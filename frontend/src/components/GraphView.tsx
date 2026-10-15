/*
================================================================================
FILE: frontend/src/components/GraphView.tsx
================================================================================

SUMMARY
    The interactive graph canvas. Builds a graphology graph from the backend's
    nodes/edges, renders it with Sigma (WebGL), runs a ForceAtlas2 force layout,
    supports drag-to-reposition with live physics, highlights hover/selection,
    dims/paints for Query mode, exports the view as PNG, and grows the drawn
    graph by merging one entity's neighbourhood into it.

BASIC IDEA
    Sigma draws the graph on a canvas; graphology holds the data and positions;
    ForceAtlas2 spreads the nodes out. For fluid motion on small/medium graphs
    the physics run synchronously once per animation frame; very large graphs
    offload the physics to a web worker to keep the UI responsive. Node/edge
    "reducers" recolour and dim nodes on the fly for hover, selection and Query
    mode without rebuilding the graph. Everything that must survive re-renders
    (the Sigma instance, the layout, timers, current selection) is kept in refs.

    An expansion is the one thing here that changes the graph without rebuilding
    it. `data` arriving anew tears the scene down and starts over, which is right
    when the ontology or the node budget changed and wrong when the user asked
    for one more entity's connections — so a neighbourhood arrives on its own
    prop, is added to the live graphology instance, and the layout then runs a
    bounded number of iterations with everything that was already drawn pinned.
    Nothing already on the canvas moves.

    Names are drawn only where they fit (D-110). Sigma chooses candidates
    through its label grid and hands each to the drawers here, which ask
    explore/labelBoxes.ts whether the name's box would overlap one already
    placed in the frame and skip it if so; `beforeRender` starts each frame
    afresh. Link names are drawn only for the hovered or selected node's links,
    which the edge reducer forces, and go through the same rule.

    Two things here are for people who are not using a mouse or who have asked
    the machine to stop moving. The container carries role="img" and a label
    saying how much of the ontology is drawn and where the keyboard route is,
    because a WebGL canvas has nothing in the accessibility tree to navigate —
    that is the accessible equivalent D-025 chose over arrow-key stepping. And
    `prefers-reduced-motion` is read once per mount and honoured in both places
    a CSS rule cannot reach: the layout is applied in one blocking pass before
    the first frame instead of animating, and every camera move takes zero
    milliseconds.

INPUTS / INPUT SOURCES (props)
    - data: the VizGraph to draw (or null for the empty state). A node
      carrying `importedFrom` is drawn smaller (external-access Stage 2).
    - theme: which colour palette to use.
    - hiddenKinds: kinds toggled off in the legend (hidden).
    - selected + focusTick: the selected node and a counter that, when bumped,
      re-centres the camera on it. `selected` is NOT guaranteed to be a node in
      this graph — see focusTarget. When it is not, the request is honoured
      later by whichever merge draws it, and not at all if none does.
    - onSelect: called with a clicked node's IRI (or null on empty click).
    - queryMode / queryPathIris / queryCandidates: Query-mode highlighting.
    - expansion: a neighbourhood to merge in, with a token that changes per
      expansion; onExpanded reports back what was actually added.
    - leftRail: the legend, docked beside the canvas (never an overlay, so it
      cannot swallow clicks meant for nodes beneath it).

EXPECTED OUTPUT
    - The rendered graph with its docked toolbar and legend; onSelect callbacks;
      onExpanded after a merge; a downloaded PNG on demand.
================================================================================
*/

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";                       // in-memory graph data structure
import { circular } from "graphology-layout";         // initial ring placement
import forceAtlas2, { inferSettings } from "graphology-layout-forceatlas2"; // sync physics
import FA2Layout from "graphology-layout-forceatlas2/worker";               // worker physics
import Sigma from "sigma";                             // WebGL renderer
import { drawDiscNodeLabel } from "sigma/rendering";   // Sigma's own label drawing
import type {
  EdgeLabelDrawingFunction,
  NodeHoverDrawingFunction,
  NodeLabelDrawingFunction,
} from "sigma/rendering";
import { downloadAsPNG } from "@sigma/export-image";   // PNG export
import type { MergeResult, Theme, VizGraph, VizNeighborhood } from "../types";
import { PALETTES, edgeColor, nodeColor } from "../types";
import {
  LabelBoxes,
  edgeLabelBox,
  edgeLabelPlacement,
  fitEdgeLabel,
  nodeLabelBox,
  pillBox,
} from "../explore/labelBoxes";

/**
 * How far outside the node the selection ring sits, and how thick it is, in the
 * same coordinate space as `data.size`. The gap is what makes it a ring around
 * the node rather than a fatter outline on it, and it is drawn outside the
 * already-enlarged selected node (the reducer adds +4 to its size), so it clears
 * a cluster of same-kind neighbours — the whole point of G-8's first half.
 */
const SELECTION_RING_GAP = 4;
const SELECTION_RING_WIDTH = 2;

/**
 * Sigma's own `drawDiscNodeHover` hard-codes the label pill to `#FFF`, while
 * the label text colour comes from `settings.labelColor`. In the dark theme
 * that is `#f2f5fa`, so the selected node's label rendered as white on white —
 * invisible, on the label of the thing the user just clicked.
 *
 * This is the same geometry with the one constant made theme-aware. It is a
 * copy rather than a wrapper because the fill happens in the middle of the
 * path-building, with no seam to hook into.
 *
 * It also draws G-8's selection ring, and this is the right place for it because
 * Sigma has no per-node border in 3.0.3 — neither node program (circle, point)
 * exposes a `borderColor`, and there is no `@sigma/node-border` in the
 * dependency tree. The alternatives the spec named were a custom WebGL node
 * program (a much larger change it told us to stop and report rather than build)
 * or this: the hover overlay, a 2D-canvas pass Sigma already runs for every
 * highlighted node, which is the same mechanism the label pill above uses. So
 * the ring costs no new dependency and no shader.
 *
 * The ring is drawn only for the SELECTED node, told apart from the merely
 * hovered one by `data.selected`. The node reducer sets that flag, and it rides
 * here through Sigma's display data: the reducer's return is stored whole in
 * `nodeDataCache` and spread into the object handed to this function, so a
 * boolean set there arrives here without a second channel. Hover and query-path
 * nodes are `highlighted` too and draw through this same function, so keying the
 * ring on `highlighted` would ring all three — the flag is what separates
 * selection from hover, which AC-2 requires.
 *
 * Version risk, stated rather than hidden: this will not track changes to
 * Sigma's own hover drawing. `defaultDrawNodeHover` is a documented setting and
 * `drawDiscNodeLabel` a public export, so the worst case is that the pill
 * geometry drifts from Sigma's — not that anything silently breaks. No test can
 * catch that.
 */
