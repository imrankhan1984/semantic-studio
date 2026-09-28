/*
================================================================================
FILE: frontend/src/canvas/relate.ts
================================================================================

SUMMARY
    What a line drawn between two boxes may mean (visual-modeling 5.4,
    Relating): the choices the relate menu offers, the notes it shows, or the
    sentence that refuses the line. Also the aria name a box is given, the
    tree's words read aloud (*Invoice, class, kind of Document, 2
    subclasses*).

BASIC IDEA
    A rule, so it lives outside the component and is tested without drawing
    anything (CLAUDE.md's split for anything with a rule in it).

    Class to class offers *is a kind of*, *new relationship…*, and any
    existing relationship the line would complete rather than change: one
    with no domain and no range, or with one end already this line's. One
    already linking other classes is never offered, because SetDomain would
    silently change what it means elsewhere; the menu says so instead.
    Concept to concept offers *narrower than*. A class and a concept cannot be
    linked here at all. A line that would change an imported box, or link a
    box to itself, is refused with a sentence. A link that already exists is
    not offered again.

INPUTS / INPUT SOURCES
    - The canvas view from the server: its boxes, lines and undrawn
      relationships.

EXPECTED OUTPUT
    - relateChoices(view, from, to) -> { refusal } or { choices, notes }.
    - boxName(view, iri) -> the box's accessible name.
================================================================================
*/

import type { CanvasNode, CanvasView } from "../types";

export type RelateChoice =
  | { kind: "subClassOf"; label: string }
  | { kind: "broader"; label: string }
  | { kind: "newRelationship"; label: string }
  | {
      kind: "existing";
      label: string;
      property: string;
      // Which ends the command must set: the one it lacks, or both.
      setDomain: boolean;
      setRange: boolean;
    };

export type RelateResult =
  | { refusal: string }
  | { choices: RelateChoice[]; notes: string[] };

const CLASS_CONCEPT =
  "A class and a concept cannot be linked here. Use the form for other annotations.";

function node(view: CanvasView, iri: string): CanvasNode | undefined {
  return view.nodes.find((n) => n.iri === iri);
}

export function relateChoices(view: CanvasView, fromIri: string, toIri: string): RelateResult {
  const from = node(view, fromIri);
  const to = node(view, toIri);
  if (!from || !to) return { refusal: "Draw the line from one box to another." };
  if (from.iri === to.iri) return { refusal: "A box cannot be linked to itself." };
  if (from.kind !== to.kind) return { refusal: CLASS_CONCEPT };
  if (from.imported) {
    return {
      refusal: `${from.label} comes from ${from.imported === "outside" ? "outside this model" : from.imported} and is read-only. Draw the line from a box of this model.`,
    };
  }
  const has = (kind: string) =>
    view.edges.some((e) => e.kind === kind && e.source === from.iri && e.target === to.iri);

  if (from.kind === "concept") {
    if (has("broader")) return { refusal: `${from.label} is already narrower than ${to.label}.` };
    return { choices: [{ kind: "broader", label: "narrower than" }], notes: [] };
  }

  const choices: RelateChoice[] = [];
  if (!has("subClassOf")) choices.push({ kind: "subClassOf", label: "is a kind of" });
  choices.push({ kind: "newRelationship", label: "new relationship…" });
  for (const u of view.undrawn) {
    if (u.kind !== "objectProperty") continue;
    const domainFits = u.domain === null || u.domain === from.iri;
    const rangeFits = u.range === null || u.range === to.iri;
    if (!domainFits || !rangeFits) continue;
    choices.push({
      kind: "existing",
      label: u.label,
      property: u.iri,
      setDomain: u.domain === null,
      setRange: u.range === null,
    });
  }
  // Drawn relationships sharing an end with this line are not offered, and
  // the menu says why, so the learner does not look for them in vain.
  const notes = view.edges
    .filter(
      (e) =>
        e.kind === "relationship" &&
        (e.source === from.iri || e.target === to.iri) &&
        !(e.source === from.iri && e.target === to.iri),
    )
    .slice(0, 3)
    .map((e) => {
      const a = node(view, e.source)?.label ?? e.source;
      const b = node(view, e.target)?.label ?? e.target;
      return `${e.label} already links ${a} to ${b}; create a new relationship instead.`;
    });
  return { choices, notes };
}

/** A box read aloud as the tree reads a row. */
export function boxName(view: CanvasView, iri: string): string {
  const n = node(view, iri);
  if (!n) return iri;
  const parts = [n.label, n.kind];
  const up = n.kind === "class" ? "subClassOf" : "broader";
  const parents = view.edges.filter((e) => e.kind === up && e.source === iri).map((e) => node(view, e.target)?.label);
  if (parents.length) parts.push(`${n.kind === "class" ? "kind of" : "narrower than"} ${parents.join(" and ")}`);
  const children = view.edges.filter((e) => e.kind === up && e.target === iri).length;
  if (children) {
    const word = n.kind === "class" ? ["subclass", "subclasses"] : ["narrower concept", "narrower concepts"];
    parts.push(`${children} ${children === 1 ? word[0] : word[1]}`);
  }
  if (n.imported) parts.push(n.imported === "outside" ? "outside this model, read-only" : `from ${n.imported}, read-only`);
  return parts.join(", ");
}
