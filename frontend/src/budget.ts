/*
================================================================================
FILE: frontend/src/budget.ts
================================================================================

SUMMARY
    BUDGET_FACTOR: the one allowance every `[budget]` test multiplies its
    millisecond limit by (visual-modeling 5.7, AC-17). The backend's
    tests/budget.py is the same rule for the `perf` tests.

BASIC IDEA
    A limit is measured on a developer's machine. CI's shared runners are
    slower and busier: miniature.test.ts measured 2.40 ms there against its
    2 ms limit on every pull request, and a job that is always red is a job
    nobody reads -- which is how a real regression would later go unseen. So
    the limit stays as measured, and the budgets job sets BUDGET_FACTOR=2 to
    allow for the machine, not the code.

    Only milliseconds are multiplied. A ratio of two timings taken on the same
    machine ("ten times the rows costs at most three times as much") does not
    depend on how fast the machine is, and loosening it would hide exactly the
    scaling it exists to catch.

    Read from process.env without naming Node's types: the tests run in Node,
    and the frontend carries no @types/node for one variable.

INPUTS / INPUT SOURCES
    - The BUDGET_FACTOR environment variable; 1 when unset or not a positive
      number.

EXPECTED OUTPUT
    - BUDGET_FACTOR, and limitMs(), a measured limit scaled by it.
================================================================================
*/

function readFactor(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = Number(env?.BUDGET_FACTOR ?? "1");
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export const BUDGET_FACTOR = readFactor();

/** A budget's limit on this machine: as measured, times the allowance. */
export function limitMs(measured: number): number {
  return measured * BUDGET_FACTOR;
}
