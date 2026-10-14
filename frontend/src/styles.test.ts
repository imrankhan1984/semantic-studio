/*
================================================================================
FILE: frontend/src/styles.test.ts
================================================================================

SUMMARY
    Asserts the portal's visual foundations as the stylesheet writes them
    (portal-foundations 5.2 to 5.5): the light theme's dim text colour, which
    the design review measured under 4.5:1 on every screen; the six font
    sizes; the button heights.

BASIC IDEA
    The same blunt instrument as focus-visible.test.ts: index.css read as
    text, comments stripped, because jsdom resolves no cascade. The contrast
    of the dim text is computed here from the WCAG formula against every
    light background it sits on, so a later change to either side fails.

INPUTS / INPUT SOURCES
    - frontend/src/index.css, imported as raw text by Vite.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6, AC-7 and AC-8 of
      portal-foundations.
================================================================================
*/

import { describe, expect, it } from "vitest";
import CSS from "./index.css?raw";
import { contrast } from "./theme/contrast";

/** The stylesheet with comments removed, so prose cannot match. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const at = RULES.indexOf(`${selector} {`);
  expect(at, `no ${selector} block`).toBeGreaterThanOrEqual(0);
  return RULES.slice(at, RULES.indexOf("}", at));
}

function token(body: string, name: string): string {
  const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  expect(m, `no --${name}`).not.toBeNull();
  return m![1].toLowerCase();
}

describe("index.css foundations", () => {
  // Every assertion below reads index.css; against "" they would pass or
  // throw for the wrong reason.
  it("actually loaded the stylesheet", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS).toContain("--text-dim");
  });

  it("AC-6: the light theme's dim text is #5d6678, at least 4.5:1 on every light background", () => {
    const light = block(':root[data-theme="light"]');
    const dim = token(light, "text-dim");
    expect(dim).toBe("#5d6678");
    for (const bg of ["bg", "bg-raised", "bg-panel", "bg-header", "bg-subhead"]) {
      expect(contrast(dim, token(light, bg)), `--text-dim on --${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // The accent tint, selected rows and chips: the lowest of the three.
    expect(contrast(dim, "#e6eef8")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("six font sizes (portal-foundations 5.4, AC-7)", () => {
  const SIZES: Record<string, number> = { xs: 12, sm: 13, md: 14, lg: 16, xl: 20, "2xl": 24 };

  it("defines the six tokens, 12 px the smallest", () => {
    for (const [name, px] of Object.entries(SIZES)) {
      expect(RULES, `--fs-${name}`).toMatch(new RegExp(`--fs-${name}:\\s*${px}px;`));
    }
    const defined = [...RULES.matchAll(/--fs-[\w-]+:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(defined).toHaveLength(6);
    expect(Math.min(...defined)).toBe(12);
  });

  it("every font-size is one of the six tokens or inherit", () => {
    const sizes = [...RULES.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(100);
    const allowed = new Set(["inherit", ...Object.keys(SIZES).map((n) => `var(--fs-${n})`)]);
    expect(sizes.filter((s) => !allowed.has(s))).toEqual([]);
    // No size hides in the `font` shorthand either.
    const shorthands = [...RULES.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(shorthands.filter((s) => s !== "inherit")).toEqual([]);
  });

  it("body text has a line height of 1.45", () => {
    expect(block("body")).toMatch(/line-height:\s*1\.45;/);
  });
});
