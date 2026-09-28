/*
================================================================================
FILE: frontend/src/api.test.ts
================================================================================

SUMMARY
    Proves every call in api.ts that changes something on the server sends the
    X-Semantic-Studio header, and that read-only calls are plain GETs. Also
    proves the approval round trip in `send` (external-access Stage 1): a 409
    asks the registered handler, Allow repeats the same request with the grant
    id, Don't allow fails with a sentence naming the host and sends nothing
    more. Covers
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
  getEmbeddedQueries: () => api.getEmbeddedQueries("ont-1"),
  downloadDocumentation: () => api.downloadDocumentation("ont-1"),
  getNetworkPolicy: () => api.getNetworkPolicy(),
  grantNetwork: () =>
    api.grantNetwork({
      capability: "jsonld:context",
      host: "example.org",
      decision: "allow",
      remember: false,
    }),
  revokeNetworkGrant: () => api.revokeNetworkGrant("grant-1"),
  setNetworkOffline: () => api.setNetworkOffline(true),
  getNetworkActivity: () => api.getNetworkActivity(),
  listImports: () => api.listImports("ont-1"),
  resolveImports: () => api.resolveImports("ont-1"),
  refreshImports: () => api.refreshImports("ont-1"),
  cancelImports: () => api.cancelImports("ont-1"),
  mapImport: () => api.mapImport("ont-1", "http://example.org/i", "ont-2"),
  chooseImportFiles: () => api.chooseImportFiles("ont-1", [new File(["x"], "x.ttl")]),
  // authoring-foundations: projects and editing.
  listProjects: () => api.listProjects(),
  createProject: () => api.createProject({ name: "p", template: "small" }),
  updateProject: () => api.updateProject("prj-1", { name: "q" }),
  duplicateProject: () => api.duplicateProject("prj-1"),
  deleteProject: () => api.deleteProject("prj-1"),
  exportProject: () => api.exportProject("prj-1"),
  openProject: () => api.openProject("prj-1"),
  closeProject: () => api.closeProject("prj-1"),
  addShapesDocument: () => api.addShapesDocument("prj-1"),
  runCommand: () => api.runCommand("prj-1", "model", "CreateClass", { label: "A" }),
  getDocumentSource: () => api.getDocumentSource("prj-1", "model"),
  applyDocumentSource: () => api.applyDocumentSource("prj-1", "model", "@prefix : <x#> ."),
  undoChange: () => api.undoChange("prj-1", "model"),
  redoChange: () => api.redoChange("prj-1", "model"),
  saveDocument: () => api.saveDocument("prj-1", "model"),
  downloadDocumentCopy: () => api.downloadDocumentCopy("prj-1", "model"),
  recoverProject: () => api.recoverProject("prj-1", "discard"),
  getLanguageReport: () => api.getLanguageReport("prj-1", "model"),
  previewDelete: () => api.previewDelete("prj-1", "model", "http://example.org/A"),
  getAnnotationProperties: () => api.getAnnotationProperties("prj-1", "model"),
  getCanvas: () => api.getCanvas("prj-1", "model"),
  getLayout: () => api.getLayout("prj-1", "model"),
  putLayout: () =>
    api.putLayout("prj-1", "model", { version: 1, positions: {}, shown: null, viewport: null }),
  // Not requests: the approval plumbing and the display language. Listed so
  // the export check holds.
  setApprovalHandler: async () => api.setApprovalHandler(null),
  declinedMessage: async () => api.declinedMessage([]),
  setDisplayLanguage: async () => api.setDisplayLanguage(null),
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
    // Ten POSTs and three DELETEs before projects; projects add ten POSTs,
    // a DELETE, a PATCH (rename, languages) and a PUT (the Turtle apply);
    // the editing form adds one POST (the delete's dry run); the canvas one
    // PUT (its layout).
    const expected = [
      ...Array(4).fill("DELETE"),
      "PATCH",
      ...Array(21).fill("POST"),
      "PUT",
      "PUT",
      "PUT",
    ];
    expect(mutating.map((r) => r.method).sort()).toEqual(expected);
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

describe("text queries (sparql-text-and-query-files, AC-9)", () => {
  function captureBodies() {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        recorded.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: {} });
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    return bodies;
  }

  it("saveQuery sends the mode, and a text query may have no state", async () => {
    const bodies = captureBodies();
    await api.saveQuery({
      name: "Union",
      ontologyId: "ont-1",
      state: null,
      sparql: "SELECT * WHERE { { ?s ?p ?o } UNION { ?o ?p ?s } }",
      mode: "text",
    });
    expect(bodies[0]).toMatchObject({ mode: "text", state: null, name: "Union" });
  });

  it("getEmbeddedQueries is a GET, with the imports switch when on", async () => {
    await api.getEmbeddedQueries("ont-1");
    await api.getEmbeddedQueries("ont-1", true);
    expect(recorded.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/api/ontologies/ont-1/embedded-queries"],
      ["GET", "/api/ontologies/ont-1/embedded-queries?imports=true"],
    ]);
  });

  it("a validation error reads as its message, not [object Object]", async () => {
    // The 100 KB cap is a 422 whose detail is FastAPI's list of objects.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            detail: [{ loc: ["body", "query"], msg: "String should have at most 102400 characters" }],
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    await expect(api.runSparql("ont-1", "SELECT")).rejects.toThrow(
      "String should have at most 102400 characters",
    );
  });
});

describe("approval round trip (external-access Stage 1)", () => {
  const QUESTION = {
    capability: "jsonld:context",
    host: "json-ld.org",
    url: "https://json-ld.org/contexts/person.jsonld",
    reason: "The file you are opening defines its terms in a JSON-LD context.",
    sends: "A download request for the context.",
    encrypted: true,
  };

  let answers: Response[];
  let bodies: unknown[];

  beforeEach(() => {
    answers = [];
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        recorded.push({
          url,
          method: (init?.method ?? "GET").toUpperCase(),
          headers: { ...((init?.headers as Record<string, string>) ?? {}) },
        });
        bodies.push(init?.body);
        return answers.shift() ?? new Response("{}", { status: 200 });
      }),
    );
  });

  afterEach(() => api.setApprovalHandler(null));

  const approval = () =>
    new Response(
      JSON.stringify({ detail: { code: "approval_required", requests: [QUESTION] } }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );

  it("asks, then repeats the same request with the just-once grant", async () => {
    const handler = vi.fn(async () => ["grant-abc"]);
    api.setApprovalHandler(handler);
    answers = [approval(), new Response(JSON.stringify({ id: "ont-9" }), { status: 200 })];
    const file = new File(["{}"], "doc.jsonld");

    const summary = await api.uploadOntology(file);

    expect(summary).toEqual({ id: "ont-9" });
    expect(handler).toHaveBeenCalledWith([QUESTION]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0].headers).toEqual({ "X-Semantic-Studio": "1" });
    expect(recorded[1].headers).toEqual({
      "X-Semantic-Studio": "1",
      "X-Semantic-Studio-Grant": "grant-abc",
    });
    // The same FormData, so the browser re-sends the file it still holds.
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("retries without a grant id when the answer was remembered", async () => {
    api.setApprovalHandler(async () => []);
    answers = [approval(), new Response("[]", { status: 200 })];
    await api.getGraph("ont-1");
    expect(recorded).toHaveLength(2);
    expect(recorded[1].headers).toEqual({});
  });

  it("fails with a sentence naming the host on Don't allow, and sends nothing more", async () => {
    api.setApprovalHandler(async () => null);
    answers = [approval()];
    const error = await api.fetchOntology("https://example.org/x.jsonld").catch((e) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(error.message).toBe(
      "Semantic Studio did not connect to json-ld.org, so nothing was sent.",
    );
    expect(recorded).toHaveLength(1);
  });

  it("says what was needed when no dialog is registered", async () => {
    answers = [approval()];
    const error = await api.getGraph("ont-1").catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.message).toContain("permission to connect to json-ld.org");
  });

  it("stops asking after a bounded number of rounds", async () => {
    const handler = vi.fn(async () => ["g"]);
    api.setApprovalHandler(handler);
    answers = Array.from({ length: 20 }, approval);
    const error = await api.getGraph("ont-1").catch((e) => e);
    expect(error.status).toBe(409);
    expect(recorded.length).toBeLessThanOrEqual(7);
  });
});

describe("the merged-view flag (external-access Stage 2)", () => {
  it("adds imports=true only when on, so an off request is unchanged", async () => {
    await api.getGraph("ont-1");
    await api.getGraph("ont-1", 4000, true);
    await api.searchNodes("ont-1", "ab", true);
    await api.runSparql("ont-1", "SELECT * WHERE { ?s ?p ?o }", true);
    expect(recorded.map((r) => r.url)).toEqual([
      "/api/ontologies/ont-1/graph",
      "/api/ontologies/ont-1/graph?limit=4000&imports=true",
      "/api/ontologies/ont-1/search?q=ab&imports=true",
      "/api/ontologies/ont-1/sparql?imports=true",
    ]);
  });
});

describe("projects in the client (authoring-foundations)", () => {
  afterEach(() => api.setDisplayLanguage(null));

  it("sends the display language on the five name-showing reads only while one is set", async () => {
    const reads = () => [
      api.getGraph("prj-1-model"),
      api.getNeighborhood("prj-1-model", "http://x/a"),
      api.fetchHierarchy("prj-1-model"),
      api.getNodeDetails("prj-1-model", "http://x/a"),
      api.searchNodes("prj-1-model", "ab"),
    ];
    await Promise.all(reads());
    expect(recorded.every((r) => !r.url.includes("lang="))).toBe(true);
    recorded = [];
    api.setDisplayLanguage("fr");
    await Promise.all([...reads(), api.getQuerySchema("prj-1-model"), api.getSource("prj-1-model")]);
    const withLang = recorded.filter((r) => r.url.includes("lang=fr"));
    expect(withLang).toHaveLength(5);
    expect(recorded.find((r) => r.url.includes("/query-schema"))!.url).not.toContain("lang=");
  });

  it("an invalid Turtle apply throws a TurtleError carrying line, column and rdflib's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            detail: { line: 3, column: 5, message: "Line 3, column 5: expected '.'", detail: "Bad syntax at ^" },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const error = await api.applyDocumentSource("prj-1", "model", "bad").catch((e) => e);
    expect(error).toBeInstanceOf(api.TurtleError);
    expect(error).toBeInstanceOf(api.ApiError);
    expect([error.line, error.column, error.status]).toEqual([3, 5, 422]);
    expect(error.message).toBe("Line 3, column 5: expected '.'");
    expect(error.detail).toBe("Bad syntax at ^");
  });

  it("a refused command reads as its sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: '"4.5" is not a valid integer (expected a whole number such as 42).' }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const error = await api.runCommand("prj-1", "model", "AddAnnotation", {}).catch((e) => e);
    expect(error.message).toBe('"4.5" is not a valid integer (expected a whole number such as 42).');
  });
});
