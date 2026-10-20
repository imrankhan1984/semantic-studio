// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/EditStructure.test.tsx
================================================================================

SUMMARY
    The first tests of the editing form's Structure block, for
    attribute-reuse 5.3 (AC-8, AC-12): a class's attributes and
    relationships in three groups -- its own, *Shared with others* and
    *Through* each parent -- the shared ones marked in text; and 5.2 (AC-2,
    AC-12): the reuse plan's choices in their order, the first focused,
    each one command, Cancel back to the name, case B closing the form, and
    a refused Create offering the plan.

BASIC IDEA
    The block is rendered for an entity model built by entityModel from
    details shaped as /node sends them, with the api mocked as the other
    form tests mock it, and the project store open. The reuse plan (5.2)
    is opened as the canvas opens it, through the store's reuseDraft, or
    by a refused Create, with ShareDomain's dry run mocked.

INPUTS / INPUT SOURCES
    - Inline node details with `properties`.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { entityModel } from "../modeling/entity";
import { projectStore } from "../state/projectStore";
import type { ClassProperty, NodeDetails, SharePlan } from "../types";
import { useRunner } from "./EditParts";
import EditStructure from "./EditStructure";

const { openProject, runCommand, searchNodes, getNodeDetails, planShare } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  searchNodes: vi.fn(),
  getNodeDetails: vi.fn(),
  planShare: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, searchNodes, getNodeDetails, planShare };
});

const HR = "http://example.org/hr#";
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

const ref = (local: string) => ({ iri: HR + local, label: local });