function makeDrawNodeHover(
  labelBackground: string,
  selectedRing: string,
): NodeHoverDrawingFunction {
  return function drawNodeHover(context, data, settings) {
    // The selection ring, before the pill so the pill's shadow settings below
    // cannot bleed into the stroke. Guarded on the flag the reducer sets: a
    // hovered-but-unselected node reaches here with it undefined and gets no
    // ring, which is the mark that tells the two states apart.
    if ((data as { selected?: boolean }).selected) {
      context.beginPath();
      context.arc(data.x, data.y, data.size + SELECTION_RING_GAP, 0, Math.PI * 2);
      context.closePath();
      context.lineWidth = SELECTION_RING_WIDTH;
      context.strokeStyle = selectedRing;
      context.stroke();
    }

    const size = settings.labelSize;
    const font = settings.labelFont;
    const weight = settings.labelWeight;
    context.font = `${weight} ${size}px ${font}`;

    // The one line this function exists for.
    context.fillStyle = labelBackground;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 8;
    context.shadowColor = "#000";

    const PADDING = 2;
    if (typeof data.label === "string") {
      const textWidth = context.measureText(data.label).width;
      const boxWidth = Math.round(textWidth + 5);
      const boxHeight = Math.round(size + 2 * PADDING);
      const radius = Math.max(data.size, size / 2) + PADDING;
      const angleRadian = Math.asin(boxHeight / 2 / radius);
      const xDeltaCoord = Math.sqrt(
        Math.abs(Math.pow(radius, 2) - Math.pow(boxHeight / 2, 2)),
      );
      context.beginPath();
      context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
      context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
      context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2);
      context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
      context.closePath();
      context.fill();
    } else {
      // No label: Sigma draws a plain shadowed disc instead of a pill.
      context.beginPath();
      context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
      context.closePath();
      context.fill();
    }
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;

    drawDiscNodeLabel(context, data, settings);
  };
}

/**
 * One drawing function per theme, built once at module load.
 *
 * Built here rather than inside the theme effect because that effect also runs
 * on every selection and filter change: a factory call there would allocate a
 * closure on each one. Two functions for the lifetime of the module is the
 * whole cost, and the per-frame path allocates nothing.
 */
export const NODE_HOVER_DRAWERS: Record<Theme, NodeHoverDrawingFunction> = {
  dark: makeDrawNodeHover(PALETTES.dark.labelBackground, PALETTES.dark.selectedRing),
  light: makeDrawNodeHover(PALETTES.light.labelBackground, PALETTES.light.selectedRing),
};

/** Node and link names, in pixels. Link names at 12, the smallest of the six
 *  sizes (D-110), and drawn only for the node in focus. */
const LABEL_SIZE = 13;
const EDGE_LABEL_SIZE = 12;

/** What the label drawers need from the component, read at draw time. */
interface LabelSource {
  /** The renderer, once built: null during Sigma's own first frame, which it
   *  draws inside its constructor, before there is anything to ask. */
  renderer: () => Sigma | null;
  /** The nodes drawn with a pill on the hover layer this frame. */
  pillNodes: () => Iterable<string | null>;
}

/**
 * The node and link name drawers Sigma is handed, both going through one
 * LabelBoxes (D-110), and the `beforeRender` handler that starts each frame.
 *
 * The pills come first. They are drawn on the hover layer, above everything,
 * so a name placed under one would be hidden by it and a measurement of what
 * the canvas draws would count the two as overlapping. Sigma offers names in
 * grid order and the selected node may come late, so its pill's box is
 * reserved at the first label of the frame, which is after Sigma has set the
 * frame's camera matrix — `beforeRender` is too early for that.
 *
 * Built once per renderer: the per-frame path allocates one box per name it
 * places and nothing per comparison.
 */
export function makeLabelDrawers(source: LabelSource): {
  drawNodeLabel: NodeLabelDrawingFunction;
  drawEdgeLabel: EdgeLabelDrawingFunction;
  beforeRender: () => void;
  boxes: LabelBoxes;
} {
  const boxes = new LabelBoxes();
  const pilled = new Set<string>();
  let primed = false;

  const prime = (
    context: CanvasRenderingContext2D,
    settings: Parameters<NodeLabelDrawingFunction>[2],
  ) => {
    if (primed) return;
    primed = true;
    const renderer = source.renderer();
    if (!renderer) return;
    const graph = renderer.getGraph();
    context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
    for (const node of source.pillNodes()) {
      if (!node || pilled.has(node) || !graph.hasNode(node)) continue;
      const display = renderer.getNodeDisplayData(node);
      if (!display || display.hidden || !display.label) continue;
      const at = renderer.framedGraphToViewport(display);
      const width = context.measureText(display.label).width;
      boxes.reserve(pillBox(at.x, at.y, renderer.scaleSize(display.size), settings.labelSize, width));
      pilled.add(node);
    }
  };

  const drawNodeLabel: NodeLabelDrawingFunction = (context, data, settings) => {
    if (!data.label) return;
    prime(context, settings);
    // A node with a pill keeps the place reserved for it; its name under the
    // pill is drawn as Sigma always drew it.
    const key = (data as { key?: string }).key;
    if (key === undefined || !pilled.has(key)) {
      context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
      const width = context.measureText(data.label).width;
      if (!boxes.tryPlace(nodeLabelBox(data.x, data.y, data.size, settings.labelSize, width))) return;
    }
    drawDiscNodeLabel(context, data, settings);
  };

  // Sigma's drawStraightEdgeLabel, with the box tested between working out
  // where the text goes and drawing it.
  const drawEdgeLabel: EdgeLabelDrawingFunction = (context, edgeData, sourceData, targetData, settings) => {
    prime(context, settings);
    boxes.beginEdgeLabel(String((edgeData as { key?: string }).key));
    const label = edgeData.label;
    if (!label) return;
    const placement = edgeLabelPlacement(
      sourceData.x, sourceData.y, sourceData.size,
      targetData.x, targetData.y, targetData.size,
    );
    if (!placement) return;
    const size = settings.edgeLabelSize;
    context.font = `${settings.edgeLabelWeight} ${size}px ${settings.edgeLabelFont}`;
    const fitted = fitEdgeLabel(label, placement.length, (t) => context.measureText(t).width);
    if (!fitted) return;
    if (!boxes.tryPlace(edgeLabelBox(placement, fitted.width, size, edgeData.size))) return;
    context.fillStyle = settings.edgeLabelColor.color ?? "#000";
    context.save();
    context.translate(placement.cx, placement.cy);
    context.rotate(placement.angle);
    context.fillText(fitted.text, -fitted.width / 2, edgeData.size / 2 + size);
    context.restore();
  };

  const beforeRender = () => {
    boxes.clear();
    pilled.clear();
    primed = false;
  };

  return { drawNodeLabel, drawEdgeLabel, beforeRender, boxes };
}

