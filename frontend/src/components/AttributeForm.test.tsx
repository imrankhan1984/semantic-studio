// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/AttributeForm.test.tsx
================================================================================

SUMMARY
    The first tests of the attribute form, for attribute-reuse 5.3 and 5.4
    (AC-6, AC-9): *Belongs to* listing a shared domain's every class with
    Remove (UnshareDomain) and *Add a class*; *Change class* only for one
    class; the reasoner's limit said for a union; and two domain lines
    warned of, with **Share it**, which runs its Fix or, for an RDFS class,
    opens the plan that asks the shared parent's name.

BASIC IDEA
    The form is rendered for an entity model built by entityModel from
    details shaped as /node sends them, with the api mocked as the other
    form tests mock it and the project store open.

INPUTS / INPUT SOURCES
    - Inline node details with `domain` and `warnings`.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityModel } from "../modeling/entity";
import { projectStore } from "../state/projectStore";
import type { DomainReading, ModelWarning, NodeDetails } from "../types";
import AttributeForm from "./AttributeForm";
import { useRunner } from "./EditParts";

const { openProject, runCommand, planShare } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  planShare: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, planShare };
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

function propertyDetails(kind: "datatypeProperty" | "objectProperty", domain: DomainReading): NodeDetails {
  return {
    iri: HR + "hasName",
    prefixed: "hr:hasName",
    label: "hasName",
    kind,
    outgoing: [
      {
        predicate: { type: "uri", value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" },
        object: { type: "uri", value: `http://www.w3.org/2002/07/owl#${kind === "datatypeProperty" ? "DatatypeProperty" : "ObjectProperty"}` },
      },
      ...(domain.form === "one"
        ? [{ predicate: { type: "uri", value: "http://www.w3.org/2000/01/rdf-schema#domain" }, object: { type: "uri", value: domain.classes[0].iri, label: domain.classes[0].label } }]
        : []),
    ],
    incoming: [],
    outgoingTotal: 2,
    incomingTotal: 0,
    domain,
  } as NodeDetails;
}

const SEPARATE_TEXT =
  "hasName lists Employee and Team separately. In RDFS and OWL that means whatever has hasName is both an Employee and a Team. To mean either one, share it.";

function separate(needs?: "parentName"): ModelWarning {
  return {
    block: "domain",
    code: "separate",
    text: SEPARATE_TEXT,
    fix: { command: "ShareDomain", args: { property: HR + "hasName", how: needs ? "parent" : "union" }, label: "Share it", ...(needs ? { needs } : {}) },
  };
}

function Harness({ details, warnings }: { details: NodeDetails; warnings: ModelWarning[] }) {
  const runner = useRunner();
  return (
    <AttributeForm
      ontologyId={`${PID}-model`}
      iri={details.iri}
      name={details.label}
      model={entityModel(details, "en", [])}
      runner={runner}
      onSelect={() => undefined}
      warnings={warnings}
    />
  );
}

async function show(domain: DomainReading, warnings: ModelWarning[] = []) {
  await act(async () => {
    render(<Harness details={propertyDetails("datatypeProperty", domain)} warnings={warnings} />);
  });
}

/** A form block is a section under its heading. */
const belongsTo = () => screen.getByRole("heading", { name: "Belongs to" }).closest("section") as HTMLElement;

const UNION: DomainReading = { form: "union", classes: [ref("Employee"), ref("Contractor"), ref("Intern")] };
const TWO_LINES: DomainReading = { form: "separate", classes: [ref("Employee"), ref("Team")] };

beforeEach(async () => {
  projectStore._reset();
  for (const m of [openProject, runCommand, planShare]) m.mockReset();
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
  runCommand.mockResolvedValue({ revision: 3, label: "Done", state: STATE });
});

afterEach(() => {
  cleanup();
});

describe("Belongs to, for a shared domain (attribute-reuse 5.3)", () => {
  it("lists every class with Remove, and Add a class; no Change class", async () => {
    await show(UNION);
    const block = belongsTo();
    expect(within(block).getByText("Any one of these classes:")).toBeTruthy();
    for (const c of ["Employee", "Contractor", "Intern"]) {
      expect(within(block).getByRole("button", { name: `Remove ${c} from hasName` })).toBeTruthy();
    }
    expect(within(block).getByRole("button", { name: "Add a class to hasName" })).toBeTruthy();
    // Neither Change nor Choose: either would replace every class.
    expect(within(block).queryByRole("button", { name: /the class hasName belongs to/ })).toBeNull();
    // Section 7: the reasoner's limit, said where it matters.
    expect(within(block).getByText(/draws no conclusion from a shared class list/)).toBeTruthy();
  });

  it("Remove is UnshareDomain for that class", async () => {
    await show(UNION);
    await act(async () => screen.getByRole("button", { name: "Remove Contractor from hasName" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "UnshareDomain", { property: HR + "hasName", class: HR + "Contractor" });
  });

  it("one class keeps Change class, and can be shared through Add a class", async () => {
    await show({ form: "one", classes: [ref("Employee")] });
    const block = belongsTo();
    expect(within(block).getByRole("button", { name: "Change the class hasName belongs to" })).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Add a class to hasName" })).toBeTruthy();
    expect(within(block).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });
});

describe("two domain lines (attribute-reuse 5.4)", () => {
  it("says what they mean under Belongs to, and Share it runs the Fix", async () => {
    await show(TWO_LINES, [separate()]);
    const block = belongsTo();
    expect(within(block).getByText(SEPARATE_TEXT)).toBeTruthy();
    expect(within(block).getByText("All of these classes at once (see the warning):")).toBeTruthy();
    await act(async () => within(block).getByRole("button", { name: "Share it" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "ShareDomain", { property: HR + "hasName", how: "union" });
  });

  it("with an RDFS class, Share it opens the plan for the parent's name", async () => {
    planShare.mockResolvedValue({
      dryRun: true,
      plan: {
        case: "separate",
        property: { iri: HR + "hasName", label: "hasName", kind: "attribute" },
        domain: { form: "separate", classes: [{ ...ref("Employee"), type: "owl" }, { ...ref("Team"), type: "rdfs" }] },
        choices: { subclass: false, union: false, parent: true, up: [] },
        imported: [],
        union: [ref("Employee"), ref("Team")],
        turtle: null,
      },
      revision: 2,
    });
    await show(TWO_LINES, [separate("parentName")]);
    await act(async () => screen.getByRole("button", { name: "Share it" }).click());
    expect(runCommand).not.toHaveBeenCalled();
    expect(planShare).toHaveBeenCalledWith(PID, HR + "hasName", undefined);
    expect(await screen.findByLabelText("What is every Employee and Team? For example, Worker")).toBeTruthy();
  });

  it("an imported property's warning has no button", async () => {
    await show(TWO_LINES, [{ block: "domain", code: "separate", text: SEPARATE_TEXT }]);
    expect(screen.getByText(SEPARATE_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share it" })).toBeNull();
  });
});

describe("found in code review", () => {
  it("a refused change of one class is said once", async () => {
    runCommand.mockRejectedValue(new Error("hasName has no start to clear."));
    await show({ form: "one", classes: [ref("Employee")] });
    await act(async () => screen.getByRole("button", { name: "Clear the class hasName belongs to" }).click());
    expect(screen.getAllByText("hasName has no start to clear.")).toHaveLength(1);
  });
});
