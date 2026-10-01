/*
================================================================================
FILE: frontend/src/modeling/entity.ts
================================================================================

SUMMARY
    What the editing form shows for one entity (visual-modeling 5.1), read out
    of the detail panel's statements: its kind, whether it can be edited here,
    its names per project language, its definition, its other annotations, and
    its structure (parents, attributes, relationships, domain and range,
    broader concepts), and for Stage B of relationships-and-project-kinds a
    property's other way round, characteristics and more general property,
    and a concept's related concepts, mappings and top-concept schemes.

BASIC IDEA
    The detail panel already fetches every statement about the entity, and
    for a project document each URI term carries the kind its rdf:type gives.
    That is enough to build every block of the form, so the form costs no
    request of its own and refreshes with the panel on each new revision.

    "Editable" means defined in this document: the entity has an rdf:type
    here. A class that is only mentioned -- foaf:Agent as a parent -- is
    somebody else's, and the form says so rather than writing labels onto it.

    The annotations block is every statement that is not already a block of
    its own: not a name shown under Names, not the definition, not structure
    (rdf:type, subClassOf, domain, range, broader, scheme, related, the
    mappings), and not an OWL axiom. What is left is exactly what AddAnnotation, ReplaceAnnotation and
    RemoveAnnotation can address. A value whose datatype is not one of the
    seven the command layer offers is listed but not editable here; Turtle
    edits it.

INPUTS / INPUT SOURCES
    - NodeDetails from /node, for a project document (with `kind` on terms).
    - The project's primary and additional languages.

EXPECTED OUTPUT
    - entityModel(details, primary, languages) -> EntityModel.
================================================================================
*/

import type { AnnotationValue, NodeDetails, TermRef } from "../types";
import type { Characteristic } from "./sentences";
import { datatypeName } from "./values";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

export const P = {
  type: `${RDF}type`,
  label: `${RDFS}label`,
  comment: `${RDFS}comment`,
  subClassOf: `${RDFS}subClassOf`,
  subPropertyOf: `${RDFS}subPropertyOf`,
  domain: `${RDFS}domain`,
  range: `${RDFS}range`,
  prefLabel: `${SKOS}prefLabel`,
  definition: `${SKOS}definition`,
  broader: `${SKOS}broader`,
  narrower: `${SKOS}narrower`,
  inScheme: `${SKOS}inScheme`,
  topConceptOf: `${SKOS}topConceptOf`,
  hasTopConcept: `${SKOS}hasTopConcept`,
  inverseOf: `${OWL}inverseOf`,
  related: `${SKOS}related`,
} as const;

/** The characteristics a property can carry, by the rdf:type each is (5.6). */
export const CHARACTERISTIC_TYPES: Record<string, Characteristic> = {
  [`${OWL}FunctionalProperty`]: "functional",
  [`${OWL}InverseFunctionalProperty`]: "inverseFunctional",
  [`${OWL}SymmetricProperty`]: "symmetric",
  [`${OWL}TransitiveProperty`]: "transitive",
  [`${OWL}AsymmetricProperty`]: "asymmetric",
  [`${OWL}IrreflexiveProperty`]: "irreflexive",
  [`${OWL}ReflexiveProperty`]: "reflexive",
};

/** The five SKOS mapping properties, by the name the commands take (5.8). */
export const MAPPING_PROPERTIES: Record<string, string> = {
  [`${SKOS}exactMatch`]: "exactMatch",
  [`${SKOS}closeMatch`]: "closeMatch",
  [`${SKOS}broadMatch`]: "broadMatch",
  [`${SKOS}narrowMatch`]: "narrowMatch",
  [`${SKOS}relatedMatch`]: "relatedMatch",
};

const STRUCTURE = new Set<string>([
  P.type,
  P.subClassOf,
  P.subPropertyOf,
  P.domain,
  P.range,
  P.broader,
  P.narrower,
  P.inScheme,
  P.topConceptOf,
  P.hasTopConcept,
  P.related,
  ...Object.keys(MAPPING_PROPERTIES),
]);

export interface Ref {
  iri: string;
  label: string;
}

