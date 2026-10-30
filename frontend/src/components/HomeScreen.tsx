/*
================================================================================
FILE: frontend/src/components/HomeScreen.tsx
================================================================================

SUMMARY
    The screen the application opens on, and the screen the Home control returns
    to from anywhere. It shows one library -- the person's projects and loaded
    files, most recent first, then the bundled examples and reference
    ontologies (reference-ontologies 5.2) -- as cards,
    headed with the three ways in, *New project*, *Open a file* and *Load
    from a URL*, in one row of primary buttons, and a search box
    (home-and-settings 5.2).

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
    nothing. Every number comes from the two lists App has already requested,
    and every thumbnail comes from a sketch the server computed during the
    parse that happened at ingest. Any later change that fetches a graph to
    populate a card breaks that property and should be refused — a home
    screen that parses six ontologies to draw six thumbnails is the FIBO freeze
    again in a nicer coat. (The thumbnails themselves went in
    home-and-settings 5.2, unreadable at card size; the rule stands.)

    **One library, the person's work first** (home-and-examples 5.5, D-111).
    Projects and loaded files used to sit in two sections, and a suggested
    catalogue below them downloaded from the internet, which fails behind a
    corporate proxy. The examples are now in the library itself, seeded by the
    server with no download, and always after what the person made, so they
    move down as that work grows; the catalogue lives on in Settings →
    Library.
    The order is home/libraryOrder.ts's. A file or an example card says
    *Read-only* in words, which the old section heading used to say.

    **Three ways in, in one row** (home-and-settings 5.2). The two file
    routes sat at the foot of the screen under *Or*, as grey buttons, while
    *New project* was the one blue button at the top; a person who had a
    file in hand looked for it last. They are now beside *New project*, each
    primary, and open the Load dialog on the tab each names.

    **Cards only.** Without the thumbnail a card and a row differed by
    little, and the Cards / Rows switch went with it (home-and-settings 5.2,
    Section 15 question 2). A layout once saved in this browser is ignored,
    not migrated.

    Search filters by NAME only, and the placeholder says so — "What are you
    looking for?" would invite a concept name, return nothing, and teach the
    user the feature is broken rather than absent.

    Each list fails on its own. A backend that cannot list should not stop
    somebody uploading a file, so an error is said in the library and the rest
    of the screen keeps working.

INPUTS / INPUT SOURCES (props)
    - ontologies / loading / error / onRetry: the ontology list App owns, and
      the way to ask for it again.
    - theme: which palette the cards' composition bars draw in.
    - pendingMode: a mode chosen from the header with nothing open, so the
      library heading can ask which ontology it should act on.
    - onOpen / onEnterMode / onViewSource / onRemove: what a card's controls do.
    - onOpenDialog: hand the file and URL routes to the Load dialog, on the
      tab each names.
    - projects: the project list, its state, New project and every project
      card's action, all App's.
    - onStartProject: "Start a project from this" on each library card.

EXPECTED OUTPUT
    - The rendered home screen, and the side effects of a pick: onOpen,
      onEnterMode, a project action, or the Load dialog opening on the right
      tab.
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadDocumentation } from "../api";
import { triggerDownload } from "../download";
import { libraryEntries } from "../home/libraryOrder";
import OntologyCard from "./OntologyCard";
import ProjectCard, { type ProjectActions } from "./ProjectsSection";
import type { AppMode, OntologySummary, ProjectSummary, Theme } from "../types";

/** The projects half of the library: App's list and every action on it. */
export interface HomeProjects extends ProjectActions {
  list: ProjectSummary[];
  loading: boolean;
  error: string | null;
  /** The project an action is running on, or null. */
  busyId: string | null;
  onNew: () => void;
}

/** What the library heading says when a mode was chosen with nothing open. The
 *  header tabs are no longer disabled, so pressing Explore with an empty canvas
 *  is answerable — and answering it teaches the model the disabled tabs used to
 *  hide: modes act on an ontology. */