function classDetails(local: string, properties: ClassProperty[]): NodeDetails {
  return {
    iri: HR + local,
    prefixed: `hr:${local}`,
    label: local,
    kind: "class",
    outgoing: [
      {
        predicate: { type: "uri", value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" },
        object: { type: "uri", value: "http://www.w3.org/2002/07/owl#Class" },
      },
    ],
    incoming: [],
    outgoingTotal: 1,
    incomingTotal: 0,
    properties,
  } as NodeDetails;
}

const MANAGER: ClassProperty[] = [
  { ...ref("title"), kind: "attribute", how: "own", datatype: "xsd:string" },
  { ...ref("hasName"), kind: "attribute", how: "shared", with: [ref("Contractor")], datatype: "xsd:string" },
  { ...ref("badge"), kind: "attribute", how: "both", with: [ref("Team")], datatype: "xsd:string" },
  { ...ref("hasJobCode"), kind: "attribute", how: "through", via: ref("Employee"), datatype: "xsd:string" },
  { ...ref("leads"), kind: "relationship", how: "through", via: ref("Employee"), range: ref("Team") },
];

const onSelect = vi.fn();

function Harness({ details }: { details: NodeDetails }) {
  const runner = useRunner();
  return (
    <EditStructure
      ontologyId={`${PID}-model`}
      iri={details.iri}
      name={details.label}
      model={entityModel(details, "en", [])}
      primaryLanguage="en"
      runner={runner}
      onSelect={onSelect}
      follow={() => undefined}
    />
  );
}

async function show(details: NodeDetails) {
  await act(async () => {
    render(<Harness details={details} />);
  });
}

beforeEach(async () => {
  projectStore._reset();
  for (const m of [openProject, runCommand, searchNodes, getNodeDetails, planShare, onSelect]) m.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID,
      name: "HR",
      createdAt: "",
      updatedAt: "",
      baseIri: HR,
      prefix: "hr",
      primaryLanguage: "en",
      languages: [],
      documents: [{ file: "model.ttl", role: "model" }],
      counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  searchNodes.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("a class's attributes in three groups (attribute-reuse 5.3)", () => {
  it("lists its own, those shared with others and those through a parent", async () => {
    await show(classDetails("Manager", MANAGER));
    const attributes = screen.getByRole("heading", { name: "Attributes" }).parentElement!;
    expect(within(attributes).getByRole("button", { name: "title" })).toBeTruthy();
    const shared = screen.getByRole("heading", { name: "Shared with others" });
    const sharedList = shared.nextElementSibling as HTMLElement;
    // Marked in text, never by colour alone (5.5).
    expect(sharedList.textContent).toContain("hasName (shared with Contractor)");
    expect(sharedList.textContent).toContain("badge (both, see warning)");
    const through = screen.getAllByRole("heading", { name: "Through Employee" });
    expect(through).toHaveLength(2);
    expect((through[0].nextElementSibling as HTMLElement).textContent).toBe("hasJobCode");
    expect((through[1].nextElementSibling as HTMLElement).textContent).toBe("leads");
  });

  it("selects a property from any group", async () => {
    await show(classDetails("Manager", MANAGER));
    act(() => screen.getByRole("button", { name: "hasJobCode" }).click());
    expect(onSelect).toHaveBeenCalledWith(HR + "hasJobCode");
  });

  it("says there are none when the class has none", async () => {
    await show(classDetails("Team", []));
    expect(screen.getByText("No attributes.")).toBeTruthy();
    expect(screen.getByText("No relationships.")).toBeTruthy();
  });
});

// --- the reuse plan (attribute-reuse 5.1, 5.2, 5.5) ----------------------------------------

const HAS_NAME = { iri: HR + "hasName", label: "hasName", kind: "attribute" as const };
const owl = (local: string) => ({ ...ref(local), type: "owl" as const });

function planD(extra: Partial<SharePlan> = {}): SharePlan {
  return {
    case: "D",
    property: HAS_NAME,
    class: owl("Contractor"),
    domain: { form: "one", classes: [owl("Employee")] },
    choices: {
      subclass: true,
      union: true,
      parent: true,
      up: [{ ...ref("Worker"), gains: [ref("Intern")], gainsTotal: 1 }],
    },
    imported: [],
    union: [ref("Employee"), ref("Contractor")],
    turtle: "hr:hasName rdfs:domain [ a owl:Class ; owl:unionOf ( hr:Employee hr:Contractor ) ] .",
    ...extra,
  };
}

async function openReuse(className = "Contractor") {
  await show(classDetails(className, []));
  await act(async () => screen.getByRole("button", { name: "Add attribute" }).click());
  await act(async () => projectStore.startReuse(HR + className, HR + "hasName", "hasName", "attribute"));
}

describe("the reuse plan in the class form (attribute-reuse 5.2)", () => {
  it("case D lists the choices in order, the first one focused", async () => {
    planShare.mockResolvedValue({ dryRun: true, plan: planD(), revision: 2 });
    await openReuse();
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    expect(planShare).toHaveBeenCalledWith(PID, HR + "hasName", HR + "Contractor");
    const buttons = within(plan).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([
      "Make Contractor a kind of Employee",
      "Share it",
      "Or give them a shared parent, which the reasoner can use",
      "Move hasName up to Worker",
      "Cancel",
    ]);
    expect(within(plan).getByText(/^Is every Contractor an Employee\?/)).toBeTruthy();
    expect(
      within(plan).getByText("Share hasName between Employee and Contractor. It means: whatever has hasName is an Employee or a Contractor."),
    ).toBeTruthy();
    expect(within(plan).getByText("Every Intern gets hasName too, because an Intern is a Worker.")).toBeTruthy();
    expect(within(plan).getByLabelText("The Turtle it writes").textContent).toContain("owl:unionOf");
    expect(document.activeElement?.textContent).toBe("Make Contractor a kind of Employee");
  });

  it("each choice is one command, and the live region says what changed", async () => {
    planShare.mockResolvedValue({ dryRun: true, plan: planD(), revision: 2 });
    runCommand.mockResolvedValue({ revision: 3, label: "Shared", state: STATE });
    await openReuse();
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    await act(async () => within(plan).getByRole("button", { name: "Share it" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "ShareDomain", {
      property: HR + "hasName",
      class: HR + "Contractor",
      how: "union",
    });
    expect(projectStore.getSnapshot().announcement.text).toContain("hasName is now shared by Employee and Contractor.");
    // A finished choice: the form closes, focus on the class's attribute list.
    expect(screen.queryByRole("group", { name: "Use hasName" })).toBeNull();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(document.activeElement?.textContent).toBe("Attributes");
  });

  it("with an RDFS class the shared parent is the only way, named first", async () => {
    planShare.mockResolvedValue({
      dryRun: true,
      plan: planD({ class: { ...ref("Contractor"), type: "rdfs" }, choices: { subclass: false, union: false, parent: true, up: [] }, turtle: null }),
      revision: 2,
    });
    runCommand.mockResolvedValue({ revision: 3, label: "Shared", state: STATE });
    await openReuse();
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    expect(within(plan).getByText(/^RDFS has no way to say "either"/)).toBeTruthy();
    const field = within(plan).getByLabelText("What is every Employee and Contractor? For example, Worker");
    await act(async () => {
      (field as HTMLInputElement).focus();
    });
    fireEvent.change(field, { target: { value: "Worker" } });
    await act(async () => within(plan).getByRole("button", { name: "Give Employee and Contractor this parent" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "ShareDomain", {
      property: HR + "hasName",
      class: HR + "Contractor",
      how: "parent",
      parentLabel: "Worker",
    });
  });

  it("an imported class is never offered a parent, and the plan says why", async () => {
    planShare.mockResolvedValue({
      dryRun: true,
      plan: planD({ choices: { subclass: false, union: true, parent: false, up: [] }, imported: [{ ...ref("Contractor"), from: "HR-Core" }] }),
      revision: 2,
    });
    await openReuse();
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    expect(within(plan).getByText("Contractor comes from HR-Core, so it cannot be given a new parent here.")).toBeTruthy();
    expect(within(plan).queryByRole("button", { name: /shared parent/ })).toBeNull();
  });

  it("Cancel gives focus back to the name field", async () => {
    planShare.mockResolvedValue({ dryRun: true, plan: planD(), revision: 2 });
    await openReuse();
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    await act(async () => within(plan).getByRole("button", { name: "Cancel" }).click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(document.activeElement).toBe(screen.getByLabelText("Name (en)"));
  });

  it("case B writes nothing: the form closes and says why", async () => {
    planShare.mockResolvedValue({
      dryRun: true,
      plan: { case: "B", property: HAS_NAME, class: owl("Manager"), domain: { form: "one", classes: [owl("Employee")] }, via: ref("Employee") },
      revision: 2,
    });
    await openReuse("Manager");
    expect(await screen.findByText("Manager already has hasName, because a Manager is an Employee.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Use hasName" })).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("a Create refused because the name exists offers the plan instead (5.1)", async () => {
    runCommand.mockRejectedValue(
      new ApiError("There is already an attribute hasName, of Employee.", 409, {
        code: "already_defined",
        message: "There is already an attribute hasName, of Employee.",
        property: { ...HAS_NAME, domain: { form: "one", classes: [ref("Employee")] }, range: null },
      }),
    );
    planShare.mockResolvedValue({ dryRun: true, plan: planD(), revision: 2 });
    await show(classDetails("Contractor", []));
    await act(async () => screen.getByRole("button", { name: "Add attribute" }).click());
    fireEvent.change(screen.getByLabelText("Name (en)"), { target: { value: "hasName" } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Name (en)").closest("form")!);
    });
    expect(screen.getByText("There is already an attribute hasName, of Employee.")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Use it on Contractor" }).click());
    expect(await screen.findByRole("group", { name: "Use hasName" })).toBeTruthy();
    expect(planShare).toHaveBeenCalledWith(PID, HR + "hasName", HR + "Contractor");
  });
});


describe("found in code review", () => {
  it("the union's words are the classes the server will write", async () => {
    // Manager is a kind of Employee: sharing with Employee leaves Manager out.
    planShare.mockResolvedValue({
      dryRun: true,
      plan: planD({
        class: owl("Employee"),
        domain: { form: "union", classes: [owl("Manager"), owl("Engineer")] },
        choices: { subclass: false, union: true, parent: true, up: [] },
        union: [ref("Engineer"), ref("Employee")],
      }),
      revision: 2,
    });
    await openReuse("Employee");
    const plan = await screen.findByRole("group", { name: "Use hasName" });
    expect(within(plan).getByText(/^Share hasName between Engineer and Employee\./)).toBeTruthy();
  });
});
