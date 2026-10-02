/*
================================================================================
FILE: frontend/src/modeling/dataSentences.ts
================================================================================

SUMMARY
    The words the data import says (csv-data-import 5.2 to 5.7): the label
    every place puts on snapshot data (*from people.csv, imported 2 October
    2026; sample: first 2,000 of 12,480 rows*), the preview's rows as
    sentences (*Bob is a Person. Bob's birth date is "yesterday" — not a
    date, kept as text.*), the import report's lines, the identifier
    check, and the one word a snapshot's row gives its report.

BASIC IDEA
    The learner's safeguard (Section 7) is that bad data is shown and
    snapshot data is never mistaken for the model, and both are sentences,
    so they are built here once and tested without rendering. Every value
    is the server's text, put into a sentence as text: nothing is read as
    markup or used as a pattern.

    The sample is part of the label itself, never a separate badge, so no
    place can show where data came from and forget that it is a sample
    (5.6, AC-6).

    Dates are written in words with a fixed month list, not the browser's
    locale, so "2 October 2026" reads the same everywhere and in tests.

INPUTS / INPUT SOURCES
    - DataSource, PreviewRow, ImportReportData and IdCheck, as the server
      sends them.

EXPECTED OUTPUT
    - dataLabel, sampleWords, importedOn, rowList, previewSentences,
      reportLines, reportWord, idProblems, typeWord.
================================================================================
*/

import { plural } from "./shapeSentences";
import type { DataSource, IdCheck, ImportReportData, PreviewRow, RowList } from "../types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const count = (n: number) => n.toLocaleString("en-US");

/** "2 October 2026", in the browser's own time zone. */
export function importedOn(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "sample: first 2,000 of 12,480 rows", or null for a whole file. */
export function sampleWords(source: Pick<DataSource, "rows" | "total" | "sample">): string | null {
  return source.sample ? `sample: first ${count(source.rows)} of ${count(source.total)} rows` : null;
}

/** The label snapshot data carries everywhere it is shown (5.6). */
export function dataLabel(source: Pick<DataSource, "source" | "importedAt" | "rows" | "total" | "sample">): string {
  const label = `from ${source.source}, imported ${importedOn(source.importedAt)}`;
  const sample = sampleWords(source);
  return sample ? `${label}; ${sample}` : label;
}

/** "row 7", "rows 2 and 4", "rows 7, 19, 230 and 11 more". */
export function rowList(list: RowList): string {
  const shown = list.rows.map(count);
  const more = list.count - list.rows.length;
  if (shown.length === 0) return "";
  if (shown.length === 1 && more === 0) return `row ${shown[0]}`;
  if (more > 0) return `rows ${shown.join(", ")} and ${count(more)} more`;
  return `rows ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// What a value that does not fit was supposed to be.
const TYPE_WORDS: Record<string, [string, string]> = {
  date: ["a date", "dates"],
  dateTime: ["a date and time", "dates and times"],
  integer: ["a whole number", "whole numbers"],
  decimal: ["a number", "numbers"],
  double: ["a number", "numbers"],
  float: ["a number", "numbers"],
  boolean: ["true or false", "true or false"],
  gYear: ["a year", "years"],
};

/** "a date" (one), or "dates" (many), for an XML Schema type's short name. */
export function typeWord(datatype: string | null | undefined, many = false): string {
  const words = TYPE_WORDS[datatype ?? ""] ?? [`a ${datatype ?? "value of its type"}`, `${datatype ?? "values of the type"}`];
  return many ? words[1] : words[0];
}

function quoted(value: string): string {
  return `"${value}"`;
}

/** Step 4's preview: one row read as sentences, in the model's names. */
export function previewSentences(row: PreviewRow, className: string): string[] {
  if (row.skipped || !row.subject) {
    return [`Row ${count(row.row)} has no id, so nothing is made from it.`];
  }
  const who = row.name ?? `Row ${count(row.row)}`;
  const sentences = [`${who} is ${/^[aeiou]/i.test(className) ? "an" : "a"} ${className}.`];
  for (const value of row.values) {
    if (value.kind === "link") {
      sentences.push(`${who}'s ${value.label}: the one with id ${quoted(value.value)}.`);
    } else if (value.fits === false) {
      sentences.push(
        `${who}'s ${value.label} is ${quoted(value.value)} — not ${typeWord(value.datatype)}, kept as text.`,
      );
    } else if (value.datatype) {
      sentences.push(`${who}'s ${value.label} is ${value.value}.`);
    } else {
      sentences.push(`${who}'s ${value.label} is ${quoted(value.value)}.`);
    }
  }
  return sentences;
}

function rows(n: number): string {
  return n === 1 ? "1 row" : `${count(n)} rows`;
}

/** The import report's lines (5.5), in order. `source` adds the sample's
 *  words to the first line when the file was cut. */
export function reportLines(
  report: ImportReportData,
  className: string,
  source?: Pick<DataSource, "rows" | "total" | "sample">,
): string[] {
  const made = report.individuals === 1 ? `1 ${className}` : `${count(report.individuals)} ${plural(className)}`;
  const sample = sampleWords(source ?? { rows: report.rowsRead, total: report.total, sample: report.sample });
  const lines = [`${rows(report.rowsRead)}, ${made}${sample ? ` (${sample})` : ""}`];
  if (report.skipped.count) {
    lines.push(`${rows(report.skipped.count)} without an id (${rowList(report.skipped)})`);
  }
  if (report.repeated.count) {
    lines.push(
      `${rows(report.repeated.count)} repeat an id already used, so they add to that individual (${rowList(report.repeated)})`,
    );
  }
  for (const kept of report.keptAsText) {
    const values = kept.count === 1 ? "1 value is not" : `${count(kept.count)} values are not`;
    lines.push(`${kept.column}: ${values} ${typeWord(kept.datatype, kept.count !== 1)}, kept as text (${rowList(kept)})`);
  }
  for (const empty of report.empty) {
    lines.push(`${empty.column}: ${count(empty.count)} empty, nothing written`);
  }
  if (report.clean) lines.push("Every row has an id and every value fits its type.");
  return lines;
}

/** The word a snapshot's row gives its report (5.7): "clean", or what is not. */
export function reportWord(report: ImportReportData): string {
  const kept = report.keptAsText.reduce((sum, k) => sum + k.count, 0);
  const parts: string[] = [];
  if (kept) parts.push(kept === 1 ? "1 value kept as text" : `${count(kept)} values kept as text`);
  if (report.skipped.count) parts.push(`${rows(report.skipped.count)} without an id`);
  if (report.repeated.count) parts.push(`${rows(report.repeated.count)} repeating an id`);
  return parts.length ? parts.join(", ") : "clean";
}

/** Step 2's check of the identifier column, as sentences (5.3). */
export function idProblems(check: IdCheck): string[] {
  const out: string[] = [];
  if (check.missing.count) {
    const have = check.missing.count === 1 ? "1 row has" : `${count(check.missing.count)} rows have`;
    out.push(`${have} no ${check.column} (${rowList(check.missing)}).`);
  }
  if (check.repeats) {
    const values = check.repeats === 1 ? "1 value repeats" : `${count(check.repeats)} values repeat`;
    out.push(`${check.column} is not unique: ${values} (${rowList(check.repeated)}).`);
  }
  return out;
}
