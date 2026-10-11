/*
================================================================================
FILE: frontend/src/canvas/kindColours.test.ts
================================================================================

SUMMARY
    The test for kindColours.ts (edit-page-rework 5.8, AC-8): every token
    pair meets its contrast floor in both themes, index.css carries exactly
    these values in both theme blocks, and a box is named by its kind.

BASIC IDEA
    Pure arithmetic, no rendering. The floors are 5.8's measured ones: a line
    against the canvas 3.7:1 (light) and 7.5:1 (dark); a kind word against
    its tint 5.1:1 and 7.7:1 (5.8 rounds the lightest, 5.175, to 5.2); body
    text on a tint 12.9:1 and 9.3:1. The stylesheet is read as text (`?raw`,
    with `test.css` on), and the test first asserts it loaded.

INPUTS / INPUT SOURCES
    - kindColours.ts; index.css as text.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import CSS from "../index.css?raw";
import {
  BODY_TEXT,
  CANVAS_BG,
  LINES,
  RELATIONSHIP_TINT,
  TOKENS,
  boxKind,
  contrast,
  kindWord,
  type Theme,
} from "./kindColours";

const THEMES: Theme[] = ["light", "dark"];
const FLOORS: Record<Theme, { line: number; word: number; body: number }> = {
  light: { line: 3.7, word: 5.1, body: 12.9 },
  dark: { line: 7.5, word: 7.7, body: 9.3 },
};

/** The declarations of one theme's :root block. */
function themeBlock(theme: Theme): string {
  const selector = theme === "dark" ? ':root[data-theme="dark"] {' : ':root[data-theme="light"] {';
  const start = CSS.indexOf(selector);
  expect(start, `no ${theme} block`).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf("}", start));
}

const declared = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];

describe("kind colours (edit-page-rework 5.8)", () => {
  it("actually loaded the stylesheet", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS).toContain("--kind-owl-accent");
  });

  it("is the arithmetic WCAG uses", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(contrast("#4a72a8", "#ffffff")).toBe(contrast("#ffffff", "#4a72a8"));
  });

  it.each(THEMES)("every line is readable on the %s canvas", (theme) => {
    for (const [kind, colour] of Object.entries(LINES[theme])) {
      expect(contrast(colour, CANVAS_BG[theme]), `${kind} line, ${theme}`).toBeGreaterThanOrEqual(FLOORS[theme].line);
    }
  });

  it.each(THEMES)("every kind word is readable on its tint, and body text on every tint (%s)", (theme) => {
    for (const [kind, { tint, ink }] of Object.entries(TOKENS[theme])) {
      expect(contrast(ink, tint), `${kind} word, ${theme}`).toBeGreaterThanOrEqual(FLOORS[theme].word);
      expect(contrast(BODY_TEXT[theme], tint), `text on ${kind}, ${theme}`).toBeGreaterThanOrEqual(FLOORS[theme].body);
    }
    expect(contrast(BODY_TEXT[theme], RELATIONSHIP_TINT[theme])).toBeGreaterThanOrEqual(FLOORS[theme].body);
  });

  it.each(THEMES)("index.css carries these values in the %s theme", (theme) => {
    const block = themeBlock(theme);
    for (const [kind, token] of Object.entries(TOKENS[theme])) {
      for (const part of ["accent", "tint", "ink"] as const) {
        expect(declared(block, `kind-${kind}-${part}`), `--kind-${kind}-${part}`).toBe(token[part]);
      }
    }
    for (const [kind, colour] of Object.entries(LINES[theme])) {
      expect(declared(block, `line-${kind}`), `--line-${kind}`).toBe(colour);
    }
    expect(declared(block, "line-relationship-tint")).toBe(RELATIONSHIP_TINT[theme]);
    expect(declared(block, "canvas-bg")).toBe(CANVAS_BG[theme]);
    expect(declared(block, "text")).toBe(BODY_TEXT[theme]);
  });

  it("names a box by its kind: owl:Class (or both), rdfs:Class alone, a concept, an import", () => {
    expect(boxKind({ kind: "class" })).toBe("owl");
    expect(boxKind({ kind: "class", classType: "owl" })).toBe("owl");
    expect(boxKind({ kind: "class", classType: "rdfs" })).toBe("rdfs");
    expect(boxKind({ kind: "concept" })).toBe("concept");
    expect(kindWord({ kind: "class" })).toBe("OWL class");
    expect(kindWord({ kind: "class", classType: "rdfs" })).toBe("RDFS class");
    expect(kindWord({ kind: "concept" })).toBe("concept");
    expect(kindWord({ kind: "class", imported: "FOAF" })).toBe("imported · FOAF");
    expect(kindWord({ kind: "class", imported: "outside" })).toBe("outside this model");
  });
});
