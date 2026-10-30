/*
================================================================================
FILE: frontend/src/wording.test.ts
================================================================================

SUMMARY
    No text a person reads says *triple* or *triples* (home-and-examples 5.7,
    AC-9): the word is *statement*. Code names keep *triples* (`summary.triples`,
    the API), and *N-Triples* is a format's name, so both are allowed.

    And no text names a *“Load”* button (wording-and-query-export 5.1,
    AC-1): U-17 removed it, and two empty states went on sending people to
    it. Home's actions are *Open a file* and *Load from a URL*.

BASIC IDEA
    Every source file is read as text (`import.meta.glob` with `?raw`, as
    ModelCanvas.test.tsx scans for `@xyflow/react`), its comments are taken
    out, and what is left is searched for the word standing on its own: not
    after a dot (a property), not inside an identifier, not before a colon
    (a type or a key). What remains is a string or JSX text, which a person
    reads. The scanner is tested on samples first, so a scan that matched
    nothing because it was broken would fail rather than pass.

INPUTS / INPUT SOURCES
    - Every .ts and .tsx file under src/, tests excluded.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Block comments, JSX comments and line comments out. A line comment is one
 *  that starts a line or follows whitespace, so the `//` in a URL stays. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** The places the word stands as words a person reads. */
function visibleTriples(source: string): string[] {
  const text = withoutComments(source).replace(/N-Triples/g, "");
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (/(?<![.\w])triples?\b(?!\s*[:?=(])/i.test(line)) found.push(line.trim());
  }
  return found;
}

describe("visibleTriples, the scanner", () => {
  it("finds the word in a string and in JSX text", () => {
    expect(visibleTriples('const size = "~3 MB · 17k triples";')).toHaveLength(1);
    expect(visibleTriples("<span>{n.toLocaleString()} triples</span>")).toHaveLength(1);
    expect(visibleTriples("label: `One triple`,")).toHaveLength(1);
  });

  it("leaves code names, comments and the N-Triples format alone", () => {
    expect(visibleTriples("statementCount(summary.triples)")).toEqual([]);
    expect(visibleTriples("  triples: number;")).toEqual([]);
    expect(visibleTriples("const AUTO_PREVIEW_MAX_TRIPLES = 50000;")).toEqual([]);
    expect(visibleTriples("ontologyTriples={active.triples}")).toEqual([]);
    expect(visibleTriples('nt: "N-Triples",')).toEqual([]);
    expect(visibleTriples("// counts triples")).toEqual([]);
    expect(visibleTriples("/* the triples */ x")).toEqual([]);
    expect(visibleTriples('const u = "http://x/y"; // triples')).toEqual([]);
  });
});

describe("the word a person reads is statements (AC-9)", () => {
  it("no source file shows triple or triples", () => {
    const files = Object.entries(SOURCES).filter(([path]) => !/\.test\.tsx?$/.test(path));
    // Loaded first: a glob that silently found nothing would pass anything.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(([path]) => path.endsWith("/App.tsx"))).toBe(true);

    const offenders = files.flatMap(([path, source]) =>
      visibleTriples(source).map((line) => `${path}: ${line}`),
    );
    expect(offenders).toEqual([]);
  });
});

/** Places a button called Load is named: the word alone in quotes, or
 *  *Load button*. *Load from a URL* and the *Load dialog* are not buttons
 *  called Load. */
function namedLoad(source: string): string[] {
  return withoutComments(source)
    .split("\n")
    .filter((line) => /[“‘"'`]Load[”’"'`]|\bLoad button\b/.test(line))
    .map((line) => line.trim());
}

describe("no text names a Load button (wording 5.1, AC-1)", () => {
  it("the scanner finds a quoted Load and leaves other uses alone", () => {
    expect(namedLoad("<p>Use “Load” to upload a file.</p>")).toHaveLength(1);
    expect(namedLoad('const hint = "Press the Load button";')).toHaveLength(1);
    expect(namedLoad("label: 'Load',")).toHaveLength(1);
    expect(namedLoad('<button>Load from a URL</button>')).toEqual([]);
    expect(namedLoad("// the “Load” dialog")).toEqual([]);
    expect(namedLoad("loadOntology(id)")).toEqual([]);
  });

  it("no source file names one", () => {
    const files = Object.entries(SOURCES).filter(([path]) => !/\.test\.tsx?$/.test(path));
    expect(files.some(([path]) => path.endsWith("/components/GraphView.tsx"))).toBe(true);
    expect(files.some(([path]) => path.endsWith("/components/SourceView.tsx"))).toBe(true);
    const offenders = files.flatMap(([path, source]) => namedLoad(source).map((line) => `${path}: ${line}`));
    expect(offenders).toEqual([]);
  });
});
