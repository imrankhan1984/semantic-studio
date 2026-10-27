// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/RelationshipForm.test.tsx
================================================================================

SUMMARY
    The first tests of the relationship form, for attribute-reuse 5.3 and
    5.4 (AC-6, AC-9): *From* listing a shared start's every class with
    Remove (UnshareDomain) and *Add a class*; *Change from* only for one
    class; and two domain lines warned of under *From*, with **Share it**.
    Stage B (5.8): from an RDFS class, *Pointers* offers to make it an OWL
    class in place of *add a rule*.

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
import { useRunner } from "./EditParts";
import RelationshipForm from "./RelationshipForm";

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
      // An end, so Swap is not disabled for the want of one.
      { predicate: { type: "uri", value: "http://www.w3.org/2000/01/rdf-schema#range" }, object: { type: "uri", value: HR + "Manager", label: "Manager" } },
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
  "hasName lists Employee and Team separately. In RDFS and OWL that means whatever hasName something is both an Employee and a Team. To mean either one, share it.";

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
    <RelationshipForm
      ontologyId={`${PID}-model`}
      primaryLanguage="en"
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
    render(<Harness details={propertyDetails("objectProperty", domain)} warnings={warnings} />);
  });
}

/** A form block is a section under its heading. */
const fromTo = () => screen.getByRole("heading", { name: "From and to" }).closest("section") as HTMLElement;

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

describe("From, for a shared start (attribute-reuse 5.3)", () => {
  it("lists every class with Remove, and Add a class; no Change from", async () => {
    await show(UNION);
    const block = fromTo();
    expect(within(block).getByText("Any one of these classes:")).toBeTruthy();
    for (const c of ["Employee", "Contractor", "Intern"]) {
      expect(within(block).getByRole("button", { name: `Remove ${c} from hasName` })).toBeTruthy();
    }
    expect(within(block).getByRole("button", { name: "Add a class to hasName" })).toBeTruthy();
    expect(within(block).queryByRole("button", { name: /the start of hasName/ })).toBeNull();
    await act(async () => within(block).getByRole("button", { name: "Remove Intern from hasName" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "UnshareDomain", { property: HR + "hasName", class: HR + "Intern" });
  });

  it("one class keeps Change from, and Add a class", async () => {
    await show({ form: "one", classes: [ref("Employee")] });
    const block = fromTo();
    expect(within(block).getByRole("button", { name: "Change the start of hasName" })).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Add a class to hasName" })).toBeTruthy();
  });

  it("two domain lines are warned of under From, and Share it runs the Fix", async () => {
    await show(TWO_LINES, [separate()]);
    const block = fromTo();
    expect(within(block).getByText(SEPARATE_TEXT)).toBeTruthy();
    await act(async () => within(block).getByRole("button", { name: "Share it" }).click());
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "ShareDomain", { property: HR + "hasName", how: "union" });
  });
});

describe("found in code review", () => {
  it("Swap is unavailable for a shared start: its end would become several classes", async () => {
    await show(UNION);
    const swap = within(fromTo()).getAllByRole("button").find((b) => b.textContent?.includes("Swap"))!;
    expect(swap.textContent).toContain("Swap");
    expect(swap.getAttribute("aria-disabled")).toBe("true");
    await act(async () => swap.click());
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("Pointers, from an RDFS class (attribute-reuse 5.8, AC-13)", () => {
  it("offers to make the start an OWL class in place of Add a rule", async () => {
    await show({ form: "one", classes: [{ ...ref("Employee"), type: "rdfs" }] });
    expect(screen.queryByRole("button", { name: "add a rule to Employee" })).toBeNull();
    expect(screen.getByText(/Rules need an OWL class; RDFS has no words for them\./)).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Make Employee an OWL class" }).click());
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["model", "SetClassType", { class: HR + "Employee", type: "owl" }]);
    expect(projectStore.getSnapshot().announcement.text).toBe("Employee is now an OWL class.");
  });

  it("keeps add a rule for an OWL start", async () => {
    await show({ form: "one", classes: [{ ...ref("Employee"), type: "owl" }] });
    expect(screen.getByRole("button", { name: "add a rule to Employee" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make Employee an OWL class" })).toBeNull();
  });
});
