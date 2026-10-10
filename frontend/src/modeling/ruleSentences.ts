/*
================================================================================
FILE: frontend/src/modeling/ruleSentences.ts
================================================================================

SUMMARY
    A class's rules in the learner's words (axioms-and-reasoning 5.8, 5.9),
    both ways: a rule as its sentence (*Every Order has at least one has
    line that is an Order line*, *A Manager is exactly a Person that manages
    at least one Employee*, *No Person is an Organization*), its canvas
    label (*at least 1 · has line*, *only · has line*, *defines*) and its
    open-world note; and the sentence builder's state as the sentence so
    far, the problem that stops Add, and the one command Add sends.

BASIC IDEA
    The server reads a rule out of the graph into its parts with labels
    (axioms.py); everything a learner reads is built here, from those parts,
    so the form, the canvas and the builder say a rule the same way and are
    tested without drawing anything. A name is used exactly as written;
    nothing here reads ontology text as markup or as a pattern. Articles and
    plurals are kept simple, as the relationship sentences keep them: *a* or
    *an* by the first letter, the last word's plural.

    The builder is one state for every kind of rule. Its blanks are the
    parts of the sentence: which rule, the relationship or attribute, the
    kind, the number, the class or value at the other end and, for the
    defining form, the class it is *exactly a ... that*. The sentence reads
    with "…" in the blanks still empty, and the command is the same shape
    the server's commands take, with the old rule's key for a replace.

INPUTS / INPUT SOURCES
    - Rule items and choices from /node (types.ts ClassRules); a canvas rule
      line's parts; the builder's state.

EXPECTED OUTPUT
    - Strings, the builder state, and { name, args } commands.
================================================================================
*/

import type { AnnotationValue, RuleChoices, RuleForm, RuleItem, RuleKey, RuleKind, RuleRef, RuleRestriction } from "../types";
import { article as articleOf } from "./sentences";
import { plural } from "./shapeSentences";

const XSD = "http://www.w3.org/2001/XMLSchema#";

const BLANK = "…";

/** *a Person*, *an Order line*. */
function a(name: string): string {
  return `${articleOf(name)} ${name}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 1 is *one*, as 5.8 writes *at least one*; any other number is digits. */
export function countWord(n: number): string {
  return n === 1 ? "one" : String(n);
}

const QUANTITY: Record<"exactly" | "atLeast" | "atMost", string> = {
  exactly: "exactly",
  atLeast: "at least",
  atMost: "at most",
};

export function isCount(kind: RuleKind | null): kind is "exactly" | "atLeast" | "atMost" {
  return kind === "exactly" || kind === "atLeast" || kind === "atMost";
}

/** The parts of a rule a sentence is built from, as labels. */
export interface RuleParts {
  form: RuleForm;
  kind: RuleKind | null;
  property: string | null;
  // The class or type of value at the other end, or the value.
  filler: string | null;
  n: number | null;
  with: string | null;
}

/** A value of *has value*, as the sentence shows it. */
export function valueText(value: AnnotationValue & { label?: string }): string {
  if (value.kind === "link") return value.label ?? value.value;
  return value.value;
}

export function partsOf(item: RuleRestriction): RuleParts {
  let filler: string | null = null;
  if (item.filler) {
    filler =
      item.kind === "value"
        ? valueText(item.filler as AnnotationValue & { label?: string })
        : "iri" in item.filler
          ? item.filler.label
          : null;
  }
  return {
    form: item.form,
    kind: item.kind,
    property: item.property.label,
    filler,
    n: item.n,
    with: item.with?.label ?? null,
  };
}

/** *that is an Order line* / *that are Order lines*, by the number. */
function thatIs(filler: string, n: number): string {
  return n === 1 ? `that is ${a(filler)}` : `that are ${plural(filler)}`;
}

/** The sentence of a restriction (5.8). Blanks not yet filled read "…",
 *  so the builder's sentence reads as its pickers fill. */
export function restrictionSentence(cls: string, parts: RuleParts): string {
  const p = parts.property ?? BLANK;
  const f = parts.filler;
  const kind = parts.kind;
  if (parts.form === "defines") {
    const head = `${capital(a(cls))} is exactly ${parts.with ? a(parts.with) : "something"} that`;
    return `${head} ${definingPhrase(p, kind, f, parts.n)}`;
  }
  if (kind === "some") return `Every ${cls} has at least one ${p} that is ${f ? a(f) : BLANK}`;
  if (kind === "only") return `Every ${cls}'s ${p} can only be ${f ? plural(f) : BLANK}`;
  if (kind === "value") return `Every ${cls} has ${p} ${f ?? BLANK}`;
  if (isCount(kind)) {
    const n = parts.n;
    const count = n === null ? BLANK : countWord(n);
    const tail = f ? ` ${n === null ? `that are ${plural(f)}` : thatIs(f, n)}` : "";
    return `Every ${cls} has ${QUANTITY[kind]} ${count} ${p}${tail}`;
  }
  return `Every ${cls} ${BLANK}`;
}

