/*
================================================================================
FILE: frontend/src/explain/glossary.ts
================================================================================

SUMMARY
    The one fixed list of what the standard terms mean (explain-panel 5.3,
    D-114): RDF, RDFS, OWL, SKOS, Dublin Core and XML Schema terms, each
    defined in one plain sentence, keyed by full IRI. And which of them a
    detail panel shows, in the order they first appear, for its *What these
    words mean* list.

BASIC IDEA
    Built into the app, never fetched and never generated: a definition is
    read here or not at all, and a term not in the list is not listed. A
    SKOS mapping's definition is MAPPINGS' in modeling/sentences.ts, the
    one the Edit page's concept form shows, read from there rather than
    copied, so the two can never say different things.

    Each definition is one sentence of at most 25 words, in US English,
    starting lower case, as it follows the term's name and a colon, and
    names no prefixed term: a learner who needs this list cannot read one.
    glossary.test.ts holds every entry to that, and checks that every
    standard term the bundled examples show is here (exampleTerms.json).

    A panel shows a term as a predicate, as a value, as a subject that
    references the entity, or as a literal's type (^^xsd:date). A literal's
    type is looked up by the full IRI the server sends beside its prefixed
    form, never by the prefix, which is whatever the file bound: xs:date is
    XML Schema's date, and a dc: bound to Dublin Core terms is not the
    original set (code review).

INPUTS / INPUT SOURCES
    - The rows the panel lists: its statements and its references.

EXPECTED OUTPUT
    - GLOSSARY: full IRI -> definition.
    - definition(iri): one entry, own-key (X-6), or undefined.
    - panelTerms(statements, references): the defined terms the panel shows,
      each once, in first-appearance order, with the name the panel shows.
================================================================================
*/

import { MAPPINGS } from "../modeling/sentences";
import { own } from "../theme/kinds";
import type { NodeDetails, TermRef } from "../types";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const DCTERMS = "http://purl.org/dc/terms/";
const DC = "http://purl.org/dc/elements/1.1/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

/** MAPPINGS' sentence after the term's name and a colon: lower case first. */
function mapping(id: string): string {
  const means = MAPPINGS.find((m) => m.id === id)?.means ?? "";
  return means ? `${means[0].toLowerCase()}${means.slice(1)}` : means;
}

