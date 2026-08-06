/*
================================================================================
FILE: frontend/src/sparql/exportResults.ts
================================================================================

SUMMARY
    Turns a SparqlResults the client already holds into a downloadable file, in
    two standard shapes: the W3C SPARQL 1.1 Query Results CSV format and the W3C
    SPARQL 1.1 Query Results JSON format. Pure functions — data in, string out —
    so the CSV-quoting and the formula-injection rules are proved without
    rendering. Backlog Q-2.

BASIC IDEA
    The rows are already in the browser (execute_select returns the whole result
    set up to the server's 1,000-row cap), so export is entirely client-side:
    no endpoint, no round trip, no second path to the same rows.

    CSV follows RFC 4180 — one column per variable, a header of variable names,
    fields quoted when they contain a quote/comma/newline — over the DATA form of
    each cell (full IRI, lexical value, `_:` blank-node label), because a
    developer opening the file in a spreadsheet needs the identifier, not the
    display label.

    The one rule here that is a security control, not a formatting choice:
    **formula-injection neutralization** (AC-5). A CSV cell is ontology-derived
    text an attacker who authored the ontology controls, and a spreadsheet reads
    a cell beginning `=`, `+`, `-`, `@` (or a leading tab / carriage return) as a
    FORMULA — so a hostile label could execute when the user opens the file under
    their own account. Every field whose first character is one of those is
    prefixed with a single apostrophe before RFC 4180 quoting, the
    OWASP-recommended mitigation: the value is preserved and visible, only its
    interpretation as a formula is removed. This is the CSV analogue of the
    documentation export's stored-XSS path (docs_export AC-9). JSON carries no
    such risk — it is data a consumer parses, never executes — so nothing is
    neutralized there; applying the prefix to JSON would corrupt the values.

INPUTS / INPUT SOURCES
    - A SparqlResults ({vars, rows, rowCount, truncated, durationMs}); each cell
      is a SparqlTerm or null (an unbound OPTIONAL variable).

EXPECTED OUTPUT
    - toCsv(results) -> a CSV string (RFC 4180, CRLF line terminator).
    - toJson(results) -> a W3C SPARQL Results JSON string.
    - resultsFilename(name, ext) -> the download filename.
================================================================================
*/

import type { SparqlResults, SparqlTerm } from "../types";

/**
 * A cell as its DATA value for CSV: the full IRI for a URI, `_:`+label for a
 * blank node, the lexical value for a literal (or the defensive `unknown`), and
 * an empty field for an unbound cell (AC-2 / AC-3).
 */
export function csvField(term: SparqlTerm | null): string {
  if (term === null) return "";
  if (term.type === "uri") return term.value;
  if (term.type === "bnode") return `_:${term.value}`;
  return term.value;
}

/**
 * The characters a spreadsheet treats as the start of a formula. Tab and
 * carriage return are included because some spreadsheets strip leading
 * whitespace and then read the next character as a formula trigger.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralize a spreadsheet formula trigger (AC-5, the load-bearing rule). A
 * field whose first character would make a spreadsheet evaluate it is prefixed
 * with a single apostrophe, which a spreadsheet reads as "this is text". The
 * original value is unchanged after that apostrophe, so nothing is lost.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/**
 * One CSV field: neutralize a formula trigger FIRST, then apply RFC 4180 quoting
 * if the (neutralized) value contains a quote, comma or line break. Order
 * matters — neutralizing after quoting would leave a `"`-wrapped `=…` that some
 * spreadsheets still evaluate.
 */
function csvField4180(value: string): string {
  const neutral = neutralizeFormula(value);
  if (/[",\r\n]/.test(neutral)) {
    return `"${neutral.replace(/"/g, '""')}"`;
  }
  return neutral;
}

/** A variable name without its leading `?`, for a header cell or a JSON key. */
function bareVar(name: string): string {
  return name.replace(/^\?/, "");
}

/**
 * The result set as W3C SPARQL Results CSV (RFC 4180). Header row of variable
 * names (no leading `?`), then one row per result in `vars` order, `\r\n`
 * terminated so Excel on every platform reads it cleanly. The header is NOT
 * formula-neutralized: variable names come from the query builder, not from the
 * ontology, so they are not attacker-influenced — only the data cells are.
 */
export function toCsv(results: SparqlResults): string {
  const header = results.vars.map((v) => csvField4180(bareVar(v))).join(",");
  const lines = [header];
  for (const row of results.rows) {
    lines.push(results.vars.map((_v, i) => csvField4180(csvField(row[i] ?? null))).join(","));
  }
  return lines.join("\r\n");
}

/** The `type` a JSON binding carries. `unknown` is treated as a literal, which
 *  is inert to any consumer and matches the defensive CSV rendering. */
function jsonType(term: SparqlTerm): "uri" | "literal" | "bnode" {
  if (term.type === "uri") return "uri";
  if (term.type === "bnode") return "bnode";
  return "literal";
}

/**
 * The result set as W3C SPARQL Results JSON:
 *   {"head":{"vars":[...]}, "results":{"bindings":[...]}}
 * one binding object per row keyed by variable name, each value carrying `type`
 * and `value` and — for a literal — `xml:lang` or `datatype` when present. An
 * unbound variable is OMITTED from its binding, as the standard requires (AC-7).
 *
 * `datatype` is carried in the prefixed form the client holds (e.g. `xsd:string`)
 * rather than the strict full IRI — a recorded deviation (spec Open Question 2)
 * that keeps Q-2 client-only; a consumer needing strict compliance is a later
 * backend change to send the full datatype IRI.
 */
export function toJson(results: SparqlResults): string {
  const bindings = results.rows.map((row) => {
    const binding: Record<string, Record<string, string>> = {};
    results.vars.forEach((v, i) => {
      const term = row[i] ?? null;
      if (term === null) return; // unbound: omit the variable entirely
      const entry: Record<string, string> = {
        type: jsonType(term),
        // A blank node's JSON value is the bare label, without the `_:` the CSV
        // form prefixes; a URI is its IRI; a literal is its lexical value.
        value: term.value,
      };
      if (term.type === "literal") {
        if (term.lang) entry["xml:lang"] = term.lang;
        else if (term.datatype) entry.datatype = term.datatype;
      }
      binding[bareVar(v)] = entry;
    });
    return binding;
  });
  const doc = {
    head: { vars: results.vars.map(bareVar) },
    results: { bindings },
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * The download filename: `<slug(ontology-name)>-results.<ext>`, falling back to
 * `results.<ext>` when no usable name survives slugging. The ontology name is
 * user- or file-supplied, so it is reduced to characters that are legal and
 * safe in a filename, matching the documentation export's own filename rule.
 */
export function resultsFilename(ontologyName: string | undefined | null, ext: "csv" | "json"): string {
  const slug = (ontologyName ?? "")
    .replace(/\.[A-Za-z0-9]+$/, "") // drop a trailing file extension on the name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug ? `${slug}-results.${ext}` : `results.${ext}`;
}
