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
import { PALETTES } from "./types";
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
];

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
});
