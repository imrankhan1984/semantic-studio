/*
================================================================================
FILE: frontend/src/catalogue.ts
================================================================================

SUMMARY
    A static list of well-known ontologies offered as suggestions, in the order
    a newcomer should meet them: FOAF, schema.org, FIBO, then a large SKOS
    thesaurus. Rendered by CatalogueList, which appears both on the start
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
// user has to cope with — size, triple count and conceptual difficulty happen
// to agree across these four, which is why one number is enough.
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
    id: "juho",
    name: "JUHO — Finnish public administration thesaurus",
    description:
      "A large SKOS taxonomy: tens of thousands of concepts in a broader/narrower hierarchy. Useful for seeing how the app handles scale.",
    size: "~26 MB · 800k triples · slow",
    audience: "Large on purpose. Use it to see how the app handles scale.",
    url: "https://api.finto.fi/rest/v1/juho/data?format=text/turtle",
  },
];
