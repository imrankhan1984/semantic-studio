/*
================================================================================
FILE: frontend/src/sparql/resultNodes.ts
================================================================================

SUMMARY
    The rules behind a query's results on the graph (query-page-rework 5.2):
    which IRIs in the rows are candidates for a result node, how many hidden
    ones are drawn, the camera target that frames them, and the two sentences
    that say what happened.

BASIC IDEA
    Kept out of GraphView and App for the reason sparql/ exists: each has a
    rule in it, and a rule is cheaper to test without rendering. Nothing here
    knows what is drawn; the caller intersects these IRIs with the graph, as
    only the graph can say which are entities.

    The camera target is in Sigma's framed-graph coordinates, the ones
    getNodeDisplayData answers: the whole graph spans about one unit and a
    camera ratio of 1 shows all of it, so a box w by h is framed by a ratio
    of its larger side with a margin. One node, or a tight cluster, is shown
    at the ratio a search pick centres at, never closer.

INPUTS / INPUT SOURCES
    - SparqlResults rows; node positions in framed-graph coordinates; counts.

EXPECTED OUTPUT
    - IRIs, a camera target, and sentences. No ontology text is interpolated.
================================================================================
*/

import type { SparqlResults } from "../types";

/** What one /nodes request may carry: the server's own bounds
 *  (NODES_MAX_IRIS, an IRI's 4,096 characters, NODES_MAX_BYTES). */
export const RESULT_IRIS_SENT = 20000;
const MAX_IRI_CHARS = 4096;
/** The body's bound, less room for the envelope `{"iris":[]}`. */
const MAX_BODY_BYTES = 4 * 1024 * 1024 - 1024;

/**
 * The hidden IRIs a /nodes request can carry, in order: one longer than the
 * server takes is left out rather than failing the whole request (no graph
 * entity is named by one), and the list stops before the body would pass
 * the server's 4 MB, counted in UTF-8 bytes with the quotes and comma each
 * IRI adds. JSON escapes only quotes and backslashes, which an IRI cannot
 * hold unescaped, so this is the body's size.
 */
export function sendable(iris: string[]): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let size = 0;
  for (const iri of iris) {
    if (iri.length > MAX_IRI_CHARS) continue;
    size += encoder.encode(iri).length + 3;
    if (out.length >= RESULT_IRIS_SENT || size > MAX_BODY_BYTES) break;
    out.push(iri);
  }
  return out;
}

/** The ratio a search pick centres at (GraphView's centerOn). */
export const SINGLE_RESULT_RATIO = 0.25;

/** How much wider than the results' box the framed view is. */
const FRAME_MARGIN = 1.3;

/** Past this the view is the whole graph and a little more. */
const MAX_FRAME_RATIO = 1.2;

/**
 * Every distinct IRI the rows name, in the order the table shows them.
 * Literals and blank nodes are never result nodes; whether an IRI is an
 * entity of the graph (rather than a predicate, say) is the graph's to tell.
 */
export function resultIris(results: SparqlResults | null): string[] {
  if (!results) return [];
  const seen = new Set<string>();
  for (const row of results.rows) {
    for (const term of row) {
      if (term?.type === "uri" && !seen.has(term.value)) seen.add(term.value);
    }
  }
  return [...seen];
}

export interface CameraTarget {
  x: number;
  y: number;
  ratio: number;
}

/** The camera that frames these points, or null with none. */
export function frameTarget(points: Iterable<{ x: number; y: number }>): CameraTarget | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const p of points) {
    count += 1;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (count === 0) return null;
  const x = (minX + maxX) / 2;
  const y = (minY + maxY) / 2;
  // One node has no span, so the floor below is what centres it.
  const span = Math.max(maxX - minX, maxY - minY) * FRAME_MARGIN;
  return { x, y, ratio: Math.min(MAX_FRAME_RATIO, Math.max(SINGLE_RESULT_RATIO, span)) };
}

/** What the live region says once per explicit run, or null for none. */
export function shownOnGraph(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 result shown on the graph."
    : `${count.toLocaleString()} results shown on the graph.`;
}

/** The results header's sentence when more were hidden than were drawn
 *  (house rule 6: the true total), or null when every one was drawn. */
export function undrawnSentence(drawn: number, total: number): string | null {
  if (total <= drawn) return null;
  return `The graph shows ${drawn.toLocaleString()} of the ${total.toLocaleString()} results it had not drawn.`;
}
