/*
================================================================================
FILE: frontend/src/files/tabs.test.ts
================================================================================

SUMMARY
    The tab strip as data (multi-file-projects 5.9, AC-25, AC-27): one row
    per open file in the order opened, an id the project no longer holds
    left out, the folder shown only where two open files share a name, the
    words a screen reader hears, and the remembered tabs read back.

BASIC IDEA
    Pure functions, so plain inputs and exact outputs.

INPUTS / INPUT SOURCES
    - Inline document states and lists of open ids.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { keptTabs, tabLabel, tabRows } from "./tabs";

const DOCS = [
  { doc: "model", file: "model.ttl", role: "ontology" as const, dirty: false },
  { doc: "shapes", file: "shapes.ttl", role: "shapes" as const, dirty: false },
  { doc: "f00000001", file: "vocab/equipment.ttl", role: "vocabulary" as const, dirty: true },
  { doc: "f00000002", file: "vocab/model.ttl", role: "ontology" as const, dirty: false },
];

describe("tabRows (5.9 items 1 and 2)", () => {
  it("gives one row per open file, in the order opened", () => {
    const rows = tabRows(DOCS, ["f00000001", "model"]);
    expect(rows.map((r) => r.doc)).toEqual(["f00000001", "model"]);
    expect(rows.map((r) => r.name)).toEqual(["equipment.ttl", "model.ttl"]);
    expect(rows.map((r) => r.dirty)).toEqual([true, false]);
  });

  it("leaves out an id the project no longer holds", () => {
    expect(tabRows(DOCS, ["model", "f0000ffff"]).map((r) => r.doc)).toEqual(["model"]);
    expect(tabRows([], ["model"])).toEqual([]);
  });

  it("shows the folder only where two open files share a name (AC-27)", () => {
    const apart = tabRows(DOCS, ["model", "f00000001"]);
    expect(apart.map((r) => r.showFolder)).toEqual([false, false]);
    const together = tabRows(DOCS, ["model", "f00000002"]);
    expect(together.map((r) => [r.name, r.showFolder, r.folder])).toEqual([
      ["model.ttl", false, ""],
      ["model.ttl", true, "vocab"],
    ]);
  });

  it("says the file, its folder and its unsaved state in words", () => {
    expect(tabRows(DOCS, ["f00000001"])[0].label).toBe("equipment.ttl, in vocab, unsaved");
    expect(tabLabel({ name: "model.ttl", folder: "", dirty: false })).toBe("model.ttl");
    expect(tabLabel({ name: "model.ttl", folder: "", dirty: true })).toBe("model.ttl, unsaved");
  });

  it("reads a document from a server before E-16 by its id", () => {
    const rows = tabRows([{ doc: "shapes", dirty: false }, { doc: "model", dirty: false }], ["shapes", "model"]);
    expect(rows.map((r) => [r.name, r.role])).toEqual([
      ["shapes.ttl", "shapes"],
      ["model.ttl", "ontology"],
    ]);
  });
});

describe("the remembered tabs (5.9 item 5)", () => {
  it("keeps the ids the project holds, in the order stored, each once", () => {
    expect(keptTabs(["f00000001", "model", "f00000001", "gone"], DOCS)).toEqual(["f00000001", "model"]);
  });

  it("takes anything else as nothing remembered", () => {
    for (const stored of [null, undefined, 7, "model", {}, [7, null]]) {
      expect(keptTabs(stored, DOCS)).toEqual([]);
    }
  });
});
