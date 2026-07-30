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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
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

/** Every camera.animate target, in order, so "the camera arrived" is testable. */
const cameraMoves = vi.hoisted(() => ({ to: [] as { x: number; y: number }[] }));

// A Sigma that draws nothing and remembers everything it was given. Only the
// methods GraphView actually calls are implemented; anything else appearing
// here later means GraphView started calling something new, which is worth
// noticing rather than stubbing away with a Proxy.
vi.mock("sigma", () => {
  class FakeSigma {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(graph: any, container: any, settings: any) {
      sigmaCalls.last = { graph, container, settings };
    }
    on() {}
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
      return {
        animate(target: { x: number; y: number }) {
          cameraMoves.to.push({ x: target.x, y: target.y });
        },
        animatedReset() {},
        animatedZoom() {},
        animatedUnzoom() {},
      };
    }
  }
  return { default: FakeSigma };
});

/** Records every fillStyle assigned, in order, plus the calls that were made. */
function recordingContext() {
  const fills: string[] = [];
  const calls: string[] = [];
  const ctx = {
    set fillStyle(value: string) {
      fills.push(value);
    },
    get fillStyle() {
      return fills[fills.length - 1] ?? "";
    },
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
  };
  return { ctx, fills, calls };
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
