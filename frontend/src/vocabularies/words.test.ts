/*
================================================================================
FILE: frontend/src/vocabularies/words.test.ts
================================================================================

SUMMARY
    The Vocabularies section's words (vocabularies-and-ontologies 5.2,
    AC-2): every status and source in words, the use count, and which
    actions a row's menu offers.

BASIC IDEA
    Pure functions, so plain tables. A read-only document keeps every
    action, Add and Remove disabled with the reason.

INPUTS / INPUT SOURCES
    - words.ts.

EXPECTED OUTPUT
    - Pass/fail per rule.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { VocabularyRow } from "../types";
import {
  READ_ONLY,
  addedWords,
  rowActions,
  rowName,
  sourceWord,
  statusWord,
  tabFor,
  usesWord,
  validAddress,
  validPrefix,
} from "./words";

function row(over: Partial<VocabularyRow> = {}): VocabularyRow {
  return {
    iri: "http://www.w3.org/ns/prov-o",
    title: "PROV-O",
    prefix: "prov",
    namespaces: ["http://www.w3.org/ns/prov#"],
    status: "added",
    how: "imported",
    loaded: true,
    pending: 0,
    source: { kind: "bundled", name: "Bundled", fetchedAt: null },
    uses: 12,
    ...over,
  };
}

describe("statusWord", () => {
  it.each([
    [row(), "Added · imported"],
    [row({ how: "reused" }), "Added · terms reused"],
    [row({ status: "used", how: null }), "Used, not added"],
    [row({ status: "notFound", how: null, source: null }), "Not found"],
    [row({ loaded: false }), "Added · imported, not loaded"],
    [row({ pending: 1 }), "Added · imported, 1 file still to load"],
    [row({ pending: 2 }), "Added · imported, 2 files still to load"],
  ])("%# says it in words", (r, said) => {
    expect(statusWord(r)).toBe(said);
  });
});

describe("sourceWord", () => {
  it("says each source in words, a web copy with its date", () => {
    expect(sourceWord({ kind: "bundled", name: "Bundled", fetchedAt: null })).toBe("Bundled");
    expect(sourceWord({ kind: "library", name: "Your library: Pumps", fetchedAt: null })).toBe("Your library: Pumps");
    expect(sourceWord({ kind: "file", name: "File: team.ttl", fetchedAt: null })).toBe("File: team.ttl");
    expect(sourceWord({ kind: "web", name: "Web: example.org", fetchedAt: "2026-11-07T10:00:00+00:00" })).toBe(
      "Web: example.org, 7 Nov 2026",
    );
    expect(sourceWord(null)).toBe("");
  });
});

describe("usesWord", () => {
  it("counts the statements", () => {
    expect(usesWord(0)).toBe("No statement uses its terms");
    expect(usesWord(1)).toBe("1 statement uses its terms");
    expect(usesWord(1200)).toBe("1,200 statements use its terms");
  });
});

describe("rowActions", () => {
  const actions = (r: VocabularyRow, readOnly = false) => rowActions(r, readOnly).map((a) => a.action);
  it("follows the row's status", () => {
    expect(actions(row())).toEqual(["remove", "turtle"]);
    expect(actions(row({ loaded: false }))).toEqual(["load", "remove", "turtle"]);
    expect(actions(row({ pending: 1 }))).toEqual(["load", "remove", "turtle"]);
    expect(actions(row({ how: "reused" }))).toEqual(["remove", "turtle"]);
    expect(actions(row({ status: "used", how: null }))).toEqual(["add", "turtle"]);
    expect(actions(row({ status: "notFound", how: null }))).toEqual(["addFrom", "turtle"]);
  });

  it("keeps Add and Remove in a read-only document, disabled with the reason", () => {
    const items = rowActions(row(), true);
    expect(items.find((i) => i.action === "remove")?.disabled).toBe(READ_ONLY);
    expect(items.find((i) => i.action === "turtle")?.disabled).toBeUndefined();
    expect(rowActions(row({ status: "used", how: null }), true)[0]).toEqual({
      action: "add", label: "Add…", disabled: READ_ONLY,
    });
  });
});

describe("the rest", () => {
  it("names a row by every column", () => {
    expect(rowName(row())).toBe("PROV-O, prefix prov, Added · imported, Bundled, 12 statements use its terms");
  });

  it("opens a row's Add on its own source", () => {
    expect(tabFor(null)).toBe("bundled");
    expect(tabFor(row({ status: "used" }))).toBe("bundled");
    expect(tabFor(row({ status: "used", source: { kind: "library", name: "Your library: X", fetchedAt: null } }))).toBe("library");
    expect(tabFor(row({ status: "notFound", source: null }))).toBe("file");
  });

  it("puts Added. before the sentence", () => {
    expect(addedWords("PROV-O holds rules.")).toBe("Added. PROV-O holds rules.");
  });

  it("holds a prefix and an address to the server's rules", () => {
    expect(validPrefix("prov")).toBe(true);
    expect(validPrefix("dc-terms_2")).toBe(true);
    expect(validPrefix("2dc")).toBe(false);
    expect(validPrefix("a b")).toBe(false);
    expect(validAddress("https://example.org/v.ttl")).toBe(true);
    expect(validAddress("ftp://example.org/v.ttl")).toBe(false);
    expect(validAddress("not an address")).toBe(false);
  });
});
