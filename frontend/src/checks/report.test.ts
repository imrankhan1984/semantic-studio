/*
================================================================================
FILE: frontend/src/checks/report.test.ts
================================================================================

SUMMARY
    The Checks report's rules (design-checks 5.4, 5.7, 5.9): the order of
    the groups, the summary, the measures' and level's lines, *Showing 100
    of N*, staleness, and where a finding leads.

BASIC IDEA
    Pure functions, tested without rendering, as the other logic folders are.

INPUTS / INPUT SOURCES
    - checks/report.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { CheckGroup, CheckMeasures, ChecksReport } from "../api";
import {
  destination,
  isStale,
  lastRun,
  levelLines,
  measureLines,
  orderGroups,
  showingLine,
  summaryLine,
} from "./report";

const group = (id: string, level: CheckGroup["level"], total: number): CheckGroup => ({
  id,
  level,
  heading: id,
  fix: "Fix it.",
  total,
  findings: Array.from({ length: Math.min(total, 100) }, (_, i) => ({ iri: `x:${i}`, sentence: `${i}` })),
});

const MEASURES: CheckMeasures = {
  counts: { classes: 27, properties: 20, concepts: 11, individuals: 67 },
  hierarchy: { depth: 3, widest: 6, tops: 8 },
  documentation: { documented: 54, terms: 58 },
  reuse: { namespaces: 4, reused: 12, used: 100 },
  level: { step: 6, of: 6, name: "Formal model with data", next: null },
};

describe("the Checks report's rules", () => {
  it("orders groups with findings first (Problems, then Worth a look, most first), then those that passed", () => {
    const ordered = orderGroups([
      group("A", "Worth a look", 5),
      group("B", "Problem", 0),
      group("C", "Problem", 4),
      group("D", "Worth a look", 0),
      group("E", "Problem", 4),
      group("F", "Worth a look", 9),
    ]);
    expect(ordered.map((g) => g.id)).toEqual(["C", "E", "F", "A", "B", "D"]);
    // A group that failed to run is no pass.
    expect(orderGroups([group("P", "Problem", 0), { ...group("Q", "Worth a look", 0), error: "Too slow." }]).map((g) => g.id)).toEqual(["Q", "P"]);
  });

  it("sums up the groups with findings, by level", () => {
    const groups = [group("A", "Problem", 4), group("B", "Problem", 2), group("C", "Worth a look", 1), group("D", "Problem", 0)];
    expect(summaryLine("Space Exploration", groups)).toBe("Space Exploration: 2 problems, 1 worth a look");
    expect(summaryLine("Space Exploration", [group("A", "Problem", 1)])).toBe("Space Exploration: 1 problem, 0 worth a look");
    expect(summaryLine("Clean", [group("A", "Problem", 0)])).toBe("Clean: every check passed");
  });

  it("says the measures and the level in words (5.7)", () => {
    expect(measureLines(MEASURES)).toEqual([
      "27 classes · 20 properties · 11 concepts · 67 individuals",
      "Hierarchy 3 deep, 6 at most under one parent, 8 top classes and concepts",
      "Documentation 54 of 58 terms labelled and defined (93%)",
      "Reuse 4 namespaces from other vocabularies · 12% of terms reused",
    ]);
    expect(levelLines(MEASURES)).toEqual(["Level: Formal model with data (step 6 of 6)"]);
    expect(
      levelLines({ ...MEASURES, level: { step: 3, of: 6, name: "Arranged in a hierarchy", next: "Relate two concepts." } }),
    ).toEqual(["Level: Arranged in a hierarchy (step 3 of 6)", "Next: Relate two concepts."]);
    const one = { ...MEASURES, counts: { classes: 1, properties: 1, concepts: 1, individuals: 1 } };
    expect(measureLines(one)[0]).toBe("1 class · 1 property · 1 concept · 1 individual");
  });

  it("says Showing 100 of N with the true total, and nothing when all are shown (AC-7)", () => {
    expect(showingLine(group("A", "Problem", 1500))).toBe("Showing 100 of 1,500");
    expect(showingLine(group("A", "Problem", 12))).toBeNull();
    expect(lastRun(213)).toBe("Last run 0.2 s");
  });

  it("is stale when the revision or the generation moved (AC-8)", () => {
    const report = { revision: 3, generation: 1 } as ChecksReport;
    expect(isStale(report, 3, 1)).toBe(false);
    expect(isStale(report, 4, 1)).toBe(true);
    expect(isStale(report, 3, 2)).toBe(true);
    expect(isStale(report, 3)).toBe(false);
  });

  it("leads a project's own term to Edit and anything else to Explore (AC-10)", () => {
    const base = "http://example.org/shop#";
    expect(destination({ iri: `${base}Person`, sentence: "" }, base, false)).toBe("edit");
    expect(destination({ iri: "http://xmlns.com/foaf/0.1/Person", sentence: "" }, base, false)).toBe("explore");
    expect(destination({ iri: "http://example.org/space#Lander", sentence: "" }, null, false)).toBe("explore");
    expect(destination({ iri: "http://example.org/shop", sentence: "", block: "header" }, base, false)).toBe("edit");
    expect(destination({ iri: "http://example.org/space", sentence: "", block: "header" }, null, false)).toBe("source");
    expect(destination({ iri: `${base}PersonRules`, sentence: "" }, base, true)).toBe("shapes");
  });
});
