/*
================================================================================
FILE: frontend/src/canvas/curves.test.ts
================================================================================

SUMMARY
    Lines that stay readable (relationships 5.4, AC-5): several lines
    between two boxes spread evenly about the straight line, a pair in both
    directions bent to opposite sides, labels apart from each other, and
    loops on one box nested rather than stacked.

BASIC IDEA
    Pure geometry on fixed points, as the component tests stub React Flow's
    edges.

INPUTS / INPUT SOURCES
    - canvas/curves.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { loopCurve, pairCurve, PAIR_SPACING, spread } from "./curves";

describe("curves", () => {
  it("spreads several lines evenly about the straight line", () => {
    expect(spread(0, 1)).toBe(0);
    expect([spread(0, 2), spread(1, 2)]).toEqual([-PAIR_SPACING / 2, PAIR_SPACING / 2]);
    expect([spread(0, 3), spread(1, 3), spread(2, 3)]).toEqual([-PAIR_SPACING, 0, PAIR_SPACING]);
  });

  it("bends works for and employs to opposite sides, in one frame", () => {
    // Person at (0, 0), Organization at (200, 0): works for runs forward,
    // employs back, first and second of the pair.
    const worksFor = pairCurve(0, 0, 200, 0, 0, 2, true);
    const employs = pairCurve(200, 0, 0, 0, 1, 2, false);
    expect(Math.sign(worksFor.labelY)).toBe(-Math.sign(employs.labelY));
    expect(Math.abs(worksFor.labelY - employs.labelY)).toBeGreaterThanOrEqual(PAIR_SPACING - 1);
  });

  it("keeps labels apart along a vertical pair, where names are wide", () => {
    const a = pairCurve(0, 0, 0, 300, 0, 2, true);
    const b = pairCurve(0, 0, 0, 300, 1, 2, true);
    // Side by side is not enough for two names; they are also slid along.
    expect(Math.abs(a.labelY - b.labelY)).toBeGreaterThan(30);
  });

  it("a single line stays on the straight line", () => {
    const one = pairCurve(0, 0, 200, 0, 0, 1, true);
    expect([one.labelX, one.labelY]).toEqual([100, 0]);
  });

  it("draws a loop out of the right side and back, the next one outside it", () => {
    const first = loopCurve(190, 40, 0);
    const second = loopCurve(190, 40, 1);
    expect(first.path.startsWith("M 190,30")).toBe(true);
    expect(first.path.endsWith("190,50")).toBe(true);
    expect(first.labelX).toBeGreaterThan(190);
    expect(second.labelX).toBeGreaterThan(first.labelX + 20);
    expect(first.labelY).toBe(40);
  });
});
