/*
================================================================================
FILE: frontend/src/canvas/relate.test.ts
================================================================================

SUMMARY
    The relate menu's rule (visual-modeling 5.4, AC-12) and a box's accessible
    name: class to class, concept to concept, class and concept refused, an
    imported start refused, existing relationships offered only to complete
    them, and the note for one that already links other classes.

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
  total: 6,
  limited: false,
  layout: { version: 1, positions: {}, shown: null, viewport: null },
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
    { kind: "subClassOf", source: "Inv", target: "Doc" },
    { kind: "subClassOf", source: "Item", target: "Doc" },
    { kind: "relationship", source: "Item", target: "Inv", property: "belongsTo", label: "belongs to" },
    { kind: "broader", source: "Paid", target: "Status" },
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
      "is a kind of",
      "new relationship…",
      "related to",
      "placed by",
    ]);
    expect(result.choices[2]).toMatchObject({ kind: "existing", setDomain: true, setRange: true });
    expect(result.choices[3]).toMatchObject({ kind: "existing", setDomain: false, setRange: true });
  });

  it("never offers one already linking other classes, and says so", () => {
    const result = relateChoices(view, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.label === "made by")).toBe(false);
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
    expect(result).toEqual({ choices: [{ kind: "broader", label: "narrower than" }], notes: [] });
  });

  it.each([
    ["Inv", "Paid", "A class and a concept cannot be linked here. Use the form for other annotations."],
    ["Agent", "Doc", "Agent comes from FOAF and is read-only. Draw the line from a box of this model."],
    ["Inv", "Inv", "A box cannot be linked to itself."],
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
    expect(result.choices.some((c) => c.label === "either")).toBe(false);
  });
});
