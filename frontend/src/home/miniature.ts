/*
================================================================================
FILE: frontend/src/home/miniature.ts
================================================================================

SUMMARY
    The two pure functions behind a home-screen card's picture of an ontology:
    where the twenty sketched entities sit in a tiny box, and how the ontology's
    composition divides a thin stacked bar. Neither renders anything.

BASIC IDEA
    Six cards of identical grey text differ only by the words on them. Six cards
    each showing the shape of its own graph are told apart before they are read,
    and the shape is true rather than decorative — it is drawn from the sketch
    the server computed with the same degree ranking the canvas uses, in the
    same kind colours the canvas and the legend use.

    **No Sigma, and no WebGL.** A browser caps the number of live WebGL contexts
    at somewhere around sixteen, and a library of twenty ontologies would ask
    for twenty. Twenty nodes also do not need ForceAtlas2: this is
    Fruchterman-Reingold over at most twenty points, which costs a few hundred
    microseconds and produces a picture that responds to structure — a hub with
    spokes looks like a hub, a chain looks like a chain, a dense ontology looks
    dense.

    **It is deterministic.** The initial placement is a golden-angle spiral by
    rank, never Math.random, so the same ontology draws the same picture on every
    render. A card whose thumbnail rearranged itself on each keystroke in the
    search box would be worse than no thumbnail.

    Split out of the component for the reason sparql/ and explore/ exist: the
    rule is testable without rendering, and the cost is measurable without
    measuring jsdom.

INPUTS / INPUT SOURCES
    - A CardSketch from the ontology summary, or null for anything stored before
      the server wrote one.
    - A kindCounts map from the same summary.
    Nothing else: no requests, no DOM, no globals.

EXPECTED OUTPUT
    - layoutSketch -> points and lines in the requested box, or null when there
      is nothing to draw.
    - compositionSegments -> one segment per kind present, largest first, each
      carrying its share of the whole as a percentage.
================================================================================
*/

import type { CardSketch } from "../types";
import { KIND_LABELS } from "../types";

/**
 * The box each layout draws into, in its own units. The SVG scales these with a
 * viewBox, so they are not pixels — but their *aspect ratio* is load-bearing.
 *
 * `preserveAspectRatio` letterboxes a viewBox that does not match its container,
 * and the first version used one 120x70 box for both layouts: in a card's
 * 320x76 strip that put the whole picture in a 130px column down the middle,
 * with 60% of the card's width empty. Measured in Chrome. So the card's box is
 * a wide strip and the row's is the square its 44px glyph actually occupies.
 */
export const CARD_MINIATURE = { width: 260, height: 70 };
export const ROW_MINIATURE = { width: 70, height: 70 };

/** Dot radii, smallest to largest by degree. Small enough that twenty of them
 *  are separate dots rather than a blob. */
const MIN_RADIUS = 1.6;
const MAX_RADIUS = 4.2;

/** Keeps the outermost dot's edge inside the box. */
const PADDING = MAX_RADIUS + 1;

/** Iterations of the spring layout. Measured over 20 nodes: 60 iterations is
 *  about 0.1 ms, and past roughly 40 the picture stops visibly changing. */
const ITERATIONS = 60;

/** The golden angle in radians, which is what makes the initial spiral spread
 *  evenly rather than falling into arms — the same reason sunflowers use it. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface MiniaturePoint {
  id: string;
  kind: string;
  x: number;
  y: number;
  r: number;
}

export interface MiniatureLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Miniature {
  points: MiniaturePoint[];
  lines: MiniatureLine[];
}

/**
 * Where the sketch's entities sit, and which of them are joined.
 *
 * Returns null rather than an empty picture when there is nothing to draw, so a
 * caller can tell "no sketch stored" from "a sketch with no entities" only by
 * not getting a picture in either case — which is right, because the card's
 * answer to both is the same: show the counts and the verbs, and no thumbnail.
 */
