// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/DataWizard.test.tsx
================================================================================

SUMMARY
    The data import wizard (csv-data-import 5.2 to 5.5, Section 6): the
    detections and a change to one, the 2,000-row limit and its two choices,
    the identifier check and Use the row number instead, suggestions marked
    and preselected, a new attribute as one command, the preview as
    sentences, the import and its report, the heading focus on each step,
    and Cancel asking only once the columns are mapped. Stage B: a
    workbook's sheet and header row pickers, kept through a failed read, and
    step 4 naming the links that match no row yet (5.8, 5.9). X-12: a
    refresh through step 1, the class reading keyed on the sheet and header
    row, the announcement's count of things, and a taxonomy's labels.
    attribute-reuse 5.6: a new class made as the project's default kind,
    said beside its name and named in the summary step.

BASIC IDEA
    api.ts is mocked; the real project store is opened on a fixed project,
    so a new attribute goes through the same command action the form uses.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, runCommand, inspectData, previewData, importData, fetchHierarchy, listData, updateData, refreshData } =
  vi.hoisted(() => ({
    refreshData: vi.fn(),
    openProject: vi.fn(),
    runCommand: vi.fn(),
    inspectData: vi.fn(),
    previewData: vi.fn(),
    importData: vi.fn(),
    fetchHierarchy: vi.fn(),
    listData: vi.fn(),
    updateData: vi.fn(),
  }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  runCommand,
  inspectData,
  previewData,
  importData,
  fetchHierarchy,
  listData,
  updateData,
  refreshData,
}));

import { projectStore } from "../state/projectStore";
import type { DataInspection, DataPreview, SnapshotSummary } from "../types";
import DataWizard, { type WizardStart } from "./DataWizard";

const PID = "prj-0123456789ab";
const X = "http://example.org/shop#";
const PROJECT = {
  id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: X, prefix: "shop",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};
const MODEL = {
  doc: "model" as const, ontologyId: `${PID}-model`, revision: 1, dirty: false,
  canUndo: false, undoLabel: null, canRedo: false, redoLabel: null, triples: 1,
};

function profile(name: string, changes = {}) {
  return { name, empty: 0, unique: true, repeats: 0, wholeNumbers: false, numbers: false, dates: false, dateTimes: false, ...changes };
}

function inspection(changes: Partial<DataInspection> = {}): DataInspection {
  return {
    separator: ",", separatorName: "comma", encoding: "utf-8", header: true,
    columns: [profile("id", { wholeNumbers: true }), profile("name"), profile("born", { dates: true }), profile("age", { wholeNumbers: true })],
    renamed: [], rows: [["1", "Bob", "yesterday", "41"]], total: 1, kept: 1, limit: 2000, sample: false,
    limitSentence: null, idSuggestion: "id", nameSuggestion: "name",
    ...changes,
  };
}

const OK_ID = { column: "id", ok: true, missing: { count: 0, rows: [] }, repeats: 0, repeated: { count: 0, rows: [] } };
const REPORT = {
  rowsRead: 1, total: 1, sample: false, individuals: 1, statements: 3, skipped: { count: 0, rows: [] },
  repeated: { count: 0, rows: [] }, keptAsText: [{ column: "born", datatype: "date", count: 1, rows: [1] }], empty: [], clean: false,
};

function preview(changes: Partial<DataPreview> = {}): DataPreview {
  return {
    idCheck: OK_ID,
    fields: [{ property: `${X}birthDate`, label: "birth date", kind: "attribute", datatype: "xsd:date", text: false }],
    suggestions: { name: { as: "name" }, born: { as: "attribute", property: `${X}birthDate` } },
    className: "Person",
    rows: [{ row: 1, subject: `${X}data/person/1`, name: "Bob", values: [
      { column: "born", label: "birth date", value: "yesterday", kind: "value", datatype: "date", fits: false },
    ] }],
    report: REPORT,
    ...changes,
  };
}

const SNAPSHOT: SnapshotSummary = {
  id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 1, total: 1, sample: false,
  enabled: true, className: "Person", classIri: `${X}Person`, statements: 3, individuals: 1, report: REPORT,
  mapping: { status: "ok", message: null },
};

