// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/GraphView.test.tsx
================================================================================

SUMMARY
    Tests for GraphView. Two groups: the theme-aware pill drawn behind the
    hovered or selected node's label — the fix for a white-on-white label in
    dark mode — and the node and edge reducers, which decide what is dimmed and
    which used to throw when the selection was not a node in the drawn graph.

BASIC IDEA
    The drawing function is a plain canvas callback, so it is tested by calling
    it with a recording stub for CanvasRenderingContext2D and reading back the
    fill colour it chose. No renderer, no WebGL, no layout.

    The reducers are harder to reach: they are closures defined inline in the
    Sigma constructor call and they read the component's refs, so there is no
    export to test. Rather than pull them out of the component — a refactor of
    the least-tested and most delicate file here, to fix a two-line defect —
    this stubs the `sigma` module with a class that records the settings object
    it was constructed with. Rendering GraphView then hands over the real
    reducers, closed over the real refs, and they can be called directly.

    That is worth stating plainly: what these tests exercise is the code that
    ships, not a copy of it. A reducer extracted for testability would have been
    a second thing to keep in step.

    Importing GraphView at all needs `WebGL2RenderingContext` to exist, because
    Sigma reads it at module scope and jsdom does not define it. Two stub
    globals are enough.

    The palette assertions are written against `PALETTES` rather than against
    the hex values, so changing a theme colour does not silently break the test
    — but the one value that must never come back, Sigma's hard-coded `#FFF`, is
    asserted literally, because that specific constant is the defect.

INPUTS / INPUT SOURCES
    - NODE_HOVER_DRAWERS, exported from GraphView.tsx.
    - A recording canvas context stub.
    - A stubbed `sigma` module that records its constructor settings.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-5 and AC-12 of
      visual-defects, and the off-graph selection crash.
================================================================================
*/

import { Profiler } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PALETTES } from "../types";
import type { MergeResult, Theme, VizGraph, VizNeighborhood } from "../types";

// Sigma touches WebGL2RenderingContext when its module is evaluated. Stubbing
// it lets the module import.
beforeAll(() => {
  vi.stubGlobal("WebGL2RenderingContext", class {});
  vi.stubGlobal("WebGLRenderingContext", class {});
});

/**
 * The settings object of the most recent Sigma construction, which is where the
 * two reducers live. Reset per test by the stub's constructor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sigmaCalls = vi.hoisted(() => ({ last: null as any }));

/** Every camera.animate target, in order, so "the camera arrived" is testable.
 *  The duration rides along because reduced motion is asserted on it. The three
 *  counters are for the zoom controls: which camera action each button fired. */
const cameraMoves = vi.hoisted(() => ({
  to: [] as { x: number; y: number }[],
  durations: [] as number[],
  zoomIn: 0,
  zoomOut: 0,
  fit: 0,
}));

// A Sigma that draws nothing and remembers everything it was given. Only the
// methods GraphView actually calls are implemented; anything else appearing
// here later means GraphView started calling something new, which is worth
// noticing rather than stubbing away with a Proxy.
vi.mock("sigma", () => {
  class FakeSigma {
    // Event handlers GraphView registers, so a test can drive one — the only way
    // to reach hoveredRef from here, since hover is set inside the enterNode
    // handler and there is no WebGL to hover a node in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: Record<string, (payload: any) => void> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(graph: any, container: any, settings: any) {
      // A snapshot of where every node was at the moment the renderer was
      // built, i.e. at the first paint. Taken here because the graph is a live
      // object: read afterwards it reports wherever the layout has since put
      // things, and "the layout was applied BEFORE painting" is precisely a
      // claim about this instant.
      const positionsAtFirstPaint: Record<string, [number, number]> = {};
      graph?.forEachNode?.((id: string, attrs: { x: number; y: number }) => {
        positionsAtFirstPaint[id] = [attrs.x, attrs.y];
      });
      sigmaCalls.last = {
        graph, container, settings, positionsAtFirstPaint,
        handlers: this.handlers, camera: this.camera,
      };
    }
    // A stable camera per renderer, with the TypedEventEmitter surface GraphView
    // uses — on/removeListener for the zoom controls' disabled state. `__fire`
    // stands in for the real camera emitting `updated` as it animates, and
    // `__listeners` lets a test prove the subscription was cleaned up.
    camera = (() => {
      const listeners = new Set<(s: { ratio: number }) => void>();
      return {
        ratio: 1,
        on(_event: string, fn: (s: { ratio: number }) => void) { listeners.add(fn); },
        removeListener(_event: string, fn: (s: { ratio: number }) => void) { listeners.delete(fn); },
        animate(target: { x: number; y: number }, opts?: { duration?: number }) {
          cameraMoves.to.push({ x: target.x, y: target.y });
          cameraMoves.durations.push(opts?.duration ?? -1);
        },
        animatedReset(opts?: { duration?: number }) {
          cameraMoves.fit += 1;
          cameraMoves.durations.push(opts?.duration ?? -1);
        },
        animatedZoom(opts?: { duration?: number }) {
          cameraMoves.zoomIn += 1;
          cameraMoves.durations.push(opts?.duration ?? -1);
        },
        animatedUnzoom(opts?: { duration?: number }) {
          cameraMoves.zoomOut += 1;
          cameraMoves.durations.push(opts?.duration ?? -1);
        },
        __fire(ratio: number) {
          this.ratio = ratio;
          for (const fn of listeners) fn({ ratio });
        },
        __listeners() { return listeners.size; },
      };
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, fn: (payload: any) => void) {
      this.handlers[event] = fn;
    }
    kill() {}
    refresh() {}
    setSetting() {}
    // The real one returns the node's screen position. Returning the graph's
    // own coordinates is enough for the camera assertions and keeps the stub
    // honest about which node it was asked for: a null here, as this returned
    // before, makes centerOn a no-op and every camera test vacuous.
    getNodeDisplayData(node: string) {
      const graph = sigmaCalls.last?.graph;
      if (!graph?.hasNode?.(node)) return null;
      return { x: graph.getNodeAttribute(node, "x"), y: graph.getNodeAttribute(node, "y") };
    }
    getCamera() {
      return this.camera;
    }
  }
  return { default: FakeSigma };
});

/** Records every fillStyle assigned, in order, plus the calls that were made.
 *  `strokes` records the strokeStyle in effect at each stroke(), which is how the
 *  selection ring (a stroked circle, not a fill) is read back. */