export function layoutSketch(
  sketch: CardSketch | null | undefined,
  width = CARD_MINIATURE.width,
  height = CARD_MINIATURE.height,
): Miniature | null {
  if (!sketch || sketch.nodes.length === 0) return null;

  const nodes = sketch.nodes;
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));

  // Initial placement: a golden-angle spiral, ordered by the ranking the server
  // already applied. Deterministic, and spread enough that the first repulsion
  // pass has real distances to work with — every node at the origin would give
  // the force calculation nothing but division by zero.
  //
  // Stretched to the target box's aspect from the start, because the fit at the
  // end scales both axes by the SAME factor. Fitting them independently was the
  // first version and it visibly flattened the picture: a roughly round cloud
  // normalised into a 260x70 strip came out as a horizontal smear with the
  // structure squeezed out of it. Measured in Chrome on the space ontology.
  const aspect = width / height;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const radius = Math.sqrt((i + 0.5) / n);
    const angle = i * GOLDEN_ANGLE;
    xs[i] = aspect * radius * Math.cos(angle);
    ys[i] = radius * Math.sin(angle);
  }

  // Edges as index pairs, dropping anything naming an entity the sketch does
  // not carry. The server only sends edges whose both ends survived, so this
  // guards a stale or hand-written metadata file rather than the normal case.
  const links: [number, number][] = [];
  for (const edge of sketch.edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }

  // Fruchterman-Reingold: every pair pushes apart, every edge pulls together,
  // and the step size cools linearly so the last iterations settle rather than
  // oscillate. `k` is the ideal edge length for n points spread over the target
  // rectangle, whose area is `aspect` in these units.
  const k = Math.sqrt(aspect / n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let step = 0; step < ITERATIONS; step++) {
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ox = xs[i] - xs[j];
        let oy = ys[i] - ys[j];
        let distance = Math.hypot(ox, oy);
        // Two nodes exactly on top of each other have no direction to separate
        // along. Nudge them apart deterministically — by index, never randomly,
        // or the picture would differ between renders.
        if (distance < 1e-6) {
          ox = (i - j) * 1e-3;
          oy = 1e-3;
          distance = Math.hypot(ox, oy);
        }
        const force = (k * k) / distance;
        const fx = (ox / distance) * force;
        const fy = (oy / distance) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    for (const [a, b] of links) {
      const ox = xs[a] - xs[b];
      const oy = ys[a] - ys[b];
      const distance = Math.max(Math.hypot(ox, oy), 1e-6);
      const force = (distance * distance) / k;
      const fx = (ox / distance) * force;
      const fy = (oy / distance) * force;
      dx[a] -= fx;
      dy[a] -= fy;
      dx[b] += fx;
      dy[b] += fy;
    }

    const temperature = 0.1 * (1 - step / ITERATIONS);
    for (let i = 0; i < n; i++) {
      const magnitude = Math.max(Math.hypot(dx[i], dy[i]), 1e-6);
      const scale = Math.min(magnitude, temperature) / magnitude;
      xs[i] += dx[i] * scale;
      ys[i] += dy[i] * scale;
    }
  }

  // Fit whatever the layout produced to the box. Scaling from the actual extent
  // rather than from an assumed one is what makes a two-node sketch fill the
  // card instead of sitting as two dots in the middle.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const usableWidth = width - PADDING * 2;
  const usableHeight = height - PADDING * 2;
  // ONE scale for both axes, so the picture keeps its shape. A degenerate span
  // — one node, or a perfect vertical line — contributes no constraint rather
  // than dividing by zero, and collapses to the centre of that axis, which is
  // what it looks like.
  const scale = Math.min(
    spanX < 1e-9 ? Infinity : usableWidth / spanX,
    spanY < 1e-9 ? Infinity : usableHeight / spanY,
  );
  // Both spans degenerate means a single point; anything else has a real scale.
  const factor = Number.isFinite(scale) ? scale : 1;
  // Centred in whatever the shape-preserving scale left over.
  const offsetX = PADDING + (usableWidth - spanX * factor) / 2;
  const offsetY = PADDING + (usableHeight - spanY * factor) / 2;

  // Degree drives the dot size, exactly as it drives node size on the canvas.
  // The scale is over the sketch's own range rather than the ontology's: these
  // twenty are the highest-degree twenty, and a global scale would draw them
  // all at the maximum.
  let maxDegree = 0;
  for (const node of nodes) if (node.degree > maxDegree) maxDegree = node.degree;

  const points: MiniaturePoint[] = nodes.map((node, i) => ({
    id: node.id,
    kind: node.kind,
    x: offsetX + (xs[i] - minX) * factor,
    y: offsetY + (ys[i] - minY) * factor,
    r:
      maxDegree === 0
        ? MIN_RADIUS
        : MIN_RADIUS + (node.degree / maxDegree) * (MAX_RADIUS - MIN_RADIUS),
  }));

  const lines: MiniatureLine[] = links.map(([a, b]) => ({
    x1: points[a].x,
    y1: points[a].y,
    x2: points[b].x,
    y2: points[b].y,
  }));

  return { points, lines };
}

/** One band of the composition bar. `label` comes from KIND_LABELS and never
 *  from the ontology, for the reason describeContents states: an unrecognised
 *  kind falls back rather than being printed. */
export interface CompositionSegment {
  kind: string;
  label: string;
  count: number;
  /** Share of the whole, 0 to 100. */
  percent: number;
}

/**
 * The stacked bar's bands, largest first.
 *
 * "132,001 triples" tells a learner nothing. A bar segmented by entity kind in
 * the legend's own colours says at a glance whether this is an OWL ontology, a
 * SKOS taxonomy, or a pile of individuals — and it teaches the colour language
 * before the canvas has to.
 *
 * The order is by count and then by kind name, the same tiebreak
 * describeContents uses, because the object's key order comes from JSON and is
 * not something to rely on for something that must not change between two loads
 * of the same file.
 */
export function compositionSegments(
  counts: Record<string, number> | null | undefined,
): CompositionSegment[] {
  if (!counts) return [];
  const present = Object.entries(counts).filter(([, count]) => count > 0);
  const total = present.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return [];

  return present
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({
      kind,
      label: KIND_LABELS[kind] ?? KIND_LABELS.other,
      count,
      percent: (count / total) * 100,
    }));
}
