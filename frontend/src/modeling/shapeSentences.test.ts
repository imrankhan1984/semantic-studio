/*
================================================================================
FILE: frontend/src/modeling/shapeSentences.test.ts
================================================================================

SUMMARY
    The sentences of shacl-authoring 5.3, 5.4 and 5.7, without rendering:
    each rule kind, the whole shape, a list row, the five panel headers, the
    live region's summary, and the checks that keep Add disabled.

BASIC IDEA
    Every rule and every result is a sentence in the learner's own names
    (Section 7), so each sentence is asserted word for word.

INPUTS / INPUT SOURCES
    - Rules, shapes and panels written inline.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { ShapeRule, ValidationPanel, ValidationResult } from "../types";
import {
  dateTimeBound,
  mustPhrase,
  panelHeader,
  panelName,
  pathWords,
  plural,
  rowSentence,
  ruleProblem,
  ruleSentence,
  shapeSentence,
  validationSummary,
} from "./shapeSentences";

const name: ShapeRule = { path: ["http://x#name"], pathLabel: "name", pathKind: "attribute" };
const phone: ShapeRule = { path: ["http://x#phone"], pathLabel: "phone number", pathKind: "attribute" };
const worksFor: ShapeRule = {
  path: ["http://x#worksFor"],
  pathLabel: "works for",
  pathKind: "relationship",
  class: "http://x#Organization",
  classLabel: "Organization",
};

describe("ruleSentence", () => {
  it("reads each count as the form offers it", () => {
    expect(ruleSentence({ ...name, minCount: 1 })).toBe("must have a name");
    expect(ruleSentence({ ...name, maxCount: 1 })).toBe("may have at most one name");
    expect(ruleSentence({ ...name, minCount: 1, maxCount: 1, datatype: "xsd:string" })).toBe(
      "must have exactly one name, as text",
    );
  });

  it("reads 5.3's example", () => {
    expect(ruleSentence({ ...phone, minCount: 1, maxCount: 3, datatype: "xsd:string", maxLength: 20 })).toBe(
      // 5.3's own words: the type and its length are one phrase (follow-up 5).
      "must have between 1 and 3 phone numbers, each text of at most 20 characters",
    );
  });

  it("reads a range, a pattern, allowed values and languages", () => {
    expect(
      ruleSentence({
        path: ["http://x#age"], pathLabel: "age", pathKind: "attribute",
        minInclusive: { value: "0", datatype: "xsd:integer" }, maxInclusive: { value: "150", datatype: "xsd:integer" },
      }),
    ).toBe("may have ages, each between 0 and 150");
    expect(ruleSentence({ ...name, maxCount: 1, pattern: "^[A-Z]" })).toBe(
      "may have at most one name, matching the pattern ^[A-Z]",
    );
    expect(
      ruleSentence({
        ...name, in: [{ kind: "typed", value: "active" }, { kind: "typed", value: "retired" }],
      }),
    ).toBe("may have names, each one of: active, retired");
    expect(
      ruleSentence({
        path: ["rdfs:label"], pathLabel: "name", pathKind: "name",
        requiredLanguages: ["en", "fr"], languageIn: ["en", "fr"], uniqueLang: true,
      }),
    ).toBe("must have a name in English and French, each only in English or French, one per language");
  });

  it("reads a relationship in its own words", () => {
    expect(ruleSentence(worksFor)).toBe("works for an Organization");
    expect(ruleSentence({ ...worksFor, maxCount: 1 })).toBe("works for an Organization, at most once");
    expect(ruleSentence({ ...worksFor, minCount: 1, maxCount: 1 })).toBe("works for an Organization, exactly once");
  });
});

describe("shapeSentence and rowSentence", () => {
  const shape = {
    target: { iri: "http://x#Person", label: "Person", every: null },
    rules: [{ ...name, minCount: 1, maxCount: 1, datatype: "xsd:string" }, worksFor],
  };

  it("reads the whole shape back from its rules", () => {
    expect(shapeSentence(shape)).toBe(
      // 5.3's own words: *must work for*, not *must be linked: works for* (follow-up 5).
      "Every Person must have exactly one name, as text, and must work for an Organization.",
    );
    expect(shapeSentence({ ...shape, rules: [] })).toBe("Every Person: no rules yet.");
    expect(shapeSentence({ target: { iri: "owl:Class", label: "Class", every: "every class" }, rules: [] })).toBe(
      "Every class: no rules yet.",
    );
  });

  it("gives a list row its count", () => {
    expect(rowSentence(shape)).toBe("Every Person: 2 rules");
    expect(rowSentence({ ...shape, rules: [name] })).toBe("Every Person: 1 rule");
  });
});

function panel(changes: Partial<ValidationPanel>): ValidationPanel {
  return {
    id: "s", name: "Person rules", state: "fails",
    target: { iri: "http://x#Person", label: "Person", one: "person", many: "people" },
    focusCount: 5, failingCount: 2, problemCount: 3, warningCount: 0,
    problems: [], problemsTotal: 3, error: null, ...changes,
  };
}

describe("panelHeader", () => {
  it("says each of the five states in words and counts (5.7)", () => {
    expect(panelHeader(panel({}))).toBe("Person rules: 2 of 5 people fail (3 problems)");
    expect(panelHeader(panel({
      name: "Organization rules", state: "passes", focusCount: 4,
      target: { iri: "o", label: "Organization", one: "organization", many: "organizations" },
    }))).toBe("Organization rules: all 4 organizations pass");
    expect(panelHeader(panel({ name: "Phone rules", state: "warnings", warningCount: 1 }))).toBe("Phone rules: 1 warning");
    expect(panelHeader(panel({
      name: "Invoice rules", state: "nothing",
      target: { iri: "i", label: "Invoice", one: "invoice", many: "invoices" },
    }))).toBe("Invoice rules: no Invoice in the data yet");
    expect(panelHeader(panel({ name: "Invoice rules", state: "error" }))).toBe(
      "Invoice rules: this shape could not be checked",
    );
  });

  it("names a panel with its state word first, so colour is never alone", () => {
    expect(panelName(panel({}))).toBe("Fails. Person rules: 2 of 5 people fail (3 problems)");
  });
});

describe("validationSummary", () => {
  const result = (shapes: ValidationPanel[], stopped = false): ValidationResult => ({
    stopped, statements: 1200, shapeCount: 3, shapes, durationMs: 4, revisions: { model: 1, shapes: 2 },
  });

  it("counts the states for the live region (Section 6)", () => {
    expect(validationSummary(result([panel({}), panel({ state: "fails" }), panel({ state: "passes" })]))).toBe(
      "3 shapes: 1 passes, 2 fail.",
    );
  });

  it("says when a check was stopped, and its size", () => {
    expect(validationSummary(result([], true))).toBe(
      "The check took too long and was stopped (3 shapes, 1,200 statements).",
    );
  });
});

describe("ruleProblem", () => {
  it("keeps Add disabled with a sentence for what cannot be added", () => {
    expect(ruleProblem(name)).toBe("Choose at least one thing to check.");
    expect(ruleProblem({ ...name, minCount: 3, maxCount: 1 })).toMatch(/could never be met/);
    expect(ruleProblem({ ...name, minCount: Number.NaN })).toMatch(/whole number/);
    expect(ruleProblem({ ...name, pattern: "(" })).toMatch(/not a regular expression/);
    expect(ruleProblem({ ...name, minInclusive: { value: "soon", datatype: "xsd:date" } })).toMatch(/not a date/);
    expect(ruleProblem({
      ...name, minInclusive: { value: "9", datatype: "xsd:integer" }, maxInclusive: { value: "2", datatype: "xsd:integer" },
    })).toMatch(/minimum is above/);
    expect(ruleProblem({ ...name, minCount: 1 })).toBeNull();
  });
});

describe("plural", () => {
  it.each([
    ["person", "people"], ["Person", "People"], ["class", "classes"], ["company", "companies"],
    ["phone number", "phone numbers"], ["day", "days"], ["box", "boxes"],
  ])("%s -> %s", (word, expected) => {
    expect(plural(word)).toBe(expected);
  });
});

describe("Stage A follow-ups fixed in Stage B (5.9)", () => {
  const name = { path: ["http://www.w3.org/2000/01/rdf-schema#label"], pathLabel: "name (label)", pathKind: "name" as const };

  it("puts the plural before the brackets of name (label) (item 4)", () => {
    expect(plural("name (label)")).toBe("names (label)");
    expect(ruleSentence({ ...name, minCount: 2 })).toBe("must have at least 2 names (label)");
  });

  it("reads a relationship after must as a verb, or with be (item 5)", () => {
    expect(mustPhrase("works for an Organization")).toBe("work for an Organization");
    expect(mustPhrase("member of an Organization")).toBe("be member of an Organization");
    expect(mustPhrase("has part a Wheel")).toBe("have part a Wheel");
    expect(mustPhrase("is part of a Car")).toBe("be part of a Car");
    expect(mustPhrase("teaches a Course")).toBe("teach a Course");
    expect(mustPhrase("carries a Bag")).toBe("carry a Bag");
    expect(mustPhrase("located in a City")).toBe("be located in a City");
  });

  it("reads 5.9's example as the follow-up asks: must be member of (item 5)", () => {
    const member = { path: ["http://x#memberOf"], pathLabel: "member of", pathKind: "relationship" as const, class: "http://x#Org", classLabel: "Organization" };
    expect(shapeSentence({ target: { iri: "http://x#Person", label: "Person", every: null }, rules: [member] })).toBe(
      "Every Person must be member of an Organization.",
    );
  });

  it("says nothing of a minimum of 0: between 0 and 3 is at most 3 (item 5)", () => {
    const phone = { path: ["http://x#phone"], pathLabel: "phone number", pathKind: "attribute" as const };
    expect(ruleSentence({ ...phone, minCount: 0, maxCount: 3 })).toBe("may have at most 3 phone numbers");
    const rel = { path: ["http://x#knows"], pathLabel: "knows", pathKind: "relationship" as const };
    expect(ruleSentence({ ...rel, minCount: 0, maxCount: 2 })).toBe("knows something, at most twice");
  });

  it("joins a type and its length into one phrase (item 5)", () => {
    const code = { path: ["http://x#code"], pathLabel: "code", pathKind: "attribute" as const, datatype: "xsd:string", maxLength: 8 };
    expect(ruleSentence({ ...code, maxCount: 1 })).toBe("may have at most one code, as text of at most 8 characters");
  });

  it("names a rule without a label by its path's last name (item 5)", () => {
    expect(pathWords({ path: ["http://x#nickname"] })).toBe("nickname");
    expect(pathWords({ path: ["http://x/a/alias", "http://x#nick"] })).toBe("alias or nick");
    expect(ruleSentence({ path: ["http://x#nickname"], minCount: 1 })).toBe("must have a nickname");
  });

  it("adds the seconds a date-and-time field leaves out, and checks the time (item 1)", () => {
    expect(dateTimeBound("2020-01-01T10:00")).toBe("2020-01-01T10:00:00");
    expect(dateTimeBound("2020-01-01T10:00:30")).toBe("2020-01-01T10:00:30");
    const at = { path: ["http://x#at"], pathLabel: "starts at", pathKind: "attribute" as const };
    expect(ruleProblem({ ...at, minInclusive: { value: "2020-01-01", datatype: "xsd:dateTime" } })).toBe(
      '"2020-01-01" is not a date and time (YYYY-MM-DDThh:mm:ss).',
    );
    expect(ruleProblem({ ...at, minInclusive: { value: "2020-01-01T10:00:00", datatype: "xsd:dateTime" } })).toBeNull();
  });
});
