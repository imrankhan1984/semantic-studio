/*
================================================================================
FILE: frontend/src/components/GraphNotice.tsx
================================================================================

SUMMARY
    The bar above the graph canvas that says the view is showing part of the
    ontology, how much of it, and offers to draw more or fewer entities.

BASIC IDEA
    The server caps how many nodes it will hand over, so the graph a user sees
    is usually a subset. Saying nothing about that would leave a learner
    believing an 18,717-entity ontology contains 2,000 — so the two numbers are
    stated in plain words, as digits.

    The budget is a range with two ends. "Show more" doubles it, "Show less"
    halves it, and each is disabled at its own end with the reason in its title,
    because a control that silently stops working is worse than one that
    explains why. Halving is the exact inverse of doubling, so the sequence a
    user walks up is the sequence they walk back down.

    It renders nothing when the budget is not doing anything the user can act
    on: an ontology smaller than the default budget was never truncated and can
    never be reduced, so it looks exactly as it did before the budget existed.
    Truncation alone is not the test — see the early return.

    **There is no way to dismiss it, and that is the fix for defect D-2.** A ✕
    used to hide the whole bar for the rest of the session, taking Show more and
    Show less with it and leaving no way back: `noticeDismissed` in App reset
    only when the active ontology changed. The control was specified in
    partial-graph-rendering stage 1, when the bar carried a sentence and one
    button, and was kept through show-less without noticing that show-less had
    given it something worth losing. The bar stays.

INPUTS / INPUT SOURCES (props)
    - stats: the drawn/total counts, the applied budget and the truncation flag
      from GET /graph.
    - defaultBudget: the budget the server applied before the user changed
      anything, which is the floor Show less stops at. A prop rather than a
      constant because the server owns the number and an environment variable
      moves it.
    - atMaximum: true when the server clamped the requested budget, i.e. the
      view will not draw more however often the button is pressed.
    - restoreFocus: which control was pressed to produce this graph, so focus
      can be put back after App's refetch remounts the bar.
    - clearedExpansions: how many entities the budget change that produced this
      graph discarded from expansions. Reported beside the counts, in the same
      live region, only when it is above zero — a message shown every time is a
      message nobody reads. Zero on an ontology switch, which App handles.
    - onShowMore / onShowLess / onFocusRestored.

EXPECTED OUTPUT
    - A polite live region announcing the counts whenever the budget produces a
      view the user can still change, or null when it does not.
================================================================================
*/

import { useEffect, useRef } from "react";
import type { VizGraph } from "../types";

interface Props {
  stats: VizGraph["stats"];
  defaultBudget: number;
  atMaximum: boolean;
  restoreFocus: "more" | "less" | null;
  /** How many expanded entities the budget change discarded. Optional and
   *  defaulting to zero so the many callers in tests need not pass it; the one
   *  that matters, App, always does. */
  clearedExpansions?: number;
  onShowMore: () => void;
  onShowLess: () => void;
  onFocusRestored: () => void;
}

export default function GraphNotice({
  stats,
  defaultBudget,
  atMaximum,
  restoreFocus,
  clearedExpansions = 0,
  onShowMore,
  onShowLess,
  onFocusRestored,
}: Props) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const lessRef = useRef<HTMLButtonElement>(null);

  // Can the budget still come down? Derived from the two numbers rather than
  // taken as a prop, so every state of this bar is reachable in a test from a
  // stats object and one integer.
  const canReduce = stats.budget > defaultBudget;
  // Everything the ontology has is on the canvas. Distinct from atMaximum: the
  // budget can outrun the ontology long before it reaches the server's ceiling.
  const allDrawn = stats.nodeCount >= stats.nodeTotal;
  const noMoreToDraw = allDrawn || atMaximum;

  // Put focus back on the pair after a budget change.
  //
  // App sets graphData to null while the new graph is in flight, so pressing
  // either control unmounts this whole bar and focus is on <body> by the time
  // the replacement arrives. That is why the instruction is a prop from App
  // rather than a ref kept here: nothing in this component survives the press.
  //
  // Focus goes back to the control pressed, unless that press disabled it —
  // pressing Show less down to the floor — in which case it goes to its
  // partner. A disabled element cannot hold focus, and the browser drops it to
  // <body> rather than moving it anywhere useful. Measured in Chrome on
  // 2026-07-30 against the remove control; see saved-query-deletion-warning.
  useEffect(() => {
    if (!restoreFocus) return;
    const pressed = restoreFocus === "less" ? lessRef : moreRef;
    const partner = restoreFocus === "less" ? moreRef : lessRef;
    const stillUsable = restoreFocus === "less" ? canReduce : !noMoreToDraw;
    (stillUsable ? pressed : partner).current?.focus();
    // Clear the instruction even when there was nothing to focus, so a stale
    // one cannot fire against a later render.
    onFocusRestored();
  }, [restoreFocus, canReduce, noMoreToDraw, onFocusRestored]);

  // Render whenever the budget is doing something the user can act on: the
  // graph is truncated, OR everything is drawn but only because the budget was
  // raised. The old condition was `if (!stats.truncated) return null`, which
  // removed the whole bar — counts, controls and all — at exactly the moment
  // the user most wanted Show less.
  if (!stats.truncated && !canReduce) return null;

  const drawn = stats.nodeCount.toLocaleString();
  const total = stats.nodeTotal.toLocaleString();
  const floor = defaultBudget.toLocaleString();

  return (
    // role="status" + aria-live="polite" announces the counts when a truncated
    // graph loads, without stealing focus from whatever the user is doing.
    <div className="graph-notice" role="status" aria-live="polite">
      {/* aria-hidden: the icon repeats what the sentence already says, and an
          announced "information" adds nothing for a screen reader user. */}
      <span className="graph-notice-icon" aria-hidden="true">
        ⓘ
      </span>
      <span className="graph-notice-text">
        {allDrawn ? (
          // Checked before atMaximum, which can be true at the same time: ask
          // for 32,000 of FIBO's 18,717 and the server clamps to 20,000 and
          // returns every entity. "Showing all 18,717" is the truer of the two
          // sentences there, and the reason Show more is dead is the ontology
          // rather than the ceiling.
          <>Showing all {total} entities.</>
        ) : atMaximum ? (
          <>
            Showing {drawn} of {total} entities. This is the maximum this view will draw.
          </>
        ) : (
          <>
            Showing the {drawn} most connected of {total} entities. Search for anything
            that is not drawn.
          </>
        )}
        {/* Beside the counts, in the same live region, so a budget change that
            threw expansions away says so rather than shrinking silently (G-8).
            Only when it happened: the zero case is not spoken. Singular is
            spelled out because "1 expanded entities were" is the kind of grammar
            slip a learner-facing string cannot afford. */}
        {clearedExpansions > 0 && (
          <>
            {" "}
            {clearedExpansions.toLocaleString()} expanded{" "}
            {clearedExpansions === 1 ? "entity was" : "entities were"} cleared.
          </>
        )}
      </span>
      {/* Before Show more, so the pair reads in the order the range runs. */}
      <button
        className="ghost"
        ref={lessRef}
        onClick={onShowLess}
        disabled={!canReduce}
        title={canReduce ? "Draw half as many entities" : `${floor} entities is the smallest view.`}
      >
        Show less
      </button>
      <button
        className="ghost"
        ref={moreRef}
        onClick={onShowMore}
        disabled={noMoreToDraw}
        title={
          allDrawn
            ? "Every entity is already drawn."
            : atMaximum
              ? `The maximum of ${drawn} entities is already drawn.`
              : "Draw twice as many entities"
        }
      >
        Show more
      </button>
    </div>
  );
}
