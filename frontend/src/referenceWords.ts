/*
================================================================================
FILE: frontend/src/referenceWords.ts
================================================================================

SUMMARY
    The Turtle editor's words for a reference term it does not know
    (reference-ontologies 5.7): *qudt:Powr is not a term of QUDT. Did you mean
    qudt:Power?*, one line per term the server named, and a last line
    counting the rest.

BASIC IDEA
    The server finds the terms -- the index never leaves it -- and sends
    each as structure (term, reference, suggestion); the sentence is made
    here, so its wording is tested without rendering, the split of
    statusWords.ts. *A term of QUDT* rather than the spec's *a QUDT term*:
    the name needs no article that way, and the one a/an rule reads FOAF
    letter by letter (*an FOAF*) where people say it as a word. The line
    is information: the text has applied, and the person may mean a term
    of their own in that namespace.

INPUTS / INPUT SOURCES
    - An apply's `references`, from the server.

EXPECTED OUTPUT
    - unknownTermLines(found): the lines, none when every term is known.
================================================================================
*/

import type { UnknownReferenceTerms } from "./types";

export function unknownTermLines(found: UnknownReferenceTerms | undefined): string[] {
  if (!found) return [];
  const lines = found.terms.map(
    (t) =>
      `${t.term} is not a term of ${t.reference}.` + (t.suggestion ? ` Did you mean ${t.suggestion}?` : ""),
  );
  if (found.more > 0) {
    lines.push(`And ${found.more.toLocaleString("en")} more ${found.more === 1 ? "term" : "terms"} like ${found.more === 1 ? "it" : "these"}.`);
  }
  return lines;
}
