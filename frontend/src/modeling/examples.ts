/*
================================================================================
FILE: frontend/src/modeling/examples.ts
================================================================================

SUMMARY
    Example data in the editing form (shacl-authoring 5.8): the examples a
    class's form lists, the type of value each field of an example is
    entered as, the check that refuses a wrong value before it is sent
    (row S22), and the command and arguments a field's change becomes.

BASIC IDEA
    The server works out an example's fields (examples.py) and sends them
    with the entity's statements, so this only reads them. A field is an
    attribute, entered as its type of value -- a date as a date, checked as
    E-6 checks an annotation (values.ts), whose sentences are the server's
    -- or a relationship, chosen from the examples of its end class.

    A type of value outside the seven offered (xsd:float, xsd:gYear from an
    import) is entered as text but sent typed with its own datatype, and the
    hint names it: *a value of type xsd:float*. The server checks it where
    rdflib knows the type (PR #51 review).

    A field that takes one value (the attribute or relationship is marked
    *at most one*) is set: SetExampleValue replaces whatever was there. Any
    other field gains a value with AddExampleValue, and loses one with
    RemoveExampleValue. Each is one undo step.

INPUTS / INPUT SOURCES
    - NodeDetails of a class (its incoming rdf:type rows) or of an example
      (its `example` block), from /node.

EXPECTED OUTPUT
    - examplesOf, fieldType, otherType, fieldProblem, fieldValue, fieldStart,
      fieldCommand, typeWords.
================================================================================
*/

import type { AnnotationValue, ExampleField, NodeDetails, ValueType } from "../types";
import { P } from "./entity";
import { datatypeName, toValue, valueProblem } from "./values";

/** The examples of a class: what its statements say is of this class and
 *  is an individual (or untyped otherwise, as Turtle may write one). */
export function examplesOf(details: NodeDetails): { iri: string; label: string }[] {
  const seen = new Set<string>();
  const out: { iri: string; label: string }[] = [];
  for (const row of details.incoming) {
    const s = row.subject;
    if (row.predicate.value !== P.type || s.type !== "uri") continue;
    if (s.kind !== "individual" && s.kind !== "other") continue;
    if (seen.has(s.value)) continue;
    seen.add(s.value);
    out.push({ iri: s.value, label: s.label && s.label !== s.prefixed ? s.label : (s.prefixed ?? s.value) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const XSD = "http://www.w3.org/2001/XMLSchema#";
/** Types that mean "text", in a language or not said. */
const TEXT_TYPES = new Set([
  "rdf:langString",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
  "http://www.w3.org/2000/01/rdf-schema#Literal",
]);

/** A type of value outside the seven offered, as the hint names it
 *  (xsd:float), or null when the field's type is offered or text. */
export function otherType(field: ExampleField): string | null {
  const type = field.datatype;
  if (field.kind !== "attribute" || !type || TEXT_TYPES.has(type) || datatypeName(type)) return null;
  return type.startsWith(XSD) ? `xsd:${type.slice(XSD.length)}` : type;
}

/** How a field's value is entered: its attribute's type of value, text in
 *  a language when it is rdf:langString or has none, and a type outside the
 *  seven as typed text carrying that type. */
export function fieldType(field: ExampleField): ValueType {
  if (field.kind === "relationship") return { kind: "link" };
  const name = datatypeName(field.datatype);
  if (name) return { kind: "typed", datatype: `xsd:${name}` };
  if (otherType(field)) return { kind: "typed", datatype: field.datatype! };
  return { kind: "text" };
}

/** The type of value in words, for the field's hint: "a date (YYYY-MM-DD)". */
export function typeWords(field: ExampleField): string {
  switch (datatypeName(field.datatype)) {
    case "string":
      return "text";
    case "integer":
      return "a whole number, such as 42";
    case "decimal":
      return "a number, such as 4.5";
    case "boolean":
      return "yes or no";
    case "date":
      return "a date, YYYY-MM-DD";
    case "dateTime":
      return "a date and time, YYYY-MM-DDThh:mm:ss";
    case "anyURI":
      return "a web address";
    default:
      return otherType(field) ? `a value of type ${otherType(field)}` : "text in a language";
  }
}

/** Why this cannot be sent, in the server's words, or null (row S22). */
export function fieldProblem(field: ExampleField, raw: string, lang?: string): string | null {
  if (field.kind === "relationship") return raw ? null : `Choose the ${field.rangeLabel ?? "example"} to link.`;
  if (raw.trim() === "") return `Give ${field.label} a value.`;
  // A type the browser does not know is checked by the server.
  if (otherType(field)) return null;
  return valueProblem(fieldType(field), raw, lang);
}

/** The value the command takes for what was entered or chosen. */
export function fieldValue(field: ExampleField, raw: string, lang?: string): AnnotationValue {
  // Its own datatype, never xsd:string, which toValue falls back to.
  if (otherType(field)) return { kind: "typed", value: raw.trim(), datatype: field.datatype! };
  return toValue(fieldType(field), raw, lang);
}

/** What a field starts with: a yes/no field starts at yes, as the
 *  annotation adder does, so it is ready to add (PR #51 review). */
export function fieldStart(field: ExampleField): string {
  return field.kind === "attribute" && datatypeName(field.datatype) === "boolean" ? "true" : "";
}

/** A field that takes one value is set; any other gains one more. */
export function fieldCommand(field: ExampleField): "SetExampleValue" | "AddExampleValue" {
  return field.functional ? "SetExampleValue" : "AddExampleValue";
}
