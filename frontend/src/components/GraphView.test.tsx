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

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { PALETTES } from "../types";
import type { Theme, VizGraph } from "../types";

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
    getNodeDisplayData() {
      return null;
    }
    getCamera() {
      return { animate() {}, animatedReset() {}, animatedZoom() {}, animatedUnzoom() {} };
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
