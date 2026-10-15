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

describe("one button set (portal-foundations 5.5, AC-8)", () => {
  const HEIGHTS = new Set(["var(--btn-sm)", "var(--btn-md)", "var(--btn-lg)", "28px", "32px", "40px"]);

  /** Every rule as [selector, body], comments gone. */
  const rules = [...RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
  /** A rule that sizes a button: its selector names one, by element or class. */
  const forButtons = rules.filter(([sel]) => /\bbutton\b|-btn\b|-button\b/.test(sel));

  it("the three heights are 28, 32 and 40 px", () => {
    expect(RULES).toMatch(/--btn-sm:\s*28px;/);
    expect(RULES).toMatch(/--btn-md:\s*32px;/);
    expect(RULES).toMatch(/--btn-lg:\s*40px;/);
  });

  it("every button height set in the file is 28, 32 or 40 px", () => {
    expect(forButtons.length).toBeGreaterThan(30);
    const odd: string[] = [];
    for (const [sel, body] of forButtons) {
      for (const m of body.matchAll(/(?<![-\w])(height|min-height|max-height):\s*([^;]+);/g)) {
        if (!HEIGHTS.has(m[2].trim())) odd.push(`${sel.replace(/\s+/g, " ")} { ${m[1]}: ${m[2]} }`);
      }
    }
    expect(odd).toEqual([]);
  });

  it("the set's default is 32 px with a 6 px radius, .small 28 and .large 40", () => {
    const set = rules.find(([sel]) => sel.startsWith(":where(button:not("));
    expect(set, "the set's rule").toBeDefined();
    expect(set![1]).toMatch(/height:\s*var\(--btn-md\);/);
    expect(set![1]).toMatch(/border-radius:\s*6px;/);
    expect(rules.find(([sel]) => /button\.small/.test(sel))![1]).toMatch(/height:\s*var\(--btn-sm\);/);
    expect(rules.find(([sel]) => /button\.large/.test(sel))![1]).toMatch(/height:\s*var\(--btn-lg\);/);
  });

  it("the bespoke button classes take their size from the set", () => {
    const BESPOKE = [
      ".header-icon-btn", ".tool-btn", ".zoom-btn", ".pager-btn", ".link-btn", ".edit-btn",
      ".expand-btn", ".onto-menu-btn", ".hierarchy-menu-btn", ".canvas-help-button", "button.icon-btn",
    ];
    for (const cls of BESPOKE) {
      // A class's own rules; the set's :where() rules are what size it.
      const own = rules.filter(([sel]) => !sel.startsWith(":where(") && sel.split(",").some((s) => s.trim() === cls));
      for (const [, body] of own) {
        // Placement may stay (width: 100%, margins); a size may not.
        expect(body, cls).not.toMatch(/(?<![-\w])(height|padding|font-size):/);
        expect(body, cls).not.toMatch(/(?<![-\w])(min-)?width:\s*\d+px/);
        // 0 only for the zoom stack, three buttons joined into one control.
        for (const m of body.matchAll(/border-radius:\s*([^;]+);/g)) expect(["0", "6px"], cls).toContain(m[1].trim());
      }
    }
  });

  it("the plain button rule sets no font or padding, which would outrank the set", () => {
    // Element specificity beats :where()'s none: a padding on `button` kept
    // every icon button 24 px narrower than its square, and a font on it
    // kept every button at the inherited size. Measured in Chrome.
    const plain = rules.filter(([sel]) => sel === "button");
    expect(plain.length).toBeGreaterThan(0);
    for (const [, body] of plain) expect(body).not.toMatch(/(?<![-\w])(padding|font|font-size|height):/);
  });

  it("the turned-off look is on aria-disabled", () => {
    const off = rules.find(([sel]) => sel.split(",").some((s) => s.trim() === 'button[aria-disabled="true"]'));
    expect(off, 'a button[aria-disabled="true"] rule').toBeDefined();
    expect(off![1]).toMatch(/opacity:\s*0\.5;/);
    // The old look, on the attribute authoring controls must not carry.
    expect(rules.some(([sel]) => sel === "button.primary:disabled")).toBe(false);
  });
});
