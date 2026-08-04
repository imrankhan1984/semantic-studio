/*
================================================================================
FILE: frontend/src/home/miniature.test.ts
================================================================================

SUMMARY
    Tests for the two pure functions behind a home-screen card's picture: the
    thumbnail layout and the composition bar's bands.

BASIC IDEA
    No rendering, no jsdom, no DOM at all — the point of splitting these out of
    OntologyCard is that the rules can be asserted directly. What matters here
    is not that the picture looks good, which no test can see, but that it is
    *inside the box*, *the same on every render*, and *never throws* on the
    shapes a real library actually contains: a missing sketch, one entity, two
    entities on a line, an entity with no connections.

    The determinism assertion is the load-bearing one. A card whose thumbnail
    rearranged itself on every keystroke in the search box would be worse than
    no thumbnail, and the only thing stopping that is that the initial placement
    is a spiral rather than Math.random.

INPUTS / INPUT SOURCES
    - Hand-built CardSketch objects and kindCounts maps.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering the drawing half of AC-3 and AC-16.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { CARD_MINIATURE, compositionSegments, layoutSketch } from "./miniature";
import type { CardSketch } from "../types";

/** A star: one hub every spoke connects to, which is the shape a taxonomy's
 *  top concept makes and the easiest one to check by eye. */
function star(spokes: number): CardSketch {
  return {
    nodes: [
      { id: "hub", kind: "class", degree: spokes },
      ...Array.from({ length: spokes }, (_, i) => ({
        id: `n${i}`,
        kind: "concept",
        degree: 1,
      })),
    ],
    edges: Array.from({ length: spokes }, (_, i) => ({ source: "hub", target: `n${i}` })),
  };
}

