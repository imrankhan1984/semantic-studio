/*
================================================================================
FILE: frontend/src/sparql/types.ts
================================================================================

SUMMARY
    The TypeScript data model for the visual query builder — the plain-data
    shapes that describe a query as the user builds it. No React, no DOM.

BASIC IDEA
    A query is a tree of "steps" (each a class, optionally pinned to one
    individual, with selected data properties/filters) joined by "links" (a
    predicate hop that can be inverted, alternated, given a path modifier, or
    made OPTIONAL). Keeping this as pure data lets the generator, the describer
    and the React UI all share one definition and lets the logic be unit tested
    without a browser.

INPUTS / INPUT SOURCES
    - Mutated by the query-builder hook as the user clicks; produced by the
      starters module; persisted as part of a saved query.

EXPECTED OUTPUT
    - Types imported across the sparql/ modules and the query components.
    - emptyQueryState(): the initial blank query.
================================================================================
*/

// A property-path modifier applied to a hop: none, zero-or-more, one-or-more,
// zero-or-one.
export type Modifier = "" | "*" | "+" | "?";

// The comparison operators offered for a data-property filter.
export type FilterOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "startsWith"
  | "lang";

// One predicate used in a hop, plus whether it is traversed backwards.
export interface LinkPredicate {
  iri: string;
  /** true when the hop traverses the predicate backwards (`^p`). */
  inverse: boolean;
}

// How a step connects to an earlier step. Because paths BRANCH, a link records
// which step it hangs off (anchor), not merely "the previous step".
export interface StepLink {
  /** Index of the step this one hangs off — paths branch, they aren't a chain. */
  anchor: number;
  /** One predicate, or several to form an alternation (`p1|^p2`). */
  predicates: LinkPredicate[];
  modifier: Modifier;   // property-path modifier on this hop
  optional: boolean;    // wrap this hop (and its subtree) in OPTIONAL
}

// A comparison filter on a selected data property (operator + entered value).
export interface PropFilter {
  op: FilterOp;
  value: string;
}

// A data property the user chose to return for a step, with optional filter.
export interface SelectedProp {
  predicateIri: string;
  label: string;
  /** Full IRI of the observed datatype, used to emit correctly typed literals. */
  datatype?: string;
  optional: boolean;    // return the property as OPTIONAL (rows without it still match)
  filter?: PropFilter;  // when set, constrains and forces the property present
}

// One node in the query path: a class, optionally pinned to a single
// individual, with chosen data properties and the link that reaches it.
export interface QueryStep {
  classIri: string;
  label: string;
  /** Set when the user clicked a specific individual rather than a class. */
  pin?: { iri: string; label: string } | null;
  props: SelectedProp[];
  /** Absent on the root step. */
  link?: StepLink;
}

// Whether the query returns rows or a count.
export type Aggregate = "none" | "count";

// The complete query being built: the step tree plus the global options.
export interface QueryState {
  steps: QueryStep[];
  limit: number;
  /** Collapse bare hops into compact property paths. */
  pathsMode: boolean;
  distinct: boolean;
  /** "count" turns the query into "how many", grouped by the first step. */
  aggregate: Aggregate;
}

// The initial blank query (no steps, sensible defaults). Used on reset and as
// the base for starter queries.
export function emptyQueryState(): QueryState {
  return { steps: [], limit: 100, pathsMode: false, distinct: false, aggregate: "none" };
}
