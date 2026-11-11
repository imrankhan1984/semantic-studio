/*
================================================================================
FILE: frontend/src/state/projectStore.ts
================================================================================

SUMMARY
    The open project and its documents, as a small external store read through
    useSyncExternalStore (D-084): which project is open, each document's
    revision and dirty flag, the undo and redo labels, the save status, the
    display language, the editor's unapplied text, the sentence the live
    region last announced, the last SHACL validation (shacl-authoring
    5.6), which lives for the session and is never saved, the project's
    data snapshots with their generation (csv-data-import 5.6) or why they
    could not be read, and the last
    reasoning run with Show inferred (axioms-and-reasoning 5.2 to 5.7).

BASIC IDEA
    New state only. App.tsx keeps everything it held before; this holds what
    authoring adds, so that the header, the editor, the dialogs and App can all
    read one copy without App threading a dozen props to each (candidate D-060,
    adopted for new state). No dependency: a listener set and a snapshot object
    replaced on every change, which is all useSyncExternalStore asks for.

    Every server answer that carries a document's state replaces that state
    here, so the revision the views refetch on is always the server's number,
    never one counted in the browser (D-081). The actions are plain async
    functions; a component calls them and re-renders from the snapshot.
    `command` is the editing form's and the tree's one way to change the
    model (visual-modeling 5.1, 5.2): the same bookkeeping as an undo. It
    takes a document as well, for the Shapes view's commands on shapes.ttl;
    the first one creates that file, and the store then tracks it.

    Validation runs one check at a time, and a check that outlives its
    project -- closed, or another opened -- is ignored when it answers: its
    result, its announcement and its failure never reach the next project
    (shacl-authoring Stage B, follow-up 3). Reasoning follows the same rule:
    one run at a time, its start and end announced, its result kept for the
    session only with what it was computed on, and Stop asks the server to
    kill the run, whose own answer then says *Stopped*. Between the press and
    that answer the run is stopping: Stop is pressed once, and a Stop the
    server refuses says so. A run whose answer arrives after the model moved
    is announced as such, never as current (PR #55 review).

    A rule begun on the canvas waits here for the form (axioms 5.9): the
    relate menu selects the class and leaves the draft, and the class's
    Rules block opens its sentence builder on it once.

    So does a new class, concept, relationship, attribute or example being
    named (edit-page-rework 5.5): one draft, begun from the canvas's palette,
    an outline section's +, a row's *Add subclass* or the side panel, whose
    name is typed in the canvas's draft box or the side panel's form -- one
    value, so either shows what the other holds. Creating it is one command
    whichever place pressed Enter, and Cancel gives focus back to the control
    the creation started from.

    Data snapshots are not documents: changing one moves no revision and no
    undo step (5.7). The server counts their changes in a generation of its
    own, which every view's fetch key carries beside the revision, so
    switching a snapshot off refreshes Explore, Query and the tree exactly
    as an edit does. The listing is fetched when the project opens and after
    every snapshot action, and only kept if that project is still open.

    Something holding writes for the open project -- the canvas, which saves
    its layout a second after a move -- registers a flush, and close() awaits
    every one before the server closes the project. A closed project refuses
    the write, and a move made just before Close was lost (PR #47 review).

    The editor's unapplied text lives here rather than in the editor, because
    leaving it is App's business: switching mode, switching document or
    closing the project each has to ask "Apply, discard, or stay?", and only
    something outside the editor can ask before the editor unmounts.

    reuseDraft (attribute-reuse 5.1) carries a reuse begun on the canvas
    to the class's form, which opens the reuse plan once, as ruleDraft does
    for a rule.

    A new class is made as the project's last choice of kind, OWL or RDFS
    (attribute-reuse 5.6), unless its form chose: the server keeps that
    choice in the manifest and the summary here follows its answer.

    A project is a folder of files (multi-file-projects, D-131), each with an
    id and a role. `activeDoc` is any of them; `editDoc` is the ontology or
    vocabulary file the Edit page last showed, which the commands made
    outside a file's own view (Add a vocabulary, the data wizard, a draft)
    run on, as they ran on model.ttl before. The Files panel's actions --
    New file, New folder, Rename, Move, Remove, and a folder's rename
    (5.10 item 1) -- are here, each replacing the list from the server's
    answer. The views key on the sum of every file's revision
    (projectRevision), so a change in one file refreshes the others' views
    (5.3 item 7).

    The open files are tabs (5.9, D-132): `openDocs` in the order opened,
    remembered per project in the browser in try/catch, and kept to the ids
    the project still holds. Closing a tab discards nothing -- unsaved
    changes are the open file's, and text typed and not applied stays here
    under `editorTexts`, which holds every file's unapplied text but the
    active one's, whose text is `editorDraft` as before. The two are moved
    between only when the active file changes, never on a keystroke.

INPUTS / INPUT SOURCES
    - api.ts, for every project call.

EXPECTED OUTPUT
    - useProjectStore() for components, `projectStore` for actions, and
      setDisplayLanguage kept in step in api.ts.
================================================================================
*/

import { useSyncExternalStore } from "react";
import {
  ApiError,
  applyDocumentSource,
  addProjectFile,
  closeProject,
  createProjectFolder,
  listData,
  renameProjectFolder,
  moveProjectFile,
  removeProjectFile,
  removeProjectFolder,
  openProject,
  recoverProject,
  redoChange,
  runCommand,
  reasonProject,
  saveDocument,
  stopReasoning,
  setDisplayLanguage as setApiLanguage,
  undoChange,
  updateProject,
  validateProject,
} from "../api";
import { keptTabs, tabsKey } from "../files/tabs";
import { validationSummary } from "../modeling/shapeSentences";
import { failureReason } from "../networkWords";
import { finishedLine, isStale, staleLine, type ReasoningNow } from "../reasoning/reasonSentences";
import type {
  ChangeResult,
  ClassType,
  CreatingKind,
  FileRole,
  IndexNotice,
  ProjectDocName,
  ProjectDocumentState,
  ProjectSummary,
  ReasoningResult,
  SnapshotListing,
  ValidationResult,
} from "../types";

export type SaveStatus = "saved" | "unsaved" | "saving";

