/*
================================================================================
FILE: frontend/src/sparql/generate.test.ts
================================================================================

SUMMARY
    Unit tests for the SPARQL generator. Because the generator is pure, these
    assert its exact output for hand-built QueryStates: single class, multi-hop
    paths, inverse hops, alternation, each modifier, OPTIONAL subtree wrapping,
    filters (every operator/datatype), paths-mode collapsing, count mode,
    variable dedup, prefix handling, and edge cases.

BASIC IDEA
    Small helper factories (step/link/state/prop) make each test read as the
    query it describes; assertions check substrings of the generated SPARQL.

INPUTS / INPUT SOURCES
    - Hand-constructed QueryState objects and a fixed namespace map.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures pinpoint a generator regression.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { assignVarNames, generateSparql } from "./generate";
import type { QueryState, QueryStep, SelectedProp, StepLink } from "./types";

const NS = "http://example.org/space#";
const NAMESPACES = { ex: NS, skos: "http://www.w3.org/2004/02/skos/core#" };

function step(name: string, extra: Partial<QueryStep> = {}): QueryStep {
  return { classIri: NS + name, label: name, props: [], ...extra };
}

function link(anchor: number, predicate: string, extra: Partial<StepLink> = {}): StepLink {
  return {
    anchor,
    predicates: [{ iri: NS + predicate, inverse: false }],
    modifier: "",
    optional: false,
    ...extra,
  };
}

function state(steps: QueryStep[], extra: Partial<QueryState> = {}): QueryState {
  return { steps, limit: 100, pathsMode: false, distinct: false, aggregate: "none", ...extra };
}

function prop(name: string, extra: Partial<SelectedProp> = {}): SelectedProp {
  return { predicateIri: NS + name, label: name, optional: true, ...extra };
}

describe("generateSparql", () => {
  it("returns an empty string with no steps", () => {
    expect(generateSparql(state([]), NAMESPACES)).toBe("");
  });

  it("emits a single class query", () => {
    const sparql = generateSparql(state([step("Planet")]), NAMESPACES);
    expect(sparql).toBe(
      [
        "PREFIX ex: <http://example.org/space#>",
        "",
        "SELECT ?planet",
        "WHERE {",
        "  ?planet a ex:Planet .",
        "}",
        "LIMIT 100",
      ].join("\n"),
    );
  });

  it("emits a linear multi-hop path", () => {
    const sparql = generateSparql(
      state([
        step("Mission"),
        step("Spacecraft", { link: link(0, "uses") }),
        step("SpaceAgency", { link: link(1, "operatedBy") }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain("?mission a ex:Mission .");
    expect(sparql).toContain("?mission ex:uses ?spacecraft .");
    expect(sparql).toContain("?spacecraft ex:operatedBy ?spaceAgency .");
    expect(sparql).toContain("SELECT ?mission ?spacecraft ?spaceAgency");
  });

  it("swaps subject and object for an inverse hop", () => {
    const sparql = generateSparql(
      state([
        step("Star"),
        step("Planet", {
          link: { ...link(0, "orbits"), predicates: [{ iri: NS + "orbits", inverse: true }] },
        }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain("?planet ex:orbits ?star .");
    expect(sparql).not.toContain("^");
  });

  it("uses a property path for alternation", () => {
    const sparql = generateSparql(
      state([
        step("Planet"),
        step("Star", {
          link: {
            ...link(0, "orbits"),
            predicates: [
              { iri: NS + "orbits", inverse: false },
              { iri: NS + "circles", inverse: true },
            ],
          },
        }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain("?planet (ex:orbits|^ex:circles) ?star .");
  });

  it.each([
    ["*", "(ex:orbits)*"],
    ["+", "(ex:orbits)+"],
    ["?", "(ex:orbits)?"],
  ])("applies the %s modifier", (modifier, expected) => {
    const sparql = generateSparql(
      state([
        step("CelestialBody"),
        step("CelestialBody", {
          link: { ...link(0, "orbits"), modifier: modifier as "*" | "+" | "?" },
        }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain(`?celestialBody ${expected} ?celestialBody2 .`);
  });

  it("combines alternation and modifier", () => {
    const sparql = generateSparql(
      state([
        step("Concept"),
        step("Concept", {
          link: {
            anchor: 0,
            modifier: "+",
            optional: false,
            predicates: [
              { iri: "http://www.w3.org/2004/02/skos/core#broader", inverse: false },
              { iri: "http://www.w3.org/2004/02/skos/core#narrower", inverse: true },
            ],
          },
        }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain("(skos:broader|^skos:narrower)+");
  });

  it("wraps an optional hop and everything hanging off it", () => {
    const sparql = generateSparql(
      state([
        step("Order"),
        step("Customer", { link: { ...link(0, "hasCustomer"), optional: true } }),
        step("Address", { link: link(1, "livesAt") }),
        step("Shipper", { link: link(0, "hasShipper") }),
      ]),
      NAMESPACES,
    );
    const lines = sparql.split("\n");
    const open = lines.findIndex((l) => l.includes("OPTIONAL {"));
    const close = lines.findIndex((l, i) => i > open && l.trim() === "}");
    const inside = lines.slice(open + 1, close).join("\n");
    // The dependent step travels into the OPTIONAL block with its parent...
    expect(inside).toContain("?order ex:hasCustomer ?customer .");
    expect(inside).toContain("?customer ex:livesAt ?address .");
    // ...while a sibling branch off the same anchor stays outside it.
    expect(lines.slice(close).join("\n")).toContain("?order ex:hasShipper ?shipper .");
  });

  it("pins an individual with VALUES", () => {
    const sparql = generateSparql(
      state([step("Planet", { pin: { iri: NS + "Earth", label: "Earth" } })]),
      NAMESPACES,
    );
    expect(sparql).toContain("VALUES ?planet { ex:Earth }");
  });

  it("makes selected properties optional by default", () => {
    const sparql = generateSparql(
      state([step("Planet", { props: [prop("diameterKm")] })]),
      NAMESPACES,
    );
    expect(sparql).toContain("OPTIONAL { ?planet ex:diameterKm ?planetDiameterKm . }");
    expect(sparql).toContain("SELECT ?planet ?planetDiameterKm");
  });

  it("drops OPTIONAL when a property carries a filter", () => {
    const sparql = generateSparql(
      state([
        step("Planet", {
          props: [
            prop("diameterKm", {
              datatype: "http://www.w3.org/2001/XMLSchema#decimal",
              filter: { op: ">", value: "5000" },
            }),
          ],
        }),
      ]),
      NAMESPACES,
    );
    expect(sparql).toContain("?planet ex:diameterKm ?planetDiameterKm .");
    expect(sparql).toContain("FILTER(?planetDiameterKm > 5000)");
    expect(sparql).not.toContain("OPTIONAL");
  });

  describe("filters", () => {
    const numeric = "http://www.w3.org/2001/XMLSchema#integer";
    function filterFor(op: string, value: string, datatype?: string) {
      return generateSparql(
        state([
          step("Planet", {
            props: [
              prop("value", {
                datatype,
                optional: false,
                filter: { op: op as never, value },
              }),
            ],
          }),
        ]),
        NAMESPACES,
      );
    }

    it.each([">", ">=", "<", "<="])("emits a bare number for %s", (op) => {
      expect(filterFor(op, "42", numeric)).toContain(`FILTER(?planetValue ${op} 42)`);
    });

    it("compares strings through STR()", () => {
      expect(filterFor("=", "Earth")).toContain('FILTER(STR(?planetValue) = "Earth")');
      expect(filterFor("!=", "Earth")).toContain('FILTER(STR(?planetValue) != "Earth")');
    });

    it("compares numbers directly", () => {
      expect(filterFor("=", "7", numeric)).toContain("FILTER(?planetValue = 7)");
    });

    it("lowercases contains and starts-with", () => {
      expect(filterFor("contains", "Mars")).toContain(
        'FILTER(CONTAINS(LCASE(STR(?planetValue)), "mars"))',
      );
      expect(filterFor("startsWith", "Ma")).toContain(
        'FILTER(STRSTARTS(LCASE(STR(?planetValue)), "ma"))',
      );
    });

    it("filters by language tag", () => {
      expect(filterFor("lang", "en")).toContain('FILTER(LANG(?planetValue) = "en")');
    });

    it("types date and dateTime literals", () => {
      const sparql = filterFor(">", "1997-01-01", "http://www.w3.org/2001/XMLSchema#date");
      expect(sparql).toContain('FILTER(?planetValue > "1997-01-01"^^xsd:date)');
      expect(sparql).toContain("PREFIX xsd:");
    });

    it("compares xsd:gYear lexically", () => {
      // rdflib (and other engines) silently match nothing when gYear is
      // compared as a typed literal, so the lexical form is used instead.
      const sparql = filterFor(">", "1980", "http://www.w3.org/2001/XMLSchema#gYear");
      expect(sparql).toContain('FILTER(STR(?planetValue) > "1980")');
      expect(sparql).not.toContain("^^xsd:gYear");
    });

    it("compares booleans as bare values", () => {
      const sparql = filterFor("=", "true", "http://www.w3.org/2001/XMLSchema#boolean");
      expect(sparql).toContain("FILTER(?planetValue = true)");
    });

    it("escapes quotes in values", () => {
      expect(filterFor("=", 'say "hi"')).toContain('STR(?planetValue) = "say \\"hi\\""');
    });

    it("ignores an empty filter value", () => {
      expect(filterFor("=", "  ")).not.toContain("FILTER");
    });
  });

  describe("paths mode", () => {
    const chain = () =>
      state(
        [
          step("Product"),
          step("OrderDetail", {
            link: { ...link(0, "hasProduct"), predicates: [{ iri: NS + "hasProduct", inverse: true }] },
          }),
          step("Order", { link: link(1, "belongsToOrder") }),
        ],
        { pathsMode: true },
      );

    it("collapses bare intermediate steps into one path", () => {
      const sparql = generateSparql(chain(), NAMESPACES);
      expect(sparql).toContain("?product (^ex:hasProduct)/(ex:belongsToOrder) ?order .");
      expect(sparql).not.toContain("?orderDetail");
      expect(sparql).toContain("SELECT ?product ?order");
    });

    it("keeps a step that carries data", () => {
      const withProps = chain();
      withProps.steps[1].props = [prop("quantity")];
      const sparql = generateSparql(withProps, NAMESPACES);
      expect(sparql).toContain("?orderDetail");
      expect(sparql).not.toContain("/(ex:belongsToOrder)");
    });

    it("keeps a pinned step", () => {
      const pinned = chain();
      pinned.steps[1].pin = { iri: NS + "OD1", label: "OD1" };
      expect(generateSparql(pinned, NAMESPACES)).toContain("VALUES ?orderDetail");
    });

    it("does not collapse across an optional hop", () => {
      const optional = chain();
      (optional.steps[2].link as StepLink).optional = true;
      const sparql = generateSparql(optional, NAMESPACES);
      expect(sparql).toContain("?orderDetail");
      expect(sparql).toContain("OPTIONAL {");
    });

    it("leaves explicit mode untouched", () => {
      const sparql = generateSparql({ ...chain(), pathsMode: false }, NAMESPACES);
      expect(sparql).toContain("?orderDetail a ex:OrderDetail .");
    });
  });

  it("dedupes repeated class names", () => {
    const { stepVars } = assignVarNames(
      state([step("Planet"), step("Planet", { link: link(0, "orbits") })]),
    );
    expect(stepVars).toEqual(["planet", "planet2"]);
  });

  it("falls back to full IRIs when no prefix matches", () => {
    const sparql = generateSparql(
      state([{ classIri: "http://other.example/Thing", label: "Thing", props: [] }]),
      NAMESPACES,
    );
    expect(sparql).toContain("?thing a <http://other.example/Thing> .");
    expect(sparql).not.toContain("PREFIX ex:");
  });

  it("supports the empty prefix used by many ontologies", () => {
    const sparql = generateSparql(state([step("Planet")]), { "": NS });
    expect(sparql).toContain("PREFIX : <http://example.org/space#>");
    expect(sparql).toContain("?planet a :Planet .");
  });

  it("falls back to a full IRI when the local part is not a valid QName", () => {
    const sparql = generateSparql(
      state([{ classIri: NS + "odd.name", label: "odd", props: [] }]),
      NAMESPACES,
    );
    expect(sparql).toContain("<http://example.org/space#odd.name>");
  });

  it("honours DISTINCT and LIMIT", () => {
    const sparql = generateSparql(
      state([step("Planet")], { distinct: true, limit: 25 }),
      NAMESPACES,
    );
    expect(sparql).toContain("SELECT DISTINCT ?planet");
    expect(sparql).toContain("LIMIT 25");
  });

  describe("count mode", () => {
    it("counts a single step without grouping", () => {
      const sparql = generateSparql(
        state([step("Planet")], { aggregate: "count" }),
        NAMESPACES,
      );
      expect(sparql).toContain("SELECT (COUNT(DISTINCT ?planet) AS ?count)");
      expect(sparql).not.toContain("GROUP BY");
    });

    it("groups by the first step and counts the last", () => {
      const sparql = generateSparql(
        state(
          [
            step("SpaceAgency"),
            step("Spacecraft", { link: link(0, "operates") }),
          ],
          { aggregate: "count" },
        ),
        NAMESPACES,
      );
      expect(sparql).toContain("SELECT ?spaceAgency (COUNT(DISTINCT ?spacecraft) AS ?count)");
      expect(sparql).toContain("GROUP BY ?spaceAgency");
      expect(sparql).toContain("ORDER BY DESC(?count)");
    });

    it("keeps filters but does not project data properties", () => {
      const sparql = generateSparql(
        state(
          [
            step("Spacecraft", {
              props: [
                prop("launchYear", {
                  optional: false,
                  filter: { op: "=", value: "2020" },
                }),
              ],
            }),
          ],
          { aggregate: "count" },
        ),
        NAMESPACES,
      );
      expect(sparql).toContain("FILTER(");
      expect(sparql).toContain("?spacecraft ex:launchYear ?spacecraftLaunchYear .");
      expect(sparql).not.toContain("SELECT ?spacecraftLaunchYear");
    });
  });

  it("ignores a step whose anchor is invalid", () => {
    const sparql = generateSparql(
      state([step("Planet"), step("Star", { link: link(5, "orbits") })]),
      NAMESPACES,
    );
    expect(sparql).toContain("?planet a ex:Planet .");
    expect(sparql).not.toContain("?star");
  });
});
