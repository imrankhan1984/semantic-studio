/*
================================================================================
FILE: frontend/src/styles.test.ts
================================================================================

SUMMARY
    Asserts the portal's visual foundations as the stylesheet writes them
    (portal-foundations 5.2): the light theme's dim text color, which the
    design review measured under 4.5:1 on every screen.

BASIC IDEA
    The same blunt instrument as focus-visible.test.ts: index.css read as
    text, comments stripped, because jsdom resolves no cascade. The contrast
    of the dim text is computed here from the WCAG formula against every
    light background it sits on, so a later change to either side fails.

INPUTS / INPUT SOURCES
    - frontend/src/index.css, imported as raw text by Vite.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6 of portal-foundations.
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