function definingPhrase(p: string, kind: RuleKind | null, f: string | null, n: number | null): string {
  if (kind === "some") return `${p} at least one ${f ?? BLANK}`;
  if (kind === "only") return `${p} only ${f ? plural(f) : BLANK}`;
  if (kind === "value") return `${p} ${f ?? BLANK}`;
  if (isCount(kind)) {
    const count = n === null ? BLANK : countWord(n);
    const what = f ? ` ${n === 1 ? f : plural(f)}` : "";
    return `${p} ${QUANTITY[kind]} ${count}${what}`;
  }
  return `${p} ${BLANK}`;
}

export function disjointSentence(cls: string, other: string): string {
  return `No ${cls} is ${a(other)}`;
}

export function equivalentSentence(cls: string, other: string): string {
  return `${cls} and ${other} mean the same thing`;
}

/** Any item of the Rules block as its sentence; Turtle outside 5.8 is its
 *  own text and has none. */
export function itemSentence(cls: string, item: RuleItem): string | null {
  if (item.type === "restriction") return restrictionSentence(cls, partsOf(item));
  if (item.type === "disjoint") return disjointSentence(cls, item.other.label);
  if (item.type === "equivalent") return equivalentSentence(cls, item.other.label);
  return null;
}

/** A rule line's label on the canvas (5.9): the sentence's short form. */
export function shortLabel(rule: { form: RuleForm; kind: RuleKind; n: number | null; propertyLabel: string }): string {
  if (rule.form === "defines") return "defines";
  if (rule.kind === "some") return `at least 1 · ${rule.propertyLabel}`;
  if (rule.kind === "only") return `only · ${rule.propertyLabel}`;
  if (rule.kind === "value") return `value · ${rule.propertyLabel}`;
  return `${QUANTITY[rule.kind]} ${rule.n ?? 0} · ${rule.propertyLabel}`;
}

/** A box's count of the rules the canvas does not draw (5.9). */
export function moreRulesText(n: number): string {
  return `${n} more ${n === 1 ? "rule" : "rules"} in the form`;
}

/** *has line* read as the thing it links to, *line*, for the note; any other
 *  name is read as written. */
function thing(property: string): string {
  return /^has /i.test(property) && property.length > 4 ? property.slice(4) : property;
}

/** The open-world note under a restriction (Q3, Section 7): what the rule
 *  does not do, with the case that is not an error. */
export function openWorldNote(cls: string, parts: RuleParts): string {
  const head = `This describes every ${cls}. It does not check your data:`;
  const t = parts.property ? thing(parts.property) : BLANK;
  const n = parts.n ?? 0;
  let example: string;
  if (parts.form === "defines") {
    example = `a thing that fits the description is not made ${a(cls)} in your file.`;
    return `This defines ${a(cls)}. It does not check your data: ${example}`;
  }
  switch (parts.kind) {
    case "some":
      example = `${a(cls)} with no ${t} is not an error here.`;
      break;
    case "atLeast":
      example = `${a(cls)} with fewer than ${n} ${n === 1 ? t : plural(t)} is not an error here.`;
      break;
    case "only":
      example = `${a(cls)} with ${a(t)} that is not ${parts.filler ? a(parts.filler) : BLANK} is not an error here.`;
      break;
    case "atMost":
      example = `${a(cls)} with more than ${n} ${n === 1 ? t : plural(t)} is not an error here.`;
      break;
    case "exactly":
      example = `${a(cls)} with another number of ${plural(t)} is not an error here.`;
      break;
    default:
      example = `${a(cls)} without that ${t} is not an error here.`;
  }
  return `${head} ${example}`;
}

