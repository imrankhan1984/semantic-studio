/*
================================================================================
FILE: frontend/src/links.test.ts
================================================================================

SUMMARY
    CF-7 (D-088): only http: and https: IRIs become links, and nothing in the
    source makes a link any other way.

BASIC IDEA
    Two halves. The helper is tested on the schemes a file can carry,
    including the disguises a prefix test alone would miss. Then every .tsx
    file is scanned: each `href={…}` must be `linkTarget(…)` itself, or a name
    the same file assigns from `linkTarget(`. A new link written straight from
    an IRI fails here before it can reach a browser.

INPUTS / INPUT SOURCES
    - links.ts; every .tsx under frontend/src, read as raw text through Vite's
      glob, as no-raw-html.test.ts does.

EXPECTED OUTPUT
    - Pass/fail for AC-7.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { linkTarget } from "./links";

const SOURCES = import.meta.glob("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PRODUCTION = Object.entries(SOURCES).filter(([path]) => !/\.test\.tsx$/.test(path));

describe("linkTarget", () => {
  it("links http and https IRIs unchanged", () => {
    expect(linkTarget("http://example.org/a#B")).toBe("http://example.org/a#B");
    expect(linkTarget("HTTPS://example.org/x")).toBe("HTTPS://example.org/x");
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "urn:isbn:0451450523",
    "mailto:someone@example.org",
    "vbscript:msgbox(1)",
    "//example.org/relative",
    "http:/one-slash",
    "",
  ])("refuses %j", (iri) => {
    expect(linkTarget(iri)).toBeUndefined();
  });

  it("refuses what is not a string", () => {
    expect(linkTarget(null)).toBeUndefined();
    expect(linkTarget(undefined)).toBeUndefined();
  });
});

describe("the source scan", () => {
  it("every href in the source goes through linkTarget", () => {
    // The scan must be reading files, or it passes vacuously forever.
    expect(PRODUCTION.length).toBeGreaterThan(10);
    expect(PRODUCTION.some(([path]) => path.endsWith("DetailPanel.tsx"))).toBe(true);
    expect(PRODUCTION.some(([, text]) => text.includes("href={"))).toBe(true);

    const offenders: string[] = [];
    for (const [path, text] of PRODUCTION) {
      for (const match of text.matchAll(/href=\{\s*([^}]*)\}/g)) {
        const expression = match[1].trim();
        if (expression.startsWith("linkTarget(")) continue;
        const name = /^[A-Za-z_$][\w$]*$/.test(expression) ? expression : null;
        const assigned =
          name !== null && new RegExp(String.raw`\b${name}\s*=\s*linkTarget\(`).test(text);
        if (!assigned) offenders.push(`${path}: href={${expression}}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
