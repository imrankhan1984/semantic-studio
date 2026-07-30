/*
================================================================================
FILE: frontend/src/components/ExploreStart.tsx
================================================================================

SUMMARY
    What the right-hand column shows in Explore mode when an ontology is open
    and nothing is selected: one sentence saying what the ontology contains, up
    to eight entities worth opening first, and a line naming the three ways to
    select something.

BASIC IDEA
    Explore mode is the default mode and it said nothing at all until a node was
    clicked — DetailPanel's second line of rendering is `if (!iri) return null`,
    so the panel did not exist rather than being empty. Query mode already
    solves this well with QueryStart; this is the same idea in the mode a
    newcomer actually lands in.

    Presentational only. The ranking and the sentence come from
    explore/suggestions.ts, behind useMemo keyed on the graph: without that,
    every hover that re-renders App would re-rank the whole ontology. The panel
    disappears the moment anything is selected, which for an ontology developer
    is immediately, so it costs them nothing.

INPUTS / INPUT SOURCES (props)
    - graph: the /graph response, or null while loading and after a failure.
    - loading: whether the graph request is still in flight.
    - theme: for the kind swatches, via the same kindColor the legend uses.
    - onSelect: select an entity, exactly as clicking its node does.

EXPECTED OUTPUT
    - The rendered starting panel, or nothing when there is no graph to describe.
    - onSelect(iri) when a suggestion is activated.
================================================================================
*/

import { useMemo } from "react";
import { describeContents, suggestedEntities } from "../explore/suggestions";
import type { Theme, VizGraph } from "../types";
import { KIND_LABELS, kindColor } from "../types";

interface Props {
  graph: VizGraph | null;
  loading: boolean;
  theme: Theme;
  onSelect: (iri: string) => void;
}

/** The heading this panel is named by, referenced from its own aria-labelledby. */
const HEADING_ID = "explore-start-heading";

export default function ExploreStart({ graph, loading, theme, onSelect }: Props) {
  // Both memos are keyed on the graph object, which changes only when a graph is
  // fetched. The ranking is a pass over every node — 40,000 of them for the
  // largest ontology measured — and App re-renders on things as ordinary as a
  // hover, so this is the difference between 3 ms per load and 3 ms per render.
  const suggestions = useMemo(() => suggestedEntities(graph), [graph]);
  const summary = useMemo(() => describeContents(graph), [graph]);

  if (loading) {
    return (
      <aside className="explore-start" aria-labelledby={HEADING_ID}>
        <h2 id={HEADING_ID}>Explore</h2>
        <p className="hint">Loading…</p>
      </aside>
    );
  }

  // No graph and not loading means the request failed, and the error bar above
  // is already carrying that. An empty panel is better than a confident summary
  // of an ontology nobody managed to read.
  if (!graph) return null;

  return (
    <aside className="explore-start" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID}>Explore</h2>
      <p className="explore-summary">{summary}</p>

      {suggestions.length > 0 && (
        <section>
          <h3>Start with one of these</h3>
          <div className="starter-list">
            {suggestions.map((entity) => (
              <button
                key={entity.id}
                className="starter"
                onClick={() => onSelect(entity.id)}
                title={entity.id}
              >
                <span className="starter-title">
                  {/* Decorative: the kind is written out on the line below, so
                      nothing on this panel depends on colour. The graph's kind
                      encoding still does, which is backlog G-2 and is not fixed
                      here. */}
                  <span
                    className="dot"
                    aria-hidden="true"
                    style={{ background: kindColor(entity.kind, theme) }}
                  />
                  {entity.label}
                </span>
                <span className="starter-detail">
                  {KIND_LABELS[entity.kind] ?? KIND_LABELS.other} ·{" "}
                  {entity.degree.toLocaleString()}{" "}
                  {entity.degree === 1 ? "connection" : "connections"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="hint">Or click any node in the graph, or search for one by name.</p>
    </aside>
  );
}
