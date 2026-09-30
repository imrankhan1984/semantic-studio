/*
================================================================================
FILE: frontend/src/modeling/sentences.test.ts
================================================================================

SUMMARY
    The sentences a relationship is read as (relationships 5.2, 5.3, 5.5):
    articles by the first letter, the sentence while naming, the link
    sentences, the announcement, and a tree row's ends.

BASIC IDEA
    Pure strings, so every case is one line.

INPUTS / INPUT SOURCES
    - modeling/sentences.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import * as S from "./sentences";
import {
  article,
  createdAnnouncement,
  existingSentence,
  linkSentence,
  relationshipSentence,
  rowEnds,
  typeWord,
} from "./sentences";

describe("sentences", () => {
  it("chooses a or an by the first letter, and nothing more", () => {
    expect(article("Person")).toBe("a");
    expect(article("Organization")).toBe("an");
    expect(article("invoice")).toBe("an");
    // No grammar beyond the letter, as the spec says.
    expect(article("University")).toBe("an");
    expect(article("Hour")).toBe("a");
  });

  it("reads a relationship as it is named, with the gap before the first key", () => {
    expect(relationshipSentence("Person", "works for", "Organization")).toBe("A Person works for an Organization.");
    expect(relationshipSentence("Employee", "reports to", "Employee")).toBe("An Employee reports to an Employee.");
    expect(relationshipSentence("Person", "  ", "Organization")).toBe("A Person … an Organization.");
  });

  it("reads each line the way it points", () => {
    expect(linkSentence("subClassOf", "Employee", "Person")).toBe("Employee is a kind of Person");
    expect(linkSentence("broader", "Apple", "Fruit")).toBe("Apple is narrower than Fruit");
    expect(existingSentence("Person", "works for", "Organization")).toBe(
      "Person works for Organization (existing relationship)",
    );
    expect(createdAnnouncement("works for", "Person", "Organization")).toBe(
      "Created relationship works for, from Person to Organization.",
    );
  });

  it("reads a tree row's ends, a missing one included", () => {
    expect(rowEnds({ domain: "Person", range: "Organization" }, false)).toBe("Person → Organization");
    expect(rowEnds({ domain: null, range: null }, false)).toBe("no start yet → no end yet");
    expect(rowEnds({ domain: "Person", range: "xsd:string" }, true)).toBe("Person, text");
    expect(rowEnds({ domain: "Invoice", range: "xsd:decimal" }, true)).toBe("Invoice, decimal number");
    expect(rowEnds({ domain: null, range: null }, true)).toBe("no start yet, no type yet");
  });

  it("names the seven types in words and leaves any other as written", () => {
    expect(
      ["xsd:string", "xsd:integer", "xsd:decimal", "xsd:boolean", "xsd:date", "xsd:dateTime", "xsd:anyURI"].map(typeWord),
    ).toEqual(["text", "whole number", "decimal number", "yes or no", "date", "date and time", "web address"]);
    expect(typeWord("xsd:gYear")).toBe("xsd:gYear");
  });
});

describe("Stage B sentences (relationships 5.6 to 5.8)", () => {
  it("reads the relationship back, with the missing end said", () => {
    expect(S.formSentence("Person", "works for", "Organization")).toBe("A Person works for an Organization.");
    expect(S.formSentence(null, "works for", "Organization")).toBe("(no start yet) works for an Organization.");
    expect(S.formSentence("Person", "works for", null)).toBe("A Person works for (no end yet).");
  });

  it("reads the other way round with the ends swapped", () => {
    expect(S.inverseSentence("employs", "Person", "Organization")).toBe("An Organization employs a Person.");
  });

  it("writes every characteristic's example from the relationship's own names, as 5.6 shows them", () => {
    const example = (id: S.Characteristic) => S.characteristicExample(id, "works for", "Person", "Organization");
    expect(S.CHARACTERISTICS.map((c) => [c.name, example(c.id)])).toEqual([
      ["At most one", "A Person works for at most one Organization."],
      ["Identifies its start", "An Organization is linked by works for to at most one Person."],
      ["Works both ways", "If A works for B, then B works for A."],
      ["Chains", "If A works for B and B works for C, then A works for C."],
      ["Never both ways", "If A works for B, then B never works for A."],
      ["Never to itself", "Nothing works for itself."],
      ["Always to itself", "Everything works for itself."],
    ]);
    // Four always shown, three under More.
    expect(S.CHARACTERISTICS.filter((c) => c.more).map((c) => c.id)).toEqual(["asymmetric", "irreflexive", "reflexive"]);
  });

  it("gives an example even before the ends are set", () => {
    expect(S.characteristicExample("functional", "owns", null, null)).toBe("Something owns at most one thing.");
    expect(S.characteristicExample("inverseFunctional", "owns", null, null)).toBe(
      "Something is linked by owns to at most one thing.",
    );
  });

  it("names the more general relationship and why there is one start and one end", () => {
    expect(S.parentSentence("works for", "member of")).toBe("works for is a more specific kind of member of");
    expect(S.oneStartOneEnd("works for", "Person")).toContain('To use "works for" from another class too, make Person and that class');
  });

  it("reads an attribute and one value only", () => {
    expect(S.attributeSentence("Person", "name", "xsd:string")).toBe("A Person has a name, as text.");
    expect(S.attributeSentence(null, "age", null)).toBe("Something has an age.");
    expect(S.oneValueExample("Person", "name")).toBe("A Person has at most one name.");
  });

  it("reads related lines, top concepts and the five mappings", () => {
    expect(S.linkSentence("related", "Apple", "Orchard")).toBe("Apple is related to Orchard");
    expect(S.topConceptSentence("Fruits")).toBe("Top concept of Fruits");
    expect(S.MAPPINGS.map((m) => m.id)).toEqual(["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"]);
    expect(S.MAPPINGS.every((m) => m.means.endsWith("."))).toBe(true);
  });

  it("keeps relationships and attributes read-only in a taxonomy, and only there (5.10 item 2)", () => {
    expect(S.otherKindReason("taxonomy", "objectProperty")).toMatch(/^A relationship, read-only in a taxonomy/);
    expect(S.otherKindReason("taxonomy", "datatypeProperty")).toMatch(/^An attribute, read-only in a taxonomy/);
    expect(S.otherKindReason("ontology", "objectProperty")).toBeNull();
    expect(S.otherKindReason(null, "objectProperty")).toBeNull();
  });
});
