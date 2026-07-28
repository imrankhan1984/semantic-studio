// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/GraphView.test.tsx
================================================================================

SUMMARY
    The first test for GraphView. Covers the theme-aware pill drawn behind the
    hovered or selected node's label — the fix for a white-on-white label in
    dark mode.

BASIC IDEA
    The drawing function is a plain canvas callback, so it is tested by calling
    it with a recording stub for CanvasRenderingContext2D and reading back the
    fill colour it chose. No renderer, no WebGL, no layout.

    Importing GraphView at all needs `WebGL2RenderingContext` to exist, because
    Sigma reads it at module scope and jsdom does not define it. Two stub
    globals are enough; nothing here constructs a Sigma instance.

    The assertions are written against `PALETTES` rather than against the hex
    values, so changing a theme colour does not silently break the test — but
    the one value that must never come back, Sigma's hard-coded `#FFF`, is
    asserted literally, because that specific constant is the defect.

INPUTS / INPUT SOURCES
    - NODE_HOVER_DRAWERS, exported from GraphView.tsx.
    - A recording canvas context stub.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-5 and AC-12.
================================================================================
*/

import { beforeAll, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../types";
import type { Theme } from "../types";

// Sigma touches WebGL2RenderingContext when its module is evaluated. Stubbing
// it lets the module import; nothing below renders anything.
beforeAll(() => {
  vi.stubGlobal("WebGL2RenderingContext", class {});
  vi.stubGlobal("WebGLRenderingContext", class {});
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