export interface ProjectSnapshot {
  project: ProjectSummary | null;
  documents: ProjectDocumentState[];
  activeDoc: ProjectDocName;
  /** The ontology or vocabulary file the Edit page last showed: where a
   *  command made outside a file's own view runs (multi-file-projects). */
  editDoc: ProjectDocName;
  /** The project's folders, by path from the project folder, sorted. */
  folders: string[];
  /** The open files, one tab each, in the order opened (5.9 item 1). The
   *  active file is always one of them. */
  openDocs: ProjectDocName[];
  /** What the open's folder index found, dropped and skipped (5.2), said
   *  once at the top of the Files panel until dismissed. */
  fileNotice: IndexNotice | null;
  /** The server's shift (5.3 item 7): added to every sum of the files'
   *  revisions so it grows when a file is added, moved or removed. Taken
   *  from the server's answers, never counted here. */
  revisionShift: number;
  saving: boolean;
  displayLanguage: string | null;
  recovery: { draftTime: string } | null;
  /** A save is waiting on the one-time comments question (5.6). */
  commentsWarning: { doc: ProjectDocName; backup: string } | null;
  /** The Turtle editor's text while it differs from the document; null when
   *  there is nothing unapplied. The ACTIVE file's: every other file's is
   *  in `editorTexts`, so switching tabs keeps each one's (5.9 item 4). */
  editorDraft: string | null;
  /** The unapplied editor text of every file that is not the active one,
   *  by id. Written when the active file changes, never on a keystroke:
   *  App reads the store by selector, and the editor's text must not
   *  re-render anything else (the load-bearing rule). */
  editorTexts: Record<ProjectDocName, string>;
  /** What the polite live region says, e.g. "Created class Invoice. Unsaved
   *  changes." A counter beside it so the same sentence twice is announced
   *  twice. */
  announcement: { text: string; id: number };
  /** The last validation (shacl-authoring 5.6, D-094): kept for the session
   *  only, never written to disk, and shown in the Shapes view and under the
   *  Turtle editor alike. */
  validation: ValidationResult | null;
  validating: boolean;
  /** Where the Turtle editor should put its cursor once it has its text:
   *  what a shape is written as (its prefixed name, its IRI), for *Edit in
   *  Turtle* (5.5). Searched with indexOf, never as a pattern. */
  editorTarget: { find: string[]; token: number } | null;
  /** The project's data snapshots and the server's generation for them
   *  (csv-data-import 5.6); null until fetched. */
  data: SnapshotListing | null;
  /** Why the snapshot list could not be read, until a read succeeds: the
   *  Data tab says it with Try again rather than reading for ever. */
  dataError: string | null;
  /** The last reasoning run (axioms-and-reasoning 5.2): kept for the session
   *  only, never saved, and stale once the model moves (5.3). */
  reasoning: ReasoningResult | null;
  /** When the run going started, for the seconds the status line counts;
   *  null when none is going. Reason reads Stop meanwhile. */
  reasoningSince: number | null;
  /** A run that could not be asked for, or a Stop that failed: a 409, a
   *  lost connection. */
  reasoningError: string | null;
  /** Stop was pressed and the run's answer has not arrived: presses meanwhile
   *  are ignored, rather than sent again (PR #55 review). */
  reasoningStopping: boolean;
  /** Show inferred (5.7): on after a run, the user's toggle otherwise. */
  showInferred: boolean;
  /** Include data snapshots (5.1, Q1): off by default for every project. */
  reasoningData: boolean;
  /** One more for every result kept: what the views refetch on. Two runs
   *  can share a basis (Reason again with the data ticked), and keyed on the
   *  basis alone the tree kept the first run's marks (code review). */
  reasoningToken: number;
  /** A rule started on the canvas (axioms-and-reasoning 5.9): the relate
   *  menu's *a rule* entry opens the class's sentence builder with both
   *  classes filled. The form takes it once, by its token. */
  ruleDraft: { cls: string; filler: string; property?: string; token: number } | null;
  /** Add a vocabulary… asked for from outside the outline (vocabularies-
   *  and-ontologies 5.8): the canvas's *Add a term from…* footer. The
   *  outline's Vocabularies section opens its dialog once, by its token. */
  vocabularyDraft: { token: number } | null;
  /** A reuse begun on the canvas (attribute-reuse 5.1): the relate menu's
   *  *Share* entry, or a box's attribute suggestion, opens the class's
   *  reuse plan for that property. The form takes it once, by its token. */
  reuseDraft: { cls: string; property: string; label: string; kind: "attribute" | "relationship"; token: number } | null;
  /** A thing being named before it is made (edit-page-rework 5.5): the
   *  canvas's draft box and the side panel's form both show it. */
  creating: Creating | null;
  creatingBusy: boolean;
  /** The server's refusal, shown under both name fields. */
  creatingError: string | null;
  /** The last thing a draft made, for the canvas to place it and App to
   *  select it; its token is the draft's. */
  created: { iri: string; kind: CreatingKind; token: number; parent: string | null } | null;
}

export interface Creating {
  kind: CreatingKind;
  /** The class it is a kind of, or the concept it is narrower than. */
  parent: { iri: string; label: string } | null;
  name: string;
  token: number;
  /** What the side panel's form holds besides the name: a definition, the
   *  ends or class chosen, More options. Here, not in the form, so Enter in
   *  the canvas's box makes the same thing as Create (code review). */
  extra: CreatingExtra;
}

/** What the side panel's form adds to the name for each kind. */
export interface CreatingExtra {
  /** An identifier the expert chose under More options. */
  iri?: string;
  definition?: string;
  domain?: string;
  range?: string;
  /** A new relationship whose values are a branch of concepts (skos-and-owl
   *  5.3.1, *a concept from…*): the branch concept, which makes the draft a
   *  CreateBranchRelationship rather than a CreateObjectProperty. */
  branch?: string;
  datatype?: string;
  cls?: string;
  /** A class's kind, OWL or RDFS (attribute-reuse 5.6); the project's
   *  default when the form has not chosen. */
  classType?: ClassType;
}

const EMPTY: ProjectSnapshot = {
  project: null,
  documents: [],
  activeDoc: "model",
  editDoc: "model",
  folders: [],
  openDocs: [],
  fileNotice: null,
  revisionShift: 0,
  saving: false,
  displayLanguage: null,
  recovery: null,
  commentsWarning: null,
  editorDraft: null,
  editorTexts: {},
  announcement: { text: "", id: 0 },
  validation: null,
  validating: false,
  editorTarget: null,
  data: null,
  dataError: null,
  reasoning: null,
  reasoningSince: null,
  reasoningError: null,
  reasoningStopping: false,
  showInferred: false,
  reasoningData: false,
  reasoningToken: 0,
  ruleDraft: null,
  vocabularyDraft: null,
  reuseDraft: null,
  creating: null,
  creatingBusy: false,
  creatingError: null,
  created: null,
};

