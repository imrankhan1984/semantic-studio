// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ResultPanels.test.tsx
================================================================================

SUMMARY
    The result panels (shacl-authoring 5.6, 5.7, Section 6): Validate runs a
    check only when pressed and reads *Validating…* meanwhile; one panel per
    shape, collapsed at first, each header a button with aria-expanded and a
    name carrying its state word and counts; problems grouped by rule with
    the individual's name as a link; *and N more* past the cap; Expand all
    and Collapse all; the stale line after a change; the stopped message;
    and the summary read in the live region.

BASIC IDEA
    api.ts is mocked and the real project store is opened on a fixed
    project, so Validate goes through the same action the Shapes view and
    the Turtle editor run.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, validateProject, runCommand, listData } = vi.hoisted(() => ({
  openProject: vi.fn(),
  validateProject: vi.fn(),
  runCommand: vi.fn(),
  listData: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  validateProject,
  runCommand,
  listData,
}));

import { projectStore } from "../state/projectStore";
import type { ValidationPanel, ValidationResult } from "../types";
import ResultPanels, { ValidateButton } from "./ResultPanels";

const PROJECT = {
  id: "prj-0123456789ab", name: "Shop", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};

function doc(name: "model" | "shapes", revision: number) {
  return {
    doc: name, ontologyId: `prj-0123456789ab-${name}`, revision, dirty: false,
    canUndo: false, undoLabel: null, canRedo: false, redoLabel: null, triples: 1,
  };
}

function panel(changes: Partial<ValidationPanel>): ValidationPanel {
  return {
    id: "http://x#PersonRules", name: "Person rules", state: "fails",
    target: { iri: "http://x#Person", label: "Person", one: "person", many: "people" },
    focusCount: 5, failingCount: 2, problemCount: 3, warningCount: 0,
    problems: [
      { focus: "http://x#bob", focusLabel: "Bob", group: "name", sentence: "Bob has no name; every Person must have at least 1.", value: null, severity: "violation" },
      { focus: "http://x#carol", focusLabel: "Carol", group: "name", sentence: "Carol has 2 names; every Person may have at most 1.", value: null, severity: "violation" },
      { focus: "http://x#erin", focusLabel: "Erin", group: "birth date", sentence: 'Erin\'s birth date "yesterday" is not a date.', value: '"yesterday"', severity: "violation" },
    ],
    problemsTotal: 3, error: null, ...changes,
  };
}

const RESULT: ValidationResult = {
  stopped: false, statements: 40, shapeCount: 3, durationMs: 3, revisions: { model: 2, shapes: 5 },
  shapes: [
    panel({}),
    panel({ id: "n", name: "Invoice rules", state: "nothing", focusCount: 0, failingCount: 0, problemCount: 0, problems: [], problemsTotal: 0,
      target: { iri: "http://x#Invoice", label: "Invoice", one: "invoice", many: "invoices" } }),
    panel({ id: "p", name: "Organization rules", state: "passes", focusCount: 4, failingCount: 0, problemCount: 0, problems: [], problemsTotal: 0,
      target: { iri: "http://x#Organization", label: "Organization", one: "organization", many: "organizations" } }),
  ],
};

let onSelect: ReturnType<typeof vi.fn<(iri: string) => void>>;
let onError: ReturnType<typeof vi.fn<(message: string) => void>>;

async function setup(result: ValidationResult = RESULT) {
  listData.mockResolvedValue({ generation: 1, snapshots: [] });
  openProject.mockResolvedValue({ project: PROJECT, documents: [doc("model", 2), doc("shapes", 5)], recovery: { available: false, draftTime: null } });
  await projectStore.open(PROJECT.id);
  validateProject.mockResolvedValue(result);
  onSelect = vi.fn<(iri: string) => void>();
  onError = vi.fn<(message: string) => void>();
  await act(async () => {
    render(
      <>
        <ValidateButton onError={onError} />
        <ResultPanels onSelect={onSelect} />
      </>,
    );
  });
}

async function validate() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  projectStore._reset();
});
afterEach(cleanup);

