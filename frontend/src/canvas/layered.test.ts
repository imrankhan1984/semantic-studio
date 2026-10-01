/*
================================================================================
FILE: frontend/src/canvas/layered.test.ts
================================================================================

SUMMARY
    The canvas's first placement (visual-modeling 5.5, AC-12): roots above
    children, no two boxes overlapping, the same layout for the same model, a
    cycle that does not loop, imported boxes at the edge, new boxes below
    their parent, and the Section 10 budget of 300 boxes in 30 ms.

BASIC IDEA
    Pure function tests. The budget is a median of seven after a warm-up, as
    CLAUDE.md asks of a frontend timing, and takes BUDGET_FACTOR.

INPUTS / INPUT SOURCES
    - canvas/layered.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { limitMs } from "../budget";
import { BOX_HEIGHT, BOX_WIDTH, freeSpot, layered, placeMissing, type Box, type Link } from "./layered";

const box = (iri: string, imported = false): Box => ({ iri, label: iri, imported });

function noOverlap(positions: Record<string, [number, number]>) {
  const all = Object.entries(positions);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [, a] = all[i];
      const [, b] = all[j];
      const apart = Math.abs(a[0] - b[0]) >= BOX_WIDTH || Math.abs(a[1] - b[1]) >= BOX_HEIGHT;
      expect(apart, `${all[i][0]} and ${all[j][0]} overlap`).toBe(true);
    }
  }
}

/** A binary tree of n boxes, the shape of a real class hierarchy at scale. */
function tree(n: number): { boxes: Box[]; links: Link[] } {
  const boxes = Array.from({ length: n }, (_, i) => box(`C${i}`));
  const links = boxes.slice(1).map((_, k) => ({ child: `C${k + 1}`, parent: `C${Math.floor(k / 2)}` }));
  return { boxes, links };
}

describe("layered", () => {
  it("puts roots above their children, and children above theirs", () => {
    const p = layered([box("Doc"), box("Invoice"), box("Sales")], [
      { child: "Invoice", parent: "Doc" },
      { child: "Sales", parent: "Invoice" },
    ]);
    expect(p.Doc[1]).toBeLessThan(p.Invoice[1]);
    expect(p.Invoice[1]).toBeLessThan(p.Sales[1]);
  });

  it("places a box one level below its deepest parent", () => {
    const p = layered([box("A"), box("B"), box("C")], [
      { child: "B", parent: "A" },
      { child: "C", parent: "A" },
      { child: "C", parent: "B" },
    ]);
    expect(p.C[1]).toBeGreaterThan(p.B[1]);
  });

  it("never overlaps two boxes, and is the same for the same input", () => {
    const { boxes, links } = tree(60);
    const first = layered(boxes, links);
    noOverlap(first);
    expect(layered([...boxes].reverse(), [...links].reverse())).toEqual(first);
  });

  it("does not loop on a cycle in malformed data", () => {
    const p = layered([box("A"), box("B")], [
      { child: "A", parent: "B" },
      { child: "B", parent: "A" },
    ]);
    expect(Object.keys(p).sort()).toEqual(["A", "B"]);
  });

  it("puts imported boxes at the edge of their level", () => {
    const p = layered([box("Agent", true), box("Thing"), box("Zebra")], []);
    expect(p.Agent[0]).toBeGreaterThan(p.Zebra[0]);
    expect(p.Agent[0]).toBeGreaterThan(p.Thing[0]);
  });
});

describe("placeMissing", () => {
  it("keeps saved positions and puts a new box below its parent", () => {
    const saved = { Doc: [500, 40] as [number, number] };
    const p = placeMissing([box("Doc"), box("Invoice")], [{ child: "Invoice", parent: "Doc" }], saved);
    expect(p.Doc).toEqual([500, 40]);
    expect(p.Invoice[0]).toBe(500);
    expect(p.Invoice[1]).toBeGreaterThan(40);
  });

  it("steps right past a box already below the parent", () => {
    const saved = { Doc: [0, 0] as [number, number], Old: [0, 170] as [number, number] };
    const p = placeMissing(
      [box("Doc"), box("Old"), box("New")],
      [{ child: "Old", parent: "Doc" }, { child: "New", parent: "Doc" }],
      saved,
    );
    noOverlap(p);
    expect(p.New[1]).toBe(170);
  });

  it("puts a box with no placed parent below everything", () => {
    const p = placeMissing([box("A"), box("B")], [], { A: [0, 300] });
    expect(p.B[1]).toBeGreaterThan(300);
  });

  it("[budget] lays out 300 boxes within 30 ms", () => {
    const { boxes, links } = tree(300);
    layered(boxes, links); // warm-up
    const samples = Array.from({ length: 7 }, () => {
      const start = performance.now();
      layered(boxes, links);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    const median = samples[3];
    expect(median, `median ${median.toFixed(2)} ms`).toBeLessThan(limitMs(30));
  });
});

describe("freeSpot (relationships 5.10 item 3)", () => {
  const overlaps = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < BOX_WIDTH && Math.abs(a[1] - b[1]) < BOX_HEIGHT;

  it("centres the box on the middle of the view when it is free", () => {
    expect(freeSpot([500, 300], [])).toEqual([500 - BOX_WIDTH / 2, 300 - BOX_HEIGHT / 2]);
  });

  it("never lands on a box already in the middle", () => {
    const middle: [number, number] = [500 - BOX_WIDTH / 2, 300 - BOX_HEIGHT / 2];
    const spot = freeSpot([500, 300], [{ at: middle }]);
    expect(overlaps(spot, middle)).toBe(false);
    // The nearest free place: one step off the middle, not somewhere far.
    expect(Math.hypot(spot[0] - middle[0], spot[1] - middle[1])).toBeLessThan(BOX_WIDTH * 1.5);
  });

  it("finds free space among many boxes, and chooses the same place every time", () => {
    const taken = [];
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) taken.push({ at: [i * 200, j * 100] as [number, number] });
    const spot = freeSpot([0, 0], taken);
    for (const t of taken) expect(overlaps(spot, t.at)).toBe(false);
    expect(freeSpot([0, 0], taken)).toEqual(spot);
  });

  it("respects a box taller than the default, one with attributes", () => {
    const tall = { at: [500 - BOX_WIDTH / 2, 300 - BOX_HEIGHT / 2 - 150] as [number, number], height: 400 };
    const spot = freeSpot([500, 300], [tall]);
    const clear =
      spot[0] + BOX_WIDTH <= tall.at[0] || tall.at[0] + BOX_WIDTH <= spot[0] || spot[1] >= tall.at[1] + 400 || spot[1] + BOX_HEIGHT <= tall.at[1];
    expect(clear).toBe(true);
  });
});
