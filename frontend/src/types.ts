/*
================================================================================
FILE: frontend/src/types.ts
================================================================================

SUMMARY
    The shared, app-wide TypeScript types that mirror the backend's JSON
    shapes (ontology summaries, graph, node details, query schema, SPARQL
    results, saved queries, the network broker's policy and activity), plus the theme-aware colour palettes and label
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

// --- the network broker (external-access Stage 1, D-066) -----------------

// What an outbound request is for. Never shown to the user by name; the
// approval dialog and the Network panel phrase each one in words.
export type NetworkCapability =
  | "ontology:fetch"
  | "ontology:import"
  | "jsonld:context"
  | "sparql:service";

// One question the server needs answered before it connects: the body of a 409.
export interface ApprovalRequest {
  capability: NetworkCapability;
  host: string;
  url: string;
  reason: string;
  sends: string;
  encrypted: boolean;
  // SPARQL SERVICE only: the exact query text that will be sent, which the
  // dialog shows in full (external-access Section 6).
  text?: string;
}

// A decision the user made about a site. Only remembered ones are listed.
export interface NetworkGrant {
  id: string;
  capability: NetworkCapability;
  host: string;
  decision: "allow" | "block";
  remember: boolean;
  grantedAt: string;
}

export interface NetworkPolicy {
  offline: boolean;
  grants: NetworkGrant[];
}

// One line of the activity log. `outcome` is "ok" for a completed download;
// every other value is a request that was refused, asked about, or failed.
export interface NetworkActivity {
  time: string;
  capability: NetworkCapability;
  url: string;
  host: string;
  outcome: string;
  status: number;
  bytes: number;
  encrypted: boolean;
}

// Which colour theme is active.
export type Theme = "dark" | "light";

// The top-level modes. View / Explore / Query / Hierarchy are selected by the
// header tabs and act on an ontology; `home` is the library screen, which acts
// on none of them and is why it is not a tab. Home is a VIEW rather than a reset
// — switching to it keeps the loaded ontology, the selection and any query in
// progress. See D-026. `hierarchy` is the tree view over subClassOf / broader.
export type AppMode = "view" | "explore" | "query" | "home" | "hierarchy" | "shapes";

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
  /** Queries the file stores in itself. Carried on the schema so Query mode
   *  needs no request of its own to know whether to list them. */
  embeddedQueryCount?: number;
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
  // Present when the query ran with imports on: how many imported documents
  // the merged view covered.
  importDocuments?: number;
  // Present when the query had SERVICE blocks: one entry per endpoint call.
  services?: ServiceCall[];
}

// One SERVICE call a query made (external-access Stage 3). `truncated` means
// the endpoint's answer passed the 10,000-row per-call cap; `error` is set
// when the call failed and SERVICE SILENT let the query carry on without it.
export interface ServiceCall {
  endpoint: string;
  host: string;
  rows: number;
  truncated: boolean;
  ms: number;
  error: string | null;
}

// A persisted query in the saved-query library.
export interface SavedQuery {
  id: string;
  name: string;
  ontologyId: string;
  ontologyName: string;
  /** Absent on anything saved before text queries existed, which is visual. */
  mode?: "visual" | "text";
  /** Visual: the state it reopens in. Text: the state it forked from, for
   *  "Back to the visual version", or null when written from nothing. */
  state: QueryState | null;
  /** Visual: the generated text, for reference. Text: the query itself. */
  sparql: string;
  createdAt: string;
  updatedAt: string;
}

// One SPARQL query stored inside the loaded ontology (SHACL sh:select,
// sh:construct, sh:ask, or SPIN sp:text), from GET /{id}/embedded-queries.
export interface EmbeddedQuery {
  /** Null when the query hangs off a blank node, as SHACL's usually does. */
  subject: string | null;
  label: string;
  predicate: string;
  form: "SELECT" | "CONSTRUCT" | "ASK" | "DESCRIBE" | "UPDATE" | "UNKNOWN";
  text: string;
  /** Cut at 100 KB; what is shown is not the whole query. */
  truncated: boolean;
  /** Uses $this or $value, which a SHACL engine binds and a standalone run does not. */
  shaclVariables: boolean;
}

