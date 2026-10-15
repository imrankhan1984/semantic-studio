/*
================================================================================
FILE: frontend/src/explore/labelBoxes.ts
================================================================================

SUMMARY
    The one place the graph's label overlap rule is written (D-110): a label
    whose box would overlap a label already placed in the frame is skipped.
    Holds the boxes placed in the current frame, the test between two boxes,
    and the geometry of the three kinds of label Sigma draws: a node's name, the
    pill behind a hovered or selected node's name, and a link's name rotated
    along its line. Draws nothing.

BASIC IDEA
    Sigma 3.0.3 already thins labels through a grid, keeping the largest node of
    each 100 px cell, but a 13 px name is often wider than a cell, so names in
    neighbouring cells still collide. Sigma offers no hook between choosing and
    drawing, so the rule runs inside the drawing functions GraphView hands it:
    each one asks `tryPlace` before it draws, and skips its label on a refusal.
    Labels are placed in the order Sigma offers them; first come keeps its place.

    A box is a convex quadrilateral (four corners) with its axis-aligned bounds.
    Node names and pills are axis-aligned; a link name is rotated, and testing
    its bounding rectangle instead would refuse link names that do not touch
    anything, so two rotated boxes are separated by the separating-axis test.
    Boxes that only touch are not overlapping: a label may sit flush against
    another.

    The list is cleared on Sigma's `beforeRender`. One pass needs more than
    that: on a hover Sigma redraws the link names on their own (its
    `scheduleHighlightedNodesRender`), with no `beforeRender`, and every link
    name would then meet its own box from the pass before and be refused. A
    link name seen twice since the last clear is how that second pass is told
    apart, and it drops the link boxes while keeping the node boxes, which the
    node labels on screen still occupy.

    The cost is the count Section 10 budgets: each candidate is compared with
    the boxes already placed, n(n − 1)/2 for n candidates at most, and
    `comparisons` counts them so a test can hold the bound. Nothing is
    allocated per comparison.

INPUTS / INPUT SOURCES
    - Viewport coordinates, sizes and measured text widths, from the drawing
      functions in GraphView.tsx. No DOM, no canvas, no Sigma.

EXPECTED OUTPUT
    - LabelBoxes: clear, tryPlace, reserve, beginEdgeLabel and the comparison
      count.
    - nodeLabelBox, pillBox, edgeLabelPlacement, edgeLabelBox, fitEdgeLabel:
      the box a label will occupy, or where a link name goes and what of it fits.
================================================================================
*/

/** Space kept clear around every label, on each side, in pixels. */
export const LABEL_PADDING = 2;

/** Sigma's gap between a node's disc and the start of its name. */
const NODE_LABEL_GAP = 3;

/** Where text sits around its baseline, as fractions of the font size: the
 *  em box Inter fills, above and below. Sigma draws a node's name with its
 *  baseline a third of the size below the node's centre. */
const ASCENT = 0.8;
const DESCENT = 0.2;

export interface LabelBox {
  /** Corners in drawing order, x then y. */
  xs: [number, number, number, number];
  ys: [number, number, number, number];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Whether the edges are the axes, so the bounds are the box. */
  aligned: boolean;
}

function rect(left: number, top: number, right: number, bottom: number): LabelBox {
  return {
    xs: [left, right, right, left],
    ys: [top, top, bottom, bottom],
    minX: left,
    minY: top,
    maxX: right,
    maxY: bottom,
    aligned: true,
  };
}

/** The box of a node's name as Sigma's `drawDiscNodeLabel` draws it. */
export function nodeLabelBox(
  x: number,
  y: number,
  nodeSize: number,
  labelSize: number,
  textWidth: number,
): LabelBox {
  const left = x + nodeSize + NODE_LABEL_GAP;
  const baseline = y + labelSize / 3;
  return rect(
    left - LABEL_PADDING,
    baseline - labelSize * ASCENT - LABEL_PADDING,
    left + textWidth + LABEL_PADDING,
    baseline + labelSize * DESCENT + LABEL_PADDING,
  );
}

/** The box of the pill GraphView's hover drawing puts behind a hovered or
 *  selected node's name, the disc included: the same numbers as that drawing. */
export function pillBox(
  x: number,
  y: number,
  nodeSize: number,
  labelSize: number,
  textWidth: number,
): LabelBox {
  const radius = Math.max(nodeSize, labelSize / 2) + LABEL_PADDING;
  const half = Math.round(labelSize + 2 * LABEL_PADDING) / 2;
  return rect(
    x - radius - LABEL_PADDING,
    y - Math.max(half, radius) - LABEL_PADDING,
    x + radius + Math.round(textWidth + 5) + LABEL_PADDING,
    y + Math.max(half, radius) + LABEL_PADDING,
  );
}

export interface EdgeLabelPlacement {
  /** The middle of the visible part of the line. */
  cx: number;
  cy: number;
  /** The rotation Sigma gives the text, in radians. */
  angle: number;
  /** How long the visible part of the line is: the most text it can carry. */
  length: number;
}

/**
 * Where a link name goes: Sigma's `drawStraightEdgeLabel` arithmetic, so the
 * box tested is where the text lands. Null when the two discs touch and there
 * is no line to write on.
 */
