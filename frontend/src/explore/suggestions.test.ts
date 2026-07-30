/*
================================================================================
FILE: frontend/src/explore/suggestions.test.ts
================================================================================

SUMMARY
    Tests for the two pure functions behind Explore mode's starting panel: the
    degree ranking with its per-kind spread rule, and the summary sentence. No
    rendering, no jsdom, no server.

BASIC IDEA
    Both functions are functions of a VizGraph, so every case is a constructed
    graph and an assertion on the return value. That is the point of the split
    from ExploreStart.tsx: the piece most likely to be wrong is the spread rule,
    and it can be tested exhaustively without a DOM.

    Two rows here are budgets rather than behaviour, and one is a security
    assertion. The security one is worth stating plainly: the summary sentence is
    built by interpolation, and the only safe interpolation is one where nothing
    from the ontology can reach the string. The test gives an ontology hostile
    labels AND a kind key it invented, and asserts neither appears.

INPUTS / INPUT SOURCES
    - Constructed VizGraph objects, including a generated 40,000-node one.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-2 to AC-8, AC-13 and AC-14 of
      explore-mode-starting-point.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { describeContents, suggestedEntities } from "./suggestions";
import type { VizGraph, VizNode } from "../types";

/** A graph carrying the given nodes; kindCounts derived so it stays consistent. */
function graphOf(nodes: VizNode[], kindCounts?: Record<string, number>): VizGraph {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  return {
    nodes,
    edges: [],
    stats: {
      nodeCount: nodes.length,
      edgeCount: 0,
      nodeTotal: nodes.length,
      edgeTotal: 0,
      truncated: false,
      budget: 2000,
      kindCounts: kindCounts ?? counts,
    },
  };
}

/** A graph with kind counts only, for the summary sentence. */
function statsOnly(kindCounts: Record<string, number>): VizGraph {
  return graphOf([], kindCounts);
}

function node(id: string, kind: string, degree: number): VizNode {
  return { id, label: id, kind, degree };
}

/** `count` nodes of one kind with descending degrees, ids in load order. */
function run(kind: string, count: number, topDegree: number): VizNode[] {
  return Array.from({ length: count }, (_, i) => node(`${kind}-${i}`, kind, topDegree - i));
}