function recordingContext() {
  const fills: string[] = [];
  const strokes: string[] = [];
  const calls: string[] = [];
  let strokeStyle = "";
  const ctx = {
    set fillStyle(value: string) {
      fills.push(value);
    },
    get fillStyle() {
      return fills[fills.length - 1] ?? "";
    },
    set strokeStyle(value: string) {
      strokeStyle = value;
    },
    get strokeStyle() {
      return strokeStyle;
    },
    lineWidth: 0,
    font: "",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    shadowColor: "",
    measureText: (t: string) => ({ width: t.length * 7 }),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    arc: () => calls.push("arc"),
    fill: () => calls.push("fill"),
    fillText: () => calls.push("fillText"),
    stroke: () => {
      calls.push("stroke");
      strokes.push(strokeStyle);
    },
  };
  return { ctx, fills, strokes, calls };
}

/** The subset of Sigma settings the two drawing functions actually read. */
function settingsFor(theme: Theme) {
  return {
    labelSize: 13,
    labelFont: "Inter, system-ui, sans-serif",
    labelWeight: "600",
    labelColor: { color: PALETTES[theme].label },
  };
}

const NODE = { x: 10, y: 20, size: 8, label: "Financial Instrument", color: "#4c9aff" };

/** Run one theme's hover drawer against a recording context. */
async function draw(theme: Theme, node: typeof NODE | { label: undefined } & typeof NODE) {
  const { NODE_HOVER_DRAWERS } = await import("./GraphView");
  const rec = recordingContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NODE_HOVER_DRAWERS[theme](rec.ctx as any, node as any, settingsFor(theme) as any);
  return rec;
}

/* --- the reducers -------------------------------------------------------- */

/** Two classes joined by one edge, plus an unrelated third node. */
const DATA: VizGraph = {
  nodes: [
    { id: "http://x/Celestial", label: "Celestial Body", kind: "class", degree: 2 },
    { id: "http://x/Planet", label: "Planet", kind: "class", degree: 1 },
    { id: "http://x/NASA", label: "NASA", kind: "individual", degree: 0 },
  ],
  edges: [
    {
      source: "http://x/Planet",
      target: "http://x/Celestial",
      kind: "subClassOf",
      label: "subclass of",
    },
  ],
  stats: {
    nodeCount: 3,
    edgeCount: 1,
    nodeTotal: 3,
    edgeTotal: 1,
    truncated: false,
    budget: 2000,
    kindCounts: { class: 2, individual: 1 },
  },
};

/** An IRI that is not a node in DATA: rdf:type, the one that crashed the app. */
const OFF_GRAPH = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

interface Reducers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: (id: string, attrs: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edge: (id: string, attrs: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: any;
  unmount: () => void;
}

/** Render GraphView with a selection and hand back the reducers Sigma got. */
async function reducersFor(selected: string | null): Promise<Reducers> {
  const { default: GraphView } = await import("./GraphView");
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <GraphView
        data={DATA}
        theme="dark"
        hiddenKinds={new Set()}
        selected={selected}
        onSelect={() => {}}
        focusTick={0}
      />,
    );
  });
  const settings = sigmaCalls.last.settings;
  return {
    node: settings.nodeReducer,
    edge: settings.edgeReducer,
    graph: sigmaCalls.last.graph,
    unmount: () => view.unmount(),
  };
}

/** The attributes Sigma passes a reducer, read off the built graphology graph. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attrsOf(graph: any, id: string) {
  return graph.getNodeAttributes(id);
}

describe("selecting something that is not in the drawn graph", () => {
  afterEach(() => {
    // The layout runs on requestAnimationFrame until the component unmounts.
    vi.clearAllTimers();
  });

  it("does not throw when the selection is not a node in the graph", async () => {
    // The defect, exactly. `graph.areNeighbors(selected, node)` threw
    // NotFoundGraphError, React unmounted the whole tree, and the page went
    // blank until a reload. Two ordinary routes reach it: an rdf:type term link
    // in the detail panel, and a search hit outside the node budget.
    const { node, graph, unmount } = await reducersFor(OFF_GRAPH);

    for (const id of DATA.nodes.map((n) => n.id)) {
      expect(() => node(id, attrsOf(graph, id))).not.toThrow();
    }
    unmount();
  });

  it("dims nothing when the selection is not drawn", async () => {
    // Not throwing is not enough: the graph must look untouched. Dimming
    // everything would be the same information as a blank screen.
    const { node, graph, unmount } = await reducersFor(OFF_GRAPH);
    const palette = PALETTES.dark;

    for (const id of DATA.nodes.map((n) => n.id)) {
      const res = node(id, attrsOf(graph, id));
      expect(res.color, id).not.toBe(palette.dimNode);
      expect(res.label, id).toBe(attrsOf(graph, id).label);
      expect(res.highlighted, id).toBeUndefined();
    }
    unmount();
  });

  it("dims no edge when the selection is not drawn", async () => {
    // The edge reducer never threw, which is why it would have been missed: it
    // compares rather than looks up. Left unguarded it dimmed every edge while
    // every node stayed lit, which is a worse picture than no highlight at all.
    const { edge, graph, unmount } = await reducersFor(OFF_GRAPH);

    for (const key of graph.edges()) {
      const res = edge(key, graph.getEdgeAttributes(key));
      expect(res.color).not.toBe(PALETTES.dark.dimEdge);
      expect(res.label).toBe(graph.getEdgeAttributes(key).label);
    }
    unmount();
  });

  it("still highlights the neighbourhood when the selection is drawn", async () => {
    // The guard must not have bought its safety by turning the feature off.
    // Selecting a drawn node dims everything that is not its neighbour, which
    // is what the highlight is for.
    const { node, edge, graph, unmount } = await reducersFor("http://x/Celestial");
    const palette = PALETTES.dark;

    const selected = node("http://x/Celestial", attrsOf(graph, "http://x/Celestial"));
    expect(selected.highlighted).toBe(true);

    // Planet is joined to Celestial by an edge, so it stays lit.
    const neighbour = node("http://x/Planet", attrsOf(graph, "http://x/Planet"));
    expect(neighbour.color).not.toBe(palette.dimNode);

    // NASA is not, so it recedes.
    const stranger = node("http://x/NASA", attrsOf(graph, "http://x/NASA"));
    expect(stranger.color).toBe(palette.dimNode);
    expect(stranger.label).toBe("");

    // And the one edge touches the selection, so it is emphasised rather than
    // dimmed.
    for (const key of graph.edges()) {
      const res = edge(key, graph.getEdgeAttributes(key));
      expect(res.size).toBe(2);
    }
    unmount();
  });
});

/* --- merging a neighbourhood in ------------------------------------------ */

