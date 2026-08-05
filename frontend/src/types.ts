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

// The top-level modes. The first three are selected by the header tabs and act
// on an ontology; `home` is the library screen, which acts on none of them and
// is why it is not a tab. Home is a VIEW rather than a reset — switching to it
// keeps the loaded ontology, the selection and any query in progress. See D-026.
export type AppMode = "view" | "explore" | "query" | "home";

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

// What DELETE /api/ontologies/{id} reports. `deletedQueries` is the count the
// interface repeats back to the user, and it is what was actually removed
// rather than what was listed for removal.
export interface OntologyDeletion {
  deleted: string;
  deletedQueries: number;
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

// The /neighborhood response: one entity, its highest-degree neighbours up to
// the limit, and the edges among that set. The same shape as VizGraph with two
// fields added, because the browser merges it into the graph it already holds.
//
// `truncated` here is about the NEIGHBOURS, not about the ontology: it is true
// when this entity has more connections than were returned, and `neighborTotal`
// is how many it really has. Those two are what let the interface say "showing
// the 200 most connected of 640 connections" rather than implying it showed
// everything.
export interface VizNeighborhood {
  nodes: VizNode[];
  edges: VizEdge[];
  stats: VizGraph["stats"] & {
    neighborTotal: number;
    center: string;
  };
}

/** What GraphView actually merged, reported back by it. The caller cannot work
 *  this out for itself: only the renderer knows which of the returned nodes and
 *  edges were already on the canvas. */
export interface MergeResult {
  addedNodes: string[];
  addedEdges: number;
}

/**
 * The twenty-entity thumbnail a home-screen card draws, computed by the server
 * during the parse that already happens at ingest and served from metadata.
 *
 * It carries no labels, because nothing at 120x70 pixels renders text, and no
 * edge kinds, because at that size an edge is a hairline. Node ids are here to
 * join the edges to their ends and are never displayed.
 */
export interface CardSketch {
  nodes: { id: string; kind: string; degree: number }[];
  edges: { source: string; target: string }[];
}

// The lightweight per-ontology summary shown in the dropdown (the /list response).
//
// `nodes`, `edges` and `kindCounts` describe the WHOLE ontology: they are
// build_viz_graph's stats, taken before any budget is applied. A card is a
// statement about the file, not about the current canvas.
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
  /** The home screen's thumbnail. Absent — null, not undefined — for anything
   *  stored before this field existed; such a card renders without a miniature
   *  rather than triggering a parse to backfill one. */
  card?: { sketch: CardSketch } | null;
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
//
// These are the calmer, lower-saturation palettes of G-8 (spec
// graph-legibility). The previous set was fully saturated, and at FIBO density
// hundreds of overlapping circles read as noise — Imran's words were "the colour
// used today is hardly distinguishable". Two constraints shaped every value and
// they pull against each other, so the numbers were chosen by loading FIBO in
// both themes rather than by arithmetic:
//
//   - Each colour must stay distinguishable from --bg-canvas in its own theme.
//     Pastels are lowest-contrast against a dark canvas, so the dark set is
//     lightened rather than merely desaturated, and the light set is kept
//     medium-depth rather than pale, because a pale colour under alpha washes
//     into white.
//   - Eleven kinds is near the limit of what colour alone can carry, and
//     lowering saturation shrinks the distance between them. The SKOS purples
//     (concept / collection / conceptScheme) are the tightest cluster and were
//     the ones checked hardest; they remain tellable apart but this is exactly
//     G-2's argument arriving a band early. See the build report.
//
// The alpha (the last two hex digits) is the transparency G-8 asked for, and it
// is chosen against the DENSE case: two translucent circles blend to a third
// colour belonging to no kind, so too little alpha is invisible and too much
// washes a light-theme cluster toward white (normal compositing over white
// lightens). The dark theme carries more transparency than the light one for
// that reason — see the risk note in the spec's Section 8.
const KIND_COLORS_DARK: Record<string, string> = {
  class: "#7db4f2d9",
  objectProperty: "#f2b866d9",
  datatypeProperty: "#e6d879d9",
  annotationProperty: "#cba07dd9",
  property: "#ef9d76d9",
  concept: "#b79bf0d9",
  conceptScheme: "#ef9bc9d9",
  collection: "#d3a9e8d9",
  individual: "#86d6a0d9",
  ontology: "#6fd0c2d9",
  other: "#9aa3b5d9",
};

const KIND_COLORS_LIGHT: Record<string, string> = {
  class: "#3f82cfe6",
  objectProperty: "#c9822ee6",
  datatypeProperty: "#9a8420e6",
  annotationProperty: "#9c6b45e6",
  property: "#cc6a45e6",
  concept: "#7d54c4e6",
  conceptScheme: "#c25a92e6",
  collection: "#a06fc0e6",
  individual: "#3f955fe6",
  ontology: "#2f938ae6",
  other: "#667284e6",
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
  /** Fill behind the hovered/selected node's label. Must contrast with `label`:
   *  Sigma hard-codes this to #FFF, which is invisible under a near-white
   *  dark-theme label colour. See drawNodeHover in GraphView.tsx. */
  labelBackground: string;
  edgeLabel: string;              // edge label colour
  background: string;             // canvas background (also PNG export bg)
  /** The ring drawn around the selected node, in the theme's accent. G-8's
   *  selection treatment is a ring rather than a colour swap, so the selected
   *  node stands out in a cluster without hiding which kind it is — swapping the
   *  fill would tell the user WHAT is selected while hiding WHAT KIND it is, and
   *  both matter. Kept opaque (no alpha): the ring is the one mark that must not
   *  blend into whatever it overlaps. Drawn by makeDrawNodeHover in GraphView. */
  selectedRing: string;
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
    // --bg-panel, not the canvas background --bg-panel is one step lighter than
    // the canvas, so the pill stays visible when the label is drawn over a
    // brightly coloured node instead of appearing to float.
    labelBackground: "#1a1f29",
    edgeLabel: "#93a0b8",
    background: "#12151c",
    // --accent in index.css for the dark theme. Kept in step by hand: a spec
    // that repalettes both must move this and the CSS variable together.
    selectedRing: "#4c9aff",
  },
  light: {
    kind: KIND_COLORS_LIGHT,
    edge: EDGE_COLORS_LIGHT,
    defaultEdge: "#c4ccd8",
    dimNode: "#d5dae3",
    dimEdge: "#e3e7ee",
    label: "#141821",
    // What Sigma already draws, so light mode is unchanged by construction.
    labelBackground: "#ffffff",
    edgeLabel: "#5d6a77",
    background: "#f2f4f8",
    // --accent in index.css for the light theme.
    selectedRing: "#2472e8",
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
