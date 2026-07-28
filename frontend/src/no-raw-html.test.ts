/*
================================================================================
FILE: frontend/src/no-raw-html.test.ts
================================================================================

SUMMARY
    Asserts that `dangerouslySetInnerHTML` appears nowhere in the frontend
    source. This is trust boundary 3 from architecture.md turned into a test.

BASIC IDEA
    Loaded ontology files are untrusted input, and their labels, IRIs and
    literals are rendered throughout the interface. React escapes text by
    default, so the boundary holds for exactly as long as nobody reaches for
    raw HTML.

    The reason this test lives with the visual-defects work rather than with the
    security tests is that both defects it accompanies are about *overflowing
    text*, which is the situation where someone is most tempted to control
    rendering with markup. The temptation is the risk; this is the tripwire.

    Test files are excluded from the scan, because this file necessarily
    contains the string it is looking for.

INPUTS / INPUT SOURCES
    - Every .ts/.tsx file under frontend/src, read from disk.

EXPECTED OUTPUT
    - Pass/fail, covering AC-11.
================================================================================
*/

import { describe, expect, it } from "vitest";

// Vite's glob rather than node:fs, which would need @types/node added as a
// dependency for one assertion. `eager` inlines every match at build time, so
// the scan cannot silently read nothing at runtime.
const SOURCES = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Source files only. Test files quote the string and would match themselves. */
const PRODUCTION = Object.entries(SOURCES).filter(
  ([path]) => !/\.test\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path),
);

describe("trust boundary 3", () => {
  it("dangerouslySetInnerHTML appears nowhere in the source", () => {
    // AC-11. Ontology content must never be rendered as raw HTML.
    const offenders = PRODUCTION.filter(([, text]) =>
      text.includes("dangerouslySetInnerHTML"),
    ).map(([path]) => path);
    expect(offenders, `raw HTML rendering in: ${offenders.join(", ")}`).toEqual([]);

    // The scan itself must be working: an empty glob would pass vacuously
    // forever, which is the failure mode of every test shaped like this one.
    expect(PRODUCTION.length).toBeGreaterThan(10);
    expect(PRODUCTION.some(([path]) => path.includes("DetailPanel"))).toBe(true);
  });
});