/**
 * Three nodes for the centre already drawn in DATA, two of which are new. The
 * second edge repeats DATA's own Planet -> Celestial edge exactly, because the
 * duplicate case is the one the merge has to survive: graphology throws on a
 * repeated key rather than ignoring it, so an unguarded merge crashes the graph
 * rather than drawing something twice.
 */
const NEIGHBORHOOD: VizNeighborhood = {
  nodes: [
    { id: "http://x/Celestial", label: "Celestial Body", kind: "class", degree: 2 },
    { id: "http://x/Moon", label: "Moon", kind: "class", degree: 3 },
    { id: "http://x/Comet", label: "Comet", kind: "class", degree: 1 },
  ],
  edges: [
    { source: "http://x/Moon", target: "http://x/Celestial", kind: "subClassOf", label: "" },
    {
      source: "http://x/Planet",
      target: "http://x/Celestial",
      kind: "subClassOf",
      label: "subclass of",
    },
    { source: "http://x/Comet", target: "http://x/Celestial", kind: "subClassOf", label: "" },
  ],
  stats: {
    nodeCount: 3,
    edgeCount: 3,
    nodeTotal: 5,
    edgeTotal: 4,
    truncated: false,
    budget: 200,
    kindCounts: { class: 4, individual: 1 },
    neighborTotal: 2,
    center: "http://x/Celestial",
  },
};

interface Merged {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: any;
  results: MergeResult[];
  merge: (data?: VizNeighborhood) => Promise<void>;
  unmount: () => void;
}

/**
 * Render GraphView with no expansion, then hand back a way to push one in.
 *
 * Fake timers matter here and are not incidental. The initial layout runs on
 * requestAnimationFrame, which jsdom drives from a timer, so with real timers
 * every node's position drifts between the assertions — and the claim being
 * tested is precisely that positions do not move.
 */
async function mergeable(selected: string | null = null): Promise<Merged> {
  const { default: GraphView } = await import("./GraphView");
  const results: MergeResult[] = [];
  let token = 0;
  let view!: ReturnType<typeof render>;
  const props = (expansion: { data: VizNeighborhood; token: number } | null) => (
    <GraphView
      data={DATA}
      theme="dark"
      hiddenKinds={new Set()}
      selected={selected}
      onSelect={() => {}}
      // 1, not 0: a caller passing `selected` is standing in for a search pick
      // or a result chip, both of which ask for the camera. With 0 the focus
      // effect returns before it looks at anything.
      focusTick={selected ? 1 : 0}
      expansion={expansion}
      onExpanded={(r) => results.push(r)}
    />
  );
  await act(async () => {
    view = render(props(null));
  });
  return {
    graph: sigmaCalls.last.graph,
    results,
    merge: async (data = NEIGHBORHOOD) => {
      token += 1;
      await act(async () => {
        view.rerender(props({ data, token }));
      });
    },
    unmount: () => view.unmount(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function positionsOf(graph: any): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  graph.forEachNode((id: string, attrs: { x: number; y: number }) => {
    out[id] = [attrs.x, attrs.y];
  });
  return out;
}

describe("expanding the drawn graph", () => {
  beforeEach(() => {
    cameraMoves.to = [];
    cameraMoves.durations = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expanding merges without duplicating existing nodes", async () => {
    // AC-25, both halves. An entity already drawn appears exactly once, and
    // nothing that was already on the canvas moves — the merge exists to avoid
    // the rebuild that would throw away the settled layout, so a merge that
    // shifted positions would have given away the thing it was for.
    const { graph, merge, unmount } = await mergeable();
    expect(graph.order).toBe(3);
    const before = positionsOf(graph);

    await merge();

    // Celestial was in both DATA and the neighbourhood: five nodes, not six.
    expect(graph.order).toBe(5);
    expect(graph.hasNode("http://x/Moon")).toBe(true);
    expect(graph.hasNode("http://x/Comet")).toBe(true);

    // Not bit-exact, and the reason is worth knowing before someone tightens
    // this. ForceAtlas2 copies every node's coordinates into a Float32Array and
    // writes them all back, pinned or not, so a node that never moved still
    // returns quantised: -49.99999999999998 came back as -50. Measured
    // 2026-07-30, the largest difference across the three nodes was 1.4e-5.
    // Three decimal places is far below anything a layout step produces — FA2
    // moves nodes by whole units — so this still fails if anything really moved.
    const after = positionsOf(graph);
    for (const id of Object.keys(before)) {
      expect(after[id][0], `${id} x`).toBeCloseTo(before[id][0], 3);
      expect(after[id][1], `${id} y`).toBeCloseTo(before[id][1], 3);
    }
    unmount();
  });

  it("expanding reports the entities and edges it actually added", async () => {
    // What App turns into "Added 2 entities. 2,240 of 18,717 drawn." Only the
    // renderer can produce this number, because only it knows what was already
    // on the canvas — which is why it is reported back rather than counted from
    // the response.
    const { graph, results, merge, unmount } = await mergeable();

    await merge();

    expect(results).toHaveLength(1);
    expect(results[0].addedNodes.sort()).toEqual(["http://x/Comet", "http://x/Moon"]);
    // Three edges came back and one of them was already drawn.
    expect(results[0].addedEdges).toBe(2);
    expect(graph.size).toBe(3);
    unmount();
  });

  it("merging the same neighbourhood twice adds nothing the second time", async () => {
    // The duplicate guard under repetition. graphology throws on a repeated
    // node or edge key rather than ignoring it, so this is the difference
    // between a no-op and a crash — and pressing the control twice, or
    // expanding a neighbour of something already expanded, is ordinary use.
    const { graph, results, merge, unmount } = await mergeable();

    await merge();
    const afterFirst = positionsOf(graph);
    await merge();

    expect(graph.order).toBe(5);
    expect(graph.size).toBe(3);
    expect(results[1]).toEqual({ addedNodes: [], addedEdges: 0 });
    // And with nothing new to place, the layout must not have run: a merge that
    // added nothing has no reason to move anything.
    expect(positionsOf(graph)).toEqual(afterFirst);
    unmount();
  });

  it("the camera arrives at an entity this merge is what drew", async () => {
    // AC-2 of result-navigation, and it is a gap this spec inherited rather
    // than created: search picks had it too. Focus is requested at the moment
    // of selection, when the node does not exist, so the camera effect bails on
    // hasNode and the request is simply lost. Drawing an entity off screen and
    // leaving the user looking at where it was not is most of the difference
    // between "the result led somewhere" and "the result did nothing".
    //
    // Found in Chrome on 2026-07-31, against the built application: 5 of 34
    // nodes became 8 of 34 and the view did not move.
    const moon = "http://x/Moon";
    const { graph, merge, unmount } = await mergeable(moon);
    expect(cameraMoves.to, "nothing to centre on before the merge").toEqual([]);

    await merge();

    expect(graph.hasNode(moon)).toBe(true);
    expect(cameraMoves.to).toHaveLength(1);
    expect(cameraMoves.to[0]).toEqual({
      x: graph.getNodeAttribute(moon, "x"),
      y: graph.getNodeAttribute(moon, "y"),
    });
    unmount();
  });

  it("a merge around an already-drawn entity leaves the camera alone", async () => {
    // The other half of the rule, and the reason it is keyed on what the merge
    // ADDED rather than on what is drawn. "Show its connections" grows the view
    // from an entity the user has already centred and settled; re-running the
    // camera there would zoom a view they arranged.
    const planet = "http://x/Planet";
    const { graph, merge, unmount } = await mergeable(planet);
    expect(graph.hasNode(planet)).toBe(true);
    cameraMoves.to = []; // the focus request on mount is not what this is about

    await merge();

    expect(cameraMoves.to).toEqual([]);
    unmount();
  });

  it("merges a neighbourhood whose centre is not itself drawn", async () => {
    // The route stage 2 exists for: a search hit outside the node budget. The
    // centre is not on the canvas, so there is no position to grow outward
    // from, and the merge must place the new nodes somewhere real rather than
    // reading undefined coordinates off a node that is not there.
    const off = "http://x/Quasar";
    const { graph, results, merge, unmount } = await mergeable();

    await merge({
      ...NEIGHBORHOOD,
      nodes: [
        { id: off, label: "Quasar", kind: "class", degree: 1 },
        { id: "http://x/Moon", label: "Moon", kind: "class", degree: 3 },
      ],
      edges: [{ source: off, target: "http://x/Moon", kind: "subClassOf", label: "" }],
      stats: { ...NEIGHBORHOOD.stats, center: off },
    });

    expect(graph.hasNode(off)).toBe(true);
    expect(results[0].addedNodes.sort()).toEqual([off, "http://x/Moon"].sort());
    for (const id of [off, "http://x/Moon"]) {
      expect(Number.isFinite(graph.getNodeAttribute(id, "x")), id).toBe(true);
      expect(Number.isFinite(graph.getNodeAttribute(id, "y")), id).toBe(true);
    }
    unmount();
  });
});

/* --- the accessible equivalent, and reduced motion ------------------------ */

/**
 * A controllable `prefers-reduced-motion`.
 *
 * jsdom defines no matchMedia at all, which is why GraphView guards it with
 * `?.` — so every test above this point runs with the preference unset, which
 * is the normal path. This installs one, records every query string it is
 * asked for, and can flip the answer and notify listeners the way a real
 * browser does when the OS setting changes under a running page.
 */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  const list = {
    get matches() {
      return state.matches;
    },
    media: "",
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      listeners.delete(fn);
    },
  };
  const state = { matches };
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    return list as unknown as MediaQueryList;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    queries,
    /** Change the preference the way the operating system would. */
    set(next: boolean) {
      state.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

/** Render GraphView and hand back the view, for tests that drive props. */
async function renderView(props: Partial<Record<string, unknown>> = {}) {
  const { default: GraphView } = await import("./GraphView");
  const all = {
    data: DATA,
    theme: "dark" as const,
    hiddenKinds: new Set<string>(),
    selected: null as string | null,
    onSelect: () => {},
    focusTick: 0,
    ...props,
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view = render(<GraphView {...(all as any)} />);
  });
  return {
    view,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rerender: async (next: Record<string, any>) => {
      await act(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        view.rerender(<GraphView {...({ ...all, ...next } as any)} />);
      });
    },
  };
}

