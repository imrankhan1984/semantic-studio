/*
================================================================================
FILE: frontend/src/budget.test.ts
================================================================================

SUMMARY
    AC-17: the timing budgets read BUDGET_FACTOR, default 1.

BASIC IDEA
    The module reads the variable once, when it is imported, so each case
    stubs the environment and imports a fresh copy.

INPUTS / INPUT SOURCES
    - budget.ts, under a stubbed process.env.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { afterEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  return import("./budget");
}

describe("BUDGET_FACTOR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is 1 when unset, so a limit is as measured", async () => {
    vi.stubEnv("BUDGET_FACTOR", undefined);
    const budget = await fresh();
    expect(budget.BUDGET_FACTOR).toBe(1);
    expect(budget.limitMs(2)).toBe(2);
  });

  it("scales every millisecond limit when set, as the CI budgets job sets it", async () => {
    vi.stubEnv("BUDGET_FACTOR", "2");
    const budget = await fresh();
    expect(budget.limitMs(2)).toBe(4);
  });

  it.each(["0", "-1", "fast", "Infinity"])("ignores %j and keeps 1", async (value) => {
    vi.stubEnv("BUDGET_FACTOR", value);
    expect((await fresh()).BUDGET_FACTOR).toBe(1);
  });
});
