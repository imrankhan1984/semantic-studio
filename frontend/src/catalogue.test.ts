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

    The regression assertions matter more than they look. That change reordered
    a list of URLs by hand, and the failure mode of doing that is pairing the
    right name with the wrong address — which would send a user to a different
    ontology than the one they clicked, silently. The urls are therefore pinned.

    Since 2026-07-31 the same pins guard a different act. The spec
    `catalogue-skos-replacement.md` swapped the fourth entry from JUHO to the
    UNESCO Thesaurus, and both the id list and the url map had to be edited for
    the suite to pass.
    That is the point — a catalogue entry is the first thing a newcomer is
    offered, and replacing one should cost a deliberate edit in two places
    rather than one quiet line.

INPUTS / INPUT SOURCES
    - The real CATALOGUE constant. Nothing is mocked; the constant is the
      subject.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering `catalogue-order` AC-1 to AC-6 and
      `catalogue-skos-replacement` AC-1 to AC-5.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { CATALOGUE } from "./catalogue";

/**
 * The intended order, ascending by how much the user has to cope with. This
 * list is the specification restated as code: if it and the array disagree,
 * one of them is wrong and a human has to decide which.
 */
const EXPECTED_ORDER = ["foaf", "schemaorg", "fibo", "unesco"];

/**
 * Every entry's url. The first three stood at commit 33d35c7, the commit
 * `catalogue-order` was written against; `unesco` replaced `juho` in position
 * four on 2026-07-31. Keyed by id so the comparison survives the reordering
 * this file exists to assert — a positional copy would have had to be reordered
 * too, and would then prove nothing about the move.
 *
 * The pin outlives the reorder it was written for. It is now what makes
 * swapping an entry a deliberate act: a URL edited here and nowhere else, or
 * there and nowhere else, fails rather than silently sending a user to a
 * different vocabulary than the one they clicked.
 */
const EXPECTED_URLS: Record<string, string> = {
  fibo: "https://spec.edmcouncil.org/fibo/ontology/master/latest/prod.fibo-quickstart.ttl",
  schemaorg:
    "https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl",
  foaf: "http://xmlns.com/foaf/spec/index.rdf",
  unesco:
    "https://vocabularies.unesco.org/exports/thesaurus/latest/unesco-thesaurus.ttl",
};

describe("CATALOGUE", () => {
  it("lists FOAF first", () => {
    // AC-1. The whole point of the item: the first thing offered is the 150 KB
    // vocabulary, not the 5 MB one.
    expect(CATALOGUE[0].id).toBe("foaf");
  });

  it("lists foaf, schemaorg, fibo, unesco in that order", () => {
    // catalogue-order AC-2, and catalogue-skos-replacement AC-1. Asserted as
    // ids rather than parsed from `size`; see the header. The name no longer
    // says "by ascending triple count" because since the UNESCO swap that is
    // not what the order is: UNESCO is the smaller file and sits last anyway,
    // for the reason written above CATALOGUE.
    expect(CATALOGUE.map((e) => e.id)).toEqual(EXPECTED_ORDER);
  });

  it("still contains exactly four entries", () => {
    // catalogue-order AC-3. A reorder that quietly drops an entry would satisfy
    // the prefix of the assertion above.
    expect(CATALOGUE).toHaveLength(4);
    expect([...CATALOGUE.map((e) => e.id)].sort()).toEqual(
      [...EXPECTED_ORDER].sort(),
    );
  });

  it("contains no entry with id juho", () => {
    // catalogue-skos-replacement AC-2. Implied by the order assertion, and
    // stated separately anyway: this is the criterion the item exists for, and
    // a future entry appended without touching EXPECTED_ORDER would be caught
    // by that test for the wrong reason.
    expect(CATALOGUE.some((e) => e.id === "juho")).toBe(false);
  });

  it("every entry keeps its pinned url", () => {
    // catalogue-order AC-4. Guards the hand-editing failure mode: right name,
    // wrong address.
    for (const entry of CATALOGUE) {
      expect(entry.url).toBe(EXPECTED_URLS[entry.id]);
    }
    // And no entry was added without its url being recorded above, which would
    // make the loop vacuously true for it.
    expect(Object.keys(EXPECTED_URLS)).toHaveLength(CATALOGUE.length);
  });

  it("the unesco entry points at the vocabularies.unesco.org export", () => {
    // catalogue-skos-replacement AC-5. The loop above compares the entry with
    // the map; this states the address itself, so that editing both to the same
    // wrong value still fails.
    const unesco = CATALOGUE.find((e) => e.id === "unesco");
    expect(unesco?.url).toBe(
      "https://vocabularies.unesco.org/exports/thesaurus/latest/unesco-thesaurus.ttl",
    );
  });

  it("the unesco entry's audience line names SKOS", () => {
    // catalogue-skos-replacement AC-3, the half that can be asserted here.
    // The line is what tells a newcomer this row is the SKOS example, which is
    // the whole reason the catalogue keeps a fourth entry at all; that it
    // reaches the accessible name is asserted in CatalogueList.test.tsx.
    const unesco = CATALOGUE.find((e) => e.id === "unesco");
    expect(unesco?.audience).toContain("SKOS");
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
