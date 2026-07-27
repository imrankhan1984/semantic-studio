/*
================================================================================
FILE: frontend/src/components/GraphNotice.tsx
================================================================================

SUMMARY
    The bar above the graph canvas that says the view is showing part of the
    ontology, how much of it, and offers to draw more.

BASIC IDEA
    The server caps how many nodes it will hand over, so the graph a user sees
    is usually a subset. Saying nothing about that would leave a learner
    believing an 18,717-entity ontology contains 2,000 — so the two numbers are
    stated in plain words, as digits.

    It renders nothing at all when the response was not truncated, so a small
    ontology looks exactly as it did before the budget existed.

    "Show more" doubles the budget rather than removing it. At the server's
    maximum the button is disabled and the wording changes to say so, because
    a control that silently stops working is worse than one that explains why.

INPUTS / INPUT SOURCES (props)
    - stats: the drawn/total counts and the truncation flag from GET /graph.
    - atMaximum: true when the server clamped the requested budget, i.e. the
      view will not draw more however often the button is pressed.
    - onShowMore / onDismiss: raise the budget, or hide this bar.

EXPECTED OUTPUT
    - A polite live region announcing the counts when a truncated graph loads,
      or null when nothing was truncated.
================================================================================
*/

import type { VizGraph } from "../types";

interface Props {
  stats: VizGraph["stats"];
  atMaximum: boolean;
  onShowMore: () => void;
  onDismiss: () => void;
}

export default function GraphNotice({ stats, atMaximum, onShowMore, onDismiss }: Props) {
  // Not truncated means there is nothing to disclose. Rendering an empty bar
  // would still take vertical space away from the canvas.
  if (!stats.truncated) return null;

  const drawn = stats.nodeCount.toLocaleString();
  const total = stats.nodeTotal.toLocaleString();

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
        {atMaximum ? (
          <>
            Showing {drawn} of {total} entities. This is the maximum this view will draw.
          </>
        ) : (
          <>
            Showing the {drawn} most connected of {total} entities. Search for anything
            that is not drawn.
          </>
        )}
      </span>
      <button
        className="ghost"
        onClick={onShowMore}
        disabled={atMaximum}
        title={
          atMaximum
            ? `The maximum of ${drawn} entities is already drawn.`
            : "Draw twice as many entities"
        }
      >
        Show more
      </button>
      <button
        className="ghost icon-btn"
        onClick={onDismiss}
        title="Dismiss this notice"
        aria-label="Dismiss this notice"
      >
        ✕
      </button>
    </div>
  );
}