describe("the graph's accessible equivalent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("the graph container is role img with a describing label", async () => {
    // AC-8. A WebGL canvas draws pixels: there is nothing in the accessibility
    // tree to navigate, so what it gets is a description and a route out. The
    // label ends by naming the route, which is the honest half of D-025 — the
    // keyboard user gets a path through the ontology, not the spatial view.
    const { view } = await renderView();
    const container = screen.getByRole("img");

    expect(container.className).toContain("graph-container");
    expect(container.getAttribute("aria-label")).toMatch(/^Ontology graph, /);
    expect(container.getAttribute("aria-label")).toMatch(/entity list/i);
    view.unmount();
  });

  it("the label reports drawn and total counts", async () => {
    // AC-8. Both numbers, with separators, as everything else in this
    // application states them — and NOTHING from the ontology. Requirement 5 of
    // the security rules in one line: counts are interpolated, labels are not.
    const { view } = await renderView({
      data: {
        ...DATA,
        stats: { ...DATA.stats, nodeCount: 3, nodeTotal: 18717, truncated: true },
      },
    });

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("3 of 18,717 entities drawn");
    // Not a single entity label from the graph. The three in DATA are named
    // here so this fails loudly rather than by a regex nobody re-reads.
    for (const node of DATA.nodes) expect(label).not.toContain(node.label);
    view.unmount();
  });

  it("the toolbar comes before the docked rail in the tab order", async () => {
    // AC-13, the half App.test.tsx cannot see because it stubs this component.
    //
    // **The specification's Section 6 has this the other way round**, listing
    // the legend before the graph toolbar. It is wrong about the layout: the
    // toolbar is a full-width strip across the top of the graph area and the
    // legend is a rail beneath it, so the toolbar is what a sighted user reads
    // first. Matching the specification would put the tab order out of step
    // with the visual order, which is the defect this item exists to fix rather
    // than a form of fixing it. Document order is left as it is and asserted.
    const rail = <div data-testid="rail" />;
    const { default: GraphView } = await import("./GraphView");
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <GraphView
          data={DATA}
          theme="dark"
          hiddenKinds={new Set()}
          selected={null}
          onSelect={() => {}}
          focusTick={0}
          leftRail={rail}
        />,
      );
    });

    const toolbar = document.querySelector(".graph-toolbar")!;
    const docked = screen.getByTestId("rail");
    expect(
      toolbar.compareDocumentPosition(docked) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And nothing in the toolbar has been given a tabindex to reorder it.
    for (const button of toolbar.querySelectorAll("button")) {
      expect(button.getAttribute("tabindex")).toBeNull();
    }
    view.unmount();
  });

  it("labels nothing when there is no graph", async () => {
    // The edge case the specification names: with no ontology open there is
    // nothing to describe, so an unlabelled div is exposed as nothing at all
    // rather than as an image of nothing.
    const { view } = await renderView({ data: null });
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".graph-container")!.getAttribute("aria-label")).toBeNull();
    view.unmount();
  });
});