export interface Name {
  lang: string;
  /** The name, or null where the translation is missing. */
  value: string | null;
  /** The predicate and exact tag it is stored under, to remove it by. */
  predicate: string | null;
  tag: string | null;
}

export interface Annotation {
  property: Ref & { prefixed: string };
  value: AnnotationValue;
  /** False for a datatype the command layer does not offer. */
  editable: boolean;
}

export interface EntityModel {
  kind: string;
  /** Defined in this document: it has an rdf:type here. */
  defined: boolean;
  /** skos:prefLabel for a concept, rdfs:label for anything else (SetLabel's rule). */
  namePredicate: string;
  names: Name[];
  definition: { property: string; value: AnnotationValue } | null;
  annotations: Annotation[];
  parents: Ref[];
  children: Ref[];
  attributes: Ref[];
  relationships: Ref[];
  domain: Ref | null;
  range: Ref | null;
  broader: Ref[];
  narrower: Ref[];
  schemes: Ref[];
  /** The schemes it is a top concept of, written either way round (5.8). */
  topOf: Ref[];
  /** owl:inverseOf, read either way round (5.6). */
  inverses: Ref[];
  characteristics: Set<Characteristic>;
  /** rdfs:subPropertyOf: the more general relationship or attribute. */
  superProperties: Ref[];
  /** skos:related, read either way round. */
  related: Ref[];
  mappings: { kind: string; target: Ref }[];
  /** The panel loads at most 500 statements each way; past that the lists
   *  above are read from part of them, and the form has to say so. */
  partial: boolean;
}

/** A tag matches a language by prefix, as the server's lang_matches does. */
export function langMatches(tag: string | null | undefined, lang: string): boolean {
  if (!tag) return false;
  const t = tag.toLowerCase();
  const l = lang.toLowerCase();
  return t === l || t.startsWith(`${l}-`);
}

function ref(term: TermRef): Ref {
  const label = term.label && term.label !== term.prefixed ? term.label : (term.prefixed ?? term.value);
  return { iri: term.value, label };
}

/** A literal or IRI term as the value the annotation commands take. */
export function termValue(term: TermRef): { value: AnnotationValue; editable: boolean } {
  if (term.type === "uri") return { value: { kind: "link", value: term.value }, editable: true };
  if (term.lang) return { value: { kind: "text", value: term.value, lang: term.lang }, editable: true };
  if (!term.datatype) {
    // A plain literal: sent as xsd:string, which the server matches to it.
    return { value: { kind: "typed", value: term.value, datatype: "xsd:string" }, editable: true };
  }
  const name = datatypeName(term.datatype);
  return {
    value: { kind: "typed", value: term.value, datatype: name ? `xsd:${name}` : term.datatype },
    editable: name !== null,
  };
}

function kindFromStatements(details: NodeDetails): string {
  if (details.kind && details.kind !== "other") return details.kind;
  // Not typed here: infer what the statements that mention it say it is.
  if (details.incoming.some((r) => r.predicate.value === P.subClassOf)) return "class";
  if (details.outgoing.some((r) => r.predicate.value === P.subClassOf)) return "class";
  if (details.incoming.some((r) => r.predicate.value === P.broader)) return "concept";
  if (details.outgoing.some((r) => r.predicate.value === P.broader)) return "concept";
  return details.kind ?? "other";
}

function uniq(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.iri) ? false : (seen.add(r.iri), true)));
}

