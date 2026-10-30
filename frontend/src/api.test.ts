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

    The upload goes over XMLHttpRequest (load-progress 5.2). FakeXHR stands in
    for it and hands each request to the fetch spy, so every check above
    reads the upload as it reads the rest; in its manual mode a test drives
    the upload's progress and its abort itself.

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

type Handler = ((e: ProgressEvent) => void) | null;

/** XMLHttpRequest, answered by whatever `fetch` is stubbed as. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  /** When set, a request waits for the test to answer or abort it. */
  static manual = false;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  statusText = "";
  responseText = "";
  rawHeaders = "";
  upload: { onprogress: Handler; onload: Handler } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getAllResponseHeaders() {
    return this.rawHeaders;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.instances.push(this);
    if (FakeXHR.manual) return;
    void (async () => {
      const response = await fetch(this.url, { method: this.method, headers: this.headers, body: body as BodyInit });
      this.answer(response.status, await response.text(), [...response.headers]);
    })();
  }
  answer(status: number, text: string, headers: [string, string][] = [["content-type", "application/json"]]) {
    this.status = status;
    this.responseText = text;
    this.rawHeaders = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n");
    this.upload.onload?.(new ProgressEvent("load", { lengthComputable: true, loaded: 1, total: 1 }));
    this.onload?.();
  }
  abort() {
    this.onabort?.();
  }
}