describe("ResultPanels", () => {
  it("checks nothing until Validate is pressed", async () => {
    await setup();
    expect(validateProject).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing has been checked yet/)).toBeTruthy();
    await validate();
    expect(validateProject).toHaveBeenCalledTimes(1);
  });

  it("reads Validating… while a check runs, keeps focus, and dims the previous panels", async () => {
    await setup();
    await validate();
    let finish!: (r: ValidationResult) => void;
    validateProject.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const button = screen.getByRole("button", { name: /Validate/ });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("Validating…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    // The previous panels stay until the new ones replace them.
    expect(screen.getByRole("button", { name: /Fails\. Person rules/ })).toBeTruthy();
    expect(document.querySelector(".result-panels.busy")).not.toBeNull();
    await act(async () => finish(RESULT));
    expect(button.textContent).toBe("Validate");
  });

  it("shows one collapsed panel per shape, failing first, each named with its state word and counts", async () => {
    await setup();
    await validate();
    const headers = screen.getAllByRole("button", { expanded: false });
    expect(headers.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Fails. Person rules: 2 of 5 people fail (3 problems)",
      "Nothing to check. Invoice rules: no Invoice in the data yet",
      "Passes. Organization rules: all 4 organizations pass",
    ]);
    // Only headers render until a panel opens (Section 10).
    expect(screen.queryByText(/Bob has no name/)).toBeNull();
  });

  it("opens a panel onto its problems grouped by rule, and a name selects the individual", async () => {
    await setup();
    await validate();
    const header = screen.getByRole("button", { name: /Fails\. Person rules/ });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(header.getAttribute("aria-controls")!)!;
    expect(within(body).getAllByRole("heading", { level: 5 }).map((h) => h.textContent)).toEqual(["name", "birth date"]);
    expect(within(body).getByText("Bob has no name; every Person must have at least 1.")).toBeTruthy();
    expect(within(body).getByText('Value: "yesterday"')).toBeTruthy();
    fireEvent.click(within(body).getByRole("button", { name: "Bob" }));
    expect(onSelect).toHaveBeenCalledWith("http://x#bob");
  });

  it("says how many more there are past the cap", async () => {
    await setup({ ...RESULT, shapes: [panel({ problemsTotal: 1070 })] });
    await validate();
    fireEvent.click(screen.getByRole("button", { name: /Fails\./ }));
    expect(screen.getByText("and 1,067 more")).toBeTruthy();
  });

  it("expands and collapses every panel", async () => {
    await setup();
    await validate();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
  });

  it("shows the could-not-run reason in its panel", async () => {
    await setup({ ...RESULT, shapes: [panel({ state: "error", error: "sh:minCount must be an integer", problems: [], problemsTotal: 0 })] });
    await validate();
    fireEvent.click(screen.getByRole("button", { name: /Could not run\./ }));
    expect(screen.getByText(/sh:minCount must be an integer/)).toBeTruthy();
  });

  it("marks the result stale after a change, and clears it on the next check", async () => {
    await setup();
    await validate();
    expect(screen.queryByText(/changed since this check/)).toBeNull();
    runCommand.mockResolvedValue({ revision: 6, label: "Added a rule", state: doc("shapes", 6) });
    await act(async () => {
      await projectStore.command("AddRule", {}, undefined, "shapes");
    });
    expect(screen.getByText("The model, the shapes or the data changed since this check. Validate again.")).toBeTruthy();
    validateProject.mockResolvedValue({ ...RESULT, revisions: { model: 2, shapes: 6 } });
    await validate();
    expect(screen.queryByText(/changed since this check/)).toBeNull();
  });

  it("names the data a panel checked, a sample's words included (csv-data-import 5.6)", async () => {
    const people = { id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true };
    await setup({
      ...RESULT,
      revisions: { model: 2, shapes: 5, data: 1 },
      dataSources: [people],
      shapes: [panel({ data: [people.id] }), RESULT.shapes[2]],
    });
    await validate();
    // Under the header, whether the panel is open or not.
    expect(screen.getByText(
      "Checked data from people.csv, imported 2 October 2026; sample: first 2,000 of 12,480 rows",
    )).toBeTruthy();
    expect(screen.getAllByText(/^Checked data/)).toHaveLength(1);
    expect(screen.queryByText(/changed since this check/)).toBeNull();
    // A snapshot switched off since: stale, as an edit makes it.
    listData.mockResolvedValue({ generation: 2, snapshots: [] });
    await act(async () => {
      await projectStore.dataChanged("Switched off people.csv.");
    });
    expect(screen.getByText(/the data changed since this check/)).toBeTruthy();
  });

  it("says a check was stopped, with its size", async () => {
    await setup({ ...RESULT, stopped: true, shapes: [], statements: 120000, shapeCount: 12 });
    await validate();
    expect(screen.getByRole("alert").textContent).toBe(
      "The check took too long and was stopped. It was checking 12 shapes against 120,000 statements.",
    );
  });

  it("announces the summary in the project's live region", async () => {
    await setup();
    await validate();
    expect(projectStore.getSnapshot().announcement.text).toBe(
      "3 shapes: 1 passes, 1 fails, 1 has nothing to check.",
    );
  });

  it("reports a failed check to the caller", async () => {
    await setup();
    validateProject.mockRejectedValue(new Error("Open the project first."));
    await validate();
    expect(onError).toHaveBeenCalledWith("Open the project first.");
  });
});