const PENDING_HEADING: Record<AppMode, string> = {
  explore: "Choose an ontology to explore",
  query: "Choose an ontology to query",
  view: "Choose an ontology to view",
  hierarchy: "Choose an ontology to see its hierarchy",
  // Never pending in practice: the Shapes tab shows only with a project open.
  shapes: "Open a project to work on its shapes",
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
  onOpenDialog: (tab: "file" | "url") => void;
  /** The person's projects, in the library beside their files. Omitted, the
   *  library holds ontologies only and offers no New project. */
  projects?: HomeProjects;
  /** "Start a project from this" on each library card. */
  onStartProject?: (id: string) => void;
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
 *  treated as needing no host: a bundled example's "example" is one. */
function confirmationHost(source: string): string | null {
  if (source === "upload") return null;
  try {
    return new URL(source).hostname || null;
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
  onOpenDialog,
  projects,
  onStartProject,
}: Props) {
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

  const firstControl = useRef<HTMLButtonElement>(null);
  // Where focus starts when the library is empty: New project, or with no
  // projects to make, the first file route.
  const newProjectRef = useRef<HTMLButtonElement>(null);
  const openFileRef = useRef<HTMLButtonElement>(null);
  // Focus is taken once per mount, not on every render, or re-rendering while
  // an action is in flight would drag focus back out of wherever the user put
  // it.
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
  // nothing. On a first visit the first card is the first example's, so focus
  // starts on its Explore.
  const startTarget = () =>
    firstControl.current ?? newProjectRef.current ?? openFileRef.current ?? null;

  const listsLoading = loading || (projects?.loading ?? false);
  useEffect(() => {
    if (listsLoading || focusTaken.current) return;
    focusTaken.current = true;
    const target = startTarget();
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
    // Without preventScroll the browser scrolled to the target, and at
    // 1280x720 Home opened past its top (portal-foundations 5.8).
    target.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listsLoading]);

  // A card removed from its ⋮ menu takes its focused ⋮ button with it, and
  // focus would fall to the page (portal-foundations 5.7: removal lives only
  // here now). It goes to the screen's start target instead; a removal that
  // was declined left focus on the ⋮, and this does nothing.
  const shownIds = useRef(ontologies.map((o) => o.id));
  useEffect(() => {
    const was = shownIds.current;
    shownIds.current = ontologies.map((o) => o.id);
    if (!was.some((id) => !shownIds.current.includes(id))) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    startTarget()?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologies]);

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

  const busy = workingId !== null || docsBusyId !== null;
  const projectBusyId = projects?.busyId ?? null;

  const projectList = projects?.list;
  const entries = useMemo(
    () => libraryEntries(projectList ?? [], ontologies),
    [projectList, ontologies],
  );

  // Filtered by NAME only. Case-insensitive and a substring rather than a
  // prefix, because a user who remembers "quickstart" should not have to
  // remember what came before it.
  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () => (needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries),
    [entries, needle],
  );

  // One live region, and what it says depends on what just happened.
  // Documentation generation leads — it is a deliberate action the user is
  // waiting on — and its "ready" holds until the next search keystroke clears
  // it (see the search onChange).
  const announcement =
    docsStatus === "preparing"
      ? "Preparing documentation…"
      : docsStatus === "ready"
        ? "Documentation ready."
        : needle
          ? matching.length === 1
            ? "1 entry matches"
            : `${matching.length} entries match`
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
            <div className="home-controls">
              {/* The three ways in, in reading order, each the primary style:
                  they differ by their words, never by colour alone
                  (home-and-settings 5.2, 5.7). aria-disabled with a guard,
                  never disabled: a disabled button drops the focus it holds
                  (the authoring rule, wording 5.7). */}
              <div className="home-actions">
                {projects && (
                  <button
                    ref={newProjectRef}
                    className="primary large"
                    aria-disabled={projectBusyId !== null}
                    onClick={() => projectBusyId === null && projects.onNew()}
                  >
                    New project
                  </button>
                )}
                <button
                  ref={openFileRef}
                  className="primary large"
                  aria-disabled={busy}
                  onClick={() => !busy && onOpenDialog("file")}
                >
                  Open a file
                </button>
                <button className="primary large" aria-disabled={busy} onClick={() => !busy && onOpenDialog("url")}>
                  Load from a URL
                </button>
              </div>
              {/* Search is absent while the library is empty: a search box
                  over nothing is a control that cannot do anything. */}
              {!listsLoading && entries.length > 0 && (
                <>
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
                      // A finished-documentation announcement has had its
                      // moment; let the region go back to reporting matches.
                      if (docsStatus === "ready") setDocsStatus("");
                    }}
                    // Honest about what it does. Searching the CONTENTS of
                    // every saved ontology is real future work and is parked;
                    // a placeholder that invited a concept name would return
                    // nothing and teach the user the feature is broken rather
                    // than absent.
                    // Short enough to fit unclipped at 1280×720 (wording
                    // 5.7); the label above still says what it searches.
                    placeholder="Search by name"
                  />
                </>
              )}
            </div>
          </div>

          {/* Each list fails alone: what did load is still shown, and the file
              routes above stay usable. */}
          {error && (
            <div className="start-error">
              <p className="detail-error">{error}</p>
              <button className="ghost" onClick={onRetry}>
                Try again
              </button>
            </div>
          )}
          {projects?.error && <p className="detail-error">{projects.error}</p>}

          {listsLoading ? (
            <p className="start-empty">Loading your library…</p>
          ) : entries.length === 0 ? (
            !error && !projects?.error && (
              <p className="start-empty">
                Nothing here yet. Start a project, or open a file.
              </p>
            )
          ) : matching.length === 0 ? (
            <p className="start-empty">Nothing in your library matches “{query.trim()}”.</p>
          ) : (
            <div className="onto-grid">
              {matching.map((entry, i) =>
                entry.kind === "project" && projects ? (
                  <ProjectCard
                    key={entry.id}
                    project={entry.project}
                    busy={projectBusyId === entry.id}
                    disabled={projectBusyId !== null}
                    openRef={i === 0 ? firstControl : undefined}
                    onOpen={projects.onOpen}
                    onRename={projects.onRename}
                    onChangeKind={projects.onChangeKind}
                    onDuplicate={projects.onDuplicate}
                    onExport={projects.onExport}
                    onDelete={projects.onDelete}
                  />
                ) : entry.kind === "ontology" ? (
                  <OntologyCard
                    key={entry.id}
                    summary={entry.ontology}
                    theme={theme}
                    busy={busy}
                    working={workingId === entry.id}
                    firstVerbRef={i === 0 ? firstControl : undefined}
                    onOpen={onOpen}
                    onEnterMode={onEnterMode}
                    onViewSource={onViewSource}
                    onDownloadDocs={requestDocs}
                    onRemove={onRemove}
                    onStartProject={onStartProject}
                  />
                ) : null,
              )}
            </div>
          )}
          {/* A refusal (the graph is over the embed guard) or a generation
              failure, named beneath the library rather than in a way that
              leaves a broken file behind. */}
          {docsError && <p className="detail-error">{docsError}</p>}
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
