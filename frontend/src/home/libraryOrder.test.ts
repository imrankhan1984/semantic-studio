/*
================================================================================
FILE: frontend/src/home/libraryOrder.test.ts
================================================================================

SUMMARY
    The order of Home's one library (home-and-examples 5.5, AC-7): the
    person's projects and files together, newest first, then the examples in
    their fixed order; what counts as an example; which are missing.

BASIC IDEA
    Pure functions over summaries, so no rendering. EXAMPLE_ORDER is checked
    against backend/app/examples/manifest.json read as text, so the server's
    order and the screen's cannot drift apart.

INPUTS / INPUT SOURCES
    - Summaries built below; the manifest file.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { EXAMPLE_ORDER, isExample, libraryEntries, missingExamples } from "./libraryOrder";
import type { OntologySummary, ProjectSummary } from "../types";
// The server's manifest, read as text as AboutPanel.test.tsx reads LICENSE.
import MANIFEST from "../../../backend/app/examples/manifest.json?raw";

function file(id: string, addedAt?: string, extra: Partial<OntologySummary> = {}): OntologySummary {
  return {
    id,
    name: id,
    source: "upload",
    format: "turtle",
    triples: 1,
    nodes: 1,
    edges: 0,
    kindCounts: {},
    namespaces: {},
    addedAt,
    ...extra,
  };
}

function example(key: string): OntologySummary {
  return file(`ont-${key}`, "2099-01-01T00:00:00Z", {
    source: "example",
    example: { key, purpose: "p" },
  });
}

function project(id: string, updatedAt: string): ProjectSummary {
  return {
    id,
    name: id,
    createdAt: updatedAt,
    updatedAt,
    baseIri: "http://example.org/x#",
    prefix: "x",
    primaryLanguage: "en",
    languages: [],
    documents: [],
    counts: { classes: 0, properties: 0, concepts: 0 },
    kind: "ontology",
  };
}

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);

describe("libraryEntries", () => {
  it("dates a project by its last change and a file by when it was added, as one list", () => {
    const entries = libraryEntries(
      [project("p-mid", "2026-06-01T00:00:00Z"), project("p-new", "2026-10-01T00:00:00Z")],
      [file("f-old", "2026-01-01T00:00:00Z"), file("f-newest", "2026-10-02T00:00:00Z")],
    );
    expect(ids(entries)).toEqual(["f-newest", "p-new", "p-mid", "f-old"]);
  });

  it("puts the examples after the person's work however new they are, in the fixed order", () => {
    const entries = libraryEntries(
      [project("p-old", "2001-01-01T00:00:00Z")],
      [example("foaf"), example("space"), file("f-old", "2000-01-01T00:00:00Z"), example("middle-earth")],
    );
    expect(ids(entries)).toEqual(["p-old", "f-old", "ont-space", "ont-middle-earth", "ont-foaf"]);
  });

  it("sorts an undated file after the dated ones, never before", () => {
    const entries = libraryEntries([], [file("undated"), file("dated", "2020-01-01T00:00:00Z")]);
    expect(ids(entries)).toEqual(["dated", "undated"]);
  });

  it("an example is told by its source and its record, never its name", () => {
    // A person's own file may be called FOAF; it is theirs, and sorts with
    // their work.
    const own = file("mine", "2026-10-01T00:00:00Z", { name: "FOAF (Friend of a Friend)" });
    expect(isExample(own)).toBe(false);
    expect(isExample(file("x", undefined, { source: "example" }))).toBe(false);
    expect(isExample(example("foaf"))).toBe(true);
    expect(ids(libraryEntries([], [example("foaf"), own]))).toEqual(["mine", "ont-foaf"]);
  });
});

describe("missingExamples", () => {
  it("names the keys not in the library, in their order", () => {
    expect(missingExamples([])).toEqual(["space", "middle-earth", "foaf"]);
    expect(missingExamples([example("middle-earth"), file("f")])).toEqual(["space", "foaf"]);
    expect(missingExamples(EXAMPLE_ORDER.map(example))).toEqual([]);
  });
});

describe("EXAMPLE_ORDER", () => {
  it("is the server manifest's order", () => {
    // Loaded first: a ?raw import that silently yields "" proves nothing.
    expect(MANIFEST.length).toBeGreaterThan(0);
    const manifest = JSON.parse(MANIFEST) as { examples: { key: string }[] };
    expect(manifest.examples.map((e) => e.key)).toEqual([...EXAMPLE_ORDER]);
  });
});
