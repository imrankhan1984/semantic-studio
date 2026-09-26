/*
================================================================================
FILE: frontend/src/api.test.ts
================================================================================

SUMMARY
    Proves every call in api.ts that changes something on the server sends the
    X-Semantic-Studio header, and that read-only calls are plain GETs. Covers
    AC-4 of the external-access spec, Stage 0 (backlog S-6, decision D-065):
    the backend refuses a state-changing request without the header, so a
    mutating call that forgot it would break in the application while every
    backend test stayed green.

BASIC IDEA
    `fetch` is replaced with a spy that records each request and answers with
    an empty JSON body. Every exported function is called once, and then every
    recorded request that is not a GET must carry the header.

    The list of calls is checked against the module's actual exports, so a new
    function added to api.ts fails this file until it is added here — which is
    the moment someone has to decide whether it mutates.

INPUTS / INPUT SOURCES
    - api.ts, with global fetch stubbed.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

type Recorded = { url: string; method: string; headers: Record<string, string> };

let recorded: Recorded[] = [];

beforeEach(() => {
  recorded = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      recorded.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// One call per exported function. The arguments are placeholders: fetch is a
// spy, so nothing reaches a server.
const CALLS: Record<string, () => Promise<unknown>> = {
  listOntologies: () => api.listOntologies(),
  uploadOntology: () => api.uploadOntology(new File(["x"], "x.ttl")),
  fetchOntology: () => api.fetchOntology("https://example.org/x.ttl"),
  deleteOntology: () => api.deleteOntology("ont-1"),
  getGraph: () => api.getGraph("ont-1"),
  getNeighborhood: () => api.getNeighborhood("ont-1", "http://example.org/a"),
  fetchHierarchy: () => api.fetchHierarchy("ont-1"),
  getNodeDetails: () => api.getNodeDetails("ont-1", "http://example.org/a"),
  searchNodes: () => api.searchNodes("ont-1", "ab"),
  getSource: () => api.getSource("ont-1"),
  getQuerySchema: () => api.getQuerySchema("ont-1"),
  getQueryNode: () => api.getQueryNode("ont-1", "http://example.org/a"),
  runSparql: () => api.runSparql("ont-1", "SELECT * WHERE { ?s ?p ?o }"),
  listSavedQueries: () => api.listSavedQueries("ont-1"),
  saveQuery: () =>
    api.saveQuery({
      name: "q",
      ontologyId: "ont-1",
      state: {} as never,
      sparql: "SELECT * WHERE { ?s ?p ?o }",
    }),
  deleteSavedQuery: () => api.deleteSavedQuery("q-1"),
  downloadDocumentation: () => api.downloadDocumentation("ont-1"),
};

describe("api client header (S-6)", () => {
  it("covers every exported function", () => {
    const exported = Object.entries(api)
      .filter(([, value]) => typeof value === "function" && !/^[A-Z]/.test(value.name))
      .map(([name]) => name)
      .sort();
    expect(Object.keys(CALLS).sort()).toEqual(exported);
  });

  it("sends the header on every request that is not a GET", async () => {
    for (const call of Object.values(CALLS)) {
      await call().catch(() => undefined);
    }
    const mutating = recorded.filter((r) => r.method !== "GET");
    // Assert the loop really exercised the writes before trusting the check.
    expect(mutating.map((r) => r.method).sort()).toEqual([
      "DELETE",
      "DELETE",
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
    for (const request of mutating) {
      expect(request.headers, `${request.method} ${request.url}`).toMatchObject({
        "X-Semantic-Studio": "1",
      });
    }
  });

  it("keeps the JSON content type beside the header", async () => {
    await api.runSparql("ont-1", "SELECT * WHERE { ?s ?p ?o }");
    expect(recorded[0].headers).toEqual({
      "Content-Type": "application/json",
      "X-Semantic-Studio": "1",
    });
  });

  it("does not set a content type on the multipart upload", async () => {
    // The browser must write the multipart boundary itself; a hand-set
    // Content-Type would drop it and the server could not read the file.
    await api.uploadOntology(new File(["x"], "x.ttl"));
    expect(recorded[0].headers).toEqual({ "X-Semantic-Studio": "1" });
  });
});
