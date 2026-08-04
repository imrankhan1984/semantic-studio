/*
================================================================================
FILE: frontend/src/components/OntologyCard.tsx
================================================================================

SUMMARY
    One entry in the home screen's library: a picture of the ontology's own
    graph, the sentence saying what it contains, chips carrying its metrics and
    status, a composition bar, three verbs, and a "⋮" menu. Renders as a card or
    as a dense row from the same markup.

BASIC IDEA
    The reference this design borrows from puts a stock icon on each card — a
    building, a cloud, a list. Semantic Studio can do better than a metaphor,
    because it already knows how to draw the thing itself. Each card carries a
    miniature of its own graph in the kind colours the canvas and the legend
    use, so a user learns the colour language here and carries it into Explore,
    and six saved ontologies are told apart before they are read.

    **The verbs live on the card.** The reference has one CONNECT button, so
    choosing what to do is a second step. Here "what to do with what" is one
    decision: someone who wants to query FIBO presses Query on the FIBO card.
    That removes the mode-routing dead end rather than solving it.

    **Nothing here fetches.** Every number comes from the OntologySummary App
    already holds, and the miniature comes from the sketch the server computed
    during the parse that happened at ingest. An ontology stored before that
    field existed simply has no picture and no composition bar; it must not
    trigger a parse to backfill one, which is why there is no fallback path that
    asks for a graph.

    The card is NOT one large target. Open is a button, the three verbs are
    buttons, the menu is a disclosure — because a card-sized button would
    announce as one unreadable run of text and offer one action where there are
    four.

INPUTS / INPUT SOURCES (props)
    - summary: the ontology, from GET /api/ontologies.
    - theme: which palette the miniature and the composition bar draw in.
    - layout: "card" or "row".
    - busy: something on the screen is working; every control is inert.
    - working: THIS entry is the one being worked on.
    - onOpen / onEnterMode / onViewSource / onRemove: what the controls do.

EXPECTED OUTPUT
    - One <article> with a heading, a picture, chips, a composition bar, three
      mode buttons and a menu, and the side effects of pressing any of them.
================================================================================
*/

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { describeKindCounts } from "../explore/suggestions";
import { CARD_MINIATURE, ROW_MINIATURE, compositionSegments, layoutSketch } from "../home/miniature";
import type { AppMode, OntologySummary, Theme } from "../types";
import { PALETTES, kindColor } from "../types";

interface Props {
  summary: OntologySummary;
  theme: Theme;
  layout: "card" | "row";
  busy: boolean;
  working: boolean;
  /** Set on the first card only, so the screen can take focus on mount without
   *  HomeScreen having to reach into rendered DOM to find a control. */
  firstVerbRef?: React.RefObject<HTMLButtonElement>;
  onOpen: (id: string) => void;
  onEnterMode: (id: string, mode: AppMode) => void;
  onViewSource: (id: string) => void;
  onRemove: (id: string) => void;
}

/** The three verbs, in the header's own order so the two places a user meets
 *  them agree. `view` first because it is the least committal. */
const VERBS: { mode: AppMode; label: string; hint: string }[] = [
  { mode: "explore", label: "Explore", hint: "Browse this ontology and inspect entities" },
  { mode: "query", label: "Query", hint: "Build a SPARQL query against this ontology" },
  { mode: "view", label: "View", hint: "Read this ontology's file" },
];

/** "26 Jul", or null when the ontology predates addedAt being persisted.
 *  Undated is normal for an older library, so the card drops the chip rather
 *  than showing a placeholder. */
function addedOn(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Where it came from, as a word. `source` is either "upload" or the URL it was
 *  fetched from, and a whole URL on a chip is unreadable — so it becomes URL,
 *  and the full address stays in the title for anyone who wants it. */
function sourceWord(source: string): string {
  return source === "upload" ? "Upload" : "URL";
}

function OntologyCard({
  summary,
  theme,
  layout,
  busy,
  working,
  firstVerbRef,
  onOpen,
  onEnterMode,
  onViewSource,
  onRemove,
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

  // Both behind useMemo, keyed on the summary rather than on the derived
  // objects: `card` and `kindCounts` come straight off the list response and
  // keep their identity for as long as the entry does. Without this, every
  // keystroke in the home screen's search box re-runs a spring layout per card,
  // which is the one place on this screen where work is done rather than
  // markup emitted.
  // The box depends on the layout, because the SVG letterboxes a viewBox that
  // does not match its container: one shared box put the card's picture in a
  // 130px column down the middle of a 320px strip. See the constants.
  const box = layout === "row" ? ROW_MINIATURE : CARD_MINIATURE;
  const miniature = useMemo(
    () => layoutSketch(summary.card?.sketch, box.width, box.height),
    [summary.card, box],
  );
  const segments = useMemo(
    () => compositionSegments(summary.kindCounts),
    [summary.kindCounts],
  );
  const palette = PALETTES[theme];
  const added = addedOn(summary.addedAt);
  const disabled = busy || working;

  return (
    <article
      className={layout === "row" ? "onto-card onto-row" : "onto-card"}
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
      {/* The ontology's own graph, its twenty highest-degree entities.
          aria-hidden because it is a picture OF the numbers stated beside it in
          words — announcing it would repeat the composition bar twice. */}
      <div className="onto-mini" aria-hidden="true">
        {miniature ? (
          <svg
            viewBox={`0 0 ${box.width} ${box.height}`}
            preserveAspectRatio="xMidYMid meet"
            focusable="false"
          >
            {miniature.lines.map((line, i) => (
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={palette.defaultEdge}
                strokeWidth={0.6}
              />
            ))}
            {miniature.points.map((point) => (
              <circle
                key={point.id}
                cx={point.x}
                cy={point.y}
                r={point.r}
                fill={kindColor(point.kind, theme)}
              />
            ))}
          </svg>
        ) : (
          // An ontology stored before the sketch existed. A dashed placeholder
          // rather than a blank space, so the grid does not go ragged, and no
          // request of any kind to fill it — see AC-15.
          <div className="onto-mini-absent" />
        )}
      </div>

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
              disabled={disabled}
              onClick={() => setMenuOpen((was) => !was)}
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
                  <button
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false);
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
        <p className="onto-summary">{describeKindCounts(summary.kindCounts)}</p>

        {/* The composition bar. Every band also appears in the counts below it
            and in the sentence above it, so nothing here is conveyed by colour
            alone — it is aria-hidden for that reason rather than despite it. */}
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

        {/* Metrics and status, every one of them text. The chip vocabulary is
            deliberately extensible: V-3's reasoner and Q-3's endpoint badges
            belong in this row when they exist, and inventing them now would put
            a badge on a card for something that does not run. */}
        <ul className="onto-chips">
          <li className="chip-metric">{summary.triples.toLocaleString()} triples</li>
          <li className="chip-metric">{summary.nodes.toLocaleString()} entities</li>
          <li className="chip-metric">{summary.edges.toLocaleString()} relations</li>
          <li className="chip-metric">{summary.format}</li>
          {/* Loaded state as a word, never as a green dot. There is no
              connection to hold open here — an ontology is either parsed in
              server memory or not — so the wording says exactly that. */}
          <li className={summary.loaded ? "chip-state chip-on" : "chip-state"}>
            {summary.loaded ? "Loaded" : "Not loaded"}
          </li>
          <li className="chip-state" title={summary.source}>
            {sourceWord(summary.source)}
          </li>
          {added && <li className="chip-state">Added {added}</li>}
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
