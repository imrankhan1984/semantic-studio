/*
================================================================================
FILE: frontend/src/explain/explainSentences.ts
================================================================================

SUMMARY
    The words of the detail panel's In plain words block (explain-panel 5.2,
    D-114): one sentence saying what kind of thing is selected, then at most
    four facts the file states about it, then its authors' description.

BASIC IDEA
    The server sends the structure (`explain` on the node response) and this
    module writes it, so the wording is tested without rendering and the
    server never says a word. Every *a* or *an* comes from
    modeling/sentences.ts (`a`), as do its sentences for a more general
    class and a broader concept (`parentSentence`, `linkSentence`) and the
    Edit page's word for a type of value (`asType`, through `typeWord`):
    that module stays the only place the article rule lives.

    A sentence is a list of parts, text and names, so each name the panel
    shows can be the panel's term button. A sentence from sentences.ts is
    asked for with a marker in each name's place and split on the markers;
    the markers are control characters no label can bring to a split, as a
    name is never searched for in the sentence.

    A property's label is never read as a verb here: a library's labels are
    often nouns, and *A Crewed mission crew member an Astronaut* is what the
    relationship sentence writes for one. *crew member links a Crewed
    mission to an Astronaut* is true of any label.

    Nothing is said that the structure does not hold: no fact for a count of
    zero, *a thing* for a missing end, and a count past 10,000 is *more than
    10,000*.

INPUTS / INPUT SOURCES
    - The entity's label, and its `explain` (types.ts, Explain).

EXPECTED OUTPUT
    - kindSentence, factSentences, descriptionSentence: Sentence values, each
      a list of strings and {iri, label} names.
    - explainSentences: the three together, in the block's order.
    - sentenceText: a sentence as plain text, for tests and titles.
================================================================================
*/

import { a, asType, linkSentence, parentSentence } from "../modeling/sentences";
import { own } from "../theme/kinds";
import type { Explain, ExplainCount, ExplainRef } from "../types";

export type Part = string | ExplainRef;
export type Sentence = Part[];

/** What each kind is, after its name (5.2's first table, word for word):
 *  the legend's name for it, and the Edit page's plainer word where it has
 *  one. */
const KIND_WORDS: Record<string, string> = {
  class: "is a class: a category of things.",
  objectProperty: "is an object property, also called a relationship: it links one thing to another.",
  datatypeProperty:
    "is a datatype property, also called an attribute: it gives a thing a value, such as a number, a date or a piece of text.",
  annotationProperty:
    "is an annotation property: it adds a note for people, such as a label or a comment, and does not change what the ontology means.",
  property: "is a property: it links a thing to another thing or to a value.",
  individual: "is an individual: one particular thing, not a category.",
  concept: "is a concept: one term in a vocabulary.",
  conceptScheme: "is a concept scheme: a vocabulary that holds concepts, arranged from broad to narrow.",
  collection: "is a collection: a named group of concepts.",
  ontology: "is the ontology itself: the record that names this vocabulary and who made it.",
};
const OTHER_WORDS = "is named in this file, but the file does not say what kind of thing it is.";

/** The most names a sentence lists; the server sends no more. */
const NAMES_SHOWN = 3;
/** Where the server's counts stop (graph_builder.EXPLAIN_COUNT_LIMIT). */
const COUNT_LIMIT = 10_000;

// Stand-ins for names inside a sentence from sentences.ts. Control
// characters: no label reaches the split with one, as the split is on these
// alone.
const FIRST = "\u0001";
const SECOND = "\u0002";

export function kindSentence(label: string, kind: string): Sentence {
  return [`${label} ${own(KIND_WORDS, kind) ?? OTHER_WORDS}`];
}

/** *a Mission*, with the name as a part of its own. `a` writes the
 *  article; the name is cut back off the end it was written on. */
function articled(ref: ExplainRef): Part[] {
  return [a(ref.label).slice(0, -ref.label.length || undefined), ref];
}

/** *A, B and C*, each part kept whole. */
function list(items: Part[][]): Part[] {
  const out: Part[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? " and " : ", ");
    out.push(...item);
  });
  return out;
}

/** One end of a property: *a Mission*, *a thing*, or *a thing that is a
 *  Person and an Agent* when the file names several, which RDFS reads as
 *  all of them at once. An end given only as a blank node is not *a
 *  thing*: the statements below say what it is. */
function end(refs: ExplainRef[] | undefined, unnamed = false): Part[] {
  if ((!refs || refs.length === 0) && unnamed) return ["something the statements below describe"];
  if (!refs || refs.length === 0) return ["a thing"];
  if (refs.length === 1) return articled(refs[0]);
  return ["a thing that is ", ...list(refs.map(articled))];
}

/** A sentence from sentences.ts with names in its two places. */
function filled(template: string, first: Part[], second: Part[]): Sentence {
  const out: Sentence = [];
  for (const piece of template.split(/(\u0001|\u0002)/)) {
    if (piece === FIRST) out.push(...first);
    else if (piece === SECOND) out.push(...second);
    else if (piece) out.push(piece);
  }
  return out;
}

