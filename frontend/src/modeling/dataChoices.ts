/*
================================================================================
FILE: frontend/src/modeling/dataChoices.ts
================================================================================

SUMMARY
    The data wizard's rules for its choices (csv-data-import 5.2 to 5.4):
    what each column starts as, one column at most as the name, how a
    choice is written in a select, the type a new attribute is suggested
    from its values, and why Next cannot be pressed yet.

BASIC IDEA
    One decision per step, and suggestions never applied silently (Section
    7): a column the server suggests starts at that choice and is marked
    *suggested*; every other column starts at Ignore. A choice the learner
    made earlier -- a snapshot's stored mapping, kept through a refresh
    whose headers changed -- wins over a suggestion, for every column the
    new file still has.

    Kept out of the component so the rules are tested without rendering,
    as dataSentences.ts is for the words.

INPUTS / INPUT SOURCES
    - The server's inspection (column profiles) and preview (suggestions).

EXPECTED OUTPUT
    - initialColumns, withChoice, choiceValue, parseChoice, suggestedType,
      NEW_TYPES, stepBlocked.
================================================================================
*/

import type { ColumnChoice, ColumnProfile, DataInspection, DataOptions } from "../types";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const LANG_STRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/** The select value that opens the inline New attribute form. */
export const NEW_ATTRIBUTE = "new";

/** The types a new attribute can have, as the attribute form offers them. */
export const NEW_TYPES: { key: string; label: string; datatype: string }[] = [
  { key: "text", label: "Text", datatype: LANG_STRING },
  { key: "integer", label: "Whole number", datatype: `${XSD}integer` },
  { key: "decimal", label: "Number", datatype: `${XSD}decimal` },
  { key: "date", label: "Date", datatype: `${XSD}date` },
  { key: "dateTime", label: "Date and time", datatype: `${XSD}dateTime` },
  { key: "boolean", label: "True or false", datatype: `${XSD}boolean` },
  { key: "string", label: "Text without a language", datatype: `${XSD}string` },
];

/** A new attribute's type, suggested from its column's values (5.4): all
 *  whole numbers make an integer, all dates a date. */
export function suggestedType(profile: ColumnProfile | undefined): string {
  if (!profile) return "text";
  if (profile.wholeNumbers) return "integer";
  if (profile.dates) return "date";
  if (profile.dateTimes) return "dateTime";
  if (profile.numbers) return "decimal";
  return "text";
}

/** What each column starts as, and which of those were suggested. */
export function initialColumns(
  columns: string[],
  suggestions: Record<string, ColumnChoice>,
  previous?: Record<string, ColumnChoice> | null,
): { columns: Record<string, ColumnChoice>; suggested: string[] } {
  const out: Record<string, ColumnChoice> = {};
  const suggested: string[] = [];
  for (const column of columns) {
    const earlier = previous?.[column];
    if (earlier) out[column] = earlier;
    else if (suggestions[column]) {
      out[column] = suggestions[column];
      suggested.push(column);
    } else out[column] = { as: "ignore" };
  }
  return { columns: withOneName(out), suggested };
}

function withOneName(columns: Record<string, ColumnChoice>): Record<string, ColumnChoice> {
  let named = false;
  const out: Record<string, ColumnChoice> = {};
  for (const [column, choice] of Object.entries(columns)) {
    if (choice.as === "name") {
      out[column] = named ? { as: "ignore" } : choice;
      named = true;
    } else out[column] = choice;
  }
  return out;
}

/** One column's new choice. A second column made the name takes the name
 *  from the first, which goes back to Ignore: a row has one name. */
export function withChoice(
  columns: Record<string, ColumnChoice>,
  column: string,
  choice: ColumnChoice,
): Record<string, ColumnChoice> {
  const out: Record<string, ColumnChoice> = {};
  for (const [name, current] of Object.entries(columns)) {
    out[name] = choice.as === "name" && current.as === "name" ? { as: "ignore" } : current;
  }
  out[column] = choice;
  return out;
}

/** A choice as a select's value. */
export function choiceValue(choice: ColumnChoice | undefined): string {
  if (!choice || choice.as === "ignore") return "ignore";
  if (choice.as === "name") return "name";
  return `${choice.as} ${choice.property ?? ""}`;
}

/** A select's value as a choice, or NEW_ATTRIBUTE. */
export function parseChoice(value: string): ColumnChoice | typeof NEW_ATTRIBUTE {
  if (value === NEW_ATTRIBUTE) return NEW_ATTRIBUTE;
  if (value === "name") return { as: "name" };
  const at = value.indexOf(" ");
  if (at > 0) {
    const as = value.slice(0, at);
    if (as === "attribute" || as === "relationship") return { as, property: value.slice(at + 1) };
  }
  return { as: "ignore" };
}

/** Why Next cannot be pressed on a step, or null when it can (Section 6). */
export function stepBlocked(
  step: number,
  state: { inspection: DataInspection | null; options: DataOptions; classIri: string | null },
): string | null {
  if (step === 1) {
    if (!state.inspection) return "Choose a file first.";
    if (state.inspection.sample && !state.options.sample) {
      return `Choose to use the first ${state.inspection.limit.toLocaleString("en-US")} rows, or another file.`;
    }
    if (state.inspection.kept === 0) return "This file has no rows to import.";
  }
  if (step === 2 && !state.classIri) return "Choose what each row is.";
  return null;
}