export const GLOSSARY: Record<string, string> = {
  // RDF
  [`${RDF}type`]: "says what kind of thing something is; the value is a class.",
  [`${RDF}Property`]: "a property in the plainest sense: a link from a thing to another thing or to a value.",
  [`${RDF}langString`]: "a piece of text marked with the language it is written in.",
  [`${RDF}List`]: "an ordered list of items, written as a chain of one item and the rest of the list.",
  [`${RDF}first`]: "the first item of a list.",
  [`${RDF}rest`]: "the rest of a list after its first item.",
  [`${RDF}nil`]: "the empty list, which ends every list.",

  // RDF Schema
  [`${RDFS}subClassOf`]: "says one class is a more specific kind of another; everything in the first is also in the second.",
  [`${RDFS}subPropertyOf`]: "says one property is a more specific kind of another; whatever the first links, the second links too.",
  [`${RDFS}domain`]: "says what a property starts from: anything that has the property is in this class.",
  [`${RDFS}range`]: "says what a property's values are: each value is in this class or of this type.",
  [`${RDFS}label`]: "a name for people to read, often given in several languages.",
  [`${RDFS}comment`]: "a description for people to read; it does not change what the ontology means.",
  [`${RDFS}Class`]: "a category of things, in the plainest sense, as RDF Schema defines one.",
  [`${RDFS}Literal`]: "any plain value, such as a piece of text, a number or a date, rather than a named thing.",
  [`${RDFS}Resource`]: "anything at all that can be described; everything is one.",
  [`${RDFS}Datatype`]: "a type of value, such as a whole number or a date.",
  [`${RDFS}isDefinedBy`]: "names the vocabulary or document where this term is defined.",
  [`${RDFS}seeAlso`]: "points to another resource that may say more about this one.",
  [`${RDFS}member`]: "links a container to one of the things in it.",

  // OWL
  [`${OWL}Ontology`]: "the record that names an ontology and says who made it, its version and its license.",
  [`${OWL}Class`]: "a category of things, as the Web Ontology Language defines one; its members are individuals.",
  [`${OWL}Thing`]: "the class of everything; every individual is in it.",
  [`${OWL}Nothing`]: "the empty class; nothing can be in it.",
  [`${OWL}NamedIndividual`]: "marks something as an individual: one particular thing with a name, not a category.",
  [`${OWL}ObjectProperty`]: "a relationship: a property that links one thing to another thing.",
  [`${OWL}DatatypeProperty`]: "an attribute: a property that gives a thing a value, such as a number, a date or a piece of text.",
  [`${OWL}AnnotationProperty`]: "a property for notes to people, such as labels and comments; it does not change what the ontology means.",
  [`${OWL}FunctionalProperty`]: "a property that has at most one value for each thing.",
  [`${OWL}InverseFunctionalProperty`]: "a property whose value identifies its thing: no two things share the same value.",
  [`${OWL}SymmetricProperty`]: "a property that works both ways: if A has it to B, then B has it to A.",
  [`${OWL}AsymmetricProperty`]: "a property that never works both ways: if A has it to B, then B never has it to A.",
  [`${OWL}TransitiveProperty`]: "a property that chains: if A has it to B and B has it to C, then A has it to C.",
  [`${OWL}ReflexiveProperty`]: "a property every thing has to itself.",
  [`${OWL}IrreflexiveProperty`]: "a property nothing has to itself.",
  [`${OWL}inverseOf`]: "says one property is the other read the other way round: if A has one to B, B has the other to A.",
  [`${OWL}equivalentClass`]: "says two classes have exactly the same members.",
  [`${OWL}equivalentProperty`]: "says two properties always link the same things.",
  [`${OWL}disjointWith`]: "says two classes share no members: nothing can be in both.",
  [`${OWL}AllDisjointClasses`]: "a group of classes in which no two share a member.",
  [`${OWL}members`]: "lists the classes or individuals a group is about.",
  [`${OWL}sameAs`]: "says two names refer to the very same thing.",
  [`${OWL}differentFrom`]: "says two names refer to two different things.",
  [`${OWL}versionInfo`]: "a note saying which version this is, such as a number or a date.",
  [`${OWL}versionIRI`]: "the web address of this particular version of the ontology.",
  [`${OWL}priorVersion`]: "the web address of the version before this one.",
  [`${OWL}imports`]: "says this ontology uses another one, and includes everything that one states.",
  [`${OWL}deprecated`]: "marks a term as no longer recommended for use.",
  [`${OWL}Restriction`]: "an unnamed class defined by a rule about one property, such as having at least one crew member.",
  [`${OWL}onProperty`]: "names the property a rule is about.",
  [`${OWL}onClass`]: "names the class a counted rule's values must be in.",
  [`${OWL}someValuesFrom`]: "a rule that each member has at least one value of the property in this class.",
  [`${OWL}allValuesFrom`]: "a rule that every value of the property, where there is one, is in this class.",
  [`${OWL}hasValue`]: "a rule that each member has this exact value for the property.",
  [`${OWL}cardinality`]: "a rule that each member has exactly this many values of the property.",
  [`${OWL}minCardinality`]: "a rule that each member has at least this many values of the property.",
  [`${OWL}maxCardinality`]: "a rule that each member has at most this many values of the property.",
  [`${OWL}qualifiedCardinality`]: "a rule that each member has exactly this many values of the property in a given class.",
  [`${OWL}minQualifiedCardinality`]: "a rule that each member has at least this many values of the property in a given class.",
  [`${OWL}maxQualifiedCardinality`]: "a rule that each member has at most this many values of the property in a given class.",
  [`${OWL}intersectionOf`]: "defines a class as the things that are in every one of the listed classes.",
  [`${OWL}unionOf`]: "defines a class as the things that are in at least one of the listed classes.",
  [`${OWL}complementOf`]: "defines a class as everything that is not in the given class.",
  [`${OWL}oneOf`]: "defines a class by listing its members one by one.",
  [`${OWL}disjointUnionOf`]: "says a class is exactly the listed classes together, and no two of them share a member.",

  // SKOS
  [`${SKOS}Concept`]: "one term in a vocabulary, such as a subject heading or a category.",
  [`${SKOS}ConceptScheme`]: "a vocabulary: a set of concepts, arranged from broad to narrow.",
  [`${SKOS}Collection`]: "a named group of concepts, gathered for a purpose of its own.",
  [`${SKOS}OrderedCollection`]: "a named group of concepts kept in a set order.",
  [`${SKOS}prefLabel`]: "the preferred name of a concept, at most one in each language.",
  [`${SKOS}altLabel`]: "another name for a concept, such as a synonym or an abbreviation.",
  [`${SKOS}hiddenLabel`]: "a name that finds a concept in a search, such as a common misspelling, but is never shown.",
  [`${SKOS}definition`]: "a full statement of what a concept means.",
  [`${SKOS}scopeNote`]: "a note saying how a concept is meant to be used, and what it does not cover.",
  [`${SKOS}note`]: "a general note about a concept, for people to read.",
  [`${SKOS}example`]: "an example of how a concept is used.",
  [`${SKOS}editorialNote`]: "a note for the people who maintain the vocabulary.",
  [`${SKOS}historyNote`]: "a note about how a concept's meaning or use has changed over time.",
  [`${SKOS}changeNote`]: "a note recording a change made to a concept.",
  [`${SKOS}notation`]: "a code that identifies a concept within its vocabulary, such as a number.",
  [`${SKOS}broader`]: "links a concept to a broader, more general one.",
  [`${SKOS}narrower`]: "links a concept to a narrower, more specific one.",
  [`${SKOS}related`]: "links two associated concepts, neither broader nor narrower than the other.",
  [`${SKOS}inScheme`]: "says which vocabulary a concept belongs to.",
  [`${SKOS}hasTopConcept`]: "links a vocabulary to one of its broadest concepts, at the top of its hierarchy.",
  [`${SKOS}topConceptOf`]: "says a concept is one of the broadest in a vocabulary, at the top of its hierarchy.",
  [`${SKOS}member`]: "links a collection to one of the concepts in it.",
  [`${SKOS}memberList`]: "lists the concepts of an ordered collection, in their order.",
  [`${SKOS}exactMatch`]: mapping("exactMatch"),
  [`${SKOS}closeMatch`]: mapping("closeMatch"),
  [`${SKOS}broadMatch`]: mapping("broadMatch"),
  [`${SKOS}narrowMatch`]: mapping("narrowMatch"),
  [`${SKOS}relatedMatch`]: mapping("relatedMatch"),

  // Dublin Core terms
  [`${DCTERMS}title`]: "the name of a resource, such as a document or a vocabulary.",
  [`${DCTERMS}description`]: "an account of what a resource is or contains, for people to read.",
  [`${DCTERMS}creator`]: "a person or organization chiefly responsible for making a resource.",
  [`${DCTERMS}contributor`]: "a person or organization that helped to make a resource.",
  [`${DCTERMS}publisher`]: "the person or organization that makes a resource available.",
  [`${DCTERMS}created`]: "the date a resource was made.",
  [`${DCTERMS}modified`]: "the date a resource was last changed.",
  [`${DCTERMS}issued`]: "the date a resource was published.",
  [`${DCTERMS}date`]: "a date in the life of a resource, such as when it was made or changed.",
  [`${DCTERMS}license`]: "the license that says how a resource may be used and shared.",
  [`${DCTERMS}rights`]: "a statement about who holds rights over a resource, such as its copyright.",
  [`${DCTERMS}source`]: "a resource this one is derived from.",
  [`${DCTERMS}subject`]: "what a resource is about, often a term from a vocabulary.",
  [`${DCTERMS}Agent`]: "a person, an organization or a program that can act, such as one that makes a resource.",

  // Dublin Core's original fifteen, older than the terms above
  [`${DC}title`]: "the name of a resource, in the original Dublin Core set.",
  [`${DC}description`]: "an account of a resource, in the original Dublin Core set.",
  [`${DC}date`]: "a date in the life of a resource, in the original Dublin Core set.",
  [`${DC}creator`]: "who made a resource, in the original Dublin Core set.",
  [`${DC}subject`]: "what a resource is about, in the original Dublin Core set.",

  // XML Schema types of value
  [`${XSD}string`]: "a piece of text.",
  [`${XSD}integer`]: "a whole number, such as 3 or -12.",
  [`${XSD}nonNegativeInteger`]: "a whole number that is zero or more.",
  [`${XSD}positiveInteger`]: "a whole number that is one or more.",
  [`${XSD}int`]: "a whole number within a fixed size, about two billion either side of zero.",
  [`${XSD}decimal`]: "a number that may have a fractional part, such as 3.75.",
  [`${XSD}double`]: "a number in floating-point form, which can be very large or very small.",
  [`${XSD}float`]: "a number in floating-point form, less precise than a double.",
  [`${XSD}boolean`]: "a yes-or-no value, written true or false.",
  [`${XSD}date`]: "a calendar date, such as 1969-07-16.",
  [`${XSD}dateTime`]: "a date and a time of day, such as 1969-07-16T13:32:00.",
  [`${XSD}time`]: "a time of day, such as 13:32:00.",
  [`${XSD}gYear`]: "a year, such as 1969.",
  [`${XSD}anyURI`]: "a web address, or another identifier written like one.",
};

