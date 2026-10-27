// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ClassKindBlock.test.tsx
================================================================================

SUMMARY
    The class form's *Kind of class* block (attribute-reuse 5.7, AC-13):
    RDFS to OWL runs at once; OWL to RDFS asks the dry run first, says
    *Checking what changes…*, lists what goes in the Rules block's
    sentences, and changes nothing until *Make it an RDFS class*; Cancel
    changes nothing; the server's refusal (a union member) is shown with no
    button to go on; and focus goes to the first button when the answer
    arrives and back to the block's button after.

BASIC IDEA
    The block is rendered with its runner and the api mocked: the dry run
    (planClassType) answers as the server would, and runCommand records
    the command.

INPUTS / INPUT SOURCES
    - Inline plans, shaped as SetClassType's dry run sends them.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import type { ClassType, ClassTypePlan } from "../types";
import ClassKindBlock from "./ClassKindBlock";
import { useRunner } from "./EditParts";

const { openProject, runCommand, planClassType } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  planClassType: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, planClassType };
});

const EX = "http://example.org/hr#";
const PID = "prj-0123456789ab";
const STATE = {
  doc: "model" as const,
  ontologyId: `${PID}-model`,
  revision: 2,
  dirty: true,
  canUndo: true,
  undoLabel: "x",
  canRedo: false,
  redoLabel: null,
  triples: 10,
};

const PLAN: ClassTypePlan = {
  class: { iri: EX + "Manager", label: "Manager" },
  type: "owl",
  to: "rdfs",
  goes: [
    {
      type: "restriction",
      form: "every",
      property: { iri: EX + "manages", label: "manages", kind: "relationship" },
      kind: "atLeast",
      filler: { iri: EX + "Team", label: "Team" },
      n: 1,
      with: null,
      key: { form: "every", property: EX + "manages", kind: "atLeast", filler: EX + "Team", n: 1 },
      editable: true,
    },
    { type: "disjoint", other: { iri: EX + "Contractor", label: "Contractor" }, editable: true },
  ],
  refused: null,
};

function Harness({ classType }: { classType: ClassType }) {
  const runner = useRunner();
  return <ClassKindBlock iri={EX + "Manager"} name="Manager" classType={classType} runner={runner} />;
}

async function show(classType: ClassType) {
  await act(async () => {
    render(<Harness classType={classType} />);
  });
}

const said = () => projectStore.getSnapshot().announcement.text;

beforeEach(async () => {
  projectStore._reset();
  for (const m of [openProject, runCommand, planClassType]) m.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "HR", createdAt: "", updatedAt: "", baseIri: EX, prefix: "hr",
      primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockImplementation(async (_p, _d, command: string) => ({ revision: 3, label: `Did ${command}`, state: STATE }));
  planClassType.mockResolvedValue({ dryRun: true, plan: PLAN, revision: 2 });
});

afterEach(() => {
  cleanup();
});

describe("Kind of class (5.7)", () => {
  it("RDFS to OWL loses nothing, so it runs at once and says what the class is now", async () => {
    await show("rdfs");
    expect(document.querySelector(".class-kind-block")!.textContent).toContain("RDFS class");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it an OWL class" }));
    });
    expect(planClassType).not.toHaveBeenCalled();
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["model", "SetClassType", { class: EX + "Manager", type: "owl" }]);
    expect(said()).toBe("Manager is now an OWL class.");
  });

  it("OWL to RDFS lists what goes first, in the person's names, and changes nothing until asked", async () => {
    let answer: (v: unknown) => void = () => undefined;
    planClassType.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show("owl");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it an RDFS class" }));
    });
    expect(planClassType).toHaveBeenCalledWith(PID, EX + "Manager", "rdfs");
    expect(screen.getByRole("status").textContent).toBe("Checking what changes…");
    await act(async () => answer({ dryRun: true, plan: PLAN, revision: 2 }));
    const group = screen.getByRole("group", { name: "Make it an RDFS class" });
    expect(group.textContent).toContain(
      "Manager becomes an RDFS class. These go with it, because RDFS has no words for them:",
    );
    // The Rules block's own sentence for the same item (ruleSentences.ts).
    expect(group.textContent).toContain("“Every Manager has at least one manages that is a Team”");
    expect(group.textContent).toContain("“No Manager is a Contractor”");
    expect(runCommand).not.toHaveBeenCalled();
    // The first button takes focus when the list arrives.
    const go = screen.getByRole("button", { name: "Make it an RDFS class" });
    expect(document.activeElement).toBe(go);
    await act(async () => {
      fireEvent.click(go);
    });
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["model", "SetClassType", { class: EX + "Manager", type: "rdfs" }]);
    expect(said()).toBe("Manager is now an RDFS class.");
  });

  it("Cancel changes nothing and gives focus back to the block's button", async () => {
    await show("owl");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it an RDFS class" }));
    });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(runCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Make it an RDFS class" }));
  });

  it("a refusal is the server's sentence, with no button to go on", async () => {
    const refused = "hasName is shared by Employee and Manager in an OWL list, which an RDFS class cannot be part of. Give them a shared parent first, or keep Manager an OWL class.";
    planClassType.mockResolvedValue({ dryRun: true, plan: { ...PLAN, goes: [], refused }, revision: 2 });
    await show("owl");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it an RDFS class" }));
    });
    const group = screen.getByRole("group", { name: "Make it an RDFS class" });
    expect(group.textContent).toContain(refused);
    expect(screen.queryAllByRole("button", { name: "Make it an RDFS class" })).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("a class with nothing to lose says so", async () => {
    planClassType.mockResolvedValue({ dryRun: true, plan: { ...PLAN, goes: [] }, revision: 2 });
    await show("owl");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it an RDFS class" }));
    });
    expect(screen.getByRole("group").textContent).toContain("Manager becomes an RDFS class. Nothing else changes: it has no rules.");
  });
});
