import type { QueryState } from "./sparql/types";

export type Theme = "dark" | "light";

export type AppMode = "explore" | "query";

/* --- visual query builder ------------------------------------------------ */

export interface SchemaClass {
  iri: string;
  label: string;
  prefixed: string;
  instances: number;
  kind: string;
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

export interface SchemaDataProp {
  predicate: string;
  label: string;
  prefixed: string;
  datatype: string;
  datatypePrefixed: string;
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

export interface QueryNodeInfo {
  iri: string;
  isClass: boolean;
  label: string;
  types: SchemaClass[];
}

export interface SparqlTerm {
  type: "uri" | "literal" | "bnode" | "unknown";
  value: string;
  label?: string;
  prefixed?: string;
  lang?: string | null;
  datatype?: string | null;
}

export interface SparqlResults {
  vars: string[];
  rows: (SparqlTerm | null)[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  ontologyId: string;
  ontologyName: string;
  state: QueryState;
  sparql: string;
  createdAt: string;
  updatedAt: string;
}

export interface VizNode {
  id: string;
  label: string;
  kind: string;
  degree: number;
}

export interface VizEdge {
  source: string;
  target: string;
  kind: string;
  label: string;
}

export interface VizGraph {
  nodes: VizNode[];
  edges: VizEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    kindCounts: Record<string, number>;
  };
}

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

export interface TermRef {
  type: "uri" | "literal" | "bnode" | "unknown";
  value: string;
  prefixed?: string;
  label?: string;
  lang?: string | null;
  datatype?: string | null;
}

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

export interface GraphPalette {
  kind: Record<string, string>;
  edge: Record<string, string>;
  defaultEdge: string;
  dimNode: string;
  dimEdge: string;
  label: string;
  edgeLabel: string;
  background: string;
}

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

export function kindColor(kind: string, theme: Theme): string {
  const palette = PALETTES[theme].kind;
  return palette[kind] ?? palette.other;
}

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
