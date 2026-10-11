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
    theme switch with no re-render. This file holds the same values as data,
    for two reasons: kindColours.test.ts measures every pair against its
    floor, and checks index.css still says what this file says, so the two
    cannot drift apart unnoticed.

    Colour is never the only signal (5.8): every box says its kind in words
    (`kindWord`), every line keeps its label and its pattern. The accents are
    close in lightness on purpose, which is why the words are required.

    Explore's graph keeps its own palette (types.ts, kindColor): the
    portal-wide scheme is U-10's change, with all four of its users (X-6).

INPUTS / INPUT SOURCES
    - A canvas box or outline row's kind, class type and import.

EXPECTED OUTPUT
    - TOKENS, LINES, CANVAS_BG: the values index.css carries.
    - boxKind(), kindWord(): what a box is drawn and named as. (The
      outline's dots map their own kinds in HierarchyView, which must not
      import from canvas/: App reaches canvas/ only through React.lazy.)
    - contrast(): the WCAG ratio of two colours.
================================================================================
*/

import type { CanvasNode } from "../types";

export type BoxKind = "owl" | "rdfs" | "concept" | "scheme" | "example" | "attribute";
export type LineKind = "kindof" | "relationship" | "broader" | "related" | "rule";
export type Theme = "light" | "dark";

/** accent: the band, a line, a dot; tint: the header and label fill; ink:
 *  the kind word and label text. 5.8's table, word for word. */
export const TOKENS: Record<Theme, Record<BoxKind, { accent: string; tint: string; ink: string }>> = {
  light: {
    owl: { accent: "#4a72a8", tint: "#e6eef8", ink: "#3d6194" },
    rdfs: { accent: "#2f7f78", tint: "#e1f1ee", ink: "#25665f" },
    concept: { accent: "#7e5fb0", tint: "#eee8f7", ink: "#654a91" },
    scheme: { accent: "#a65579", tint: "#f7e7ee", ink: "#8a4262" },
    example: { accent: "#4f8a55", tint: "#e5f2e5", ink: "#3d6e43" },
    attribute: { accent: "#8a7a2e", tint: "#f4f0dc", ink: "#6b5e22" },
  },
  dark: {
    owl: { accent: "#8fb3e3", tint: "#22324a", ink: "#b5cdee" },
    rdfs: { accent: "#7cc6bb", tint: "#1d3936", ink: "#a7dbd3" },
    concept: { accent: "#b9a0e6", tint: "#30284a", ink: "#d3c4f0" },
    scheme: { accent: "#e39abd", tint: "#45283a", ink: "#efbfd5" },
    example: { accent: "#8fcb94", tint: "#22382a", ink: "#b6dfb9" },
    attribute: { accent: "#d2c06a", tint: "#3a361c", ink: "#e4d89d" },
  },
};

/** Each line's colour (5.8). A relationship's label has a tint of its own. */
export const LINES: Record<Theme, Record<LineKind, string>> = {
  light: { kindof: "#4a72a8", relationship: "#b0763a", broader: "#7e5fb0", related: "#94649f", rule: "#a8566b" },
  dark: { kindof: "#8fb3e3", relationship: "#e2ad6e", broader: "#b9a0e6", related: "#cfa0db", rule: "#e08fa3" },
};
export const RELATIONSHIP_TINT: Record<Theme, string> = { light: "#f8eddf", dark: "#43321c" };

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

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The WCAG 2 contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
