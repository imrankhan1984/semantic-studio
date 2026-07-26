/*
================================================================================
FILE: frontend/src/sparql/starters.test.ts
================================================================================

SUMMARY
    Unit tests for the starter-query and entry-point suggestions: the most
    populated class is suggested first, a counting question is offered, SKOS
    taxonomies get hierarchy starters, real relationships become two-step
    starters, every starter produces valid-looking SPARQL, the max is
    respected, and entryPoints ranks connected/populated classes first.

BASIC IDEA
    A hand-built QuerySchema stands in for a real ontology, so the ranking and
    shape of the generated starters can be asserted deterministically.

INPUTS / INPUT SOURCES
    - A fixed, hand-constructed QuerySchema.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a starters/entryPoints bug.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { buildStarters, entryPoints } from "./starters";
import { generateSparql } from "./generate";
import type { QuerySchema } from "../types";

const NS = "http://example.org/space#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

const schema: QuerySchema = {
  classes: [
    { iri: `${NS}Planet`, label: "Planet", prefixed: ":Planet", instances: 12, kind: "class" },
    { iri: `${NS}Star`, label: "Star", prefixed: ":Star", instances: 4, kind: "class" },
    { iri: `${SKOS}Concept`, label: "Concept", prefixed: "skos:Concept", instances: 40, kind: "concept" },
    {
      iri: `${SKOS}ConceptScheme`,
      label: "Concept Scheme",
      prefixed: "skos:ConceptScheme",
      instances: 2,
      kind: "conceptScheme",
    },
    { iri: `${NS}Unused`, label: "Unused", prefixed: ":Unused", instances: 0, kind: "class" },
  ],
  links: [
    {
      source: `${NS}Planet`,
      target: `${NS}Star`,
      predicate: `${NS}orbits`,
      label: "orbits",
      prefixed: ":orbits",
      declared: true,
      count: 9,
    },
  ],
  superClasses: {},
  dataProperties: {},
  namespaces: { "": NS, skos: SKOS },
  truncated: false,
};

describe("buildStarters", () => {
  it("returns nothing without a schema", () => {
    expect(buildStarters(null)).toEqual([]);
  });

  it("suggests the most populated type first", () => {
    const starters = buildStarters(schema);
    expect(starters[0].title).toBe("All Concepts");
    expect(starters[0].detail).toContain("40");
  });

  it("includes a counting question", () => {
    const starters = buildStarters(schema);
    const counting = starters.find((s) => s.state.aggregate === "count");
    expect(counting).toBeDefined();
  });

  it("suggests SKOS hierarchy queries for a taxonomy", () => {
    const starters = buildStarters(schema);
    const narrower = starters.find((s) => s.id === "skos:narrower");
    expect(narrower).toBeDefined();
    expect(narrower!.state.steps[1].link?.predicates[0]).toEqual({
      iri: `${SKOS}broader`,
      inverse: true,
    });
  });

  it("suggests relationships found in the data", () => {
    const starters = buildStarters(schema, 10);
    const link = starters.find((s) => s.id.startsWith("link:"));
    expect(link!.title).toBe("Planet → orbits → Star");
  });

  it("produces starters that generate valid-looking SPARQL", () => {
    for (const starter of buildStarters(schema, 10)) {
      const sparql = generateSparql(starter.state, schema.namespaces);
      expect(sparql).toContain("WHERE {");
      expect(sparql).toContain("LIMIT");
      if (starter.state.aggregate === "count") expect(sparql).toContain("COUNT(DISTINCT");
    }
  });

  it("respects the maximum", () => {
    expect(buildStarters(schema, 2)).toHaveLength(2);
  });
});

describe("entryPoints", () => {
  it("puts connected, populated classes first", () => {
    const points = entryPoints(schema);
    expect(points[0].iri).toBe(`${NS}Planet`);
    expect(points.map((c) => c.iri)).toContain(`${SKOS}Concept`);
  });

  it("still lists classes with no instances, but last", () => {
    const points = entryPoints(schema);
    expect(points[points.length - 1].label).toBe("Unused");
  });
});
