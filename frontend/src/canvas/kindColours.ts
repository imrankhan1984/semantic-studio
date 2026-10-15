/*
================================================================================
FILE: frontend/src/canvas/kindColours.ts
================================================================================

SUMMARY
    Colour by kind on the Edit page (edit-page-rework 5.8): the tokens for
    each box kind (OWL class, RDFS class, SKOS concept, concept scheme,
    example, attribute) and each line kind (kind of, relationship, broader,
    related, rule), in both themes; the word each kind is named by; and the
    WCAG contrast arithmetic that proves the pairs readable.

BASIC IDEA
    The colours live in index.css as custom properties, one set per theme,
    so the boxes, lines and outline dots are styled by class and follow the
    theme switch with no re-render. This file names the canvas's kinds in
    the portal's one palette (theme/kinds.ts, D-109), which writes every
    value: kindColours.test.ts measures every pair against its floor, and
    checks index.css still says what the palette says, so the two cannot
    drift apart unnoticed.

    Colour is never the only signal (5.8): every box says its kind in words
    (`kindWord`), every line keeps its label and its pattern. The accents are
    close in lightness on purpose, which is why the words are required.

    Explore's graph and every other tab draw from the same palette
    (types.ts reads it too; portal-foundations 5.3).

INPUTS / INPUT SOURCES
    - A canvas box or outline row's kind, class type and import.

EXPECTED OUTPUT
    - TOKENS, LINES, CANVAS_BG: the values index.css carries.
    - boxKind(), kindWord(): what a box is drawn and named as. (The
      outline's dots map their own kinds in HierarchyView, which must not
      import from canvas/: App reaches canvas/ only through React.lazy.)
    - contrast(): the WCAG ratio of two colours (theme/contrast.ts).
================================================================================
*/

import type { CanvasNode } from "../types";
import { EDGES, KINDS, type KindTokens, type Theme } from "../theme/kinds";

export type BoxKind = "owl" | "rdfs" | "concept" | "scheme" | "example" | "attribute";
export type LineKind = "kindof" | "relationship" | "broader" | "related" | "rule";
export type { Theme };

/** accent: the band, a line, a dot; tint: the header and label fill; ink:
 *  the kind word and label text. 5.8's table, now read from the portal's
 *  one palette (theme/kinds.ts, D-109): the Edit page looks as it did. */
const fromPalette = (t: Theme): Record<BoxKind, KindTokens> => ({
  owl: KINDS[t].class,
  rdfs: KINDS[t].rdfsClass,
  concept: KINDS[t].concept,
  scheme: KINDS[t].conceptScheme,
  example: KINDS[t].individual,
  attribute: KINDS[t].datatypeProperty,
});
export const TOKENS: Record<Theme, Record<BoxKind, KindTokens>> = {
  light: fromPalette("light"),
  dark: fromPalette("dark"),
};

/** Each line's colour (5.8): the graph's edge colours for the same meaning. */
const lines = (t: Theme): Record<LineKind, string> => ({
  kindof: EDGES[t].subClassOf,
  relationship: EDGES[t].assertion,
  broader: EDGES[t].broader,
  related: EDGES[t].related,
  rule: EDGES[t].disjointWith,
});
export const LINES: Record<Theme, Record<LineKind, string>> = { light: lines("light"), dark: lines("dark") };
/** A relationship's label has a tint of its own: the object property's. */
export const RELATIONSHIP_TINT: Record<Theme, string> = {
  light: KINDS.light.objectProperty.tint,
  dark: KINDS.dark.objectProperty.tint,
};

/** The canvas surface the lines are drawn on. White in the light theme: on
 *  the page's grey (#eef1f6) the relationship line measured 3.4:1, under
 *  5.8's 3.7; on white it is 3.8. */
export const CANVAS_BG: Record<Theme, string> = { light: "#ffffff", dark: "#0f1219" };
/** Body text, as index.css's --text, read on every tint. */
export const BODY_TEXT: Record<Theme, string> = { light: "#1f2430", dark: "#dbe2ee" };

/** What a canvas box is drawn as. */
export function boxKind(node: Pick<CanvasNode, "kind" | "classType">): BoxKind {
  if (node.kind === "concept") return "concept";
  return node.classType === "rdfs" ? "rdfs" : "owl";
}

const WORDS: Record<BoxKind, string> = {
  owl: "OWL class",
  rdfs: "RDFS class",
  concept: "concept",
  scheme: "scheme",
  example: "example",
  attribute: "attribute",
};

/** The kind in words, as a box's header shows it (in capitals, by CSS) and
 *  its accessible name says it: *Person, OWL class*. An imported box names
 *  its import instead: *imported · FOAF*. */
export function kindWord(node: Pick<CanvasNode, "kind" | "classType" | "imported">): string {
  if (node.imported) return node.imported === "outside" ? "outside this model" : `imported · ${node.imported}`;
  return WORDS[boxKind(node)];
}

/** The WCAG 2 contrast ratio of two #rrggbb colours. */
export { contrast } from "../theme/contrast";
