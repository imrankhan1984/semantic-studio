/*
================================================================================
FILE: frontend/src/types.test.ts
================================================================================

SUMMARY
    Guards the shared graph palettes. Every theme must define every colour the
    renderer reads, including the label background added to fix the
    white-on-white selected label.

BASIC IDEA
    PALETTES is a plain constant, so this is a pure test with no DOM. It exists
    because a new theme, or a new palette field, is the kind of change that
    compiles cleanly and then renders wrongly: TypeScript catches a missing
    field, but not a field set to the same value as the text it sits behind.

INPUTS / INPUT SOURCES
    - PALETTES from types.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-3.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { KIND_LABELS, PALETTES } from "./types";
import type { GraphPalette, Theme } from "./types";

const THEMES: Theme[] = ["dark", "light"];

// Every colour the graph renderer reads from a palette.
const REQUIRED: (keyof GraphPalette)[] = [
  "kind",
  "edge",
  "defaultEdge",
  "dimNode",
  "dimEdge",
  "label",
  "labelBackground",
  "edgeLabel",
  "background",
  "selectedRing",
];

/** The canonical set of node kinds: whatever the legend can name. Every one must
 *  have a colour in both themes, or a node of that kind falls back to "other". */
const KINDS = Object.keys(KIND_LABELS);

/** The alpha of an 8-digit #RRGGBBAA colour, as a float in [0, 1]. */
function alphaOf(color: string): number {
  const match = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(color);
  return match ? parseInt(match[1], 16) / 255 : 1;
}

describe("graph palettes", () => {
  it("palette carries a labelBackground for every theme", () => {
    // AC-3. A theme missing this renders Sigma's hard-coded #FFF instead.
    for (const theme of THEMES) {
      const palette = PALETTES[theme];
      for (const field of REQUIRED) {
        expect(palette[field], `${theme}.${String(field)}`).toBeDefined();
      }
      expect(palette.labelBackground).toMatch(/^#[0-9a-f]{6}$/i);
      // The pill must contrast with the text drawn on it. Equal values are
      // exactly the defect this spec fixes, so equality is the failure.
      expect(palette.labelBackground.toLowerCase()).not.toBe(palette.label.toLowerCase());
    }
  });

  it("every kind has a colour in both themes", () => {
    // AC-5 of graph-legibility. A repalette that drops a kind, or a new kind
    // added to KIND_LABELS without a colour, would silently fall back to "other"
    // and lose a distinction the legend claims to make.
    for (const theme of THEMES) {
      for (const kind of KINDS) {
        expect(PALETTES[theme].kind[kind], `${theme}.${kind}`).toBeDefined();
      }
    }
  });

  it("every kind colour differs from the canvas background", () => {
    // AC-5. Lower saturation is exactly where contrast against the canvas is
    // hardest, so a pastel that matched the background would vanish. The two
    // themes have different backgrounds and are checked against their own.
    for (const theme of THEMES) {
      const bg = PALETTES[theme].background.toLowerCase();
      for (const kind of KINDS) {
        expect(PALETTES[theme].kind[kind].toLowerCase(), `${theme}.${kind}`).not.toBe(bg);
      }
    }
  });

  it("no two kind colours are identical", () => {
    // AC-6. Eleven kinds carried by colour alone is near the limit, and lowering
    // saturation shrinks the distance between them; two that collapsed to the
    // same value would be indistinguishable. Compared case-insensitively so a
    // #AABBCC / #aabbcc pair still counts as a clash.
    for (const theme of THEMES) {
      const colours = KINDS.map((k) => PALETTES[theme].kind[k].toLowerCase());
      expect(new Set(colours).size, theme).toBe(colours.length);
    }
  });

  it("node fills carry an alpha below 1", () => {
    // AC-7. The transparency G-8 asked for, so overlapping nodes at density read
    // as a blend rather than a wall of solid discs. Encoded as the last two hex
    // digits of an 8-digit colour; a 6-digit value would be fully opaque and
    // fail here.
    for (const theme of THEMES) {
      for (const kind of KINDS) {
        const colour = PALETTES[theme].kind[kind];
        expect(colour, `${theme}.${kind}`).toMatch(/^#[0-9a-f]{8}$/i);
        expect(alphaOf(colour), `${theme}.${kind} alpha`).toBeLessThan(1);
      }
    }
  });
});
