/*
================================================================================
FILE: frontend/src/catalogue.test.ts
================================================================================

SUMMARY
    Locks the order of the suggested-ontology catalogue, and the properties of
    each entry that the reordering must not have disturbed.

BASIC IDEA
    The order of CATALOGUE is a product decision, not an implementation detail:
    it is the first thing a newcomer sees, and D-002 decides it. A source
    comment saying so is not enough, because the previous comment said the
    opposite and was believed for months. So the expected order is asserted
    here, and reordering the array without reading the spec fails the suite.

    The ordering assertion is written against an explicit list of ids rather
    than parsed out of the `size` string. `size` is prose ("~150 KB · 600
    triples") and a test that parses prose to recover a number is fragile in a
    way that has nothing to do with what is being protected. Adding a numeric
    `triples` field purely so a test could read it would be the tail wagging the
    dog; the spec's Section 11 reaches the same conclusion.

    The regression assertions matter more than they look. This change reordered
    a list of URLs by hand, and the failure mode of doing that is pairing the
    right name with the wrong address — which would send a user to a different
    ontology than the one they clicked, silently. The urls are therefore pinned
    to their values at commit 33d35c7, before the reordering.

INPUTS / INPUT SOURCES
    - The real CATALOGUE constant. Nothing is mocked; the constant is the
      subject.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 through AC-6.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { CATALOGUE } from "./catalogue";

/**
 * The intended order, ascending by how much the user has to cope with. This
 * list is the specification restated as code: if it and the array disagree,
 * one of them is wrong and a human has to decide which.
 */
const EXPECTED_ORDER = ["foaf", "schemaorg", "fibo", "juho"];

/**
 * Every entry's url as it stood at commit 33d35c7, the commit `catalogue-order`
 * was written against. Keyed by id so the comparison survives the reordering
 * this file exists to assert — a positional copy would have had to be reordered
 * too, and would then prove nothing about the move.
 */
const URLS_AT_33D35C7: Record<string, string> = {
  fibo: "https://spec.edmcouncil.org/fibo/ontology/master/latest/prod.fibo-quickstart.ttl",
  schemaorg:
    "https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl",
  foaf: "http://xmlns.com/foaf/spec/index.rdf",
  juho: "https://api.finto.fi/rest/v1/juho/data?format=text/turtle",
};

describe("CATALOGUE", () => {
  it("lists FOAF first", () => {
    // AC-1. The whole point of the item: the first thing offered is the 150 KB
    // vocabulary, not the 5 MB one.
    expect(CATALOGUE[0].id).toBe("foaf");
  });

  it("orders entries by ascending triple count", () => {
    // AC-2. Asserted as ids rather than parsed from `size`; see the header.
    expect(CATALOGUE.map((e) => e.id)).toEqual(EXPECTED_ORDER);
  });

  it("still contains all four original entries", () => {
    // AC-3. A reorder that quietly drops an entry would satisfy AC-2's prefix.
    expect(CATALOGUE).toHaveLength(4);
    expect([...CATALOGUE.map((e) => e.id)].sort()).toEqual(
      [...EXPECTED_ORDER].sort(),
    );
  });

  it("every entry keeps its original url", () => {
    // AC-4. Guards the hand-reordering failure mode: right name, wrong address.
    for (const entry of CATALOGUE) {
      expect(entry.url).toBe(URLS_AT_33D35C7[entry.id]);
    }
    // And no entry was added without its url being recorded above, which would
    // make the loop vacuously true for it.
    expect(Object.keys(URLS_AT_33D35C7)).toHaveLength(CATALOGUE.length);
  });

  it("every entry has a non-empty audience line", () => {
    // AC-5. `audience` is a required field, so this catches the emptier
    // failure: satisfying the type with "" and shipping a blank row.
    for (const entry of CATALOGUE) {
      expect(entry.audience.trim().length).toBeGreaterThan(0);
    }
  });

  it("every entry has a unique id", () => {
    // AC-6. Ids are React keys, and a duplicate would also make the
    // downloading marker appear on two rows at once.
    const ids = CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
