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

export default function Legend({ theme, kindCounts, edgeKinds, hiddenKinds, onToggleKind }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const kinds = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  if (kinds.length === 0) return null;
  const palette = PALETTES[theme];

  if (collapsed) {
    return (
      <div className="legend collapsed">
        <button
          className="legend-toggle"
          onClick={() => setCollapsed(false)}
          title="Show legend and filters"
        >
          <span className="legend-toggle-icon">▸</span>
          <span className="legend-toggle-text">LEGEND &amp; FILTERS</span>
        </button>
      </div>
    );
  }

  return (
    <div className="legend">
      <div className="legend-header" onClick={() => setCollapsed(true)}>
        <strong>Legend &amp; filters</strong>
        <span title="Collapse">◂</span>
      </div>
      {!collapsed && (
        <>
          <div className="legend-section">Nodes — click to show/hide</div>
          {kinds.map(([kind, count]) => (
            <div
              key={kind}
              className={hiddenKinds.has(kind) ? "legend-row off" : "legend-row"}
              onClick={() => onToggleKind(kind)}
              title="Toggle visibility"
            >
              <span className="dot" style={{ background: kindColor(kind, theme) }} />
              <span className="legend-label">{KIND_LABELS[kind] ?? kind}</span>
              <span className="legend-count">{count}</span>
            </div>
          ))}
          {edgeKinds.length > 0 && (
            <>
              <div className="legend-section">Relations</div>
              {edgeKinds.map((kind) => (
                <div key={kind} className="legend-row static">
                  <span className="line" style={{ background: palette.edge[kind] ?? palette.defaultEdge }} />
                  <span className="legend-label">{EDGE_LABELS[kind] ?? kind}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
