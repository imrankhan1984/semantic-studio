// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/MoveToFileDialog.test.tsx
================================================================================

SUMMARY
    The Move to file dialog (links-between-files 5.8, AC-23): the picker is
    a labelled select of the project's other ontology and vocabulary files,
    it holds the focus, Enter on it moves, Escape and Cancel close without a
    command, and a project's files are offered by path, never a shapes file.

BASIC IDEA
    The component-test pattern: api.ts mocked, the project store opened on a
    mocked project of four files, the dialog rendered with a real runner
    from EditParts. What the server would receive is asserted on
    runCommand's arguments.

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand).

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import { useRunner } from "./EditParts";
import MoveToFileDialog from "./MoveToFileDialog";

const { openProject, runCommand } = vi.hoisted(() => ({ openProject: vi.fn(), runCommand: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand };
});

const PID = "prj-0123456789ab";
const EX = "http://example.org/plant#";
const state = (doc: string, file: string, role: string) => ({
  doc, file, role, ontologyId: `${PID}-${doc}`, revision: 1, dirty: false,
  canUndo: false, undoLabel: null, canRedo: false, redoLabel: null, triples: 4,
});

const onDone = vi.fn();

function Harness() {
  const runner = useRunner();
  return <MoveToFileDialog iri={EX + "Pump"} label="Pump" runner={runner} onDone={onDone} />;
}

beforeEach(async () => {
  projectStore._reset();
  onDone.mockReset();
  runCommand.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Plant", createdAt: "", updatedAt: "", baseIri: EX, prefix: "plant",
      primaryLanguage: "en", languages: [], counts: {}, documents: [],
    },
    documents: [
      state("model", "model.ttl", "ontology"),
      state("f00000001", "parts/core.ttl", "ontology"),
      state("shapes", "shapes.ttl", "shapes"),
      state("f00000002", "terms.ttl", "vocabulary"),
    ],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockResolvedValue({ revision: 2, label: "Moved Pump to core.ttl", state: state("model", "model.ttl", "ontology") });
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("MoveToFileDialog (links-between-files 5.8)", () => {
  it("offers the other ontology and vocabulary files by path, never this file or a shapes file", async () => {
    render(<Harness />);
    const picker = screen.getByRole("combobox", { name: "Move to" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["parts/core.ttl", "terms.ttl"]);
    await waitFor(() => expect(document.activeElement).toBe(picker));
  });

  it("moves to the file chosen when Enter is pressed on the picker", async () => {
    render(<Harness />);
    const picker = screen.getByRole("combobox", { name: "Move to" });
    fireEvent.change(picker, { target: { value: "f00000002" } });
    await act(async () => {
      fireEvent.keyDown(picker, { key: "Enter" });
    });
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["model", "MoveToFile", { iri: EX + "Pump", target: "f00000002" }]);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("closes on Cancel and on Escape, sending nothing", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
