/*
================================================================================
FILE: frontend/src/components/DetailPanel.tsx
================================================================================

SUMMARY
    The right-hand panel shown in Explore mode. When a node is selected it
    fetches and displays every statement about that entity — its outgoing
    statements and everything that references it — with clickable IRIs.

BASIC IDEA
    Clicking a node sets `iri`; this component fetches /node for it and renders
    two tables (statements, referenced-by). Each URI term is a button that
    navigates to that node (onNavigate), so the user can walk the graph through
    the panel. A cancelled flag drops a stale response if the selection changes.

    It also carries the one control that grows the graph. The canvas draws only
    the highest-degree entities the server's budget allows, so the entity being
    described is regularly not on it; "Show its connections" asks for that
    entity's neighbourhood and hands it to the graph to merge.

    With no `iri` it renders nothing, and what fills the column instead is
    ExploreStart. That is why the heading can take focus: a selection made from
    that panel replaces the very control the user was standing on, so App sets
    focusHeading and focus follows the selection here.

INPUTS / INPUT SOURCES (props)
    - ontologyId + iri: which entity to describe (null iri = panel hidden).
    - onNavigate: select another entity when its IRI is clicked.
    - onClose: close the panel.
    - focusHeading: whether this selection should move focus to the heading.
    - onExpand + expanding: draw this entity's connections on the graph, and
      whether that request is in flight.

EXPECTED OUTPUT
    - The rendered detail panel (or nothing when no node is selected).
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { getNodeDetails } from "../api";
import type { NodeDetails, TermRef } from "../types";

interface Props {
  ontologyId: string | null;
  iri: string | null;
  onNavigate: (iri: string) => void;
  onClose: () => void;
  /** True when the selection came from ExploreStart, whose row had focus and no
   *  longer exists. False for a graph click, a search pick and a term link
   *  inside this panel: those leave the user's focus where they chose to be. */
  focusHeading?: boolean;
  /** Draw this entity's connections on the canvas. Omitted, the control is not
   *  rendered at all, which is what keeps this panel usable on its own. */
  onExpand?: (iri: string) => void;
  /** An expansion is in flight. The control says so and the graph is not
   *  blocked, because the canvas stays interactive while the request runs. */
  expanding?: boolean;
}

/** The heading id, so the panel can be named by it and focus can be sent to it. */
const HEADING_ID = "detail-panel-heading";

function Term({ term, onNavigate }: { term: TermRef; onNavigate: (iri: string) => void }) {
  if (term.type === "uri") {
    // Long predicates are truncated with a CSS ellipsis, so the title has to
    // carry the readable label as well as the IRI: a truncated label is
    // precisely the text the user is trying to finish reading. The truncation
    // is visual only — nothing is shortened here, so the full string stays in
    // the accessible name.
    const display = term.label && term.label !== term.prefixed ? term.label : term.prefixed;
    return (
      <button
        className="term-link"
        title={display && display !== term.value ? `${display} — ${term.value}` : term.value}
        onClick={() => onNavigate(term.value)}
      >
        {display}
      </button>
    );
  }
  if (term.type === "literal") {
    return (
      <span className="term-literal">
        “{term.value}”
        {term.lang && <span className="term-tag">@{term.lang}</span>}
        {term.datatype && <span className="term-tag">^^{term.datatype}</span>}
      </span>
    );
  }
  return <span className="term-bnode">{term.value}</span>;
}

export default function DetailPanel({
  ontologyId,
  iri,
  onNavigate,
  onClose,
  focusHeading = false,
  onExpand,
  expanding = false,
}: Props) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setDetails(null);
    setError(null);
    if (!ontologyId || !iri) return;
    setLoading(true);
    let cancelled = false;
    getNodeDetails(ontologyId, iri)
      .then((d) => !cancelled && setDetails(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ontologyId, iri]);

  // Take focus when this selection asked for it, rather than when the details
  // arrive, because the wait is a request: keystrokes made in between would go
  // wherever the browser fell back to. The heading reads "…" for that moment,
  // and it is the panel's accessible name either way.
  //
  // Keyed on `iri` as well, so walking the panel by clicking a term link — which
  // changes `iri` with focusHeading false — cannot leave a stale true behind.
  //
  // No focus rule is needed for the heading. Activating a suggestion by keyboard
  // leaves the modality keyboard, so the global :focus-visible ring is drawn;
  // by mouse it is not, which is the case D-022 measured — and a heading is not
  // an actionable control, so there is nothing a pointer user needs telling.
  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [iri, focusHeading]);

  if (!iri) return null;

  return (
    <aside className="detail-panel" aria-labelledby={HEADING_ID}>
      <div className="detail-header">
        <div>
          {/* tabIndex -1: script-focusable, and not in the tab order, so this
              adds no stop for a keyboard user walking the panel. */}
          <h2 id={HEADING_ID} ref={headingRef} tabIndex={-1}>
            {details?.label ?? "…"}
          </h2>
          <div className="detail-prefixed">{details?.prefixed}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close panel">✕</button>
      </div>

      <div className="detail-iri">
        <a href={iri} target="_blank" rel="noreferrer" title="Open IRI in a new tab">
          {iri}
        </a>
        <button
          className="icon-btn"
          title="Copy IRI"
          onClick={() => navigator.clipboard?.writeText(iri)}
        >
          ⧉
        </button>
      </div>

      {/* Expanding adds no concept to learn: clicking a node already selects
          it, and this is one more button on a panel the user has opened. Hence
          "Show its connections" rather than "Expand the subgraph".

          It is rendered before the statements rather than after, because the
          panel is arbitrarily long and a control below several hundred rows is
          a control nobody finds. It is not disabled when the entity is off the
          canvas — that is precisely the case it exists for. */}
      {onExpand && (
        <button
          className="ghost expand-btn"
          onClick={() => onExpand(iri)}
          disabled={expanding}
          aria-busy={expanding}
          title={
            expanding
              ? "Fetching this entity's connections…"
              : "Draw this entity and everything it connects to on the graph"
          }
        >
          {expanding ? "Drawing…" : "Show its connections"}
        </button>
      )}

      {loading && <p className="detail-note">Loading…</p>}
      {error && <p className="detail-error">{error}</p>}

      {details && (
        <>
          <section>
            <h3>
              Statements <span className="count">{details.outgoingTotal}</span>
            </h3>
            <table className="detail-table">
              <tbody>
                {details.outgoing.map((row, i) => (
                  <tr key={i}>
                    <td className="pred">
                      <Term term={row.predicate} onNavigate={onNavigate} />
                    </td>
                    <td>
                      <Term term={row.object} onNavigate={onNavigate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {details.outgoingTotal > details.outgoing.length && (
              <p className="detail-note">
                Showing {details.outgoing.length} of {details.outgoingTotal} statements.
              </p>
            )}
          </section>

          <section>
            <h3>
              Referenced by <span className="count">{details.incomingTotal}</span>
            </h3>
            {details.incoming.length === 0 && <p className="detail-note">Nothing references this entity.</p>}
            <table className="detail-table">
              <tbody>
                {details.incoming.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <Term term={row.subject} onNavigate={onNavigate} />
                    </td>
                    <td className="pred">
                      <Term term={row.predicate} onNavigate={onNavigate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {details.incomingTotal > details.incoming.length && (
              <p className="detail-note">
                Showing {details.incoming.length} of {details.incomingTotal} references.
              </p>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
