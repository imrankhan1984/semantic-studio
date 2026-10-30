/*
================================================================================
FILE: frontend/src/sparql/resultNodes.test.ts
================================================================================

SUMMARY
    Tests for sparql/resultNodes.ts (query-page-rework 5.2): which IRIs in
    the rows can be result nodes, the camera target that frames them, and
    the two sentences.

BASIC IDEA
    Pure functions over plain data, so each rule is one table of inputs.

INPUTS / INPUT SOURCES
    - Hand-built SparqlResults and points.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering parts of AC-2, AC-4 and AC-7.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { SparqlResults } from "../types";
import {
  RESULT_IRIS_SENT,
  SINGLE_RESULT_RATIO,
  frameTarget,
  resultIris,
  sendable,
  shownOnGraph,
  undrawnSentence,
} from "./resultNodes";

function results(rows: SparqlResults["rows"]): SparqlResults {
  return { vars: ["a", "b"], rows, rowCount: rows.length, truncated: false, durationMs: 1 };
}

describe("resultIris", () => {
  it("names every distinct IRI in row order; literals, blank nodes and unbound cells never", () => {
    const got = resultIris(
      results([
        [{ type: "uri", value: "http://x/B" }, { type: "literal", value: "http://x/L" }],
        [{ type: "bnode", value: "b0" }, { type: "uri", value: "http://x/A" }],
        [{ type: "uri", value: "http://x/B" }, null],
      ]),
    );
    expect(got).toEqual(["http://x/B", "http://x/A"]);
    expect(resultIris(null)).toEqual([]);
  });
});

describe("frameTarget", () => {
  it("centres on the box of the points, the ratio its larger side with a margin", () => {
    const target = frameTarget([
      { x: 0.2, y: 0.4 },
      { x: 0.8, y: 0.5 },
      { x: 0.5, y: 0.45 },
    ])!;
    expect(target.x).toBeCloseTo(0.5, 6);
    expect(target.y).toBeCloseTo(0.45, 6);
    expect(target.ratio).toBeGreaterThan(0.6);
    expect(target.ratio).toBeLessThan(1);
  });

  it("one result is centred at the zoom a search pick uses", () => {
    expect(frameTarget([{ x: 0.3, y: 0.7 }])).toEqual({ x: 0.3, y: 0.7, ratio: SINGLE_RESULT_RATIO });
  });

  it("a tight cluster is never closer than one result, a spread never past the whole graph", () => {
    expect(frameTarget([{ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }])!.ratio).toBe(SINGLE_RESULT_RATIO);
    expect(frameTarget([{ x: -2, y: 0 }, { x: 2, y: 0 }])!.ratio).toBeLessThanOrEqual(1.2);
  });

  it("nothing to frame is null", () => {
    expect(frameTarget([])).toBeNull();
  });
});

describe("the sentences", () => {
  it("the announcement counts the entities on the graph, and says nothing for none (wording 5.5, AC-6)", () => {
    expect(shownOnGraph(33)).toBe("33 entities shown on the graph.");
    expect(shownOnGraph(1)).toBe("1 entity shown on the graph.");
    expect(shownOnGraph(1200)).toBe("1,200 entities shown on the graph.");
    expect(shownOnGraph(0)).toBeNull();
  });

  it("the header names the true total only when some were left undrawn", () => {
    expect(undrawnSentence(200, 340)).toBe("The graph shows 200 of the 340 results it had not drawn.");
    expect(undrawnSentence(12, 12)).toBeNull();
  });
});

describe("sendable (the /nodes body's bounds)", () => {
  it("leaves out an IRI longer than the server takes, never the whole request", () => {
    const long = `http://x/${"a".repeat(5000)}`;
    expect(sendable(["http://x/A", long, "http://x/B"])).toEqual(["http://x/A", "http://x/B"]);
  });

  it("stops before 4 MB, counted in UTF-8 bytes", () => {
    // 2,000 IRIs of 1,100 two-byte characters: 4.4 MB in bytes, 2.2 M characters.
    const wide = Array.from({ length: 2000 }, (_, i) => `http://x/${i}/${"é".repeat(1100)}`);
    const sent = sendable(wide);
    expect(sent.length).toBeGreaterThan(1500);
    expect(sent.length).toBeLessThan(2000);
    const bytes = new TextEncoder().encode(JSON.stringify({ iris: sent })).length;
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("stops at RESULT_IRIS_SENT IRIs, the first ones, well inside 4 MB", () => {
    // 25,000 short IRIs are about 0.5 MB: only the count can stop them.
    const many = Array.from({ length: 25000 }, (_, i) => `http://x/E${i}`);
    const sent = sendable(many);
    expect(RESULT_IRIS_SENT).toBe(20000);
    expect(sent.length).toBe(RESULT_IRIS_SENT);
    expect(sent).toEqual(many.slice(0, RESULT_IRIS_SENT));
  });
});