// ---------------------------------------------------------------------------
// The sentence builder
// ---------------------------------------------------------------------------

export type RuleType = "every" | "defines" | "disjoint" | "equivalent";

export interface BuilderState {
  type: RuleType;
  property: string | null;
  kind: RuleKind | null;
  /** The number, as typed. */
  n: string;
  /** A class, a type of value, or a thing (an IRI); null when none. */
  filler: string | null;
  /** A *has value* attribute's value, as typed. */
  value: string;
  /** The defining form's named class, or null for *something*. */
  with: string | null;
  /** The other class of a disjoint or same-meaning rule. */
  other: string | null;
}

export const EMPTY_BUILDER: BuilderState = {
  type: "every",
  property: null,
  kind: null,
  n: "1",
  filler: null,
  value: "",
  with: null,
  other: null,
};

export const RULE_TYPES: { id: RuleType; words: (cls: string) => string }[] = [
  { id: "every", words: (cls) => `Every ${cls} …` },
  { id: "defines", words: (cls) => `${capital(a(cls))} is exactly …` },
  { id: "disjoint", words: (cls) => `No ${cls} is …` },
  { id: "equivalent", words: (cls) => `${cls} means the same as …` },
];

/** The kinds a property is offered (5.8): an attribute takes a count or a
 *  value; a relationship any of the six. */
export function kindsFor(propertyKind: "relationship" | "attribute" | null | undefined): { id: RuleKind; words: string }[] {
  const all: { id: RuleKind; words: string }[] = [
    { id: "some", words: "has at least one … that is a" },
    { id: "only", words: "can only be" },
    { id: "exactly", words: "has exactly" },
    { id: "atLeast", words: "has at least" },
    { id: "atMost", words: "has at most" },
    { id: "value", words: "has the value" },
  ];
  return propertyKind === "attribute" ? all.filter((k) => k.id !== "some" && k.id !== "only") : all;
}

/** The seven types of value E-6 offers, as an attribute's count may name one. */
export const VALUE_TYPES: { iri: string; label: string }[] = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "anyURI",
].map((name) => ({ iri: `${XSD}${name}`, label: `xsd:${name}` }));

function find(list: RuleRef[] | undefined, iri: string | null): RuleRef | undefined {
  return iri ? list?.find((r) => r.iri === iri) : undefined;
}

/** The chosen property's kind, from the choices. */
export function propertyKind(state: BuilderState, choices: RuleChoices | null): "relationship" | "attribute" | null {
  const chosen = choices?.properties.items.find((p) => p.iri === state.property);
  return chosen?.kind ?? null;
}

function parsedN(state: BuilderState): number | null {
  if (!/^\d+$/.test(state.n.trim())) return null;
  const n = Number(state.n.trim());
  return n <= 1000 ? n : null;
}

/** The builder's sentence so far, with "…" in each blank still empty: the
 *  group's name and what Add announces (Section 6, Accessibility). */
export function builderSentence(cls: string, state: BuilderState, choices: RuleChoices | null): string {
  const label = (list: RuleRef[] | undefined, iri: string | null) => find(list, iri)?.label ?? null;
  if (state.type === "disjoint") {
    const other = label(choices?.classes.items, state.other);
    return other ? disjointSentence(cls, other) : `No ${cls} is ${BLANK}`;
  }
  if (state.type === "equivalent") {
    const other = label(choices?.classes.items, state.other);
    return equivalentSentence(cls, other ?? BLANK);
  }
  const attribute = propertyKind(state, choices) === "attribute";
  let filler: string | null = null;
  if (state.kind === "value") {
    filler = attribute ? state.value.trim() || null : label(choices?.things.items, state.filler);
  } else if (state.filler) {
    filler = attribute ? (find(VALUE_TYPES, state.filler)?.label ?? state.filler) : label(choices?.classes.items, state.filler);
  }
  return restrictionSentence(cls, {
    form: state.type,
    kind: state.kind,
    property: label(choices?.properties.items, state.property),
    filler,
    n: isCount(state.kind) ? parsedN(state) : null,
    with: state.type === "defines" ? label(choices?.classes.items, state.with) : null,
  });
}

/** What stops Add, in words, or null when the rule can be written. The
 *  server checks again and has the last word (5.10). */
