// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ConceptRelations.test.tsx
================================================================================

SUMMARY
    The first test for ConceptRelations (X-12, T-23): a concept's mapping
    rows read by the target's name -- an imported concept's label, which they
    showed as its raw IRI (PR #49 review) -- with the IRI in the title, and
    by the IRI only for a target with no name.

BASIC IDEA
    The concept's blocks are read out of node details by entityModel, as the
    form reads them, so the row's name is the one the server's term carries.
    The runner is a stub: no command is sent here.

INPUTS / INPUT SOURCES
    - A mocked api.ts (the picker's search is never reached).

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ searchNodes: vi.fn() }));

import { entityModel } from "../modeling/entity";
import type { NodeDetails, TermRef } from "../types";
import ConceptRelations from "./ConceptRelations";
import type { Runner } from "./EditParts";

const EX = "http://example.org/fruit#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

const term = (value: string, label: string | null, prefixed: string | null): TermRef => ({
  type: "uri",
  value,
  label: label ?? undefined,
  prefixed: prefixed ?? undefined,
});

function concept(mappings: [string, TermRef][]): NodeDetails {
  return {
    iri: EX + "Apple",
    prefixed: "fruit:Apple",
    label: "Apple",
    kind: "concept",
    outgoing: mappings.map(([p, o]) => ({ predicate: term(SKOS + p, p, `skos:${p}`), object: o })),
    incoming: [],
    outgoingTotal: mappings.length,
    incomingTotal: 0,
  } as NodeDetails;
}

const runner: Runner = { busy: false, errors: {}, run: vi.fn(), clear: vi.fn(), alive: () => true };

function show(details: NodeDetails) {
  render(
    <ConceptRelations
      ontologyId="prj-1-model"
      iri={details.iri}
      name="Apple"
      model={entityModel(details, "en", ["en"])}
      runner={runner}
      onSelect={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ConceptRelations: a mapping row (T-23)", () => {
  it("shows an imported concept by its label, with its IRI in the title", () => {
    const imported = "http://example.org/imported#Malus";
    show(concept([["exactMatch", term(imported, "Malus", "imp:Malus")]]));
    const link = screen.getByRole("link", { name: "Malus" });
    expect(link.getAttribute("href")).toBe(imported);
    expect(link.getAttribute("title")).toBe(imported);
    expect(screen.queryByText(imported)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove the exact match Malus" })).toBeTruthy();
  });

  it("falls back to the IRI only when the target has no name", () => {
    const bare = "http://dbpedia.org/resource/Apple";
    show(concept([["closeMatch", term(bare, null, null)]]));
    expect(screen.getByRole("link", { name: bare }).getAttribute("href")).toBe(bare);
  });

  it("a target that cannot be a link is its name as text", () => {
    show(concept([["relatedMatch", term("urn:x:pome", "Pome", null)]]));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Pome").getAttribute("title")).toBe("urn:x:pome");
  });
});
