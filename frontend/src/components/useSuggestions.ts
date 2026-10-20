/*
================================================================================
FILE: frontend/src/components/useSuggestions.ts
================================================================================

SUMMARY
    What the project already has, while a new attribute or relationship is
    being named (attribute-reuse 5.1): its own properties of that kind whose
    names match, each worded as *hasName, an attribute of Employee (text).*
    The class form's *Add attribute* and *Add relationship* and the canvas
    box's own *+ attribute* both use it.

BASIC IDEA
    Once the name has two characters and typing has rested SUGGEST_MS, the
    search endpoint is asked with its `kind` filter, the document only (not
    its imports), for at most five; each match's details then give its
    domain as the server's one reader reads it, and its type of value or the
    class it points to. A search a newer one replaces is aborted, details
    and all, and an answer older than the latest is dropped (CF-4); a
    failed one shows nothing, so Create still works. `said` is what the
    polite live region says: the count, never the list.

INPUTS / INPUT SOURCES
    - The model's ontology id (null to suggest nothing), the kind, the name
      as typed.

EXPECTED OUTPUT
    - { suggestions, said }.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { getNodeDetails, searchNodes } from "../api";
import { domainWords, matchesSaid, suggestionLine, type PropertyWord } from "../modeling/sentences";
import type { NodeDetails } from "../types";

/** An existing property offered while the name is typed. */
export interface Suggestion {
  iri: string;
  label: string;
  line: string;
}

/** How long typing rests before the project is searched (5.1). */
export const SUGGEST_MS = 250;
const SUGGESTED = 5;
const RANGE = "http://www.w3.org/2000/01/rdf-schema#range";

/** The suggestion's words, from the property's details: its domain as the
 *  server reads it, and its type of value or the class it points to. */
function lineOf(word: PropertyWord, details: NodeDetails): string {
  const reading = details.domain;
  const domain =
    !reading || reading.form === "none"
      ? null
      : reading.form === "expression"
        ? "a class written in Turtle"
        : domainWords(reading.form === "separate" ? "separate" : "union", reading.classes.map((c) => c.label));
  const range = details.outgoing.find((r) => r.predicate.value === RANGE && r.object.type === "uri")?.object;
  const end = range
    ? word === "attribute"
      ? (range.prefixed ?? range.value)
      : (range.label ?? range.prefixed ?? range.value)
    : null;
  return suggestionLine(word, details.label, domain, end);
}

export function useSuggestions(
  ontologyId: string | null,
  kind: "datatypeProperty" | "objectProperty",
  name: string,
): { suggestions: Suggestion[]; said: string } {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [said, setSaid] = useState("");
  const asked = useRef(0);
  const word: PropertyWord = kind === "objectProperty" ? "relationship" : "attribute";

  useEffect(() => {
    const q = name.trim();
    const ask = ++asked.current;
    if (!ontologyId || q.length < 2) {
      setSuggestions([]);
      setSaid("");
      return;
    }
    // A search a newer one replaces is aborted, its details with it (CF-4).
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchNodes(ontologyId, q, false, kind, controller.signal, SUGGESTED);
        const details = await Promise.all(
          found.slice(0, SUGGESTED).map((n) => getNodeDetails(ontologyId, n.id, false, controller.signal)),
        );
        if (ask !== asked.current) return;
        const next = details.map((d) => ({ iri: d.iri, label: d.label, line: lineOf(word, d) }));
        setSuggestions(next);
        setSaid(next.length ? matchesSaid(next.length, word) : "");
      } catch {
        if (ask === asked.current) {
          setSuggestions([]);
          setSaid("");
        }
      }
    }, SUGGEST_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [name, ontologyId, kind, word]);

  return { suggestions, said };
}