export function builderProblem(state: BuilderState, choices: RuleChoices | null): string | null {
  if (state.type === "disjoint" || state.type === "equivalent") {
    return state.other ? null : "Choose the other class.";
  }
  if (!state.property) return "Choose the relationship or attribute.";
  if (!state.kind) return "Choose what is true of it.";
  const attribute = propertyKind(state, choices) === "attribute";
  if (attribute && (state.kind === "some" || state.kind === "only")) {
    return "An attribute takes exactly, at least, at most or a value.";
  }
  if (isCount(state.kind) && parsedN(state) === null) return "A number of 0 to 1,000.";
  if ((state.kind === "some" || state.kind === "only") && !state.filler) return "Choose the class it points to.";
  if (state.kind === "value" && (attribute ? !state.value.trim() : !state.filler)) return "Choose the value.";
  return null;
}

/** An attribute's value as the commands take it: typed with the
 *  attribute's own type when it is one of the seven, else text without a
 *  language (written plain). */
function attributeValue(state: BuilderState, choices: RuleChoices | null): AnnotationValue {
  const datatype = choices?.properties.items.find((p) => p.iri === state.property)?.datatype ?? null;
  const offered = datatype && datatype.startsWith(XSD) ? `xsd:${datatype.slice(XSD.length)}` : null;
  const known = offered && VALUE_TYPES.some((t) => t.label === offered) ? offered : "xsd:string";
  return { kind: "typed", value: state.value.trim(), datatype: known };
}

/** The one command Add sends (5.10): AddRestriction, or ReplaceRestriction
 *  with the old rule's key when editing; AddDisjointWith or
 *  AddEquivalentClass for the pairs. Null while a blank stops it. */
export function builderCommand(
  cls: string,
  state: BuilderState,
  choices: RuleChoices | null,
  replacing: RuleKey | null = null,
): { name: string; args: Record<string, unknown> } | null {
  if (builderProblem(state, choices) !== null) return null;
  if (state.type === "disjoint") return { name: "AddDisjointWith", args: { a: cls, b: state.other } };
  if (state.type === "equivalent") return { name: "AddEquivalentClass", args: { a: cls, b: state.other } };
  const attribute = propertyKind(state, choices) === "attribute";
  const kind = state.kind!;
  let filler: unknown = null;
  if (kind === "value") filler = attribute ? attributeValue(state, choices) : state.filler;
  else filler = state.filler;
  const args: Record<string, unknown> = {
    class: cls,
    form: state.type,
    property: state.property,
    kind,
    filler,
    n: isCount(kind) ? parsedN(state) : null,
  };
  if (state.type === "defines" && state.with) args.with = state.with;
  if (replacing) return { name: "ReplaceRestriction", args: { ...args, restriction: replacing } };
  return { name: "AddRestriction", args };
}

/** The builder opened on an existing restriction, for Edit. */
export function stateOf(item: RuleRestriction): BuilderState {
  const value = item.kind === "value" && item.filler && !("iri" in item.filler) ? (item.filler as AnnotationValue) : null;
  return {
    type: item.form,
    property: item.property.iri,
    kind: item.kind,
    n: item.n === null ? "1" : String(item.n),
    filler: value ? (value.kind === "link" ? value.value : null) : item.filler && "iri" in item.filler ? item.filler.iri : null,
    value: value && value.kind !== "link" ? value.value : "",
    with: item.with?.iri ?? null,
    other: null,
  };
}

/** The command that takes an item away (5.9's Remove). */
export function removeCommand(cls: string, item: RuleItem): { name: string; args: Record<string, unknown> } | null {
  if (!item.editable) return null;
  if (item.type === "restriction") return { name: "RemoveRestriction", args: { class: cls, restriction: item.key } };
  if (item.type === "disjoint") return { name: "RemoveDisjointWith", args: { a: cls, b: item.other.iri } };
  if (item.type === "equivalent") return { name: "RemoveEquivalentClass", args: { a: cls, b: item.other.iri } };
  return null;
}

/** A stable key for an item, so a refusal or focus can follow it across a
 *  refetch that re-orders the list. */
export function itemKey(item: RuleItem): string {
  if (item.type === "restriction") return `r:${JSON.stringify(item.key)}`;
  if (item.type === "turtle") return `t:${item.turtle}`;
  return `${item.type}:${item.other.iri}`;
}
