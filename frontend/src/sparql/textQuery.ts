/*
================================================================================
FILE: frontend/src/sparql/textQuery.ts
================================================================================

SUMMARY
    The rules behind writing SPARQL as text (spec sparql-text-and-query-files):
    the 100 KB size limit, the starter comment, inserting PREFIX lines, the
    .rq file name for a download, and reading a chosen .rq file.

BASIC IDEA
    Kept out of SparqlEditor for the same reason sparql/ exists: each of these
    has a rule in it, and a rule is cheaper to test without rendering. None of
    them touches the network. A file is read in the browser and nothing is
    sent until the user runs or saves the query.

    The size limit is counted in UTF-8 bytes, the unit a file's size comes in.
    The server counts characters against the same 102,400, and a character is
    never fewer than one byte, so anything accepted here is accepted there.

INPUTS / INPUT SOURCES
    - Query text, the query schema's prefix map, a query name, a File.

EXPECTED OUTPUT
    - Strings, byte counts, and a read result that is either the file's text
      or the sentence saying why it was not opened.
================================================================================
*/

/** The same 100 KB the server holds query text to. */
export const MAX_QUERY_BYTES = 100 * 1024;

export const STARTER_COMMENT =
  "# Write a SELECT query. Prefixes from this ontology are available below.\n";

export const TOO_LARGE_TO_RUN =
  "This query is larger than the 100 KB limit, so it was not run.";
export const TOO_LARGE_TO_OPEN =
  "This file is larger than the 100 KB limit for a query, so it was not opened.";
export const NOT_UTF8 = "This file is not UTF-8 text, so it was not opened.";

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Prefixes rdflib 7 binds into every graph whether or not the file mentions
 * them. The query schema carries a graph's bindings as they are, so without
 * this a space-exploration ontology offered `brick:`, `sosa:` and twenty more
 * -- measured in Chrome, 30 lines for a file that declares 5. The four core
 * vocabularies are not listed: every ontology can use those.
 */
const RDFLIB_DEFAULTS: Record<string, string> = {
  brick: "https://brickschema.org/schema/Brick#",
  csvw: "http://www.w3.org/ns/csvw#",
  dc: "http://purl.org/dc/elements/1.1/",
  dcam: "http://purl.org/dc/dcam/",
  dcat: "http://www.w3.org/ns/dcat#",
  dcmitype: "http://purl.org/dc/dcmitype/",
  dcterms: "http://purl.org/dc/terms/",
  doap: "http://usefulinc.com/ns/doap#",
  foaf: "http://xmlns.com/foaf/0.1/",
  geo: "http://www.opengis.net/ont/geosparql#",
  odrl: "http://www.w3.org/ns/odrl/2/",
  org: "http://www.w3.org/ns/org#",
  prof: "http://www.w3.org/ns/dx/prof/",
  prov: "http://www.w3.org/ns/prov#",
  qb: "http://purl.org/linked-data/cube#",
  schema: "https://schema.org/",
  sh: "http://www.w3.org/ns/shacl#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  sosa: "http://www.w3.org/ns/sosa/",
  ssn: "http://www.w3.org/ns/ssn/",
  time: "http://www.w3.org/2006/time#",
  vann: "http://purl.org/vocab/vann/",
  void: "http://rdfs.org/ns/void#",
  wgs: "https://www.w3.org/2003/01/geo/wgs84_pos#",
  xml: "http://www.w3.org/XML/1998/namespace",
};

/**
 * The text with a PREFIX line added for every namespace the ontology declares
 * and the text does not. Added after any leading comment lines, so the
 * starter comment stays on top, and before everything else.
 *
 * A binding identical to one of rdflib's defaults cannot be told apart from
 * one the file declared, so it is added only when the text already uses the
 * prefix: a file that declares `skos:` and a query that says `skos:Concept`
 * get the line, and nobody gets `brick:` for nothing.
 */
export function insertPrefixes(text: string, namespaces: Record<string, string>): string {
  const declared = new Set<string>();
  for (const match of text.matchAll(/^\s*PREFIX\s+([A-Za-z][\w.-]*)?:/gim)) {
    declared.add(match[1] ?? "");
  }
  const used = (prefix: string) => new RegExp(`(^|[^\\w.-])${prefix}:`).test(text);
  const lines = Object.entries(namespaces)
    .filter(([prefix]) => !declared.has(prefix))
    .filter(([prefix, ns]) => RDFLIB_DEFAULTS[prefix] !== ns || used(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, ns]) => `PREFIX ${prefix}: <${ns}>`);
  if (lines.length === 0) return text;

  const all = text.split("\n");
  let at = 0;
  while (at < all.length && /^\s*#/.test(all[at])) at += 1;
  return [...all.slice(0, at), ...lines, ...all.slice(at)].join("\n");
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
