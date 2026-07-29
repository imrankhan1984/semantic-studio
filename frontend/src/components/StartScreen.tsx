/*
================================================================================
FILE: frontend/src/components/StartScreen.tsx
================================================================================

SUMMARY
    The chooser the application opens on. It offers the saved library, the
    online catalogue and the two file-loading routes, and fills the main area
    whenever no ontology is active.

BASIC IDEA
    Until this screen existed, App selected the most recently added ontology on
    mount and rendered it immediately, so a user with FIBO stored met 18,717
    nodes on every page load whether they asked for one or not. The chooser is
    what replaces that: the user picks, and only then does anything load.

    The property that makes it worth having is that opening it is FREE. It
    fetches nothing, parses nothing and renders no graph — every number on it
    comes from the ontology list App has already requested. Any later change
    that adds a preview or a thumbnail here breaks that property and should be
    refused.

    Every row is a real <button>, so the whole screen is one plain tab
    sequence: library rows, then catalogue rows, then the two file routes. The
    focus ring is the global :focus-visible rule in index.css; there is
    deliberately no per-component focus style.

    The library section fails on its own. A backend that cannot list should not
    stop somebody uploading a file, so an error replaces that section and
    leaves the rest of the screen working.

INPUTS / INPUT SOURCES (props)
    - ontologies / loading / error / onRetry: the ontology list App owns, and
      the way to ask for it again.
    - onOpen: open a saved ontology by id.
    - onLoaded: a catalogue entry finished downloading (same callback the Load
      dialog uses).
    - onOpenDialog: hand the file and URL routes to the existing Load dialog,
      opened on the named tab.
    Plus fetchOntology from api.ts for a catalogue pick.

EXPECTED OUTPUT
    - The rendered chooser, and the side effects of a pick: onOpen, onLoaded,
      or the Load dialog opening on the right tab.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { fetchOntology } from "../api";
import type { CatalogueEntry } from "../catalogue";
import CatalogueList from "./CatalogueList";
import type { OntologySummary } from "../types";

interface Props {
  ontologies: OntologySummary[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onLoaded: (summary: OntologySummary) => void;
  onOpenDialog: (tab: "file" | "url") => void;
}

/**
 * "26 Jul" for a library row, or null when the ontology predates addedAt being
 * persisted. Undated is normal for an older library, so the row drops the date
 * rather than showing a placeholder.
 */
