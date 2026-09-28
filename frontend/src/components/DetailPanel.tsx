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
    - imports: describe the entity from the merged view (external-access
      Stage 2). An entity defined only in an import says so, in text, under
      its name: "Imported from FOAF (read-only)".
    - revision: a project document's revision (authoring-foundations); the
      details are fetched again when it moves, so an edit shows at once. A
      project document's details also carry `names`, shown as a Names block
      listing each project language and its name, or "missing" in text.
      Refetching for a new revision keeps the details on screen until the new
      ones arrive: clearing them would unmount the form field the user just
      pressed Enter in, and drop their focus with it.
    - editing: the open project's languages, when this is its model.ttl. The
      panel then shows the Edit section (visual-modeling 5.1) above the
      statements, in place of the read-only Names block.
    - readOnlyNote: why there is no Edit section (a library ontology,
      shapes.ttl), said in one line of text (AC-4).
    - onDeleted: the entity was deleted from the form.

    The IRI under the title is a link only when linkTarget allows it (D-088):
    http and https. Any other scheme is shown as text, with Copy beside it.

EXPECTED OUTPUT
    - The rendered detail panel (or nothing when no node is selected).
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { getNodeDetails } from "../api";
import { linkTarget } from "../links";
import type { NodeDetails, TermRef } from "../types";
import EditSection from "./EditSection";

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
  /** Read the entity from the ontology together with its resolved imports. */
  imports?: boolean;
  /** A project document's revision; 0 for the library, which never moves. */
  revision?: number;
  /** The display language, which names the title; refetched when it moves. */
  language?: string | null;
  /** The project's languages, when this entity's document is its model.ttl. */
  editing?: { primaryLanguage: string; languages: string[] } | null;
  /** Why the entity cannot be edited here, when that is the document's fault. */
  readOnlyNote?: string | null;
  onDeleted?: (iri: string) => void;
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
  imports = false,
  revision = 0,
  language = null,
  editing = null,
  readOnlyNote = null,
  onDeleted,
}: Props) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The entity the details on screen describe. A new revision of the same
  // entity keeps them until the refetch lands (see the header).
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${ontologyId}|${iri}|${imports}`;
    if (shownKey.current !== key) {
      shownKey.current = key;
      setDetails(null);
    }
    setError(null);
    if (!ontologyId || !iri) return;
    setLoading(true);
    let cancelled = false;
    getNodeDetails(ontologyId, iri, imports)
      .then((d) => !cancelled && setDetails(d))
      .catch((e) => {
        if (cancelled) return;
        // Kept details are only for a refetch that succeeds: after an undo
        // of the entity's creation the refetch is a 404, and a form left on
        // screen would edit an entity that no longer exists (found in review).
        setDetails(null);
        setError(String(e.message ?? e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ontologyId, iri, imports, revision, language]);

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
  const href = linkTarget(iri);

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
          {details?.importedFrom && (
            <p className="detail-imported">Imported from {details.importedFrom} (read-only)</p>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close panel">✕</button>
      </div>

      <div className="detail-iri">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" title="Open IRI in a new tab">
            {iri}
          </a>
        ) : (
          // Not http(s): shown, never followed (D-088).
          <span className="detail-iri-text">{iri}</span>
        )}
        <button
          className="icon-btn"
          title="Copy IRI"
          // The glyph is not a name; a non-web IRI is only text, and this is
          // how it is taken elsewhere (D-088).
          aria-label="Copy IRI"
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

      {loading && !details && <p className="detail-note">Loading…</p>}
      {error && <p className="detail-error">{error}</p>}
      {readOnlyNote && <p className="detail-note detail-readonly">{readOnlyNote}</p>}

      {details && (
        <>
          {editing && ontologyId && (
            <EditSection
              key={details.iri}
              ontologyId={ontologyId}
              details={details}
              primaryLanguage={editing.primaryLanguage}
              languages={editing.languages}
              onSelect={onNavigate}
              onDeleted={(deleted) => (onDeleted ? onDeleted(deleted) : onClose())}
            />
          )}
          {details.names && !editing && (
            // Each project language and its name. "missing" is written, not
            // shown by colour: a translation still to do is a normal state of
            // work, and it has to be readable as one (5.4.2).
            <section>
              <h3>Names</h3>
              <dl className="detail-names">
                {details.names.map((name) => (
                  <div key={name.lang}>
                    <dt>{name.lang}</dt>
                    <dd className={name.value === null ? "detail-name-missing" : undefined}>
                      {name.value ?? "missing"}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
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