let snapshot: ProjectSnapshot = EMPTY;
// Which validation is the current one. Opening, closing or forgetting a
// project moves it on, so a check still running for the old project is
// ignored when it answers (shacl-authoring Stage A follow-up 3).
let validationRun = 0;
// The same for reasoning: a run that outlives its project is ignored.
let reasoningRun = 0;
const listeners = new Set<() => void>();
// Pending writes to wait for before the project closes (the canvas layout).
const flushes = new Set<() => Promise<void>>();
// The control a creation began from, for Cancel to give focus back to. Not
// in the snapshot: an element is not state anything renders from.
let creatingFrom: HTMLElement | null = null;

/** Where focus goes back to: the control the creation began from, or --
 *  when that control was replaced while the draft was open, as the side
 *  panel's own New class button is by the form -- the control now standing
 *  in its place, found by its `data-create-from` name; else the outline's
 *  heading, never the page. */
function creationStart(): HTMLElement | null {
  const from = creatingFrom;
  if (from && from.isConnected) return from;
  const key = from?.dataset.createFrom;
  const twin = key ? document.querySelector<HTMLElement>(`[data-create-from="${key}"]`) : null;
  return twin ?? document.getElementById("hierarchy-view-heading");
}
let creatingTokens = 0;

/** The command a draft makes, with its arguments (edit-page-rework 5.5). */
function draftCommand(draft: Creating, extra: CreatingExtra): [string, Record<string, unknown>] {
  const name = draft.name.trim();
  // What every box kind takes besides its name.
  const extras = {
    ...(extra.definition?.trim() ? { definition: extra.definition.trim() } : {}),
    ...(extra.iri ? { iri: extra.iri } : {}),
  };
  switch (draft.kind) {
    case "class":
      return [
        "CreateClass",
        { label: name, ...(draft.parent ? { parent: draft.parent.iri } : {}), type: extra.classType ?? defaultClassType(), ...extras },
      ];
    case "concept":
      return ["CreateConcept", { prefLabel: name, ...(draft.parent ? { broader: draft.parent.iri } : {}), ...extras }];
    case "objectProperty":
      // *a concept from…* makes a branch relationship, one paired undo step
      // across the model and the shapes (skos-and-owl 5.3.1).
      if (extra.branch) {
        return [
          "CreateBranchRelationship",
          { label: name, ...(extra.domain ? { domain: extra.domain } : {}), branch: extra.branch, ...(extra.iri ? { iri: extra.iri } : {}) },
        ];
      }
      return [
        "CreateObjectProperty",
        { label: name, ...(extra.domain ? { domain: extra.domain } : {}), ...(extra.range ? { range: extra.range } : {}), ...(extra.iri ? { iri: extra.iri } : {}) },
      ];
    case "datatypeProperty":
      return [
        "CreateDatatypeProperty",
        { label: name, ...(extra.domain ? { domain: extra.domain } : {}), datatype: extra.datatype ?? "xsd:string", ...(extra.iri ? { iri: extra.iri } : {}) },
      ];
    case "example":
      return ["CreateExample", { class: extra.cls, label: name, ...(extra.iri ? { iri: extra.iri } : {}) }];
  }
}

/** The kind a new class is made as unless its form says otherwise (5.6):
 *  the project's last choice, OWL for a project that has made none. */
export function defaultClassType(project: ProjectSummary | null = snapshot.project): ClassType {
  return project?.classType ?? "owl";
}

/** Wait for every registered flush; one failing does not stop the others,
 *  nor the close: its own status line has already said so. */
async function flushAll(): Promise<void> {
  await Promise.all([...flushes].map((flush) => flush().catch(() => undefined)));
}