export function entityModel(details: NodeDetails, primary: string, languages: string[]): EntityModel {
  const kind = kindFromStatements(details);
  const out = details.outgoing;
  const inc = details.incoming;
  const defined = out.some((r) => r.predicate.value === P.type);
  const namePredicate = kind === "concept" ? P.prefLabel : P.label;

  // Names: the first label in each project language, preferring the
  // predicate SetLabel writes, then the other.
  const shown = new Set<TermRef>();
  const names: Name[] = [primary, ...languages.filter((l) => l !== primary)].map((lang) => {
    for (const predicate of [namePredicate, namePredicate === P.label ? P.prefLabel : P.label]) {
      const row = out.find(
        (r) => r.predicate.value === predicate && r.object.type === "literal" && langMatches(r.object.lang, lang),
      );
      if (row) {
        shown.add(row.object);
        return { lang, value: row.object.value, predicate, tag: row.object.lang ?? lang };
      }
    }
    return { lang, value: null, predicate: null, tag: null };
  });

  // The definition: skos:definition in the primary language, else the
  // rdfs:comment that is there (in the primary language or untagged).
  let definition: EntityModel["definition"] = null;
  const byLang = (predicate: string, allowUntagged: boolean) =>
    out.find(
      (r) =>
        r.predicate.value === predicate &&
        r.object.type === "literal" &&
        (langMatches(r.object.lang, primary) || (allowUntagged && !r.object.lang && !r.object.datatype)),
    );
  const defRow = byLang(P.definition, false) ?? byLang(P.comment, true);
  if (defRow) {
    shown.add(defRow.object);
    definition = { property: defRow.predicate.value, value: termValue(defRow.object).value };
  }

  const annotations: Annotation[] = [];
  for (const row of out) {
    const p = row.predicate.value;
    if (shown.has(row.object) || STRUCTURE.has(p) || row.object.type === "bnode") continue;
    if (row.object.type !== "literal" && row.object.type !== "uri") continue;
    // An OWL axiom pointing at another entity (equivalentClass, disjointWith
    // ...) is structure the form does not draw; Turtle edits it.
    if (row.object.type === "uri" && p.startsWith(OWL)) continue;
    const { value, editable } = termValue(row.object);
    annotations.push({
      property: { ...ref(row.predicate), prefixed: row.predicate.prefixed ?? p },
      value,
      editable,
    });
  }

  const objects = (predicate: string) =>
    out.filter((r) => r.predicate.value === predicate && r.object.type === "uri").map((r) => ref(r.object));
  const subjects = (predicate: string, kinds?: string[]) =>
    inc
      .filter(
        (r) =>
          r.predicate.value === predicate &&
          r.subject.type === "uri" &&
          (!kinds || kinds.includes(r.subject.kind ?? "")),
      )
      .map((r) => ref(r.subject));

  return {
    kind,
    defined,
    namePredicate,
    names,
    definition,
    annotations,
    parents: uniq(objects(P.subClassOf)),
    children: uniq(subjects(P.subClassOf)),
    attributes: uniq(subjects(P.domain, ["datatypeProperty"])),
    relationships: uniq(subjects(P.domain, ["objectProperty"])),
    domain: objects(P.domain)[0] ?? null,
    range: objects(P.range)[0] ?? null,
    broader: uniq([...objects(P.broader), ...subjects(P.narrower)]),
    narrower: uniq([...subjects(P.broader), ...objects(P.narrower)]),
    schemes: uniq([...objects(P.inScheme), ...objects(P.topConceptOf)]),
    topOf: uniq([...objects(P.topConceptOf), ...subjects(P.hasTopConcept)]),
    inverses: uniq([...objects(P.inverseOf), ...subjects(P.inverseOf)]).filter((r) => r.iri !== details.iri),
    characteristics: new Set(
      out
        .filter((r) => r.predicate.value === P.type && r.object.type === "uri" && CHARACTERISTIC_TYPES[r.object.value])
        .map((r) => CHARACTERISTIC_TYPES[r.object.value]),
    ),
    superProperties: uniq(objects(P.subPropertyOf)),
    related: uniq([...objects(P.related), ...subjects(P.related)]).filter((r) => r.iri !== details.iri),
    mappings: out
      .filter((r) => MAPPING_PROPERTIES[r.predicate.value] && r.object.type === "uri")
      .map((r) => ({ kind: MAPPING_PROPERTIES[r.predicate.value], target: ref(r.object) })),
    partial: details.outgoingTotal > out.length || details.incomingTotal > inc.length,
  };
}

/** Where an entity's structure block comes from, by kind. */
export function structureOf(kind: string): "class" | "property" | "concept" | null {
  if (kind === "class") return "class";
  if (kind === "objectProperty" || kind === "datatypeProperty") return "property";
  if (kind === "concept") return "concept";
  return null;
}
