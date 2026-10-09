// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SnapshotList.test.tsx
================================================================================

SUMMARY
    The project's Data section (csv-data-import 5.7): each row's label, a
    sample's words included; the switch; Refresh at once, with the limit's
    two choices, and handing a header mismatch to the wizard; Edit as RML
    run, kept outside the engine, and refused; Remove after saying how many
    statements leave. None of it is a model change. Stage B: a workbook's
    snapshot refreshed by its sheet and header row, and its links to no row.

BASIC IDEA
    api.ts is mocked and the real project store is opened on a fixed
    project, so every action's announcement and the refetched list are the
    store's own.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, listData, updateData, refreshData, removeData, inspectData, runCommand } = vi.hoisted(() => ({
  openProject: vi.fn(),
  listData: vi.fn(),
  updateData: vi.fn(),
  refreshData: vi.fn(),
  removeData: vi.fn(),
  inspectData: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  listData,
  updateData,
  refreshData,
  removeData,
  inspectData,
  runCommand,
}));

import { ApiError } from "../api";
import { projectStore } from "../state/projectStore";
import type { SnapshotSummary } from "../types";
import type { WizardStart } from "./DataWizard";
import SnapshotList from "./SnapshotList";

const PID = "prj-0123456789ab";
const PROJECT = {
  id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};
const MODEL = {
  doc: "model" as const, ontologyId: `${PID}-model`, revision: 4, dirty: false,
  canUndo: false, undoLabel: null, canRedo: false, redoLabel: null, triples: 1,
};
const REPORT = {
  rowsRead: 2000, total: 12480, sample: true, individuals: 2000, statements: 4000, skipped: { count: 0, rows: [] },
  repeated: { count: 0, rows: [] }, keptAsText: [{ column: "born", datatype: "date", count: 1000, rows: [2] }], empty: [], clean: false,
};
const SNAP: SnapshotSummary = {
  id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true,
  enabled: true, className: "Person", classIri: "http://x#Person", statements: 4000, individuals: 2000, report: REPORT,
  mapping: { status: "ok", message: null }, mappingText: '<#m> a rml:TriplesMap .',
};
const FILE = new File(["id\n1\n"], "people-2.csv");

let onWizard: ReturnType<typeof vi.fn<(start: WizardStart) => void>>;

async function setup(snapshots: SnapshotSummary[] = [SNAP]) {
  openProject.mockResolvedValue({ project: PROJECT, documents: [MODEL], recovery: { available: false, draftTime: null } });
  listData.mockResolvedValue({ generation: 1, snapshots });
  await act(async () => {
    await projectStore.open(PID);
  });
  onWizard = vi.fn<(start: WizardStart) => void>();
  await act(async () => {
    render(<SnapshotList projectId={PID} onWizard={onWizard} />);
  });
}

async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  projectStore._reset();
});
afterEach(cleanup);

