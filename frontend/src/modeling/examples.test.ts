/*
================================================================================
FILE: frontend/src/modeling/examples.test.ts
================================================================================

SUMMARY
    Example data in the form (shacl-authoring 5.8): a class's examples read
    from its statements, the type a field is entered as, the check that
    refuses a wrong value before it is sent (row S22), and which command a
    field's change becomes.

BASIC IDEA
    Pure functions, tested without rendering.

INPUTS / INPUT SOURCES
    - Hand-built NodeDetails and fields.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { ExampleField, NodeDetails, TermRef } from "../types";
import { examplesOf, fieldCommand, fieldProblem, fieldType, fieldValue, typeWords } from "./examples";

const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const X = "http://x#";

function uri(value: string, label: string, kind?: string): TermRef {
  return { type: "uri", value, label, prefixed: `x:${value.slice(X.length)}`, ...(kind ? { kind } : {}) };
}

function field(changes: Partial<ExampleField>): ExampleField {
  return { property: `${X}birthDate`, label: "birth date", kind: "attribute", functional: false, values: [], datatype: "xsd:date", ...changes };
}

describe("examplesOf", () => {
  it("lists the individuals typed with the class, sorted, once each, never a subclass", () => {
    const details = {
      iri: `${X}Person`, prefixed: "x:Person", label: "Person", outgoing: [], outgoingTotal: 0, incomingTotal: 4,
      incoming: [
        { subject: uri(`${X}bob`, "Bob", "individual"), predicate: uri(TYPE, "type") },
        { subject: uri(`${X}alice`, "Alice", "other"), predicate: uri(TYPE, "type") },
        { subject: uri(`${X}bob`, "Bob", "individual"), predicate: uri(TYPE, "type") },
        { subject: uri(`${X}Employee`, "Employee", "class"), predicate: uri("http://www.w3.org/2000/01/rdf-schema#subClassOf", "subClassOf") },
      ],
    } as NodeDetails;
    expect(examplesOf(details)).toEqual([
      { iri: `${X}alice`, label: "Alice" },
      { iri: `${X}bob`, label: "Bob" },
    ]);
  });
});

describe("a field's type of value", () => {
  it("enters an attribute as its type, text in a language without one, a relationship as a link", () => {
    expect(fieldType(field({}))).toEqual({ kind: "typed", datatype: "xsd:date" });
    expect(fieldType(field({ datatype: null }))).toEqual({ kind: "text" });
    expect(fieldType(field({ datatype: "rdf:langString" }))).toEqual({ kind: "text" });
    expect(fieldType(field({ kind: "relationship", datatype: undefined }))).toEqual({ kind: "link" });
    expect(typeWords(field({}))).toBe("a date, YYYY-MM-DD");
  });

  it("refuses a wrong value before it is sent, in the server's words (row S22)", () => {
    expect(fieldProblem(field({}), "yesterday")).toBe('"yesterday" is not a valid date (expected YYYY-MM-DD).');
    expect(fieldProblem(field({}), "1990-02-30")).toBe('"1990-02-30" is not a valid date (expected YYYY-MM-DD).');
    expect(fieldProblem(field({}), "1990-05-01")).toBeNull();
    expect(fieldProblem(field({ datatype: "xsd:integer" }), "4.5")).toBe('"4.5" is not a valid integer (expected a whole number such as 42).');
    expect(fieldProblem(field({}), "  ")).toBe("Give birth date a value.");
    expect(fieldProblem(field({ kind: "relationship", rangeLabel: "Organization" }), "")).toBe("Choose the Organization to link.");
  });

  it("sends the value the command takes", () => {
    expect(fieldValue(field({}), " 1990-05-01 ")).toEqual({ kind: "typed", value: "1990-05-01", datatype: "xsd:date" });
    expect(fieldValue(field({ datatype: null }), "Bobby", "en")).toEqual({ kind: "text", value: "Bobby", lang: "en" });
    expect(fieldValue(field({ kind: "relationship" }), `${X}acme`)).toEqual({ kind: "link", value: `${X}acme` });
  });

  it("sets a one-value field and adds to any other", () => {
    expect(fieldCommand(field({ functional: true }))).toBe("SetExampleValue");
    expect(fieldCommand(field({}))).toBe("AddExampleValue");
  });
});
