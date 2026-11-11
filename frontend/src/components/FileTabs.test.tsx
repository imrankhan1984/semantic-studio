/*
================================================================================
FILE: frontend/src/components/FileTabs.test.tsx
================================================================================

SUMMARY
    The tab strip (multi-file-projects 5.9, Section 6, AC-25 to AC-28): a
    tab per open file, choosing a file already open moving to its tab, an
    unsaved file saying so in words, closing a tab discarding nothing, the
    last tab without a close button, two files of the same name showing
    their folders, and the arrow keys.

BASIC IDEA
    api.ts is mocked and the real project store is opened on a fixed
    project, so a press goes through the store action the app runs and the
    strip re-renders from the store. jsdom has no sequential focus
    navigation, so the tab order is asserted as tabindex and measured in a
    browser (a11y-check).

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, listData, applyDocumentSource } = vi.hoisted(() => ({
  openProject: vi.fn(),
  listData: vi.fn(),
  applyDocumentSource: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  listData,
  applyDocumentSource,
}));

import { projectStore } from "../state/projectStore";
import type { ProjectDocumentState } from "../types";
import FileTabs from "./FileTabs";

const PID = "prj-0123456789ab";
const PROJECT = {
  id: PID, name: "Plant", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};

function state(doc: string, file: string, role: "ontology" | "vocabulary" | "shapes", extra: Record<string, unknown> = {}) {
  return {
    doc, file, role, ontologyId: `${PID}-${doc}`, revision: 0, dirty: false, canUndo: false,
    undoLabel: null, canRedo: false, redoLabel: null, triples: 4, ...extra,
  } as ProjectDocumentState;
}

const DOCS = [
  state("model", "model.ttl", "ontology"),
  state("shapes", "shapes.ttl", "shapes"),
  state("f00000001", "vocab/equipment.ttl", "vocabulary", { dirty: true }),
  state("f00000002", "vocab/model.ttl", "ontology"),
];

let onOpenFile: ReturnType<typeof vi.fn<(doc: string) => void>>;
let onClosed: ReturnType<typeof vi.fn<(next: ProjectDocumentState | null) => void>>;

async function open(documents = DOCS) {
  openProject.mockResolvedValue({
    project: PROJECT, documents, recovery: { available: false, draftTime: null }, folders: ["vocab"],
    found: [], missing: [], skipped: [], wroteModel: false,
  });
  listData.mockResolvedValue({ generation: 0, snapshots: [] });
  await act(async () => {
    await projectStore.open(PID);
  });
  onOpenFile = vi.fn((doc: string) => projectStore.switchDocument(doc));
  onClosed = vi.fn();
  render(<FileTabs onOpenFile={onOpenFile} onClosed={onClosed} />);
}

const tabs = () => screen.getAllByRole("tab");
const tab = (name: RegExp | string) => screen.getByRole("tab", { name });

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
  } catch {
    // Nothing to clear where storage is refused; the tests do not need it.
  }
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("the strip (5.9 items 1 and 2, AC-25)", () => {
  it("opens with the project's first file and adds a tab per file opened", async () => {
    await open();
    expect(screen.getByRole("tablist", { name: "Open files" })).toBeTruthy();
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["model.ttl"]);
    await act(async () => projectStore.switchDocument("f00000001"));
    await act(async () => projectStore.switchDocument("shapes"));
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual([
      "model.ttl", "equipment.ttl, in vocab, unsaved", "shapes.ttl",
    ]);
    // The unsaved file says so in words, not colour alone.
    expect(tab(/^equipment/).textContent).toContain("unsaved");
    expect(tabs().filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual([
      "shapes.ttl",
    ]);
  });

  it("moves to the tab of a file already open rather than opening it twice", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    await act(async () => projectStore.switchDocument("model"));
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["model.ttl", "equipment.ttl, in vocab, unsaved"]);
    expect(tab("model.ttl").getAttribute("aria-selected")).toBe("true");
  });

  it("shows the folders of two open files that share a name (AC-27)", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000002"));
    expect(tabs().map((t) => t.textContent)).toEqual(["model.ttl", "model.ttlin vocab"]);
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["model.ttl", "model.ttl, in vocab"]);
  });

  it("gives the strip one tab stop, on the file shown", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    expect(tabs().filter((t) => t.tabIndex === 0).map((t) => t.textContent)).toEqual([
      "equipment.ttl● unsaved",
    ]);
  });
});

describe("the keyboard (Section 6)", () => {
  it("moves with the arrow keys, Home and End, and chooses with Enter and Space", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    await act(async () => projectStore.switchDocument("shapes"));
    const here = tab("shapes.ttl");
    here.focus();
    fireEvent.keyDown(here, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab(/^equipment/));
    // Moving focus alone chooses nothing (manual activation).
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(tab("model.ttl"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("model");
    fireEvent.keyDown(tab("model.ttl"), { key: "End" });
    expect(document.activeElement).toBe(tab("shapes.ttl"));
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(onOpenFile).toHaveBeenLastCalledWith("shapes");
    fireEvent.keyDown(tab("shapes.ttl"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("shapes.ttl"));
  });

  it("names each close button after its file and keeps it beside its tab", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    const close = screen.getByRole("button", { name: "Close equipment.ttl" });
    expect(close.previousElementSibling).toBe(tab(/^equipment/));
    expect(close.tabIndex).toBe(0);
    // Not a tab stop for a file the keyboard has not arrived at.
    expect((screen.getByRole("button", { name: "Close model.ttl" }) as HTMLElement).tabIndex).toBe(-1);
  });
});

describe("closing a tab (5.9 item 3, AC-26)", () => {
  it("discards nothing: the file keeps its unsaved changes and its text", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    projectStore.setEditorDraft("@prefix : <http://x#> .\n:Typed a :Thing .\n");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close equipment.ttl" }));
    });
    expect(tabs().map((t) => t.textContent)).toEqual(["model.ttl"]);
    const snapshot = projectStore.getSnapshot();
    // The file is still there, still unsaved, with its text kept for when
    // it is opened again; the server was not asked to discard anything.
    expect(snapshot.documents.find((d) => d.doc === "f00000001")?.dirty).toBe(true);
    expect(snapshot.editorTexts.f00000001).toContain(":Typed a :Thing .");
    expect(applyDocumentSource).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed.mock.calls[0][0]?.doc).toBe("model");
    // Opened again, after the page moved to the file left, the text is
    // where it was.
    await act(async () => projectStore.switchDocument("model"));
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
    await act(async () => projectStore.switchDocument("f00000001"));
    expect(projectStore.getSnapshot().editorDraft).toContain(":Typed a :Thing .");
  });

  it("leaves the last tab without a close button", async () => {
    await open();
    expect(tabs()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
    await act(async () => projectStore.switchDocument("shapes"));
    expect(screen.getAllByRole("button", { name: /^Close/ })).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close model.ttl" }));
    });
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
    expect(projectStore.closeTab("shapes")).toBeNull();
    expect(tabs()).toHaveLength(1);
  });

  it("keeps focus in the strip, on the tab that stood where the closed one did", async () => {
    await open();
    await act(async () => projectStore.switchDocument("f00000001"));
    await act(async () => projectStore.switchDocument("shapes"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close equipment.ttl" }));
    });
    expect(document.activeElement).toBe(tab("shapes.ttl"));
    expect(onClosed).not.toHaveBeenCalled(); // it was not the file shown
  });
});
