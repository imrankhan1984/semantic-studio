/*
================================================================================
FILE: frontend/src/modeling/usesWords.test.ts
================================================================================

SUMMARY
    The rename line and the delete dialog's words for uses in other files
    (links-between-files 5.2, 5.3).

BASIC IDEA
    Pure functions, so every count and its grammar is a row here: one file
    or two, one statement or many, snapshots and saved queries alone or
    after the uses, and a file in a folder named by its file name.

INPUTS / INPUT SOURCES
    - Inline FileUses rows.

EXPECTED OUTPUT
    - Pass/fail per sentence.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { deleteUses, renameLine, usesPhrase } from "./usesWords";

const equipment = { doc: "f1", file: "vocab/equipment.ttl", count: 3 };
const shapes = { doc: "shapes", file: "shapes.ttl", count: 1 };

describe("usesWords", () => {
  it("says the counts by file, the noun once", () => {
    expect(usesPhrase([equipment, shapes])).toBe("3 statements in equipment.ttl and 1 in shapes.ttl");
    expect(usesPhrase([shapes])).toBe("1 statement in shapes.ttl");
  });

  it("gives 5.2's rename line, or none with no uses", () => {
    expect(renameLine({ uses: [equipment, shapes], snapshots: [], queries: 0 }, "Pump")).toBe(
      "Also changes 3 statements in equipment.ttl and 1 in shapes.ttl.",
    );
    expect(renameLine({ uses: [], snapshots: [], queries: 0 }, "Pump")).toBeNull();
  });

  it("names the snapshots and counts the saved queries (5.2 items 8, 9)", () => {
    const snapshots = [{ id: "a", label: "a.csv" }, { id: "b", label: "b.csv" }];
    expect(renameLine({ uses: [equipment], snapshots, queries: 1 }, "Pump")).toBe(
      "Also changes 3 statements in equipment.ttl. 2 data snapshots use Pump; edit their mappings to follow, and 1 saved query mentions it.",
    );
    expect(renameLine({ uses: [], snapshots: [], queries: 2 }, "Pump")).toBe(
      "2 saved queries mention Pump; they are not changed.",
    );
  });

  it("gives 5.3's delete sentence and list", () => {
    const sampled = { ...equipment, sample: [{ subject: "x", label: "Motor" }, { subject: "y", label: "drives" }] };
    expect(deleteUses([sampled, shapes], "Pump")).toEqual({
      lead: "4 statements in other files use Pump:",
      rows: ["3 in equipment.ttl (Motor, drives)", "1 in shapes.ttl"],
      ending: "Deleting Pump leaves them pointing at nothing.",
    });
    expect(deleteUses([shapes], "Pump").lead).toBe("1 statement in another file uses Pump:");
    expect(deleteUses([shapes], "Pump").ending).toBe("Deleting Pump leaves it pointing at nothing.");
  });
});
