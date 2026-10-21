/*
================================================================================
FILE: frontend/src/sparql/textQuery.ts
================================================================================

SUMMARY
    The rules behind writing SPARQL as text (spec sparql-text-and-query-files):
    the 100 KB size limit, the text a new query starts with (the prefixes
    the ontology uses, query-page-rework 5.3), the prefix a failed run was
    missing and the one line Add PREFIX writes, the .rq file name for a
    download, and reading a chosen .rq file.

BASIC IDEA
    Kept out of SparqlEditor for the same reason sparql/ exists: each of these
    has a rule in it, and a rule is cheaper to test without rendering. None of
    them touches the network. A file is read in the browser and nothing is
    sent until the user runs or saves the query.

    The size limit is counted in UTF-8 bytes, the unit a file's size comes in.
    The server counts characters against the same 102,400, and a character is
    never fewer than one byte, so anything accepted here is accepted there.

INPUTS / INPUT SOURCES
    - Query text, the query schema's `prefixes`, a server error sentence,
      a query name, a File.

EXPECTED OUTPUT
    - Strings, byte counts, and a read result that is either the file's text
      or the sentence saying why it was not opened.
================================================================================
*/

/** The same 100 KB the server holds query text to. */
export const MAX_QUERY_BYTES = 100 * 1024;

export const TOO_LARGE_TO_RUN =
  "This query is larger than the 100 KB limit, so it was not run.";
export const TOO_LARGE_TO_OPEN =
  "This file is larger than the 100 KB limit for a query, so it was not opened.";
export const NOT_UTF8 = "This file is not UTF-8 text, so it was not opened.";

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The help line under the editor of a new text query (query-page-rework
 *  5.3): visible, as it says what is already in the box. */
export const STARTED_HELP =
  "The prefixes this ontology uses are already at the top. Ctrl+Enter runs the query.";
export const RUN_HELP = "Ctrl+Enter runs the query.";

/**
 * What a new text query starts with: one PREFIX line for each namespace the
 * ontology uses, as the server lists them (the schema's `prefixes`, sorted),
 * then a blank line, the caret going at the end. Nothing else: the starter
 * comment it replaces said the prefixes were "available below", which was
 * only half true (query-page-rework 5.3).
 */
export function startingText(prefixes: Record<string, string> | undefined): string {
  const lines = Object.entries(prefixes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, ns]) => `PREFIX ${prefix}: <${ns}>`);
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

/**
 * The prefix a failed run was missing, read from the server's sentence
 * ("Unknown namespace prefix : space"), or null for any other failure. The
 * empty prefix (`:Term`) comes back as "": many ontologies bind `:`.
 * Read with indexOf and a fixed pattern after it, never a RegExp built from
 * the text: the message carries what the person typed.
 */
export function unknownPrefix(error: string | null): string | null {
  if (!error) return null;
  const marker = "Unknown namespace prefix";
  const at = error.indexOf(marker);
  if (at < 0) return null;
  const match = /^\s*:\s*([A-Za-z][\w.-]*)?/.exec(error.slice(at + marker.length));
  return match ? match[1] ?? "" : null;
}

/**
 * The text with one `PREFIX p: <ns>` line added, after any leading comment
 * lines and before everything else: what Add PREFIX does to a query that
 * came from a file, a saved query or the ontology (5.3), which otherwise
 * open exactly as written.
 */
export function addPrefixLine(text: string, prefix: string, ns: string): string {
  const all = text.split("\n");
  let at = 0;
  while (at < all.length && /^\s*#/.test(all[at])) at += 1;
  return [...all.slice(0, at), `PREFIX ${prefix}: <${ns}>`, ...all.slice(at)].join("\n");
}

/**
 * `<name>.rq`, with anything a file system would refuse replaced. The name is
 * the user's, or a label read from the ontology, so it is untrusted: a `/`
 * in it must not become a folder.
 */
export function rqFileName(name: string | null | undefined): string {
  const base = (name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 100);
  return `${base || "query"}.rq`;
}

/** The query name a chosen file gives: its name without the extension. */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.(rq|sparql|txt)$/i, "") || fileName;
}

export type ReadResult = { ok: true; name: string; text: string } | { ok: false; error: string };

/**
 * A chosen .rq file as text, or why not. The size is checked before a byte is
 * read, and the bytes are decoded strictly, so a binary file picked by mistake
 * is refused with a sentence rather than opened as noise.
 */
export async function readQueryFile(file: File): Promise<ReadResult> {
  if (file.size > MAX_QUERY_BYTES) return { ok: false, error: TOO_LARGE_TO_OPEN };
  let text: string;
  try {
    const bytes = await file.arrayBuffer();
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: NOT_UTF8 };
  }
  return { ok: true, name: nameFromFile(file.name), text: text.replace(/^﻿/, "") };
}
