/*
================================================================================
FILE: frontend/src/components/CatalogueList.tsx
================================================================================

SUMMARY
    The list of suggested public ontologies, rendered as one button per
    CATALOGUE entry. Used by both the Load dialog's "Suggested" tab and the
    start screen's "Try one" section.

BASIC IDEA
    Two screens offer the same four ontologies, and two separate renderings of
    the same constant would drift: a change to the ordering (backlog L-1, built
    2026-07-30) or to an entry's wording would land on one screen and not the
    other. So the markup lives here once and both callers pass in their own
    busy state and their own pick handler. L-1 was the anticipated case and it
    behaved: reordering CATALOGUE and giving each entry an audience line reached
    both screens through this one component.

    It is deliberately presentational. It does not fetch, does not hold the
    in-flight id, and does not know what happens after a pick — the caller owns
    all of that, because the dialog closes on success and the start screen is
    replaced by the graph.

INPUTS / INPUT SOURCES (props)
    - fetchingId: the entry currently downloading, or null.
    - busy: true while any download is in flight; disables every row.
    - onPick: called with the chosen entry.
    Plus the CATALOGUE constant.

EXPECTED OUTPUT
    - One <button> per catalogue entry, in CATALOGUE order, each announcing its
      name, description, size and the line saying who it suits.
================================================================================
*/

import { CATALOGUE, type CatalogueEntry } from "../catalogue";

interface Props {
  /** The entry being downloaded right now, or null. */
  fetchingId: string | null;
  /** True while any download is in flight: every row is disabled. */
  busy: boolean;
  onPick: (entry: CatalogueEntry) => void;
}

export default function CatalogueList({ fetchingId, busy, onPick }: Props) {
  return (
    <div className="catalogue">
      {CATALOGUE.map((entry) => (
        <button
          key={entry.id}
          className="catalogue-entry"
          disabled={busy}
          onClick={() => onPick(entry)}
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
      ))}
    </div>
  );
}