function addedOn(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * The one-line summary of a stored ontology, as a screen reader hears it:
 * "FIBO quickstart, 132,001 triples, 18,717 nodes, turtle, added 26 Jul".
 * The size is words and digits, never a colour or a bar, so a heavy ontology
 * is a visible choice however the row is consumed.
 */
function rowLabel(o: OntologySummary): string {
  const added = addedOn(o.addedAt);
  return [
    o.name,
    `${o.triples.toLocaleString()} triples`,
    `${o.nodes.toLocaleString()} nodes`,
    o.format,
    added ? `added ${added}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export default function StartScreen({
  ontologies,
  loading,
  error,
  onRetry,
  onOpen,
  onLoaded,
  onOpenDialog,
}: Props) {
  // Which catalogue entry is downloading, and what went wrong last time. Both
  // are local: nothing above this component needs to know about a download
  // that has not produced an ontology yet.
  const [fetching, setFetching] = useState<CatalogueEntry | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const firstLibraryRow = useRef<HTMLButtonElement>(null);
  // The catalogue's own first row, reached through its container rather than
  // through a ref prop, so CatalogueList stays purely presentational and both
  // callers of it render identically.
  const catalogueRef = useRef<HTMLDivElement>(null);
  // Focus is taken once per mount, not on every render, or re-rendering while
  // a download is in flight would drag focus back out of wherever the user
  // moved it.
  const focusTaken = useRef(false);

  // Take focus once the library has resolved, because until then there is no
  // first row to take it. The chooser is the only thing on screen, so taking
  // focus is correct here: it interrupts nothing.
  useEffect(() => {
    if (loading || focusTaken.current) return;
    focusTaken.current = true;
    const target =
      firstLibraryRow.current ??
      catalogueRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!target) return;

    // Mark the row so index.css can draw a ring on it. Measured in headless
    // Chrome on 2026-07-29, and the result is split, which is why the marker
    // exists at all:
    //
    //   page load          -> :focus-visible MATCHES, global rule draws it
    //   close with a mouse -> :focus-visible does NOT match, nothing is drawn
    //
    // The second line is the path this feature adds. Someone who opens an
    // ontology and presses "Close this ontology" with the pointer lands back
    // here on a focused row with no indication they are on it, and the next
    // keystroke then goes somewhere they did not expect.
    //
    // This is not the per-component focus rule CLAUDE.md forbids. That warning
    // is about duplicating the ordinary ring; :focus-visible deliberately
    // excludes this case and no global rule can express it. The marker is
    // dropped the moment focus leaves, so from then on :focus-visible is the
    // only thing drawing rings on this screen.
    target.dataset.startFocus = "";
    target.addEventListener("blur", () => delete target.dataset.startFocus, { once: true });
    target.focus();
  }, [loading]);

  const pickCatalogue = async (entry: CatalogueEntry) => {
    setFetching(entry);
    setFetchError(null);
    try {
      // The same client function the Load dialog calls, so this reaches the
      // same guarded POST /fetch and introduces no new outbound path.
      onLoaded(await fetchOntology(entry.url));
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      // Restores the row: a failure leaves the catalogue exactly as it was,
      // with the error beneath it.
      setFetching(null);
    }
  };

  const busy = fetching !== null;

  return (
    <main className="main start-screen" aria-labelledby="start-screen-title">
      <div className="start-screen-inner">
        <h1 id="start-screen-title">Semantic Studio</h1>
        <p className="start-lede">
          Open an ontology to begin. Nothing loads until you pick.
        </p>

        {/* Announces "Downloading FOAF…" without moving focus. Rendered even
            when idle: a live region added to the DOM at the same moment as its
            text is unreliably announced. */}
        <div className="start-live" role="status" aria-live="polite">
          {fetching ? `Downloading ${fetching.name}…` : ""}
        </div>

        <section className="start-section" aria-labelledby="start-library-heading">
          <h2 id="start-library-heading">Your library</h2>
          {loading ? (
            <p className="start-empty">Loading your library…</p>
          ) : error ? (
            // The library section fails alone; the catalogue and both file
            // routes below stay usable.
            <div className="start-error">
              <p className="detail-error">{error}</p>
              <button className="ghost" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : ontologies.length === 0 ? (
            <p className="start-empty">Nothing saved yet. Pick one below, or open a file.</p>
          ) : (
            <div className="start-rows">
              {ontologies.map((o, i) => (
                <button
                  key={o.id}
                  ref={i === 0 ? firstLibraryRow : undefined}
                  className="start-row"
                  disabled={busy}
                  onClick={() => onOpen(o.id)}
                  aria-label={rowLabel(o)}
                >
                  <span className="start-row-name">{o.name}</span>
                  <span className="start-row-counts">
                    {o.triples.toLocaleString()} triples · {o.nodes.toLocaleString()} nodes
                  </span>
                  <span className="start-row-meta">
                    {o.format}
                    {addedOn(o.addedAt) && ` · added ${addedOn(o.addedAt)}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="start-section" aria-labelledby="start-catalogue-heading">
          <h2 id="start-catalogue-heading">Try one</h2>
          <p className="hint">
            Well-known public ontologies — nothing is downloaded until you pick one.
          </p>
          <div ref={catalogueRef}>
            <CatalogueList
              fetchingId={fetching?.id ?? null}
              busy={busy}
              onPick={(entry) => void pickCatalogue(entry)}
            />
          </div>
          {fetchError && <p className="detail-error">{fetchError}</p>}
        </section>

        <section className="start-section" aria-labelledby="start-or-heading">
          <h2 id="start-or-heading">Or</h2>
          <div className="start-routes">
            <button onClick={() => onOpenDialog("file")}>Open a file</button>
            <button onClick={() => onOpenDialog("url")}>Load from a URL</button>
          </div>
        </section>
      </div>
    </main>
  );
}
