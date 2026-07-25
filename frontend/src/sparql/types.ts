/** Query builder state model — pure data, no React, no DOM. */

export type Modifier = "" | "*" | "+" | "?";

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

export interface LinkPredicate {
  iri: string;
  /** true when the hop traverses the predicate backwards (`^p`). */
  inverse: boolean;
}

export interface StepLink {
  /** Index of the step this one hangs off — paths branch, they aren't a chain. */
  anchor: number;
  /** One predicate, or several to form an alternation (`p1|^p2`). */
  predicates: LinkPredicate[];
  modifier: Modifier;
  optional: boolean;
}

export interface PropFilter {
  op: FilterOp;
  value: string;
}

export interface SelectedProp {
  predicateIri: string;
  label: string;
  /** Full IRI of the observed datatype, used to emit correctly typed literals. */
  datatype?: string;
  optional: boolean;
  filter?: PropFilter;
}

export interface QueryStep {
  classIri: string;
  label: string;
  /** Set when the user clicked a specific individual rather than a class. */
  pin?: { iri: string; label: string } | null;
  props: SelectedProp[];
  /** Absent on the root step. */
  link?: StepLink;
}

export interface QueryState {
  steps: QueryStep[];
  limit: number;
  /** Collapse bare hops into compact property paths. */
  pathsMode: boolean;
  distinct: boolean;
}

export function emptyQueryState(): QueryState {
  return { steps: [], limit: 100, pathsMode: false, distinct: false };
}
