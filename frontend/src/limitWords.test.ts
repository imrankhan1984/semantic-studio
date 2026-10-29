/*
================================================================================
FILE: frontend/src/limitWords.test.ts
================================================================================

SUMMARY
    Settings → Limits' one rule and its words (home-and-settings 5.4): which
    typed text is a value, the refusal with its range, what a Save sends, and
    what closing asks about.

BASIC IDEA
    Pure functions over LimitSetting records, tested without rendering, as
    networkWords.test.ts does.

INPUTS / INPUT SOURCES
    - limitWords.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { LimitSetting } from "./api";
import {
  administratorLine,
  fieldLabel,
  hasUnsaved,
  limitChanges,
  limitError,
  parseLimit,
  rangeLine,
  shownValue,
} from "./limitWords";

const FILE: LimitSetting = {
  key: "largestFile", name: "Largest file to load", unit: "MB", value: 50, default: 50,
  min: 1, max: 200, source: "default", variables: [],
};
const TIME: LimitSetting = {
  key: "readTime", name: "Longest time to read a file", unit: "s", value: 60, default: 60,
  min: 10, max: 600, source: "settings", variables: [],
};
const DRAW: LimitSetting = {
  key: "firstDrawing", name: "Items drawn when a graph opens", unit: "items", value: 2000, default: 2000,
  min: 100, max: 20000, source: "environment", variables: ["SEMANTIC_STUDIO_GRAPH_NODE_BUDGET"],
};

describe("a typed value (home-and-settings 5.4)", () => {
  it("is a whole number inside the range, ends included", () => {
    expect(parseLimit("1", FILE)).toBe(1);
    expect(parseLimit("200", FILE)).toBe(200);
    expect(parseLimit("75", FILE)).toBe(75);
  });

  it("is refused, never rounded, outside the range or not a whole number", () => {
    for (const text of ["0", "201", "-1", "50.5", "1e2", "", " 50", "50 ", "fifty", "0x10", "Infinity"]) {
      expect(parseLimit(text, FILE)).toBeNull();
      expect(limitError(text, FILE)).toBe("Enter a whole number from 1 to 200 MB.");
    }
    expect(limitError("75", FILE)).toBeNull();
  });

  it("says the range in the limit's words", () => {
    expect(limitError("5", TIME)).toBe("Enter a whole number from 10 to 600 seconds.");
    expect(limitError("5", DRAW)).toBe("Enter a whole number from 100 to 20,000 items.");
  });
});

describe("the words", () => {
  it("label a field by name and unit, and give its default and range", () => {
    expect(fieldLabel(TIME)).toBe("Longest time to read a file (seconds)");
    expect(rangeLine(FILE)).toBe("Default 50 MB. From 1 to 200 MB.");
    expect(rangeLine(DRAW)).toBe("Default 2,000 items. From 100 to 20,000 items.");
  });

  it("name the administrator's variables for a read-only limit", () => {
    expect(administratorLine(DRAW)).toBe("Set by the administrator (SEMANTIC_STUDIO_GRAPH_NODE_BUDGET).");
    expect(shownValue(DRAW)).toBe("2,000 items");
  });
});

describe("what a Save sends", () => {
  it("only the editable limits that changed", () => {
    expect(limitChanges([FILE, TIME, DRAW], {})).toEqual({});
    expect(limitChanges([FILE, TIME, DRAW], { largestFile: "100", readTime: "60" })).toEqual({ largestFile: 100 });
  });

  it("never a limit an environment variable owns, whatever its field says", () => {
    expect(limitChanges([FILE, DRAW], { firstDrawing: "5000" })).toEqual({});
  });

  it("nothing while any editable field is refused", () => {
    expect(limitChanges([FILE, TIME], { largestFile: "100", readTime: "5" })).toBeNull();
  });
});

describe("what closing asks about", () => {
  it("any editable field differing from its saved value, valid or not", () => {
    expect(hasUnsaved([FILE, TIME], {})).toBe(false);
    expect(hasUnsaved([FILE, TIME], { largestFile: "50" })).toBe(false);
    expect(hasUnsaved([FILE, TIME], { largestFile: "500" })).toBe(true);
    expect(hasUnsaved([FILE, TIME], { readTime: "" })).toBe(true);
    expect(hasUnsaved([DRAW], { firstDrawing: "5000" })).toBe(false);
  });
});
