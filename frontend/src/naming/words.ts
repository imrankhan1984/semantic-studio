/*
================================================================================
FILE: frontend/src/naming/words.ts
================================================================================

SUMMARY
    Settings → Naming's words and its one rule (design-checks 5.1): the
    sentences the tab shows, the pattern block's lines with the person's
    namespace in place, the examples with it, and what a Save sends.

BASIC IDEA
    Kept out of NamingSettings so they are tested without rendering, as
    limitWords.ts is for Limits. The examples come from the table the two
    address rules are tested with (address.table.json), the namespace of
    that table replaced by the one typed, so what the page shows is what
    the rule builds.

    No organization is named anywhere here: `acme` is the placeholder
    the spec's examples use, and the page shows the person's own value as
    soon as there is one.

INPUTS / INPUT SOURCES
    - The typed namespace and the saved one.

EXPECTED OUTPUT
    - Sentences, lines, example rows, and a Save's value.
================================================================================
*/

import table from "./address.table.json";
import { PREFIX, namespaceError } from "./address";

export const FIELD_LABEL = "Your organization's namespace";
export const GUIDELINES = "Use the official IRI guidelines from your organization.";
export const NOT_REGISTERED =
  "Semantic Studio proposes addresses under this namespace for new projects; it does not register or publish them.";
export const W3ID_LINE =
  "w3id.org is a public permanent-identifier service; your organization registers its space there.";
export const EMPTY_LINE = "No namespace set: new projects start under http://example.org/.";
export const CLEAR_QUESTION =
  "New projects will start under example.org again. Your existing projects keep their addresses.";
export const SAVED = "Saved. New projects will be proposed addresses under this namespace.";
export const CLEARED = "Cleared. New projects start under example.org.";
export const LEAVE_QUESTION = "Close without saving? The namespace you typed is not kept.";

/** The placeholder the examples use while nothing is typed. */
const SAMPLE = table.namespace;
const SAMPLE_IRI = `${PREFIX}${SAMPLE}/`;

/** The namespace the pattern block and the examples show: what is typed when
 *  the rule accepts it, the placeholder otherwise. */
export function shownNamespace(typed: string): string {
  return typed && namespaceError(typed) === null ? typed : SAMPLE;
}

/** The pattern block of 5.1, line by line, with the namespace in place. */
export function patternLines(typed: string): { what: string; text: string }[] {
  const ns = `${PREFIX}${shownNamespace(typed)}`;
  return [
    { what: "Artifact", text: `${ns}/{layer}/{subject}-{type}` },
    { what: "", text: "layer: core | domain/{domain} | app/{application}" },
    { what: "", text: "type: ontology | taxonomy | vocabulary | shapes | mapping" },
    { what: "Term", text: "{artifact}#{TermName}" },
    { what: "Data", text: `${ns}/data/{data-domain}/{class}/{id}` },
  ];
}

function withNamespace(address: string, typed: string): string {
  return address.split(SAMPLE_IRI).join(`${PREFIX}${shownNamespace(typed)}/`);
}

/** The examples table of 5.1 with the namespace in place. */
export function exampleRows(typed: string): { what: string; address: string }[] {
  return table.built.map((row) => ({ what: row.what, address: withNamespace(row.address, typed) }));
}

/** The Avoid table of 5.1 with the namespace in place. */
export function avoidRows(typed: string): { avoid: string; instead: string; why: string }[] {
  return table.avoid.map((row) => ({
    avoid: withNamespace(row.address, typed),
    instead: withNamespace(row.instead, typed),
    why: row.why,
  }));
}

/** What a Save sends: the text as typed, or null when it is refused or the
 *  same as the saved value (Save then waits, aria-disabled). " acme" is
 *  refused, not trimmed: a value the person did not type is never saved
 *  for them (limitWords.ts's rule). */
export function namespaceToSave(typed: string, saved: string | null): string | null {
  if (!typed || namespaceError(typed) !== null) return null;
  return typed === (saved ?? "") ? null : typed;
}

/** The refusal under the field, or null; nothing while it is empty, which
 *  is no namespace rather than a wrong one. */
export function fieldError(typed: string): string | null {
  return typed === "" ? null : namespaceError(typed);
}