// Props — see the file header for the meaning of each.
interface Props {
  data: VizGraph | null;
  theme: Theme;
  hiddenKinds: Set<string>;
  selected: string | null;
  onSelect: (iri: string | null) => void;
  /** bump this counter to re-center the camera on the selected node */
  focusTick: number;
  /** Query mode paints the current path and its possible continuations. */
  queryMode?: boolean;
  queryPathIris?: Set<string>;
  queryCandidates?: { classes: Set<string>; kinds: Set<string> };
  /**
   * A neighbourhood to merge into the drawn graph, with a token that changes
   * per expansion. It is a separate prop from `data` on purpose: `data` rebuilds
   * the whole scene, which would throw away every settled position, and the one
   * thing an expansion must not do is move what the user is already looking at.
   * The token is what makes two expansions of the same entity two merges.
   */
  expansion?: { data: VizNeighborhood; token: number } | null;
  /** What the merge actually added — see MergeResult for why only this knows. */
  onExpanded?: (result: MergeResult) => void;
  /**
   * Docked beside the canvas (the legend). Rendered as a sibling rather than
   * an overlay so it can never hide or swallow clicks on nodes beneath it.
   */
  leftRail?: React.ReactNode;
}

// Graphs up to this many nodes animate with a per-frame synchronous
// ForceAtlas2 loop (fluid, WebVOWL-like). Larger graphs use the web worker.
const SYNC_LAYOUT_MAX_NODES = 3000;

/** The media query every motion decision in this file keys off. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** How long a camera move takes normally. Zero under reduced motion, which is
 *  the whole of that half: a jump rather than a tween. */
const CAMERA_DURATION_MS = 500;
const ZOOM_DURATION_MS = 200;
const FIT_DURATION_MS = 400;

/** The camera-ratio bounds Sigma is given, named once so the zoom controls can
 *  disable "+" and "−" at the exact ends Sigma clamps to. Smaller ratio is more
 *  zoomed IN, so the minimum is the fully-zoomed-in end. */
const MIN_CAMERA_RATIO = 0.01;
const MAX_CAMERA_RATIO = 20;

/**
 * The reduced-motion settle: how much layout is applied in one blocking pass,
 * instead of animating it, before the graph is first drawn.
 *
 * Bounded by time rather than by iterations because the cost per iteration is a
 * function of graph size and spans three orders of magnitude. Measured
 * 2026-07-31 on this machine with graphology-layout-forceatlas2, at roughly
 * FIBO's edge density:
 *
 *     100 nodes    600 iterations     24 ms
 *     500 nodes    600 iterations    528 ms
 *   2,000 nodes    100 iterations  1,343 ms
 *
 * So the budget buys a fully settled graph for anything a newcomer opens, and a
 * partial arrangement at the default node budget. **It is deliberately NOT the
 * total the animated path runs**: that path runs about 560 iterations over its
 * 8.5 second window, which at 2,000 nodes is eight seconds of frozen tab. The
 * specification's Section 10 asks for "the same total" and the same total is
 * not affordable on the main thread; the property that matters — the graph
 * appears arranged rather than moving — is met either way.
 */
const REDUCED_MOTION_SETTLE_MS = 1000;
const REDUCED_MOTION_MAX_ITERATIONS = 600;
/** Iterations per deadline check. Small enough that the overshoot is invisible,
 *  large enough that the clock is not read once per iteration. */
const SETTLE_CHUNK_ITERATIONS = 25;

/**
 * Whether the user has asked for reduced motion, kept current without a reload.
 *
 * One `matchMedia` call per mount, and that is a performance budget rather than
 * tidiness: the obvious shape — a `matchMedia` in the `useState` initialiser and
 * a second one in the effect — reads it twice on every graph mount. The
 * MediaQueryList is held in a ref and both the initial value and the
 * subscription come off it.
 *
 * `?.` throughout because jsdom leaves `matchMedia` undefined, which is the same
 * guard SourceView.tsx already carries for the same reason.
 */