const FILE = new File(["id,name,born,age\n1,Bob,yesterday,41\n"], "people.csv", { type: "text/csv" });

let onClose: ReturnType<typeof vi.fn<() => void>>;

async function setup() {
  openProject.mockResolvedValue({ project: PROJECT, documents: [MODEL], recovery: { available: false, draftTime: null } });
  listData.mockResolvedValue({ generation: 1, snapshots: [] });
  await projectStore.open(PID);
  fetchHierarchy.mockResolvedValue({
    classes: { nodes: { [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false } }, children: {}, roots: [`${X}Person`] },
    concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 1, concepts: 0 }, truncated: false,
  });
  previewData.mockResolvedValue(preview());
  onClose = vi.fn<() => void>();
  await act(async () => {
    render(<DataWizard projectId={PID} modelOntologyId={`${PID}-model`} taxonomy={false} start={{ kind: "new" }} onClose={onClose} />);
  });
}

async function chooseFile(found = inspection()) {
  inspectData.mockResolvedValue(found);
  const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [FILE] } });
  });
}

const next = () => screen.getByRole("button", { name: "Next" });

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

describe("step 1: the file (5.2)", () => {
  it("shows what was detected, each changeable, and reads the file again on a change", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "Step 1 of 4: the file" })).toBe(document.activeElement);
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Choose a file first.")).toBeTruthy();
    await chooseFile();
    expect((screen.getByLabelText("Separator") as HTMLSelectElement).value).toBe(",");
    expect((screen.getByLabelText("Encoding") as HTMLSelectElement).value).toBe("utf-8");
    expect((screen.getByLabelText("First row is the header") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("columnheader", { name: "born" })).toBeTruthy();
    expect(next().getAttribute("aria-disabled")).toBe("false");
    inspectData.mockResolvedValue(inspection({ separator: ";" }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Separator"), { target: { value: ";" } });
    });
    expect(inspectData).toHaveBeenLastCalledWith(PID, { file: FILE }, { separator: ";", sample: false });
  });

  it("says the tool's limit past 2,000 rows, and waits for one of its two choices", async () => {
    await setup();
    await chooseFile(inspection({
      total: 12480, kept: 2000, sample: true,
      limitSentence: "This file has 12,480 rows. Semantic Studio imports at most 2,000 rows: it is for learning how data is mapped to a model, not for loading whole datasets.",
    }));
    expect(screen.getByText(/This file has 12,480 rows\. Semantic Studio imports at most 2,000 rows/)).toBeTruthy();
    const limit = screen.getByRole("group", { name: "More rows than the tool takes" });
    expect(within(limit).getByRole("button", { name: "Choose another file" })).toBeTruthy();
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Choose to use the first 2,000 rows, or another file.")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Use the first 2,000 rows" }));
    expect(screen.getByText(/sample: first 2,000 of 12,480 rows/)).toBeTruthy();
    expect(next().getAttribute("aria-disabled")).toBe("false");
  });

  it("says a refused file is too large, in the server's words", async () => {
    await setup();
    const { ApiError } = await import("../api");
    inspectData.mockRejectedValue(new ApiError("This file has 101 columns. Semantic Studio imports at most 100 columns.", 413));
    const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [FILE] } });
    });
    expect(screen.getByRole("alert").textContent).toBe("Too large. This file has 101 columns. Semantic Studio imports at most 100 columns.");
  });
});

