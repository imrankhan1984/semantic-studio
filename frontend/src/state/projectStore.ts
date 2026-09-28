/*
================================================================================
FILE: frontend/src/state/projectStore.ts
================================================================================

SUMMARY
    The open project and its documents, as a small external store read through
    useSyncExternalStore (D-084): which project is open, each document's
    revision and dirty flag, the undo and redo labels, the save status, the
    display language, the editor's unapplied text, and the sentence the live
    region last announced.

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
    model (visual-modeling 5.1, 5.2): the same bookkeeping as an undo.

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
  openProject,
  recoverProject,
  redoChange,
  runCommand,
  saveDocument,
  setDisplayLanguage as setApiLanguage,
  undoChange,
  updateProject,
} from "../api";
import type {
  ChangeResult,
  ProjectDocName,
  ProjectDocumentState,
  ProjectSummary,
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
};

let snapshot: ProjectSnapshot = EMPTY;
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

  /** Open a project and make it current. Returns the model's ontology id. */
  async open(pid: string): Promise<string> {
    const opened = await openProject(pid);
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
    return opened.documents.find((d) => d.doc === "model")!.ontologyId;
  },

  /** Close, dropping unsaved changes only when told to. Throws the server's
   *  409 when there are unsaved changes and `discard` is false. */
  async close(discard = false): Promise<void> {
    const project = snapshot.project;
    await flushAll();
    if (project) await closeProject(project.id, discard);
    set({ ...EMPTY, announcement: snapshot.announcement });
  },

  /** Forget the open project without telling the server: for a project that
   *  was deleted or failed to open. */
  reset(): void {
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
  ): Promise<ChangeResult> {
    const project = requireProject();
    const result = await runCommand(project.id, snapshot.activeDoc, name, args);
    if (announcement) {
      set({ documents: withDocument(result.state) });
      announce(announcement(result));
    } else {
      afterChange(result, "");
    }
    return result;
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
    snapshot = EMPTY;
    setApiLanguage(null);
    for (const listener of listeners) listener();
  },
};
