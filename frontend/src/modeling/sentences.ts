/*
================================================================================
FILE: frontend/src/modeling/sentences.ts
================================================================================

SUMMARY
    The sentences a relationship is read as (relationships 5.2, 5.3, 5.5):
    *A Person works for an Organization.* while it is being named, *Person is
    a kind of Organization* in the relate menu, *Employee is a kind of
    Person* in the link panel, the announcement once one is created, a
    tree row's ends, *Person → Organization* or *Person, text*, and the one
    line that says a project holds content of its other kind (5.1).

BASIC IDEA
    Every relationship reads as a sentence, before and after it is created
    (Section 7), so the sentence is built in one place and tested without
    drawing anything. Articles are kept simple, as the spec says: *a* or *an*
    by the first letter, no grammar beyond that. A name is used exactly as
    written; nothing here reads ontology text as markup or as a pattern.

INPUTS / INPUT SOURCES
    - Names: a class's, a concept's, a relationship's, already chosen in the
      display language by the server.

EXPECTED OUTPUT
    - Strings.
================================================================================
*/

/** *a* or *an*, by the name's first letter. */
export function article(name: string): string {
  return /^[aeiou]/i.test(name.trim()) ? "an" : "a";
}

/** A new relationship read as it is named: *A Person works for an
 *  Organization.* With no name yet, the gap is shown, so the sentence has
 *  its shape before the first key. */
export function relationshipSentence(from: string, name: string, to: string): string {
  const verb = name.trim() || "…";
  const first = article(from);
  return `${first[0].toUpperCase()}${first.slice(1)} ${from} ${verb} ${article(to)} ${to}.`;
}

/** The link a line would make, or has made, as the relate menu and the link
 *  panel read it. */
export function linkSentence(kind: "subClassOf" | "broader", from: string, to: string): string {
  return kind === "subClassOf" ? `${from} is a kind of ${to}` : `${from} is narrower than ${to}`;
}

/** An existing relationship the line would complete. */
export function existingSentence(from: string, name: string, to: string): string {
  return `${from} ${name} ${to} (existing relationship)`;
}

/** What the live region says once a relationship is made (5.2). */
export function createdAnnouncement(name: string, from: string, to: string): string {
  return `Created relationship ${name}, from ${from} to ${to}.`;
}

/** An attribute's datatype as a word, for *name (Person, text)*: the seven
 *  types of E-6, and the prefixed name for any other. */
const TYPE_WORDS: Record<string, string> = {
  "xsd:string": "text",
  "rdf:langString": "text",
  "xsd:integer": "whole number",
  "xsd:decimal": "decimal number",
  "xsd:boolean": "yes or no",
  "xsd:date": "date",
  "xsd:dateTime": "date and time",
  "xsd:anyURI": "web address",
};

export function typeWord(datatype: string | null): string {
  if (!datatype) return "no type yet";
  return TYPE_WORDS[datatype] ?? datatype;
}

/** A tree row's ends: *Person → Organization* for a relationship, *Person,
 *  text* for an attribute; a missing end says so rather than vanishing. */
export function rowEnds(
  ends: { domain: string | null; range: string | null },
  attribute: boolean,
): string {
  const start = ends.domain ?? "no start yet";
  if (attribute) return `${start}, ${typeWord(ends.range)}`;
  return `${start} → ${ends.range ?? "no end yet"}`;
}

/** The one line shown when a document holds the other kind's content
 *  (5.1): how much, and where it is changed. Null when there is none. */
export function otherKindNote(kind: "ontology" | "taxonomy" | null, count: number): string | null {
  if (!kind || count === 0) return null;
  const them = count === 1 ? "it" : "them";
  return kind === "ontology"
    ? `This ontology also contains ${count} SKOS ${count === 1 ? "concept" : "concepts"}. Edit ${them} in Turtle, or change the project to a taxonomy.`
    : `This taxonomy also contains ${count} ${count === 1 ? "class" : "classes"}. Edit ${them} in Turtle, or change the project to an ontology.`;
}

/** Why one entity of the other kind is not changed in the visual doors. */
export function otherKindReason(kind: "ontology" | "taxonomy" | null, entityKind: string): string | null {
  if (kind === "ontology" && entityKind === "concept") {
    return "A SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.";
  }
  if (kind === "taxonomy" && entityKind === "class") {
    return "A class, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  return null;
}
