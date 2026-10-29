/*
================================================================================
FILE: frontend/src/components/OntologyCard.tsx
================================================================================

SUMMARY
    One entry in the home screen's library: its name and "⋮" menu, the
    sentence saying what it contains (an example's purpose instead), a
    composition bar, two facts -- how many statements, and when it was added
    or *Example* -- and *Read-only*, and three verbs (home-and-examples 5.6).

BASIC IDEA
    **No picture of the graph** (home-and-settings 5.2). The card used to
    open with a miniature of its twenty highest-degree entities, and at 75 px
    it could not be read: the three examples looked alike, a scatter of dots.
    The server still writes the sketch at ingest (`summary()` reads
    `meta.get("card")`, and nothing backfills one), so no data shape changed;
    the card simply stopped drawing it. The kind colours a learner carries
    into Explore are still here, in the composition bar.

    **The verbs live on the card.** The reference has one CONNECT button, so
    choosing what to do is a second step. Here "what to do with what" is one
    decision: someone who wants to query FIBO presses Query on the FIBO card.
    That removes the mode-routing dead end rather than solving it.

    **Nothing here fetches.** Every number comes from the OntologySummary App
    already holds. An ontology stored before its counts were kept simply has
    no composition bar; it must not trigger a parse to backfill one, which is
    why there is no fallback path that asks for a graph.

    **One sentence and two facts.** The card carried seven chips -- triples,
    entities, relations, format, loaded, source, date -- which a learner had
    to decode before choosing (design review F-9). What tells two entries
    apart is what they are about, how big they are and how new: the sentence,
    the statement count and the date. The rest is in the status bar once the
    file is open.

    The card is NOT one large target. Open is a button, the three verbs are
    buttons, the menu is a disclosure — because a card-sized button would
    announce as one unreadable run of text and offer one action where there are
    four.

INPUTS / INPUT SOURCES (props)
    - summary: the ontology, from GET /api/ontologies.
    - theme: which palette the composition bar draws in.
    - busy: something on the screen is working; every control is inert.
    - working: THIS entry is the one being worked on.
    - onOpen / onEnterMode / onViewSource / onRemove: what the controls do.
    - onStartProject: "Start a project from this" (authoring-foundations), the
      explicit way to get an editable copy of a read-only library entry.
      Omitted, the menu item is absent.

EXPECTED OUTPUT
    - One <article> with a heading, a menu, a sentence, a composition bar,
      the facts and three mode buttons, and the side effects of pressing any
      of them.
================================================================================
*/

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { describeKindCounts } from "../explore/suggestions";
import { compositionSegments } from "../home/miniature";
import { statementCount } from "../statusWords";
import type { AppMode, OntologySummary, Theme } from "../types";
import { kindColor } from "../types";

interface Props {
  summary: OntologySummary;
  theme: Theme;
  busy: boolean;
  working: boolean;
  /** Set on the first card only, so the screen can take focus on mount without
   *  HomeScreen having to reach into rendered DOM to find a control. */
  firstVerbRef?: React.RefObject<HTMLButtonElement>;
  onOpen: (id: string) => void;
  onEnterMode: (id: string, mode: AppMode) => void;
  onViewSource: (id: string) => void;
  onDownloadDocs: (id: string) => void;
  onRemove: (id: string) => void;
  onStartProject?: (id: string) => void;
}

/** The three verbs, in the header's own order so the two places a user meets
 *  them agree. `view` first because it is the least committal. */
const VERBS: { mode: AppMode; label: string; hint: string }[] = [
  { mode: "explore", label: "Explore", hint: "Browse this ontology and inspect entities" },
  { mode: "query", label: "Query", hint: "Build a SPARQL query against this ontology" },
  { mode: "view", label: "View", hint: "Read this ontology's file" },
];

/** "26 Jul", or null when the ontology predates addedAt being persisted.
 *  Undated is normal for an older library, so the card drops the fact rather
 *  than showing a placeholder. */
