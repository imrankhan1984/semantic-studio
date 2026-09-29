/*
================================================================================
FILE: frontend/src/canvas/relate.test.ts
================================================================================

SUMMARY
    The relate menu's rule (visual-modeling 5.4, AC-12) and a box's accessible
    name: class to class, concept to concept, class and concept refused, an
    imported start refused, existing relationships offered only to complete
    them, and the note for one that already links other classes. Since
    relationships Stage A: each choice labelled by its sentence, the other
    direction asked by swapping the ends, a class linked to itself by a
    relationship only, and the other kind's boxes refused by the kind.

BASIC IDEA
    A hand-built canvas view, as the server returns it.

INPUTS / INPUT SOURCES
    - canvas/relate.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { CanvasView } from "../types";
import { boxName, relateChoices } from "./relate";

const view: CanvasView = {
  revision: 1,
  kind: null,
  total: 6,
  limited: false,
  layout: { version: 1, generation: 0, positions: {}, shown: null, viewport: null },
  nodes: [
    { iri: "Doc", kind: "class", label: "Document", fallback: false, attributes: [] },
    { iri: "Inv", kind: "class", label: "Invoice", fallback: false, attributes: [] },
    { iri: "Item", kind: "class", label: "Invoice Item", fallback: false, attributes: [] },
    { iri: "Order", kind: "class", label: "Order", fallback: false, attributes: [] },
    { iri: "Agent", kind: "class", label: "Agent", fallback: false, imported: "FOAF", attributes: [] },
    { iri: "Paid", kind: "concept", label: "Paid", fallback: false, attributes: [] },
    { iri: "Status", kind: "concept", label: "Status", fallback: false, attributes: [] },
  ],
  edges: [
    { kind: "subClassOf", source: "Inv", target: "Doc", pair: 0, pairs: 1 },
    { kind: "subClassOf", source: "Item", target: "Doc", pair: 0, pairs: 1 },
    { kind: "relationship", source: "Item", target: "Inv", property: "belongsTo", label: "belongs to", pair: 0, pairs: 1 },
    { kind: "broader", source: "Paid", target: "Status", pair: 0, pairs: 1 },
  ],
  undrawn: [
    { iri: "free", label: "related to", kind: "objectProperty", missing: "both", domain: null, range: null },
    { iri: "half", label: "placed by", kind: "objectProperty", missing: "range", domain: "Order", range: null },
    { iri: "other", label: "made by", kind: "objectProperty", missing: "range", domain: "Inv", range: null },
  ],
};

describe("relateChoices", () => {
  it("offers is a kind of, a new relationship and the ones it would complete", () => {
    const result = relateChoices(view, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.map((c) => c.label)).toEqual([
      "Order is a kind of Invoice",
      "new relationship…",
      "Order related to Invoice (existing relationship)",
      "Order placed by Invoice (existing relationship)",
    ]);
    expect(result.choices[2]).toMatchObject({ kind: "existing", setDomain: true, setRange: true });
    expect(result.choices[3]).toMatchObject({ kind: "existing", setDomain: false, setRange: true });
  });

  it("never offers one already linking other classes, and says so", () => {
    const result = relateChoices(view, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "existing" && c.name === "made by")).toBe(false);
    expect(result.notes).toEqual([
      "belongs to already links Invoice Item to Invoice; create a new relationship instead.",
    ]);
  });

  it("does not offer a subclass link that already exists", () => {
    const result = relateChoices(view, "Inv", "Doc");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices[0].kind).toBe("newRelationship");
  });

  it("offers narrower than between concepts", () => {
    const result = relateChoices(view, "Status", "Paid");
    expect(result).toEqual({ choices: [{ kind: "broader", label: "Status is narrower than Paid" }], notes: [] });
  });

  it.each([
    ["Inv", "Paid", "A class and a concept cannot be linked here. Use the form for other annotations."],
    ["Agent", "Doc", "Agent comes from FOAF and is read-only. Draw the line from a box of this model."],
    ["Paid", "Paid", "Paid cannot be narrower than itself."],
    ["Paid", "Status", "Paid is already narrower than Status."],
  ])("refuses %s to %s with a sentence", (from, to, sentence) => {
    expect(relateChoices(view, from, to)).toEqual({ refusal: sentence });
  });

  it("lets a line end on an imported box", () => {
    const result = relateChoices(view, "Order", "Agent");
    expect("choices" in result && result.choices[0].kind).toBe("subClassOf");
  });
});

describe("boxName", () => {
  it("reads a box as the tree reads a row", () => {
    expect(boxName(view, "Doc")).toBe("Document, class, 2 subclasses");
    expect(boxName(view, "Inv")).toBe("Invoice, class, kind of Document");
    expect(boxName(view, "Paid")).toBe("Paid, concept, narrower than Status");
    expect(boxName(view, "Agent")).toBe("Agent, class, from FOAF, read-only");
  });
});

describe("relateChoices, found in review", () => {
  it("never offers to complete a relationship whose end is an expression", () => {
    const withExpression: CanvasView = {
      ...view,
      undrawn: [{ iri: "either", label: "either", kind: "objectProperty", missing: "expression", domain: null, range: null }],
    };
    const result = relateChoices(withExpression, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "existing" && c.name === "either")).toBe(false);
  });
});

describe("relateChoices, relationships Stage A", () => {
  it("asked the other way round, reads the other way round (the menu's Swap)", () => {
    const there = relateChoices(view, "Order", "Inv");
    const back = relateChoices(view, "Inv", "Order");
    if ("refusal" in there || "refusal" in back) throw new Error("refused");
    expect(there.choices[0].label).toBe("Order is a kind of Invoice");
    expect(back.choices[0].label).toBe("Invoice is a kind of Order");
    // What the line would complete follows the direction too: *placed by*
    // starts at Order, so it fits only there; *made by* starts at Invoice.
    expect(back.choices.filter((c) => c.kind === "existing").map((c) => c.label)).toEqual([
      "Invoice related to Order (existing relationship)",
      "Invoice made by Order (existing relationship)",
    ]);
  });

  it("links a class to itself by a relationship, never by is a kind of", () => {
    const result = relateChoices(view, "Inv", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.map((c) => c.kind)).not.toContain("subClassOf");
    expect(result.choices[0].kind).toBe("newRelationship");
  });

  it.each([
    ["ontology", "Paid", "Status", "Paid is a SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy."],
    ["taxonomy", "Inv", "Doc", "Invoice is a class, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology."],
  ] as const)("in an %s, refuses a line between boxes of the other kind", (kind, from, to, sentence) => {
    expect(relateChoices({ ...view, kind }, from, to)).toEqual({ refusal: sentence });
  });

  it("offers each kind's own lines", () => {
    expect("choices" in relateChoices({ ...view, kind: "ontology" }, "Order", "Inv")).toBe(true);
    expect("choices" in relateChoices({ ...view, kind: "taxonomy" }, "Status", "Paid")).toBe(true);
  });
});
