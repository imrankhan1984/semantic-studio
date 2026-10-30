/*
================================================================================
FILE: frontend/src/referenceWords.test.ts
================================================================================

SUMMARY
    The Turtle editor's reference-term lines (reference-ontologies 5.7): with
    and without a closest match, the one-more and many-more endings, and none
    for an answer with nothing to say.

BASIC IDEA
    Pure strings, so every case is one line.

INPUTS / INPUT SOURCES
    - Fixed answers in the server's shape.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { unknownTermLines } from "./referenceWords";

describe("unknownTermLines", () => {
  it("names each term, with the closest match when there is one", () => {
    expect(
      unknownTermLines({
        terms: [
          { term: "qudt:Powr", reference: "QUDT", suggestion: "qudt:Power" },
          { term: "foaf:Banana", reference: "FOAF", suggestion: null },
        ],
        more: 0,
      }),
    ).toEqual(["qudt:Powr is not a term of QUDT. Did you mean qudt:Power?", "foaf:Banana is not a term of FOAF."]);
  });

  it("counts the rest, singular and plural", () => {
    const one = { term: "foaf:A", reference: "FOAF", suggestion: null };
    expect(unknownTermLines({ terms: [one], more: 1 })[1]).toBe("And 1 more term like it.");
    expect(unknownTermLines({ terms: [one], more: 1200 })[1]).toBe("And 1,200 more terms like these.");
  });

  it("says nothing for nothing", () => {
    expect(unknownTermLines(undefined)).toEqual([]);
    expect(unknownTermLines({ terms: [], more: 0 })).toEqual([]);
  });
});
