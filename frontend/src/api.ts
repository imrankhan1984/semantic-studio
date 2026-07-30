/*
================================================================================
FILE: frontend/src/api.ts
================================================================================

SUMMARY
    The single place the frontend talks to the backend. One thin wrapper per
    REST endpoint, each returning a typed Promise.

BASIC IDEA
    Keeping every fetch call here (rather than scattered in components) means
    URL shapes, request encoding and error handling live in one file. `handle`
    centralises turning a non-2xx response into a thrown Error carrying the
    backend's `detail` message, so callers can just try/catch.

INPUTS / INPUT SOURCES
    - Arguments from the components (ids, IRIs, query text, files, payloads).
    - HTTP responses from the FastAPI backend.

EXPECTED OUTPUT
    - Typed data (or a thrown Error) for each endpoint.
================================================================================
*/

import type { QueryState } from "./sparql/types";
import type {
  NodeDetails,
  OntologyDeletion,
  OntologySource,
  OntologySummary,
  QueryNodeInfo,
  QuerySchema,
  SavedQuery,
  SparqlResults,
  VizGraph,
  VizNode,
} from "./types";

/**
 * Unwrap a fetch Response: return the parsed JSON on success, or throw an
 * Error carrying the backend's `detail` (falling back to the status text).
 */
async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      // Backend errors put a human message in { detail: ... }.
      const body = await response.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

// List loaded ontologies (dropdown summaries).
export function listOntologies(): Promise<OntologySummary[]> {
  return fetch("/api/ontologies").then((r) => handle<OntologySummary[]>(r));
}

// Upload a local file as multipart form data.
export function uploadOntology(file: File): Promise<OntologySummary> {
  const form = new FormData();
  form.append("file", file);
  return fetch("/api/ontologies/upload", { method: "POST", body: form }).then((r) =>
    handle<OntologySummary>(r),
  );
}

// Ask the backend to download an ontology from a URL.
export function fetchOntology(url: string): Promise<OntologySummary> {
  return fetch("/api/ontologies/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then((r) => handle<OntologySummary>(r));
}

// Remove an ontology (and its saved queries) from the server. The body is
// returned rather than discarded because `deletedQueries` is the only place the
// count of destroyed work exists — the client's own count was taken before the
// delete and can be out of date by the time it lands.
export function deleteOntology(id: string): Promise<OntologyDeletion> {
  return fetch(`/api/ontologies/${id}`, { method: "DELETE" }).then((r) =>
    handle<OntologyDeletion>(r),
  );
}

/**
 * The visualization nodes/edges for the graph view.
 *
 * `limit` is omitted on the first request on purpose, so the server applies
 * its own configured default. Sending 2,000 from here would hard-code the
 * number in a second place and make SEMANTIC_STUDIO_GRAPH_NODE_BUDGET do
 * nothing, which is the setting the whole choice of default relies on.
 * Callers pass a limit only once the user has asked for more.
 */
export function getGraph(id: string, limit?: number): Promise<VizGraph> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  return fetch(`/api/ontologies/${id}/graph${query}`).then((r) => handle<VizGraph>(r));
}

// Every statement about one entity, for the detail panel.
export function getNodeDetails(id: string, iri: string): Promise<NodeDetails> {
  return fetch(`/api/ontologies/${id}/node?iri=${encodeURIComponent(iri)}`).then((r) =>
    handle<NodeDetails>(r),
  );
}

// Label/IRI search for the search box.
export function searchNodes(id: string, q: string): Promise<VizNode[]> {
  return fetch(`/api/ontologies/${id}/search?q=${encodeURIComponent(q)}`).then((r) =>
    handle<VizNode[]>(r),
  );
}

// The source text for the View tab (original bytes, or pretty Turtle).
export function getSource(id: string, pretty = false): Promise<OntologySource> {
  return fetch(`/api/ontologies/${id}/source?pretty=${pretty}`).then((r) =>
    handle<OntologySource>(r),
  );
}

/* --- visual query builder ------------------------------------------------ */

// The class-level schema powering the query builder.
export function getQuerySchema(id: string): Promise<QuerySchema> {
  return fetch(`/api/ontologies/${id}/query-schema`).then((r) => handle<QuerySchema>(r));
}

// Map a clicked graph node to the class/type the builder should step on.
export function getQueryNode(id: string, iri: string): Promise<QueryNodeInfo> {
  return fetch(`/api/ontologies/${id}/query-node?iri=${encodeURIComponent(iri)}`).then((r) =>
    handle<QueryNodeInfo>(r),
  );
}

// Execute a SPARQL SELECT and return the result rows.
export function runSparql(id: string, query: string): Promise<SparqlResults> {
  return fetch(`/api/ontologies/${id}/sparql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then((r) => handle<SparqlResults>(r));
}

// The saved-query library for one ontology.
export function listSavedQueries(ontologyId: string): Promise<SavedQuery[]> {
  return fetch(`/api/queries?ontology=${encodeURIComponent(ontologyId)}`).then((r) =>
    handle<SavedQuery[]>(r),
  );
}

// Create or update a saved query (id present -> update).
export function saveQuery(payload: {
  id?: string;
  name: string;
  ontologyId: string;
  state: QueryState;
  sparql: string;
}): Promise<SavedQuery> {
  return fetch("/api/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => handle<SavedQuery>(r));
}

// Delete a saved query by id.
export function deleteSavedQuery(qid: string): Promise<void> {
  return fetch(`/api/queries/${qid}`, { method: "DELETE" }).then((r) => handle(r));
}
