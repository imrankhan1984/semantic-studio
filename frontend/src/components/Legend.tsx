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
    A collapsed state saves space on small screens: a first visit starts
    folded under 1440 px, and the person's own choice is kept for this
    browser after that (explore-and-query-layout 5.2).

    Query starts it folded every time, whatever Explore kept, and keeps
    nothing (load-and-shapes 5.4): open, it took 208 px of a 512 px graph
    there. App remounts the legend when the mode changes, so opening it in
    Query lasts until Query is left, and Explore reads its choice again.

    Every row that does something is a <button>, and that is the whole of this
    file's accessibility story. They were <div onClick> until 2026-07-31, which
    looked identical and was unreachable: the legend is the application's only
    filtering mechanism and it could not be operated without a pointer. A toggle
    that changes something elsewhere rather than navigating carries aria-pressed,
    so the state is announced rather than left to a CSS opacity; the collapse
    header carries aria-expanded and names the panel it controls.

    The Relations rows do nothing and stay non-interactive, as a plain list. A
    control that does nothing is worse than text. So is the RDFS class line
    under Class (portal-foundations 5.3): it explains the graph's second class
    colour, and Class stays the one filter for both.

    Every lookup by kind is own-key (kindLabel, kindColor, edgeColor): a kind
    is a string from a loaded file (X-6).

INPUTS / INPUT SOURCES (props)
    - theme: for the swatch colours.
    - kindCounts: node count per kind (from graph stats).
    - rdfsClassCount: how many of the classes are RDFS-only (graph stats).
    - edgeKinds: which relation kinds are present.
    - hiddenKinds + onToggleKind: the show/hide filter state and its setter.
    - inQuery: Query's legend, folded at first and remembered nowhere.
    - localStorage `semantic-studio-legend` and the window's width, read once
      on mount for whether it starts folded.

EXPECTED OUTPUT
    - The rendered legend/filter rail (or a collapsed toggle button).
================================================================================
*/

import { Fragment, useState } from "react";
import type { Theme } from "../types";
import { PALETTES, edgeColor, kindColor, kindLabel } from "../types";
import { own } from "../theme/kinds";

interface Props {
  theme: Theme;
  kindCounts: Record<string, number>;
  rdfsClassCount?: number;
  edgeKinds: string[];
  hiddenKinds: Set<string>;
  onToggleKind: (kind: string) => void;
  inQuery?: boolean;
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

/** The person's last choice, per browser, like the theme: "open" or "folded"
 *  (explore-and-query-layout 5.2). */
export const LEGEND_KEY = "semantic-studio-legend";

/** Narrower than this, a first visit starts folded: 208 px of legend is a
 *  sixth of a 1280 px window. */
export const LEGEND_OPEN_FROM = 1440;

/**
 * Whether the legend starts folded: the person's choice if one is kept, else
 * the width rule. Read once, when the legend mounts; a resize does not refold
 * it. Storage that throws (a private window, blocked site data) leaves the
 * width rule to decide.
 */
function startsFolded(): boolean {
  try {
    const kept = localStorage.getItem(LEGEND_KEY);
    if (kept === "open") return false;
    if (kept === "folded") return true;
  } catch {
    // Fall through to the width rule.
  }
  return window.innerWidth < LEGEND_OPEN_FROM;
}

export default function Legend({
  theme,
  kindCounts,
  rdfsClassCount = 0,
  edgeKinds,
  hiddenKinds,
  onToggleKind,
  inQuery = false,
}: Props) {
  const [collapsed, setCollapsedState] = useState(() => inQuery || startsFolded());
  const setCollapsed = (folded: boolean) => {
    setCollapsedState(folded);
    if (inQuery) return;
    try {
      localStorage.setItem(LEGEND_KEY, folded ? "folded" : "open");
    } catch {
      // Not kept; the width rule decides next time.
    }
  };
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
          <Fragment key={kind}>
            <button
              className={hiddenKinds.has(kind) ? "legend-row off" : "legend-row"}
              onClick={() => onToggleKind(kind)}
              aria-pressed={hiddenKinds.has(kind)}
              aria-label={`${kindLabel(kind)}, ${count}`}
              title="Toggle visibility"
            >
              <span className="dot" style={{ background: kindColor(kind, theme) }} />
              <span className="legend-label">{kindLabel(kind)}</span>
              <span className="legend-count">{count}</span>
            </button>
            {kind === "class" && rdfsClassCount > 0 && (
              <div className="legend-row static legend-sub">
                <span className="dot" style={{ background: kindColor("class", theme, "rdfs") }} />
                <span className="legend-label">RDFS class</span>
                <span className="legend-count">{rdfsClassCount}</span>
              </div>
            )}
          </Fragment>
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
                    style={{ background: edgeColor(palette, kind) }}
                  />
                  <span className="legend-label">{own(EDGE_LABELS, kind) ?? kind}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
