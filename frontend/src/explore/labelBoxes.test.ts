/*
================================================================================
FILE: frontend/src/explore/labelBoxes.test.ts
================================================================================

SUMMARY
    Tests for the graph's label overlap rule (explore-and-query-layout 5.1,
    D-110): an overlapping box is refused, a touching one kept, the list
    cleared for a new frame, a link-name-only pass told apart, rotated boxes
    tested on their own sides, and Section 10's budget of 23,220 comparisons
    for 216 labels.

BASIC IDEA
    The module is pure, so every test builds boxes from numbers and asks. The
    budget is a count, not a timing, as every reducer budget on the graph is.

INPUTS / INPUT SOURCES
    - explore/labelBoxes.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 and AC-3.
================================================================================
*/

import { describe, expect, it } from "vitest";
import {
  LABEL_PADDING,
  LabelBoxes,
  boxesOverlap,
  edgeLabelBox,
  edgeLabelPlacement,
  fitEdgeLabel,
  nodeLabelBox,
  pillBox,
} from "./labelBoxes";

/** A node label box whose text starts at `x` and whose centre line is `y`. */
function at(x: number, y: number, width = 50) {
  // nodeSize 0 and the 3 px gap: the text starts at x + 3.
  return nodeLabelBox(x - 3, y, 0, 13, width);
}

describe("placing labels", () => {
  it("refuses a box overlapping one already placed", () => {
    const boxes = new LabelBoxes();
    expect(boxes.tryPlace(at(0, 0))).toBe(true);
    expect(boxes.tryPlace(at(30, 4))).toBe(false);
    expect(boxes.size).toBe(1);
  });

  it("keeps a box that only touches one already placed", () => {
    const boxes = new LabelBoxes();
    const first = at(0, 0, 50);
    expect(boxes.tryPlace(first)).toBe(true);
    // The second box's left edge is exactly the first's right edge.
    const second = at(first.maxX + LABEL_PADDING, 0, 40);
    expect(second.minX).toBe(first.maxX);
    expect(boxes.tryPlace(second)).toBe(true);
    expect(boxes.size).toBe(2);
  });

  it("keeps the padding: a box 1 px into another's padding is refused", () => {
    const boxes = new LabelBoxes();
    const first = at(0, 0, 50);
    boxes.tryPlace(first);
    expect(boxes.tryPlace(at(first.maxX + LABEL_PADDING - 1, 0, 40))).toBe(false);
  });

  it("clears the list for a new frame", () => {
    const boxes = new LabelBoxes();
    boxes.tryPlace(at(0, 0));
    boxes.clear();
    expect(boxes.size).toBe(0);
    expect(boxes.comparisons).toBe(0);
    expect(boxes.tryPlace(at(30, 4))).toBe(true);
  });

  it("a reserved box is kept clear of, whatever it overlaps", () => {
    const boxes = new LabelBoxes();
    boxes.tryPlace(at(0, 0));
    boxes.reserve(at(10, 0));
    expect(boxes.size).toBe(2);
    // Clear of the first box, inside the reserved one.
    expect(boxes.tryPlace(at(60, 0))).toBe(false);
  });
});

describe("a pass of link names on their own", () => {
  it("drops the link boxes of the pass before and keeps the node boxes", () => {
    const boxes = new LabelBoxes();
    const node = at(0, 0);
    const link = at(0, 100);
    boxes.tryPlace(node);
    boxes.beginEdgeLabel("e1");
    expect(boxes.tryPlace(link)).toBe(true);
    // Sigma's hover redraw offers e1 again with no beforeRender: without the
    // reset it would meet its own box and be refused.
    boxes.beginEdgeLabel("e1");
    expect(boxes.tryPlace(link)).toBe(true);
    // The node box is still there.
    boxes.beginEdgeLabel("e2");
    expect(boxes.tryPlace(at(20, 2))).toBe(false);
  });

  it("two different links in one pass are tested against each other", () => {
    const boxes = new LabelBoxes();
    boxes.beginEdgeLabel("e1");
    expect(boxes.tryPlace(at(0, 0))).toBe(true);
    boxes.beginEdgeLabel("e2");
    expect(boxes.tryPlace(at(10, 0))).toBe(false);
  });
});

