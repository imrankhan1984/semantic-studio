/*
================================================================================
FILE: frontend/src/components/CatalogueList.tsx
================================================================================

SUMMARY
    The list of suggested public ontologies, rendered as one button per
    CATALOGUE entry, in the Load dialog's "Suggested" tab. The home screen's
    "Try one" section used it too, until the bundled examples took that
    section's place (home-and-examples 5.5): Home no longer downloads anything.

BASIC IDEA
    Two screens offered the same ontologies, and two separate renderings of
    the same constant would have drifted: a change to the ordering (backlog
    L-1, built 2026-07-30) or to an entry's wording would have landed on one
    screen and not the other. So the markup lives here once and the caller
    passes in its own busy state and its own pick handler. It stays a
    component of its own with one caller, which keeps the dialog's file short
    and this list testable alone.

    It is deliberately presentational. It does not fetch, does not hold the
    in-flight id, and does not know what happens after a pick — the caller owns
    all of that, because the dialog closes on success and the home screen is
    replaced by the graph.

INPUTS / INPUT SOURCES (props)
    - fetchingId: the entry currently downloading, or null.
    - busy: true while any download is in flight; every row is
      aria-disabled, never disabled, so the row pressed keeps focus and a
      Cancel after it is the next stop (load-progress 5.3).
    - onPick: called with the chosen entry.
    - status: the load's status, drawn under the entry being fetched
      (load-progress 5.2), or after the entry a Cancel left it under.
    - statusId: which entry the status stands under.
    Plus the CATALOGUE constant.

EXPECTED OUTPUT
    - One <button> per catalogue entry, in CATALOGUE order, each announcing its
      name, description, size and the line saying who it suits.
================================================================================
*/

import { Fragment, type ReactNode } from "react";
import { CATALOGUE, type CatalogueEntry } from "../catalogue";

interface Props {
  /** The entry being downloaded right now, or null. */
  fetchingId: string | null;
  /** True while any download is in flight: every row is aria-disabled. */
  busy: boolean;
  onPick: (entry: CatalogueEntry) => void;
  /** The load's status, and the entry it stands under. */
  status?: ReactNode;
  statusId?: string | null;
}

export default function CatalogueList({ fetchingId, busy, onPick, status, statusId }: Props) {
  return (
    <div className="catalogue">
      {CATALOGUE.map((entry) => (
        <Fragment key={entry.id}>
          <button
            className="catalogue-entry"
            data-entry={entry.id}
            aria-disabled={busy}
            onClick={() => !busy && onPick(entry)}
            title={entry.url}
          >
            <span className="catalogue-name">
              {entry.name}
              {fetchingId === entry.id && (
                <span className="catalogue-loading"> · downloading…</span>
              )}
            </span>
            <span className="catalogue-desc">{entry.description}</span>
            <span className="catalogue-size">{entry.size}</span>
            {/*
              Plain text inside the button, so it joins the accessible name rather
              than needing aria-describedby. That makes the name long, and it is
              the right trade: a screen reader user hears which entry suits them
              instead of guessing from the vocabulary's initials.
            */}
            <span className="catalogue-audience">{entry.audience}</span>
          </button>
          {statusId === entry.id && status}
        </Fragment>
      ))}
    </div>
  );
}
