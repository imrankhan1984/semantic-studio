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

    Stage B's forms read back the same way (5.6 to 5.8): the relationship's
    sentence with *(no start yet)* or *(no end yet)* where an end is
    missing, its other way round, each characteristic's example written with
    the relationship's own names, its more general relationship, the
    attribute's sentence and *one value only*, a concept's related line, and
    what each kind of mapping means.

BASIC IDEA
    Every relationship reads as a sentence, before and after it is created
    (Section 7), so the sentence is built in one place and tested without
    drawing anything. Articles are kept simple, as the spec says: *a* or *an*
    by the first letter, no grammar beyond that. A name is used exactly as
    written; nothing here reads ontology text as markup or as a pattern.

INPUTS / INPUT SOURCES
    - Names: a class's, a concept's, a relationship's, already chosen in the
      display language by the server; null for an end not set yet.

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
export function linkSentence(kind: "subClassOf" | "broader" | "related", from: string, to: string): string {
  if (kind === "related") return `${from} is related to ${to}`;
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
  // Relationships and attributes belong to classes, so a taxonomy shows them
  // as it shows classes (5.10 item 2).
  if (kind === "taxonomy" && entityKind === "objectProperty") {
    return "A relationship, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  if (kind === "taxonomy" && entityKind === "datatypeProperty") {
    return "An attribute, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage B: the relationship and attribute forms (5.6, 5.7), concepts (5.8)
// ---------------------------------------------------------------------------

function capital(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** *a Person*, or what stands in for an end not set yet. */
function end(name: string | null, missing: string): string {
  return name ? `${article(name)} ${name}` : missing;
}

/** The Sentence block (5.6): what the blocks below say, read back. */
export function formSentence(from: string | null, name: string, to: string | null): string {
  return `${capital(end(from, "(no start yet)"))} ${name.trim() || "…"} ${end(to, "(no end yet)")}.`;
}

/** The other way round read as a sentence: *An Organization employs a
 *  Person.* Its start is this relationship's end. */
export function inverseSentence(inverse: string, from: string | null, to: string | null): string {
  return formSentence(to, inverse, from);
}

export type Characteristic =
  | "functional"
  | "inverseFunctional"
  | "symmetric"
  | "transitive"
  | "asymmetric"
  | "irreflexive"
  | "reflexive";

/** The seven, in the order the form offers them: four always, three under
 *  *More* (5.6). The OWL term is shown small beside each (Section 7). */
export const CHARACTERISTICS: { id: Characteristic; name: string; owl: string; more: boolean }[] = [
  { id: "functional", name: "At most one", owl: "owl:FunctionalProperty", more: false },
  { id: "inverseFunctional", name: "Identifies its start", owl: "owl:InverseFunctionalProperty", more: false },
  { id: "symmetric", name: "Works both ways", owl: "owl:SymmetricProperty", more: false },
  { id: "transitive", name: "Chains", owl: "owl:TransitiveProperty", more: false },
  { id: "asymmetric", name: "Never both ways", owl: "owl:AsymmetricProperty", more: true },
  { id: "irreflexive", name: "Never to itself", owl: "owl:IrreflexiveProperty", more: true },
  { id: "reflexive", name: "Always to itself", owl: "owl:ReflexiveProperty", more: true },
];

/** Each characteristic's example, written from the relationship's own
 *  names (5.6). An end not set yet reads as *something* or *thing*. */
export function characteristicExample(
  id: Characteristic,
  name: string,
  from: string | null,
  to: string | null,
): string {
  const verb = name.trim() || "…";
  switch (id) {
    case "functional":
      return `${capital(end(from, "something"))} ${verb} at most one ${to ?? "thing"}.`;
    case "inverseFunctional":
      return `${capital(end(to, "something"))} is linked by ${verb} to at most one ${from ?? "thing"}.`;
    case "symmetric":
      return `If A ${verb} B, then B ${verb} A.`;
    case "transitive":
      return `If A ${verb} B and B ${verb} C, then A ${verb} C.`;
    case "asymmetric":
      return `If A ${verb} B, then B never ${verb} A.`;
    case "irreflexive":
      return `Nothing ${verb} itself.`;
    case "reflexive":
      return `Everything ${verb} itself.`;
  }
}

/** *works for is a more specific kind of member of* (5.6). */
export function parentSentence(child: string, parent: string): string {
  return `${child} is a more specific kind of ${parent}`;
}

/** Why one start and one end, with the relationship's own names (5.6):
 *  *To use "works for" from Robot too, make Person and Robot kinds of a
 *  common class ...* -- the other class is the learner's to think of. */
export function oneStartOneEnd(name: string, from: string | null): string {
  const start = from ? `${from} and that class` : "both classes";
  return (
    `A relationship here has one start and one end. To use "${name.trim() || "it"}" from another class too, ` +
    `make ${start} kinds of a common class, such as Agent, and start the relationship there, ` +
    "or create a second relationship."
  );
}

/** The attribute's sentence (5.7): *A Person has a name, as text.* */
export function attributeSentence(domain: string | null, name: string, datatype: string | null): string {
  const has = `${capital(end(domain, "something"))} has ${end(name.trim() || "…", "a value")}`;
  return datatype ? `${has}, as ${typeWord(datatype)}.` : `${has}.`;
}

/** *One value only* read with the attribute's names: *A Person has at most
 *  one name.* */
export function oneValueExample(domain: string | null, name: string): string {
  return `${capital(end(domain, "something"))} has at most one ${name.trim() || "value"}.`;
}

/** The five mapping kinds (5.8), each explained in one sentence. */
export const MAPPINGS: { id: string; name: string; means: string }[] = [
  { id: "exactMatch", name: "Exact match", means: "The same concept, and it can be used in place of this one." },
  { id: "closeMatch", name: "Close match", means: "Close enough to use in place of this one in some settings, not all." },
  { id: "broadMatch", name: "Broader match", means: "A broader concept in the other vocabulary." },
  { id: "narrowMatch", name: "Narrower match", means: "A narrower concept in the other vocabulary." },
  { id: "relatedMatch", name: "Related match", means: "An associated concept in the other vocabulary, neither broader nor narrower." },
];

/** *Top concept of Fruits* (5.8). */
export function topConceptSentence(scheme: string): string {
  return `Top concept of ${scheme}`;
}
