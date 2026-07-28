/*
================================================================================
FILE: frontend/src/focus-visible.test.ts
================================================================================

SUMMARY
    Asserts that the application has one global focus ring and that nothing
    suppresses focus indication. Defect 3 of visual-defects.md.

BASIC IDEA
    jsdom does not do layout or cascade resolution, so there is no way to focus
    an element and measure its ring in vitest. What can be checked is the
    stylesheet itself, and the stylesheet is where this defect lived: someone
    wrote `outline: none` on inputs and selects, and no `:focus-visible` rule
    existed anywhere.

    So this reads index.css as text. That is a blunt instrument and it is the
    right one here: the assertions are about a rule existing and another not,
    which is exactly what the source shows. The ring's appearance is confirmed
    in a browser, as Section 11 of the spec requires.

    Comments are stripped before the suppression check, so a rule quoted inside
    an explanatory comment cannot fail the test — and cannot hide a real one.

INPUTS / INPUT SOURCES
    - frontend/src/index.css, imported as raw text by Vite.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-14 to AC-17.
================================================================================
*/

import { describe, expect, it } from "vitest";
// Vite's `?raw` import rather than node:fs, which would need @types/node added
// as a dependency for four assertions. This also resolves relative to the
// module rather than the working directory.
import CSS from "./index.css?raw";

/** The stylesheet with /* … *\/ comments removed, so prose cannot match. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("focus indication", () => {
  // Three of the assertions below are negative — "no rule does X". Against an
  // empty string every one of them passes. That is not hypothetical: vitest
  // stubs CSS out of the module graph by default, and this file silently read
  // "" until `test.css` was enabled in vite.config.ts. Fail loudly instead.
  it("actually loaded the stylesheet", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS).toContain(".detail-table");
    expect(CSS).toContain("--accent");
  });

  it("a global focus-visible rule exists", () => {
    // AC-14. Not scoped to a component: five specs promised a visible focus
    // indicator on the strength of a rule that did not exist.
    const global = RULES.match(/(^|\})\s*:focus-visible\s*\{([^}]*)\}/);
    expect(global, "no global :focus-visible rule in index.css").not.toBeNull();

    const body = global![2];
    expect(body).toMatch(/outline\s*:/);
    // An outline of `none` or `0` would satisfy "a rule exists" and show
    // nothing, which is the defect wearing a different hat.
    expect(body).not.toMatch(/outline\s*:\s*(none|0)\s*;/);
  });

  it("no rule suppresses outline on focus", () => {
    // AC-15. The `input:focus, select:focus { outline: none }` block was the
    // defect itself: it removed the ring from the ontology dropdown and the
    // search box, two of the few elements a keyboard user can reach at all.
    const suppressions = [...RULES.matchAll(/([^{}]*):focus\b([^{}]*)\{([^}]*)\}/g)].filter(
      ([, , , body]) => /outline\s*:\s*(none|0)\s*[;}]/.test(body),
    );
    expect(
      suppressions.map((m) => m[0].trim()),
      "a rule still removes the focus outline",
    ).toEqual([]);

    // And specifically the pair this spec removed.
    expect(RULES).not.toMatch(/input:focus\s*,\s*select:focus\s*\{[^}]*outline\s*:\s*none/);
  });

  it("the focus ring uses the accent colour, not a hard-coded value", () => {
    // AC-16. A literal colour would be correct in one theme and wrong in the
    // other; var(--accent) is defined per theme and is what .chip.open already
    // uses for the same purpose.
    const global = RULES.match(/(^|\})\s*:focus-visible\s*\{([^}]*)\}/);
    const body = global![2];
    expect(body).toContain("var(--accent)");
    expect(body).not.toMatch(/outline[^;]*#[0-9a-f]{3,8}/i);
  });

  it("the graph-notice comment no longer claims there is no global rule", () => {
    // AC-17. The comment was written when the scoped rule was the only one.
    // Left as it was, it is how the next reader concludes there still is none.
    expect(CSS).not.toMatch(/no global focus-visible rule/i);
    expect(CSS).not.toMatch(/application has no global/i);

    // The scoped rule itself is gone, superseded by the global one rather than
    // left as a duplicate that could drift away from it.
    expect(RULES).not.toMatch(/\.graph-notice\s+button:focus-visible/);
  });
});
