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
    attribute-reuse 5.8: from an RDFS class, the offer to make it an OWL
    class in place of a rule.

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
      "Nothing is both an Order and an Invoice (never both)",
      "An Order is the same as an Invoice (equivalent)",
      "new relationship…",
      "Every Order has at least one… (a rule)",
      "Order is related to Invoice (existing relationship)",
      "Order is placed by Invoice (existing relationship)",
      "Share belongs to: an Order belongs to an Invoice too.",
    ]);
    expect(result.choices[1]).toMatchObject({ kind: "disjoint" });
    expect(result.choices[2]).toMatchObject({ kind: "equivalent" });
    expect(result.choices[4]).toMatchObject({ kind: "rule" });
    expect(result.choices[5]).toMatchObject({ kind: "existing", setDomain: true, setRange: true });
    expect(result.choices[6]).toMatchObject({ kind: "existing", setDomain: false, setRange: true });
  });

  it("from an RDFS class, offers to make it an OWL class in place of a rule (attribute-reuse 5.8)", () => {
    const rdfs = { ...view, nodes: view.nodes.map((n) => (n.iri === "Order" ? { ...n, classType: "rdfs" as const } : n)) };
    const result = relateChoices(rdfs, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "rule")).toBe(false);
    expect(result.choices[2]).toEqual({
      kind: "makeOwl",
      label: "Rules need an OWL class; RDFS has no words for them. Make Order an OWL class",
    });
    // Only the start decides: a rule is about the class it starts at.
    const toRdfs = relateChoices(rdfs, "Inv", "Order");
    if ("refusal" in toRdfs) throw new Error(toRdfs.refusal);
    expect(toRdfs.choices.some((c) => c.kind === "rule")).toBe(true);
  });

  it("never offers to complete one already linking other classes, and says so", () => {
    const result = relateChoices(view, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "existing" && c.name === "made by")).toBe(false);
    // From Invoice Item to Document, a line from Invoice Item somewhere else.
    const away = relateChoices(view, "Item", "Doc");
    if ("refusal" in away) throw new Error(away.refusal);
    expect(away.notes).toEqual(["belongs to already links Invoice Item to Invoice; create a new relationship instead."]);
  });

  it("offers to share a relationship that ends at the same class (attribute-reuse 5.1)", () => {
    const result = relateChoices(view, "Order", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.find((c) => c.kind === "share")).toEqual({
      kind: "share",
      label: "Share belongs to: an Order belongs to an Invoice too.",
      name: "belongs to",
      property: "belongsTo",
    });
    // Not from the class it already starts at, and not offered twice.
    const shared = {
      ...view,
      edges: [
        ...view.edges,
        { kind: "relationship" as const, source: "Order", target: "Inv", property: "belongsTo", label: "belongs to", member: "Order", pair: 0, pairs: 1 },
      ],
    };
    const again = relateChoices(shared, "Order", "Inv");
    if ("refusal" in again) throw new Error(again.refusal);
    expect(again.choices.filter((c) => c.kind === "share")).toEqual([]);
    const third = relateChoices(shared, "Doc", "Inv");
    if ("refusal" in third) throw new Error(third.refusal);
    expect(third.choices.filter((c) => c.kind === "share")).toHaveLength(1);
  });

  it("never completes a relationship whose start is several classes (5.3)", () => {
    const shared = {
      ...view,
      undrawn: [
        { iri: "u", label: "audits", kind: "objectProperty", missing: "range" as const, domain: null, range: null, domains: ["Order", "Doc"] },
      ],
    };
    const fromOther = relateChoices(shared, "Item", "Inv");
    if ("refusal" in fromOther) throw new Error(fromOther.refusal);
    expect(fromOther.choices.some((c) => c.kind === "existing")).toBe(false);
    const fromMember = relateChoices(shared, "Order", "Inv");
    if ("refusal" in fromMember) throw new Error(fromMember.refusal);
    expect(fromMember.choices.find((c) => c.kind === "existing")).toMatchObject({ setDomain: false, setRange: true });
  });

  it("does not offer a subclass link that already exists", () => {
    const result = relateChoices(view, "Inv", "Doc");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "subClassOf")).toBe(false);
  });

  // --- V-8 (standard-terms 5.5): the standard axioms on the line menu ----------------

  it("offers never both and equivalent between two OWL classes (AC-8)", () => {
    const owl = {
      ...view,
      nodes: view.nodes.map((n) => (n.kind === "class" ? { ...n, classType: "owl" as const } : n)),
    };
    const result = relateChoices(owl, "Order", "Doc");
    if ("refusal" in result) throw new Error(result.refusal);
    const disjoint = result.choices.find((c) => c.kind === "disjoint");
    const equivalent = result.choices.find((c) => c.kind === "equivalent");
    expect(disjoint?.label).toBe("Nothing is both an Order and a Document (never both)");
    expect(equivalent?.label).toBe("An Order is the same as a Document (equivalent)");
    // After *is a kind of*, before *new relationship…* (5.5).
    const kinds = result.choices.map((c) => c.kind);
    expect(kinds.indexOf("disjoint")).toBe(kinds.indexOf("subClassOf") + 1);
    expect(kinds.indexOf("disjoint")).toBeLessThan(kinds.indexOf("newRelationship"));
  });

  it("offers neither between an RDFS class and another (AC-8)", () => {
    const mixed = {
      ...view,
      nodes: view.nodes.map((n) =>
        n.iri === "Order" ? { ...n, classType: "rdfs" as const } : n.kind === "class" ? { ...n, classType: "owl" as const } : n,
      ),
    };
    const fromRdfs = relateChoices(mixed, "Order", "Doc");
    if ("refusal" in fromRdfs) throw new Error(fromRdfs.refusal);
    expect(fromRdfs.choices.some((c) => c.kind === "disjoint" || c.kind === "equivalent")).toBe(false);
    // The makeOwl entry still stands in the rule's place (5.5).
    expect(fromRdfs.choices.some((c) => c.kind === "makeOwl")).toBe(true);
    // Also not when the target is the RDFS class.
    const toRdfs = relateChoices(mixed, "Doc", "Order");
    if ("refusal" in toRdfs) throw new Error(toRdfs.refusal);
    expect(toRdfs.choices.some((c) => c.kind === "disjoint" || c.kind === "equivalent")).toBe(false);
  });

  it("offers neither on a class to itself (AC-8)", () => {
    const owl = {
      ...view,
      nodes: view.nodes.map((n) => (n.kind === "class" ? { ...n, classType: "owl" as const } : n)),
    };
    const result = relateChoices(owl, "Order", "Order");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.some((c) => c.kind === "disjoint" || c.kind === "equivalent")).toBe(false);
  });

  // Concepts: Late is narrower than Paid, which is narrower than Status.
  const concepts = (...extra: CanvasView["edges"]): CanvasView => ({
    ...view,
    nodes: [...view.nodes, { iri: "Late", kind: "concept", label: "Late", fallback: false, attributes: [] }],
    edges: [...view.edges, { kind: "broader", source: "Late", target: "Paid", pair: 0, pairs: 1 }, ...extra],
  });
  const kinds = (result: ReturnType<typeof relateChoices>) => ("choices" in result ? result.choices.map((c) => c.kind) : result.refusal);

  it("offers narrower than and related to between unlinked concepts (5.8)", () => {
    const free = { ...view, edges: view.edges.filter((e) => e.kind !== "broader") };
    expect(relateChoices(free, "Status", "Paid")).toEqual({
      choices: [
        { kind: "broader", label: "Status is narrower than Paid" },
        { kind: "related", label: "Status is related to Paid" },
      ],
      notes: [],
    });
  });

  it("offers nothing the server refuses: the target already narrower than the source, directly or through others", () => {
    expect(relateChoices(concepts(), "Status", "Paid")).toEqual({ refusal: "Paid is already narrower than Status." });
    expect(relateChoices(concepts(), "Status", "Late")).toEqual({ refusal: "Late is already narrower than Status." });
  });

  it("offers only narrower than when the source is already under the target through others", () => {
    expect(kinds(relateChoices(concepts(), "Late", "Status"))).toEqual(["broader"]);
  });

  it("offers neither between two related concepts, either way round", () => {
    const related = { kind: "related" as const, source: "Late", target: "Status", pair: 0, pairs: 1 };
    const free = { ...view, edges: [related], nodes: concepts().nodes };
    const sentence = "Status is related to Late; SKOS does not allow one to be narrower than the other as well.";
    expect(relateChoices(free, "Status", "Late")).toEqual({ refusal: sentence });
    expect(kinds(relateChoices(free, "Late", "Status"))).toEqual(
      "Late is related to Status; SKOS does not allow one to be narrower than the other as well.",
    );
  });

  it("gives a loop no notes about other relationships on its box (5.10 item 4)", () => {
    const result = relateChoices(view, "Inv", "Inv");
    expect("notes" in result && result.notes).toEqual([]);
  });

  it.each([
    ["Agent", "Doc", "Agent comes from FOAF and is read-only. Draw the line from a box of this model."],
    ["Paid", "Paid", "Paid cannot be narrower than itself."],
    ["Paid", "Status", "Paid is already narrower than Status."],
  ])("refuses %s to %s with a sentence", (from, to, sentence) => {
    expect(relateChoices(view, from, to)).toEqual({ refusal: sentence });
  });

  it("offers a branch relationship between a class and a concept, class first (5.3.1)", () => {
    // Drawn either way, the one choice puts the class as the relationship's
    // start and the concept as the branch.
    for (const [from, to] of [["Inv", "Paid"], ["Paid", "Inv"]] as const) {
      const result = relateChoices(view, from, to);
      if ("refusal" in result) throw new Error(result.refusal);
      expect(result.choices).toHaveLength(1);
      const choice = result.choices[0];
      expect(choice.kind === "branch" && choice.domain).toBe("Inv");
      expect(choice.kind === "branch" && choice.branch).toBe("Paid");
      expect(choice.label).toBe("Each Invoice has a … from Paid");
    }
  });

  it("lets a line end on an imported box", () => {
    const result = relateChoices(view, "Order", "Agent");
    expect("choices" in result && result.choices[0].kind).toBe("subClassOf");
  });
});