export function edgeLabelPlacement(
  sx: number,
  sy: number,
  sSize: number,
  tx: number,
  ty: number,
  tSize: number,
): EdgeLabelPlacement | null {
  let dx = tx - sx;
  let dy = ty - sy;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < sSize + tSize) return null;
  const x0 = sx + (dx * sSize) / d;
  const y0 = sy + (dy * sSize) / d;
  const x1 = tx - (dx * tSize) / d;
  const y1 = ty - (dy * tSize) / d;
  dx = x1 - x0;
  dy = y1 - y0;
  d = Math.sqrt(dx * dx + dy * dy);
  let angle: number;
  if (dx > 0) angle = dy > 0 ? Math.acos(dx / d) : Math.asin(dy / d);
  else angle = dy > 0 ? Math.acos(dx / d) + Math.PI : Math.asin(dx / d) + Math.PI / 2;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, angle, length: d };
}

/**
 * What of a link name fits on its line, Sigma's ellipsis rule: the whole name,
 * or as much as fits with "…", or null when fewer than four characters would
 * be left. `measure` is the canvas's `measureText(...).width`.
 */
export function fitEdgeLabel(
  label: string,
  length: number,
  measure: (text: string) => number,
): { text: string; width: number } | null {
  let width = measure(label);
  if (width <= length) return { text: label, width };
  let text = label + "…";
  width = measure(text);
  while (width > length && text.length > 1) {
    text = text.slice(0, -2) + "…";
    width = measure(text);
  }
  if (text.length < 4) return null;
  return { text, width };
}

/** The box of a link name drawn at `placement`: the text centred on the line's
 *  middle, its baseline `edgeSize / 2 + labelSize` below the line, rotated. */
export function edgeLabelBox(
  placement: EdgeLabelPlacement,
  textWidth: number,
  labelSize: number,
  edgeSize: number,
): LabelBox {
  const baseline = edgeSize / 2 + labelSize;
  const left = -textWidth / 2 - LABEL_PADDING;
  const right = textWidth / 2 + LABEL_PADDING;
  const top = baseline - labelSize * ASCENT - LABEL_PADDING;
  const bottom = baseline + labelSize * DESCENT + LABEL_PADDING;
  const cos = Math.cos(placement.angle);
  const sin = Math.sin(placement.angle);
  const lx = [left, right, right, left];
  const ly = [top, top, bottom, bottom];
  const xs = [0, 0, 0, 0] as LabelBox["xs"];
  const ys = [0, 0, 0, 0] as LabelBox["ys"];
  for (let i = 0; i < 4; i++) {
    xs[i] = placement.cx + lx[i] * cos - ly[i] * sin;
    ys[i] = placement.cy + lx[i] * sin + ly[i] * cos;
  }
  return {
    xs,
    ys,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    aligned: false,
  };
}

/** Whether one of `a`'s two edge directions separates the two boxes. Touching
 *  projections separate: flush labels do not overlap. */
function separatedOnAxesOf(a: LabelBox, b: LabelBox): boolean {
  for (let i = 0; i < 2; i++) {
    // The normal of edge i (corners i and i + 1); a rectangle's other two edges
    // are parallel to these.
    const nx = a.ys[i + 1] - a.ys[i];
    const ny = a.xs[i] - a.xs[i + 1];
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let k = 0; k < 4; k++) {
      const pa = a.xs[k] * nx + a.ys[k] * ny;
      const pb = b.xs[k] * nx + b.ys[k] * ny;
      if (pa < minA) minA = pa;
      if (pa > maxA) maxA = pa;
      if (pb < minB) minB = pb;
      if (pb > maxB) maxB = pb;
    }
    if (maxA <= minB || maxB <= minA) return true;
  }
  return false;
}

/** Whether two label boxes share any area. */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  // The bounds first: most pairs on a graph are far apart, and for two
  // axis-aligned boxes the bounds are the whole answer.
  if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) return false;
  if (a.aligned && b.aligned) return true;
  return !separatedOnAxesOf(a, b) && !separatedOnAxesOf(b, a);
}

/** The labels placed in one frame. */
export class LabelBoxes {
  private placed: LabelBox[] = [];
  /** Where the link names start in `placed`, or -1 before the first. */
  private edgeStart = -1;
  private seenEdges = new Set<string>();
  /** Box comparisons since the last clear: Section 10's budget. */
  comparisons = 0;

  /** A new frame: Sigma's `beforeRender`. */
  clear(): void {
    this.placed.length = 0;
    this.edgeStart = -1;
    this.seenEdges.clear();
    this.comparisons = 0;
  }

  /** How many labels hold a place. */
  get size(): number {
    return this.placed.length;
  }

  /** Place `box` if it overlaps nothing already placed; whether it was. */
  tryPlace(box: LabelBox): boolean {
    const placed = this.placed;
    for (let i = 0; i < placed.length; i++) {
      this.comparisons += 1;
      if (boxesOverlap(box, placed[i])) return false;
    }
    placed.push(box);
    return true;
  }

  /** Place `box` whatever it overlaps: a label drawn regardless, the hovered
   *  or selected node's pill, which the others must then keep clear of. */
  reserve(box: LabelBox): void {
    this.placed.push(box);
  }

  /**
   * Called for every link name Sigma offers, before it is tested. A link seen
   * twice since the last clear means Sigma has started a pass of link names
   * on their own (see the header): the link boxes of the pass before go, the
   * node boxes stay.
   */
  beginEdgeLabel(key: string): void {
    if (this.edgeStart < 0) {
      this.edgeStart = this.placed.length;
    } else if (this.seenEdges.has(key)) {
      this.placed.length = this.edgeStart;
      this.seenEdges.clear();
    }
    this.seenEdges.add(key);
  }
}
