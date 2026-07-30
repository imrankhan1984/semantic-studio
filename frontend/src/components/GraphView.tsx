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

INPUTS / INPUT SOURCES (props)
    - data: the VizGraph to draw (or null for the empty state).
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
import { useEffect, useRef, useState } from "react";
import Graph from "graphology";                       // in-memory graph data structure
import { circular } from "graphology-layout";         // initial ring placement
import forceAtlas2, { inferSettings } from "graphology-layout-forceatlas2"; // sync physics
import FA2Layout from "graphology-layout-forceatlas2/worker";               // worker physics
import Sigma from "sigma";                             // WebGL renderer
import { drawDiscNodeLabel } from "sigma/rendering";   // Sigma's own label drawing
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import { downloadAsPNG } from "@sigma/export-image";   // PNG export
import type { MergeResult, Theme, VizGraph, VizNeighborhood } from "../types";
import { PALETTES } from "../types";

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
 * Version risk, stated rather than hidden: this will not track changes to
 * Sigma's own hover drawing. `defaultDrawNodeHover` is a documented setting and
 * `drawDiscNodeLabel` a public export, so the worst case is that the pill
 * geometry drifts from Sigma's — not that anything silently breaks. No test can
 * catch that.
 */
function makeDrawNodeHover(labelBackground: string): NodeHoverDrawingFunction {
  return function drawNodeHover(context, data, settings) {
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
  dark: makeDrawNodeHover(PALETTES.dark.labelBackground),
  light: makeDrawNodeHover(PALETTES.light.labelBackground),
};

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
  const centerOn = (node: string) => {
    const renderer = sigmaRef.current;
    const display = renderer?.getNodeDisplayData(node);
    if (!renderer || !display) return;
    renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.25 }, { duration: 500 });
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
    if (!data) return;

    const graph = new Graph({ multi: true, type: "directed" });
    for (const node of data.nodes) {
      graph.addNode(node.id, {
        label: node.label,
        kind: node.kind,
        size: nodeSize(node.degree),
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

    const renderer = new Sigma(graph, container, {
      renderEdgeLabels: graph.size <= 3000,
      labelColor: { color: paletteRef.current.label },
      edgeLabelColor: { color: paletteRef.current.edgeLabel },
      // Every node the reducer marks `highlighted` draws through this, so the
      // selected, the hovered and the query-path nodes all get the same pill.
      defaultDrawNodeHover: NODE_HOVER_DRAWERS[theme],
      labelFont: "Inter, system-ui, sans-serif",
      edgeLabelFont: "Inter, system-ui, sans-serif",
      labelWeight: "600",
      labelSize: 13,
      edgeLabelSize: 10,
      labelRenderedSizeThreshold: 5,
      minCameraRatio: 0.01,
      maxCameraRatio: 20,
      defaultEdgeType: "arrow",
      zIndex: true,
      nodeReducer: (node, attrs) => {
        const palette = paletteRef.current;
        const res: Record<string, unknown> = {
          ...attrs,
          color: palette.kind[attrs.kind as string] ?? palette.kind.other,
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
        if (node === sel || node === hov) {
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
          color: palette.edge[attrs.kind as string] ?? palette.defaultEdge,
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
        if (focusNode) {
          if (src === focusNode || dst === focusNode) {
            res.size = 2;
            res.zIndex = 2;
          } else {
            res.color = palette.dimEdge;
            res.label = "";
          }
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
      if (!syncModeRef.current) reseedWorkerLayout();
      // Let the graph settle, then freeze it.
      startLayout(2500);
    };
    renderer.on("upNode", endDrag);
    renderer.on("upStage", endDrag);

    sigmaRef.current = renderer;

    if (!syncModeRef.current) {
      workerLayoutRef.current = new FA2Layout(graph, {
        settings: fa2SettingsRef.current,
        getEdgeWeight: "weight",
      });
    }
    // Run the force layout for a duration proportional to graph size.
    startLayout(Math.min(20000, 2500 + graph.order * 3));

    return () => {
      window.clearTimeout(layoutTimer.current);
      window.clearInterval(reheatInterval);
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
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
        size: nodeSize(node.degree),
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

  // Center the camera on the selected node — but only for explicit focus
  // requests (search picks, detail-panel navigation), not plain graph clicks.
  useEffect(() => {
    const sel = selectedRef.current;
    if (!focusTick || !sel || !graphRef.current?.hasNode(sel)) return;
    centerOn(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        {data ? (
          <>
            <button
              className="tool-btn"
              onClick={() => sigmaRef.current?.getCamera().animatedReset({ duration: 400 })}
              title="Zoom out to fit the whole graph"
            >
              ⤢ <span>Fit</span>
            </button>
            <button
              className="tool-btn"
              onClick={() => {
                const camera = sigmaRef.current?.getCamera();
                if (camera) camera.animatedZoom({ duration: 200 });
              }}
              title="Zoom in"
            >
              ＋
            </button>
            <button
              className="tool-btn"
              onClick={() => {
                const camera = sigmaRef.current?.getCamera();
                if (camera) camera.animatedUnzoom({ duration: 200 });
              }}
              title="Zoom out"
            >
              －
            </button>
            <div className="spacer" />
            {/* Secondary: the layout runs automatically on load and while
                dragging, so this is only for re-settling a big or fiddled
                graph. Icon-only to keep it out of the way. */}
            <button
              className={layoutRunning ? "tool-btn icon-only active" : "tool-btn icon-only"}
              onClick={() => (layoutRunning ? stopLayout() : startLayout(15000))}
              aria-label={layoutRunning ? "Stop the layout" : "Re-run the layout"}
              title={
                layoutRunning
                  ? "Stop the layout simulation"
                  : "Re-run the layout to untangle the graph"
              }
            >
              {layoutRunning ? "⏸" : "▶"}
            </button>
            <button
              className="tool-btn"
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
              ⬇ <span>PNG</span>
            </button>
          </>
        ) : (
          <span className="graph-toolbar-hint">No ontology loaded</span>
        )}
      </div>
      <div className="graph-body">
        {data ? leftRail : null}
        <div className="graph-canvas-wrap">
          <div ref={containerRef} className="graph-container" />
          {!data && (
            <div className="graph-empty">
              <p>No ontology loaded yet.</p>
              <p className="hint">
                Use “Load” to upload a file or fetch one from a URL / GitHub.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
