/*
================================================================================
FILE: frontend/src/statusWords.test.ts
================================================================================

SUMMARY
    The status bar's words (portal-foundations 5.6, AC-9): Home's count,
    singular, plural and zero, and the formats by their written names.

BASIC IDEA
    Pure functions, so a table of cases. App.test.tsx checks the same words
    reach the bar.

INPUTS / INPUT SOURCES
    - homeStatus and formatName from statusWords.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { formatName, homeStatus } from "./statusWords";

describe("homeStatus", () => {
  it.each([
    [2, 1, "2 projects · 1 ontology in the library"],
    [1, 2, "1 project · 2 ontologies in the library"],
    [1, 0, "1 project"],
    [0, 3, "3 ontologies in the library"],
    [0, 0, "Load an ontology or start a project to begin."],
  ])("%i projects, %i ontologies", (projects, ontologies, words) => {
    expect(homeStatus(projects, ontologies)).toBe(words);
  });
});

describe("formatName", () => {
  it.each([
    ["turtle", "Turtle"],
    ["xml", "RDF/XML"],
    ["json-ld", "JSON-LD"],
    ["nt", "N-Triples"],
    ["n3", "N3"],
    ["trig", "TriG"],
    ["nquads", "N-Quads"],
    ["hext", "hext"],
    ["constructor", "constructor"],
  ])("%s is %s", (format, name) => {
    expect(formatName(format)).toBe(name);
  });
});
