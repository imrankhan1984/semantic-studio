/*
================================================================================
FILE: frontend/src/components/HomeScreen.tsx
================================================================================

SUMMARY
    The screen the application opens on, and the screen the Home control returns
    to from anywhere. It shows the saved library as cards or as dense rows, with
    a search box and a view toggle above it, then the suggested catalogue, then
    the two file-loading routes.

BASIC IDEA
    This is StartScreen's successor. That screen was a list, and three things
    were wrong with it: there was no way back to it from inside the application,
    choosing a mode before choosing an ontology was a dead end, and the rows
    said too little to tell six saved ontologies apart. Cards with metrics and
    verbs answer all three, and the verbs answer the second by removing it —
    "what to do with what" is one decision, so someone who wants to query FIBO
    presses Query on the FIBO card.

    **The property that makes it worth having is StartScreen's, and it survives
    intact: opening this screen is FREE.** It fetches nothing and parses
    nothing. Every number comes from the ontology list App has already
    requested, and every thumbnail comes from a sketch the server computed
    during the parse that happened at ingest. Any later change that fetches a
    graph to populate a card breaks that property and should be refused — a home
    screen that parses six ontologies to draw six thumbnails is the FIBO freeze
    again in a nicer coat.

    **Two layouts, and the count is a default rather than a rule.** Nine or
    fewer renders cards, ten or more renders rows, and a toggle overrides that
    and is remembered. The toggle is the one addition to what was asked for, and
    the reason is that a layout which reorganises itself the moment a tenth
    ontology is added is a surprise the user cannot undo. Adding a file is not a
    request to rearrange the screen.

    **Searching does not change the layout.** The automatic choice reads the
    whole library, never the filtered subset: switching on the filtered count
    would flip the screen back and forth while typing, which is worse than
    either layout. Search filters by NAME only, and the placeholder says so —
    "What are you looking for?" would invite a concept name, return nothing, and
    teach the user the feature is broken rather than absent.

    The library section fails on its own. A backend that cannot list should not
    stop somebody uploading a file, so an error replaces that section and leaves
    the rest of the screen working.

INPUTS / INPUT SOURCES (props)
    - ontologies / loading / error / onRetry: the ontology list App owns, and
      the way to ask for it again.
    - theme: which palette the cards' miniatures draw in.
    - pendingMode: a mode chosen from the header with nothing open, so the
      library heading can ask which ontology it should act on.
    - onOpen / onEnterMode / onViewSource / onRemove: what a card's controls do.
    - onLoaded: a catalogue entry finished downloading (the same callback the
      Load dialog uses).
    - onOpenDialog: hand the file and URL routes to the existing Load dialog.
    Plus fetchOntology from api.ts for a catalogue pick, and CATALOGUE through
    CatalogueList.

EXPECTED OUTPUT
    - The rendered home screen, and the side effects of a pick: onOpen,
      onEnterMode, onLoaded, or the Load dialog opening on the right tab.
================================================================================
*/

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadDocumentation, fetchOntology } from "../api";
import type { CatalogueEntry } from "../catalogue";
import CatalogueList from "./CatalogueList";
import OntologyCard from "./OntologyCard";
import type { AppMode, OntologySummary, Theme } from "../types";

/**
 * The catalogue does not depend on the search text, and typing must not
 * re-render it: that is this screen's one stated render budget.
 *
 * The memo lives here rather than on CatalogueList itself, so the component the
 * Load dialog renders is untouched and the two callers stay identical — which
 * is the whole reason CatalogueList exists. Its three props are all stable:
 * `busy` and `fetchingId` change only when a download starts or ends, and
 * `onPick` is a useCallback below.
 */
const MemoisedCatalogue = memo(CatalogueList);

/**
 * Where the automatic layout changes over.
 *
 * Nine rather than an arbitrary number: at the application's typical width that
 * is three rows of three, which fits without meaningful scrolling. It is a
 * constant so it can move after somebody has looked at it.
 */
export const CARD_LAYOUT_MAX = 9;

/** Where the view choice is remembered. Per user rather than per ontology: it
 *  is a preference about this screen, not about anything on it. */
const LAYOUT_KEY = "semantic-studio-home-layout";

export type HomeLayout = "cards" | "rows";

