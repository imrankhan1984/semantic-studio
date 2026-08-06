/*
================================================================================
FILE: frontend/src/sparql/exportResults.test.ts
================================================================================

SUMMARY
    Tests the pure export module (Q-2): CSV and JSON serialization of a
    SparqlResults. The one that matters most is the formula-injection test
    (AC-5): a cell beginning `=`, `+`, `-` or `@` must be neutralized before it
    can reach a spreadsheet as a formula, and the raw value must NOT appear
    unprefixed. The rest prove the RFC 4180 quoting and the W3C JSON shape.

BASIC IDEA
    Hand-built SparqlResults objects, data in / string out, no rendering and no
    network. The CSV assertions read the produced lines; the JSON assertions
    parse the produced string and inspect the object.

INPUTS / INPUT SOURCES
    - Synthetic SparqlResults built in this file.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-9.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { csvField, neutralizeFormula, resultsFilename, toCsv, toJson } from "./exportResults";
import type { SparqlResults, SparqlTerm } from "../types";

const uri = (value: string, label?: string): SparqlTerm => ({ type: "uri", value, label });
const lit = (value: string, extra: Partial<SparqlTerm> = {}): SparqlTerm => ({
  type: "literal",
  value,
  ...extra,
});
const bnode = (value: string): SparqlTerm => ({ type: "bnode", value });

function results(vars: string[], rows: (SparqlTerm | null)[][], truncated = false): SparqlResults {
  return { vars, rows, rowCount: rows.length, truncated, durationMs: 5 };
}

function csvLines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("toCsv", () => {
  it("csv has a header row of variable names", () => {
    // AC-1: variable names in vars order, no leading ?.
    const csv = toCsv(results(["s", "label"], []));
    expect(csvLines(csv)[0]).toBe("s,label");
  });

  it("strips a leading ? from a variable name in the header", () => {
    // The header is the bare name even if a var arrived with its ? (AC-1).
    expect(csvLines(toCsv(results(["?s", "?n"], [])))[0]).toBe("s,n");
  });

  it("csv renders uri as full iri, literal as lexical, bnode as _:label", () => {
    // AC-2.
    const csv = toCsv(
      results(
        ["s", "v", "b"],
        [[uri("http://example.org/Earth", "Earth"), lit("Earth"), bnode("b0")]],
      ),
    );
    expect(csvLines(csv)[1]).toBe("http://example.org/Earth,Earth,_:b0");
  });

  it("csv leaves an unbound cell empty", () => {
    // AC-3.
    const csv = toCsv(results(["s", "opt"], [[uri("http://example.org/x"), null]]));
    expect(csvLines(csv)[1]).toBe("http://example.org/x,");
  });

  it("csv quotes fields with comma, quote or newline per rfc 4180", () => {
    // AC-4.
    const csv = toCsv(
      results(
        ["a", "b", "c"],
        [[lit("has, comma"), lit('has "quote"'), lit("has\nnewline")]],
      ),
    );
    const line = csvLines(csv)[1];
    expect(line).toContain('"has, comma"');
    // Inner quotes are doubled.
    expect(line).toContain('"has ""quote"""');
    expect(line).toContain('"has\nnewline"');
  });

  it("csv neutralizes a leading =, +, -, @ formula", () => {
    // AC-5 — the load-bearing security test. Each trigger must be prefixed with
    // an apostrophe so a spreadsheet reads it as text, and the RAW payload must
    // NOT appear as the field's leading character.
    const payloads = [
      "=HYPERLINK(\"http://evil.example\",\"click\")",
      "+1+1",
      "-2+3",
      "@SUM(A1:A9)",
    ];
    const rows = payloads.map((p) => [lit(p)]);
    const csv = toCsv(results(["x"], rows));
    const lines = csvLines(csv).slice(1);
    payloads.forEach((payload, i) => {
      // The field starts with the apostrophe, then the whole original value.
      const field = lines[i];
      // A field with a comma/quote gets RFC-quoted; unwrap for the check.
      const bare = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
      expect(bare.startsWith("'")).toBe(true);
      expect(bare.slice(1)).toBe(payload);
      // The raw payload must never begin a field (it would evaluate).
      expect(field.startsWith(payload[0])).toBe(false);
    });
  });

  it("neutralizeFormula leaves a safe value untouched", () => {
    expect(neutralizeFormula("Earth")).toBe("Earth");
    expect(neutralizeFormula("=x")).toBe("'=x");
    // A tab or carriage return leader is neutralized too.
    expect(neutralizeFormula("\t=x")).toBe("'\t=x");
  });

  it("uses \\r\\n as the line terminator", () => {
    const csv = toCsv(results(["s"], [[uri("http://example.org/a")]]));
    expect(csv).toBe("s\r\nhttp://example.org/a");
  });

  it("export covers every row, not just a page", () => {
    // AC-9: 40 rows all present in the CSV (no pagination in the pure module).
    const rows = Array.from({ length: 40 }, (_, i) => [uri(`http://example.org/e${i}`)]);
    const csv = toCsv(results(["s"], rows));
    expect(csvLines(csv)).toHaveLength(41); // header + 40
  });
});

describe("csvField", () => {
  it("renders each term kind and null", () => {
    expect(csvField(uri("http://example.org/x"))).toBe("http://example.org/x");
    expect(csvField(lit("hi"))).toBe("hi");
    expect(csvField(bnode("b1"))).toBe("_:b1");
    expect(csvField(null)).toBe("");
    // Defensive: an unknown term renders its value string.
    expect(csvField({ type: "unknown", value: "raw" })).toBe("raw");
  });
});

describe("toJson", () => {
  it("json is the w3c sparql results shape", () => {
    // AC-6.
    const doc = JSON.parse(
      toJson(results(["s", "label"], [[uri("http://example.org/Earth"), lit("Earth")]])),
    );
    expect(doc.head.vars).toEqual(["s", "label"]);
    expect(Array.isArray(doc.results.bindings)).toBe(true);
    expect(doc.results.bindings[0].s).toEqual({ type: "uri", value: "http://example.org/Earth" });
    expect(doc.results.bindings[0].label).toEqual({ type: "literal", value: "Earth" });
  });

  it("json omits an unbound variable from its binding", () => {
    // AC-7.
    const doc = JSON.parse(toJson(results(["s", "opt"], [[uri("http://example.org/x"), null]])));
    expect(doc.results.bindings[0]).toHaveProperty("s");
    expect(doc.results.bindings[0]).not.toHaveProperty("opt");
  });

  it("json carries xml:lang and datatype on a literal", () => {
    // AC-8.
    const doc = JSON.parse(
      toJson(
        results(
          ["lang", "typed"],
          [[lit("Earth", { lang: "en" }), lit("42", { datatype: "xsd:integer" })]],
        ),
      ),
    );
    expect(doc.results.bindings[0].lang).toEqual({
      type: "literal",
      value: "Earth",
      "xml:lang": "en",
    });
    expect(doc.results.bindings[0].typed).toEqual({
      type: "literal",
      value: "42",
      datatype: "xsd:integer",
    });
  });

  it("json renders a blank node as its bare label", () => {
    const doc = JSON.parse(toJson(results(["b"], [[bnode("b0")]])));
    expect(doc.results.bindings[0].b).toEqual({ type: "bnode", value: "b0" });
  });

  it("json does not neutralize a formula-looking value (inert as data)", () => {
    const doc = JSON.parse(toJson(results(["x"], [[lit("=1+1")]])));
    // The value is preserved exactly — JSON is never executed by a consumer.
    expect(doc.results.bindings[0].x.value).toBe("=1+1");
  });
});

describe("resultsFilename", () => {
  it("slugs the ontology name and appends -results.<ext>", () => {
    expect(resultsFilename("Acme Core", "csv")).toBe("Acme-Core-results.csv");
    expect(resultsFilename("acme-core.ttl", "json")).toBe("acme-core-results.json");
  });

  it("falls back to results.<ext> when no usable name", () => {
    expect(resultsFilename(undefined, "csv")).toBe("results.csv");
    expect(resultsFilename("", "json")).toBe("results.json");
    expect(resultsFilename("///", "csv")).toBe("results.csv");
  });
});
