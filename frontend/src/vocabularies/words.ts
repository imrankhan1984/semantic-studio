/*
================================================================================
FILE: frontend/src/vocabularies/words.ts
================================================================================

SUMMARY
    The words of the Edit page's Vocabularies section and of Add a
    vocabulary… (vocabularies-and-ontologies 5.2, 5.3, 5.8): a row's status
    and source, how many statements use it, which actions its menu offers,
    the dialog's tabs, and the sentences the dialog and the live region say.

BASIC IDEA
    Pure, so the rules are tested without rendering (the repository's split
    for anything with a rule in it). Every status is a word, never a colour
    (AC-2, AC-17): *Added · imported*, *Added · terms reused*, *Used, not
    added*, *Not found*; an imported vocabulary whose copy is not in the
    merged view says *not loaded*, and one whose own imports wait for a
    host says how many files are still to load. The source column is the
    server's name for it, and a web copy's date beside it.

    Which actions a row offers follows its status: Add on a vocabulary used
    but not added, Add from a file or address on one not found, Remove on
    an added one, *Load its copy* on an import not loaded or waiting (5.2's
    Load, never a bare *Load*: wording 5.1 keeps that name off every
    control), Show in Turtle on every row. A read-only document keeps every action in the menu, Add and
    Remove disabled with the reason, never hidden.

INPUTS / INPUT SOURCES
    - VocabularyRow and VocabularySource, from api.ts's getVocabularies.

EXPECTED OUTPUT
    - Strings and the row menu's items.
================================================================================
*/

import type { VocabularyRow, VocabularySource } from "../types";

export const READ_ONLY = "This document is read-only.";
export const LIST_FAILED = "The vocabularies could not be read. Try again.";
export const READING_LIST = "Reading vocabularies…";
export const OFFLINE =
  "Semantic Studio is offline. Turn it on in Settings → Network to add from an address.";

/** The row's status in words (5.2). */
export function statusWord(row: VocabularyRow): string {
  if (row.status === "used") return "Used, not added";
  if (row.status === "notFound") return "Not found";
  if (row.how === "reused") return "Added · terms reused";
  if (!row.loaded) return "Added · imported, not loaded";
  if (row.pending > 0) return `Added · imported, ${filesWord(row.pending)} still to load`;
  return "Added · imported";
}

function filesWord(n: number): string {
  return n === 1 ? "1 file" : `${n.toLocaleString()} files`;
}

/** 7 Nov 2026: a web copy's date, as the source column says it. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The source column (5.2): *Bundled*, *Your library: Pumps*, *File: team.ttl*,
 *  *Web: example.org, 7 Nov 2026*; nothing for a namespace no source has. */
export function sourceWord(source: VocabularySource | null): string {
  if (!source) return "";
  if (source.kind === "bundled") return "Bundled";
  if (source.kind === "web" && source.fetchedAt) {
    const when = shortDate(source.fetchedAt);
    return when ? `${source.name}, ${when}` : source.name;
  }
  return source.name;
}

/** *12 statements use its terms* (5.2). */
export function usesWord(n: number): string {
  if (n === 0) return "No statement uses its terms";
  return n === 1 ? "1 statement uses its terms" : `${n.toLocaleString()} statements use its terms`;
}

export type VocabularyAction = "add" | "addFrom" | "remove" | "load" | "turtle";

/** The row menu (5.2), in order. */
export function rowActions(
  row: VocabularyRow,
  readOnly = false,
): { action: VocabularyAction; label: string; disabled?: string }[] {
  const off = readOnly ? READ_ONLY : undefined;
  const items: { action: VocabularyAction; label: string; disabled?: string }[] = [];
  if (row.status === "used") items.push({ action: "add", label: "Add…", disabled: off });
  if (row.status === "notFound") items.push({ action: "addFrom", label: "Add from a file or address…", disabled: off });
  if (row.status === "added" && row.how === "imported" && (!row.loaded || row.pending > 0)) {
    // Not a bare *Load*, the old Load button's name (wording 5.1).
    items.push({ action: "load", label: "Load its copy" });
  }
  if (row.status === "added") items.push({ action: "remove", label: "Remove", disabled: off });
  items.push({ action: "turtle", label: "Show in Turtle" });
  return items;
}

/** What a row is read as by a screen reader: every column, in words. */
export function rowName(row: VocabularyRow): string {
  const parts = [row.title];
  if (row.prefix) parts.push(`prefix ${row.prefix}`);
  parts.push(statusWord(row));
  const source = sourceWord(row.source);
  if (source) parts.push(source);
  parts.push(usesWord(row.uses));
  return parts.join(", ");
}

/** The line that adds a row's vocabulary, to open the Turtle editor on (5.2). */
export function turtleNeedle(row: VocabularyRow): string {
  if (row.status === "added" && row.prefix && row.how === "reused") return `${row.prefix}:`;
  return row.iri;
}

export type SourceTab = "bundled" | "library" | "file" | "web";

export const TABS: { id: SourceTab; label: string }[] = [
  { id: "bundled", label: "Bundled" },
  { id: "library", label: "Your library" },
  { id: "file", label: "File" },
  { id: "web", label: "Web address" },
];

/** The dialog's tab for a row's Add (5.2): its own source, or File. */
export function tabFor(row: VocabularyRow | null): SourceTab {
  if (!row || row.status === "notFound" || !row.source) return row ? "file" : "bundled";
  return row.source.kind;
}

/** *Reading PROV-O…* while inspect is on its way. */
export function readingWord(name: string): string {
  return `Reading ${name}…`;
}

/** What the live region says once Add has worked (5.3). */
export function addedWords(sentence: string): string {
  return `Added. ${sentence}`;
}

/** The prefix rule the server holds a typed one to (projects.PREFIX). */
export function validPrefix(prefix: string): boolean {
  return /^[A-Za-z]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/.test(prefix);
}

/** A typed address worth sending: http or https, with a host. */
export function validAddress(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