function set(changes: Partial<ProjectSnapshot>): void {
  snapshot = { ...snapshot, ...changes };
  if ("displayLanguage" in changes || "project" in changes) {
    setApiLanguage(snapshot.project ? snapshot.displayLanguage : null);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ProjectSnapshot {
  return snapshot;
}

/** The whole snapshot, for the small components that show most of it. */
export function useProjectStore(): ProjectSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One slice of the snapshot, re-rendering only when that slice changes. The
 *  selector must return a primitive or a reference the store already holds.
 *  App reads through these: the editor's text changes on every keystroke, and
 *  a whole-snapshot subscription re-rendered all of App per character (found
 *  in review). */
export function useProjectSelector<T>(select: (state: ProjectSnapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(snapshot),
    () => select(snapshot),
  );
}

/** The status the header shows in text (never a coloured dot alone). */
export function saveStatus(state: ProjectSnapshot): SaveStatus {
  if (state.saving) return "saving";
  return state.documents.some((d) => d.dirty) ? "unsaved" : "saved";
}

export const STATUS_WORDS: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
};

/** The document the header and the views are on. */
export function activeDocument(
  state: Pick<ProjectSnapshot, "documents" | "activeDoc">,
): ProjectDocumentState | null {
  return state.documents.find((d) => d.doc === state.activeDoc) ?? null;
}

/** A file's role (5.1 item 3): the server's word, or for a state from a
 *  server before E-16 the one its id meant. */
export function docRole(d: Pick<ProjectDocumentState, "doc"> & { role?: FileRole }): FileRole {
  return d.role ?? (d.doc === "shapes" ? "shapes" : "ontology");
}

export function isShapesDoc(d: Pick<ProjectDocumentState, "doc"> & { role?: FileRole }): boolean {
  return docRole(d) === "shapes";
}

/** The project's first ontology or vocabulary file: model.ttl in every
 *  project made before E-16. Its id carries the project's saved queries. */
export function primaryDocument(documents: ProjectDocumentState[]): ProjectDocumentState | null {
  return documents.find((d) => d.doc === "model") ?? documents.find((d) => !isShapesDoc(d)) ?? null;
}

/** The first shapes file (5.1 item 5), where a form writes a shape; null
 *  while the project has none, when the first shape command makes one. */
export function mainShapesDocument(documents: ProjectDocumentState[]): ProjectDocumentState | null {
  return documents.find(isShapesDoc) ?? null;
}

/** The id a shape command goes to: the main shapes file, or `shapes`, which
 *  the server makes on the first one (shacl-authoring 8). */
export function shapesDocId(documents: ProjectDocumentState[]): ProjectDocName {
  return mainShapesDocument(documents)?.doc ?? "shapes";
}

/** The sum of the ontology and vocabulary files' revisions, or of every
 *  file's, and the server's shift (5.3 item 7): what the server keys a
 *  whole-project answer on. A sum alone stays put or comes round again
 *  when a file is removed; with the shift it only grows. */
export function projectRevision(
  documents: ProjectDocumentState[],
  modelOnly = true,
  shift: number = snapshot.revisionShift,
): number {
  return documents.reduce((sum, d) => (modelOnly && isShapesDoc(d) ? sum : sum + d.revision), shift);
}

/** The sum of the shapes files' revisions and the shift, null while there
 *  is none. */
export function shapesRevision(documents: ProjectDocumentState[], shift: number = snapshot.revisionShift): number | null {
  const shapes = documents.filter(isShapesDoc);
  return shapes.length ? shapes.reduce((sum, d) => sum + d.revision, shift) : null;
}

/** The id commands made outside a file's own view run on. */
export function editDocId(): ProjectDocName {
  return snapshot.editDoc;
}

/** The backup a first clean save of a commented file keeps (D-083), named
 *  by its file: model.original.ttl, core.original.ttl. */
function backupName(doc: ProjectDocName): string {
  const file = snapshot.documents.find((d) => d.doc === doc)?.file ?? `${doc}.ttl`;
  const base = file.split("/").pop() ?? file;
  return `${base.replace(/\.ttl$/i, "")}.original.ttl`;
}

/** The data snapshots' generation, 0 before any is known. */
export function dataGenerationOf(state: Pick<ProjectSnapshot, "data">): number {
  return state.data?.generation ?? 0;
}

/** The revision of an ontology id, or 0 for anything that is not an open
 *  project document -- a library ontology never changes revision. */
export function revisionOf(
  state: Pick<ProjectSnapshot, "documents">,
  ontologyId: string | null,
): number {
  return state.documents.find((d) => d.ontologyId === ontologyId)?.revision ?? 0;
}

function announce(text: string): void {
  set({ announcement: { text, id: snapshot.announcement.id + 1 } });
}

/** Whether anything typed in the Turtle editor is unapplied, in the file
 *  shown or in another tab: what App asks about before any exit. */
export function unappliedText(
  state: Pick<ProjectSnapshot, "editorDraft" | "editorTexts"> = snapshot,
): boolean {
  return state.editorDraft !== null || Object.keys(state.editorTexts).length > 0;
}

/** Remember this project's open tabs (5.9 item 5). A browser convenience,
 *  so a window that refuses storage changes nothing: the project then opens
 *  on its first file next time. */
function rememberTabs(): void {
  const project = snapshot.project;
  if (!project) return;
  try {
    localStorage.setItem(tabsKey(project.id), JSON.stringify(snapshot.openDocs));
  } catch {
    // A private window, blocked site data: nothing to do and nothing lost.
  }
}

/** The tabs to open with: the ones remembered, kept to the ids the project
 *  still holds, and the file the page shows among them. */
function openingTabs(pid: string, documents: ProjectDocumentState[], active: ProjectDocName): ProjectDocName[] {
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(tabsKey(pid));
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    stored = null;
  }
  const kept = keptTabs(stored, documents);
  return kept.includes(active) ? kept : [...kept, active];
}

function withDocument(next: ProjectDocumentState): ProjectDocumentState[] {
  return snapshot.documents.map((d) => (d.doc === next.doc ? next : d));
}

/** A command's new document states: the changed document, and for a change
 *  across files (a grouped step, links-between-files 5.1; a branch
 *  relationship's pair, skos-and-owl 5.3.3) every other touched file too,
 *  so each one's revision, dirty flag and undo labels refresh together. */
function changedDocuments(result: ChangeResult): ProjectDocumentState[] {
  const states = [result.state];
  if (result.partner) states.push(result.partner.state);
  for (const d of result.documents ?? []) states.push(d.state);
  return snapshot.documents.map((d) => states.find((s) => s.doc === d.doc) ?? d);
}

function afterChange(result: ChangeResult, verb: string): void {
  set({ documents: changedDocuments(result) });
  const status = STATUS_WORDS[saveStatus(snapshot)];
  announce(`${verb}${result.label}. ${status}.`);
}

/** An undo or redo: a paired half whose partner is gone is dropped and its
 *  sentence announced, rather than announced as an ordinary step (5.3.3). The
 *  document state still refreshes, so the undo and redo labels follow. */
function applyUndoRedo(result: ChangeResult, verb: string): void {
  if (result.dropped) {
    set({ documents: changedDocuments(result) });
    announce(result.dropped);
  } else {
    afterChange(result, verb);
  }
}

function requireProject(): ProjectSummary {
  if (!snapshot.project) throw new Error("No project is open.");
  return snapshot.project;
}

