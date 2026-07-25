import type { QueryState } from "./sparql/types";
import type {
  NodeDetails,
  OntologySummary,
  QueryNodeInfo,
  QuerySchema,
  SavedQuery,
  SparqlResults,
  VizGraph,
  VizNode,
} from "./types";

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function listOntologies(): Promise<OntologySummary[]> {
  return fetch("/api/ontologies").then((r) => handle<OntologySummary[]>(r));
}

export function uploadOntology(file: File): Promise<OntologySummary> {
  const form = new FormData();
  form.append("file", file);
  return fetch("/api/ontologies/upload", { method: "POST", body: form }).then((r) =>
    handle<OntologySummary>(r),
  );
}

export function fetchOntology(url: string): Promise<OntologySummary> {
  return fetch("/api/ontologies/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then((r) => handle<OntologySummary>(r));
}

export function deleteOntology(id: string): Promise<void> {
  return fetch(`/api/ontologies/${id}`, { method: "DELETE" }).then((r) => handle(r));
}

export function getGraph(id: string): Promise<VizGraph> {
  return fetch(`/api/ontologies/${id}/graph`).then((r) => handle<VizGraph>(r));
}

export function getNodeDetails(id: string, iri: string): Promise<NodeDetails> {
  return fetch(`/api/ontologies/${id}/node?iri=${encodeURIComponent(iri)}`).then((r) =>
    handle<NodeDetails>(r),
  );
}

export function searchNodes(id: string, q: string): Promise<VizNode[]> {
  return fetch(`/api/ontologies/${id}/search?q=${encodeURIComponent(q)}`).then((r) =>
    handle<VizNode[]>(r),
  );
}

/* --- visual query builder ------------------------------------------------ */

export function getQuerySchema(id: string): Promise<QuerySchema> {
  return fetch(`/api/ontologies/${id}/query-schema`).then((r) => handle<QuerySchema>(r));
}

export function getQueryNode(id: string, iri: string): Promise<QueryNodeInfo> {
  return fetch(`/api/ontologies/${id}/query-node?iri=${encodeURIComponent(iri)}`).then((r) =>
    handle<QueryNodeInfo>(r),
  );
}

export function runSparql(id: string, query: string): Promise<SparqlResults> {
  return fetch(`/api/ontologies/${id}/sparql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then((r) => handle<SparqlResults>(r));
}

export function listSavedQueries(ontologyId: string): Promise<SavedQuery[]> {
  return fetch(`/api/queries?ontology=${encodeURIComponent(ontologyId)}`).then((r) =>
    handle<SavedQuery[]>(r),
  );
}

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

export function deleteSavedQuery(qid: string): Promise<void> {
  return fetch(`/api/queries/${qid}`, { method: "DELETE" }).then((r) => handle(r));
}