describe("SnapshotList", () => {
  it("says there is no data yet, and offers the import", async () => {
    await setup([]);
    expect(screen.getByText(/No data yet/)).toBeTruthy();
    await press(screen.getByRole("button", { name: "Import data from CSV or Excel…" }));
    expect(onWizard).toHaveBeenCalledWith({ kind: "new" });
  });

  it("takes focus on its heading when the wizard hands back, never dropping it to the page (X4)", async () => {
    openProject.mockResolvedValue({ project: PROJECT, documents: [MODEL], recovery: { available: false, draftTime: null } });
    listData.mockResolvedValue({ generation: 1, snapshots: [SNAP] });
    await act(async () => {
      await projectStore.open(PID);
    });
    await act(async () => {
      render(<SnapshotList projectId={PID} onWizard={() => {}} focusOnMount />);
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Data" }));
  });

  it("labels each snapshot with where it came from, a sample's words included", async () => {
    await setup();
    expect(screen.getByText("from people.csv, imported 2 October 2026; sample: first 2,000 of 12,480 rows")).toBeTruthy();
    expect(screen.getByText(/2,000 People · 1,000 values kept as text/)).toBeTruthy();
  });

  it("switches a snapshot off, says so, and moves the generation without a model change", async () => {
    await setup();
    updateData.mockResolvedValue({ snapshot: { ...SNAP, enabled: false }, generation: 2 });
    listData.mockResolvedValue({ generation: 2, snapshots: [{ ...SNAP, enabled: false }] });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    expect(updateData).toHaveBeenCalledWith(PID, SNAP.id, { enabled: false });
    expect(projectStore.getSnapshot().announcement.text).toBe(
      "Switched off people.csv: its data has left every view and validation.",
    );
    expect(projectStore.getSnapshot().data?.generation).toBe(2);
    expect(screen.getByText("Off: in no view")).toBeTruthy();
    expect(projectStore.getSnapshot().documents[0].revision).toBe(4);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refreshes at once when the headers match, after step 1's checks", async () => {
    await setup();
    inspectData.mockResolvedValue({ sample: false, limit: 2000 });
    refreshData.mockResolvedValue({ status: "imported", snapshot: { ...SNAP, source: "people-2.csv" }, generation: 2 });
    await act(async () => {
      fireEvent.change(document.querySelector(".snapshot-row input[type=file]")!, { target: { files: [FILE] } });
    });
    expect(inspectData).toHaveBeenCalledWith(PID, { file: FILE }, {});
    expect(refreshData).toHaveBeenCalledWith(PID, SNAP.id, FILE, { sample: false });
    expect(projectStore.getSnapshot().announcement.text).toBe("Refreshed people.csv from people-2.csv.");
    expect(screen.getByRole("button", { name: "Report" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("asks the limit's two choices of a larger file, and hands a header mismatch to the wizard", async () => {
    await setup();
    inspectData.mockResolvedValue({ sample: true, limit: 2000, limitSentence: "This file has 5,000 rows. Semantic Studio imports at most 2,000 rows." });
    await act(async () => {
      fireEvent.change(document.querySelector(".snapshot-row input[type=file]")!, { target: { files: [FILE] } });
    });
    expect(refreshData).not.toHaveBeenCalled();
    const limit = screen.getByRole("group", { name: "More rows than the tool takes" });
    expect(within(limit).getByText(/This file has 5,000 rows/)).toBeTruthy();
    const inspection = { columns: [] };
    refreshData.mockResolvedValue({ status: "mismatch", missing: ["born"], inspection, choices: null, generation: 1 });
    await press(within(limit).getByRole("button", { name: "Use the first 2,000 rows" }));
    expect(refreshData).toHaveBeenCalledWith(PID, SNAP.id, FILE, { sample: true });
    expect(onWizard).toHaveBeenCalledWith({
      kind: "refresh", snapshot: SNAP, file: FILE, options: { sample: true }, inspection, missing: ["born"], choices: null,
    });
  });

  it("reads a workbook's new version by the same sheet and header row, and counts its links to no row (Stage B)", async () => {
    const ORGS: SnapshotSummary = {
      ...SNAP, id: "orgs-def456", source: "orgs.xlsx", rows: 41, total: 41, sample: false,
      workbook: { sheet: "Orgs", headerRow: 3 },
      report: { ...REPORT, total: 41, sample: false, keptAsText: [],
        unmatched: [{ column: "parent", className: "Organization", classIri: "http://x#Organization", count: 2, rows: [4, 7] }] },
    };
    await setup([ORGS]);
    expect(screen.getByText(/· sheet Orgs · 2 links to no row/)).toBeTruthy();
    const book = new File(["PK"], "orgs-2.xlsx");
    inspectData.mockResolvedValue({ sample: false, limit: 2000 });
    refreshData.mockResolvedValue({ status: "imported", snapshot: { ...ORGS, source: "orgs-2.xlsx" }, generation: 2 });
    const input = document.querySelector(".snapshot-row input[type=file]") as HTMLInputElement;
    expect(input.getAttribute("accept")).toContain(".xlsx");
    await act(async () => {
      fireEvent.change(input, { target: { files: [book] } });
    });
    expect(inspectData).toHaveBeenCalledWith(PID, { file: book }, { sheet: "Orgs", headerRow: 3 });
    expect(refreshData).toHaveBeenCalledWith(PID, ORGS.id, book, { sheet: "Orgs", headerRow: 3, sample: false });
    // The refresh opened the report.
    expect(screen.getByText("parent: 2 values match no Organization row (rows 4 and 7)")).toBeTruthy();
  });

  it("edits the mapping as RML: run, kept outside the engine, or refused", async () => {
    await setup();
    await press(screen.getByRole("button", { name: "Edit as RML" }));
    const box = screen.getByLabelText("RML mapping of people.csv · mapping.rml.ttl") as HTMLTextAreaElement;
    expect(box.value).toBe(SNAP.mappingText);
    fireEvent.change(box, { target: { value: "edited" } });
    updateData.mockRejectedValue(new ApiError("rml:source must name this snapshot's own source.csv; this mapping names ../model.ttl.", 422));
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/^rml:source must name/);
    const outside = { ...SNAP, mapping: { status: "outside" as const, message: "rml:function is outside what Semantic Studio runs." } };
    updateData.mockResolvedValue({ snapshot: outside, generation: 2 });
    listData.mockResolvedValue({ generation: 2, snapshots: [outside] });
    await press(screen.getByRole("button", { name: "Apply" }));
    expect(updateData).toHaveBeenLastCalledWith(PID, SNAP.id, { mapping: "edited" });
    expect(screen.getByText("Mapping outside the engine: rml:function is outside what Semantic Studio runs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh…" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("says how many statements leave before removing", async () => {
    await setup();
    await press(screen.getByRole("button", { name: "Remove…" }));
    const ask = screen.getByRole("group", { name: "Remove people.csv?" });
    expect(within(ask).getByText(/Its 4,000 statements leave every view and validation/)).toBeTruthy();
    removeData.mockResolvedValue({ removed: SNAP.id, statements: 4000, location: ".trash/data-people-abc123", generation: 2 });
    listData.mockResolvedValue({ generation: 2, snapshots: [] });
    await press(within(ask).getByRole("button", { name: "Remove" }));
    expect(removeData).toHaveBeenCalledWith(PID, SNAP.id);
    expect(projectStore.getSnapshot().announcement.text).toBe(
      "Removed people.csv: 4,000 statements left the views. Its folder is in the project's trash.",
    );
    expect(screen.getByText(/No data yet/)).toBeTruthy();
  });
});
