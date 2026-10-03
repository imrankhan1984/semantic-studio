// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/LoadDialog.test.tsx
================================================================================

SUMMARY
    The Load dialog's tabs, its first test (CLAUDE.md lists them untested):
    the three ontology tabs always, and the project's Data tab only while a
    project is open (csv-data-import 5.1), opening with the wizard started
    when the tree asked for an import, and not closed by a click outside
    while the wizard runs. Past step 3 the ✕ and a tab switch ask "Leave the
    wizard?" as Cancel does (PR #53 review), driven through the real wizard.
    Focus goes to the Data heading when the wizard closes, and only then
    (csv-data-import X4).

BASIC IDEA
    api.ts is mocked; the snapshot list reads the real project store, left
    empty, so the list says it is reading -- opened on a fixed project where
    the focus test needs the list itself.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchHierarchy, inspectData, previewData, openProject, listData } = vi.hoisted(() => ({
  fetchHierarchy: vi.fn(() => new Promise(() => {})),
  inspectData: vi.fn(),
  previewData: vi.fn(),
  openProject: vi.fn(),
  listData: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fetchHierarchy,
  inspectData,
  previewData,
  openProject,
  listData,
}));

import { projectStore } from "../state/projectStore";
import LoadDialog from "./LoadDialog";

const PROJECT = { id: "prj-0123456789ab", name: "Shop", modelOntologyId: "prj-0123456789ab-model", taxonomy: false };

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("LoadDialog", () => {
  it("has the three ontology tabs and no Data tab without a project", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    for (const name of ["Suggested", "Local file", "URL / GitHub"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Data for this project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Local file" }));
    expect(screen.getByText("Drop an ontology file here, or click to browse.")).toBeTruthy();
  });

  it("adds the project's Data tab, titled with the project", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: "Data for this project" }));
    expect(screen.getByRole("heading", { name: "Data for Shop" })).toBeTruthy();
    expect(screen.getByText("Reading the project's data…")).toBeTruthy();
  });

  it("opens on Data with the wizard started, and a click outside does not drop it", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
    });
    expect(screen.getByRole("heading", { name: "Step 1 of 4: the file" })).toBeTruthy();
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Reading the project's data…")).toBeTruthy();
  });

  it("gives focus to the Data heading when the wizard closes, and not again after a tab switch (X4)", async () => {
    openProject.mockResolvedValue({
      project: { id: PROJECT.id, name: "Shop", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
        primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" },
      documents: [{ doc: "model", ontologyId: `${PROJECT.id}-model`, revision: 1, dirty: false, canUndo: false,
        undoLabel: null, canRedo: false, redoLabel: null, triples: 1 }],
      recovery: { available: false, draftTime: null },
    });
    listData.mockResolvedValue({ generation: 1, snapshots: [] });
    await act(async () => {
      await projectStore.open(PROJECT.id);
    });
    await act(async () => {
      render(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} initialTab="data" startImport />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    const heading = screen.getByRole("heading", { name: "Data" });
    expect(document.activeElement).toBe(heading);
    const suggested = screen.getByRole("button", { name: "Suggested" });
    suggested.focus();
    fireEvent.click(suggested);
    const data = screen.getByRole("button", { name: "Data for this project" });
    data.focus();
    await act(async () => {
      fireEvent.click(data);
    });
    expect(document.activeElement).toBe(data);
  });

  it("falls back to Suggested when Data is asked for with no project open", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="data" />);
    expect(screen.getByRole("heading", { name: "Load ontology" })).toBeTruthy();
    expect(screen.getByText(/Well-known public ontologies/)).toBeTruthy();
  });

  describe("leaving a wizard with a mapping (PR #53 review)", () => {
    const X = "http://example.org/shop#";

    async function toStep3(onClose = vi.fn()) {
      fetchHierarchy.mockResolvedValue({
        classes: { nodes: { [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false } }, children: {}, roots: [] },
        concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 1, concepts: 0 }, truncated: false,
      } as never);
      inspectData.mockResolvedValue({
        separator: ",", separatorName: "comma", encoding: "utf-8", header: true,
        columns: [{ name: "id", empty: 0, unique: true, repeats: 0, wholeNumbers: true, numbers: true, dates: false, dateTimes: false }],
        renamed: [], rows: [["1"]], total: 1, kept: 1, limit: 2000, sample: false, limitSentence: null,
        idSuggestion: "id", nameSuggestion: null,
      });
      previewData.mockResolvedValue({
        idCheck: { column: "id", ok: true, missing: { count: 0, rows: [] }, repeats: 0, repeated: { count: 0, rows: [] } },
        fields: [], suggestions: {}, className: "Person",
      });
      await act(async () => {
        render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
      });
      await act(async () => {
        fireEvent.change(document.querySelector(".data-wizard input[type=file]")!, {
          target: { files: [new File(["id,1"], "a.csv")] },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      });
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      return onClose;
    }

    it("asks before the ✕ closes the dialog, and Keep going keeps the wizard", async () => {
      const onClose = await toStep3();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
      const ask = screen.getByRole("group", { name: "Leave the wizard?" });
      fireEvent.click(within(ask).getByRole("button", { name: "Keep going" }));
      expect(screen.queryByRole("group", { name: "Leave the wizard?" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("asks before another tab drops the wizard", async () => {
      await toStep3();
      fireEvent.click(screen.getByRole("button", { name: "Suggested" }));
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(screen.getByText(/Well-known public ontologies/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Data for this project" }));
      expect(screen.queryByRole("heading", { name: "Step 3 of 4: the columns" })).toBeNull();
    });

    it("does not ask before step 3, where there is nothing to lose", async () => {
      const onClose = vi.fn();
      await act(async () => {
        render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
      });
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
