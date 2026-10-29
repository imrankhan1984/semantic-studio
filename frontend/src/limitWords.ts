/*
================================================================================
FILE: frontend/src/limitWords.ts
================================================================================

SUMMARY
    Settings → Limits' words and its one rule (home-and-settings 5.4): what
    each limit changes, its default and range, the administrator's line, the
    refusal under a field, and which typed values a Save sends.

BASIC IDEA
    Kept out of LimitsSettings so the rule can be tested without rendering,
    as networkWords.ts and loadWords.ts are. The range here is the server's,
    as GET /api/settings sends it: the page checks it so Save can wait, and
    the server checks it again, since the page is not the control (Section 9).

    A typed value is text until it is a whole number inside the range. "50.5",
    "1e3", "" and " 7" are refused, not rounded: a number the person did not
    type is never saved for them.

INPUTS / INPUT SOURCES
    - LimitSetting records from api.ts; the field's text.

EXPECTED OUTPUT
    - Sentences, and the changes a Save sends.
================================================================================
*/

import type { LimitKey, LimitSetting } from "./api";

/** One sentence on what each limit changes (5.4's table, in plain words). */
export const WHAT_IT_CHANGES: Record<LimitKey, string> = {
  largestFile: "The largest file you can open from this computer or load from a web address.",
  readTime: "How long reading a file may take before it is stopped.",
  firstDrawing: "How many items a graph draws when it opens. Show more draws the rest.",
};

function unitWord(limit: Pick<LimitSetting, "unit">): string {
  return limit.unit === "s" ? "seconds" : limit.unit;
}

/** The field's label: its name and its unit. */
export function fieldLabel(limit: LimitSetting): string {
  return `${limit.name} (${unitWord(limit)})`;
}

function count(n: number): string {
  return n.toLocaleString("en");
}

/** "Default 50 MB. From 1 to 200 MB." */
export function rangeLine(limit: LimitSetting): string {
  const unit = unitWord(limit);
  return `Default ${count(limit.default)} ${unit}. From ${count(limit.min)} to ${count(limit.max)} ${unit}.`;
}

/** The read-only line for a limit an environment variable owns. */
export function administratorLine(limit: LimitSetting): string {
  return `Set by the administrator (${limit.variables.join(", ")}).`;
}

/** A read-only limit's value, with its unit; both caps when the two size
 *  paths differ (one variable set, the other on the saved value). */
export function shownValue(limit: LimitSetting): string {
  if (limit.byPath) {
    return `${count(limit.byPath.upload)} MB for a file you open, ${count(limit.byPath.fetch)} MB for a web address`;
  }
  return `${count(limit.value)} ${unitWord(limit)}`;
}

const WHOLE = /^[0-9]+$/;

/** The typed text as a number, or null when it is not one inside the range. */
export function parseLimit(text: string, limit: LimitSetting): number | null {
  if (!WHOLE.test(text)) return null;
  const value = Number(text);
  return value >= limit.min && value <= limit.max ? value : null;
}

/** The refusal under a field, or null when the text is a value Save keeps. */
export function limitError(text: string, limit: LimitSetting): string | null {
  if (parseLimit(text, limit) !== null) return null;
  return `Enter a whole number from ${count(limit.min)} to ${count(limit.max)} ${unitWord(limit)}.`;
}

/** Whether a limit may be changed here: no administrator's variable owns it. */
export function editable(limit: LimitSetting): boolean {
  return limit.source !== "environment";
}

/** What a Save sends: each editable limit whose typed value differs from
 *  the saved one. Null when any editable field holds a refused value. */
export function limitChanges(
  limits: LimitSetting[],
  drafts: Partial<Record<LimitKey, string>>,
): Partial<Record<LimitKey, number>> | null {
  const changes: Partial<Record<LimitKey, number>> = {};
  for (const limit of limits) {
    if (!editable(limit)) continue;
    const text = drafts[limit.key] ?? String(limit.value);
    const value = parseLimit(text, limit);
    if (value === null) return null;
    if (value !== limit.value) changes[limit.key] = value;
  }
  return changes;
}

/** Whether any editable field differs from its saved value, valid or not:
 *  what closing asks about. */
export function hasUnsaved(limits: LimitSetting[], drafts: Partial<Record<LimitKey, string>>): boolean {
  return limits.some(
    (limit) => editable(limit) && drafts[limit.key] !== undefined && drafts[limit.key] !== String(limit.value),
  );
}

export const SAVED = "Saved. The new limits apply to the next file you load and the next graph you open.";
export const LEAVE_QUESTION = "Close without saving? The limits you changed are not kept.";
