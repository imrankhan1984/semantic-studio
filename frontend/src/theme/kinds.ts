/*
================================================================================
FILE: frontend/src/theme/kinds.ts
================================================================================

SUMMARY
    The one kind palette (portal-foundations 5.3, D-109): every kind's
    accent, tint and ink in both themes, every graph edge's colour, and the
    graph's node opacity. The only place a kind's colour is written; the
    Edit page (canvas/kindColours.ts) and every other tab (types.ts) read it.

BASIC IDEA
    The Edit page's tokens (edit-page-rework 5.8) became the portal's, with
    the graph's other kinds added. The accent marks a dot, node or line; the
    tint fills a header or label; the ink writes the kind's word on its tint.
    Colour is never the only signal: every kind has its word beside it
    somewhere on the screen (KIND_LABELS, the canvas's kind words).

    It sits outside canvas/ on purpose: App reaches canvas/ only through
    React.lazy (D-086), so the graph's palette could not live there.

    Lookups are own-key (`own`): a kind is a string from a loaded file, and
    `"constructor" in {}` is true (X-6). An unknown kind is "other".

INPUTS / INPUT SOURCES
    - A graph node's kind and, for a class, its classType.

EXPECTED OUTPUT
    - KINDS, EDGES, NEUTRAL_EDGE, GRAPH_ALPHA: the values.
    - paletteKind(kind, classType): which row of KINDS a node is drawn from.
    - own(map, key): an own-key lookup, undefined for an inherited name.
================================================================================
*/

export type Theme = "light" | "dark";

export type PaletteKind =
  | "class"
  | "rdfsClass"
  | "concept"
  | "conceptScheme"
  | "individual"
  | "objectProperty"
  | "datatypeProperty"
  | "annotationProperty"
  | "property"
  | "collection"
  | "ontology"
  | "other";

export interface KindTokens {
  accent: string;
  tint: string;
  ink: string;
}

/** portal-foundations 5.3's table, word for word. `rdfsClass` is a class
 *  node with `classType: "rdfs"`; its kind on the wire is still "class". */
export const KINDS: Record<Theme, Record<PaletteKind, KindTokens>> = {
  light: {
    class: { accent: "#4a72a8", tint: "#e6eef8", ink: "#3d6194" },
    rdfsClass: { accent: "#2f7f78", tint: "#e1f1ee", ink: "#25665f" },
    concept: { accent: "#7e5fb0", tint: "#eee8f7", ink: "#654a91" },
    conceptScheme: { accent: "#a65579", tint: "#f7e7ee", ink: "#8a4262" },
    individual: { accent: "#4f8a55", tint: "#e5f2e5", ink: "#3d6e43" },
    objectProperty: { accent: "#b0763a", tint: "#f8eddf", ink: "#7a4f1f" },
    datatypeProperty: { accent: "#8a7a2e", tint: "#f4f0dc", ink: "#6b5e22" },
    annotationProperty: { accent: "#7a6656", tint: "#efe9e4", ink: "#7a6656" },
    property: { accent: "#9c5a3c", tint: "#f6e6de", ink: "#8a4e33" },
    collection: { accent: "#8a6aa0", tint: "#f1eaf5", ink: "#6f5385" },
    ontology: { accent: "#3b6f86", tint: "#e2eef3", ink: "#3b6f86" },
    other: { accent: "#6b7588", tint: "#eef0f4", ink: "#5d6678" },
  },
  dark: {
    class: { accent: "#8fb3e3", tint: "#22324a", ink: "#b5cdee" },
    rdfsClass: { accent: "#7cc6bb", tint: "#1d3936", ink: "#a7dbd3" },
    concept: { accent: "#b9a0e6", tint: "#30284a", ink: "#d3c4f0" },
    conceptScheme: { accent: "#e39abd", tint: "#45283a", ink: "#efbfd5" },
    individual: { accent: "#8fcb94", tint: "#22382a", ink: "#b6dfb9" },
    objectProperty: { accent: "#e2ad6e", tint: "#43321c", ink: "#efcb9f" },
    datatypeProperty: { accent: "#d2c06a", tint: "#3a361c", ink: "#e4d89d" },
    annotationProperty: { accent: "#c8b4a3", tint: "#3a312a", ink: "#ddd0c4" },
    property: { accent: "#e59a7a", tint: "#45291f", ink: "#f0bfa8" },
    collection: { accent: "#cbb0df", tint: "#352a3d", ink: "#ddcbea" },
    ontology: { accent: "#86bfd6", tint: "#1f3540", ink: "#b0d6e6" },
    other: { accent: "#a3acbd", tint: "#262c37", ink: "#c3cad6" },
  },
};

/** An edge whose meaning has no kind colour: domain, range, seeAlso, and
 *  any kind the server adds later. */
export const NEUTRAL_EDGE: Record<Theme, string> = { light: "#7b8494", dark: "#9aa3b2" };

const edges = (t: Theme, related: string, rule: string): Record<string, string> => {
  const k = KINDS[t];
  return {
    subClassOf: k.class.accent,
    broader: k.concept.accent,
    related,
    member: related,
    inScheme: k.conceptScheme.accent,
    instanceOf: k.individual.accent,
    assertion: k.objectProperty.accent,
    subPropertyOf: k.objectProperty.accent,
    inverseOf: k.objectProperty.accent,
    disjointWith: rule,
    equivalentClass: k.rdfsClass.accent,
    equivalentProperty: k.rdfsClass.accent,
    sameAs: k.rdfsClass.accent,
    domain: NEUTRAL_EDGE[t],
    range: NEUTRAL_EDGE[t],
    seeAlso: NEUTRAL_EDGE[t],
  };
};

/** Each graph edge kind's colour (5.3's second table). The Edit page's
 *  lines are the same values: kind of, relationship, broader, related, rule. */
export const EDGES: Record<Theme, Record<string, string>> = {
  light: edges("light", "#94649f", "#a8566b"),
  dark: edges("dark", "#cfa0db", "#e08fa3"),
};

/** The graph's nodes are translucent (G-8: overlaps stay readable). 95 % in
 *  the light theme, where 90 % left the object property at exactly 3.00:1
 *  on the graph; 85 % in the dark theme, where every kind is above 6:1. */
export const GRAPH_ALPHA: Record<Theme, string> = { light: "f2", dark: "d9" };

/** `map[key]` only if `key` is the map's own: a kind named `constructor` or
 *  `__proto__` must not find Object.prototype's (X-6). */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The row of KINDS a node is drawn from. `rdfsClass` is reached only
 *  through classType, never named as a kind. */
export function paletteKind(kind: string, classType?: string | null): PaletteKind {
  if (kind === "class" && classType === "rdfs") return "rdfsClass";
  if (kind === "rdfsClass" || !own(KINDS.light, kind)) return "other";
  return kind as PaletteKind;
}
