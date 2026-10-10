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
    data snapshots with their generation (csv-data-import 5.6), and the last
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

INPUTS / INPUT SOURCES
    - api.ts, for every project call.

EXPECTED OUTPUT
    - useProjectStore() for components, `projectStore` for actions, and
      setDisplayLanguage kept in step in api.ts.
================================================================================
*/

import { useSyncExternalStore } from "react";
import {
  applyDocumentSource,
  closeProject,
  listData,
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
import { validationSummary } from "../modeling/shapeSentences";
import { finishedLine, isStale, staleLine, type ReasoningNow } from "../reasoning/reasonSentences";
import type {
  ChangeResult,
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
  saving: boolean;
  displayLanguage: string | null;
  recovery: { draftTime: string } | null;
  /** A save is waiting on the one-time comments question (5.6). */
  commentsWarning: { doc: ProjectDocName; backup: string } | null;
  /** The Turtle editor's text while it differs from the document; null when
   *  there is nothing unapplied. */
  editorDraft: string | null;
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
}

const EMPTY: ProjectSnapshot = {
  project: null,
  documents: [],
  activeDoc: "model",
  saving: false,
  displayLanguage: null,
  recovery: null,
  commentsWarning: null,
  editorDraft: null,
  announcement: { text: "", id: 0 },
  validation: null,
  validating: false,
  editorTarget: null,
  data: null,
  reasoning: null,
  reasoningSince: null,
  reasoningError: null,
  reasoningStopping: false,
  showInferred: false,
  reasoningData: false,
  reasoningToken: 0,
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

function withDocument(next: ProjectDocumentState): ProjectDocumentState[] {
  return snapshot.documents.map((d) => (d.doc === next.doc ? next : d));
}

function afterChange(result: ChangeResult, verb: string): void {
  set({ documents: withDocument(result.state) });
  const status = STATUS_WORDS[saveStatus(snapshot)];
  announce(`${verb}${result.label}. ${status}.`);
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
    set({
      ...EMPTY,
      announcement: snapshot.announcement,
      project: opened.project,
      documents: opened.documents,
      activeDoc: "model",
      displayLanguage: opened.project.primaryLanguage,
      recovery:
        opened.recovery.available && opened.recovery.draftTime
          ? { draftTime: opened.recovery.draftTime }
          : null,
    });
    announce(`Opened ${opened.project.name}. ${STATUS_WORDS[saveStatus(snapshot)]}.`);
    // The snapshot list is not needed to show the project, so it follows.
    void projectStore.loadData().catch(() => undefined);
    return opened.documents.find((d) => d.doc === "model")!.ontologyId;
  },

  /** Fetch the open project's data snapshots. Kept only if the project
   *  asked about is still the open one. */
  async loadData(): Promise<SnapshotListing | null> {
    const project = requireProject();
    const listing = await listData(project.id);
    if (snapshot.project?.id !== project.id) return null;
    set({ data: listing });
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
    set({ ...EMPTY, announcement: snapshot.announcement });
  },

  /** Forget the open project without telling the server: for a project that
   *  was deleted or failed to open. */
  reset(): void {
    validationRun++;
    reasoningRun++;
    set({ ...EMPTY, announcement: snapshot.announcement });
  },

  switchDocument(doc: ProjectDocName): void {
    set({ activeDoc: doc, editorDraft: null });
  },

  /** Track a newly added document (shapes.ttl) from a fresh open. */
  async reload(): Promise<void> {
    const project = requireProject();
    const opened = await openProject(project.id);
    set({ project: opened.project, documents: opened.documents });
  },

  async undo(): Promise<void> {
    const project = requireProject();
    // The editor's unapplied text is not touched here: the header asks
    // "Apply, discard, or stay?" before an undo, as every other exit does.
    const result = await undoChange(project.id, snapshot.activeDoc);
    afterChange(result, "Undid: ");
  },

  async redo(): Promise<void> {
    const project = requireProject();
    const result = await redoChange(project.id, snapshot.activeDoc);
    afterChange(result, "Redid: ");
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
    if (!snapshot.documents.some((d) => d.doc === target)) {
      // The first shape command made shapes.ttl (shacl-authoring 8): track
      // it from a fresh open, as Add shapes.ttl does.
      const opened = await openProject(project.id);
      set({ project: opened.project, documents: opened.documents });
    }
    if (announcement) {
      set({ documents: withDocument(result.state) });
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
        const text = e instanceof Error ? e.message : String(e);
        set({ reasoningError: text });
        announce(text);
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
        revision: snapshot.documents.find((d) => d.doc === "model")?.revision ?? 0,
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
   *  said, and Stop can be pressed again. */
  async stopReasoning(): Promise<void> {
    const project = requireProject();
    if (snapshot.reasoningSince === null || snapshot.reasoningStopping) return;
    const run = reasoningRun;
    set({ reasoningStopping: true, reasoningError: null });
    try {
      await stopReasoning(project.id);
    } catch (e) {
      if (run !== reasoningRun || snapshot.reasoningSince === null) return;
      const text = `The run could not be stopped: ${e instanceof Error ? e.message : String(e)}`;
      set({ reasoningStopping: false, reasoningError: text });
      announce(text);
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
  async applyEditor(): Promise<void> {
    const project = requireProject();
    const text = snapshot.editorDraft;
    if (text === null) return;
    const result = await applyDocumentSource(project.id, snapshot.activeDoc, text);
    set({ editorDraft: null });
    afterChange(result, "");
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
      announce(
        confirmRewrite
          ? `Saved. The previous file was kept as ${doc}.original.ttl.`
          : "Saved.",
      );
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
    announce(
      action === "recover"
        ? "Recovered the unsaved changes. Unsaved changes."
        : "Discarded the unsaved changes.",
    );
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
    snapshot = EMPTY;
    setApiLanguage(null);
    for (const listener of listeners) listener();
  },
};