describe("the geometry of a label", () => {
  it("a node label starts 3 px past the disc and is padded on each side", () => {
    const box = nodeLabelBox(100, 50, 8, 13, 40);
    expect(box.minX).toBe(100 + 8 + 3 - LABEL_PADDING);
    expect(box.maxX).toBe(100 + 8 + 3 + 40 + LABEL_PADDING);
    // The baseline is a third of the size below the centre.
    expect(box.minY).toBeLessThan(50);
    expect(box.maxY).toBeGreaterThan(50 + 13 / 3);
  });

  it("a pill covers the disc and the name", () => {
    const box = pillBox(100, 50, 8, 13, 40);
    expect(box.minX).toBeLessThan(100 - 8);
    expect(box.maxX).toBeGreaterThan(100 + 8 + 40);
  });

  it("a link name sits at the middle of the visible line, along it", () => {
    const flat = edgeLabelPlacement(0, 0, 5, 100, 0, 5)!;
    expect(flat.cx).toBe(50);
    expect(flat.cy).toBe(0);
    expect(flat.angle).toBeCloseTo(0);
    expect(flat.length).toBe(90);
    expect(edgeLabelPlacement(0, 0, 10, 15, 0, 10)).toBeNull();
  });

  it("a rotated link name is tested on its own sides, not its bounding rectangle", () => {
    // A link name along a 45° line: its bounding rectangle covers the corner
    // above it, where the text is not.
    const diagonal = edgeLabelBox(edgeLabelPlacement(0, 0, 0, 200, 200, 0)!, 100, 12, 1);
    const corner = nodeLabelBox(diagonal.minX - 3, diagonal.maxY - 6, 0, 13, 8);
    expect(corner.minX).toBeLessThan(diagonal.maxX);
    expect(corner.maxY).toBeGreaterThan(diagonal.minY);
    expect(boxesOverlap(diagonal, corner)).toBe(false);
    // And one on the line itself is refused.
    const onIt = nodeLabelBox(100 - 3, 100 + 12, 0, 13, 20);
    expect(boxesOverlap(diagonal, onIt)).toBe(true);
  });

  it("a link name too long for its line is cut with an ellipsis, or dropped", () => {
    const measure = (t: string) => t.length * 10;
    expect(fitEdgeLabel("range", 100, measure)).toEqual({ text: "range", width: 50 });
    expect(fitEdgeLabel("subclass of", 60, measure)!.text).toBe("subcl…");
    expect(fitEdgeLabel("subclass of", 30, measure)).toBeNull();
  });
});

describe("the budget (Section 10)", () => {
  it("216 labels need at most 23,220 comparisons and none placed overlap", () => {
    // Sigma's grid offers at most one candidate per 100 px cell: 18 × 12 cells
    // over 1,800 × 1,200 px. Each candidate is a wide name, so neighbours in a
    // row collide and about half are refused.
    const boxes = new LabelBoxes();
    const candidates = [];
    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < 18; col++) {
        candidates.push(nodeLabelBox(col * 100 + 20, row * 100 + 50, 6, 13, 120));
      }
    }
    expect(candidates).toHaveLength(216);
    const kept = candidates.filter((box) => boxes.tryPlace(box));
    expect(boxes.comparisons).toBeLessThanOrEqual(23_220);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(216);
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        expect(boxesOverlap(kept[i], kept[j])).toBe(false);
      }
    }
  });

  it("the worst case, every label fits, is exactly n(n − 1)/2", () => {
    const boxes = new LabelBoxes();
    for (let i = 0; i < 216; i++) boxes.tryPlace(at((i % 18) * 100, Math.floor(i / 18) * 100, 60));
    expect(boxes.size).toBe(216);
    expect(boxes.comparisons).toBe((216 * 215) / 2);
    expect(boxes.comparisons).toBeLessThanOrEqual(23_220);
  });
});