export interface EmbeddedQueries {
  queries: EmbeddedQuery[];
  /** Every query in the file; `queries` holds at most 200 of them. */
  total: number;
  truncated: boolean;
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
  // With imports on: the import that defines this entity. The graph draws it
  // smaller, so being imported is not told by colour alone (AC-21).
  importedFrom?: string;
  // A project document's node: every name it has, in any language, which is
  // what search matched on (D-085). Absent for the library.
  names?: string[];
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
  /** Count of object-property assertion edges between individuals — the A-box
   *  edges the documentation export's opt-in would add (DOC-1 AC-16). Absent (0)
   *  for anything ingested before this stat existed. The individual NODE count
   *  is `kindCounts.individual`. */
  assertionCount?: number;
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

/* --- hierarchy view ------------------------------------------------------ */

// One node in a hierarchy forest. `id` is the map key, not a field here.
// `hasChildren` marks a collapsed node worth an expand triangle; `cyclic` is
// present only when the node is its own ancestor in malformed data.
export interface HierarchyNode {
  label: string;
  prefixed: string;
  kind: string;        // colours the kind badge, keyed like the graph's kinds
  hasChildren: boolean;
  cyclic?: boolean;
  // With imports on: the import that defines this entity, which the row names
  // as "from FOAF" (external-access Stage 2, AC-21). Absent for the file's own.
  importedFrom?: string;
  // In a project document, a relationship's or attribute's ends by name, for
  // the row to read *works for (Person → Organization)* (relationships 5.5).
  // An attribute's range is its datatype, prefixed (xsd:string).
  ends?: { domain: string | null; range: string | null };
}

// A reference from a parent to one child. `origin` is "asserted" in this
// version; it is the seam that lets an inferred hierarchy be added later as data
// rather than a schema change — the tree renders an "inferred" edge as derived
// with no new rendering code (D-046). Do not narrow this to a bare string: every
// edge must carry its origin explicitly.
export interface HierarchyChild {
  id: string;
  origin: HierarchyOrigin;
}

// "imported" is the value external-access Stage 2 added: an edge leading to an
// entity defined only in an import, shown with the merged view on.
export type HierarchyOrigin = "asserted" | "inferred" | "imported";

// One forest: a flat node map, a parent->children adjacency, and the roots. A
// class with two parents is stored once and referenced from each parent.
export interface HierarchyForest {
  nodes: Record<string, HierarchyNode>;
  children: Record<string, HierarchyChild[]>;
  roots: string[];
}

// The /hierarchy response: the class forest, the concept forest, up to three
// property forests (object / datatype / annotation over rdfs:subPropertyOf,
// added in v0.3), the true node counts (which exceed the carried nodes when
// truncated), and a truncation flag.
//
// classes and concepts are always present (empty forests when the ontology has
// none). A property key — and its count — is present only when the ontology
// declares that kind of property in a subPropertyOf relationship, so most
// ontologies carry none of the three.
export interface Hierarchy {
  classes: HierarchyForest;
  concepts: HierarchyForest;
  objectProperties?: HierarchyForest;
  datatypeProperties?: HierarchyForest;
  annotationProperties?: HierarchyForest;
  // A project's examples by class (shacl-authoring 5.8): each class that has
  // one is a root, its examples its children. Absent when there are none.
  examples?: HierarchyForest;
  counts: {
    classes: number;
    concepts: number;
    objectProperties?: number;
    datatypeProperties?: number;
    annotationProperties?: number;
    examples?: number;
  };
  truncated: boolean;
}

// One RDF term as shown in the detail panel (a URI, literal, or blank node).
export interface TermRef {
  type: "uri" | "literal" | "bnode" | "unknown";
  value: string;
  prefixed?: string;
  label?: string;
  lang?: string | null;
  datatype?: string | null;
  // A project document's URI term: the kind its rdf:type gives, so the
  // editing form can tell an attribute from a relationship (visual-modeling).
  kind?: string;
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
  // With imports on, for an entity defined only in an import (AC-21).
  importedFrom?: string;
  // A project document: each project language and the name in it, or null
  // where the translation is missing (5.4.2).
  names?: { lang: string; value: string | null }[];
  // A project document: the entity's own kind, from its rdf:type.
  kind?: string;
  // A project's relationship or attribute: the modeling checks' warnings
  // (relationships 5.9), each with the command that fixes it, if one does.
  warnings?: ModelWarning[];
  // A project's example (shacl-authoring 5.8): its classes, and one field per
  // attribute and relationship they have, own and inherited.
  example?: ExampleInfo;
}

export interface ExampleInfo {
  classes: { iri: string; label: string }[];
  fields: ExampleField[];
}

export interface ExampleField {
  property: string;
  label: string;
  kind: "attribute" | "relationship";
  functional: boolean;
  values: (AnnotationValue & { label?: string })[];
  // An attribute's type of value, as xsd:name; null when it has none.
  datatype?: string | null;
  // A relationship's end class, and the examples it may point to (capped,
  // with the true total).
  range?: string | null;
  rangeLabel?: string | null;
  options?: { iri: string; label: string }[];
  optionsTotal?: number;
}

export interface ModelWarning {
  text: string;
  // The block it concerns, where the form shows it: "characteristics" (What
  // else is true, How many values) or "inverse" (The other way round).
  block?: "characteristics" | "inverse";
  fix?: { command: string; args: Record<string, unknown>; label: string };
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

/* --- owl:imports (external-access Stage 2) --------------------------------- */

export type ImportStatus = "builtin" | "unresolved" | "resolved" | "failed" | "blocked";
export type ImportSource = "builtin" | "library" | "bundled" | "mapped" | "file" | "network";

// One import in the closure. `importedBy` is the import that brought it in, or
// null for one the ontology declares itself.
export interface ImportRow {
  iri: string;
  status: ImportStatus;
  source: ImportSource | null;
  sourceName: string | null;
  fetchedAt: string | null;
  error: string | null;
  documentCount: number;
  depth: number;
  importedBy: string | null;
  sourceUrl?: string | null;
  sha256?: string;
}

// GET /imports. `limit` names a closure limit that was reached; `resolving` is
// present while a resolution runs, for "Resolving 2 of 3…".
export interface ImportsListing {
  imports: ImportRow[];
  limit: string | null;
  resolving: { done: number; total: number } | null;
  offline: boolean;
}

// POST /imports/files. `mismatch` asks the user to confirm a file whose
// declared IRI is not the one it was chosen for; `invalid` did not parse.
export interface ImportFilesResult {
  matched: { iri: string; file: string }[];
  unmatched: string[];
  mismatch: { file: string; declares: string | null; forIri: string }[];
  invalid: { file: string; error: string }[];
  imports: ImportsListing;
}

/* --- projects and editing (authoring-foundations) ------------------------ */

// A project as the home screen lists it, from its manifest alone.
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  baseIri: string;
  prefix: string;
  primaryLanguage: string;
  languages: string[];
  documents: { file: string; role: ProjectDocName }[];
  counts: { classes?: number; properties?: number; concepts?: number; triples?: number };
  // Ontology or taxonomy (D-089): which tools the visual doors offer. Null
  // only for a project made before kinds, until it is first opened.
  kind: ProjectKind | null;
}

export type ProjectDocName = "model" | "shapes";

export type ProjectKind = "ontology" | "taxonomy";

// "vocabulary" is the E-6 name for a small SKOS scheme, still accepted.
export type ProjectTemplate = "empty" | "small" | "taxonomy-empty" | "taxonomy-small" | "vocabulary";

// An open document's state. `ontologyId` is what every existing view reads
// it by (prj-<hex>-<doc>); `revision` keys every refetch (D-081).
export interface ProjectDocumentState {
  doc: ProjectDocName;
  ontologyId: string;
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  undoLabel: string | null;
  canRedo: boolean;
  redoLabel: string | null;
  triples: number;
}

export interface OpenedProject {
  project: ProjectSummary;
  documents: ProjectDocumentState[];
  recovery: { available: boolean; draftTime: string | null };
}

// A command, an apply, an undo or a redo.
export interface ChangeResult {
  revision: number;
  label: string;
  state: ProjectDocumentState;
  // A create or rename: the entity's IRI, as the server resolved it, so it
  // can be selected.
  created?: string;
}

// The kinds search can be narrowed to (the editing form's pickers).
export type SearchKind =
  | "class"
  | "concept"
  | "objectProperty"
  | "datatypeProperty"
  | "annotationProperty";

// An annotation value as the command layer takes it (authoring-foundations
// 5.4.1): text in a language, a value of one of seven datatypes, or a link.
export interface AnnotationValue {
  kind: "text" | "typed" | "link";
  value: string;
  lang?: string;
  datatype?: string;
}

// The type a value is entered as; `datatype` only for "typed".
export interface ValueType {
  kind: "text" | "typed" | "link";
  datatype?: string;
}

// One entry of the annotation-property list the form offers.
export interface AnnotationPropertyOption {
  iri: string;
  prefixed: string;
  defaultType: ValueType;
  source: "suggested" | "document" | "import";
}

// What DeleteEntity's dry run says it would do (authoring-foundations 5.5).
export interface DeleteImpact {
  iri: string;
  label: string;
  kind: string;
  statements: number;
  strategy: "reparent" | "orphan";
  children: { iri: string; label: string }[];
  reparentedTo: { iri: string; label: string }[];
  // kind: "object property", "datatype property", ... (5.8 item 7).
  properties: { iri: string; label: string; role: "domain" | "range"; kind?: string }[];
  individuals: { iri: string; label: string }[];
  importMentions: number;
}

export type SaveResult =
  | { savedAt: string; state: ProjectDocumentState }
  | { needsCommentsWarning: true; backup: string };

export interface LanguageReport {
  entities: number;
  languages: string[];
  missing: Record<string, number>;
}

/* --- the modeling canvas (visual-modeling Stage 2) ------------------------ */

// Where the canvas draws each box, saved beside the document (D-087). Not the
// model: writing it moves no revision and makes nothing dirty.
export interface CanvasLayout {
  version: 1;
  // Increased by the server on every write of the file, and set by it
  // alone: a response carrying an older one read the file before a save
  // this browser has already seen succeed (PR #47 re-review).
  generation: number;
  positions: Record<string, [number, number]>;
  // The chosen boxes past 300 (5.6); null draws everything.
  shown: string[] | null;
  viewport: { x: number; y: number; zoom: number } | null;
}

export interface CanvasNode {
  iri: string;
  kind: "class" | "concept";
  label: string;
  // The name is the primary language's, marked "(en)" in the label (5.4).
  fallback: boolean;
  // Outside this document: the import it comes from, or "outside". Read-only.
  imported?: string;
  attributes: { iri: string; label: string; datatype: string | null }[];
}

export interface CanvasEdge {
  // "related": skos:related, one line per pair, drawn dashed with no arrow
  // because it reads the same both ways (relationships 5.8).
  kind: "subClassOf" | "broader" | "relationship" | "related";
  source: string;
  target: string;
  property?: string;
  label?: string;
  // This line's place among the lines joining the same two boxes, in either
  // direction, and how many there are: several are curved apart, and a line
  // from a box to itself is a loop (relationships 5.4).
  pair: number;
  pairs: number;
}

// A subclass, broader or related line the user clicked: the link panel's
// subject (relationships 5.2). A relationship's line selects the relationship.
export interface CanvasLink {
  kind: "subClassOf" | "broader" | "related";
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  // Why it cannot be removed here: an end of the project's other kind, or
  // the narrower end imported (5.10 item 6).
  readOnly?: string;
}

export interface CanvasView {
  revision: number;
  // The project's kind: what the palette offers and what the canvas may
  // change (D-089). Null for a project that has not been opened since kinds.
  kind: ProjectKind | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  undrawn: {
    iri: string;
    label: string;
    kind: string;
    // "expression": an end written as owl:unionOf and the like, drawn by
    // neither a line nor a box; "outside": an attribute of a class the canvas
    // does not draw.
    missing: "domain" | "range" | "both" | "expression" | "outside";
    // The end it has, if any: a line can complete it (5.4, Relating).
    domain: string | null;
    range: string | null;
  }[];
  // Classes and concepts in the document, drawn or not.
  total: number;
  // Past 300 boxes: only the shown set and its direct links came back.
  limited: boolean;
  layout: CanvasLayout;
}

// What the canvas lends the tree and the form past 300 boxes (5.6): whether
// it is drawing a chosen set, which, and how to change it.
export interface CanvasSet {
  limited: boolean;
  shown: string[];
  show: (iri: string) => Promise<void> | void;
  hide: (iri: string) => Promise<void> | void;
}


// --- SHACL shapes and validation (shacl-authoring Stage A) -------------------

// One value of an "allowed values" list, as the server reads and takes it.
export interface ShapeValue {
  kind: "text" | "typed" | "link";
  value: string;
  lang?: string;
  datatype?: string;
  label?: string;
}

// A number or date bound, with the type it is written in.
export interface ShapeBound {
  value: string;
  datatype: string;
}

export type ShapePathKind = "attribute" | "relationship" | "name" | "definition" | "other";

// One rule: a path and every kind checked on it (5.3). `path` is one IRI,
// or the IRIs of an alternative (a definition is skos:definition or
// rdfs:comment).
export interface ShapeRule {
  path: string[];
  pathLabel?: string;
  pathKind?: ShapePathKind;
  minCount?: number;
  maxCount?: number;
  datatype?: string;
  class?: string;
  classLabel?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minInclusive?: ShapeBound;
  maxInclusive?: ShapeBound;
  in?: ShapeValue[];
  languageIn?: string[];
  uniqueLang?: boolean;
  requiredLanguages?: string[];
}

export interface ShapeTarget {
  iri: string;
  label: string;
  // "every class" or "every concept" for a model check, otherwise null.
  every: string | null;
}

// A listed shape as the form reads it, or read-only with why (5.5).
export interface ShapeForm {
  id: string;
  iri: string | null;
  name: string;
  named: boolean;
  target: ShapeTarget | null;
  severity: "violation" | "warning" | "info";
  message: string | null;
  rules: ShapeRule[];
  editable: boolean;
  unsupported: string[];
}

export interface ShapesListing {
  revision: number | null;
  modelRevision: number;
  kind: ProjectKind | null;
  shapes: ShapeForm[];
}

// What a rule can be about for a target class (5.3).
export interface ShapePath {
  path: string[];
  label: string;
  kind: ShapePathKind;
  functional?: boolean;
  datatype?: string | null;
  range?: string | null;
  rangeLabel?: string | null;
}

export interface ShapeSuggestions {
  paths: ShapePath[];
  suggestions: { id: string; rule: ShapeRule }[];
}

export type PanelState = "fails" | "passes" | "warnings" | "nothing" | "error";

export interface ValidationProblem {
  // The individual's IRI, the link's target; null for a blank node.
  focus: string | null;
  focusLabel: string;
  group: string;
  sentence: string;
  value: string | null;
  severity: "violation" | "warning" | "info";
}

export interface ValidationPanel {
  id: string;
  name: string;
  state: PanelState;
  target: { iri: string; label: string; one: string; many: string } | null;
  focusCount: number;
  failingCount: number;
  problemCount: number;
  warningCount: number;
  problems: ValidationProblem[];
  problemsTotal: number;
  error: string | null;
}

export interface ValidationResult {
  stopped: boolean;
  statements: number;
  shapeCount: number;
  shapes: ValidationPanel[];
  durationMs: number;
  // The revisions checked: a newer one on either document makes it stale.
  revisions: { model: number; shapes: number | null };
}
