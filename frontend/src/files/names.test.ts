/*
================================================================================
FILE: frontend/src/files/names.test.ts
================================================================================

SUMMARY
    The browser's copy of the name rule (multi-file-projects 8.3, AC-6),
    held to names.table.json, the table backend/tests/test_multi_file.py
    holds projects.py to: one table, so the two sides cannot drift.

BASIC IDEA
    Every row of the table through the function it is about, and the id
    pattern beside it.

INPUTS / INPUT SOURCES
    - names.table.json.

EXPECTED OUTPUT
    - Pass/fail per row.
================================================================================
*/

import { describe, expect, it } from "vitest";
import table from "./names.table.json";
import { fileName, folderError, isDocId, segmentError } from "./names";

describe("the name rule, one table with the server (8.3)", () => {
  it("reads a table of every kind of row", () => {
    // The table loaded: a missing file would pass every loop below.
    expect(table.segments.length).toBeGreaterThan(20);
    expect(table.files.length).toBeGreaterThan(5);
    expect(table.folders.length).toBeGreaterThan(5);
  });

  it.each(table.segments as [string, boolean][])("segment %j passes: %s", (name, passes) => {
    expect(segmentError(name) === null).toBe(passes);
  });

  it.each(table.files as [string, string | null][])("file name %j becomes %j", (typed, expected) => {
    const result = fileName(typed);
    expect("name" in result ? result.name : null).toBe(expected);
  });

  it.each(table.folders as [string, boolean][])("folder %j passes: %s", (path, passes) => {
    expect(folderError(path) === null).toBe(passes);
  });

  it("says each refusal in the server's words", () => {
    expect(segmentError("CON")).toBe("CON is a name Windows keeps for a device.");
    expect(segmentError("trailing.")).toBe("A name cannot end in a dot or a space.");
    expect(segmentError("project.json")).toBe("project.json is a name Semantic Studio keeps for itself.");
    expect(fileName("  ")).toEqual({ error: "A file needs a name." });
    expect(folderError("a/b/c/d")).toBe("A project's folders go at most 3 levels deep.");
  });

  it("knows an id by its shape only", () => {
    expect(isDocId("model")).toBe(true);
    expect(isDocId("shapes")).toBe(true);
    expect(isDocId("f0123abcd")).toBe(true);
    for (const bad of ["core", "f0123", "F0123ABCD", "f0123abcd\n", "../model", "model.ttl"]) {
      expect(isDocId(bad)).toBe(false);
    }
  });
});