beforeEach(() => {
  recorded = [];
  FakeXHR.instances = [];
  FakeXHR.manual = false;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
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
  cancelLoad: () => api.cancelLoad("0b8a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"),
  deleteOntology: () => api.deleteOntology("ont-1"),
  getGraph: () => api.getGraph("ont-1"),
  getNeighborhood: () => api.getNeighborhood("ont-1", "http://example.org/a"),
  getResultNodes: () => api.getResultNodes("ont-1", ["http://example.org/a"]),
  fetchHierarchy: () => api.fetchHierarchy("ont-1"),
  getNodeDetails: () => api.getNodeDetails("ont-1", "http://example.org/a"),
  searchNodes: () => api.searchNodes("ont-1", "ab"),
  getSource: () => api.getSource("ont-1"),
  getQuerySchema: () => api.getQuerySchema("ont-1"),
  getQueryNode: () => api.getQueryNode("ont-1", "http://example.org/a"),
  runSparql: () => api.runSparql("ont-1", "SELECT * WHERE { ?s ?p ?o }"),
  listSavedQueries: () => api.listSavedQueries("ont-1"),
  exportSavedQueries: () => api.exportSavedQueries("ont-0123456789ab"),
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
  getSettings: () => api.getSettings(),
  saveLimits: () => api.saveLimits({ largestFile: 100 }),
  getNetworkActivity: () => api.getNetworkActivity(),
  // external-access Stage 4: the connection settings and Test connection.
  getNetworkConnection: () => api.getNetworkConnection(),
  saveNetworkConnection: () =>
    api.saveNetworkConnection({
      mode: "manual",
      https: { host: "proxy.corp", port: 9400 },
      http: { host: "", port: null },
      noProxy: ["localhost"],
    }),
  uploadNetworkCertificate: () => api.uploadNetworkCertificate(new File(["x"], "root.pem")),
  removeNetworkCertificate: () => api.removeNetworkCertificate(),
  testNetworkConnection: () => api.testNetworkConnection(),
  listImports: () => api.listImports("ont-1"),
  resolveImports: () => api.resolveImports("ont-1"),
  refreshImports: () => api.refreshImports("ont-1"),
  cancelImports: () => api.cancelImports("ont-1"),
  mapImport: () => api.mapImport("ont-1", "http://example.org/i", "ont-2"),
  chooseImportFiles: () => api.chooseImportFiles("ont-1", [new File(["x"], "x.ttl")]),
  // authoring-foundations: projects and editing.
  // home-and-examples: the examples added back.
  restoreExamples: () => api.restoreExamples(),
  listReferences: () => api.listReferences(),
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
  getShapes: () => api.getShapes("prj-1"),
  getShapeSuggestions: () => api.getShapeSuggestions("prj-1", "http://example.org/A", "http://example.org/S"),
  validateProject: () => api.validateProject("prj-1"),
  previewDelete: () => api.previewDelete("prj-1", "model", "http://example.org/A"),
  // attribute-reuse 5.2: ShareDomain's dry run, the reuse plan.
  planShare: () => api.planShare("prj-1", "http://example.org/p", "http://example.org/A"),
  // attribute-reuse 5.7: SetClassType's dry run, what goes.
  planClassType: () => api.planClassType("prj-1", "http://example.org/A", "rdfs"),
  getAnnotationProperties: () => api.getAnnotationProperties("prj-1", "model"),
  getCanvas: () => api.getCanvas("prj-1", "model"),
  getLayout: () => api.getLayout("prj-1", "model"),
  putLayout: () =>
    api.putLayout("prj-1", "model", { version: 1, generation: 0, positions: {}, shown: null, viewport: null }),
  // csv-data-import: the wizard and the snapshot list.
  inspectData: () => api.inspectData("prj-1", { file: new File(["a,b"], "a.csv") }),
  previewData: () => api.previewData("prj-1", { snapshot: "people-abcdef" }, {}, { classIri: "http://example.org/A" }),
  importData: () =>
    api.importData("prj-1", new File(["a,b"], "a.csv"), {}, { classIri: "http://example.org/A", idColumn: null, columns: {} }),
  listData: () => api.listData("prj-1"),
  refreshData: () => api.refreshData("prj-1", "people-abcdef", new File(["a,b"], "a.csv"), {}),
  updateData: () => api.updateData("prj-1", "people-abcdef", { enabled: false }),
  removeData: () => api.removeData("prj-1", "people-abcdef"),
  // axioms-and-reasoning: a run, its Stop, a page, the facts about one
  // entity and one fact's reason.
  reasonProject: () => api.reasonProject("prj-1", false, false),
  stopReasoning: () => api.stopReasoning("prj-1"),
  getReasoningPage: () => api.getReasoningPage("prj-1", "memberships", 200, false),
  getReasoningAbout: () => api.getReasoningAbout("prj-1", "http://example.org/A", false),
  getWhy: () => api.getWhy("prj-1", { s: "http://example.org/a", p: "http://example.org/p", o: "http://example.org/b" }),
  // Not requests: the approval plumbing and the display language. Listed so
  // the export check holds.
  setApprovalHandler: async () => api.setApprovalHandler(null),
  declinedMessage: async () => api.declinedMessage([]),
  setDisplayLanguage: async () => api.setDisplayLanguage(null),
  // Not a request either: reads a refusal's body (attribute-reuse 5.1).
  alreadyDefined: async () => api.alreadyDefined(null),
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
    // PUT (its layout); validation one POST (shacl-authoring 5.6); the data
    // wizard four POSTs, a PATCH and a DELETE (csv-data-import); reasoning
    // a POST (Reason) and a DELETE (Stop); the examples one POST (restore);
    // a load's cancel one POST (load-progress 5.3); the reuse plan one POST
    // (ShareDomain's dry run, attribute-reuse 5.2); a query's hidden results
    // one POST (/nodes, query-page-rework 5.2); a change of a class's kind
    // one POST (SetClassType's dry run, attribute-reuse 5.7); Settings →
    // Limits one PUT (home-and-settings Stage B); the corporate network
    // settings two PUTs (the proxy, the certificate file), a DELETE (the
    // file's Remove) and a POST (Test connection, external-access 5.5).
    const expected = [
      ...Array(7).fill("DELETE"),
      "PATCH",
      "PATCH",
      ...Array(33).fill("POST"),
      ...Array(6).fill("PUT"),
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

  it("does not set a content type on a data file either, and sends choices as JSON fields", async () => {
    const sent: FormData[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(init?.body as FormData);
        recorded.push({ url: _url, method: "POST", headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        return new Response("{}", { status: 200 });
      }),
    );
    await api.previewData("prj-1", { file: new File(["a,b"], "a.csv") }, { sample: true }, { classIri: "http://x/A" });
    expect(recorded[0].headers).toEqual({ "X-Semantic-Studio": "1" });
    expect(sent[0].get("file")).toBeInstanceOf(File);
    expect(JSON.parse(String(sent[0].get("options")))).toEqual({ sample: true });
    expect(JSON.parse(String(sent[0].get("choices")))).toEqual({ classIri: "http://x/A" });
  });

  it("a refused data file reads as its sentence, with the status kept", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: { message: "This file is 6.0 MB.", kind: "too-large" } }), {
          status: 413,
        }),
      ),
    );
    const failure = await api.inspectData("prj-1", { file: new File(["x"], "a.csv") }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(api.ApiError);
    expect((failure as api.ApiError).message).toBe("This file is 6.0 MB.");
    expect((failure as api.ApiError).status).toBe(413);
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

  it("searchNodes sends limit only when given (explore-and-query-layout 5.7)", async () => {
    await api.searchNodes("ont-1", "ab");
    await api.searchNodes("ont-1", "ab", false, undefined, undefined, 26);
    expect(recorded.map((r) => r.url)).toEqual([
      "/api/ontologies/ont-1/search?q=ab",
      "/api/ontologies/ont-1/search?q=ab&limit=26",
    ]);
  });

  it("searchNodes asks for reference terms only when told (reference-ontologies 5.6)", async () => {
    await api.searchNodes("prj-1-model", "org", true, "class");
    await api.searchNodes("prj-1-model", "org", true, "class", undefined, undefined, true);
    expect(recorded.map((r) => r.url)).toEqual([
      "/api/ontologies/prj-1-model/search?q=org&kind=class&imports=true",
      "/api/ontologies/prj-1-model/search?q=org&kind=class&references=true&imports=true",
    ]);
  });

  it("listReferences reads GET /api/references (reference-ontologies 8)", async () => {
    await api.listReferences();
    expect(recorded.map((r) => [r.method, r.url])).toEqual([["GET", "/api/references"]]);
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

describe("loads that can be followed and cancelled (load-progress 5.2, 5.3)", () => {
  const LOAD_ID = "0b8a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("uploadOntology reports the bytes sent, then answers as fetch would", async () => {
    FakeXHR.manual = true;
    const sent: [number, number][] = [];
    const loading = api.uploadOntology(new File(["x".repeat(10)], "big.ttl"), {
      loadId: LOAD_ID,
      onSent: (done, total) => sent.push([done, total]),
    });
    const xhr = FakeXHR.instances[0];
    expect([xhr.method, xhr.url]).toEqual(["POST", "/api/ontologies/upload"]);
    expect(xhr.headers).toEqual({ "X-Semantic-Studio": "1" });
    xhr.upload.onprogress!(new ProgressEvent("progress", { lengthComputable: true, loaded: 40, total: 100 }));
    // A progress event that cannot say its total is not a share of anything.
    xhr.upload.onprogress!(new ProgressEvent("progress", { lengthComputable: false, loaded: 60 }));
    xhr.answer(200, JSON.stringify({ id: "ont-7" }));
    expect(await loading).toEqual({ id: "ont-7" });
    expect(sent).toEqual([
      [40, 100],
      [1, 1],
    ]);
  });

  it("both loads send the loadId: a form field and a JSON field", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body);
        return new Response("{}", { status: 200 });
      }),
    );
    await api.uploadOntology(new File(["x"], "x.ttl"), { loadId: LOAD_ID });
    await api.fetchOntology("https://example.org/x.ttl", { loadId: LOAD_ID });
    expect((bodies[0] as FormData).get("loadId")).toBe(LOAD_ID);
    expect(JSON.parse(String(bodies[1]))).toEqual({ url: "https://example.org/x.ttl", loadId: LOAD_ID });
    // Without one, the request is the one it always was.
    await api.fetchOntology("https://example.org/x.ttl");
    expect(JSON.parse(String(bodies[2]))).toEqual({ url: "https://example.org/x.ttl" });
  });

  it("uploadOntology aborts on its signal, and rejects as an AbortError", async () => {
    FakeXHR.manual = true;
    const controller = new AbortController();
    const loading = api.uploadOntology(new File(["x"], "x.ttl"), { signal: controller.signal });
    const xhr = FakeXHR.instances[0];
    const aborted = vi.spyOn(xhr, "abort");
    controller.abort();
    expect(aborted).toHaveBeenCalledTimes(1);
    const error = await loading.catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("an answer no Response can carry fails as fetch would, never with the constructor's error", async () => {
    FakeXHR.manual = true;
    const loading = api.uploadOntology(new File(["x"], "x.ttl"));
    FakeXHR.instances[0].answer(0, "");
    const error = await loading.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("Failed to fetch");
  });

  it("a null-body status is answered without a body", async () => {
    FakeXHR.manual = true;
    const loading = api.uploadOntology(new File(["x"], "x.ttl"));
    FakeXHR.instances[0].answer(204, "");
    // It reaches handle, which finds no JSON in it: not the transport's
    // "Failed to fetch", and not the Response constructor's refusal.
    const error = await loading.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(String(error)).not.toMatch(/null body/i);
  });

  it("an upload already aborted never leaves the browser", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await api.uploadOntology(new File(["x"], "x.ttl"), { signal: controller.signal }).catch((e) => e);
    expect(error.name).toBe("AbortError");
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("fetchOntology aborts on its signal", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal;
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const controller = new AbortController();
    const loading = api.fetchOntology("https://example.org/x.ttl", { signal: controller.signal });
    controller.abort();
    expect(signal).toBe(controller.signal);
    expect(((await loading.catch((e: unknown) => e)) as DOMException).name).toBe("AbortError");
  });

  it("cancelLoad posts to the load's cancel route and reads stopped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        recorded.push({ url, method: init?.method ?? "GET", headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        return new Response(JSON.stringify({ stopped: true }), { status: 200 });
      }),
    );
    expect(await api.cancelLoad(LOAD_ID)).toEqual({ stopped: true });
    expect(recorded).toEqual([
      { url: `/api/ontologies/loads/${LOAD_ID}/cancel`, method: "POST", headers: { "X-Semantic-Studio": "1" } },
    ]);
  });
});
