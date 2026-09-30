/*
================================================================================
FILE: frontend/src/modeling/entity.test.ts
================================================================================

SUMMARY
    How the editing form reads an entity out of its statements: kind, defined
    here or not, names per project language, the definition, the other
    annotations, and each kind's structure.

BASIC IDEA
    NodeDetails are built by hand, shaped as /node returns them for a project
    document (URI terms carrying `kind`). Each test names one rule of
    entity.ts and the statements that decide it.

INPUTS / INPUT SOURCES
    - modeling/entity.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { NodeDetails, TermRef } from "../types";
import { entityModel, P } from "./entity";

const EX = "http://example.org/shop#";
const uri = (value: string, kind?: string, label?: string): TermRef => ({
  type: "uri",
  value,
  prefixed: value.replace(EX, "shop:"),
  label: label ?? value.replace(EX, ""),
  ...(kind ? { kind } : {}),
});
const pred = (value: string): TermRef => uri(value);
const lit = (value: string, lang?: string, datatype?: string): TermRef => ({
  type: "literal",
  value,
  lang: lang ?? null,
  datatype: datatype ?? null,
});

function details(
  outgoing: [string, TermRef][],
  incoming: [TermRef, string][] = [],
  kind = "class",
): NodeDetails {
  return {
    iri: EX + "Invoice",
    prefixed: "shop:Invoice",
    label: "Invoice",
    kind,
    outgoing: outgoing.map(([p, o]) => ({ predicate: pred(p), object: o })),
    incoming: incoming.map(([s, p]) => ({ subject: s, predicate: pred(p) })),
    outgoingTotal: outgoing.length,
    incomingTotal: incoming.length,
  };
}

const OWL_CLASS = uri("http://www.w3.org/2002/07/owl#Class");

describe("entityModel", () => {
  it("lists a name per project language, primary first, missing ones as null", () => {
    const model = entityModel(
      details([
        [P.type, OWL_CLASS],
        [P.label, lit("Invoice", "en")],
        [P.label, lit("Rechnung", "de")],
      ]),
      "en",
      ["fr", "de"],
    );
    expect(model.names.map((n) => [n.lang, n.value])).toEqual([
      ["en", "Invoice"],
      ["fr", null],
      ["de", "Rechnung"],
    ]);
    expect(model.names[2]).toMatchObject({ predicate: P.label, tag: "de" });
  });

  it("names a concept by skos:prefLabel, and matches a tag by prefix", () => {
    const model = entityModel(
      details([[P.type, uri("http://www.w3.org/2004/02/skos/core#Concept")], [P.prefLabel, lit("Paid", "en-GB")]], [], "concept"),
      "en",
      [],
    );
    expect(model.namePredicate).toBe(P.prefLabel);
    expect(model.names[0]).toMatchObject({ value: "Paid", tag: "en-GB" });
  });

  it("takes skos:definition first, else the rdfs:comment that is there", () => {
    const both = entityModel(
      details([
        [P.type, OWL_CLASS],
        [P.comment, lit("A comment.", "en")],
        [P.definition, lit("A definition.", "en")],
      ]),
      "en",
      [],
    );
    expect(both.definition).toEqual({
      property: P.definition,
      value: { kind: "text", value: "A definition.", lang: "en" },
    });
    // The comment that is not the definition is an ordinary annotation.
    expect(both.annotations.map((a) => a.value.value)).toEqual(["A comment."]);

    const untagged = entityModel(details([[P.type, OWL_CLASS], [P.comment, lit("Plain.")]]), "en", []);
    expect(untagged.definition?.property).toBe(P.comment);
    expect(untagged.annotations).toEqual([]);
  });

  it("keeps structure, names and OWL axioms out of the annotations", () => {
    const model = entityModel(
      details([
        [P.type, OWL_CLASS],
        [P.label, lit("Invoice", "en")],
        [P.subClassOf, uri(EX + "Document", "class")],
        ["http://www.w3.org/2002/07/owl#disjointWith", uri(EX + "Receipt", "class")],
        ["http://www.w3.org/2000/01/rdf-schema#seeAlso", uri("https://example.org/spec")],
        ["http://purl.org/dc/terms/created", lit("2026-09-28", undefined, "xsd:date")],
        ["http://example.org/shop#code", lit("7", undefined, "xsd:nonNegativeInteger")],
      ]),
      "en",
      [],
    );
    expect(model.annotations.map((a) => [a.property.prefixed, a.value.kind, a.editable])).toEqual([
      ["http://www.w3.org/2000/01/rdf-schema#seeAlso", "link", true],
      ["http://purl.org/dc/terms/created", "typed", true],
      // A datatype the command layer does not offer: listed, edited in Turtle.
      ["shop:code", "typed", false],
    ]);
    expect(model.parents).toEqual([{ iri: EX + "Document", label: "Document" }]);
  });

  it("tells attributes from relationships by the kind of each property", () => {
    const model = entityModel(
      details(
        [[P.type, OWL_CLASS]],
        [
          [uri(EX + "total", "datatypeProperty"), P.domain],
          [uri(EX + "billedTo", "objectProperty"), P.domain],
          [uri(EX + "SalesInvoice", "class"), P.subClassOf],
        ],
      ),
      "en",
      [],
    );
    expect(model.attributes.map((r) => r.label)).toEqual(["total"]);
    expect(model.relationships.map((r) => r.label)).toEqual(["billedTo"]);
    expect(model.children.map((r) => r.label)).toEqual(["SalesInvoice"]);
  });

  it("reads broader from both directions of a concept's links", () => {
    const model = entityModel(
      details(
        [[P.broader, uri(EX + "Status", "concept")]],
        [[uri(EX + "Settled", "concept"), P.narrower]],
        "concept",
      ),
      "en",
      [],
    );
    expect(model.broader.map((r) => r.label)).toEqual(["Status", "Settled"]);
  });

  it("is not defined here without an rdf:type in this document", () => {
    const mentioned = entityModel(details([], [[uri(EX + "Invoice", "class"), P.subClassOf]], "other"), "en", []);
    expect(mentioned.defined).toBe(false);
    expect(mentioned.kind).toBe("class");
  });
});

describe("entityModel, found in review", () => {
  it("marks the model partial when the panel loaded only some statements", () => {
    const d = details([[P.type, OWL_CLASS]]);
    expect(entityModel(d, "en", []).partial).toBe(false);
    expect(entityModel({ ...d, incomingTotal: 501 }, "en", []).partial).toBe(true);
    expect(entityModel({ ...d, outgoingTotal: 501 }, "en", []).partial).toBe(true);
  });
});

describe("entityModel, relationships Stage B", () => {
  const OWL = "http://www.w3.org/2002/07/owl#";
  const SKOS = "http://www.w3.org/2004/02/skos/core#";

  it("reads a relationship's other way round from either side, its characteristics and its parent", () => {
    const model = entityModel(
      details(
        [
          [P.type, uri(OWL + "ObjectProperty")],
          [P.type, uri(OWL + "FunctionalProperty")],
          [P.type, uri(OWL + "TransitiveProperty")],
          [P.inverseOf, uri(EX + "employs")],
          [P.subPropertyOf, uri(EX + "memberOf")],
        ],
        [[uri(EX + "hires"), P.inverseOf]],
        "objectProperty",
      ),
      "en",
      [],
    );
    expect(model.inverses.map((r) => r.iri)).toEqual([EX + "employs", EX + "hires"]);
    expect([...model.characteristics].sort()).toEqual(["functional", "transitive"]);
    expect(model.superProperties.map((r) => r.iri)).toEqual([EX + "memberOf"]);
    // None of it is an annotation the form would list twice.
    expect(model.annotations).toEqual([]);
  });

  it("reads a concept's related concepts either way, its mappings and where it is a top concept", () => {
    const model = entityModel(
      details(
        [
          [P.type, uri(SKOS + "Concept")],
          [P.related, uri(EX + "Orchard")],
          [SKOS + "exactMatch", uri("http://dbpedia.org/resource/Apple")],
          [SKOS + "closeMatch", uri("urn:x:apple")],
          [P.topConceptOf, uri(EX + "Fruits")],
        ],
        [
          [uri(EX + "Tree"), P.related],
          [uri(EX + "Plants"), P.hasTopConcept],
        ],
        "concept",
      ),
      "en",
      [],
    );
    expect(model.related.map((r) => r.iri)).toEqual([EX + "Orchard", EX + "Tree"]);
    expect(model.mappings.map((m) => [m.kind, m.target.iri])).toEqual([
      ["exactMatch", "http://dbpedia.org/resource/Apple"],
      ["closeMatch", "urn:x:apple"],
    ]);
    expect(model.topOf.map((r) => r.iri)).toEqual([EX + "Fruits", EX + "Plants"]);
    expect(model.annotations).toEqual([]);
  });
});