export const projectStore = {
  getSnapshot,

  /** Say something in the project's polite live region: a warning of the
   *  modeling checks that a change has just brought (relationships 5.9). */
  say(text: string): void {
    announce(text);
  },

  /** Open a project and make it current. Returns the model's ontology id. */
  async open(pid: string): Promise<string> {
    const opened = await openProject(pid);
    validationRun++;
    reasoningRun++;
    const primary = primaryDocument(opened.documents)!;
    const notice: IndexNotice = {
      found: opened.found ?? [],
      missing: opened.missing ?? [],
      skipped: opened.skipped ?? [],
      wroteModel: opened.wroteModel ?? false,
    };
    set({
      ...EMPTY,
      announcement: snapshot.announcement,
      project: opened.project,
      documents: opened.documents,
      activeDoc: primary.doc,
      editDoc: primary.doc,
      openDocs: openingTabs(pid, opened.documents, primary.doc),
      folders: opened.folders ?? [],
      revisionShift: opened.revisionShift ?? 0,
      fileNotice:
        notice.found.length || notice.missing.length || notice.skipped.length || notice.wroteModel ? notice : null,
      displayLanguage: opened.project.primaryLanguage,
      recovery:
        opened.recovery.available && opened.recovery.draftTime
          ? { draftTime: opened.recovery.draftTime }
          : null,
    });
    announce(`Opened ${opened.project.name}. ${STATUS_WORDS[saveStatus(snapshot)]}.`);
    // The snapshot list is not needed to show the project, so it follows.
    void projectStore.loadData().catch(() => undefined);
    return primary.ontologyId;
  },

  /** Fetch the open project's data snapshots. Kept only if the project
   *  asked about is still the open one. */
  async loadData(): Promise<SnapshotListing | null> {
    const project = requireProject();
    let listing: SnapshotListing;
    try {
      listing = await listData(project.id);
    } catch (e) {
      if (snapshot.project?.id !== project.id) return null;
      // Said in the live region and kept for the Data tab, which otherwise
      // read "Reading the project's data…" for ever (PR #53 review).
      const text = `The data snapshots could not be read: ${failureReason(e)}`;
      set({ dataError: text });
      announce(text);
      throw e;
    }
    if (snapshot.project?.id !== project.id) return null;
    set({ data: listing, dataError: null });
    return listing;
  },

  /** A snapshot changed (5.7): say what was done, and refetch the list,
   *  whose generation every view's fetch key carries. */
  async dataChanged(sentence: string): Promise<void> {
    announce(sentence);
    await projectStore.loadData();
  },

  /** Close, dropping unsaved changes only when told to. Throws the server's
   *  409 when there are unsaved changes and `discard` is false. */
  async close(discard = false): Promise<void> {
    const project = snapshot.project;
    await flushAll();
    if (project) await closeProject(project.id, discard);
    validationRun++;
    reasoningRun++;
    creatingFrom = null;
    set({ ...EMPTY, announcement: snapshot.announcement });
  },

  /** Forget the open project without telling the server: for a project that
   *  was deleted or failed to open. */
  reset(): void {
    validationRun++;
    reasoningRun++;
    creatingFrom = null;
    set({ ...EMPTY, announcement: snapshot.announcement });
  },

  /** Make a file the active one, opening its tab or moving to it (5.9 item
   *  1). Each file keeps its unapplied editor text across the switch (item
   *  4): the file being left has its text put by, the file arrived at has
   *  its taken up again. */
  switchDocument(doc: ProjectDocName): void {
    const next = snapshot.documents.find((d) => d.doc === doc);
    // An ontology or vocabulary file becomes the one Edit shows.
    const editDoc = next && !isShapesDoc(next) ? doc : snapshot.editDoc;
    const texts = { ...snapshot.editorTexts };
    // The map holds the files that are not active; the active one's text is
    // `editorDraft`, put by here as it stops being active.
    delete texts[doc];
    if (doc !== snapshot.activeDoc && snapshot.editorDraft !== null) texts[snapshot.activeDoc] = snapshot.editorDraft;
    const editorDraft = doc === snapshot.activeDoc ? snapshot.editorDraft : snapshot.editorTexts[doc] ?? null;
    const openDocs = snapshot.openDocs.includes(doc) ? snapshot.openDocs : [...snapshot.openDocs, doc];
    set({ activeDoc: doc, editDoc, openDocs, editorDraft, editorTexts: texts });
    rememberTabs();
  },

  /** Close a tab (5.9 item 3): nothing is discarded. Unsaved changes are
   *  the open file's, and the Files panel still marks it; text typed in the
   *  editor and not applied is kept here, so reopening the file shows it
   *  again. The last tab stays. Answers the file the page should show when
   *  the closed tab was the one it was showing, else null. */
  closeTab(doc: ProjectDocName): ProjectDocumentState | null {
    if (!snapshot.openDocs.includes(doc) || snapshot.openDocs.length <= 1) return null;
    const at = snapshot.openDocs.indexOf(doc);
    const openDocs = snapshot.openDocs.filter((d) => d !== doc);
    const texts = { ...snapshot.editorTexts };
    if (doc === snapshot.activeDoc && snapshot.editorDraft !== null) texts[doc] = snapshot.editorDraft;
    set({ openDocs, editorTexts: texts });
    rememberTabs();
    const name = snapshot.documents.find((d) => d.doc === doc)?.file ?? "the file";
    announce(`Closed the tab for ${name}. Nothing was discarded.`);
    if (doc !== snapshot.activeDoc) return null;
    // The tab that stood where it did, or the last one.
    const to = openDocs[Math.min(at, openDocs.length - 1)];
    return snapshot.documents.find((d) => d.doc === to) ?? null;
  },

  dismissFileNotice(): void {
    if (snapshot.fileNotice !== null) set({ fileNotice: null });
  },

  /** New file (5.5 item 5). The server's answer carries the new file's
   *  state; the list follows it, and the caller opens the file. A refusal
   *  throws the server's ApiError, its sentence and field in `detail`. */
  async addFile(role: FileRole, name: string, folder: string): Promise<ProjectDocumentState> {
    const project = requireProject();
    const made = await addProjectFile(project.id, role, name, folder);
    if (snapshot.project?.id !== project.id) return made.document;
    set({
      documents: [...snapshot.documents, made.document], folders: made.folders,
      project: made.project ?? snapshot.project, revisionShift: made.revisionShift ?? snapshot.revisionShift,
    });
    announce(`Created ${made.entry.file}.`);
    return made.document;
  },

  /** Rename or move (5.5 item 6): the path only; id, history and layout stay. */
  async moveFile(doc: ProjectDocName, change: { name?: string; folder?: string }): Promise<ProjectDocumentState> {
    const project = requireProject();
    const moved = await moveProjectFile(project.id, doc, change);
    if (snapshot.project?.id !== project.id) return moved.document;
    set({ documents: withDocument(moved.document), folders: moved.folders, revisionShift: moved.revisionShift ?? snapshot.revisionShift });
    announce(`${change.name === undefined ? "Moved" : "Renamed"} to ${moved.entry.file}.`);
    return moved.document;
  },

  /** Remove (5.5 item 7): to the project's trash. The active file falls
   *  back to the project's first ontology file. */
  async removeFile(doc: ProjectDocName): Promise<ProjectDocumentState | null> {
    const project = requireProject();
    const gone = snapshot.documents.find((d) => d.doc === doc);
    const result = await removeProjectFile(project.id, doc);
    if (snapshot.project?.id !== project.id) return null;
    const documents = snapshot.documents.filter((d) => d.doc !== doc);
    const primary = primaryDocument(documents);
    const activeDoc = snapshot.activeDoc === doc ? (primary?.doc ?? "model") : snapshot.activeDoc;
    const editDoc = snapshot.editDoc === doc ? (primary?.doc ?? "model") : snapshot.editDoc;
    const texts = { ...snapshot.editorTexts };
    delete texts[doc];
    // The map holds the files that are not active, so the file the views
    // fall back to takes its text up as `editorDraft` and leaves the map.
    const taken = snapshot.activeDoc === doc ? (texts[activeDoc] ?? null) : snapshot.editorDraft;
    delete texts[activeDoc];
    // The file is gone, so its tab and its unapplied text go with it; the
    // file the views fall back to is a tab, whether or not it was one (its
    // tab may have been closed while another file was shown).
    const left = snapshot.openDocs.filter((d) => d !== doc);
    set({
      documents, folders: result.folders, activeDoc, editDoc,
      openDocs: left.includes(activeDoc) ? left : [...left, activeDoc],
      editorDraft: taken,
      editorTexts: texts,
      revisionShift: result.revisionShift ?? snapshot.revisionShift,
    });
    rememberTabs();
    announce(`Moved ${gone?.file ?? "the file"} to the project's trash.`);
    // What the views go to when the removed file was the one shown.
    return documents.find((d) => d.doc === activeDoc) ?? null;
  },

  async createFolder(path: string): Promise<string[]> {
    const project = requireProject();
    const result = await createProjectFolder(project.id, path);
    if (snapshot.project?.id === project.id) {
      set({ folders: result.folders });
      announce(`Created the folder ${path}.`);
    }
    return result.folders;
  },

  /** Rename a folder (5.10 item 1): the paths of the files inside it, and
   *  nothing else. Each file keeps its id, so its statements, undo history,
   *  unsaved changes and layout stay; the server's answer carries their new
   *  paths and the shift every view keys on. */
  async renameFolder(path: string, name: string): Promise<string[]> {
    const project = requireProject();
    const result = await renameProjectFolder(project.id, path, name);
    if (snapshot.project?.id !== project.id) return result.folders;
    const states = new Map((result.documents ?? []).map((d) => [d.doc, d]));
    const paths = new Map(result.files.map((f) => [f.id, f.file]));
    const documents = snapshot.documents.map((d) => {
      const state = states.get(d.doc);
      if (state) return state;
      const file = paths.get(d.doc);
      return file === undefined ? d : { ...d, file };
    });
    set({
      documents, folders: result.folders,
      revisionShift: result.revisionShift ?? snapshot.revisionShift,
    });
    announce(`Renamed the folder to ${name}.`);
    return result.folders;
  },

  async removeFolder(path: string): Promise<string[]> {
    const project = requireProject();
    const result = await removeProjectFolder(project.id, path);
    if (snapshot.project?.id === project.id) {
      set({ folders: result.folders });
      announce(`Removed the folder ${path}.`);
    }
    return result.folders;
  },

  /** Track a newly added document (shapes.ttl) from a fresh open. */
  async reload(): Promise<void> {
    const project = requireProject();
    const opened = await openProject(project.id);
    set({
      project: opened.project, documents: opened.documents, folders: opened.folders ?? snapshot.folders,
      revisionShift: opened.revisionShift ?? snapshot.revisionShift,
    });
  },

  async undo(): Promise<void> {
    const project = requireProject();
    // The editor's unapplied text is not touched here: the header asks
    // "Apply, discard, or stay?" before an undo, as every other exit does.
    const result = await undoChange(project.id, snapshot.activeDoc);
    applyUndoRedo(result, "Undid: ");
  },

  async redo(): Promise<void> {
    const project = requireProject();
    const result = await redoChange(project.id, snapshot.activeDoc);
    applyUndoRedo(result, "Redid: ");
  },

  /** Record a change made elsewhere (a command) so the views refetch. */
  applied(result: ChangeResult): void {
    afterChange(result, "");
  },

  /** Run one command on the open document (visual-modeling 5.1). The views
   *  refetch on the revision it returns, and the live region says what
   *  changed. A refusal throws the server's ApiError, with its sentence and
   *  nothing changed; the caller shows it under the field that caused it.
   *  `announce` replaces the usual "<label>. <status>." sentence. */
  async command(
    name: string,
    args: Record<string, unknown>,
    announcement?: (result: ChangeResult) => string,
    doc?: ProjectDocName,
  ): Promise<ChangeResult> {
    const project = requireProject();
    const target = doc ?? snapshot.activeDoc;
    const result = await runCommand(project.id, target, name, args);
    // The kind a class was made as is the project's next default (5.6): the
    // server has written it to the manifest; the summary here follows.
    if (result.classType && snapshot.project?.id === project.id && defaultClassType() !== result.classType) {
      set({ project: { ...snapshot.project, classType: result.classType } });
    }
    if (!snapshot.documents.some((d) => d.doc === target)) {
      // The first shape command made shapes.ttl (shacl-authoring 8): track
      // it from a fresh open, as Add shapes.ttl does.
      const opened = await openProject(project.id);
      set({
        project: opened.project, documents: opened.documents, folders: opened.folders ?? snapshot.folders,
        revisionShift: opened.revisionShift ?? snapshot.revisionShift,
      });
    }
    if (announcement) {
      set({ documents: changedDocuments(result) });
      announce(announcement(result));
    } else {
      afterChange(result, "");
    }
    return result;
  },

  /** Validate the open project, on demand only (5.6). The previous result
   *  stays, dimmed by the views, until this one replaces it; the live region
   *  reads the summary (Section 6). */
  async validate(): Promise<ValidationResult | null> {
    const project = requireProject();
    // One check at a time: a second press while one runs is not a second
    // request (Stage A follow-up 3).
    if (snapshot.validating) return null;
    const run = ++validationRun;
    set({ validating: true });
    announce("Validating…");
    const stale = () => run !== validationRun || snapshot.project?.id !== project.id;
    try {
      let result: ValidationResult;
      try {
        result = await validateProject(project.id);
      } catch (e) {
        // Nor does its failure reach the next project's error bar.
        if (stale()) return null;
        throw e;
      }
      // A check that outlived its project -- closed, or another opened --
      // says nothing in the next one and leaves its Validate alone.
      if (stale()) return null;
      set({ validation: result });
      announce(validationSummary(result));
      return result;
    } finally {
      if (run === validationRun) set({ validating: false });
    }
  },

  /** Reason over the open project (axioms-and-reasoning 5.2). One run at a
   *  time; the start and the end are announced, the seconds are not. A run
   *  that outlives its project says nothing in the next one. `importsNow`
   *  reads the imports switch when the answer arrives: the switch is App's,
   *  while the revision and the generation are read here. */
  async reason(
    includeData: boolean,
    imports: boolean,
    importsNow: () => boolean = () => imports,
  ): Promise<ReasoningResult | null> {
    const project = requireProject();
    if (snapshot.reasoningSince !== null) return null;
    const run = ++reasoningRun;
    set({ reasoningSince: Date.now(), reasoningError: null });
    announce("Reasoning started.");
    const stale = () => run !== reasoningRun || snapshot.project?.id !== project.id;
    try {
      let result: ReasoningResult;
      try {
        result = await reasonProject(project.id, includeData, imports);
      } catch (e) {
        if (stale()) return null;
        // Said once: the Reasoning panel's alert reads it, and a live-region
        // announcement as well said it twice (PR #55 review).
        const text = e instanceof ApiError ? e.message : `The run could not be started: ${failureReason(e)}`;
        set({ reasoningError: text });
        return null;
      }
      if (stale()) return null;
      // A finished run's marks show at once (Section 6: on after a run).
      // Its answer supersedes a Stop that failed while it ran.
      set({
        reasoning: result,
        reasoningError: null,
        reasoningToken: snapshot.reasoningToken + 1,
        showInferred: result.status === "done" ? true : snapshot.showInferred,
      });
      // An edit made while it ran leaves it stale on arrival (5.3): saying
      // only "Reasoned in 4 s" would call it current.
      const now: ReasoningNow = {
        revision: projectRevision(snapshot.documents),
        generation: dataGenerationOf(snapshot),
        imports: importsNow(),
      };
      const line = isStale(result, now) ? staleLine(result) : finishedLine(result);
      announce(line.endsWith(".") ? line : `${line}.`);
      return result;
    } finally {
      if (run === reasoningRun) set({ reasoningSince: null, reasoningStopping: false });
    }
  },

  /** Stop the run: its process is killed, and its own answer says so. Once
   *  pressed, presses are ignored until that answer; a refused Stop is
   *  said, once, in the panel's alert, and Stop can be pressed again. */
  async stopReasoning(): Promise<void> {
    const project = requireProject();
    if (snapshot.reasoningSince === null || snapshot.reasoningStopping) return;
    const run = reasoningRun;
    set({ reasoningStopping: true, reasoningError: null });
    try {
      await stopReasoning(project.id);
    } catch (e) {
      if (run !== reasoningRun || snapshot.reasoningSince === null) return;
      // In the app's words, never the browser's ("Failed to fetch"), and
      // said once, by the panel's alert (PR #55 review).
      const text = `The run could not be stopped: ${failureReason(e)} Press Stop again.`;
      set({ reasoningStopping: false, reasoningError: text });
    }
  },

  setShowInferred(on: boolean): void {
    if (on !== snapshot.showInferred) set({ showInferred: on });
  },

  setReasoningData(on: boolean): void {
    if (on !== snapshot.reasoningData) set({ reasoningData: on });
  },

  /** Ask the Turtle editor to move to what a shape is written as. */
  showInEditor(find: string[]): void {
    set({ editorTarget: { find, token: (snapshot.editorTarget?.token ?? 0) + 1 } });
  },

  /** Open the class's sentence builder with its other class chosen: the
   *  relate menu's rule entry, or a relationship form's pointer with the
   *  relationship too (axioms 5.9). The form opens it once. */
  startRule(cls: string, filler: string, property?: string): void {
    set({ ruleDraft: { cls, filler, ...(property ? { property } : {}), token: (snapshot.ruleDraft?.token ?? 0) + 1 } });
  },

  /** Begin naming a new thing (edit-page-rework 5.5). `from` is the
   *  control pressed, which Cancel gives focus back to. A draft already open
   *  is replaced: one thing is named at a time. */
  startCreating(
    kind: CreatingKind,
    options: { parent?: { iri: string; label: string } | null; from?: HTMLElement | null } = {},
  ): number {
    creatingFrom = options.from ?? null;
    const token = ++creatingTokens;
    set({
      creating: { kind, parent: options.parent ?? null, name: "", token, extra: {} },
      creatingBusy: false,
      creatingError: null,
    });
    return token;
  },

  setCreatingName(name: string): void {
    if (snapshot.creating && snapshot.creating.name !== name) {
      set({ creating: { ...snapshot.creating, name } });
    }
  },

  setCreatingParent(parent: { iri: string; label: string } | null): void {
    if (snapshot.creating) set({ creating: { ...snapshot.creating, parent } });
  },

  setCreatingExtra(extra: Partial<CreatingExtra>): void {
    if (snapshot.creating) set({ creating: { ...snapshot.creating, extra: { ...snapshot.creating.extra, ...extra } } });
  },

  /** Make the draft: one command, whichever field pressed Enter. A refusal
   *  stays on the draft as the server's sentence, nothing changed. */
  async createDraft(): Promise<string | null> {
    const draft = snapshot.creating;
    if (!draft || snapshot.creatingBusy || !draft.name.trim()) return null;
    set({ creatingBusy: true, creatingError: null });
    try {
      const [name, args] = draftCommand(draft, draft.extra);
      const result = await projectStore.command(name, args, undefined, snapshot.editDoc);
      // Closed, or another draft begun, while it ran: nothing to finish.
      if (snapshot.creating?.token !== draft.token) return result.created ?? null;
      // The field pressed is about to go: focus waits where the creation
      // began until the new box or row takes it, never on the page.
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".canvas-draft, .create-form")) creationStart()?.focus();
      set({
        creating: null,
        creatingBusy: false,
        created: result.created
          ? { iri: result.created, kind: draft.kind, token: draft.token, parent: draft.parent?.iri ?? null }
          : null,
      });
      creatingFrom = null;
      return result.created ?? null;
    } catch (e: unknown) {
      if (snapshot.creating?.token === draft.token) {
        set({ creatingBusy: false, creatingError: e instanceof Error ? e.message : String(e) });
      }
      return null;
    }
  },

  /** Esc, Cancel, or focus leaving both fields empty. With `restore`, focus
   *  goes back where the creation began -- or, if that control is gone, to
   *  the outline's heading -- never to the page. */
  cancelCreating(restore = true): void {
    if (!snapshot.creating) return;
    set({ creating: null, creatingBusy: false, creatingError: null });
    if (!restore) {
      creatingFrom = null;
      return;
    }
    // After the render that removed the form, so a replaced control is back.
    window.setTimeout(() => {
      creationStart()?.focus();
      creatingFrom = null;
    }, 0);
  },

  /** Open the class's reuse plan for a property (attribute-reuse 5.1):
   *  every canvas way to reuse ends in the class's form (D-078). */
  startReuse(cls: string, property: string, label: string, kind: "attribute" | "relationship"): void {
    set({ reuseDraft: { cls, property, label, kind, token: (snapshot.reuseDraft?.token ?? 0) + 1 } });
  },

  /** The form has opened the plan for the draft: it is spent. */
  reuseDraftTaken(): void {
    if (snapshot.reuseDraft !== null) set({ reuseDraft: null });
  },

  /** The form has opened the builder for the draft: it is spent. */
  ruleDraftTaken(): void {
    if (snapshot.ruleDraft !== null) set({ ruleDraft: null });
  },

  /** Ask the outline's Vocabularies section to open Add a vocabulary… (5.8). */
  askAddVocabulary(): void {
    set({ vocabularyDraft: { token: (snapshot.vocabularyDraft?.token ?? 0) + 1 } });
  },

  /** The section has opened its dialog: the request is spent. */
  vocabularyDraftTaken(): void {
    if (snapshot.vocabularyDraft !== null) set({ vocabularyDraft: null });
  },

  /** The editor has moved to the target: it is spent, so a later visit to
   *  the editor does not move the caret again (found in review). */
  editorTargetShown(): void {
    if (snapshot.editorTarget !== null) set({ editorTarget: null });
  },

  setEditorDraft(text: string | null): void {
    if (text !== snapshot.editorDraft) set({ editorDraft: text });
  },

  /** Apply the editor's text. Throws TurtleError for invalid Turtle, with
   *  nothing changed; the draft is kept so the user can fix it. */
  /** Apply the editor's text. Resolves the server's answer, whose
   *  `references` names the reference terms it does not know (reference-
   *  ontologies 5.7), or null when there was nothing to apply. */
  async applyEditor(): Promise<ChangeResult | null> {
    const project = requireProject();
    const text = snapshot.editorDraft;
    if (text === null) return null;
    const result = await applyDocumentSource(project.id, snapshot.activeDoc, text);
    set({ editorDraft: null });
    afterChange(result, "");
    return result;
  },

  /** Apply the text of every tab that holds some, the file shown first
   *  (5.9 item 4): the leave question's *Apply*, which now has more than
   *  one file's text to answer for. Turtle that will not parse makes its
   *  file the active one, so the editor shows that text and the error, and
   *  the server's refusal is thrown on. */
  async applyEditors(): Promise<void> {
    const project = requireProject();
    await projectStore.applyEditor();
    for (const doc of Object.keys(snapshot.editorTexts)) {
      const text = snapshot.editorTexts[doc];
      try {
        const result = await applyDocumentSource(project.id, doc, text);
        const texts = { ...snapshot.editorTexts };
        delete texts[doc];
        set({ editorTexts: texts, documents: changedDocuments(result) });
      } catch (e) {
        projectStore.switchDocument(doc);
        throw e;
      }
    }
  },

  /** Drop every tab's unapplied text: the leave question's *Discard*. */
  discardEditors(): void {
    set({ editorDraft: null, editorTexts: {} });
  },

  /** Save a document, the current one unless named. Resolves "warning" when
   *  the one-time comments question has to be asked first (nothing was
   *  written); confirming it saves the document the question was about. */
  async save(confirmRewrite = false, doc?: ProjectDocName): Promise<"saved" | "warning"> {
    const project = requireProject();
    doc = doc ?? (confirmRewrite ? snapshot.commentsWarning?.doc : undefined) ?? snapshot.activeDoc;
    set({ saving: true, commentsWarning: null });
    announce(STATUS_WORDS.saving);
    try {
      const result = await saveDocument(project.id, doc, confirmRewrite);
      if ("needsCommentsWarning" in result) {
        set({ commentsWarning: { doc, backup: result.backup } });
        return "warning";
      }
      set({ documents: withDocument(result.state) });
      announce(confirmRewrite ? `Saved. The previous file was kept as ${backupName(doc)}.` : "Saved.");
      return "saved";
    } finally {
      set({ saving: false });
    }
  },

  /** Save every document with unsaved changes, for "Save" in the close prompt. */
  // Each document by name: moving activeDoc to save it left the header on a
  // document the views were not showing when a save stopped part way (found
  // in review).
  async saveAll(): Promise<"saved" | "warning"> {
    for (const d of snapshot.documents.filter((x) => x.dirty)) {
      if ((await projectStore.save(false, d.doc)) === "warning") return "warning";
    }
    return "saved";
  },

  cancelCommentsWarning(): void {
    set({ commentsWarning: null });
    announce("Not saved.");
  },

  async recover(action: "recover" | "discard"): Promise<void> {
    const project = requireProject();
    const result = await recoverProject(project.id, action);
    set({ documents: result.documents, recovery: null, editorDraft: null });
    // A group missing a member is recovered in no file (5.1 item 5): said.
    const words =
      action === "recover" ? "Recovered the unsaved changes. Unsaved changes." : "Discarded the unsaved changes.";
    announce(result.dropped ? `${words} ${result.dropped}` : words);
  },

  /** Escape on the recovery question: decide later. The draft stays on disk
   *  and is offered again the next time the project opens. */
  dismissRecovery(): void {
    set({ recovery: null });
  },

  setDisplayLanguage(lang: string): void {
    set({ displayLanguage: lang });
    announce(`Showing names in ${lang}.`);
  },

  async setLanguages(languages: string[]): Promise<void> {
    const project = requireProject();
    const updated = await updateProject(project.id, { languages });
    const display =
      snapshot.displayLanguage && [updated.primaryLanguage, ...updated.languages].includes(snapshot.displayLanguage)
        ? snapshot.displayLanguage
        : updated.primaryLanguage;
    set({ project: updated, displayLanguage: display });
  },

  /** Register a pending-write flush, awaited before the project closes.
   *  Returns the function that removes it. */
  registerFlush(flush: () => Promise<void>): () => void {
    flushes.add(flush);
    return () => {
      flushes.delete(flush);
    };
  },

  /** Wait for every registered flush, as close() does. */
  flushAll,

  /** For tests: back to nothing open. */
  _reset(): void {
    validationRun++;
    reasoningRun++;
    creatingFrom = null;
    snapshot = EMPTY;
    setApiLanguage(null);
    for (const listener of listeners) listener();
  },
};
