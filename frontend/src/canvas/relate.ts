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
    linked here at all. A line that would change an imported box is refused
    with a sentence. A link that already exists is not offered again.

    Each choice is labelled by the sentence it would make (relationships
    5.3): *Person is a kind of Organization*, so a wrong direction is seen
    before it is confirmed, and the menu can be asked again the other way
    round. A class may be linked to itself by a relationship (*Person knows
    Person*), never by *is a kind of*; a concept never to itself.

    The project's kind decides which boxes the canvas may link (D-089): an
    ontology's concepts, and a taxonomy's classes, are drawn but read-only
    here, and a line from one says where to change them instead.

INPUTS / INPUT SOURCES
    - The canvas view from the server: its kind, boxes, lines and undrawn
      relationships.

EXPECTED OUTPUT
    - relateChoices(view, from, to) -> { refusal } or { choices, notes }.
    - boxName(view, iri) -> the box's accessible name.
================================================================================
*/

import { existingSentence, linkSentence } from "../modeling/sentences";
import type { CanvasNode, CanvasView } from "../types";

export type RelateChoice =
  | { kind: "subClassOf"; label: string }
  | { kind: "broader"; label: string }
  | { kind: "newRelationship"; label: string }
  | {
      kind: "existing";
      label: string;
      // The relationship's own name; `label` is the sentence it would make.
      name: string;
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

/** Why a box of the other kind is not linked here, or null (D-089). */
export function otherKindRefusal(view: CanvasView, box: CanvasNode): string | null {
  if (view.kind === "ontology" && box.kind === "concept") {
    return `${box.label} is a SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.`;
  }
  if (view.kind === "taxonomy" && box.kind === "class") {
    return `${box.label} is a class, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.`;
  }
  return null;
}

export function relateChoices(view: CanvasView, fromIri: string, toIri: string): RelateResult {
  const from = node(view, fromIri);
  const to = node(view, toIri);
  if (!from || !to) return { refusal: "Draw the line from one box to another." };
  if (from.kind !== to.kind) return { refusal: CLASS_CONCEPT };
  const otherKind = otherKindRefusal(view, from) ?? otherKindRefusal(view, to);
  if (otherKind) return { refusal: otherKind };
  const self = from.iri === to.iri;
  if (self && from.kind === "concept") return { refusal: `${from.label} cannot be narrower than itself.` };
  if (from.imported) {
    return {
      refusal: `${from.label} comes from ${from.imported === "outside" ? "outside this model" : from.imported} and is read-only. Draw the line from a box of this model.`,
    };
  }
  const has = (kind: string) =>
    view.edges.some((e) => e.kind === kind && e.source === from.iri && e.target === to.iri);

  if (from.kind === "concept") {
    if (has("broader")) return { refusal: `${from.label} is already narrower than ${to.label}.` };
    return { choices: [{ kind: "broader", label: linkSentence("broader", from.label, to.label) }], notes: [] };
  }

  const choices: RelateChoice[] = [];
  // A class is never a kind of itself; a relationship to itself is fine.
  if (!self && !has("subClassOf")) {
    choices.push({ kind: "subClassOf", label: linkSentence("subClassOf", from.label, to.label) });
  }
  choices.push({ kind: "newRelationship", label: "new relationship…" });
  for (const u of view.undrawn) {
    // An end that is an expression is set, not missing: completing it would
    // replace what it says.
    if (u.kind !== "objectProperty" || u.missing === "expression") continue;
    const domainFits = u.domain === null || u.domain === from.iri;
    const rangeFits = u.range === null || u.range === to.iri;
    if (!domainFits || !rangeFits) continue;
    choices.push({
      kind: "existing",
      label: existingSentence(from.label, u.label, to.label),
      name: u.label,
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
