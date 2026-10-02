import { describe, expect, it } from "vitest";
import {
  NEW_ATTRIBUTE,
  choiceValue,
  initialColumns,
  parseChoice,
  stepBlocked,
  suggestedType,
  withChoice,
} from "./dataChoices";
import type { ColumnProfile, DataInspection } from "../types";

const P = "http://example.org/shop#";

function profile(changes: Partial<ColumnProfile>): ColumnProfile {
  return {
    name: "c", empty: 0, unique: true, repeats: 0, wholeNumbers: false, numbers: false, dates: false,
    dateTimes: false, ...changes,
  };
}

describe("what each column starts as (5.4)", () => {
  it("takes the suggestions and marks them, and starts everything else at Ignore", () => {
    const { columns, suggested } = initialColumns(
      ["id", "name", "born", "notes"],
      { name: { as: "name" }, born: { as: "attribute", property: `${P}birthDate` } },
    );
    expect(columns).toEqual({
      id: { as: "ignore" },
      name: { as: "name" },
      born: { as: "attribute", property: `${P}birthDate` },
      notes: { as: "ignore" },
    });
    expect(suggested).toEqual(["name", "born"]);
  });

  it("keeps an earlier choice over a suggestion, for the columns the file still has", () => {
    const { columns, suggested } = initialColumns(
      ["name", "born"],
      { name: { as: "name" }, born: { as: "attribute", property: `${P}birthDate` } },
      { born: { as: "ignore" }, gone: { as: "name" } },
    );
    expect(columns).toEqual({ name: { as: "name" }, born: { as: "ignore" } });
    expect(suggested).toEqual(["name"]);
  });
});

describe("one name per row", () => {
  it("moves the name from one column to another", () => {
    const before = { a: { as: "name" as const }, b: { as: "ignore" as const } };
    expect(withChoice(before, "b", { as: "name" })).toEqual({ a: { as: "ignore" }, b: { as: "name" } });
  });
});

describe("a choice in a select", () => {
  it("round-trips", () => {
    for (const choice of [
      { as: "ignore" as const },
      { as: "name" as const },
      { as: "attribute" as const, property: `${P}born date` },
      { as: "relationship" as const, property: `${P}memberOf` },
    ]) {
      expect(parseChoice(choiceValue(choice))).toEqual(choice);
    }
    expect(parseChoice(NEW_ATTRIBUTE)).toBe(NEW_ATTRIBUTE);
  });
});

describe("a new attribute's type, from its values (5.4)", () => {
  it("suggests a whole number, a date, or text", () => {
    expect(suggestedType(profile({ wholeNumbers: true, numbers: true }))).toBe("integer");
    expect(suggestedType(profile({ dates: true }))).toBe("date");
    expect(suggestedType(profile({ numbers: true }))).toBe("decimal");
    expect(suggestedType(profile({}))).toBe("text");
  });
});

describe("why Next waits", () => {
  const inspection = { sample: true, kept: 2000, limit: 2000 } as DataInspection;
  it("waits for the sample choice past the limit (5.2)", () => {
    expect(stepBlocked(1, { inspection, options: {}, classIri: null })).toBe(
      "Choose to use the first 2,000 rows, or another file.",
    );
    expect(stepBlocked(1, { inspection, options: { sample: true }, classIri: null })).toBeNull();
    expect(stepBlocked(1, { inspection: null, options: {}, classIri: null })).toBe("Choose a file first.");
  });
  it("waits for what a row is", () => {
    expect(stepBlocked(2, { inspection, options: { sample: true }, classIri: null })).toBe("Choose what each row is.");
    expect(stepBlocked(2, { inspection, options: { sample: true }, classIri: `${P}Person` })).toBeNull();
  });
});
