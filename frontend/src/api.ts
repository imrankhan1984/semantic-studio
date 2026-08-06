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
  Hierarchy,
  NodeDetails,
  OntologyDeletion,
  OntologySource,
  OntologySummary,
  QueryNodeInfo,
  QuerySchema,
  SavedQuery,
  SparqlResults,
  VizGraph,
  VizNeighborhood,
  VizNode,
} from "./types";

/**
 * A failed request, carrying the status code alongside the backend's message.
 *
 * The code is here because one caller has to tell two failures apart. A 404
 * from `/neighborhood` is not a fault: it is the endpoint saying the IRI is not
 * a node in the visualization graph, which is true of every predicate and every
 * blank node, and the interface answers that with a polite sentence rather than
 * an error bar. Anything else really did go wrong. Matching on the message text
 * would work until the message is reworded.
 *
 * It extends Error, so every existing `e instanceof Error` catch is unchanged.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Unwrap a fetch Response: return the parsed JSON on success, or throw an
 * ApiError carrying the backend's `detail` (falling back to the status text).
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
    throw new ApiError(detail, response.status);
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

/**
 * One entity plus its highest-degree neighbours, for growing the drawn graph.
 *
 * `limit` is omitted by default for the same reason getGraph omits it: the
 * server owns the number, and writing it here would put it in two places. The
 * response is merged into the graph the browser already holds rather than
 * replacing it, so this never costs the settled layout.
 */
export function getNeighborhood(
  id: string,
  iri: string,
  limit?: number,
): Promise<VizNeighborhood> {
  const extra = limit === undefined ? "" : `&limit=${limit}`;
  return fetch(
    `/api/ontologies/${id}/neighborhood?iri=${encodeURIComponent(iri)}${extra}`,
  ).then((r) => handle<VizNeighborhood>(r));
}

/**
 * The subClassOf / broader forests for the Hierarchy view.
 *
 * Unbudgeted, unlike getGraph: the tree is a fraction of the graph's size and
 * the frontend virtualizes it, so the whole asserted structure comes back. The
 * server caches it on the ontology, so re-opening the tab is cheap.
 */
export function fetchHierarchy(id: string): Promise<Hierarchy> {
  return fetch(`/api/ontologies/${id}/hierarchy`).then((r) => handle<Hierarchy>(r));
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

/** Pull the filename out of a Content-Disposition header, or null. The backend
 *  sends `attachment; filename="<name>-docs.zip"`; anything unexpected falls
 *  back to null so the caller can name the file itself. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match ? match[1] : null;
}

/**
 * Fetch an ontology's documentation as a zip blob, with the server's filename.
 *
 * This is the one client call that returns bytes rather than JSON, so it does
 * not go through `handle`. It still unwraps a failure the same way — the error
 * body is JSON `{ detail }` (for instance, the graph is over the 5 MB embed
 * guard) — and throws an ApiError carrying the status, so the caller can tell a
 * refusal from a real fault exactly as elsewhere.
 */
export async function downloadDocumentation(
  id: string,
  includeIndividuals = false,
): Promise<{ blob: Blob; filename: string }> {
  // Instance data is excluded by default (DOC-1 D-038); the flag is sent only
  // when the user opted in, and the backend treats any value other than "true"
  // as excluded, so omitting it is the safe path.
  const query = includeIndividuals ? "?include_individuals=true" : "";
  const response = await fetch(`/api/ontologies/${id}/documentation${query}`);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(detail, response.status);
  }
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ?? `${id}-docs.zip`;
  return { blob, filename };
}
