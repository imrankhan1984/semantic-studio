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

INPUTS / INPUT SOURCES (props)
    - ontologyId + iri: which entity to describe (null iri = panel hidden).
    - onNavigate: select another entity when its IRI is clicked.
    - onClose: close the panel.

EXPECTED OUTPUT
    - The rendered detail panel (or nothing when no node is selected).
================================================================================
*/

import { useEffect, useState } from "react";
import { getNodeDetails } from "../api";
import type { NodeDetails, TermRef } from "../types";

interface Props {
  ontologyId: string | null;
  iri: string | null;
  onNavigate: (iri: string) => void;
  onClose: () => void;
}

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

export default function DetailPanel({ ontologyId, iri, onNavigate, onClose }: Props) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  if (!iri) return null;

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <div>
          <h2>{details?.label ?? "…"}</h2>
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