describe("steps 2 to 4 (5.3 to 5.5)", () => {
  async function toStep2() {
    await setup();
    await chooseFile();
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBe(document.activeElement);
  }

  it("checks the identifier and offers the row number instead", async () => {
    await toStep2();
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByLabelText(/Each row is identified by column/) as HTMLSelectElement).value).toBe("id");
    previewData.mockResolvedValue(preview({
      idCheck: { column: "id", ok: false, missing: { count: 14, rows: [7, 19, 230] }, repeats: 3, repeated: { count: 4, rows: [8] } },
    }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
    });
    expect(previewData).toHaveBeenLastCalledWith(PID, { file: FILE }, {}, { classIri: `${X}Person`, idColumn: "id", columns: {} });
    expect(screen.getByText("14 rows have no id (rows 7, 19, 230 and 11 more).")).toBeTruthy();
    expect(screen.getByText("id is not unique: 3 values repeat (rows 8 and 3 more).")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Use the row number instead" }));
    expect(previewData).toHaveBeenLastCalledWith(PID, { file: FILE }, {}, { classIri: `${X}Person`, idColumn: null, columns: {} });
    expect((screen.getByLabelText(/Each row is identified by column/) as HTMLSelectElement).value).toBe("");
  });

  it("preselects and marks the suggestions, makes a new attribute in one command, previews, imports and reports", async () => {
    await toStep2();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
    });
    await press(next());
    const table = screen.getByRole("table");
    expect((within(table).getByLabelText("name") as HTMLSelectElement).value).toBe("name");
    expect((within(table).getByLabelText("born") as HTMLSelectElement).value).toBe(`attribute ${X}birthDate`);
    expect((within(table).getByLabelText("id") as HTMLSelectElement).value).toBe("ignore");
    expect(within(table).getAllByText("suggested")).toHaveLength(2);

    // A new attribute: its type suggested from the values, one command.
    await act(async () => {
      fireEvent.change(within(table).getByLabelText("age"), { target: { value: "new" } });
    });
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("integer");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("age");
    runCommand.mockResolvedValue({ revision: 2, label: "Created datatype property age", state: { ...MODEL, revision: 2 }, created: `${X}age` });
    await press(screen.getByRole("button", { name: "Create attribute" }));
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateDatatypeProperty", {
      label: "age", domain: `${X}Person`, datatype: "http://www.w3.org/2001/XMLSchema#integer",
    });
    expect((within(table).getByLabelText("age") as HTMLSelectElement).value).toBe(`attribute ${X}age`);

    // Cancel asks, once the columns are mapped.
    await press(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Leave without importing\?/)).toBeTruthy();
    await press(screen.getByRole("button", { name: "Keep going" }));

    await press(next());
    expect(screen.getByText('Bob is a Person. Bob\'s birth date is "yesterday" — not a date, kept as text.')).toBeTruthy();
    expect(screen.getByText("1 row → 3 statements")).toBeTruthy();

    importData.mockResolvedValue({ snapshot: SNAPSHOT, generation: 2 });
    listData.mockResolvedValue({ generation: 2, snapshots: [SNAPSHOT] });
    await press(screen.getByRole("button", { name: "Import" }));
    expect(importData).toHaveBeenCalledWith(PID, FILE, {}, {
      classIri: `${X}Person`, idColumn: "id",
      columns: { id: { as: "ignore" }, name: { as: "name" }, born: { as: "attribute", property: `${X}birthDate` }, age: { as: "attribute", property: `${X}age` } },
    });
    expect(screen.getByRole("heading", { name: "Imported" })).toBe(document.activeElement);
    expect(screen.getByRole("status").textContent).toBe("1 row, 1 Person");
    expect(screen.getByText("born: 1 value is not a date, kept as text (row 1)")).toBeTruthy();
    expect(screen.getByText("from people.csv, imported 2 October 2026")).toBeTruthy();
    expect(projectStore.getSnapshot().data?.generation).toBe(2);
    expect(projectStore.getSnapshot().announcement.text).toBe("Imported people.csv: 1 thing made.");
  });
});

