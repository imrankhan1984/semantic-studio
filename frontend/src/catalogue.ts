/*
================================================================================
FILE: frontend/src/catalogue.ts
================================================================================

SUMMARY
    A static list of well-known ontologies offered in the Load dialog's
    "Suggested" tab (FIBO, schema.org, FOAF, a large SKOS thesaurus).

BASIC IDEA
    A newcomer with no ontology of their own needs a starting point. This gives
    them one-click access to real vocabularies. Nothing is fetched until the
    user picks one, so it costs nothing at startup. Each entry is a stable,
    publicly reachable URL published by the vocabulary's own maintainers.

INPUTS / INPUT SOURCES
    - None at runtime; this is a hand-maintained constant.

EXPECTED OUTPUT
    - CATALOGUE: the array LoadDialog renders as clickable suggestions.
================================================================================
*/

/** One suggested ontology shown in the Load dialog. */
export interface CatalogueEntry {
  id: string;          // stable key for React lists / loading state
  name: string;        // display name
  description: string; // one-line explanation of what it is
  /** Rough guide so nobody is surprised by a long download or parse. */
  size: string;
  url: string;         // the file to fetch when picked
}

// The suggestions, in the order shown. FIBO is first because it is the primary
// validation target and the richest example of OWL-restriction relationships.
export const CATALOGUE: CatalogueEntry[] = [
  {
    id: "fibo",
    name: "FIBO — Financial Industry Business Ontology",
    description:
      "The EDM Council's production release: financial entities, instruments, markets and legal structures. Relationships are stated as OWL restrictions, which the query builder reads.",
    size: "~5 MB · 132k triples · ~15s",
    url: "https://spec.edmcouncil.org/fibo/ontology/master/latest/prod.fibo-quickstart.ttl",
  },
  {
    id: "schemaorg",
    name: "schema.org",
    description:
      "The vocabulary behind structured data on the web — around 900 classes covering people, places, products, events and creative works.",
    size: "~3 MB · 17k triples",
    url: "https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl",
  },
  {
    id: "foaf",
    name: "FOAF — Friend of a Friend",
    description:
      "A small, classic vocabulary describing people, their links and the things they make. A good first ontology.",
    size: "~150 KB · 600 triples",
    url: "http://xmlns.com/foaf/spec/index.rdf",
  },
  {
    id: "juho",
    name: "JUHO — Finnish public administration thesaurus",
    description:
      "A large SKOS taxonomy: tens of thousands of concepts in a broader/narrower hierarchy. Useful for seeing how the app handles scale.",
    size: "~26 MB · 800k triples · slow",
    url: "https://api.finto.fi/rest/v1/juho/data?format=text/turtle",
  },
];
