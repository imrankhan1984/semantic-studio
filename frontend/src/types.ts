/*
================================================================================
FILE: frontend/src/types.ts
================================================================================

SUMMARY
    The shared, app-wide TypeScript types that mirror the backend's JSON
    shapes (ontology summaries, graph, node details, query schema, SPARQL
    results, saved queries), plus the theme-aware colour palettes and label
    maps used to render the graph.

BASIC IDEA
    One source of truth for the data shapes crossing the API boundary keeps the
    frontend honest about what the backend sends. The palette/label section
    lives here too because colours are keyed by the same node/edge "kind"
    strings the backend emits, so keeping them beside the types avoids drift.
    (The query-builder-specific state model lives in sparql/types.ts.)

INPUTS / INPUT SOURCES
    - None at runtime; these are type declarations and colour constants.

EXPECTED OUTPUT
    - Types imported across the app; PALETTES / kindColor / KIND_LABELS for
      rendering the graph and legend.
================================================================================
*/

import type { QueryState } from "./sparql/types";

// Which colour theme is active.
export type Theme = "dark" | "light";

// The three top-level modes selected by the header tabs.
export type AppMode = "view" | "explore" | "query";

// Response of GET /source: the file text plus render/truncation metadata.
export interface OntologySource {
  text: string;
  format: string;
  pretty: boolean;     // true when this is the re-serialized Turtle form
  truncated: boolean;  // true when only the first max_bytes are included
  bytes: number;       // true total size
  lines: number;
  name: string;
}

/* --- visual query builder ------------------------------------------------ */

// A queryable class in the schema: its IRI, labels, instance count and kind.
export interface SchemaClass {
  iri: string;
  label: string;
  prefixed: string;
  instances: number;  // how many instances it has (drives ranking)
  kind: string;       // node kind for colouring (class/concept/...)
}

export interface SchemaLink {
  source: string;
  target: string;
  predicate: string;
  label: string;
  prefixed: string;
  /** Stated through rdfs:domain / rdfs:range. */
  declared: boolean;
  /** Stated through an owl:Restriction axiom. */
  restriction?: boolean;
  count: number;
}

// A literal-valued (data) property a class carries, with its observed datatype.
export interface SchemaDataProp {
  predicate: string;
  label: string;
  prefixed: string;
  datatype: string;          // full datatype IRI, used to type filter literals
  datatypePrefixed: string;  // shortened form, for display
  count: number;
}

export interface QuerySchema {
  classes: SchemaClass[];
  links: SchemaLink[];
  /** Direct parents per class; declared links and properties inherit down. */
  superClasses: Record<string, string[]>;
  dataProperties: Record<string, SchemaDataProp[]>;
  namespaces: Record<string, string>;
  truncated: boolean;
}

// Result of clicking a node: whether it is itself a class, or an individual
// whose types can be stepped on (best-shared type first).
export interface QueryNodeInfo {
  iri: string;
  isClass: boolean;
  label: string;
  types: SchemaClass[];
}

// One cell in a SPARQL result row (null = an unbound OPTIONAL variable).
export interface SparqlTerm {
  type: "uri" | "literal" | "bnode" | "unknown";
  value: string;
  label?: string;
  prefixed?: string;
  lang?: string | null;
  datatype?: string | null;
}

// The full result set of a SPARQL query.
export interface SparqlResults {
  vars: string[];
  rows: (SparqlTerm | null)[][];
  rowCount: number;
  truncated: boolean;   // true when the server row cap was hit
  durationMs: number;
}

// A persisted query in the saved-query library.
export interface SavedQuery {
  id: string;
  name: string;
  ontologyId: string;
  ontologyName: string;
  state: QueryState;  // the visual state, so it reopens in the builder
  sparql: string;     // the generated text, for reference
  createdAt: string;
  updatedAt: string;
}

// One node in the graph view.
export interface VizNode {
  id: string;
  label: string;
  kind: string;    // colours the node and keys the legend
  degree: number;  // edge count, used to size the node
}

// One edge in the graph view.
export interface VizEdge {
  source: string;
  target: string;
  kind: string;   // colours the edge (subClassOf, assertion, ...)
  label: string;  // shown on the edge (e.g. the property name)
}

// The whole graph plus summary counts (the /graph response).
// The response is budgeted: it carries the highest-degree `budget` nodes, so
// nodeCount/edgeCount describe what is DRAWN and the *Total fields describe the
// ontology. Every added field is required, not optional: made optional, a stale
// backend that omitted them would render a confident and wrong notice.
export interface VizGraph {
  nodes: VizNode[];
  edges: VizEdge[];
  stats: {
    nodeCount: number;   // drawn
    edgeCount: number;   // drawn
    nodeTotal: number;   // in the ontology
    edgeTotal: number;   // in the ontology
    truncated: boolean;  // true when the budget dropped something
    budget: number;      // the budget actually applied, after clamping
    // Per-kind totals for the legend. Counts the WHOLE ontology, not the drawn
    // subset, so these will not add up to nodeCount. That is deliberate: the
    // legend describes the ontology, not the canvas. See D-017.
    kindCounts: Record<string, number>;
  };
}

