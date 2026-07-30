/*
================================================================================
FILE: frontend/src/explore/suggestions.ts
================================================================================

SUMMARY
    The two pure functions behind Explore mode's starting panel: which entities
    are worth opening first, and one sentence saying what the loaded ontology
    contains. Neither renders anything.

BASIC IDEA
    Explore mode is where everyone lands and it said nothing until a node was
    clicked. Both answers are already in the /graph response the browser holds,
    so this module derives them rather than asking the server for anything:
    `degree` ranks the entities, `stats.kindCounts` describes the contents.

    The ranking is deliberately not a plain "top eight by degree". In an
    individual-heavy ontology that returns eight individuals and hides that
    classes exist, so the first pass takes at most three from any one kind and
    only then fills the remaining slots from the overall ranking. Ontology-header
    nodes are skipped: they are the file's own metadata, often high-degree, and
    never what a newcomer wants to open first.

    Split out from the component on purpose, following sparql/starters.ts and
    QueryStart.tsx: the ranking and the wording are testable without rendering
    anything, which is why the query builder is the best-tested part of this
    frontend.

INPUTS / INPUT SOURCES
    - A VizGraph (the /graph response) or null. Nothing else; no requests, no
      DOM, no globals.

EXPECTED OUTPUT
    - suggestedEntities -> up to `limit` VizNodes, highest degree first, ties
      broken by id so the list is identical on every load.
    - describeContents -> "This ontology describes 412 classes, 58 object
      properties and 1,104 individuals.", built only from counts and the
      KIND_LABELS constant.
================================================================================
*/

import { plural } from "../sparql/describe";
import type { VizGraph, VizNode } from "../types";
import { KIND_LABELS } from "../types";

/** Eight fills the 380px panel without scrolling, and leaves the per-kind
 *  spread rule room to show three kinds. Reversible by one constant. */
const SUGGESTION_LIMIT = 8;

/** At most three from any one kind before moving on. A ceiling, not a quota:
 *  a kind with one entity contributes one. */
const PER_KIND_CEILING = 3;

/** The file's own `owl:Ontology` declaration. Excluded from the suggestions
 *  rather than from the summary sentence, which counts the whole ontology. */
const HEADER_KIND = "ontology";

/** A sentence naming eleven kinds is a sentence nobody reads. */
const MAX_NAMED_KINDS = 3;

/** What an ontology with nothing drawable says. Reachable with a file
 *  containing only blank nodes, which build_viz_graph keeps out of the visual
 *  graph, and used for a null graph so this function never throws. */
const NO_ENTITIES = "This ontology has no entities to display.";

/**
 * Descending degree, then ascending id. The id tiebreak is what makes the list
 * identical on every load, and it is the same rule `budget_viz` applies on the
 * server, so the panel and the canvas rank entities the same way.
 */
function byRank(a: VizNode, b: VizNode): number {
  if (a.degree !== b.degree) return b.degree - a.degree;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Up to `limit` entities worth opening first: highest degree, at most `perKind`
 * from any one kind before the remaining slots are filled from the overall
 * ranking, ontology-header nodes excluded, ties broken by id so the result is
 * stable.
 */
export function suggestedEntities(
  graph: VizGraph | null,
  limit = SUGGESTION_LIMIT,
  perKind = PER_KIND_CEILING,
): VizNode[] {
  if (!graph || limit <= 0) return [];

  // A plain sort, and that is a measurement rather than laziness. This was first
  // written as a single pass keeping the best `limit` per kind, on the assumption
  // that sorting 40,000 nodes would not fit the 20 ms budget. Measured on
  // 2026-07-30, 40,000 nodes across eleven kinds: the partial selection took
  // 0.48–0.70 ms and the sort below takes **0.68 ms**. There was nothing to buy,
  // and the version that bought it was three times the code. Do not reintroduce
  // it without a number that says otherwise.
  //
  // `filter` before `sort` is also what keeps `sort` off the response's own
  // array: it returns a new one. Sorting `graph.nodes` in place would reorder
  // the object App holds and every other component reads.
  const ranked = graph.nodes.filter((n) => n.kind !== HEADER_KIND).sort(byRank);

  // First pass: down the ranking, at most `perKind` from any one kind.
  const taken: VizNode[] = [];
  const perKindCount = new Map<string, number>();
  for (const node of ranked) {
    if (taken.length >= limit) break;
    const count = perKindCount.get(node.kind) ?? 0;
    if (count >= perKind) continue;
    perKindCount.set(node.kind, count + 1);
    taken.push(node);
  }

  // Second pass: the ceiling has left slots empty because the ontology does not
  // have enough kinds to fill them, so the rest go to the overall ranking. An
  // ontology of nothing but classes shows eight classes, not three.
  if (taken.length < limit) {
    const chosen = new Set(taken.map((n) => n.id));
    for (const node of ranked) {
      if (taken.length >= limit) break;
      if (!chosen.has(node.id)) taken.push(node);
    }
  }

  // Sorted rather than returned in selection order: the second pass appends
  // below the ceiling's picks, and the list the user reads is meant to descend.
  return taken.sort(byRank);
}

/**
 * "object property" for one, "object properties" for more. `plural` is the
 * query builder's, reused rather than copied — this is the same problem in a
 * different panel, and two naive pluralisers would disagree eventually.
 */
function kindWords(kind: string, count: number): string {
  const label = KIND_LABELS[kind] ?? KIND_LABELS.other;
  // Lowercased to read mid-sentence, except when the label opens with an
  // acronym: "SKOS concept" is not a capitalised word and "skos concepts" is
  // wrong in a way a learner would notice.
  const lowered = /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  return count === 1 ? lowered : plural(lowered);
}

/** "a, b and c" — no Oxford comma, matching the sentence in the specification. */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "This ontology describes 412 classes, 58 object properties and 1,104
 * individuals." Built from `stats.kindCounts`, naming at most the three largest
 * kinds.
 *
 * Every word of the result comes from a number or from KIND_LABELS. Nothing is
 * interpolated from the ontology, not even a kind string: an unrecognised kind
 * falls back to "other" rather than being printed. The counts describe the
 * whole ontology rather than what is drawn, because kindCounts does — D-017.
 */
export function describeContents(graph: VizGraph | null): string {
  if (!graph) return NO_ENTITIES;
  const present = Object.entries(graph.stats.kindCounts)
    .filter(([, count]) => count > 0)
    // By count, then by kind name: the object's own key order comes from JSON
    // and is not something to rely on for a sentence that must not change
    // between two loads of the same file.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (present.length === 0) return NO_ENTITIES;

  const named = present
    .slice(0, MAX_NAMED_KINDS)
    .map(([kind, count]) => `${count.toLocaleString()} ${kindWords(kind, count)}`);
  return `This ontology describes ${joinWithAnd(named)}.`;
}