describe("the PR #53 review fixes", () => {
  const TWO_CLASSES = {
    classes: {
      nodes: {
        [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false },
        [`${X}Organization`]: { label: "Organization", prefixed: "shop:Organization", kind: "class", hasChildren: false },
      },
      children: {}, roots: [`${X}Person`, `${X}Organization`],
    },
    concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 2, concepts: 0 }, truncated: false,
  };

  async function toStep2() {
    await setup();
    fetchHierarchy.mockResolvedValue(TWO_CLASSES);
    await chooseFile();
    await press(next());
  }

  const classSelect = () => screen.getByLabelText("Each row is") as HTMLSelectElement;
  async function chooseClass(iri: string) {
    await act(async () => {
      fireEvent.change(classSelect(), { target: { value: iri } });
    });
  }

  it("1. a second file gets its own id suggested, not the row number", async () => {
    await setup();
    await chooseFile();
    await chooseFile(inspection({ columns: [profile("code"), profile("id", { wholeNumbers: true }), profile("name")] }));
    await press(next());
    expect((screen.getByLabelText(/Each row is identified by column/) as HTMLSelectElement).value).toBe("id");
  });

  it("2. a class change waits for that class's own reading before Next", async () => {
    await toStep2();
    await chooseClass(`${X}Person`);
    expect(next().getAttribute("aria-disabled")).toBe("false");
    previewData.mockReturnValue(new Promise(() => {}));
    await chooseClass(`${X}Organization`);
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Checking the identifier…")).toBeTruthy();
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
  });

  it("3. a failed reading says so with Try again, and Next waits for it", async () => {
    await toStep2();
    previewData.mockRejectedValueOnce(new Error("The server did not answer."));
    await chooseClass(`${X}Person`);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The server did not answer.");
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("The identifier could not be checked. Try again.")).toBeTruthy();
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
    previewData.mockResolvedValue(preview());
    await press(within(alert).getByRole("button", { name: "Try again" }));
    expect(next().getAttribute("aria-disabled")).toBe("false");
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
  });

  it("4. Import does nothing while the preview it waits for is not there", async () => {
    await toStep2();
    await chooseClass(`${X}Person`);
    await press(next());
    previewData.mockReturnValue(new Promise(() => {}));
    await press(next());
    const button = screen.getByRole("button", { name: "Import" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await press(button);
    expect(importData).not.toHaveBeenCalled();
  });
});

describe("Change the mapping (5.7)", () => {
  it("starts at step 2 on the copy kept, with the choices made before", async () => {
    openProject.mockResolvedValue({ project: PROJECT, documents: [MODEL], recovery: { available: false, draftTime: null } });
    listData.mockResolvedValue({ generation: 1, snapshots: [SNAPSHOT] });
    await projectStore.open(PID);
    fetchHierarchy.mockResolvedValue({
      classes: { nodes: { [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false } }, children: {}, roots: [] },
      concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 1, concepts: 0 }, truncated: false,
    });
    inspectData.mockResolvedValue(inspection({
      snapshot: SNAPSHOT.id,
      choices: { classIri: `${X}Person`, idColumn: "id", columns: { name: { as: "name" }, born: { as: "ignore" } } },
    }));
    previewData.mockResolvedValue(preview());
    await act(async () => {
      render(<DataWizard projectId={PID} modelOntologyId={`${PID}-model`} taxonomy={false} start={{ kind: "remap", snapshot: SNAPSHOT }} onClose={() => {}} />);
    });
    expect(inspectData).toHaveBeenCalledWith(PID, { snapshot: SNAPSHOT.id });
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await press(next());
    // The earlier choice wins over the suggestion.
    expect((screen.getByLabelText("born") as HTMLSelectElement).value).toBe("ignore");
    await press(next());
    updateData.mockResolvedValue({ snapshot: SNAPSHOT, generation: 3 });
    await press(screen.getByRole("button", { name: "Import again" }));
    expect(updateData).toHaveBeenCalledWith(PID, SNAPSHOT.id, {
      choices: { classIri: `${X}Person`, idColumn: "id", columns: { id: { as: "ignore" }, name: { as: "name" }, born: { as: "ignore" }, age: { as: "ignore" } } },
    });
  });
});