/** What the library heading says when a mode was chosen with nothing open. The
 *  header tabs are no longer disabled, so pressing Explore with an empty canvas
 *  is answerable — and answering it teaches the model the disabled tabs used to
 *  hide: modes act on an ontology. */
const PENDING_HEADING: Record<AppMode, string> = {
  explore: "Choose an ontology to explore",
  query: "Choose an ontology to query",
  view: "Choose an ontology to view",
  home: "Your library",
};

interface Props {
  ontologies: OntologySummary[];
  loading: boolean;
  error: string | null;
  theme: Theme;
  /** The entry App is currently working on — counting an ontology's saved
   *  queries before its removal dialog — so that card can say so and the rest
   *  can go inert. */
  workingId: string | null;
  /** A mode picked from the header while nothing was open, or null. */
  pendingMode: AppMode | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onEnterMode: (id: string, mode: AppMode) => void;
  onViewSource: (id: string) => void;
  onRemove: (id: string) => void;
  onLoaded: (summary: OntologySummary) => void;
  onOpenDialog: (tab: "file" | "url") => void;
}

/** What Tab may land on inside the confirmation dialog. Same selector as
 *  AboutPanel: the document-bound trap wraps focus across these, so a keyboard
 *  user cannot tab out into the page behind the modal (DOC-1 AC-23). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The host a fetch-source confirmation should name, or null for an upload.
 *  Mirrors the backend's `docs_export.confirmation_host` (DOC-1, AC-14): an
 *  uploaded file is the user's own and exports without a prompt; a URL-sourced
 *  one probably has a publisher who already documents it, so the interface
 *  confirms first and names the host. A source that does not parse as a URL is
 *  treated as needing no host, which cannot happen for a real fetch. */
function confirmationHost(source: string): string | null {
  if (source === "upload") return null;
  try {
    return new URL(source).hostname || null;
  } catch {
    return null;
  }
}

/** Trigger the browser's own download of a blob. The object URL is revoked
 *  immediately after the synthetic click, so the blob is not held in memory
 *  once the download has been handed to the browser. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** The remembered view, or null for "let the count decide". Reading localStorage
 *  can throw in a locked-down browser, and a preference is never worth failing a
 *  render over. */
function storedLayout(): HomeLayout | null {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === "cards" || saved === "rows" ? saved : null;
  } catch {
    return null;
  }
}