describe("reduced motion", () => {
  beforeEach(() => {
    cameraMoves.to = [];
    cameraMoves.durations = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The two Sigma globals are stubbed once for the whole file and
    // unstubAllGlobals has just removed them; put them back for the next test.
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.stubGlobal("WebGLRenderingContext", class {});
    document.body.innerHTML = "";
  });

  it("reads the motion preference once", async () => {
    // AC-14, row 2 of the performance budget. The obvious shape — a matchMedia
    // in the useState initialiser and a second one in the effect that
    // subscribes — reads it twice per graph mount, and a graph mounts on every
    // ontology switch and every budget change.
    const media = stubMatchMedia(false);
    const { view } = await renderView();

    const reads = media.queries.filter((q) => q.includes("prefers-reduced-motion"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBe("(prefers-reduced-motion: reduce)");
    view.unmount();
  });

  it("reduced motion settles the layout before painting", async () => {
    // AC-10, and row 3 of the performance budget. The claim is an ordering one:
    // by the time Sigma exists — the first paint — the nodes are no longer on
    // the ring circular.assign put them on. Settling afterwards would show that
    // ring and then replace it, which is one motion event more than a
    // reduced-motion user asked for.
    //
    // Asserted against the ring rather than against a settled shape, because
    // ForceAtlas2's output is not something to pin: what matters is that it ran
    // before the renderer was constructed, not where it landed.
    const rings: Record<string, [number, number]> = {};
    {
      // The ring itself: the same graph rendered with the preference unset,
      // where the layout is animated and has not run at construction time.
      stubMatchMedia(false);
      const plain = await renderView();
      Object.assign(rings, sigmaCalls.last.positionsAtFirstPaint);
      plain.view.unmount();
    }

    vi.unstubAllGlobals();
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.stubGlobal("WebGLRenderingContext", class {});
    stubMatchMedia(true);
    const rafs = vi.spyOn(window, "requestAnimationFrame");
    const { view } = await renderView();

    const settled = sigmaCalls.last.positionsAtFirstPaint as Record<string, [number, number]>;
    expect(Object.keys(settled).sort()).toEqual(Object.keys(rings).sort());
    const moved = Object.keys(settled).filter(
      (id) => settled[id][0] !== rings[id][0] || settled[id][1] !== rings[id][1],
    );
    expect(moved.length, "the layout had not run by the first paint").toBe(
      Object.keys(rings).length,
    );

    // And nothing was scheduled to keep moving them. This is the half that
    // fails if the media-query read is removed: the animated path requests a
    // frame immediately.
    expect(rafs).not.toHaveBeenCalled();
    rafs.mockRestore();
    view.unmount();
  });

  it("reduced motion passes zero duration to the camera", async () => {
    // AC-10's second half. The camera tween is 500 ms on every selection made
    // from search, a result row or the detail panel, which is the motion a user
    // of this application meets most often.
    stubMatchMedia(false);
    const normal = await renderView({ selected: "http://x/Planet", focusTick: 1 });
    expect(cameraMoves.durations).toEqual([500]);
    normal.view.unmount();

    vi.unstubAllGlobals();
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.stubGlobal("WebGLRenderingContext", class {});
    cameraMoves.durations = [];
    stubMatchMedia(true);
    const reduced = await renderView({ selected: "http://x/Planet", focusTick: 1 });

    expect(cameraMoves.durations).toEqual([0]);
    // The toolbar's own camera controls take the same route, so there is one
    // place to change rather than four literals to keep in step.
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    fireEvent.click(screen.getByRole("button", { name: /fit/i }));
    expect(cameraMoves.durations).toEqual([0, 0, 0]);
    reduced.view.unmount();
  });

  it("a motion preference change is honoured without reload", async () => {
    // AC-11. matchMedia change events are subscribed to, so turning the OS
    // setting on mid-session takes effect on the next camera move rather than
    // on the next page load.
    //
    // Only the ON direction does anything, and the test says so: turning it off
    // has nobody asking for movement, and re-running the load layout at that
    // point would be motion nobody requested.
    const media = stubMatchMedia(false);
    const { view, rerender } = await renderView({ selected: "http://x/Planet", focusTick: 1 });
    expect(cameraMoves.durations).toEqual([500]);

    await act(async () => {
      media.set(true);
    });
    await rerender({ selected: "http://x/Planet", focusTick: 2 });

    expect(cameraMoves.durations).toEqual([500, 0]);
    view.unmount();
  });
});

describe("hovered node label background", () => {
  it("hover drawing uses the dark palette background in dark theme", async () => {
    // AC-1. The pill must be the palette value and must not be Sigma's #FFF,
    // which is the entire defect: near-white text on a white pill.
    const { fills } = await draw("dark", NODE);
    expect(fills).toContain(PALETTES.dark.labelBackground);
    expect(fills).not.toContain("#FFF");
    expect(fills).not.toContain("#fff");
  });

  it("hover drawing uses the light palette background in light theme", async () => {
    // AC-2. Light mode was already correct, so the value it draws is the same
    // white Sigma drew — asserted through the palette so it stays deliberate.
    const { fills } = await draw("light", NODE);
    expect(fills).toContain(PALETTES.light.labelBackground);
    expect(PALETTES.light.labelBackground.toLowerCase()).toBe("#ffffff");
  });

  it("label text colour and pill colour differ in both themes", async () => {
    // AC-3. The defect was these two being equal in practice. A theme that
    // sets them to the same value reproduces it, so assert they differ.
    for (const theme of ["dark", "light"] as Theme[]) {
      const palette = PALETTES[theme];
      expect(palette.labelBackground.toLowerCase()).not.toBe(palette.label.toLowerCase());
      // And the drawer really used the pill colour, not the text colour.
      const { fills } = await draw(theme, NODE);
      expect(fills[0]).toBe(palette.labelBackground);
    }
  });

  it("switching theme updates the hover drawing setting without remounting", async () => {
    // AC-4. The two drawers are distinct functions chosen by theme, which is
    // what lets the theme effect swap the setting rather than rebuild Sigma.
    const { NODE_HOVER_DRAWERS } = await import("./GraphView");
    expect(NODE_HOVER_DRAWERS.dark).not.toBe(NODE_HOVER_DRAWERS.light);

    const dark = await draw("dark", NODE);
    const light = await draw("light", NODE);
    expect(dark.fills[0]).not.toBe(light.fills[0]);
  });

  it("the same drawing applies to selected, hovered and query-path nodes", async () => {
    // AC-5. All three reducer branches set `highlighted`, and Sigma routes
    // every highlighted node through the single `defaultDrawNodeHover`
    // setting. One drawer per theme is therefore the mechanism that makes the
    // three cases identical — assert there is exactly one, not three.
    const { NODE_HOVER_DRAWERS } = await import("./GraphView");
    expect(Object.keys(NODE_HOVER_DRAWERS).sort()).toEqual(["dark", "light"]);

    // A node with no label takes the disc branch and must still be themed.
    const unlabelled = await draw("dark", { ...NODE, label: undefined } as never);
    expect(unlabelled.fills).toContain(PALETTES.dark.labelBackground);
    expect(unlabelled.calls).toContain("arc");
  });

  it("hover draw callback does not add allocations", async () => {
    // AC-12. The per-frame path must not build objects, and the drawer must be
    // a stable reference: a factory called per render would allocate a new
    // closure on every theme effect, which also runs on selection changes.
    const { NODE_HOVER_DRAWERS } = await import("./GraphView");
    const again = await import("./GraphView");
    expect(again.NODE_HOVER_DRAWERS.dark).toBe(NODE_HOVER_DRAWERS.dark);

    // Drawing twice produces identical output, so nothing accumulates.
    const first = await draw("dark", NODE);
    const second = await draw("dark", NODE);
    expect(second.fills).toEqual(first.fills);
    expect(second.calls).toEqual(first.calls);

    // One pill fill plus one label draw per invocation, not a loop of them.
    expect(first.calls.filter((c) => c === "fill")).toHaveLength(1);
    expect(first.calls.filter((c) => c === "fillText")).toHaveLength(1);
  });
});

/* --- the selection ring (G-8) -------------------------------------------- */

/** Draw one theme's hover drawer against a recording context, for any data.
 *  Wider than `draw` above, which builds its own node — here the caller passes
 *  the exact display data, including the `selected` flag the ring keys on. */
async function drawData(theme: Theme, data: Record<string, unknown>) {
  const { NODE_HOVER_DRAWERS } = await import("./GraphView");
  const rec = recordingContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NODE_HOVER_DRAWERS[theme](rec.ctx as any, data as any, settingsFor(theme) as any);
  return rec;
}

describe("the selected node's ring", () => {
  afterEach(() => {
    // The layout runs on requestAnimationFrame until the component unmounts.
    vi.clearAllTimers();
    document.body.innerHTML = "";
  });

  it("the selected node carries a ring", async () => {
    // AC-1. Two halves, run through the real pipeline: the reducer marks the
    // selected node and grows it more than a hover would (+4, not +2), and the
    // hover drawer turns that mark into a stroked ring in the theme's accent.
    // The reducer's own output is fed to the drawer rather than a hand-built
    // flag, so nothing here can pass while the two disagree.
    const { node, graph, unmount } = await reducersFor("http://x/Celestial");
    const base = attrsOf(graph, "http://x/Celestial");
    const res = node("http://x/Celestial", base);
    expect(res.selected).toBe(true);
    expect(res.highlighted).toBe(true);
    expect(res.zIndex).toBe(3);
    expect(res.size).toBe((base.size as number) + 4);

    const rec = await drawData("dark", { ...res, x: 1, y: 2, key: "http://x/Celestial" });
    expect(rec.calls).toContain("stroke");
    expect(rec.strokes).toContain(PALETTES.dark.selectedRing);
    unmount();
  });

  it("a hovered node carries no ring", async () => {
    // AC-2. Hover and selection both set `highlighted` and draw through the same
    // function, so the ring is the only thing that tells them apart: a hovered
    // node reaches the drawer without `selected` and is not stroked, and its
    // size bump is the smaller +2. Hover is set the one way it can be from here —
    // by driving the enterNode handler GraphView registered.
    const { node, graph, unmount } = await reducersFor(null);
    sigmaCalls.last.handlers.enterNode({ node: "http://x/Planet" });
    const base = attrsOf(graph, "http://x/Planet");
    const res = node("http://x/Planet", base);
    expect(res.highlighted).toBe(true);
    expect(res.selected).toBeUndefined();
    expect(res.size).toBe((base.size as number) + 2);

    const rec = await drawData("dark", { ...res, x: 0, y: 0, key: "http://x/Planet" });
    expect(rec.calls).not.toContain("stroke");
    expect(rec.strokes).toHaveLength(0);
    unmount();
  });

  it("selected and hovered carries the ring", async () => {
    // AC-2's tie-break. A node that is both keeps the ring, because the reducer
    // checks selection before hover and so never falls to the hover branch — the
    // size stays the selection's +4 and `selected` stays set. The drawer then
    // draws the ring alongside the shared highlight pill: selection adds to the
    // hover treatment rather than replacing it.
    const { node, graph, unmount } = await reducersFor("http://x/Celestial");
    sigmaCalls.last.handlers.enterNode({ node: "http://x/Celestial" });
    const base = attrsOf(graph, "http://x/Celestial");
    const res = node("http://x/Celestial", base);
    expect(res.selected).toBe(true);
    expect(res.size).toBe((base.size as number) + 4);

    const rec = await drawData("dark", {
      ...res,
      x: 0,
      y: 0,
      key: "http://x/Celestial",
    });
    expect(rec.strokes).toContain(PALETTES.dark.selectedRing);
    expect(rec.fills).toContain(PALETTES.dark.labelBackground);
    unmount();
  });

  it("the selected node keeps its kind colour", async () => {
    // AC-3. Selection is a ring, not a fill swap, so the node still shows which
    // kind it is. The colour is set from the kind before any selection branch,
    // and the sel branch does not touch it — Celestial is a class and stays the
    // class colour, which is emphatically not the ring colour.
    const { node, graph, unmount } = await reducersFor("http://x/Celestial");
    const res = node("http://x/Celestial", attrsOf(graph, "http://x/Celestial"));
    expect(res.color).toBe(PALETTES.dark.kind.class);
    expect(res.color).not.toBe(PALETTES.dark.selectedRing);
    unmount();
  });

  it("the ring follows the theme", async () => {
    // AC-4. Each theme's drawer is a distinct function closed over its own
    // selectedRing, so App's theme effect swapping defaultDrawNodeHover repaints
    // the ring in the new accent without the user reselecting. The same selected
    // node strokes the dark accent under the dark drawer and the light accent
    // under the light one, and the two accents differ.
    const selected = { x: 0, y: 0, size: 10, label: "X", key: "x", selected: true, color: "#123456" };
    const dark = await drawData("dark", { ...selected });
    const light = await drawData("light", { ...selected });
    expect(dark.strokes).toContain(PALETTES.dark.selectedRing);
    expect(light.strokes).toContain(PALETTES.light.selectedRing);
    expect(PALETTES.dark.selectedRing).not.toBe(PALETTES.light.selectedRing);
  });

  it("the node reducer allocates nothing per frame", async () => {
    // AC-9, the allocation budget. The one result object per call is the
    // reducer's contract with Sigma; what this guards is that nothing is
    // allocated BEYOND it, and in particular that the ring rides on a boolean
    // rather than a fresh structure. Every value on the result is a primitive,
    // so a ring drawn as a nested `{color,width}` object — or any per-node array
    // or object — fails here. jsdom cannot measure a heap, so this is the
    // structural stand-in, per D-021's principle that a budget is a machine-
    // independent count. The selection is present, so the branch under test runs.
    const { node, graph, unmount } = await reducersFor("http://x/Celestial");
    for (const id of DATA.nodes.map((n) => n.id)) {
      const res = node(id, attrsOf(graph, id));
      for (const [key, value] of Object.entries(res)) {
        expect(typeof value, `${id}.${key} must be a primitive`).not.toBe("object");
      }
    }
    unmount();
  });

  it("selection does not slow the reducer", async () => {
    // AC-9, the cost budget, realized as an operation count rather than a
    // wall-clock ratio: jsdom timing is noise and this project times budgets as
    // counts for that reason (D-024, D-021). The spec's "≤1.1× against none" is
    // not literally measurable — a selection inherently adds the neighbour-
    // dimming traversal that predates G-8, so any selection is dearer than none
    // regardless of this spec. What is asserted instead is this spec's actual
    // addition: the ring costs no graph work. The selected node takes the sel
    // branch, which returns before areNeighbors, so it adds ZERO traversals —
    // the two non-selected nodes get one each, the selected one none. A sel
    // branch that fell through to the dimming would count three and fail.
    const { node, graph, unmount } = await reducersFor("http://x/Celestial");
    let neighborCalls = 0;
    const orig = graph.areNeighbors.bind(graph);
    graph.areNeighbors = (a: string, b: string) => {
      neighborCalls += 1;
      return orig(a, b);
    };
    for (const id of DATA.nodes.map((n) => n.id)) node(id, attrsOf(graph, id));
    expect(neighborCalls).toBe(DATA.nodes.length - 1);
    unmount();
  });

  it("palette is read once per node", async () => {
    // AC-9. The reducer binds `const palette = paletteRef.current` once and reads
    // `.kind` a single time per node — the colour line, before any branch. A
    // proxy over the theme palette counts `.kind` accesses: one per node, not one
    // per lookup. A reducer that stopped caching and wrote `paletteRef.current.kind`
    // in several places would count more and fail. Restored in finally so no
    // other test sees the instrumented palette.
    const realDark = PALETTES.dark;
    let kindReads = 0;
    const proxy = new Proxy(realDark, {
      get(target, prop, recv) {
        if (prop === "kind") kindReads += 1;
        return Reflect.get(target, prop, recv);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (PALETTES as any).dark = proxy;
    try {
      const { node, graph, unmount } = await reducersFor(null);
      for (const id of DATA.nodes.map((n) => n.id)) node(id, attrsOf(graph, id));
      expect(kindReads).toBe(DATA.nodes.length);
      unmount();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PALETTES as any).dark = realDark;
    }
  });
});

/* --- the docked zoom controls (G-5) -------------------------------------- */

/** The three zoom buttons by their accessible names. */
const zoomIn = () => screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
const zoomOut = () => screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
const fit = () => screen.getByRole("button", { name: "Fit the whole graph" }) as HTMLButtonElement;

/** Fire the camera's `updated` event the way the real camera does as it animates,
 *  which is the only way to reach the disabled state from jsdom. */
async function cameraRatio(value: number) {
  await act(async () => {
    sigmaCalls.last.camera.__fire(value);
  });
}

describe("the docked zoom controls", () => {
  beforeEach(() => {
    cameraMoves.to = [];
    cameraMoves.durations = [];
    cameraMoves.zoomIn = 0;
    cameraMoves.zoomOut = 0;
    cameraMoves.fit = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The two Sigma globals are stubbed once for the whole file; unstubAllGlobals
    // has just removed them, so put them back for the next test.
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.stubGlobal("WebGLRenderingContext", class {});
    document.body.innerHTML = "";
  });

  it("zoom controls render inside the graph container", async () => {
    // AC-1. The three controls live in a labelled group docked over the canvas —
    // inside .graph-canvas-wrap, the positioned wrapper — not in the toolbar.
    const { view } = await renderView();
    const group = document.querySelector(".graph-canvas-wrap .graph-zoom")!;
    expect(group).not.toBeNull();
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Zoom controls");
    expect(group.querySelectorAll("button")).toHaveLength(3);
    for (const button of [zoomIn(), zoomOut(), fit()]) expect(group.contains(button)).toBe(true);
    view.unmount();
  });

  it("the toolbar no longer contains zoom or fit", async () => {
    // AC-1, the other half. The controls MOVED; a copy left in the toolbar would
    // pass the test above while failing the point of the spec. Only layout and
    // PNG remain in the strip above the canvas.
    const { view } = await renderView();
    const toolbar = document.querySelector(".graph-toolbar")!;
    expect(toolbar.querySelector(".graph-zoom")).toBeNull();
    for (const name of ["Zoom in", "Zoom out", "Fit the whole graph"]) {
      const button = screen.getByRole("button", { name });
      expect(toolbar.contains(button)).toBe(false);
    }
    view.unmount();
  });

  it("no controls render without an ontology", async () => {
    // AC-2. Nothing to zoom, so nothing to zoom with.
    const { view } = await renderView({ data: null });
    expect(document.querySelector(".graph-zoom")).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    view.unmount();
  });

  it("zoom in calls animatedZoom", async () => {
    // AC-3. The same camera action the toolbar button performed.
    const { view } = await renderView();
    fireEvent.click(zoomIn());
    expect(cameraMoves.zoomIn).toBe(1);
    expect(cameraMoves.zoomOut).toBe(0);
    view.unmount();
  });

  it("zoom out calls animatedUnzoom", async () => {
    // AC-3.
    const { view } = await renderView();
    fireEvent.click(zoomOut());
    expect(cameraMoves.zoomOut).toBe(1);
    expect(cameraMoves.zoomIn).toBe(0);
    view.unmount();
  });

  it("fit reuses the existing handler", async () => {
    // AC-3. Fit is animatedReset, exactly as it was in the toolbar.
    const { view } = await renderView();
    fireEvent.click(fit());
    expect(cameraMoves.fit).toBe(1);
    view.unmount();
  });

  it("zoom in is disabled at the minimum ratio", async () => {
    // AC-4. Smaller ratio is more zoomed in, so the minimum is the fully-in end.
    const { view } = await renderView();
    expect(zoomIn().disabled).toBe(false);
    await cameraRatio(0.01); // MIN_CAMERA_RATIO
    expect(zoomIn().disabled).toBe(true);
    expect(zoomOut().disabled).toBe(false);
    view.unmount();
  });

  it("zoom out is disabled at the maximum ratio", async () => {
    // AC-4.
    const { view } = await renderView();
    expect(zoomOut().disabled).toBe(false);
    await cameraRatio(20); // MAX_CAMERA_RATIO
    expect(zoomOut().disabled).toBe(true);
    expect(zoomIn().disabled).toBe(false);
    view.unmount();
  });

  it("disabled controls carry a reason in their title", async () => {
    // AC-4. The reason is stated, not left to a dimmed button — the rule G-6
    // applied to Show more and Show less.
    const { view } = await renderView();
    await cameraRatio(0.01);
    expect(zoomIn().disabled).toBe(true);
    expect(zoomIn().getAttribute("title")).toMatch(/fully zoomed in/i);

    await cameraRatio(20);
    expect(zoomOut().disabled).toBe(true);
    expect(zoomOut().getAttribute("title")).toMatch(/fully zoomed out/i);
    view.unmount();
  });

  it("accessible names are words, not glyphs", async () => {
    // AC-5. "＋" and "−" announce as punctuation, so the names are words and no
    // button is addressable by its glyph.
    const { view } = await renderView();
    expect(zoomIn()).toBeTruthy();
    expect(zoomOut()).toBeTruthy();
    expect(fit()).toBeTruthy();
    for (const glyph of ["＋", "－", "⤢"]) {
      expect(screen.queryByRole("button", { name: glyph })).toBeNull();
    }
    view.unmount();
  });

  it("glyphs are hidden from assistive technology", async () => {
    // AC-5. The glyph is decorative; the label carries the name, so the glyph is
    // aria-hidden and does not get announced alongside it.
    const { view } = await renderView();
    for (const button of [zoomIn(), zoomOut(), fit()]) {
      const glyph = button.querySelector("[aria-hidden='true']");
      expect(glyph, button.getAttribute("aria-label") ?? "").not.toBeNull();
    }
    view.unmount();
  });

  it("focus moves to the partner when a control becomes disabled", async () => {
    // AC-6. Zooming fully in disables "+"; a disabled button drops focus to
    // <body>, so focus is put on "−" instead — the trap recorded twice already.
    // The press is recorded so an edge reached by the scroll wheel moves nobody.
    const { view } = await renderView();
    zoomIn().focus();
    fireEvent.click(zoomIn());
    await cameraRatio(0.01);
    expect(zoomIn().disabled).toBe(true);
    expect(document.activeElement).toBe(zoomOut());
    view.unmount();
  });

  it("a wheel zoom to an edge after a mid-range press moves nobody", async () => {
    // Beyond the plan, guarding the timer armZoomPress uses. A button press that
    // stops mid-range leaves an intent that must expire, or a later scroll-wheel
    // zoom to the edge inherits it and steals focus — the invariant AC-6's
    // wording relies on ("an edge reached by the scroll wheel moves nobody").
    vi.useFakeTimers();
    try {
      const { view } = await renderView();
      zoomIn().focus();
      fireEvent.click(zoomIn()); // arms the "in" intent
      await act(async () => {
        sigmaCalls.last.camera.__fire(0.5); // animates, but stays mid-range
      });
      await act(async () => {
        vi.advanceTimersByTime(400); // the intent's window elapses
      });
      // Now a wheel zoom reaches the minimum, with no button pressed.
      await act(async () => {
        sigmaCalls.last.camera.__fire(0.01);
      });
      expect(zoomIn().disabled).toBe(true);
      expect(document.activeElement).not.toBe(zoomOut());
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("zoom uses the shared camera helper, not a literal duration", async () => {
    // AC-7. Under reduced motion the camera helper X-1 left behind returns a zero
    // duration, and the zoom buttons must go through it rather than passing 200 —
    // matching on the duration is how a reintroduced literal is caught.
    stubMatchMedia(true);
    const { view } = await renderView();
    fireEvent.click(zoomIn());
    fireEvent.click(zoomOut());
    fireEvent.click(fit());
    expect(cameraMoves.durations).toEqual([0, 0, 0]);
    view.unmount();
  });

  it("a zoom press renders once", async () => {
    // AC-8, first performance row. The camera emits `updated` every animation
    // frame, but the component stores the derived edge, not the ratio, so the
    // frames between edges dedupe to nothing: an edge-crossing press commits
    // exactly once. (A mid-range press commits zero times, which is strictly
    // better and is why the ratio is not held in state.)
    const { default: GraphView } = await import("./GraphView");
    let commits = 0;
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <Profiler id="gv" onRender={() => { commits += 1; }}>
          <GraphView
            data={DATA}
            theme="dark"
            hiddenKinds={new Set()}
            selected={null}
            onSelect={() => {}}
            focusTick={0}
          />
        </Profiler>,
      );
    });
    const before = commits;
    await cameraRatio(0.005); // crosses to "min"
    expect(commits - before).toBe(1);
    view.unmount();
  });

  it("the camera listener is added once and removed", async () => {
    // AC-8, second performance row, and the mutation target: a listener left on a
    // camera that outlives its renderer leaks one per ontology opened, invisibly.
    const { view } = await renderView();
    expect(sigmaCalls.last.camera.__listeners()).toBe(1);
    view.unmount();
    expect(sigmaCalls.last.camera.__listeners()).toBe(0);
  });

  it("zoom makes no request", async () => {
    // AC-8, third performance row. Zooming is a camera move and nothing else;
    // GraphView reaches no network at all, and this holds it there.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { view } = await renderView();
    fetchSpy.mockClear();
    fireEvent.click(zoomIn());
    fireEvent.click(zoomOut());
    fireEvent.click(fit());
    expect(fetchSpy).not.toHaveBeenCalled();
    view.unmount();
  });
});
