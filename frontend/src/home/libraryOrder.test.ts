/*
================================================================================
FILE: frontend/src/home/libraryOrder.test.ts
================================================================================

SUMMARY
    The order of Home's one library (home-and-examples 5.5, AC-7;
    reference-ontologies 5.2, AC-2): the person's projects and files
    together, newest first, then the examples, then the reference
    ontologies, each in their fixed order; what counts as a bundled entry and
    as a reference; which are missing.

BASIC IDEA
    Pure functions over summaries, so no rendering. BUNDLED is checked
    against backend/app/examples/manifest.json read as text, keys, names and
    groups, so the server's order and the screen's cannot drift apart.

INPUTS / INPUT SOURCES
    - Summaries built below; the manifest file.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { BUNDLED, isExample, isReference, libraryEntries, missingBundled } from "./libraryOrder";
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
  const group = BUNDLED.find((b) => b.key === key)?.group ?? "example";
  return file(`ont-${key}`, "2099-01-01T00:00:00Z", {
    source: "example",
    example: { key, purpose: "p", group },
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

  it("puts the examples after the person's work however new they are, then the references, in the fixed order", () => {
    const entries = libraryEntries(
      [project("p-old", "2001-01-01T00:00:00Z")],
      [
        example("qudt"),
        example("foaf"),
        example("space"),
        file("f-old", "2000-01-01T00:00:00Z"),
        example("middle-earth"),
      ],
    );
    expect(ids(entries)).toEqual(["p-old", "f-old", "ont-space", "ont-middle-earth", "ont-foaf", "ont-qudt"]);
  });

  it("orders by group before position: a reference listed first in BUNDLED still follows the examples", () => {
    // The group decides, not the manifest's position alone: told the
    // other way round, the server's word is what places the entry.
    const space = example("space");
    const asReference = { ...space, example: { ...space.example!, group: "reference" as const } };
    expect(ids(libraryEntries([], [asReference, example("middle-earth"), example("qudt")]))).toEqual([
      "ont-middle-earth",
      "ont-space",
      "ont-qudt",
    ]);
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

describe("isReference", () => {
  it("is FOAF and QUDT, by the group, and never a person's own file", () => {
    expect(BUNDLED.filter((b) => isReference(example(b.key))).map((b) => b.key)).toEqual(["foaf", "qudt"]);
    expect(isReference(file("mine", undefined, { name: "QUDT" }))).toBe(false);
  });
});

describe("missingBundled", () => {
  it("names the entries not in the library, examples and references, in their order", () => {
    const names = (o: OntologySummary[]) => missingBundled(o).map((b) => b.name);
    expect(names([])).toEqual(["Space Exploration", "The Lord of the Rings", "FOAF (Friend of a Friend)", "QUDT"]);
    expect(names([example("middle-earth"), example("foaf"), file("f")])).toEqual(["Space Exploration", "QUDT"]);
    expect(names(BUNDLED.map((b) => example(b.key)))).toEqual([]);
  });
});

describe("BUNDLED", () => {
  it("is the server manifest's order, names and groups", () => {
    // Loaded first: a ?raw import that silently yields "" proves nothing.
    expect(MANIFEST.length).toBeGreaterThan(0);
    const manifest = JSON.parse(MANIFEST) as { examples: { key: string; name: string; group: string }[] };
    expect(manifest.examples.map(({ key, name, group }) => ({ key, name, group }))).toEqual([...BUNDLED]);
  });
});
