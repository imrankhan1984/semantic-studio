import type { NodeDetails, OntologySummary, VizGraph, VizNode } from "./types";

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
