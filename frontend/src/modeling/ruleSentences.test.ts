/*
================================================================================
FILE: frontend/src/modeling/ruleSentences.test.ts
================================================================================

SUMMARY
    axioms-and-reasoning Stage B, the words both ways (AC-8, AC-9): every
    5.8 row as its sentence, its canvas label and its open-world note; the
    builder's state as the sentence so far, the problem that stops Add, and
    the command Add sends -- the same arguments the server's commands take,
    and for an existing rule, the state Edit opens on sends it back as it
    was.

BASIC IDEA
    Pure functions, no rendering. The items are shaped as /node sends them
    (axioms.py's class_rules).

INPUTS / INPUT SOURCES
    - Inline rule items and choices.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { RuleChoices, RuleRestriction } from "../types";
import {
  EMPTY_BUILDER,
  builderCommand,
  builderProblem,
  builderSentence,
  itemSentence,
  moreRulesText,
  openWorldNote,
  partsOf,
  removeCommand,
  shortLabel,
  stateOf,
} from "./ruleSentences";

const EX = "http://example.org/shop#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const ref = (local: string, label: string) => ({ iri: EX + local, label });
const hasLine = { ...ref("hasLine", "has line"), kind: "relationship" as const };
const manages = { ...ref("manages", "manages"), kind: "relationship" as const };
const birthDate = { ...ref("birthDate", "birth date"), kind: "attribute" as const };
const status = { ...ref("status", "status"), kind: "attribute" as const };

function rule(part: Partial<RuleRestriction>): RuleRestriction {
  const base: RuleRestriction = {
    type: "restriction",
    form: "every",
    property: hasLine,
    kind: "some",
    filler: ref("OrderLine", "Order line"),
    n: null,
    with: null,
    key: { form: "every", property: EX + "hasLine", kind: "some", filler: EX + "OrderLine", n: null },
    editable: true,
  };
  return { ...base, ...part };
}

// Each 5.8 row: the item as the server reads it, its class, and its sentence.
const ROWS: [string, RuleRestriction, string, string][] = [
  ["some", rule({}), "Order", "Every Order has at least one has line that is an Order line"],
  ["only", rule({ kind: "only" }), "Order", "Every Order's has line can only be Order lines"],
  ["exactly 2 qualified", rule({ kind: "exactly", n: 2 }), "Order", "Every Order has exactly 2 has line that are Order lines"],
  ["at least 1 qualified", rule({ kind: "atLeast", n: 1 }), "Order", "Every Order has at least one has line that is an Order line"],
  ["at most unqualified", rule({ kind: "atMost", n: 10, filler: null }), "Order", "Every Order has at most 10 has line"],
  ["attribute at most one", rule({ property: birthDate, kind: "atMost", n: 1, filler: null }), "Person", "Every Person has at most one birth date"],
  [
    "has value",
    rule({ property: status, kind: "value", filler: { kind: "typed", value: "gold", datatype: "xsd:string" } }),
    "Gold customer",
    "Every Gold customer has status gold",
  ],
  [
    "defines",
    rule({ form: "defines", property: manages, filler: ref("Employee", "Employee"), with: ref("Person", "Person") }),
    "Manager",
    "A Manager is exactly a Person that manages at least one Employee",
  ],
  [
    "defines alone",
    rule({ form: "defines", property: manages, filler: ref("Employee", "Employee") }),
    "Manager",
    "A Manager is exactly something that manages at least one Employee",
  ],
];

describe("a rule as its sentence (5.8)", () => {
  it.each(ROWS)("%s", (_name, item, cls, sentence) => {
    expect(itemSentence(cls, item)).toBe(sentence);
  });

  it("disjoint and same meaning", () => {
    expect(itemSentence("Person", { type: "disjoint", other: ref("Organization", "Organization"), editable: true })).toBe(
      "No Person is an Organization",
    );
    expect(itemSentence("Client", { type: "equivalent", other: ref("Customer", "Customer"), editable: true })).toBe(
      "Client and Customer mean the same thing",
    );
    expect(itemSentence("Order", { type: "turtle", turtle: "x", editable: false })).toBeNull();
  });

  it("a thing as a value reads by its name", () => {
    const item = rule({ property: manages, kind: "value", filler: { kind: "link", value: EX + "acme", label: "Acme" } });
    expect(itemSentence("Employee", item)).toBe("Every Employee has manages Acme");
  });
});

describe("the canvas label (5.9)", () => {
  it("is the short form, and *defines* for a defining rule", () => {
    const parts = { propertyLabel: "has line", n: null };
    expect(shortLabel({ form: "every", kind: "some", ...parts })).toBe("at least 1 · has line");
    expect(shortLabel({ form: "every", kind: "only", ...parts })).toBe("only · has line");
    expect(shortLabel({ form: "every", kind: "atLeast", propertyLabel: "has line", n: 3 })).toBe("at least 3 · has line");
    expect(shortLabel({ form: "every", kind: "exactly", propertyLabel: "has line", n: 2 })).toBe("exactly 2 · has line");
    expect(shortLabel({ form: "defines", kind: "some", ...parts })).toBe("defines");
    expect(moreRulesText(1)).toBe("1 more rule in the form");
    expect(moreRulesText(2)).toBe("2 more rules in the form");
  });
});

describe("the open-world note (Q3)", () => {
  it("says the rule does not check data, with the case that is not an error", () => {
    expect(openWorldNote("Order", partsOf(rule({})))).toBe(
      "This describes every Order. It does not check your data: an Order with no line is not an error here.",
    );
    expect(openWorldNote("Order", partsOf(rule({ kind: "only" })))).toBe(
      "This describes every Order. It does not check your data: an Order with a line that is not an Order line is not an error here.",
    );
    expect(openWorldNote("Order", partsOf(rule({ kind: "atMost", n: 2, filler: null })))).toContain("more than 2 lines");
  });
});

// ---------------------------------------------------------------------------

const choices: RuleChoices = {
  properties: {
    items: [hasLine, manages, { ...birthDate, datatype: XSD + "date" }, { ...status, datatype: XSD + "string" }],
    total: 4,
  },
  classes: {
    items: [ref("Order", "Order"), ref("OrderLine", "Order line"), ref("Person", "Person"), ref("Employee", "Employee")],
    total: 4,
  },
  things: { items: [ref("acme", "Acme")], total: 1 },
};

describe("the builder (5.9)", () => {
  it("reads the sentence as the blanks fill", () => {
    let state = { ...EMPTY_BUILDER };
    expect(builderSentence("Order", state, choices)).toBe("Every Order …");
    state = { ...state, property: EX + "hasLine", kind: "some" };
    expect(builderSentence("Order", state, choices)).toBe("Every Order has at least one has line that is …");
    state = { ...state, filler: EX + "OrderLine" };
    expect(builderSentence("Order", state, choices)).toBe("Every Order has at least one has line that is an Order line");
    expect(builderSentence("Person", { ...EMPTY_BUILDER, type: "disjoint" }, choices)).toBe("No Person is …");
  });

  it("says what stops Add", () => {
    expect(builderProblem(EMPTY_BUILDER, choices)).toBe("Choose the relationship or attribute.");
    expect(builderProblem({ ...EMPTY_BUILDER, property: EX + "hasLine" }, choices)).toBe("Choose what is true of it.");
    expect(builderProblem({ ...EMPTY_BUILDER, property: EX + "hasLine", kind: "some" }, choices)).toBe(
      "Choose the class it points to.",
    );
    for (const n of ["-1", "1001", "1.5", "", "two"]) {
      expect(builderProblem({ ...EMPTY_BUILDER, property: EX + "hasLine", kind: "atLeast", n }, choices)).toBe(
        "A number of 0 to 1,000.",
      );
    }
    expect(builderProblem({ ...EMPTY_BUILDER, property: EX + "birthDate", kind: "only" }, choices)).toBe(
      "An attribute takes exactly, at least, at most or a value.",
    );
    expect(builderProblem({ ...EMPTY_BUILDER, type: "equivalent" }, choices)).toBe("Choose the other class.");
  });

  it("sends nothing while a blank stops it", () => {
    expect(builderCommand(EX + "Order", EMPTY_BUILDER, choices)).toBeNull();
  });

  it("sends AddRestriction with the server's arguments", () => {
    const state = { ...EMPTY_BUILDER, property: EX + "hasLine", kind: "atLeast" as const, n: "2", filler: EX + "OrderLine" };
    expect(builderCommand(EX + "Order", state, choices)).toEqual({
      name: "AddRestriction",
      args: { class: EX + "Order", form: "every", property: EX + "hasLine", kind: "atLeast", filler: EX + "OrderLine", n: 2 },
    });
  });

  it("sends an attribute's value typed with the attribute's type, text as xsd:string", () => {
    const value = (property: string, typed: string) =>
      builderCommand(EX + "X", { ...EMPTY_BUILDER, property, kind: "value", value: typed }, choices)!.args.filler;
    expect(value(EX + "status", "gold")).toEqual({ kind: "typed", value: "gold", datatype: "xsd:string" });
    expect(value(EX + "birthDate", "2000-01-01")).toEqual({ kind: "typed", value: "2000-01-01", datatype: "xsd:date" });
  });

  it("sends the defining form with its named class, and the pairs", () => {
    const state = { ...EMPTY_BUILDER, type: "defines" as const, property: EX + "manages", kind: "some" as const, filler: EX + "Employee", with: EX + "Person" };
    expect(builderCommand(EX + "Manager", state, choices)!.args).toMatchObject({ form: "defines", with: EX + "Person" });
    expect(builderCommand(EX + "Person", { ...EMPTY_BUILDER, type: "disjoint", other: EX + "Order" }, choices)).toEqual({
      name: "AddDisjointWith",
      args: { a: EX + "Person", b: EX + "Order" },
    });
    expect(builderCommand(EX + "Person", { ...EMPTY_BUILDER, type: "equivalent", other: EX + "Order" }, choices)!.name).toBe(
      "AddEquivalentClass",
    );
  });

  it.each(ROWS)("Edit opens on %s and sends back what it says", (_name, item) => {
    // Turtle to form to command: the state Edit opens on writes the same rule.
    const command = builderCommand(EX + "C", stateOf(item), choices, item.key)!;
    expect(command.name).toBe("ReplaceRestriction");
    expect(command.args.restriction).toBe(item.key);
    expect(command.args).toMatchObject({ form: item.form, property: item.property.iri, kind: item.kind, n: item.n });
    if (item.kind === "value" && item.filler && !("iri" in item.filler)) {
      expect((command.args.filler as { value: string }).value).toBe(item.filler.value);
    } else {
      expect(command.args.filler).toBe(item.filler && "iri" in item.filler ? item.filler.iri : null);
    }
    expect(command.args.with).toBe(item.with?.iri);
  });

  it("removes each kind of item by its own command, and nothing read-only", () => {
    expect(removeCommand(EX + "Order", rule({}))).toEqual({
      name: "RemoveRestriction",
      args: { class: EX + "Order", restriction: rule({}).key },
    });
    expect(removeCommand(EX + "P", { type: "disjoint", other: ref("O", "O"), editable: true })!.name).toBe("RemoveDisjointWith");
    expect(removeCommand(EX + "P", { type: "equivalent", other: ref("O", "O"), editable: true })!.name).toBe("RemoveEquivalentClass");
    expect(removeCommand(EX + "P", rule({ editable: false }))).toBeNull();
    expect(removeCommand(EX + "P", { type: "turtle", turtle: "x", editable: false })).toBeNull();
  });
});
