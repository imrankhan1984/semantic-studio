// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/DeleteDialog.test.tsx
================================================================================

SUMMARY
    The delete dialog's first tests (links-between-files 5.3, 5.4, AC-13,
    AC-14): today's dialog when no other file uses the term, and with uses
    the uses list, *Deprecate instead* first and focused, its Deprecate step,
    and *Delete anyway* sending DeleteEntity in this file only.

BASIC IDEA
    The dialog rendered alone with a runner from useRunner, over a mocked
    api.ts and the project store opened on a mocked project. jsdom has no
    sequential focus navigation and does not turn Enter on a button into a
    click, so "Enter deprecates" is asserted as what Enter does in a
    browser: the focused element is activated, and a second Enter on the
    step's focused *Deprecate* sends Deprecate -- never DeleteEntity. The
    running app proves the key itself (run-semantic-viewer).

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand, previewDelete, searchNodes).

EXPECTED OUTPUT
    - Pass/fail for AC-13 and AC-14 and the dialog's other answers.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import type { DeleteImpact } from "../types";
import DeleteDialog from "./DeleteDialog";
import { useRunner } from "./EditParts";

const { openProject, runCommand, previewDelete, searchNodes } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  previewDelete: vi.fn(),
  searchNodes: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, previewDelete, searchNodes };
});

const EX = "http://example.org/plant#";
const PID = "prj-0123456789ab";
const STATE = {
  doc: "fcore0001" as const, ontologyId: `${PID}-fcore0001`, revision: 2, dirty: true, canUndo: true,
  undoLabel: "x", canRedo: false, redoLabel: null, triples: 10,
};

function impact(uses: DeleteImpact["uses"] = []): DeleteImpact {
  return {
    iri: EX + "Pump", label: "Pump", kind: "class", statements: 2, strategy: "reparent",
    children: [], reparentedTo: [], properties: [], individuals: [], importMentions: 0, uses,
  };
}

const USES = [
  { doc: "fequip001", file: "equipment.ttl", count: 3, sample: [{ subject: EX + "drives", label: "drives" }, { subject: EX + "Motor", label: "Motor" }] },
  { doc: "shapes", file: "shapes.ttl", count: 1, sample: [] },
];

const onDone = vi.fn();

function Harness({ start }: { start?: "delete" | "deprecate" }) {
  const runner = useRunner();
  return <DeleteDialog iri={EX + "Pump"} label="Pump" runner={runner} onDone={onDone} start={start} kind="class" />;
}

async function open(start?: "delete" | "deprecate") {
  await act(async () => {
    render(<Harness start={start} />);
  });
  return screen.getByRole("dialog");
}

const commands = () => runCommand.mock.calls.map((c) => c.slice(2));

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [openProject, runCommand, previewDelete, searchNodes, onDone]) mock.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Plant", createdAt: "", updatedAt: "", baseIri: EX, prefix: "plant",
      primaryLanguage: "en", languages: [], documents: [{ file: "core.ttl", role: "ontology", id: "fcore0001" }], counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  await act(async () => projectStore.switchDocument("fcore0001"));
  runCommand.mockImplementation(async (_p, _d, command: string) => ({
    revision: 3, label: command === "Deprecate" ? "Deprecated Pump" : "Deleted class Pump", state: STATE,
  }));
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("DeleteDialog without uses elsewhere (AC-14)", () => {
  it("is today's dialog: Delete and Cancel, no Deprecate instead", async () => {
    previewDelete.mockResolvedValue({ dryRun: true, impact: impact(), revision: 2 });
    const dialog = await open();
    expect(previewDelete).toHaveBeenCalledWith(PID, "fcore0001", EX + "Pump", "reparent");
    expect(within(dialog).getByText("Deleting Pump removes 2 statements.")).toBeTruthy();
    const buttons = within(dialog).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Delete", "Cancel"]);
    expect(within(dialog).queryByText(/other files/)).toBeNull();
    // The heading holds the focus, as every question's does.
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Delete Pump?" }));
  });
});

describe("DeleteDialog with uses elsewhere (AC-13)", () => {
  beforeEach(() => previewDelete.mockResolvedValue({ dryRun: true, impact: impact(USES), revision: 2 }));

  it("lists the uses by file, in order, as a list", async () => {
    const dialog = await open();
    expect(within(dialog).getByText("4 statements in other files use Pump:")).toBeTruthy();
    const items = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["3 in equipment.ttl (drives, Motor)", "1 in shapes.ttl"]);
    expect(within(dialog).getByText("Deleting Pump leaves them pointing at nothing.")).toBeTruthy();
  });

  it("puts Deprecate instead first, holding the focus; Enter, Enter deprecates and never deletes", async () => {
    const dialog = await open();
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Deprecate instead", "Delete anyway", "Cancel"]);
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].className).toBe("primary");
    // Enter on the focused button, as a browser turns it into a click.
    await act(async () => {
      fireEvent.click(document.activeElement!);
    });
    expect(within(dialog).getByRole("heading", { name: "Deprecate Pump?" })).toBeTruthy();
    const deprecate = within(dialog).getByRole("button", { name: "Deprecate" });
    expect(document.activeElement).toBe(deprecate);
    await act(async () => {
      fireEvent.click(document.activeElement!);
    });
    expect(commands()).toEqual([["Deprecate", { iri: EX + "Pump" }]]);
    expect(onDone).toHaveBeenCalledWith(false);
    expect(projectStore.getSnapshot().announcement.text).toBe("Deprecated Pump. Undo is available.");
  });

  it("Back returns to the question, with Deprecate instead focused again", async () => {
    const dialog = await open();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Deprecate instead" }));
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Deprecate instead" }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("Delete anyway sends DeleteEntity in this file only", async () => {
    const dialog = await open();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete anyway" }));
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["fcore0001", "DeleteEntity", { iri: EX + "Pump", strategy: "reparent" }]);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("sends the replacement chosen in Replaced by", async () => {
    searchNodes.mockResolvedValue([{ id: EX + "Pumpe", label: "Pumpe", kind: "class" }]);
    const dialog = await open();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Deprecate instead" }));
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a replacement…" }));
    const field = within(dialog).getByRole("combobox", { name: "Replaced by" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "Pum" } });
      await new Promise((r) => setTimeout(r, 400));
    });
    await act(async () => {
      // The list picks on mousedown, so the field keeps its focus.
      fireEvent.mouseDown(await within(dialog).findByRole("option", { name: /Pumpe/ }));
    });
    expect(dialog.querySelector(".deprecate-replacement")!.textContent).toMatch(/^Replaced by: Pumpe/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Deprecate" }));
    });
    expect(commands()).toEqual([["Deprecate", { iri: EX + "Pump", replacedBy: EX + "Pumpe" }]]);
  });
});
