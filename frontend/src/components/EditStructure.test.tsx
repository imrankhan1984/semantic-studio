// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/EditStructure.test.tsx
================================================================================

SUMMARY
    The first tests of the editing form's Structure block, for
    attribute-reuse 5.3 (AC-8, AC-12): a class's attributes and
    relationships in three groups -- its own, *Shared with others* and
    *Through* each parent -- the shared ones marked in text.

BASIC IDEA
    The block is rendered for an entity model built by entityModel from
    details shaped as /node sends them, with the api mocked as the other
    form tests mock it, and the project store open.

INPUTS / INPUT SOURCES
    - Inline node details with `properties`.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityModel } from "../modeling/entity";
import { projectStore } from "../state/projectStore";
import type { ClassProperty, NodeDetails } from "../types";
import { useRunner } from "./EditParts";
import EditStructure from "./EditStructure";

const { openProject, runCommand, searchNodes, getNodeDetails } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  searchNodes: vi.fn(),
  getNodeDetails: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, searchNodes, getNodeDetails };
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
  for (const m of [openProject, runCommand, searchNodes, getNodeDetails, onSelect]) m.mockReset();
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