describe("suggestedEntities", () => {
  it("ranks by degree descending", () => {
    // AC-3. Deliberately given out of order, and of one kind so the spread rule
    // cannot be what produces the answer.
    const result = suggestedEntities(
      graphOf([node("a", "class", 3), node("b", "class", 99), node("c", "class", 40)]),
    );
    expect(result.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("takes at most three from any one kind", () => {
    // AC-4. The eight highest degrees are all individuals, and there are enough
    // other kinds to fill the panel, so exactly three individuals may appear.
    // Without the ceiling this returns eight individuals and a learner never
    // learns the ontology has classes at all.
    const graph = graphOf([
      ...run("individual", 8, 500),
      ...run("class", 4, 100),
      ...run("objectProperty", 4, 50),
    ]);
    const result = suggestedEntities(graph);

    expect(result).toHaveLength(8);
    expect(result.filter((n) => n.kind === "individual")).toHaveLength(3);
    // And it is the three highest-degree individuals, not any three.
    expect(result.filter((n) => n.kind === "individual").map((n) => n.id)).toEqual([
      "individual-0",
      "individual-1",
      "individual-2",
    ]);
    // Three kinds reached the panel, which is what the rule is for.
    expect(new Set(result.map((n) => n.kind)).size).toBe(3);
  });

  it("fills remaining slots from the overall ranking", () => {
    // AC-4's second half. Two kinds cannot fill eight slots at three each, so
    // the ceiling is relaxed rather than the panel being left short. This is
    // also the "every node the same kind" edge case in the general form.
    const graph = graphOf([...run("class", 10, 900), ...run("individual", 2, 5)]);
    const result = suggestedEntities(graph);

    expect(result).toHaveLength(8);
    // Both individuals fit under the ceiling; the other six slots go to classes.
    expect(result.filter((n) => n.kind === "individual")).toHaveLength(2);
    expect(result.filter((n) => n.kind === "class")).toHaveLength(6);
    // The fill takes the next highest classes, and the whole list still descends
    // by degree rather than showing the ceiling's picks first.
    expect(result.map((n) => n.degree)).toEqual([900, 899, 898, 897, 896, 895, 5, 4]);
  });

  it("excludes ontology header nodes", () => {
    // AC-5. The header is the file's own metadata declaration and is often the
    // highest-degree node in the graph, which is exactly why it needs excluding.
    const graph = graphOf([
      node("http://example.org/ont", "ontology", 9999),
      node("Person", "class", 12),
    ]);
    const result = suggestedEntities(graph);

    expect(result.map((n) => n.id)).toEqual(["Person"]);
  });

  it("breaks ties by id so the list is stable", () => {
    // AC-6. Every degree is equal, so the id tiebreak decides the whole list.
    // Called twice on separately-built but identical graphs, because a rule that
    // depends on input order would pass a single call.
    const ids = ["delta", "alpha", "charlie", "bravo"];
    const build = () => graphOf(ids.map((id) => node(id, "class", 7)));

    const first = suggestedEntities(build());
    const second = suggestedEntities(build());

    expect(first.map((n) => n.id)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(second.map((n) => n.id)).toEqual(first.map((n) => n.id));
  });

  it("returns every node when there are fewer than the limit", () => {
    // AC-7. A tiny ontology shows what it has, without padding or throwing.
    const graph = graphOf([node("a", "class", 2), node("b", "individual", 1)]);
    expect(suggestedEntities(graph).map((n) => n.id)).toEqual(["a", "b"]);
    // And the one-node ontology from the edge-case table.
    expect(suggestedEntities(graphOf([node("only", "class", 0)]))).toHaveLength(1);
  });

  it("does not reorder the graph it was given", () => {
    // The ranking sorts, and the array it sorts must not be the response's own:
    // App holds that object and GraphView, the legend and the search box all
    // read it. `filter` before `sort` is what keeps them separate, and dropping
    // the filter would silently reorder the graph on every load.
    const nodes = [node("a", "class", 1), node("b", "class", 99)];
    const graph = graphOf(nodes);
    suggestedEntities(graph);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for an empty graph", () => {
    // AC-8. Reachable with a file of nothing but blank nodes.
    expect(suggestedEntities(graphOf([]))).toEqual([]);
  });

  it("returns an empty list for a null graph", () => {
    // AC-8. App passes null while the graph loads and after it fails.
    expect(suggestedEntities(null)).toEqual([]);
  });
});

describe("describeContents", () => {
  it("describes the three largest kinds with counts", () => {
    // AC-2. The sentence from the specification, digit separators included: a
    // learner scans "1,104", not "1104".
    const sentence = describeContents(
      statsOnly({ class: 412, objectProperty: 58, individual: 1104 }),
    );
    expect(sentence).toBe(
      "This ontology describes 1,104 individuals, 412 classes and 58 object properties.",
    );
  });

  it("names at most three kinds", () => {
    // AC-2. Eleven kinds are possible and a sentence naming all of them is one
    // nobody reads. The legend beside it carries the full breakdown.
    const sentence = describeContents(
      statsOnly({
        class: 50,
        objectProperty: 40,
        datatypeProperty: 30,
        annotationProperty: 20,
        individual: 10,
        ontology: 1,
      }),
    );
    expect(sentence).toBe(
      "This ontology describes 50 classes, 40 object properties and 30 datatype properties.",
    );
    expect(sentence).not.toContain("annotation");
    // Two separators for three items, so nothing was silently dropped from the
    // middle of the list.
    expect(sentence.split(",")).toHaveLength(2);
  });

  it("pluralises kind names correctly", () => {
    // AC-2. Three shapes English gets wrong if you only append an s: a label
    // ending in s, one ending in y, and a count of one.
    expect(describeContents(statsOnly({ class: 2 }))).toBe("This ontology describes 2 classes.");
    expect(describeContents(statsOnly({ objectProperty: 2 }))).toBe(
      "This ontology describes 2 object properties.",
    );
    expect(describeContents(statsOnly({ class: 1 }))).toBe("This ontology describes 1 class.");
    // A leading acronym is not a capitalised word: "skos concepts" is wrong in a
    // way a learner would notice, so the lowercasing has to skip it.
    expect(describeContents(statsOnly({ concept: 30 }))).toBe(
      "This ontology describes 30 SKOS concepts.",
    );
    // Two kinds read "a and b", with no comma.
    expect(describeContents(statsOnly({ class: 3, individual: 2 }))).toBe(
      "This ontology describes 3 classes and 2 individuals.",
    );
  });

  it("says an ontology has no entities when it has none", () => {
    // AC-8. Three ways to get here: no kinds at all, kinds that all count zero,
    // and no graph. None of them may produce "This ontology describes ."
    const expected = "This ontology has no entities to display.";
    expect(describeContents(statsOnly({}))).toBe(expected);
    expect(describeContents(statsOnly({ class: 0 }))).toBe(expected);
    expect(describeContents(null)).toBe(expected);
  });

  it("contains no ontology-derived text", () => {
    // AC-14. The sentence is built by interpolation, so the only thing that
    // makes it safe is that nothing from the file can reach it. The ontology
    // here supplies hostile labels AND invents a kind key, which is the case a
    // naive implementation gets wrong: printing the kind string would put
    // attacker-chosen text in the sentence.
    const hostile = "<img src=x onerror=alert(1)>";
    const graph = graphOf(
      [node(hostile, hostile, 5)],
      { [hostile]: 5, "«evil kind»": 3, class: 1 },
    );

    const sentence = describeContents(graph);

    expect(sentence).not.toContain(hostile);
    expect(sentence).not.toContain("evil");
    expect(sentence).not.toContain("<");
    // Unrecognised kinds fall back to the constant rather than being printed.
    expect(sentence).toBe("This ontology describes 5 others, 3 others and 1 class.");
  });
});

describe("suggestion budgets", () => {
  /**
   * 40,000 nodes across all eleven kinds with varied degrees — the largest
   * response measured in this project, generated rather than held as a JSON
   * fixture. A file of this graph is about 5 MB and the generator is eight
   * lines; both keep the backend out of the vitest run, which is what the test
   * plan asks for.
   *
   * Degrees descend with the index and kinds cycle, so the per-kind ceiling and
   * the fill pass both run — a uniform-degree fixture would make the id tiebreak
   * decide everything and time a different algorithm than the real one. That
   * trap is recorded in D-017.
   */
  function largeGraph(): VizGraph {
    const kinds = Object.keys({
      class: 0,
      objectProperty: 0,
      datatypeProperty: 0,
      annotationProperty: 0,
      property: 0,
      concept: 0,
      conceptScheme: 0,
      collection: 0,
      individual: 0,
      ontology: 0,
      other: 0,
    });
    const nodes: VizNode[] = Array.from({ length: 40000 }, (_, i) => ({
      id: `http://example.org/e${i}`,
      label: `Entity ${i}`,
      kind: kinds[i % kinds.length],
      degree: 40000 - i,
    }));
    return graphOf(nodes);
  }

  it("ranks forty thousand nodes within budget", () => {
    // AC-13. 20 ms. The number matters because this runs on every graph load,
    // and the memoization test in ExploreStart.test.tsx is what stops it running
    // on every render.
    const graph = largeGraph();
    suggestedEntities(graph); // warm-up: a first call also pays module init

    const started = performance.now();
    const result = suggestedEntities(graph);
    const elapsed = performance.now() - started;

    expect(result).toHaveLength(8);
    // Asserted so a "fast" run that returned nothing cannot pass the budget.
    expect(result[0].degree).toBe(40000);
    expect(elapsed).toBeLessThan(20);
  });

  it("describes contents within budget", () => {
    // AC-13. 1 ms over eleven kinds. Trivial, and asserted anyway: this runs in
    // the same render as the ranking.
    const graph = largeGraph();
    describeContents(graph);

    const started = performance.now();
    const sentence = describeContents(graph);
    const elapsed = performance.now() - started;

    expect(sentence).toContain("This ontology describes");
    expect(elapsed).toBeLessThan(1);
  });
});