describe("layoutSketch", () => {
  it("has nothing to draw without a sketch", () => {
    // AC-15. An ontology stored before the server wrote a card gets no picture,
    // and the card has to be able to ask for one and be told no.
    expect(layoutSketch(null)).toBeNull();
    expect(layoutSketch(undefined)).toBeNull();
    expect(layoutSketch({ nodes: [], edges: [] })).toBeNull();
  });

  it("places every entity and joins every edge", () => {
    const result = layoutSketch(star(6))!;
    expect(result.points).toHaveLength(7);
    expect(result.lines).toHaveLength(6);
  });

  it("keeps every dot inside the box, its radius included", () => {
    // The picture is drawn into an SVG with a fixed viewBox and no clipping, so
    // a dot outside the box is a dot drawn over the card's text.
    const result = layoutSketch(star(19))!;
    for (const point of result.points) {
      expect(point.x - point.r).toBeGreaterThanOrEqual(0);
      expect(point.x + point.r).toBeLessThanOrEqual(CARD_MINIATURE.width);
      expect(point.y - point.r).toBeGreaterThanOrEqual(0);
      expect(point.y + point.r).toBeLessThanOrEqual(CARD_MINIATURE.height);
    }
  });

  it("draws the same picture every time", () => {
    // The one assertion that would fail if the initial placement went back to
    // Math.random. App re-renders the home screen on every keystroke in the
    // search box, and a thumbnail that reshuffled on each one would be noise.
    const a = layoutSketch(star(12));
    const b = layoutSketch(star(12));
    expect(a).toEqual(b);
  });

  it("sizes dots by degree, as the canvas does", () => {
    const result = layoutSketch(star(8))!;
    const hub = result.points.find((p) => p.id === "hub")!;
    const spoke = result.points.find((p) => p.id === "n0")!;
    expect(hub.r).toBeGreaterThan(spoke.r);
  });

  it("carries the kind through, because that is what the colour comes from", () => {
    const result = layoutSketch(star(3))!;
    expect(result.points.find((p) => p.id === "hub")!.kind).toBe("class");
    expect(result.points.find((p) => p.id === "n0")!.kind).toBe("concept");
  });

  it("survives one entity, and centres it", () => {
    // A one-node span divides by zero in the fit-to-box step. Both axes
    // collapse to the middle, which is where a single dot belongs.
    const result = layoutSketch({
      nodes: [{ id: "only", kind: "ontology", degree: 0 }],
      edges: [],
    })!;
    expect(result.points).toHaveLength(1);
    expect(result.points[0].x).toBeCloseTo(CARD_MINIATURE.width / 2, 5);
    expect(result.points[0].y).toBeCloseTo(CARD_MINIATURE.height / 2, 5);
    expect(Number.isFinite(result.points[0].r)).toBe(true);
  });

  it("survives an entity with no connections at all", () => {
    // Real, not theoretical: budget_viz keeps a high-degree node whose every
    // neighbour was dropped, and at a limit of twenty that happens often.
    const result = layoutSketch({
      nodes: [
        { id: "a", kind: "class", degree: 0 },
        { id: "b", kind: "class", degree: 0 },
      ],
      edges: [],
    })!;
    expect(result.lines).toHaveLength(0);
    for (const point of result.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("ignores an edge naming an entity the sketch does not carry", () => {
    // Guards a stale metadata file rather than the normal case — the server
    // only sends edges whose both ends survived — but a line to nowhere would
    // be drawn from NaN, and NaN in an SVG attribute silently draws nothing at
    // all while the console stays quiet.
    const result = layoutSketch({
      nodes: [{ id: "a", kind: "class", degree: 1 }],
      edges: [{ source: "a", target: "gone" }],
    })!;
    expect(result.lines).toHaveLength(0);
  });

  it("ignores an edge from an entity to itself", () => {
    const result = layoutSketch({
      nodes: [
        { id: "a", kind: "class", degree: 2 },
        { id: "b", kind: "class", degree: 1 },
      ],
      edges: [
        { source: "a", target: "a" },
        { source: "a", target: "b" },
      ],
    })!;
    expect(result.lines).toHaveLength(1);
  });

  it("costs a fraction of a millisecond for a full sketch", () => {
    // AC-16's other half. This runs once per card, and a library of fifty means
    // fifty of them inside one render — so it has to be cheap enough that the
    // sub-linear budget is about React rather than about this.
    const sketch = star(19);
    layoutSketch(sketch); // discard the warm-up: the first pass carries the JIT

    const runs = 50;
    const start = performance.now();
    for (let i = 0; i < runs; i++) layoutSketch(sketch);
    const each = (performance.now() - start) / runs;

    expect(each, `layoutSketch took ${each.toFixed(3)} ms`).toBeLessThan(2);
  });
});

describe("compositionSegments", () => {
  it("has no bands without counts", () => {
    expect(compositionSegments(null)).toEqual([]);
    expect(compositionSegments(undefined)).toEqual([]);
    expect(compositionSegments({})).toEqual([]);
    expect(compositionSegments({ class: 0 })).toEqual([]);
  });

  it("orders bands largest first and shares out the whole", () => {
    const segments = compositionSegments({ class: 30, individual: 60, concept: 10 });

    expect(segments.map((s) => s.kind)).toEqual(["individual", "class", "concept"]);
    expect(segments.map((s) => s.percent)).toEqual([60, 30, 10]);
    expect(segments.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100, 6);
  });

  it("breaks a tie by kind name, so the bar does not reorder between loads", () => {
    // The object's key order comes from JSON. Two kinds with the same count
    // would otherwise swap places depending on how the server serialised it.
    const forwards = compositionSegments({ concept: 5, class: 5 });
    const backwards = compositionSegments({ class: 5, concept: 5 });
    expect(forwards.map((s) => s.kind)).toEqual(["class", "concept"]);
    expect(backwards.map((s) => s.kind)).toEqual(["class", "concept"]);
  });

  it("labels a band from KIND_LABELS and never from the ontology", () => {
    // The same rule describeContents holds: nothing in the interface is
    // interpolated from a kind string an uploaded file could choose.
    const segments = compositionSegments({ objectProperty: 3, "<script>": 1 });
    expect(segments.map((s) => s.label)).toEqual(["Object property", "Other"]);
  });

  it("drops a kind with no entities rather than drawing a zero-width band", () => {
    const segments = compositionSegments({ class: 4, concept: 0 });
    expect(segments).toHaveLength(1);
    expect(segments[0].percent).toBe(100);
  });
});