describe("boxName", () => {
  it("reads a box as the tree reads a row", () => {
    expect(boxName(view, "Doc")).toBe("Document, OWL class, 2 subclasses");
    expect(boxName(view, "Inv")).toBe("Invoice, OWL class, kind of Document");
    expect(boxName(view, "Paid")).toBe("Paid, concept, narrower than Status");
    // An import's typing is its own: a class, named by where it is from.
    expect(boxName(view, "Agent")).toBe("Agent, class, from FOAF, read-only");
    expect(boxName({ ...view, nodes: view.nodes.map((n) => (n.iri === "Doc" ? { ...n, classType: "rdfs" as const } : n)) }, "Doc")).toBe(
      "Document, RDFS class, 2 subclasses",
    );
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
      "Invoice is related to Order (existing relationship)",
      "Invoice is made by Order (existing relationship)",
    ]);
  });

  it("links a class to itself by a relationship, never by is a kind of", () => {
    const result = relateChoices(view, "Inv", "Inv");
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.choices.map((c) => c.kind)).not.toContain("subClassOf");
    expect(result.choices[0].kind).toBe("newRelationship");
  });

  it("no longer refuses a line between boxes of the other kind (D-127)", () => {
    // A taxonomy's classes are editable: Order to Invoice offers the class lines.
    const taxonomy = relateChoices({ ...view, kind: "taxonomy" }, "Order", "Inv");
    expect("choices" in taxonomy && taxonomy.choices.some((c) => c.kind === "subClassOf")).toBe(true);
    // An ontology's concepts are editable too: no read-only sentence anywhere.
    const ontology = relateChoices({ ...view, kind: "ontology" }, "Status", "Paid");
    const refusal = "refusal" in ontology ? ontology.refusal : "";
    expect(refusal).not.toMatch(/read-only/);
  });

  it("offers each kind's own lines", () => {
    expect("choices" in relateChoices({ ...view, kind: "ontology" }, "Order", "Inv")).toBe(true);
    const free = view.edges.filter((e) => e.kind !== "broader");
    expect("choices" in relateChoices({ ...view, kind: "taxonomy", edges: free }, "Status", "Paid")).toBe(true);
  });
});