/** *2*, *10,000*, *more than 10,000*. */
export function countWords(counted: ExplainCount): string {
  if (counted.capped) return `more than ${COUNT_LIMIT.toLocaleString("en-US")}`;
  return counted.count.toLocaleString("en-US");
}

function counted(counted: ExplainCount, one: string, many: string): string {
  return `${countWords(counted)} ${counted.count === 1 && !counted.capped ? one : many}`;
}

/** The names after a count: all of them, or *among them* three. */
function names(counted: ExplainCount): Part[] {
  const shown = (counted.names ?? []).slice(0, NAMES_SHOWN);
  if (shown.length === 0) return [];
  const all = shown.length === counted.count && !counted.capped;
  return [all ? ", " : ", among them ", ...list(shown.map((ref) => [ref]))];
}

function present(counted: ExplainCount | undefined): counted is ExplainCount {
  return counted !== undefined && (counted.count > 0 || counted.capped);
}

/** The facts the file states, only for what is there (5.2's second
 *  table): three sentences at most, a class's, within 5.2's four. */
export function factSentences(label: string, explain: Explain): Sentence[] {
  const out: Sentence[] = [];
  switch (explain.kind) {
    case "class": {
      if (explain.parents?.length) {
        const parents = list(explain.parents.map((ref) => [ref]));
        out.push([...filled(parentSentence(FIRST, SECOND), [label], parents), "."]);
      }
      const children = explain.children;
      if (present(children)) {
        out.push([`It has ${counted(children, "more specific class", "more specific classes")}`, ...names(children), "."]);
      }
      if (present(explain.members)) {
        // The app infers nothing here, so a member of a subclass is not
        // counted, and with subclasses that has to be said.
        const tail = present(children) ? ", not counting those of its more specific classes" : "";
        out.push([
          `It has ${counted(explain.members, "individual", "individuals")} of its own`,
          ...names(explain.members),
          `${tail}.`,
        ]);
      }
      break;
    }
    case "objectProperty":
    case "property": {
      out.push([
        `${label} links `,
        ...end(explain.domains, explain.unnamedDomain),
        " to ",
        ...end(explain.ranges, explain.unnamedRange),
        ".",
      ]);
      if (explain.inverse) out.push(['Its other way round is "', explain.inverse, '".']);
      break;
    }
    case "datatypeProperty": {
      const value = explain.datatype ? `a value: ${asType(explain.datatype)}.` : "a value.";
      out.push([`${label} gives `, ...end(explain.domains, explain.unnamedDomain), ` ${value}`]);
      break;
    }
    case "individual": {
      if (explain.types?.length) out.push([`${label} is `, ...list(explain.types.map(articled)), "."]);
      break;
    }
    case "concept": {
      if (explain.broader?.length) {
        const broader = list(explain.broader.map((ref) => [ref]));
        out.push([...filled(linkSentence("broader", FIRST, SECOND), [label], broader), "."]);
      }
      if (explain.schemes?.length) out.push(["It belongs to ", ...list(explain.schemes.map((ref) => [ref])), "."]);
      if (present(explain.narrower)) out.push([`It has ${counted(explain.narrower, "narrower concept", "narrower concepts")}.`]);
      break;
    }
    case "conceptScheme": {
      if (present(explain.topConcepts)) out.push([`It has ${counted(explain.topConcepts, "top concept", "top concepts")}.`]);
      break;
    }
    case "collection": {
      if (present(explain.members)) {
        out.push([`It has ${counted(explain.members, "member", "members")}`, ...names(explain.members), "."]);
      }
      break;
    }
  }
  return out;
}

/** Whether a language tag is the one wanted, by prefix: en-GB is en. */
function sameLanguage(tag: string, wanted: string): boolean {
  const t = tag.toLowerCase();
  const w = wanted.toLowerCase();
  return t === w || t.startsWith(`${w}-`);
}

/** The authors' own words, quoted, or nothing when they wrote none. Text
 *  in another language than the one shown says which, as a name shown in
 *  its fallback language does (D-085): *Its authors describe it (de):*. */
export function descriptionSentence(explain: Explain, language: string | null = null): Sentence | null {
  const text = explain.description?.text.trim();
  if (!text) return null;
  const tag = explain.description?.lang;
  const marked = tag && !sameLanguage(tag, language ?? "en") ? ` (${tag})` : "";
  // The authors' full stop stays inside their quotation; one is added only
  // when they wrote none.
  return [`Its authors describe it${marked}: "${text}"${/[.!?]$/.test(text) ? "" : "."}`];
}

/** The block, in order: kind, facts, description. `language` is the one
 *  names are shown in; null is the library's English. */
export function explainSentences(label: string, explain: Explain, language: string | null = null): Sentence[] {
  const description = descriptionSentence(explain, language);
  return [
    kindSentence(label, explain.kind),
    ...factSentences(label, explain),
    ...(description ? [description] : []),
  ];
}

export function sentenceText(sentence: Sentence): string {
  return sentence.map((part) => (typeof part === "string" ? part : part.label)).join("");
}
