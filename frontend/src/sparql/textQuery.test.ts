// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/sparql/textQuery.test.ts
================================================================================

SUMMARY
    The rules in textQuery.ts, without rendering: the byte count the 100 KB
    limit is measured in, the text a new query starts with, the prefix a
    failed run was missing and the line Add PREFIX writes (query-page-rework
    5.3), the .rq file name, and reading a chosen file.

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
  addPrefixLine,
  nameFromFile,
  readQueryFile,
  rqFileName,
  startingText,
  unknownPrefix,
} from "./textQuery";

describe("byteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("日本")).toBe(6);
  });
});

describe("startingText (query-page-rework 5.3)", () => {
  it("one PREFIX line per namespace used, sorted by prefix, then a blank line", () => {
    const text = startingText({
      space: "http://example.org/space#",
      owl: "http://www.w3.org/2002/07/owl#",
      dcterms: "http://purl.org/dc/terms/",
    });
    expect(text).toBe(
      "PREFIX dcterms: <http://purl.org/dc/terms/>\n" +
        "PREFIX owl: <http://www.w3.org/2002/07/owl#>\n" +
        "PREFIX space: <http://example.org/space#>\n\n",
    );
  });

  it("nothing at all for an ontology that uses none, or a server without the field", () => {
    expect(startingText({})).toBe("");
    expect(startingText(undefined)).toBe("");
  });
});

describe("unknownPrefix and addPrefixLine (query-page-rework 5.3, AC-6)", () => {
  it("reads the prefix from the server's sentence, and nothing from another failure", () => {
    expect(unknownPrefix("Could not parse the SPARQL query: Unknown namespace prefix : space")).toBe("space");
    expect(unknownPrefix("Unknown namespace prefix: me")).toBe("me");
    expect(unknownPrefix("Could not parse the SPARQL query: Expected end of text")).toBeNull();
    expect(unknownPrefix(null)).toBeNull();
  });

  it("adds one line after the leading comments, and changes nothing else", () => {
    const text = "# Which moons orbit Jupiter?\n# two\nSELECT ?m WHERE { ?m a space:Moon }";
    expect(addPrefixLine(text, "space", "http://example.org/space#").split("\n")).toEqual([
      "# Which moons orbit Jupiter?",
      "# two",
      "PREFIX space: <http://example.org/space#>",
      "SELECT ?m WHERE { ?m a space:Moon }",
    ]);
    expect(addPrefixLine("SELECT * {}", "ex", "http://x/")).toBe("PREFIX ex: <http://x/>\nSELECT * {}");
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