/** A term's definition, own-key: a key from a loaded file is never
 *  Object.prototype's (X-6). */
export function definition(iri: string): string | undefined {
  return own(GLOSSARY, iri);
}

export interface PanelTerm {
  iri: string;
  /** The name the panel shows it by: its label, or its prefixed form. */
  name: string;
  prefixed: string;
  definition: string;
}

/** An IRI's last name, after its # or last /. */
function local(iri: string): string {
  const cut = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return iri.slice(cut + 1);
}

/** A term as the panel shows it, or null for one with nothing to define:
 *  a URI by its label (the Term button's rule), a literal by its type. */
function shown(term: TermRef): { iri: string; name: string; prefixed: string } | null {
  if (term.type === "uri") {
    const prefixed = term.prefixed ?? term.value;
    const name = term.label && term.label !== prefixed ? term.label : prefixed;
    return { iri: term.value, name, prefixed };
  }
  if (term.type === "literal" && term.datatypeIri) {
    const iri = term.datatypeIri;
    return { iri, name: local(iri), prefixed: term.datatype ?? iri };
  }
  return null;
}

/** The defined terms a panel shows, each once, in the order they first
 *  appear: its statements row by row, predicate then value, then the
 *  references, subject then predicate. */
export function panelTerms(
  statements: NodeDetails["outgoing"],
  references: NodeDetails["incoming"],
): PanelTerm[] {
  const order: TermRef[] = [
    ...statements.flatMap((row) => [row.predicate, row.object]),
    ...references.flatMap((row) => [row.subject, row.predicate]),
  ];
  const seen = new Set<string>();
  const out: PanelTerm[] = [];
  for (const term of order) {
    const found = shown(term);
    if (!found || seen.has(found.iri)) continue;
    const meaning = definition(found.iri);
    if (meaning === undefined) continue;
    seen.add(found.iri);
    out.push({ ...found, definition: meaning });
  }
  return out;
}