describe("Stage B: an Excel workbook (5.8) and links (5.9)", () => {
  const BOOK = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "orgs.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const WORKBOOK = {
    sheet: "Orgs", headerRow: 1,
    sheets: [{ name: "Orgs", rows: 41 }, { name: "Big", rows: 5000 }],
    top: [{ row: 1, cells: ["Organizations 2026"] }, { row: 2, cells: [] }, { row: 3, cells: ["id", "name", "founded"] }],
  };

  async function chooseBook(found: DataInspection) {
    inspectData.mockResolvedValue(found);
    const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
    expect(input.getAttribute("accept")).toContain(".xlsx");
    await act(async () => {
      fireEvent.change(input, { target: { files: [BOOK] } });
    });
  }

  it("offers the sheets with their rows and the first rows as header rows, and reads the workbook again on each", async () => {
    await setup();
    await chooseBook(inspection({ format: "xlsx", workbook: WORKBOOK, separator: ",", encoding: "utf-8" }));
    const sheet = screen.getByLabelText("Sheet") as HTMLSelectElement;
    expect(sheet.value).toBe("Orgs");
    expect([...sheet.options].map((o) => o.text)).toEqual(["Orgs (41 rows)", "Big (5,000 rows)"]);
    const header = screen.getByLabelText("Header row") as HTMLSelectElement;
    expect(header.value).toBe("1");
    expect([...header.options].map((o) => o.text)).toEqual([
      "Row 1: Organizations 2026", "Row 2 (empty)", "Row 3: id, name, founded",
    ]);
    // A CSV file's detections mean nothing for a workbook.
    expect(screen.queryByRole("checkbox", { name: "First row is the header" })).toBeNull();
    expect(screen.queryByLabelText("Separator")).toBeNull();
    expect(screen.queryByLabelText("Encoding")).toBeNull();

    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: { ...WORKBOOK, headerRow: 3 } }));
    await act(async () => {
      fireEvent.change(header, { target: { value: "3" } });
    });
    expect(inspectData).toHaveBeenLastCalledWith(PID, { file: BOOK }, { headerRow: 3, sample: false });
    expect((screen.getByLabelText("Header row") as HTMLSelectElement).value).toBe("3");

    // Another sheet starts again from its first row.
    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: { ...WORKBOOK, sheet: "Big" } }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Sheet"), { target: { value: "Big" } });
    });
    expect(inspectData).toHaveBeenLastCalledWith(PID, { file: BOOK }, { sheet: "Big", headerRow: undefined, sample: false });
    expect(JSON.parse(JSON.stringify(inspectData.mock.lastCall![2]))).toEqual({ sheet: "Big", sample: false });
  });

  it("keeps both pickers when a header row reads nothing, so it can be put right", async () => {
    await setup();
    await chooseBook(inspection({ format: "xlsx", workbook: WORKBOOK }));
    const { ApiError } = await import("../api");
    inspectData.mockRejectedValue(new ApiError("Row 2 of sheet Orgs is empty: choose the row that holds the column names.", 422));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Header row"), { target: { value: "2" } });
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Not readable. Row 2 of sheet Orgs is empty: choose the row that holds the column names.",
    );
    expect(next().getAttribute("aria-disabled")).toBe("true");
    // Another sheet that cannot be read: its rows are offered by number,
    // never labelled with the last sheet's cells (code review).
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Sheet"), { target: { value: "Big" } });
    });
    const rows = [...(screen.getByLabelText("Header row") as HTMLSelectElement).options].map((o) => o.text);
    expect(rows.slice(0, 3)).toEqual(["Row 1", "Row 2", "Row 3"]);
    expect(rows).toHaveLength(20);
    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: { ...WORKBOOK, headerRow: 3 } }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Header row"), { target: { value: "3" } });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(next().getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps both pickers when the first read finds an empty sheet or header row (PR #54 review)", async () => {
    await setup();
    const { ApiError } = await import("../api");
    const sentence = "Sheet Cover is empty.";
    const listed = {
      sheet: "Cover", headerRow: 1, top: [],
      sheets: [{ name: "Cover", rows: 0 }, { name: "Orgs", rows: 41 }],
    };
    const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
    inspectData.mockRejectedValue(new ApiError(sentence, 422, { message: sentence, kind: "empty", workbook: listed }));
    await act(async () => {
      fireEvent.change(input, { target: { files: [BOOK] } });
    });
    expect(screen.getByRole("alert").textContent).toBe(`Not readable. ${sentence}`);
    const sheet = screen.getByLabelText("Sheet") as HTMLSelectElement;
    expect([...sheet.options].map((o) => o.text)).toEqual(["Cover (0 rows)", "Orgs (41 rows)"]);
    expect((screen.getByLabelText("Header row") as HTMLSelectElement).value).toBe("1");
    // The pickers put it right.
    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: { ...WORKBOOK, headerRow: 3 } }));
    await act(async () => {
      fireEvent.change(sheet, { target: { value: "Orgs" } });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Header row") as HTMLSelectElement).value).toBe("3");
  });

  it("applies only the latest read's reply, and Next waits until it lands (PR #54 review)", async () => {
    await setup();
    await chooseBook(inspection({ format: "xlsx", workbook: { ...WORKBOOK, sheets: [...WORKBOOK.sheets, { name: "People", rows: 5 }] } }));
    const replies: ((found: DataInspection) => void)[] = [];
    inspectData.mockImplementation(() => new Promise<DataInspection>((done) => replies.push(done)));
    const pick = async (value: string) => {
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Sheet"), { target: { value } });
      });
    };
    const big = inspection({ format: "xlsx", columns: [profile("big_column")], workbook: { ...WORKBOOK, sheet: "Big" } });
    const people = inspection({ format: "xlsx", columns: [profile("people_column")], workbook: { ...WORKBOOK, sheet: "People" } });
    const blockedBy = () => document.getElementById(next().getAttribute("aria-describedby") ?? "")?.textContent;

    await pick("Big");
    await pick("People");
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(blockedBy()).toBe("Reading the file…");
    // The earlier read answers first: still reading, nothing applied.
    await act(async () => replies[0](big));
    expect(screen.queryByText("big_column")).toBeNull();
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Reading…")).toBeTruthy();
    await act(async () => replies[1](people));
    expect(screen.getByText("people_column")).toBeTruthy();
    expect(next().getAttribute("aria-disabled")).toBe("false");

    // Out of order: the later read answers first, and the earlier one,
    // landing after, changes nothing.
    await pick("Big");
    await pick("Orgs");
    const orgs = inspection({ format: "xlsx", columns: [profile("orgs_column")], workbook: WORKBOOK });
    await act(async () => replies[3](orgs));
    expect(screen.getByText("orgs_column")).toBeTruthy();
    expect(next().getAttribute("aria-disabled")).toBe("false");
    await act(async () => replies[2](big));
    expect(screen.queryByText("big_column")).toBeNull();
    expect(screen.getByText("orgs_column")).toBeTruthy();
    expect((screen.getByLabelText("Sheet") as HTMLSelectElement).value).toBe("Orgs");
    expect(screen.queryByText("Reading…")).toBeNull();
  });

  it("keeps the changed picker mounted and focused while the file is read again (X4)", async () => {
    await setup();
    await chooseBook(inspection({ format: "xlsx", workbook: WORKBOOK }));
    for (const [label, value] of [["Sheet", "Big"], ["Header row", "3"]] as const) {
      const picker = screen.getByLabelText(label) as HTMLSelectElement;
      picker.focus();
      let finish: (found: DataInspection) => void = () => {};
      inspectData.mockReturnValue(new Promise<DataInspection>((done) => (finish = done)));
      await act(async () => {
        fireEvent.change(picker, { target: { value } });
      });
      // Mid-read: the same element, still in the page, still focused.
      expect(screen.getByText("Reading…")).toBeTruthy();
      expect(picker.isConnected).toBe(true);
      expect(document.activeElement).toBe(picker);
      await act(async () => {
        finish(inspection({ format: "xlsx", workbook: { ...WORKBOOK, sheet: label === "Sheet" ? "Big" : "Orgs" } }));
      });
      expect(document.activeElement).toBe(screen.getByLabelText(label));
    }
    // A CSV file's separator, the same way (Stage A had the same drop).
    await chooseFile();
    const separator = screen.getByLabelText("Separator") as HTMLSelectElement;
    separator.focus();
    inspectData.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      fireEvent.change(separator, { target: { value: ";" } });
    });
    expect(separator.isConnected && document.activeElement === separator).toBe(true);
  });

  it("says in step 4 which links match no row yet, and that they are still written", async () => {
    await setup();
    await chooseFile();
    await press(next());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
    });
    await press(next());
    previewData.mockResolvedValue(preview({
      report: { ...REPORT, unmatched: [{ column: "org", className: "Organization", classIri: `${X}Organization`, count: 12, rows: [3, 9] }] },
    }));
    await press(next());
    expect(screen.getByText("org: 12 values match no Organization row (rows 3, 9 and 10 more)")).toBeTruthy();
    expect(screen.getByText(/These links are still written\. Import the rows they point to, before or after this file/)).toBeTruthy();
  });
});

