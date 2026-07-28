/*
================================================================================
FILE: frontend/src/components/GraphView.tsx
================================================================================

SUMMARY
    The interactive graph canvas. Builds a graphology graph from the backend's
    nodes/edges, renders it with Sigma (WebGL), runs a ForceAtlas2 force layout,
    supports drag-to-reposition with live physics, highlights hover/selection,
    dims/paints for Query mode, and exports the view as PNG.

BASIC IDEA
    Sigma draws the graph on a canvas; graphology holds the data and positions;
    ForceAtlas2 spreads the nodes out. For fluid motion on small/medium graphs
    the physics run synchronously once per animation frame; very large graphs
    offload the physics to a web worker to keep the UI responsive. Node/edge
    "reducers" recolour and dim nodes on the fly for hover, selection and Query
    mode without rebuilding the graph. Everything that must survive re-renders
    (the Sigma instance, the layout, timers, current selection) is kept in refs.

INPUTS / INPUT SOURCES (props)
    - data: the VizGraph to draw (or null for the empty state).
    - theme: which colour palette to use.
    - hiddenKinds: kinds toggled off in the legend (hidden).
    - selected + focusTick: the selected node and a counter that, when bumped,
      re-centres the camera on it.
    - onSelect: called with a clicked node's IRI (or null on empty click).
    - queryMode / queryPathIris / queryCandidates: Query-mode highlighting.
    - leftRail: the legend, docked beside the canvas (never an overlay, so it
      cannot swallow clicks meant for nodes beneath it).

EXPECTED OUTPUT
    - The rendered graph with its docked toolbar and legend; onSelect callbacks;
      a downloaded PNG on demand.
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
import type { Theme, VizGraph } from "../types";
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
   * Docked beside the canvas (the legend). Rendered as a sibling rather than
   * an overlay so it can never hide or swallow clicks on nodes beneath it.
   */
  leftRail?: React.ReactNode;
}

// Graphs up to this many nodes animate with a per-frame synchronous
// ForceAtlas2 loop (fluid, WebVOWL-like). Larger graphs use the web worker.
const SYNC_LAYOUT_MAX_NODES = 3000;

function nodeSize(degree: number): number {
  return Math.min(16, 3 + Math.log2(degree + 1) * 2.2);
}

const EMPTY_SET: Set<string> = new Set();

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
  const [layoutRunning, setLayoutRunning] = useState(false);

  selectedRef.current = selected;
  hiddenRef.current = hiddenKinds;
  paletteRef.current = PALETTES[theme];
  queryModeRef.current = queryMode;
  pathRef.current = queryPathIris ?? EMPTY_SET;
  candidateRef.current = queryCandidates;

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
      const key = `${edge.kind}|${edge.label}|${edge.source}|${edge.target}`;
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
        const focusNode = hov ?? sel;
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
        const focusNode = queryModeRef.current
          ? hoveredRef.current
          : hoveredRef.current ?? selectedRef.current;
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
    const renderer = sigmaRef.current;
    const sel = selectedRef.current;
    if (!focusTick || !renderer || !sel || !graphRef.current?.hasNode(sel)) return;
    const display = renderer.getNodeDisplayData(sel);
    if (display) {
      renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.25 }, { duration: 500 });
    }
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