export default function HomeScreen({
  ontologies,
  loading,
  error,
  theme,
  workingId,
  pendingMode,
  onRetry,
  onOpen,
  onEnterMode,
  onViewSource,
  onRemove,
  onLoaded,
  onOpenDialog,
}: Props) {
  // Which catalogue entry is downloading, and what went wrong last time. Both
  // are local: nothing above this component needs to know about a download that
  // has not produced an ontology yet.
  const [fetching, setFetching] = useState<CatalogueEntry | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // DOC-1. The ontology whose documentation is being generated, the one waiting
  // on a fetch-source confirmation, the last error, and where the progress
  // announcement is in its cycle. All local: nothing above this component acts
  // on a download that produces a file the browser saves rather than app state.
  const [docsBusyId, setDocsBusyId] = useState<string | null>(null);
  const [docsConfirm, setDocsConfirm] = useState<OntologySummary | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docsStatus, setDocsStatus] = useState<"" | "preparing" | "ready">("");
  // The opt-in (DOC-1 D-038): off by default, reset each time the dialog opens,
  // so the safe path is never carried over from a previous export.
  const [docsInclude, setDocsInclude] = useState(false);
  // null means "follow the count". Read once, in the initialiser, so the choice
  // survives a reload without costing a localStorage read on every render.
  const [override, setOverride] = useState<HomeLayout | null>(storedLayout);

  const firstControl = useRef<HTMLButtonElement>(null);
  // The catalogue's own first row, reached through its container rather than
  // through a ref prop, so CatalogueList stays purely presentational and both
  // callers of it render identically.
  const catalogueRef = useRef<HTMLDivElement>(null);
  // Focus is taken once per mount, not on every render, or re-rendering while a
  // download is in flight would drag focus back out of wherever the user put it.
  const focusTaken = useRef(false);
  // The confirm button of the docs dialog, focused when it opens; the dialog
  // itself, whose focusables the trap wraps across; and the control that opened
  // it (a card's ⋮ menu button), refocused on every exit — so a keyboard user is
  // returned to where they were rather than to <body>.
  const docsConfirmBtn = useRef<HTMLButtonElement>(null);
  const docsPanelRef = useRef<HTMLDivElement>(null);
  const docsReturnFocus = useRef<HTMLElement | null>(null);
  // A focus restore is owed once the current export finishes. Set in the finally
  // of generateDocs; consumed by the effect below AFTER docsBusyId clears and the
  // ⋮ button has re-enabled, because focus() on a still-disabled button does
  // nothing — the saved-query-deletion-warning defect, in this component.
  const docsRestorePending = useRef(false);

  useEffect(() => {
    if (docsConfirm) docsConfirmBtn.current?.focus();
  }, [docsConfirm]);

  // Restore focus to the opening control once generation ends (success or error,
  // AC-23), after the re-render that re-enables it.
  useEffect(() => {
    if (docsBusyId === null && docsRestorePending.current) {
      docsRestorePending.current = false;
      docsReturnFocus.current?.focus();
    }
  }, [docsBusyId]);

  // Take focus once the library has resolved, because until then there is no
  // card to take it. This screen is the only thing on screen whenever it is
  // shown — on startup and on every press of Home — so taking focus interrupts
  // nothing.
  useEffect(() => {
    if (loading || focusTaken.current) return;
    focusTaken.current = true;
    const target =
      firstControl.current ??
      catalogueRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!target) return;

    // Mark the row so index.css can draw a ring on it. Measured in headless
    // Chrome on 2026-07-29, and the result is split, which is why the marker
    // exists at all:
    //
    //   page load          -> :focus-visible MATCHES, global rule draws it
    //   close with a mouse -> :focus-visible does NOT match, nothing is drawn
    //
    // The second path is reached more often now than it was: Home is a header
    // control, so returning here with the pointer is an ordinary thing to do
    // rather than something only "Close this ontology" did. See D-022.
    target.dataset.startFocus = "";
    target.addEventListener("blur", () => delete target.dataset.startFocus, { once: true });
    target.focus();
  }, [loading]);

  const pickCatalogue = useCallback(
    async (entry: CatalogueEntry) => {
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
    },
    [onLoaded],
  );

  // Generate and download the documentation zip, excluding instance data unless
  // `includeIndividuals` is set (DOC-1 D-038). The screen goes busy so a second
  // action cannot start mid-generation, the progress cycles through the live
  // region, and a refusal — the graph being over a size guard, say — surfaces as
  // an error beneath the library rather than a saved but broken file. Focus is
  // restored on both success and error (AC-23) via the effect above.
  const generateDocs = useCallback(async (target: OntologySummary, includeIndividuals: boolean) => {
    setDocsConfirm(null);
    setDocsBusyId(target.id);
    setDocsStatus("preparing");
    setDocsError(null);
    try {
      const { blob, filename } = await downloadDocumentation(target.id, includeIndividuals);
      triggerDownload(blob, filename);
      setDocsStatus("ready");
    } catch (e: unknown) {
      setDocsError(e instanceof Error ? e.message : String(e));
      setDocsStatus("");
    } finally {
      docsRestorePending.current = true;
      setDocsBusyId(null);
    }
  }, []);

  // The card hands over an id; this decides whether a confirmation is needed. A
  // dialog is shown when there is a decision to make: a URL host to acknowledge
  // (AC-14), OR individuals the user could choose to include (D-038). An
  // uploaded ontology with no individuals has neither, so it exports straight
  // away, excluded — the common case keeps its one-click flow.
  const requestDocs = useCallback(
    (id: string) => {
      const target = ontologies.find((o) => o.id === id);
      if (!target) return;
      // The ⋮ button focused itself before this ran (OntologyCard), so this is
      // the stable control focus returns to on every exit.
      docsReturnFocus.current = document.activeElement as HTMLElement | null;
      const host = confirmationHost(target.source);
      const individuals = target.kindCounts?.individual ?? 0;
      if (host === null && individuals === 0) {
        void generateDocs(target, false);
      } else {
        setDocsInclude(false);
        setDocsError(null);
        setDocsConfirm(target);
      }
    },
    [ontologies, generateDocs],
  );

  // Dismiss the confirmation without generating anything (AC-14/AC-23). Focus
  // goes back to the control that opened it — enabled at this point, so directly.
  const cancelDocs = useCallback(() => {
    setDocsConfirm(null);
    docsReturnFocus.current?.focus();
  }, []);

  // The focus trap (AC-23), reusing AboutPanel's document-bound pattern: Escape
  // cancels, Tab and Shift+Tab wrap inside the dialog, and Tab from outside is
  // pulled back to the first control. On `document`, not the panel, because
  // clicking the panel's own prose blurs focus to <body> and a panel-scoped
  // handler would then see neither key.
  useEffect(() => {
    if (!docsConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelDocs();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = docsPanelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [docsConfirm, cancelDocs]);

  const busy = fetching !== null || workingId !== null || docsBusyId !== null;

  // Filtered by NAME only. Case-insensitive and a substring rather than a
  // prefix, because a user who remembers "quickstart" should not have to
  // remember what came before it.
  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () =>
      needle ? ontologies.filter((o) => o.name.toLowerCase().includes(needle)) : ontologies,
    [ontologies, needle],
  );

  // The automatic choice reads the WHOLE library, never `matching`. Switching
  // on the filtered count would flip the screen between layouts while the user
  // types, which is worse than either layout — AC-19.
  const automatic: HomeLayout = ontologies.length > CARD_LAYOUT_MAX ? "rows" : "cards";
  const layout = override ?? automatic;

  const chooseLayout = (next: HomeLayout) => {
    setOverride(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* a preference is not worth failing over */
    }
  };

  // One live region, and what it says depends on what just happened. A download
  // is transient and more urgent than a result count, so it wins while it runs.
  // Documentation generation is the most urgent of all — it is a deliberate
  // action the user is waiting on — so it leads, and its "ready" holds until the
  // next search keystroke clears it (see the search onChange).
  const announcement =
    docsStatus === "preparing"
      ? "Preparing documentation…"
      : docsStatus === "ready"
        ? "Documentation ready."
        : fetching
          ? `Downloading ${fetching.name}…`
          : needle
            ? matching.length === 1
              ? "1 ontology matches"
              : `${matching.length} ontologies match`
            : "";

  const heading = pendingMode ? PENDING_HEADING[pendingMode] : "Your library";

  return (
    // Both class names on purpose. `start-screen` is what carries the layout
    // and D-022's one scoped focus rule, neither of which changed; `home-screen`
    // is what this screen's own rules key on.
    <main className="main start-screen home-screen" aria-labelledby="home-screen-title">
      <div className="start-screen-inner">
        <h1 id="home-screen-title">Semantic Studio</h1>
        <p className="start-lede">
          {pendingMode
            ? "Pick an ontology below and it opens straight into that mode."
            : "Open an ontology to begin. Nothing loads until you pick."}
        </p>

        {/* Rendered even when idle: a live region added to the DOM at the same
            moment as its text is unreliably announced. */}
        <div className="start-live" role="status" aria-live="polite">
          {announcement}
        </div>

        <section className="start-section" aria-labelledby="home-library-heading">
          <div className="home-library-head">
            <h2 id="home-library-heading">{heading}</h2>
            {/* The controls sit above the library and are absent while it is
                empty: a search box over "nothing saved yet" is a control that
                cannot do anything. */}
            {!loading && !error && ontologies.length > 0 && (
              <div className="home-controls">
                <label className="visually-hidden" htmlFor="home-search">
                  Search your library by name
                </label>
                <input
                  id="home-search"
                  type="search"
                  className="home-search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    // A finished-documentation announcement has had its moment;
                    // let the region go back to reporting search matches.
                    if (docsStatus === "ready") setDocsStatus("");
                  }}
                  // Honest about what it does. Searching the CONTENTS of every
                  // saved ontology is real future work and is parked; a
                  // placeholder that invited a concept name would return
                  // nothing and teach the user the feature is broken rather
                  // than absent.
                  placeholder="Search your library by name"
                />
                <div
                  className="home-view-toggle"
                  role="group"
                  aria-label="Library view"
                >
                  <button
                    className={layout === "cards" ? "active" : undefined}
                    aria-pressed={layout === "cards"}
                    onClick={() => chooseLayout("cards")}
                  >
                    Cards
                  </button>
                  <button
                    className={layout === "rows" ? "active" : undefined}
                    aria-pressed={layout === "rows"}
                    onClick={() => chooseLayout("rows")}
                  >
                    Rows
                  </button>
                </div>
              </div>
            )}
          </div>

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
          ) : matching.length === 0 ? (
            // The catalogue below is deliberately unaffected: it is not what was
            // searched, and emptying it would look like a broken screen.
            <p className="start-empty">No saved ontology matches “{query.trim()}”.</p>
          ) : (
            <div className={layout === "rows" ? "onto-grid onto-grid-rows" : "onto-grid"}>
              {matching.map((summary, i) => (
                <OntologyCard
                  key={summary.id}
                  summary={summary}
                  theme={theme}
                  layout={layout === "rows" ? "row" : "card"}
                  busy={busy}
                  working={workingId === summary.id}
                  firstVerbRef={i === 0 ? firstControl : undefined}
                  onOpen={onOpen}
                  onEnterMode={onEnterMode}
                  onViewSource={onViewSource}
                  onDownloadDocs={requestDocs}
                  onRemove={onRemove}
                />
              ))}
            </div>
          )}
          {/* A refusal (the graph is over the embed guard) or a generation
              failure, named beneath the library rather than in a way that
              leaves a broken file behind. */}
          {docsError && <p className="detail-error">{docsError}</p>}
        </section>

        <section className="start-section" aria-labelledby="home-catalogue-heading">
          <h2 id="home-catalogue-heading">Try one</h2>
          <p className="hint">
            {ontologies.length === 0
              ? "Pick one and see what an ontology looks like — nothing is downloaded until you do."
              : "Well-known public ontologies — nothing is downloaded until you pick one."}
          </p>
          <div ref={catalogueRef}>
            <MemoisedCatalogue
              fetchingId={fetching?.id ?? null}
              busy={busy}
              onPick={pickCatalogue}
            />
          </div>
          {fetchError && <p className="detail-error">{fetchError}</p>}
        </section>

        <section className="start-section" aria-labelledby="home-or-heading">
          <h2 id="home-or-heading">Or</h2>
          <div className="start-routes">
            <button disabled={busy} onClick={() => onOpenDialog("file")}>
              Open a file
            </button>
            <button disabled={busy} onClick={() => onOpenDialog("url")}>
              Load from a URL
            </button>
          </div>
        </section>
      </div>

      {/* The confirmation dialog (AC-14/AC-16/AC-23). A real modal with a focus
          trap: it names the fetch host when there is one, offers the instance
          opt-in when there are individuals to include, and declining generates
          nothing. Escape (document handler above) and the backdrop both cancel.
          The message is not a scolding. */}
      {docsConfirm &&
        (() => {
          const host = confirmationHost(docsConfirm.source);
          const individuals = docsConfirm.kindCounts?.individual ?? 0;
          const assertions = docsConfirm.assertionCount ?? 0;
          return (
            <div className="modal-backdrop" onClick={cancelDocs}>
              <div
                ref={docsPanelRef}
                className="modal modal-confirm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="docs-confirm-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-header">
                  <h2 id="docs-confirm-title">Generate documentation?</h2>
                </div>
                {host && (
                  <p>
                    <strong>{docsConfirm.name}</strong> was fetched from{" "}
                    <code>{host}</code>. Its publisher may already document it.
                  </p>
                )}
                <p>
                  The documentation covers the schema. Instance data (named
                  individuals and their assertions) is left out unless you ask
                  for it below.
                </p>
                {individuals > 0 && (
                  <>
                    <label className="docs-optin">
                      <input
                        type="checkbox"
                        checked={docsInclude}
                        onChange={(e) => setDocsInclude(e.target.checked)}
                      />
                      Include instance examples (adds{" "}
                      {individuals.toLocaleString()}{" "}
                      {individuals === 1 ? "individual" : "individuals"},{" "}
                      {assertions.toLocaleString()}{" "}
                      {assertions === 1 ? "assertion" : "assertions"})
                    </label>
                    {docsInclude && (
                      <p className="hint docs-optin-warning">
                        This publishes instance data, not only the model.
                      </p>
                    )}
                  </>
                )}
                <div className="modal-actions">
                  <button className="ghost" onClick={cancelDocs}>
                    Cancel
                  </button>
                  <button
                    ref={docsConfirmBtn}
                    className="primary"
                    onClick={() => void generateDocs(docsConfirm, docsInclude)}
                  >
                    Generate documentation
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </main>
  );
}
