/*
================================================================================
FILE: frontend/src/catalogue.ts
================================================================================

SUMMARY
    A static list of well-known ontologies offered as suggestions, in the order
    a newcomer should meet them: FOAF, schema.org, FIBO, then a multilingual
    SKOS thesaurus. Rendered by CatalogueList, which appears both on the start
    screen and on the Load dialog's "Suggested" tab.

BASIC IDEA
    A newcomer with no ontology of their own needs a starting point. This gives
    them one-click access to real vocabularies. Nothing is fetched until the
    user picks one, so it costs nothing at startup. Each entry is a stable,
    publicly reachable URL published by the vocabulary's own maintainers.

    The order is part of the data, not an accident of how the list grew; see
    the comment above CATALOGUE for the rule it follows.

INPUTS / INPUT SOURCES
    - None at runtime; this is a hand-maintained constant.

EXPECTED OUTPUT
    - CATALOGUE: the array CatalogueList renders as clickable suggestions.
================================================================================
*/

/** One suggested ontology shown in the catalogue. */
export interface CatalogueEntry {
  id: string;          // stable key for React lists / loading state
  name: string;        // display name
  description: string; // one-line explanation of what it is
  /** Rough guide so nobody is surprised by a long download or parse. */
  size: string;
  /**
   * One line on who this entry suits, shown under the description. Required
   * rather than optional so a future entry cannot be added without one: it is
   * what makes the ordering below legible on screen instead of arbitrary.
   */
  audience: string;
  url: string;         // the file to fetch when picked
}

// The suggestions, in the order shown. The rule is ascending by how much the
// user has to cope with. It used to be enough to read that off one number,
// because size, triple count and conceptual difficulty agreed across the four
// entries. Since 2026-07-31 they do not: UNESCO is the smaller download of the
// last two — 3.8 MB against FIBO's 5 MB, 100k triples against 132k — and is
// still placed after it. It is the only entry whose labels are in five scripts,
// Arabic among them, which is real cognitive load on a first encounter, and a
// thesaurus asks the reader to hold a hierarchy in their head where FIBO asks
// them to read one class at a time. That judgement is Section 5 of the spec
// `catalogue-skos-replacement.md`; the ordering test asserts ids, not sizes,
// for exactly this reason.
//
// This order is deliberate and FIBO's position in it especially so. FIBO led
// this list until 2026-07-30 because it is the primary validation target and
// the richest example of OWL-restriction relationships, which is a developer's
// reason and a good one. It is not a newcomer's reason: FIBO is ~5 MB and
// 18,717 nodes, and it was the first thing a first-time user was offered.
// Reordering follows D-002, learner first when learner and expert needs
// conflict, and costs the expert two places in a list of four that needs no
// scrolling. Do not restore FIBO to the top without reading that decision.
export const CATALOGUE: CatalogueEntry[] = [
  {
    id: "foaf",
    name: "FOAF — Friend of a Friend",
    description:
      "A small, classic vocabulary describing people, their links and the things they make. A good first ontology.",
    size: "~150 KB · 600 triples",
    audience: "Start here if you are new to ontologies.",
    url: "http://xmlns.com/foaf/spec/index.rdf",
  },
  {
    id: "schemaorg",
    name: "schema.org",
    description:
      "The vocabulary behind structured data on the web — around 900 classes covering people, places, products, events and creative works.",
    size: "~3 MB · 17k triples",
    audience: "A good second step: familiar subjects, real scale.",
    url: "https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl",
  },
  {
    id: "fibo",
    name: "FIBO — Financial Industry Business Ontology",
    description:
      "The EDM Council's production release: financial entities, instruments, markets and legal structures. Relationships are stated as OWL restrictions, which the query builder reads.",
    size: "~5 MB · 132k triples · ~15s",
    audience: "Best for testing OWL restrictions and the query builder.",
    url: "https://spec.edmcouncil.org/fibo/ontology/master/latest/prod.fibo-quickstart.ttl",
  },
  {
    id: "unesco",
    name: "UNESCO Thesaurus",
    description:
      "A multilingual thesaurus of 4,499 concepts covering education, culture, science and communication, in a broader/narrower hierarchy. A real, maintained SKOS vocabulary at a size you can explore.",
    // Measured 2026-07-31 by loading it through the application: 3,987,240
    // bytes, 99,685 triples, 4,595 graph nodes and 26,102 edges, fetched and
    // parsed in 3.5 seconds. No warning word, because there is nothing to warn
    // about — the entry this replaced ended in the word "slow" and that was the
    // most useful word in it.
    size: "~3.8 MB · 100k triples · ~4s",
    audience: "Start here for SKOS: taxonomies, concept schemes and broader/narrower.",
    url: "https://vocabularies.unesco.org/exports/thesaurus/latest/unesco-thesaurus.ttl",
  },
];
