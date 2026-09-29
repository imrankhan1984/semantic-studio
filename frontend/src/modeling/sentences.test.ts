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