function useReducedMotion(): boolean {
  const queryRef = useRef<MediaQueryList | null | undefined>(undefined);
  if (queryRef.current === undefined) {
    queryRef.current = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  }
  const [reduced, setReduced] = useState(() => queryRef.current?.matches ?? false);
  useEffect(() => {
    const query = queryRef.current;
    if (!query?.addEventListener) return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * How long the layout runs after a merge, over the newly added nodes only.
 *
 * Three options were weighed and this is the middle one. Running ForceAtlas2
 * over everything on every merge throws away the settled layout, which users
 * experience as the graph jumping; placing new nodes on a ring and never moving
 * them ignores the structure they just joined. Running over the new ones only
 * is both cheap and likely to look right, and the risk it carries — a new node
 * landing on top of an old one — is what these iterations resolve.
 */
const EXPAND_LAYOUT_ITERATIONS = 50;

/** How far from the entity they were expanded from new nodes start. Graph units,
 *  matching the scale `circular.assign` uses for the initial placement. */
const EXPAND_RING_RADIUS = 30;

function nodeSize(degree: number): number {
  return Math.min(16, 3 + Math.log2(degree + 1) * 2.2);
}

/** How much smaller an entity defined only in an import is drawn, with the
 *  merged view on (external-access Stage 2, AC-21). Size is the channel because
 *  the colour already says the kind, and marking by colour alone is exactly
 *  what AC-35 rules out; the detail panel and the hierarchy say it in words. */
const IMPORTED_SIZE_SCALE = 0.6;

function drawnSize(node: { degree: number; importedFrom?: string }): number {
  const size = nodeSize(node.degree);
  return node.importedFrom ? size * IMPORTED_SIZE_SCALE : size;
}

/** The key an edge is stored under. Shared by the initial build and the merge,
 *  because the merge's whole duplicate check is that these agree. */
function edgeKey(edge: { kind: string; label: string; source: string; target: string }) {
  return `${edge.kind}|${edge.label}|${edge.source}|${edge.target}`;
}

const EMPTY_SET: Set<string> = new Set();

/**
 * Which node the view dims around, or null when there is nothing to dim around.
 *
 * The selection is not always in the drawn graph, and that is not an error
 * state. Two ordinary routes produce one that is not: a term link in the detail
 * panel can select a *predicate*, which is never a graph node, and a search hit
 * outside the node budget selects an entity the budget dropped —
 * `partial-graph-rendering` stage 1 allows exactly that and marks the result
 * *not drawn*.
 *
 * Both used to reach `graph.areNeighbors(selected, node)` in the node reducer,
 * which throws `NotFoundGraphError`. Nothing caught it, so the whole
 * application went blank until the page was reloaded. Returning null instead
 * means an off-graph selection dims nothing — the graph stays as it was, which
 * is the honest picture of "the thing you selected is not on this canvas".
 *
 * The camera effect at the bottom of this file has always had the same
 * `hasNode` check. The two reducers did not, and one of them threw.
 */
function focusTarget(graph: Graph | null, node: string | null): string | null {
  if (!node || !graph || !graph.hasNode(node)) return null;
  return node;
}

export default function GraphView({
  data,
  theme,
  hiddenKinds,
  selected,
  onSelect,
  focusTick,
  queryMode = false,
  queryPathIris,
  queryCandidates,
  expansion = null,
  onExpanded,
  leftRail,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const workerLayoutRef = useRef<FA2Layout | null>(null);
  const fa2SettingsRef = useRef<Record<string, unknown>>({});
  const syncModeRef = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);
  const layoutTimer = useRef<number | undefined>(undefined);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const hiddenRef = useRef<Set<string>>(hiddenKinds);
  const paletteRef = useRef(PALETTES[theme]);
  const queryModeRef = useRef(queryMode);
  const pathRef = useRef<Set<string>>(queryPathIris ?? EMPTY_SET);
  const candidateRef = useRef(queryCandidates);
  // Held in a ref so the merge effect can depend on the token alone. As a
  // dependency the callback's identity would re-run the merge on any App
  // re-render, and a merge that runs twice reports its additions twice.
  const expandedRef = useRef(onExpanded);
  const [layoutRunning, setLayoutRunning] = useState(false);
  // How many entities are on the canvas, for the container's accessible label.
  // Held here rather than read off `data.stats`, because a merge adds nodes
  // without replacing `data` and a label that ignored expansions would tell a
  // screen reader user the opposite of what the status bar says.
  const [drawnCount, setDrawnCount] = useState(0);
  // Whether the canvas label should explain the smaller nodes. A pass over the
  // response, once per response rather than once per render.
  const hasImported = useMemo(
    () => data?.nodes.some((n) => n.importedFrom !== undefined) ?? false,
    [data],
  );
  // Which end of the zoom range the camera is at, so the matching zoom control
  // can be disabled. A three-value string rather than the raw camera ratio,
  // because the ratio changes on every animation frame and storing it would
  // re-render GraphView a dozen times per zoom press; the edge changes at most
  // once, so setState dedupes to one render — or none, mid-range. See the
  // performance budget.
  const [zoomEdge, setZoomEdge] = useState<"min" | "max" | "mid">("mid");
  // The two zoomable buttons, so focus can move to the partner when a press
  // disables the one that made it — the blur-to-body trap G-6 and
  // saved-query-deletion-warning both hit. `lastZoomPress` records which was
  // pressed, because the disable arrives asynchronously through the camera event
  // and the effect that moves focus cannot otherwise tell which control to blame.
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const lastZoomPress = useRef<"in" | "out" | null>(null);
  const zoomPressTimer = useRef<number | undefined>(undefined);

  // Record a zoom-button press, and expire the record once its animation is
  // over. The record is what lets the focus-move effect below tell a press that
  // reached an edge from an edge reached any other way — but a press that stops
  // mid-range never crosses an edge, so without the timer its record would
  // linger and a later scroll-wheel zoom to the edge would inherit it and steal
  // focus. The window is the animation's own duration, zero under reduced motion
  // plus a small margin for the settling frame.
  const armZoomPress = (dir: "in" | "out") => {
    lastZoomPress.current = dir;
    window.clearTimeout(zoomPressTimer.current);
    zoomPressTimer.current = window.setTimeout(
      () => (lastZoomPress.current = null),
      moveDuration(ZOOM_DURATION_MS) + 60,
    );
  };

  const reduceMotion = useReducedMotion();
  // In a ref as well as in a variable: the layout and camera helpers below are
  // rebuilt every render, but the ones the Sigma event handlers closed over on
  // mount are not, and a drag started next year must still read today's answer.
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  selectedRef.current = selected;
  hiddenRef.current = hiddenKinds;
  paletteRef.current = PALETTES[theme];
  queryModeRef.current = queryMode;
  pathRef.current = queryPathIris ?? EMPTY_SET;
  candidateRef.current = queryCandidates;
  expandedRef.current = onExpanded;

  /**
   * Bring one node to the middle of the view.
   *
   * Shared by the two places that need it — an explicit focus request, and a
   * merge that has just drawn the entity a focus request was made for. They
   * were one line each and drifted immediately: the second case exists because
   * the first cannot see a node that does not yet exist.
   */
  /** A camera duration, or zero when the user has asked for reduced motion.
   *  Every camera call in this file goes through it, so there is one place to
   *  read rather than five literals to keep in step. */
  const moveDuration = (ms: number) => (reduceMotionRef.current ? 0 : ms);

  const centerOn = (node: string) => {
    const renderer = sigmaRef.current;
    const display = renderer?.getNodeDisplayData(node);
    if (!renderer || !display) return;
    renderer.getCamera().animate(
      { x: display.x, y: display.y, ratio: 0.25 },
      { duration: moveDuration(CAMERA_DURATION_MS) },
    );
  };

  /**
   * Apply the layout in one blocking pass, rather than animating it.
   *
   * Chunked against a deadline instead of running a fixed count: see
   * REDUCED_MOTION_SETTLE_MS for the measurements that shape it. The first chunk
   * always runs, so even the largest graph is arranged rather than left on the
   * ring `circular.assign` placed it on.
   */
  const settleLayout = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const deadline = performance.now() + REDUCED_MOTION_SETTLE_MS;
    let done = 0;
    do {
      forceAtlas2.assign(graph, {
        iterations: SETTLE_CHUNK_ITERATIONS,
        settings: fa2SettingsRef.current,
        getEdgeWeight: "weight",
      });
      done += SETTLE_CHUNK_ITERATIONS;
    } while (done < REDUCED_MOTION_MAX_ITERATIONS && performance.now() < deadline);
  };

  const stopLayout = () => {
    window.clearTimeout(layoutTimer.current);
    if (rafRef.current !== undefined) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    workerLayoutRef.current?.stop();
    setLayoutRunning(false);
  };

  const startLayout = (durationMs?: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    window.clearTimeout(layoutTimer.current);
    // Reduced motion never animates, wherever the request came from. The one
    // route that reaches here deliberately is the toolbar's "Re-run the layout",
    // and applying it in a single pass is the right answer for that too: the
    // user asked for the graph to be untangled, not for it to be seen moving.
    if (reduceMotionRef.current) {
      settleLayout();
      sigmaRef.current?.refresh({ skipIndexation: true });
      setLayoutRunning(false);
      return;
    }
    if (syncModeRef.current) {
      if (rafRef.current === undefined) {
        const iterations = graph.order < 500 ? 3 : 1;
        const step = () => {
          forceAtlas2.assign(graph, {
            iterations,
            settings: fa2SettingsRef.current,
            getEdgeWeight: "weight",
          });
          rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
      }
    } else {
      workerLayoutRef.current?.start();
    }
    setLayoutRunning(true);
    if (durationMs !== undefined && Number.isFinite(durationMs)) {
      layoutTimer.current = window.setTimeout(stopLayout, durationMs);
    }
  };

  /** Re-seed the worker so it picks up externally changed node positions. */
  const reseedWorkerLayout = () => {
    const worker = workerLayoutRef.current;
    if (!worker) return;
    worker.stop();
    worker.start();
  };

  // (Re)build the whole scene when the dataset changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    stopLayout();
    workerLayoutRef.current?.kill();
    workerLayoutRef.current = null;
    sigmaRef.current?.kill();
    sigmaRef.current = null;
    graphRef.current = null;
    if (!data) {
      setDrawnCount(0);
      return;
    }

    const graph = new Graph({ multi: true, type: "directed" });
    for (const node of data.nodes) {
      graph.addNode(node.id, {
        label: node.label,
        kind: node.kind,
        classType: node.classType,
        size: drawnSize(node),
      });
    }
    const labelLength = new Map(data.nodes.map((n) => [n.id, n.label.length]));
    for (const edge of data.edges) {
      const key = edgeKey(edge);
      if (graph.hasEdge(key)) continue;
      // Lower weight = weaker attraction in ForceAtlas2, so nodes with long
      // names sit further apart and their labels have room to render.
      const nameSpan =
        (labelLength.get(edge.source) ?? 8) + (labelLength.get(edge.target) ?? 8);
      graph.addEdgeWithKey(key, edge.source, edge.target, {
        kind: edge.kind,
        label: edge.label || edge.kind,
        size: 1,
        type: "arrow",
        weight: 1 / Math.max(1, nameSpan / 18),
      });
    }
    circular.assign(graph, { scale: 100 });
    graphRef.current = graph;
    syncModeRef.current = graph.order <= SYNC_LAYOUT_MAX_NODES;
    fa2SettingsRef.current = {
      ...inferSettings(graph),
      adjustSizes: false,
      edgeWeightInfluence: 1,
    };
    setDrawnCount(graph.order);

    // Before Sigma exists, so the first frame it draws is the arranged graph
    // rather than the ring circular.assign left behind. Settling after the
    // construction would show that ring and then replace it, which is one
    // motion event more than a reduced-motion user asked for.
    if (reduceMotionRef.current) settleLayout();

    let built: Sigma | null = null;
    const labels = makeLabelDrawers({
      renderer: () => built,
      // The nodes the reducer marks highlighted, which the hover layer pills:
      // the path and the hovered node in Query mode, else selected and hovered.
      pillNodes: () =>
        queryModeRef.current
          ? [hoveredRef.current, ...pathRef.current]
          : [selectedRef.current, hoveredRef.current],
    });

    const renderer = new Sigma(graph, container, {
      renderEdgeLabels: graph.size <= 3000,
      labelColor: { color: paletteRef.current.label },
      edgeLabelColor: { color: paletteRef.current.edgeLabel },
      // Every node the reducer marks `highlighted` draws through this, so the
      // selected, the hovered and the query-path nodes all get the same pill —
      // and the selected one additionally its ring, which the drawer keys on the
      // `selected` flag the reducer sets.
      defaultDrawNodeHover: NODE_HOVER_DRAWERS[theme],
      // Every name goes through the one overlap rule (D-110): one already
      // placed in the frame keeps its place, and a later one that would cross
      // it is not drawn. Sigma's grid still chooses the candidates.
      defaultDrawNodeLabel: labels.drawNodeLabel,
      defaultDrawEdgeLabel: labels.drawEdgeLabel,
      labelFont: "Inter, system-ui, sans-serif",
      edgeLabelFont: "Inter, system-ui, sans-serif",
      labelWeight: "600",
      labelSize: LABEL_SIZE,
      edgeLabelSize: EDGE_LABEL_SIZE,
      labelRenderedSizeThreshold: 5,
      minCameraRatio: MIN_CAMERA_RATIO,
      maxCameraRatio: MAX_CAMERA_RATIO,
      defaultEdgeType: "arrow",
      zIndex: true,
      nodeReducer: (node, attrs) => {
        const palette = paletteRef.current;
        const res: Record<string, unknown> = {
          ...attrs,
          color: nodeColor(palette, attrs.kind as string, attrs.classType as string | undefined),
        };
        if (hiddenRef.current.has(attrs.kind as string)) {
          res.hidden = true;
          return res;
        }
        if (queryModeRef.current) {
          const hov = hoveredRef.current;
          const inPath = pathRef.current.has(node);
          const candidates = candidateRef.current;
          const isCandidate =
            !candidates ||
            candidates.classes.has(node) ||
            candidates.kinds.has(attrs.kind as string);
          if (inPath) {
            res.highlighted = true;
            res.zIndex = 3;
            res.size = (attrs.size as number) + 3;
          } else if (node === hov) {
            res.highlighted = true;
            res.zIndex = 3;
          } else if (!isCandidate) {
            res.color = palette.dimNode;
            res.label = "";
            res.zIndex = 0;
          }
          return res;
        }
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        // Only a node that is actually drawn can be dimmed around; see
        // focusTarget. The equality test below stays on the raw selection,
        // because an off-graph selection simply matches nothing.
        const focusNode = focusTarget(graphRef.current, hov ?? sel);
        // Selection and hover are separated here, where they used to share one
        // branch (G-8). The selected node grows more (+4 vs +2) and carries
        // `selected`, which is what drawNodeHover reads to draw the ring — a
        // property set on the object already being returned, so no allocation.
        // Checked before hover so a node that is both keeps the ring, which is
        // AC-2's tie-break: the ring is the distinguishing mark.
        if (node === sel) {
          res.highlighted = true;
          res.zIndex = 3;
          res.size = (attrs.size as number) + 4;
          res.selected = true;
        } else if (node === hov) {
          res.highlighted = true;
          res.zIndex = 3;
          res.size = (attrs.size as number) + 2;
        } else if (focusNode && graphRef.current) {
          const isNeighbor = graphRef.current.areNeighbors(focusNode, node);
          if (!isNeighbor) {
            res.color = palette.dimNode;
            res.label = "";
            res.zIndex = 0;
          } else {
            res.zIndex = 2;
          }
        }
        return res;
      },
      edgeReducer: (edge, attrs) => {
        const palette = paletteRef.current;
        const res: Record<string, unknown> = {
          ...attrs,
          color: edgeColor(palette, attrs.kind as string),
        };
        const g = graphRef.current;
        if (!g) return res;
        const src = g.source(edge);
        const dst = g.target(edge);
        const srcKind = g.getNodeAttribute(src, "kind") as string;
        const dstKind = g.getNodeAttribute(dst, "kind") as string;
        if (hiddenRef.current.has(srcKind) || hiddenRef.current.has(dstKind)) {
          res.hidden = true;
          return res;
        }
        if (queryModeRef.current) {
          // Match the node rule: an edge between two nodes that cannot take
          // part in the query recedes, so the steppable graph stands out.
          const candidates = candidateRef.current;
          const relevant = (node: string) => {
            if (pathRef.current.has(node)) return true;
            if (!candidates) return true;
            const kind = g.getNodeAttribute(node, "kind") as string;
            return candidates.classes.has(node) || candidates.kinds.has(kind);
          };
          if (!relevant(src) && !relevant(dst)) {
            res.color = palette.dimEdge;
            res.label = "";
            res.zIndex = 0;
          }
        }
        // Guarded for the same reason as the node reducer, and it matters even
        // though nothing here throws: without it an off-graph selection matched
        // no edge, so every edge in the graph dimmed while every node stayed
        // lit. Half a highlight is a worse picture than none.
        const focusNode = focusTarget(
          g,
          queryModeRef.current ? hoveredRef.current : hoveredRef.current ?? selectedRef.current,
        );
        // Link names only for the node in focus (D-110). Sigma would also name
        // every link whose two ends have their names drawn, which at rest put
        // small rotated words across the node names; with no focus, none.
        // `forceLabel` is what makes Sigma offer a focus link whose far end has
        // no name drawn.
        if (focusNode) {
          if (src === focusNode || dst === focusNode) {
            res.size = 2;
            res.zIndex = 2;
            res.forceLabel = true;
          } else {
            res.color = palette.dimEdge;
            res.label = "";
          }
        } else {
          res.label = "";
        }
        return res;
      },
    });

    // Sigma still emits a "click" after our prevented drag moves, so we
    // suppress the click that immediately follows a real drag gesture.
    let suppressClick = false;
    renderer.on("clickNode", ({ node }) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onSelect(node);
    });
    renderer.on("clickStage", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onSelect(null);
    });
    renderer.on("enterNode", ({ node }) => {
      hoveredRef.current = node;
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on("leaveNode", () => {
      hoveredRef.current = null;
      renderer.refresh({ skipIndexation: true });
    });

    // --- WebVOWL-style node dragging with live physics --------------------
    // The dragged node is pinned ("fixed") while ForceAtlas2 keeps running,
    // so its neighborhood elastically follows the cursor. In sync mode the
    // physics run once per animation frame, which gives fluid motion; in
    // worker mode (very large graphs) the worker is re-seeded periodically.
    let draggedNode: string | null = null;
    let dragMoved = false;
    let reheatInterval: number | undefined;

    renderer.on("downNode", (e) => {
      draggedNode = e.node;
      dragMoved = false;
      suppressClick = false;
      graph.setNodeAttribute(e.node, "fixed", true);
      window.clearTimeout(layoutTimer.current);
      // Under reduced motion the drag moves the dragged node and nothing else.
      // The elastic neighbourhood that follows the cursor is the most motion in
      // this application, and re-settling on every mousedown would be a freeze
      // per drag rather than a fluid one — see REDUCED_MOTION_SETTLE_MS.
      if (reduceMotionRef.current) return;
      startLayout(); // run until the drag ends
      if (!syncModeRef.current) {
        reseedWorkerLayout();
        window.clearInterval(reheatInterval);
        reheatInterval = window.setInterval(reseedWorkerLayout, 200);
      }
    });
    renderer.on("moveBody", ({ event }) => {
      if (!draggedNode) return;
      dragMoved = true;
      const pos = renderer.viewportToGraph(event);
      graph.setNodeAttribute(draggedNode, "x", pos.x);
      graph.setNodeAttribute(draggedNode, "y", pos.y);
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
    });
    const endDrag = () => {
      if (!draggedNode) return;
      graph.removeNodeAttribute(draggedNode, "fixed");
      draggedNode = null;
      suppressClick = dragMoved;
      window.clearInterval(reheatInterval);
      reheatInterval = undefined;
      if (reduceMotionRef.current) {
        // Nothing was running, so there is nothing to settle: the node is where
        // the user put it and the rest of the graph never moved.
        sigmaRef.current?.refresh({ skipIndexation: true });
        return;
      }
      if (!syncModeRef.current) reseedWorkerLayout();
      // Let the graph settle, then freeze it.
      startLayout(2500);
    };
    renderer.on("upNode", endDrag);
    renderer.on("upStage", endDrag);

    built = renderer;
    renderer.on("beforeRender", labels.beforeRender);
    sigmaRef.current = renderer;

    // Drive the zoom controls' disabled state from the camera. Storing the
    // derived edge rather than the ratio is what keeps this to one render per
    // press: the ratio changes every animation frame, but "min"/"max"/"mid"
    // changes at most once, so setState dedupes the frames in between away. A
    // fresh graph starts at ratio 1, mid-range, so any stale edge is cleared.
    const camera = renderer.getCamera();
    setZoomEdge("mid");
    const onCameraUpdate = (state: { ratio: number }) => {
      setZoomEdge(
        state.ratio <= MIN_CAMERA_RATIO
          ? "min"
          : state.ratio >= MAX_CAMERA_RATIO
            ? "max"
            : "mid",
      );
    };
    camera.on("updated", onCameraUpdate);

    // No worker under reduced motion: nothing would ever start it, and the
    // layout it exists to animate has already been applied above.
    if (!syncModeRef.current && !reduceMotionRef.current) {
      workerLayoutRef.current = new FA2Layout(graph, {
        settings: fa2SettingsRef.current,
        getEdgeWeight: "weight",
      });
    }
    // Run the force layout for a duration proportional to graph size.
    if (!reduceMotionRef.current) startLayout(Math.min(20000, 2500 + graph.order * 3));

    return () => {
      window.clearTimeout(layoutTimer.current);
      window.clearInterval(reheatInterval);
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
      // Before renderer.kill(): a listener left on a camera that outlives its
      // renderer is the leak the performance budget's second row exists to
      // catch, and it is invisible until several ontologies have been opened.
      camera.removeListener("updated", onCameraUpdate);
      workerLayoutRef.current?.kill();
      workerLayoutRef.current = null;
      renderer.kill();
      sigmaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Merge a neighbourhood into the graph already on screen.
  //
  // Additive and never removing, which is deliberate: an automatic eviction
  // rule would take away nodes the user was looking at. Shrinking the view is
  // done by reloading the ontology, which returns to the budgeted graph.
  //
  // Keyed on the token alone. `expansion.data` is not a dependency because a
  // second expansion of the same entity is a second merge and must run again,
  // while a re-render carrying the same object must not.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !expansion) return;
    const { nodes, edges, stats } = expansion.data;

    // Stop first. The worker respawns itself on every nodeAdded, and the
    // per-frame loop would otherwise be moving nodes while they are placed.
    stopLayout();

    // Where new nodes start: beside the entity they were expanded from, so the
    // settled view is not thrown around by nodes arriving from the origin. If
    // that entity is not itself drawn — expanding a search hit the budget
    // dropped — the graph's own centre is the honest fallback.
    let anchorX = 0;
    let anchorY = 0;
    if (graph.hasNode(stats.center)) {
      anchorX = graph.getNodeAttribute(stats.center, "x") as number;
      anchorY = graph.getNodeAttribute(stats.center, "y") as number;
    } else if (graph.order > 0) {
      let sumX = 0;
      let sumY = 0;
      graph.forEachNode((_id, attrs) => {
        sumX += attrs.x as number;
        sumY += attrs.y as number;
      });
      anchorX = sumX / graph.order;
      anchorY = sumY / graph.order;
    }

    const addedNodes: string[] = [];
    nodes.forEach((node, index) => {
      // Already drawn: leave it exactly as it is. Re-adding would throw, and
      // re-positioning would move something the user is looking at.
      if (graph.hasNode(node.id)) return;
      const angle = (2 * Math.PI * index) / Math.max(1, nodes.length);
      graph.addNode(node.id, {
        label: node.label,
        kind: node.kind,
        classType: node.classType,
        size: drawnSize(node),
        x: anchorX + Math.cos(angle) * EXPAND_RING_RADIUS,
        y: anchorY + Math.sin(angle) * EXPAND_RING_RADIUS,
      });
      addedNodes.push(node.id);
    });

    let addedEdges = 0;
    for (const edge of edges) {
      const key = edgeKey(edge);
      // The key check is the duplicate guard; the endpoint check is for an
      // edge whose ends were not both in the response, which the endpoint does
      // not produce but which would throw rather than be ignored.
      if (graph.hasEdge(key)) continue;
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      graph.addEdgeWithKey(key, edge.source, edge.target, {
        kind: edge.kind,
        label: edge.label || edge.kind,
        size: 1,
        type: "arrow",
        weight: 1,
      });
      addedEdges += 1;
    }

    if (addedNodes.length > 0) {
      // The layout runs over the new nodes ONLY, by pinning everything else:
      // ForceAtlas2 skips a node carrying `fixed`. Which nodes were pinned here
      // is recorded rather than cleared wholesale, because a node being dragged
      // carries the same attribute for its own reasons.
      const pinned: string[] = [];
      const isNew = new Set(addedNodes);
      graph.forEachNode((id, attrs) => {
        if (isNew.has(id) || attrs.fixed) return;
        graph.setNodeAttribute(id, "fixed", true);
        pinned.push(id);
      });
      forceAtlas2.assign(graph, {
        iterations: EXPAND_LAYOUT_ITERATIONS,
        settings: fa2SettingsRef.current,
        getEdgeWeight: "weight",
      });
      for (const id of pinned) graph.removeNodeAttribute(id, "fixed");
    }

    // Full indexation, not skipIndexation: the graph gained nodes and edges,
    // and Sigma's index is what maps them to what is drawn.
    sigmaRef.current?.refresh();

    // Arrive at the entity this expansion was for, if this merge is what drew
    // it. The camera effect below cannot do it: focus is requested at the
    // moment of selection, and at that moment the node does not exist, so it
    // bails on `hasNode` and the request is lost. Without this, picking an
    // entity outside the node budget draws it somewhere off screen and leaves
    // the user looking at where it was not — which is most of the difference
    // between "the result led somewhere" and "the result did nothing".
    //
    // Conditioned on the selection having just been ADDED, not merely on it
    // being drawn: growing the view from the detail panel's "Show its
    // connections" expands around an entity already centred, and re-running the
    // camera there would zoom a view the user had settled.
    const sel = selectedRef.current;
    if (sel && addedNodes.includes(sel)) centerOn(sel);

    // The label states what is on the canvas, and a merge is the one thing that
    // changes that without replacing `data`.
    setDrawnCount(graph.order);
    expandedRef.current?.({ addedNodes, addedEdges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expansion?.token]);

  // Refresh rendering when filters, selection, theme or query state change.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (!renderer) return;
    renderer.setSetting("labelColor", { color: PALETTES[theme].label });
    renderer.setSetting("edgeLabelColor", { color: PALETTES[theme].edgeLabel });
    // Swapped alongside labelColor, so a theme switch repaints the pill behind
    // an already-selected node's label without recreating the renderer or
    // needing the user to reselect.
    renderer.setSetting("defaultDrawNodeHover", NODE_HOVER_DRAWERS[theme]);
    renderer.refresh({ skipIndexation: true });
  }, [hiddenKinds, selected, theme, queryMode, queryPathIris, queryCandidates]);

  // Honour a change to the motion preference without a reload (AC-11).
  //
  // Only the ON direction does anything, and that asymmetry is deliberate:
  // switching reduced motion on has to stop what is currently animating, while
  // switching it off has nobody asking for movement — the load layout is long
  // finished and re-running it would be motion the user never requested.
  //
  // The first run is skipped by comparing against the previous value rather than
  // by a boolean flag: on mount the build effect has already settled, and a
  // second settle would double the one blocking pass this feature is allowed.
  const wasReduced = useRef(reduceMotion);
  useEffect(() => {
    if (wasReduced.current === reduceMotion) return;
    wasReduced.current = reduceMotion;
    if (!reduceMotion || !graphRef.current) return;
    stopLayout();
    settleLayout();
    sigmaRef.current?.refresh({ skipIndexation: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // Center the camera on the selected node — but only for explicit focus
  // requests (search picks, detail-panel navigation), not plain graph clicks.
  useEffect(() => {
    const sel = selectedRef.current;
    if (!focusTick || !sel || !graphRef.current?.hasNode(sel)) return;
    centerOn(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  // Move focus to the partner control when a zoom press disables the one that
  // made it. A disabled button cannot hold focus and the browser drops it to
  // <body>, which is the same trap G-6 and saved-query-deletion-warning hit — so
  // this runs after the render that disabled the button, off the edge state
  // rather than in the click handler, because the disable arrives one camera
  // event later. The edge changes at most once per press, so this runs once; the
  // intermediate "mid" updates during an animation do not re-run it, which is why
  // lastZoomPress survives to the frame that reaches the edge. Keyed on that press
  // (armed with a lifetime, see armZoomPress), so an edge reached by the scroll
  // wheel moves nobody's focus.
  useEffect(() => {
    if (zoomEdge === "min" && lastZoomPress.current === "in") {
      zoomOutRef.current?.focus();
    } else if (zoomEdge === "max" && lastZoomPress.current === "out") {
      zoomInRef.current?.focus();
    }
    lastZoomPress.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomEdge]);

  // The zoom-press timer is the one thing armZoomPress leaves running; clear it
  // on unmount so it cannot fire against a torn-down component.
  useEffect(() => () => window.clearTimeout(zoomPressTimer.current), []);

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        {data ? (
          <>
            {/* Zoom in, zoom out and Fit moved to a control docked over the
                canvas, bottom right, where a map puts them (G-5). What stays
                here acts on the GRAPH rather than the VIEW: re-running the
                layout and exporting a PNG. */}
            {/* Two quiet 28 px buttons, each an icon and a word
                (explore-and-query-layout 5.3): the word is the accessible
                name, so a screen reader and the eye read the same thing, and
                the icon is decoration. Re-running the layout is secondary: it
                runs by itself on load and while dragging. */}
            <button
              className={layoutRunning ? "small ghost active" : "small ghost"}
              onClick={() => (layoutRunning ? stopLayout() : startLayout(15000))}
              title={
                layoutRunning
                  ? "Stop the layout simulation"
                  : "Re-run the layout to untangle the graph"
              }
            >
              <span aria-hidden="true">{layoutRunning ? "⏸" : "▶"}</span>
              {layoutRunning ? "Stop layout" : "Re-run layout"}
            </button>
            <button
              className="small ghost"
              onClick={() => {
                const renderer = sigmaRef.current;
                if (!renderer) return;
                void downloadAsPNG(renderer, {
                  fileName: "ontology-graph",
                  backgroundColor: paletteRef.current.background,
                });
              }}
              title="Save the current graph view as a PNG image"
            >
              <span aria-hidden="true">⬇</span>
              Save as image
            </button>
            {/* Link names are drawn only for the node in focus (D-110), so a
                newcomer is told where they went. Text, not a tooltip. */}
            <span className="graph-toolbar-note">
              Link names show when you point at or select a node.
            </span>
          </>
        ) : (
          <span className="graph-toolbar-hint">No ontology loaded</span>
        )}
      </div>
      <div className="graph-body">
        {data ? leftRail : null}
        <div className="graph-canvas-wrap">
          {/* role="img" with a label describing what is drawn, because WebGL
              draws pixels and there is nothing in the accessibility tree to
              move between. This is the accessible EQUIVALENT the graph gets
              instead of arrow-key navigation — see D-025 — so the label ends by
              naming the route that does work. The counts are interpolated and
              nothing from the ontology is: no label, no IRI, no literal.

              Both attributes are omitted with no graph, so an unlabelled empty
              div is exposed as nothing rather than as an image of nothing. */}
          <div
            ref={containerRef}
            className="graph-container"
            role={data ? "img" : undefined}
            aria-label={
              data
                ? `Ontology graph, ${drawnCount.toLocaleString()} of ` +
                  `${data.stats.nodeTotal.toLocaleString()} entities drawn. ` +
                  (hasImported ? "Entities from imports are drawn smaller. " : "") +
                  `Use the entity list to browse.`
                : undefined
            }
          />
          {!data && (
            <div className="graph-empty">
              <p>No ontology loaded yet.</p>
              <p className="hint">
                Use “Load” to upload a file or fetch one from a URL / GitHub.
              </p>
            </div>
          )}
          {/* The zoom control, docked bottom right over the canvas (G-5). A
              sibling of .graph-container rather than a child of it, because that
              div is where Sigma mounts its canvases and manages their children;
              .graph-canvas-wrap is already position: relative, so absolute
              positioning here lands over the visible graph either way.

              Its accessible names are words, not the glyphs — "＋" announces as
              punctuation — so the glyphs carry aria-hidden and the labels do the
              naming. The group names itself so the three read as a set. */}
          {data && (
            <div className="graph-zoom" role="group" aria-label="Zoom controls">
              <button
                ref={zoomInRef}
                className="zoom-btn"
                onClick={() => {
                  armZoomPress("in");
                  sigmaRef.current
                    ?.getCamera()
                    .animatedZoom({ duration: moveDuration(ZOOM_DURATION_MS) });
                }}
                disabled={zoomEdge === "min"}
                aria-label="Zoom in"
                title={zoomEdge === "min" ? "The view is fully zoomed in." : "Zoom in"}
              >
                <span aria-hidden="true">＋</span>
              </button>
              <button
                ref={zoomOutRef}
                className="zoom-btn"
                onClick={() => {
                  armZoomPress("out");
                  sigmaRef.current
                    ?.getCamera()
                    .animatedUnzoom({ duration: moveDuration(ZOOM_DURATION_MS) });
                }}
                disabled={zoomEdge === "max"}
                aria-label="Zoom out"
                title={zoomEdge === "max" ? "The view is fully zoomed out." : "Zoom out"}
              >
                <span aria-hidden="true">－</span>
              </button>
              <button
                className="zoom-btn"
                onClick={() =>
                  sigmaRef.current
                    ?.getCamera()
                    .animatedReset({ duration: moveDuration(FIT_DURATION_MS) })
                }
                aria-label="Fit the whole graph"
                title="Zoom out to fit the whole graph"
              >
                <span aria-hidden="true">⤢</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
