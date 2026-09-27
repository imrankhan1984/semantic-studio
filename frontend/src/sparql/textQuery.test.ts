// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/sparql/textQuery.test.ts
================================================================================

SUMMARY
    The rules in textQuery.ts, without rendering: the byte count the 100 KB
    limit is measured in, PREFIX insertion, the .rq file name, and reading a
    chosen file.

BASIC IDEA
    The editor tests exercise these through the panel; this file holds the
    edge cases that would be tedious to reach that way -- a multi-byte
    character at the limit, the default prefix, a name made only of
    characters a file system refuses.

INPUTS / INPUT SOURCES
    - textQuery.ts; File objects built in the test.

EXPECTED OUTPUT
    - Pass/fail per assertion, supporting AC-7 and AC-8.
================================================================================
*/

import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_BYTES,
  NOT_UTF8,
  TOO_LARGE_TO_OPEN,
  byteLength,
  insertPrefixes,
  nameFromFile,
  readQueryFile,
  rqFileName,
} from "./textQuery";

describe("byteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("日本")).toBe(6);
  });
});

describe("insertPrefixes", () => {
  const NS = { ex: "http://example.org/", "": "http://example.org/default#", owl: "http://www.w3.org/2002/07/owl#" };

  it("adds every undeclared prefix after the leading comments, sorted", () => {
    const text = "# one\n# two\nSELECT * {}";
    expect(insertPrefixes(text, NS).split("\n")).toEqual([
      "# one",
      "# two",
      "PREFIX : <http://example.org/default#>",
      "PREFIX ex: <http://example.org/>",
      "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
      "SELECT * {}",
    ]);
  });

  it("leaves a declared prefix alone, whatever its case or spacing", () => {
    const text = "prefix   ex: <http://elsewhere/>\nPREFIX : <x:>\nSELECT * {}";
    const out = insertPrefixes(text, NS);
    expect(out.match(/ex:/gi)).toHaveLength(1);
    expect(out).toContain("PREFIX owl:");
    expect(out.match(/PREFIX :/g)).toHaveLength(1);
  });

  it("leaves out rdflib's own bindings unless the text uses them", () => {
    // What the schema carries for a file declaring only its own prefix: the
    // file's, the core four, and rdflib's defaults, indistinguishable by name.
    const schemaNs = {
      "": "http://example.org/space#",
      owl: "http://www.w3.org/2002/07/owl#",
      brick: "https://brickschema.org/schema/Brick#",
      skos: "http://www.w3.org/2004/02/skos/core#",
      sosa: "http://www.w3.org/ns/sosa/",
    };
    const out = insertPrefixes("SELECT ?c WHERE { ?c a skos:Concept }", schemaNs);
    expect(out).toContain("PREFIX : <http://example.org/space#>");
    expect(out).toContain("PREFIX owl:");
    expect(out).toContain("PREFIX skos:");
    expect(out).not.toContain("brick");
    expect(out).not.toContain("sosa");
    // A prefix bound to something else than rdflib's IRI is the file's own.
    expect(insertPrefixes("", { schema: "http://example.org/my-schema#" })).toContain("PREFIX schema:");
  });

  it("returns the text unchanged when nothing is missing", () => {
    expect(insertPrefixes("SELECT * {}", {})).toBe("SELECT * {}");
  });
});

describe("rqFileName", () => {
  it("names the file after the query, or 'query'", () => {
    expect(rqFileName("Planets")).toBe("Planets.rq");
    expect(rqFileName(null)).toBe("query.rq");
    expect(rqFileName("")).toBe("query.rq");
  });

  it("never lets a name become a path", () => {
    expect(rqFileName("../../etc/passwd")).toBe("etc-passwd.rq");
    expect(rqFileName("a\\b:c*d?e\"f<g>h|i")).toBe("a-b-c-d-e-f-g-h-i.rq");
    expect(rqFileName("///")).toBe("query.rq");
  });

  it("keeps a long label to a sensible length", () => {
    expect(rqFileName("x".repeat(500)).length).toBe(103);
  });
});

describe("readQueryFile", () => {
  it("reads UTF-8 text and names it after the file", async () => {
    expect(await readQueryFile(new File(["SELECT * {}"], "My query.rq"))).toEqual({
      ok: true,
      name: "My query",
      text: "SELECT * {}",
    });
  });

  it("drops a byte order mark", async () => {
    const result = await readQueryFile(new File(["﻿SELECT * {}"], "bom.rq"));
    expect(result).toEqual({ ok: true, name: "bom", text: "SELECT * {}" });
  });

  it("refuses more than 100 KB before reading, and accepts exactly 100 KB", async () => {
    expect(await readQueryFile(new File(["x".repeat(MAX_QUERY_BYTES + 1)], "a.rq"))).toEqual({
      ok: false,
      error: TOO_LARGE_TO_OPEN,
    });
    expect((await readQueryFile(new File(["x".repeat(MAX_QUERY_BYTES)], "a.rq"))).ok).toBe(true);
  });

  it("refuses bytes that are not UTF-8", async () => {
    expect(await readQueryFile(new File([new Uint8Array([0xc3, 0x28])], "bad.rq"))).toEqual({
      ok: false,
      error: NOT_UTF8,
    });
  });

  it("keeps a name with no known extension whole", () => {
    expect(nameFromFile("query.SPARQL")).toBe("query");
    expect(nameFromFile("notes.md")).toBe("notes.md");
  });
});
