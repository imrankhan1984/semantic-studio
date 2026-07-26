/**
 * Renders builder state as a plain-English sentence.
 *
 * The generated SPARQL is meaningless to someone new to the Semantic Web,
 * so the query is also stated in words. Pure and dependency-free, like the
 * generator, so it can be unit tested directly.
 */

import type { FilterOp, QueryState, QueryStep, SelectedProp } from "./types";

const OP_WORDS: Record<FilterOp, string> = {
  "=": "is",
  "!=": "is not",
  ">": "is greater than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
  contains: "contains",
  startsWith: "starts with",
  lang: "is written in",
};

const MODIFIER_WORDS: Record<string, string> = {
  "": "",
  "*": " any number of times (including none)",
  "+": " one or more times",
  "?": " at most once",
};

function lower(label: string): string {
  // Keep acronyms and CamelCase names as they are; only lowercase a plain
  // capitalised word so it reads naturally mid-sentence.
  return /^[A-Z][a-z]+$/.test(label) ? label.toLowerCase() : label;
}

export function plural(label: string): string {
  const word = lower(label);
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function describeFilter(prop: SelectedProp): string | null {
  const filter = prop.filter;
  if (!filter || filter.value.trim() === "") return null;
  return `${lower(prop.label)} ${OP_WORDS[filter.op]} “${filter.value.trim()}”`;
}

function describeHop(step: QueryStep, steps: QueryStep[], predicateLabel: (iri: string) => string): string {
  const link = step.link;
  if (!link) return "";
  const anchor = steps[link.anchor];
  const anchorName = anchor ? lower(anchor.label) : "it";
  const names = link.predicates
    .map((p) => `${predicateLabel(p.iri)}${p.inverse ? " (reversed)" : ""}`)
    .join(" or ");
  const modifier = MODIFIER_WORDS[link.modifier] ?? "";
  const target = plural(step.label);
  const lead = link.optional ? "optionally follow" : "follow";
  return `${lead} ${names}${modifier} from each ${anchorName} to its ${target}`;
}

export function describeQuery(
  state: QueryState,
  predicateLabel: (iri: string) => string = (iri) => iri,
): string {
  if (state.steps.length === 0) return "";

  const root = state.steps[0];
  const sentences: string[] = [];

  const rootPhrase = root.pin
    ? `Start from ${root.pin.label} (a ${lower(root.label)})`
    : `Start from every ${lower(root.label)}`;

  const hops = state.steps
    .slice(1)
    .map((step) => describeHop(step, state.steps, predicateLabel))
    .filter(Boolean);

  sentences.push(hops.length ? `${rootPhrase}, then ${hops.join(", then ")}.` : `${rootPhrase}.`);

  // What comes back
  const shown: string[] = [];
  const conditions: string[] = [];
  for (const step of state.steps) {
    for (const prop of step.props) {
      const condition = describeFilter(prop);
      if (condition) conditions.push(`the ${lower(step.label)}’s ${condition}`);
      else shown.push(`${lower(step.label)}’s ${lower(prop.label)}`);
    }
    if (step.pin && step !== root) {
      conditions.push(`the ${lower(step.label)} is ${step.pin.label}`);
    }
  }

  if (state.aggregate === "count") {
    const last = state.steps[state.steps.length - 1];
    sentences.push(
      state.steps.length > 1
        ? `Report how many ${plural(last.label)} each ${lower(root.label)} has, largest first.`
        : `Report how many ${plural(root.label)} there are.`,
    );
  } else if (shown.length > 0) {
    sentences.push(`Also show ${shown.join(", ")}.`);
  }

  if (conditions.length > 0) {
    sentences.push(`Only where ${conditions.join(" and ")}.`);
  }

  if (state.aggregate !== "count") {
    sentences.push(
      `Return at most ${state.limit.toLocaleString()} ${
        state.distinct ? "distinct rows" : "rows"
      }.`,
    );
  }

  return sentences.join(" ");
}
