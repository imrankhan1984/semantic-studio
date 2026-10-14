/*
================================================================================
FILE: frontend/src/theme/kinds.test.ts
================================================================================

SUMMARY
    Measures the one kind palette (portal-foundations 5.3) as it is drawn,
    and scans the sources for a kind colour written anywhere else.

BASIC IDEA
    A graph node is translucent, so its contrast is taken after compositing
    it over the graph background at GRAPH_ALPHA, the way the canvas shows it:
    an accent that passes opaque can fail as drawn (the object property was
    3.00:1 at 90 %). Every ink is read on its own tint, every edge on the
    graph background.

    The scan reads every production .ts/.tsx under src as text (Vite's glob,
    as links.test.ts does) and fails on any palette value outside this
    folder: a second copy of a kind's colour is how two palettes began.

INPUTS / INPUT SOURCES
    - KINDS, EDGES, GRAPH_ALPHA from theme/kinds.ts; PALETTES from types.ts.
    - The source files under frontend/src, as raw text.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-2 and AC-3 of portal-foundations.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { PALETTES } from "../types";
import { contrast, over } from "./contrast";
import { EDGES, GRAPH_ALPHA, KINDS, NEUTRAL_EDGE, type Theme } from "./kinds";

const THEMES: Theme[] = ["light", "dark"];

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PRODUCTION = Object.entries(SOURCES).filter(
  ([path]) => !/\.test\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path) && // This folder globs as "./": the palette itself.
    !path.startsWith("./"),
);

/** Every hex the palette writes, lower case, six digits. */
const PALETTE_HEX = new Set(
  THEMES.flatMap((t) => [
    ...Object.values(KINDS[t]).flatMap((k) => [k.accent, k.tint, k.ink]),
    ...Object.values(EDGES[t]),
    NEUTRAL_EDGE[t],
  ]).map((h) => h.toLowerCase()),
);

describe("the kind palette, as drawn (AC-3)", () => {
  // 5.3's measured floors, above AC-3's 3:1: at 90 % the light object
  // property is 3.03:1 and would pass a 3:1 test; at 95 % it is 3.24:1.
  const NODE_FLOOR: Record<Theme, number> = { light: 3.2, dark: 6.0 };

  it("every node is at least 3.2:1 light, 6.0:1 dark on the graph background, composited at its opacity", () => {
    for (const theme of THEMES) {
      const bg = PALETTES[theme].background;
      for (const [kind, { accent }] of Object.entries(KINDS[theme])) {
        const drawn = over(accent + GRAPH_ALPHA[theme], bg);
        expect(contrast(drawn, bg), `${theme}.${kind} as drawn`).toBeGreaterThanOrEqual(NODE_FLOOR[theme]);
      }
    }
  });

  it("the graph draws exactly those colours", () => {
    for (const theme of THEMES) {
      for (const [kind, { accent }] of Object.entries(KINDS[theme])) {
        expect(PALETTES[theme].kind[kind as keyof (typeof KINDS)[Theme]]).toBe(accent + GRAPH_ALPHA[theme]);
      }
    }
  });

  it("every kind word is at least 4.5:1 on its tint", () => {
    for (const theme of THEMES) {
      for (const [kind, { tint, ink }] of Object.entries(KINDS[theme])) {
        expect(contrast(ink, tint), `${theme}.${kind} ink on tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("every edge is at least 3.4:1 on the graph background (5.3)", () => {
    for (const theme of THEMES) {
      const bg = PALETTES[theme].background;
      for (const [kind, colour] of Object.entries(EDGES[theme])) {
        expect(contrast(colour, bg), `${theme}.${kind}`).toBeGreaterThanOrEqual(3.4);
      }
      expect(contrast(PALETTES[theme].defaultEdge, bg), `${theme} default edge`).toBeGreaterThanOrEqual(3.4);
    }
  });
});

/** The named surfaces that may write a hex, never a kind: the canvas
 *  background and body text; the graph's dimmed, label and background
 *  colours and the selection ring. One of them may equal a palette value by
 *  chance (the dark dimEdge is the dark "other" tint) and still not be one. */
const SURFACES: Record<string, RegExp> = {
  "../canvas/kindColours.ts": /^export const (CANVAS_BG|BODY_TEXT):/,
  "../types.ts": /^\s*(dimNode|dimEdge|label|labelBackground|edgeLabel|background|selectedRing):/,
};

describe("one place writes a kind's colour (AC-2)", () => {
  // The scan is only as good as what it read.
  it("read the sources", () => {
    expect(PRODUCTION.length).toBeGreaterThan(50);
    expect(PRODUCTION.some(([path]) => path === "../types.ts")).toBe(true);
    expect(PRODUCTION.some(([path]) => path === "../canvas/kindColours.ts")).toBe(true);
  });

  it("no source outside theme/ writes a palette colour", () => {
    const found: string[] = [];
    for (const [path, text] of PRODUCTION) {
      for (const line of text.split(/\r?\n/)) {
        if (SURFACES[path]?.test(line)) continue;
        for (const m of line.matchAll(/#[0-9a-f]{6}\b/gi)) {
          if (PALETTE_HEX.has(m[0].toLowerCase())) found.push(`${path}: ${m[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("canvas/kindColours.ts and types.ts hold no hex of their own for kinds", () => {
    for (const [path, rule] of Object.entries(SURFACES)) {
      const code = SOURCES[path].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const lines = code.split(/\r?\n/).filter((line) => /#[0-9a-f]{6}/i.test(line));
      expect(lines.length, `${path} read`).toBeGreaterThan(0);
      for (const line of lines) expect(line, path).toMatch(rule);
    }
  });
});
