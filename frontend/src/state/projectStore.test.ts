/*
================================================================================
FILE: frontend/src/state/projectStore.test.ts
================================================================================

SUMMARY
    The project store's tabs and per-file editor text (multi-file-projects
    5.9, AC-26, AC-28): each file keeps its own unapplied Turtle text across
    a switch of tabs, undo and save act on the active file, closing a tab
    keeps everything, the open tabs are remembered per project, and a
    browser that refuses storage opens the project on its first file.

BASIC IDEA
    api.ts is mocked and the real store is driven directly: this is state,
    not a component, and the rules worth holding are the store's. localStorage
    is jsdom's, and the refusing case is made by making its two methods throw,
    which is what a private window does.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, listData, undoChange, applyDocumentSource, saveDocument, removeProjectFile } = vi.hoisted(
  () => ({
    openProject: vi.fn(),
    listData: vi.fn(),
    undoChange: vi.fn(),
    applyDocumentSource: vi.fn(),
    saveDocument: vi.fn(),
    removeProjectFile: vi.fn(),
  }),
);

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  listData,
  undoChange,
  applyDocumentSource,
  saveDocument,
  removeProjectFile,
}));

import { TurtleError } from "../api";
import { tabsKey } from "../files/tabs";
import { projectStore, unappliedText } from "./projectStore";
import type { ProjectDocumentState } from "../types";

const PID = "prj-0123456789ab";
const PROJECT = {
  id: PID, name: "Plant", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};

function state(doc: string, file: string, role: "ontology" | "vocabulary" | "shapes", extra: Record<string, unknown> = {}) {
  return {
    doc, file, role, ontologyId: `${PID}-${doc}`, revision: 0, dirty: false, canUndo: true,
    undoLabel: `Undo in ${file}`, canRedo: false, redoLabel: null, triples: 4, ...extra,
  } as ProjectDocumentState;
}

const DOCS = [
  state("model", "model.ttl", "ontology"),
  state("f00000001", "vocab/equipment.ttl", "vocabulary"),
  state("shapes", "shapes.ttl", "shapes"),
];

const A = "@prefix : <http://x#> .\n:InModel a :Thing .\n";
const B = "@prefix : <http://x#> .\n:InEquipment a :Thing .\n";

async function open(documents = DOCS) {
  openProject.mockResolvedValue({
    project: PROJECT, documents, recovery: { available: false, draftTime: null }, folders: ["vocab"],
    found: [], missing: [], skipped: [], wroteModel: false, revisionShift: 0,
  });
  listData.mockResolvedValue({ generation: 0, snapshots: [] });
  await projectStore.open(PID);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  projectStore._reset();
  localStorage.clear();
});

describe("per-tab editor text (5.9 item 4, AC-28)", () => {
  it("keeps each file's unapplied text across a switch of tabs", async () => {
    await open();
    projectStore.setEditorDraft(A);
    projectStore.switchDocument("f00000001");
    // The file arrived at has nothing unapplied of its own yet.
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
    projectStore.setEditorDraft(B);
    projectStore.switchDocument("model");
    expect(projectStore.getSnapshot().editorDraft).toBe(A);
    projectStore.switchDocument("f00000001");
    expect(projectStore.getSnapshot().editorDraft).toBe(B);
    // The active file's text is never in the map as well as in the draft.
    expect(Object.keys(projectStore.getSnapshot().editorTexts)).toEqual(["model"]);
  });

  it("knows that another tab holds text, which is what App asks about", async () => {
    await open();
    expect(unappliedText(projectStore.getSnapshot())).toBe(false);
    projectStore.setEditorDraft(A);
    projectStore.switchDocument("f00000001");
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
    expect(unappliedText(projectStore.getSnapshot())).toBe(true);
    projectStore.discardEditors();
    expect(unappliedText(projectStore.getSnapshot())).toBe(false);
    expect(projectStore.getSnapshot().editorTexts).toEqual({});
  });

  it("applies every tab's text, the file shown first", async () => {
    await open();
    applyDocumentSource.mockImplementation(async (_pid: string, doc: string) => ({
      label: `applied in ${doc}`, state: state(doc, `${doc}.ttl`, "ontology", { revision: 1, dirty: true }),
    }));
    projectStore.setEditorDraft(A);
    projectStore.switchDocument("f00000001");
    projectStore.setEditorDraft(B);
    await projectStore.applyEditors();
    expect(applyDocumentSource.mock.calls.map((c) => c[1])).toEqual(["f00000001", "model"]);
    expect(unappliedText(projectStore.getSnapshot())).toBe(false);
  });

  it("makes the file whose Turtle will not parse the active one, and says so", async () => {
    await open();
    applyDocumentSource.mockImplementation(async (_pid: string, doc: string) => {
      if (doc === "model") throw new TurtleError("Line 2: bad", 2, 1, "detail");
      return { label: "applied", state: state(doc, "x.ttl", "ontology", { revision: 1 }) };
    });
    projectStore.setEditorDraft(A);
    projectStore.switchDocument("f00000001");
    projectStore.setEditorDraft(B);
    await expect(projectStore.applyEditors()).rejects.toThrow("Line 2: bad");
    const snapshot = projectStore.getSnapshot();
    expect(snapshot.activeDoc).toBe("model");
    expect(snapshot.editorDraft).toBe(A);
  });

  it("acts on the active file for undo and save", async () => {
    await open();
    undoChange.mockResolvedValue({ label: "a change", state: state("f00000001", "vocab/equipment.ttl", "vocabulary") });
    saveDocument.mockResolvedValue({ state: state("f00000001", "vocab/equipment.ttl", "vocabulary") });
    projectStore.switchDocument("f00000001");
    await projectStore.undo();
    expect(undoChange).toHaveBeenCalledWith(PID, "f00000001");
    await projectStore.save();
    expect(saveDocument).toHaveBeenCalledWith(PID, "f00000001", false);
  });
});

describe("the open tabs (5.9 items 1, 3 and 5)", () => {
  it("opens on the project's first file and adds a tab per file switched to", async () => {
    await open();
    expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
    projectStore.switchDocument("shapes");
    projectStore.switchDocument("f00000001");
    projectStore.switchDocument("shapes");
    expect(projectStore.getSnapshot().openDocs).toEqual(["model", "shapes", "f00000001"]);
  });

  it("remembers them per project and opens them again, the ids the project still holds", async () => {
    await open();
    projectStore.switchDocument("f00000001");
    expect(JSON.parse(localStorage.getItem(tabsKey(PID))!)).toEqual(["model", "f00000001"]);
    projectStore._reset();
    await open();
    expect(projectStore.getSnapshot().openDocs).toEqual(["model", "f00000001"]);
    expect(projectStore.getSnapshot().activeDoc).toBe("model");
    // A file that is no longer in the project simply drops out.
    projectStore._reset();
    await open([DOCS[0], DOCS[2]]);
    expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
  });

  it("opens on the first file where the browser refuses storage", async () => {
    await open();
    projectStore.switchDocument("f00000001");
    projectStore._reset();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    const put = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    try {
      await open();
      expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
      // And a switch still works, with nothing remembered.
      projectStore.switchDocument("shapes");
      expect(projectStore.getSnapshot().openDocs).toEqual(["model", "shapes"]);
    } finally {
      get.mockRestore();
      put.mockRestore();
    }
  });

  it("takes text and tabs that will not parse as nothing remembered", async () => {
    localStorage.setItem(tabsKey(PID), "{not json");
    await open();
    expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
  });

  it("keeps the file the views fall back to as a tab, even with its tab closed", async () => {
    await open();
    projectStore.switchDocument("f00000001");
    projectStore.closeTab("model");
    expect(projectStore.getSnapshot().openDocs).toEqual(["f00000001"]);
    removeProjectFile.mockResolvedValue({ trashed: ".trash/x", folders: ["vocab"], revisionShift: 2 });
    const next = await projectStore.removeFile("f00000001");
    expect(next?.doc).toBe("model");
    expect(projectStore.getSnapshot().activeDoc).toBe("model");
    expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
  });

  it("drops the tab and the kept text of a file that is removed", async () => {
    await open();
    projectStore.switchDocument("f00000001");
    projectStore.setEditorDraft(B);
    projectStore.switchDocument("model");
    expect(projectStore.getSnapshot().openDocs).toEqual(["model", "f00000001"]);
    expect(projectStore.getSnapshot().editorTexts.f00000001).toBe(B);
    removeProjectFile.mockResolvedValue({ trashed: ".trash/x", folders: ["vocab"], revisionShift: 2 });
    await projectStore.removeFile("f00000001");
    expect(projectStore.getSnapshot().openDocs).toEqual(["model"]);
    expect(projectStore.getSnapshot().editorTexts).toEqual({});
  });
});

describe("a change across files (links-between-files 5.1, 8.2)", () => {
  it("an undo of a grouped step refreshes every touched file, not only the one asked", async () => {
    await open();
    const moved = (doc: string, file: string, role: "ontology" | "vocabulary" | "shapes") =>
      state(doc, file, role, { revision: 5, dirty: true, undoLabel: null, canUndo: false });
    undoChange.mockResolvedValue({
      revision: 5, label: "Renamed x:Pump to x:Pumpe (also in equipment.ttl, shapes.ttl)",
      state: moved("model", "model.ttl", "ontology"),
      documents: [
        { doc: "model", revision: 5, state: moved("model", "model.ttl", "ontology") },
        { doc: "f00000001", revision: 5, state: moved("f00000001", "vocab/equipment.ttl", "vocabulary") },
        { doc: "shapes", revision: 5, state: moved("shapes", "shapes.ttl", "shapes") },
      ],
    });
    await projectStore.undo();
    expect(projectStore.getSnapshot().documents.map((d) => d.revision)).toEqual([5, 5, 5]);
    expect(projectStore.getSnapshot().announcement.text).toContain("Undid: Renamed x:Pump to x:Pumpe");
  });
});