describe("the X-12 tidy-up", () => {
  const BOOK = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "orgs.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const WORKBOOK = {
    sheet: "Notes", headerRow: 1, top: [{ row: 1, cells: ["id", "name"] }],
    sheets: [{ name: "Notes", rows: 0 }, { name: "Staff", rows: 1 }],
  };

  async function mount(start: WizardStart, taxonomy = false) {
    openProject.mockResolvedValue({ project: PROJECT, documents: [MODEL], recovery: { available: false, draftTime: null } });
    listData.mockResolvedValue({ generation: 1, snapshots: [] });
    await projectStore.open(PID);
    fetchHierarchy.mockResolvedValue({
      classes: { nodes: { [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false } }, children: {}, roots: [`${X}Person`] },
      concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 1, concepts: 0 }, truncated: false,
    });
    previewData.mockResolvedValue(preview());
    onClose = vi.fn<() => void>();
    await act(async () => {
      render(<DataWizard projectId={PID} modelOntologyId={`${PID}-model`} taxonomy={taxonomy} start={start} onClose={onClose} />);
    });
  }

  it("T-5: a refresh whose sheet is gone starts at step 1, with the sheet to choose and the old one named", async () => {
    const atFile = "This workbook has no sheet named People. Choose the sheet to refresh from.";
    const gone = { sheet: "", headerRow: 1, top: [], sheets: WORKBOOK.sheets };
    const snapshot = { ...SNAPSHOT, source: "staff.xlsx", workbook: { sheet: "People", headerRow: 1 } };
    await mount({ kind: "refresh", snapshot, file: BOOK, options: {}, inspection: null, workbook: gone, missing: [], choices: null, atFile });
    expect(screen.getByRole("heading", { name: "Step 1 of 4: the file" })).toBe(document.activeElement);
    expect(screen.getByText(atFile)).toBeTruthy();
    const sheet = screen.getByLabelText("Sheet") as HTMLSelectElement;
    expect(sheet.value).toBe("");
    expect([...sheet.options].map((o) => o.text)).toEqual(["Choose a sheet", "Notes (0 rows)", "Staff (1 row)"]);
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Choose a sheet first.")).toBeTruthy();

    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: { ...WORKBOOK, sheet: "Staff" } }));
    await act(async () => {
      fireEvent.change(sheet, { target: { value: "Staff" } });
    });
    expect(next().getAttribute("aria-disabled")).toBe("false");
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
    // Back reaches step 1 again, which a refresh normally never shows.
    await press(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Step 1 of 4: the file" })).toBeTruthy();
  });

  it("T-6: a refresh read by a workbook's default sheet still names that sheet to the server", async () => {
    const found = inspection({ format: "xlsx", workbook: { ...WORKBOOK, sheet: "Staff", headerRow: 2 } });
    const atFile = "This snapshot was read from a CSV file. Choose the sheet of this workbook to refresh from.";
    await mount({ kind: "refresh", snapshot: SNAPSHOT, file: BOOK, options: {}, inspection: found, workbook: found.workbook, missing: [], choices: null, atFile });
    expect(screen.getByText(atFile)).toBeTruthy();
    expect((screen.getByLabelText("Sheet") as HTMLSelectElement).value).toBe("Staff");
    await press(next());
    await press(next());
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 4 of 4: preview and import" })).toBeTruthy();
    refreshData.mockResolvedValue({ status: "imported", snapshot: SNAPSHOT, generation: 2 });
    await press(screen.getByRole("button", { name: "Import again" }));
    expect(refreshData.mock.calls[0][3]).toEqual({ sheet: "Staff", headerRow: 2 });
  });

  it("T-7: a class reading is not reused after the sheet or the header row changes", async () => {
    await mount({ kind: "new" });
    const other = { ...WORKBOOK, sheets: [...WORKBOOK.sheets, { name: "Other", rows: 1 }] };
    inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: other }));
    const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [BOOK] } });
    });
    await press(next());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
    });
    expect(next().getAttribute("aria-disabled")).toBe("false");

    const moved = { ...other, sheet: "Other", top: [{ row: 1, cells: ["id"] }, { row: 2, cells: ["x"] }] };
    for (const [label, value] of [["Sheet", "Other"], ["Header row", "2"]] as const) {
      await press(screen.getByRole("button", { name: "Back" }));
      inspectData.mockResolvedValue(inspection({ format: "xlsx", workbook: moved }));
      await act(async () => {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
      });
      // The reading for the new sheet or row never arrives: Next waits for it.
      previewData.mockReturnValue(new Promise(() => {}));
      await press(next());
      expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
      expect(next().getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("Checking the identifier…")).toBeTruthy();
      previewData.mockResolvedValue(preview());
    }
  });

  it("T-9: the announcement counts things", async () => {
    inspectData.mockResolvedValue(inspection({ choices: { classIri: `${X}Person`, idColumn: "id", columns: {} } }));
    await mount({ kind: "remap", snapshot: SNAPSHOT });
    const many = { ...SNAPSHOT, report: { ...REPORT, individuals: 120 } };
    updateData.mockResolvedValue({ snapshot: many, generation: 2 });
    await press(next());
    await press(next());
    await press(screen.getByRole("button", { name: "Import again" }));
    expect(projectStore.getSnapshot().announcement.text).toBe("Mapped again people.csv: 120 things made.");
  });

  it("T-10: in a taxonomy every label points at a control, and the row sentence describes the identifier's", async () => {
    await mount({ kind: "new" }, true);
    inspectData.mockResolvedValue(inspection());
    const input = document.querySelector(".data-wizard input[type=file]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [FILE] } });
    });
    await press(next());
    expect(screen.getByRole("heading", { name: "Step 2 of 4: what a row is" })).toBeTruthy();
    const labels = [...document.querySelectorAll(".data-wizard label[for]")];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const target = document.getElementById(label.getAttribute("for")!);
      expect(target?.matches("input, select, textarea, button")).toBe(true);
    }
    const sentence = screen.getByText("Each row is a concept of the project's scheme.");
    expect(sentence.closest("label")).toBeNull();
    const id = screen.getByLabelText(/Each row is identified by column/);
    expect(id.getAttribute("aria-describedby")).toBe(sentence.id);
  });
});

