/*
================================================================================
FILE: frontend/src/canvas/curves.ts
================================================================================

SUMMARY
    Where a canvas line runs and where its label sits (relationships 5.4):
    one line between two boxes as React Flow's curve, several between the
    same two boxes spread into separate curves, and a line from a box to
    itself as a loop on the box's right side.

BASIC IDEA
    The server numbers the lines that share two boxes (`pair` of `pairs`,
    canvas.py), in either direction. Each gets an offset from the straight
    line, spread evenly about it, and the offset is taken across the pair's
    own direction -- from the smaller IRI to the larger -- so *works for*
    (Person to Organization) and *employs* (Organization to Person) bend to
    opposite sides instead of the same one.

    A label sits on its curve, not on the straight line, and is also moved
    along it by its place, so labels on a pair drawn one above the other
    (the normal across a vertical line is horizontal, and names are wide)
    still do not cover each other.

    A loop leaves the box's right side near its top and comes back into its
    top edge, so it stands above the corner rather than across the lines to
    other boxes. Loops grow with their place: the second loop on a box is
    drawn outside the first, with its label further out.

    Pure geometry, so it is tested without React Flow, whose edges the
    component tests stub.

INPUTS / INPUT SOURCES
    - The two ends React Flow computed, the line's place, and for a loop
      the box's right edge and top.

EXPECTED OUTPUT
    - { path, labelX, labelY }: an SVG path and the label's centre.
================================================================================
*/

/** Space between neighbouring curves of one pair, at their middle. */
export const PAIR_SPACING = 44;
/** How far a first loop reaches out from the box, and each next one more. */
const LOOP_REACH = 70;
const LOOP_STEP = 36;

export interface Curve {
  path: string;
  labelX: number;
  labelY: number;
}

/** The offset of a line's middle from the straight line: 0 for a single
 *  line, and spread evenly about it for several. */
export function spread(pair: number, pairs: number): number {
  return (pair - (pairs - 1) / 2) * PAIR_SPACING;
}

/**
 * A curve between two different boxes, as a quadratic Bézier whose control
 * point is pushed across the line. `forward` says the line runs in the
 * pair's own direction (source IRI before target IRI); a line against it
 * turns its normal round so both directions share one frame.
 */
export function pairCurve(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  pair: number,
  pairs: number,
  forward: boolean,
): Curve {
  const dx = tx - sx;
  const dy = ty - sy;
  const length = Math.hypot(dx, dy) || 1;
  const sign = forward ? 1 : -1;
  // The unit normal, in the pair's frame.
  const nx = (-dy / length) * sign;
  const ny = (dx / length) * sign;
  const offset = spread(pair, pairs);
  // A quadratic's middle is half-way to its control point, so twice the
  // offset puts the curve's middle where the spread says.
  const cx = (sx + tx) / 2 + nx * offset * 2;
  const cy = (sy + ty) / 2 + ny * offset * 2;
  // The label slides along the curve by its place as well (see the header).
  const t = pairs > 1 ? 0.5 + ((pair - (pairs - 1) / 2) / pairs) * 0.3 * sign : 0.5;
  const u = 1 - t;
  return {
    path: `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`,
    labelX: u * u * sx + 2 * u * t * cx + t * t * tx,
    labelY: u * u * sy + 2 * u * t * cy + t * t * ty,
  };
}

/** A loop from a box's right side back into its top, the `pair`-th on that
 *  box: out of the upper right corner, clear of the lines that leave the
 *  middle of that side for other boxes (found in the browser pass, where a
 *  loop on the middle of the side sat on top of them and a click on it
 *  landed on theirs). */
export function loopCurve(right: number, top: number, pair: number): Curve {
  const reach = LOOP_REACH + pair * LOOP_STEP;
  const startY = top + 14;
  const endX = right - 30;
  return {
    path: `M ${right},${startY} C ${right + reach},${startY} ${endX},${top - reach} ${endX},${top}`,
    // Near the curve's farthest point, up and out from the corner.
    labelX: right + reach * 0.4,
    labelY: top - reach * 0.45,
  };
}