describe("ResultPanels: Stage A follow-ups fixed in Stage B (5.9)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("runs one check at a time: a second press while one runs sends nothing (item 3)", async () => {
    await setup();
    const pending = deferred<ValidationResult>();
    validateProject.mockReturnValue(pending.promise);
    await validate();
    // The button is aria-disabled, not disabled, so a press still arrives.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validating…" }));
    });
    await act(async () => {
      await projectStore.validate();
    });
    expect(validateProject).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(RESULT));
    expect(projectStore.getSnapshot().validating).toBe(false);
  });

  it("says nothing in the next project about a check that outlived its own (item 3)", async () => {
    await setup();
    const pending = deferred<ValidationResult>();
    validateProject.mockReturnValue(pending.promise);
    await validate();
    expect(screen.getByRole("button", { name: "Validating…" }).getAttribute("aria-disabled")).toBe("true");
    // Another project opens while the first one's check still runs.
    openProject.mockResolvedValue({
      project: { ...PROJECT, id: "prj-ba9876543210", name: "Library" },
      documents: [doc("model", 1)], recovery: { available: false, draftTime: null },
    });
    await act(async () => {
      await projectStore.open("prj-ba9876543210");
    });
    const opened = projectStore.getSnapshot().announcement.text;
    // The new project's Validate is free at once, not when the old check ends.
    expect(screen.getByRole("button", { name: "Validate" }).getAttribute("aria-disabled")).toBe("false");
    await act(async () => pending.resolve(RESULT));
    expect(projectStore.getSnapshot().validation).toBeNull();
    expect(projectStore.getSnapshot().announcement.text).toBe(opened);
    expect(projectStore.getSnapshot().validating).toBe(false);
  });

  it("drops the failure of a check that outlived its project, rather than showing it in the next", async () => {
    await setup();
    const pending = deferred<ValidationResult>();
    validateProject.mockReturnValue(pending.promise.then(() => Promise.reject(new Error("Gone."))));
    await validate();
    openProject.mockResolvedValue({
      project: { ...PROJECT, id: "prj-ba9876543210" },
      documents: [doc("model", 1)], recovery: { available: false, draftTime: null },
    });
    await act(async () => {
      await projectStore.open("prj-ba9876543210");
    });
    await act(async () => pending.resolve(RESULT));
    expect(onError).not.toHaveBeenCalled();
  });

  it("says why Validate cannot run in text tied to it, not only a tooltip (item 7)", async () => {
    openProject.mockResolvedValue({ project: PROJECT, documents: [doc("model", 2)], recovery: { available: false, draftTime: null } });
    await projectStore.open(PROJECT.id);
    await act(async () => {
      render(<ValidateButton onError={vi.fn()} blocked="Apply the text in the editor first." />);
    });
    const button = screen.getByRole("button", { name: "Validate" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Apply the text in the editor first.");
  });

  it("points a class with nothing to check at Add an example (item 8)", async () => {
    await setup();
    await validate();
    fireEvent.click(screen.getByRole("button", { name: /Nothing to check\. Invoice rules/ }));
    expect(
      screen.getByText("No Invoice is in the data yet, so there is nothing to check. Add an example from the Invoice form, then validate again."),
    ).toBeTruthy();
  });
});