describe("the kind of a class the wizard makes (attribute-reuse 5.6, AC-13)", () => {
  it("makes it the project's default kind, says so beside the name, and names it in the summary step", async () => {
    openProject.mockResolvedValue({
      project: { ...PROJECT, classType: "rdfs" }, documents: [MODEL], recovery: { available: false, draftTime: null },
    });
    listData.mockResolvedValue({ generation: 1, snapshots: [] });
    await projectStore.open(PID);
    fetchHierarchy.mockResolvedValue({
      classes: { nodes: {}, children: {}, roots: [] }, concepts: { nodes: {}, children: {}, roots: [] },
      counts: { classes: 0, concepts: 0 }, truncated: false,
    });
    previewData.mockResolvedValue(preview({ className: "Ticket" }));
    await act(async () => {
      render(<DataWizard projectId={PID} modelOntologyId={`${PID}-model`} taxonomy={false} start={{ kind: "new" }} onClose={vi.fn()} />);
    });
    await chooseFile();
    await press(next());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: "new" } });
    });
    expect(screen.getByText("It is made as an RDFS class, the project's default.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name of the new class"), { target: { value: "Ticket" } });
    runCommand.mockResolvedValue({
      revision: 2, label: "Created class Ticket", state: { ...MODEL, revision: 2 }, created: `${X}Ticket`, classType: "rdfs",
    });
    await press(screen.getByRole("button", { name: "Create class" }));
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateClass", { label: "Ticket", type: "rdfs" });
    await press(next());
    await press(next());
    expect(screen.getByText("Ticket is a new RDFS class, the project's default kind of class.")).toBeTruthy();
  });

  it("names no kind in the summary step for a class that was there already", async () => {
    await setup();
    await chooseFile();
    await press(next());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
    });
    await press(next());
    await press(next());
    expect(screen.getByText("1 row → 3 statements")).toBeTruthy();
    expect(screen.queryByText(/the project's default kind of class/)).toBeNull();
  });
});