function addedOn(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function OntologyCard({
  summary,
  theme,
  busy,
  working,
  firstVerbRef,
  onOpen,
  onEnterMode,
  onViewSource,
  onDownloadDocs,
  onRemove,
  onStartProject,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const headingId = useId();
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus moves into the menu on open. It is the pattern next-steps-dropdown
  // established: a disclosure whose contents nobody can reach by keyboard is a
  // disclosure that only works with a mouse.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menuOpen]);

  // Something else started loading, so this card's controls went inert. An open
  // menu over disabled items is a menu that answers nothing.
  useEffect(() => {
    if (busy) setMenuOpen(false);
  }, [busy]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  // Behind useMemo, keyed on `kindCounts`, which comes straight off the list
  // response and keeps its identity for as long as the entry does: every
  // keystroke in the home screen's search box re-renders the screen.
  const segments = useMemo(
    () => compositionSegments(summary.kindCounts),
    [summary.kindCounts],
  );
  const added = addedOn(summary.addedAt);
  // A bundled example (home-and-examples 5.5) says so where other cards show
  // their date, and its purpose stands for the counted sentence: what it is
  // for says more to a first visitor than what it holds.
  const example = summary.source === "example" ? summary.example ?? null : null;
  const disabled = busy || working;

  return (
    <article
      className="onto-card"
      aria-labelledby={headingId}
      // Escape closes the menu from anywhere inside the card, including from
      // the menu items themselves, which is where focus actually is.
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <div className="onto-body">
        <div className="onto-head">
          <h3 id={headingId} className="onto-name" title={summary.name}>
            {summary.name}
          </h3>
          <div className="onto-menu-wrap">
            <button
              ref={menuButton}
              className="ghost icon-btn onto-menu-btn"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-haspopup="true"
              // Named explicitly, and the name carries the ontology: with six
              // cards on screen, six buttons all called "More" is six controls
              // a screen reader user cannot tell apart. The glyph itself
              // announces as "⋮", which is nothing.
              aria-label={`More actions for ${summary.name}`}
              // aria-disabled, never disabled: while a removal counts this
              // card's saved queries it holds focus, and a disabled button
              // drops it to the page (portal-foundations 5.7).
              aria-disabled={disabled}
              onClick={() => !disabled && setMenuOpen((was) => !was)}
            >
              <span aria-hidden="true">⋮</span>
            </button>
            {/* The element exists whether or not it is open, so aria-controls
                always names something real; its contents do not, because a menu
                item nobody can see should not be in the document.

                A plain list of buttons rather than role="menu". The ARIA menu
                pattern owes arrow-key navigation and typeahead, and a
                three-item disclosure that implements neither would announce a
                contract it does not honour. This is what next-steps-dropdown
                and about-panel both do. */}
            <div className="onto-menu" id={menuId} ref={menuRef} hidden={!menuOpen}>
              {menuOpen && (
                <>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onOpen(summary.id);
                    }}
                  >
                    Open
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onViewSource(summary.id);
                    }}
                  >
                    View source
                  </button>
                  {/* DOC-1. The confirmation an URL-sourced ontology needs, the
                      progress announcement and the download itself all live in
                      HomeScreen, which owns the live region and the screen's
                      busy state; the card only names the action and hands off
                      the id, exactly as the three items above it do. */}
                  <button
                    onClick={() => {
                      // closeMenu (not a bare setMenuOpen) so focus lands back on
                      // the ⋮ button BEFORE onDownloadDocs runs: that button is
                      // the stable "opening control" HomeScreen captures to return
                      // focus to on the dialog's three exits (DOC-1 AC-23). The
                      // menu item itself is about to unmount, so capturing it
                      // would leave the return target detached.
                      closeMenu();
                      onDownloadDocs(summary.id);
                    }}
                  >
                    Download documentation
                  </button>
                  {onStartProject && (
                    // Opens the New project form over this screen; closeMenu
                    // first so its focus trap records the stable ⋮ button as
                    // what to return to, as Download documentation does.
                    <button
                      onClick={() => {
                        closeMenu();
                        onStartProject(summary.id);
                      }}
                    >
                      Start a project from this
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => {
                      // closeMenu first, as the items above: focus waits on
                      // the ⋮ button through the count and the dialog.
                      closeMenu();
                      onRemove(summary.id);
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* L-5's sentence, reused rather than a filename. It says more about an
            ontology than its name does, and it is already tested. */}
        <p className="onto-summary">
          {example ? example.purpose : describeKindCounts(summary.kindCounts)}
        </p>

        {/* The composition bar, a picture of the sentence above it: for a file
            that sentence names the same kinds and counts in words. An example
            says its purpose instead, and its counts are the status bar's once
            it is open, so the bar carries no fact a person needs to choose. It
            is aria-hidden for that reason, and each band's title names it. */}
        {segments.length > 0 && (
          <div className="onto-bar" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.kind}
                className="onto-bar-band"
                style={{
                  width: `${segment.percent}%`,
                  background: kindColor(segment.kind, theme),
                }}
                title={`${segment.label}: ${segment.count.toLocaleString()}`}
              />
            ))}
          </div>
        )}

        {/* The two facts, and Read-only, every one of them text. Counts are the
            whole file's (summary.triples), never what a canvas drew. */}
        <ul className="onto-chips">
          <li className="chip-metric">{statementCount(summary.triples)}</li>
          {example ? (
            <li className="chip-state">Example</li>
          ) : (
            added && <li className="chip-state">Added {added}</li>
          )}
          {/* In words, on the card: the section heading that said
              "(read-only)" went when projects joined the library. */}
          <li className="chip-state">Read-only</li>
        </ul>

        <div className="onto-verbs">
          {VERBS.map((verb, i) => (
            <button
              key={verb.mode}
              ref={i === 0 ? firstVerbRef : undefined}
              className="onto-verb"
              disabled={disabled}
              // The ontology's name is in the accessible name for the same
              // reason it is on the menu button: a library of six otherwise
              // offers eighteen buttons called Explore, Query and View.
              aria-label={`${verb.label} ${summary.name}`}
              title={verb.hint}
              onClick={() => onEnterMode(summary.id, verb.mode)}
            >
              {verb.label}
            </button>
          ))}
          {working && <span className="onto-loading">Working…</span>}
        </div>
      </div>
    </article>
  );
}

/**
 * Wrapped, and it is load-bearing rather than decorative.
 *
 * The home screen re-renders on every keystroke in its search box, and a
 * library of fifty means fifty cards re-rendered per character. Every prop here
 * keeps its identity across that: `summary` comes straight off the list
 * response, the four callbacks are App's useCallbacks, and the rest are
 * primitives — so a card whose entry still matches does no work at all.
 */
export default memo(OntologyCard);
