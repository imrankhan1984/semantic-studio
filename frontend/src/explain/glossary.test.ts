/*
================================================================================
FILE: frontend/src/explain/glossary.test.ts
================================================================================

SUMMARY
    The fixed glossary (explain-panel 5.3, AC-3): every standard term the
    bundled examples show has an entry; each entry is one sentence of at
    most 25 words naming no prefixed term; the SKOS mappings are MAPPINGS'
    own; keys are full IRIs. And panelTerms: the defined terms of a panel,
    once each, in the order they first appear.

BASIC IDEA
    exampleTerms.json is measured from the bundled files by
    backend/tests/test_node_detail.py, which fails when the two part, so
    this file never holds a list of its own that could go stale. Each
    entry is checked as text; asserting first that the table loaded keeps
    a scan over nothing from passing.

INPUTS / INPUT SOURCES
    - explain/glossary.ts, explain/exampleTerms.json, modeling/sentences.ts.

EXPECTED OUTPUT
    - Pass/fail per case.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { MAPPINGS } from "../modeling/sentences";
import type { NodeDetails, TermRef } from "../types";
import EXAMPLE_TERMS from "./exampleTerms.json";
import { GLOSSARY, definition, panelTerms } from "./glossary";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

const ENTRIES = Object.entries(GLOSSARY);

describe("the glossary", () => {
  it("defines every standard term a bundled example shows", () => {
    // Measured from the files (test_node_detail.py): the spec counted 45 in
    // Space Exploration; FOAF and The Lord of the Rings add Dublin Core's
    // older terms and a few more.
    expect(EXAMPLE_TERMS.terms.length).toBeGreaterThanOrEqual(45);
    const missing = EXAMPLE_TERMS.terms.filter((iri) => definition(iri) === undefined);
    expect(missing).toEqual([]);
  });

  it("covers the common terms the examples do not use", () => {
    for (const local of ["Restriction", "Thing", "imports", "NamedIndividual", "someValuesFrom", "allValuesFrom"]) {
      expect(definition(`http://www.w3.org/2002/07/owl#${local}`)).toBeTruthy();
    }
    expect(definition("http://www.w3.org/2000/01/rdf-schema#seeAlso")).toBeTruthy();
    for (const id of ["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"]) {
      expect(definition(`${SKOS}${id}`)).toBeTruthy();
    }
  });

  it("is keyed by full IRIs", () => {
    expect(ENTRIES.length).toBeGreaterThan(100);
    for (const [iri] of ENTRIES) expect(iri).toMatch(/^http:\/\/[^\s]+[#/][A-Za-z]+$/);
  });

  it("gives each term one sentence of at most 25 words, naming no prefixed term", () => {
    for (const [iri, text] of ENTRIES) {
      const where = `${iri}: ${text}`;
      expect(text, where).toMatch(/^[a-z].*\.$/);
      // One sentence: no full stop before the last except inside a number
      // (3.75) or a date and time.
      expect(text.slice(0, -1).replace(/\d\.\d/g, ""), where).not.toMatch(/[.!?]/);
      expect(text.split(/\s+/).length, where).toBeLessThanOrEqual(25);
      // No prefixed term (rdf:type, xsd:date) in a definition: a learner
      // reading this list cannot read one.
      expect(text, where).not.toMatch(/\b[A-Za-z]+:[A-Za-z]/);
    }
  });

  it("takes the SKOS mappings from MAPPINGS, not a copy", () => {
    expect(MAPPINGS).toHaveLength(5);
    for (const mapping of MAPPINGS) {
      const means = mapping.means;
      expect(definition(`${SKOS}${mapping.id}`)).toBe(`${means[0].toLowerCase()}${means.slice(1)}`);
    }
  });

  it("finds nothing on Object.prototype (X-6)", () => {
    expect(definition("constructor")).toBeUndefined();
    expect(definition("__proto__")).toBeUndefined();
  });

  it("matches the spec's three examples", () => {
    expect(definition(RDF_TYPE)).toBe("says what kind of thing something is; the value is a class.");
    expect(definition(SUBCLASS)).toBe(
      "says one class is a more specific kind of another; everything in the first is also in the second.",
    );
    expect(definition("http://www.w3.org/2001/XMLSchema#date")).toBe("a calendar date, such as 1969-07-16.");
  });
});

const uri = (value: string, prefixed: string, label?: string): TermRef => ({ type: "uri", value, prefixed, label });
const XSD = "http://www.w3.org/2001/XMLSchema#";
const literal = (value: string, datatype: string | null, datatypeIri: string | null = null): TermRef => ({
  type: "literal",
  value,
  lang: null,
  datatype,
  datatypeIri: datatypeIri ?? (datatype?.startsWith("xsd:") ? `${XSD}${datatype.slice(4)}` : null),
});
const SPACE = "http://example.org/space#";

describe("panelTerms", () => {
  const statements: NodeDetails["outgoing"] = [
    { predicate: uri(RDF_TYPE, "rdf:type", "type"), object: uri(OWL_CLASS, "owl:Class", "Class") },
    { predicate: uri(SUBCLASS, "rdfs:subClassOf", "subClassOf"), object: uri(`${SPACE}Mission`, "space:Mission", "Mission") },
    { predicate: uri(`${SPACE}launchDate`, "space:launchDate", "launch date"), object: literal("1969-07-16", "xsd:date") },
    { predicate: uri(RDF_TYPE, "rdf:type", "type"), object: uri(OWL_CLASS, "owl:Class", "Class") },
    { predicate: uri(SUBCLASS, "rdfs:subClassOf", "subClassOf"), object: { type: "bnode", value: "[owl:onProperty …]" } },
  ];
  const references: NodeDetails["incoming"] = [
    { subject: uri(`${SPACE}Apollo11`, "space:Apollo11", "Apollo 11"), predicate: uri(RDF_TYPE, "rdf:type", "type") },
    {
      subject: uri(`${SPACE}crewMember`, "space:crewMember", "crew member"),
      predicate: uri("http://www.w3.org/2000/01/rdf-schema#domain", "rdfs:domain", "domain"),
    },
  ];

  it("lists each defined term once, in the order it first appears", () => {
    const terms = panelTerms(statements, references);
    expect(terms.map((t) => t.prefixed)).toEqual(["rdf:type", "owl:Class", "rdfs:subClassOf", "xsd:date", "rdfs:domain"]);
    // The panel's name, the prefixed form, one sentence.
    expect(terms[0]).toEqual({
      iri: RDF_TYPE,
      name: "type",
      prefixed: "rdf:type",
      definition: "says what kind of thing something is; the value is a class.",
    });
    // A literal's type, shown as ^^xsd:date, by its local name.
    expect(terms[3].name).toBe("date");
  });

  it("lists no term outside the glossary, and nothing for an empty panel", () => {
    expect(panelTerms([{ predicate: uri(`${SPACE}orbits`, "space:orbits", "orbits"), object: literal("x", null) }], [])).toEqual([]);
    expect(panelTerms([], [])).toEqual([]);
  });

  it("looks a literal's type up by its full IRI, never its prefix", () => {
    // The file bound XML Schema as xs: — still its date.
    const xs = [{ predicate: uri(`${SPACE}p`, "space:p"), object: literal("1969-07-16", "xs:date", `${XSD}date`) }];
    expect(panelTerms(xs, [])).toMatchObject([{ iri: `${XSD}date`, name: "date", prefixed: "xs:date" }]);
    // A prefix that looks standard but names something else defines nothing.
    const odd = [{ predicate: uri(`${SPACE}p`, "space:p"), object: literal("1", "xsd:date", "http://example.org/x#date") }];
    expect(panelTerms(odd, [])).toEqual([]);
  });

  it("names a term with no label by its prefixed form", () => {
    const [term] = panelTerms([{ predicate: uri(RDF_TYPE, "rdf:type"), object: literal("x", null) }], []);
    expect(term.name).toBe("rdf:type");
  });
});
