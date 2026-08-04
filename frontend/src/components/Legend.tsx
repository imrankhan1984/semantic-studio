/*
================================================================================
FILE: frontend/src/components/Legend.tsx
================================================================================

SUMMARY
    The docked legend + filter rail beside the graph. Lists node kinds (with
    counts) and relation kinds with their colours, and lets the user toggle a
    node kind's visibility in the graph. Collapsible to a thin strip.

BASIC IDEA
    Purely presentational over data passed in. Activating a node-kind row calls
    onToggleKind; the parent (App) tracks hidden kinds and GraphView dims them.
    A collapsed state saves space on small screens.

    Every row that does something is a <button>, and that is the whole of this
    file's accessibility story. They were <div onClick> until 2026-07-31, which
    looked identical and was unreachable: the legend is the application's only
    filtering mechanism and it could not be operated without a pointer. A toggle
    that changes something elsewhere rather than navigating carries aria-pressed,
    so the state is announced rather than left to a CSS opacity; the collapse
    header carries aria-expanded and names the panel it controls.

    The Relations rows do nothing and stay non-interactive, as a plain list. A
    control that does nothing is worse than text.

INPUTS / INPUT SOURCES (props)
    - theme: for the swatch colours.
    - kindCounts: node count per kind (from graph stats).
    - edgeKinds: which relation kinds are present.
    - hiddenKinds + onToggleKind: the show/hide filter state and its setter.

EXPECTED OUTPUT
    - The rendered legend/filter rail (or a collapsed toggle button).
================================================================================
*/

import { useState } from "react";
import type { Theme } from "../types";
import { KIND_LABELS, PALETTES, kindColor } from "../types";

interface Props {
  theme: Theme;
  kindCounts: Record<string, number>;
  edgeKinds: string[];
  hiddenKinds: Set<string>;
  onToggleKind: (kind: string) => void;
}

const EDGE_LABELS: Record<string, string> = {
  subClassOf: "subclass of",
  subPropertyOf: "subproperty of",
  domain: "domain",
  range: "range",
  instanceOf: "instance of",
  assertion: "property assertion",
  broader: "broader",
  related: "related",
  inScheme: "in scheme",
  member: "member",
  equivalentClass: "equivalent class",
  equivalentProperty: "equivalent property",
  disjointWith: "disjoint with",
  inverseOf: "inverse of",
  sameAs: "same as",
  seeAlso: "see also",
};

/** What the collapse header controls, named so aria-controls can point at it. */
const PANEL_ID = "legend-panel";

export default function Legend({ theme, kindCounts, edgeKinds, hiddenKinds, onToggleKind }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const kinds = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  if (kinds.length === 0) return null;
  const palette = PALETTES[theme];

  if (collapsed) {
    return (
      <div className="legend collapsed">
        {/* Same control as the expanded header, in its collapsed shape: one
            aria-expanded, so a screen reader says "Legend and filters,
            collapsed" from the state rather than from a second string that
            would have to be kept in step with it. */}
        <button
          className="legend-toggle"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-controls={PANEL_ID}
          aria-label="Legend and filters"
          title="Show legend and filters"
        >
          <span className="legend-toggle-icon" aria-hidden="true">
            ▸
          </span>
          <span className="legend-toggle-text" aria-hidden="true">
            LEGEND &amp; FILTERS
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="legend">
      <button
        className="legend-header"
        onClick={() => setCollapsed(true)}
        aria-expanded={true}
        aria-controls={PANEL_ID}
        aria-label="Legend and filters"
        title="Collapse"
      >
        <strong>Legend &amp; filters</strong>
        <span aria-hidden="true">◂</span>
      </button>
      <div id={PANEL_ID}>
        <div className="legend-section">Nodes — click to show/hide</div>
        {kinds.map(([kind, count]) => (
          // The name is stated rather than left to be computed from contents.
          // next-steps-dropdown measured a consumer reading a `title` instead
          // of the contents, and the count here is part of what the row means:
          // a test asserts the label and the visible text agree so the two
          // cannot drift.
          //
          // aria-pressed is TRUE when the kind is hidden — the control's job is
          // "hide this kind", and pressing it in is what hides it.
          <button
            key={kind}
            className={hiddenKinds.has(kind) ? "legend-row off" : "legend-row"}
            onClick={() => onToggleKind(kind)}
            aria-pressed={hiddenKinds.has(kind)}
            aria-label={`${KIND_LABELS[kind] ?? kind}, ${count}`}
            title="Toggle visibility"
          >
            <span className="dot" style={{ background: kindColor(kind, theme) }} />
            <span className="legend-label">{KIND_LABELS[kind] ?? kind}</span>
            <span className="legend-count">{count}</span>
          </button>
        ))}
        {edgeKinds.length > 0 && (
          <>
            <div className="legend-section">Relations</div>
            {/* A list, not a set of controls. These rows filter nothing and
                never have; making them buttons to match the ones above would
                put a dozen dead stops in the tab order. */}
            <ul className="legend-list">
              {edgeKinds.map((kind) => (
                <li key={kind} className="legend-row static">
                  <span
                    className="line"
                    style={{ background: palette.edge[kind] ?? palette.defaultEdge }}
                  />
                  <span className="legend-label">{EDGE_LABELS[kind] ?? kind}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