// The lightweight per-ontology summary shown in the dropdown (the /list response).
export interface OntologySummary {
  id: string;
  name: string;
  source: string;
  format: string;
  triples: number;
  nodes: number;
  edges: number;
  kindCounts: Record<string, number>;
  namespaces: Record<string, string>;
  /** ISO timestamp of when the ontology was first loaded (persisted). */
  addedAt?: string;
  /** Whether the RDF graph is currently parsed in server memory. */
  loaded?: boolean;
}

// One RDF term as shown in the detail panel (a URI, literal, or blank node).
export interface TermRef {
  type: "uri" | "literal" | "bnode" | "unknown";
  value: string;
  prefixed?: string;
  label?: string;
  lang?: string | null;
  datatype?: string | null;
}

// The detail-panel payload for one entity: its outgoing/incoming statements,
// capped, with the true totals so the UI can say "showing N of M".
export interface NodeDetails {
  iri: string;
  prefixed: string;
  label: string;
  outgoing: { predicate: TermRef; object: TermRef }[];
  incoming: { subject: TermRef; predicate: TermRef }[];
  outgoingTotal: number;
  incomingTotal: number;
}

/* --- theme-aware palettes ------------------------------------------------ */
// Node colours per kind, one map per theme. Keys match the backend's node
// "kind" strings so a new kind only needs a colour added here.

const KIND_COLORS_DARK: Record<string, string> = {
  class: "#4c9aff",
  objectProperty: "#f5a623",
  datatypeProperty: "#e8d44d",
  annotationProperty: "#c98f5e",
  property: "#e07b53",
  concept: "#b06ef7",
  conceptScheme: "#ef6ab8",
  collection: "#d38ce8",
  individual: "#57cc7c",
  ontology: "#38c5b4",
  other: "#8a93a6",
};

const KIND_COLORS_LIGHT: Record<string, string> = {
  class: "#1f6fe0",
  objectProperty: "#d97706",
  datatypeProperty: "#a16207",
  annotationProperty: "#92642f",
  property: "#c2410c",
  concept: "#7c3aed",
  conceptScheme: "#db2777",
  collection: "#a855f7",
  individual: "#15803d",
  ontology: "#0d9488",
  other: "#64748b",
};

// Edge colours per relation kind, one map per theme.
const EDGE_COLORS_DARK: Record<string, string> = {
  subClassOf: "#4c9aff",
  subPropertyOf: "#e07b53",
  domain: "#9aa7bd",
  range: "#9aa7bd",
  instanceOf: "#57cc7c",
  assertion: "#3ba98f",
  broader: "#b06ef7",
  related: "#d38ce8",
  inScheme: "#ef6ab8",
  member: "#d38ce8",
  equivalentClass: "#38c5b4",
  equivalentProperty: "#38c5b4",
  disjointWith: "#e15b64",
  inverseOf: "#e07b53",
  sameAs: "#38c5b4",
  seeAlso: "#8a93a6",
};

const EDGE_COLORS_LIGHT: Record<string, string> = {
  subClassOf: "#1f6fe0",
  subPropertyOf: "#c2410c",
  domain: "#6b7280",
  range: "#6b7280",
  instanceOf: "#15803d",
  assertion: "#0f766e",
  broader: "#7c3aed",
  related: "#a855f7",
  inScheme: "#db2777",
  member: "#a855f7",
  equivalentClass: "#0d9488",
  equivalentProperty: "#0d9488",
  disjointWith: "#dc2626",
  inverseOf: "#c2410c",
  sameAs: "#0d9488",
  seeAlso: "#64748b",
};

// The complete set of colours the graph renderer needs for one theme.
export interface GraphPalette {
  kind: Record<string, string>;   // node colour by kind
  edge: Record<string, string>;   // edge colour by kind
  defaultEdge: string;            // fallback edge colour
  dimNode: string;                // dimmed (out-of-focus) node colour
  dimEdge: string;                // dimmed edge colour
  label: string;                  // node label colour
  edgeLabel: string;              // edge label colour
  background: string;             // canvas background (also PNG export bg)
}

// Assembled palette per theme, consumed by GraphView.
export const PALETTES: Record<Theme, GraphPalette> = {
  dark: {
    kind: KIND_COLORS_DARK,
    edge: EDGE_COLORS_DARK,
    defaultEdge: "#3a4353",
    dimNode: "#333a47",
    dimEdge: "#262c37",
    label: "#f2f5fa",
    edgeLabel: "#93a0b8",
    background: "#12151c",
  },
  light: {
    kind: KIND_COLORS_LIGHT,
    edge: EDGE_COLORS_LIGHT,
    defaultEdge: "#c4ccd8",
    dimNode: "#d5dae3",
    dimEdge: "#e3e7ee",
    label: "#141821",
    edgeLabel: "#5d6a77",
    background: "#f2f4f8",
  },
};

/** The colour for a node kind in the given theme (falls back to "other"). */
export function kindColor(kind: string, theme: Theme): string {
  const palette = PALETTES[theme].kind;
  return palette[kind] ?? palette.other;
}

// Human-readable names for each node kind, shown in the legend and menus.
export const KIND_LABELS: Record<string, string> = {
  class: "Class",
  objectProperty: "Object property",
  datatypeProperty: "Datatype property",
  annotationProperty: "Annotation property",
  property: "Property",
  concept: "SKOS concept",
  conceptScheme: "Concept scheme",
  collection: "SKOS collection",
  individual: "Individual",
  ontology: "Ontology",
  other: "Other",
};
