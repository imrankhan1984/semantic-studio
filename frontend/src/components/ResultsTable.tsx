/*
================================================================================
FILE: frontend/src/components/ResultsTable.tsx
================================================================================

SUMMARY
    Renders SPARQL query results as a sortable, paged table: a column per
    variable, a row count, duration and page position, a truncation notice, a
    control that empties the results area, URI cells as clickable chips with a
    secondary "view in source" control, and literal cells as text (unbound
    cells shown as em dashes).

BASIC IDEA
    Presentational over one SparqlResults. Column headers toggle client-side
    sort (numeric where possible, else case-insensitive text). Clicking a URI
    chip calls onPickIri, which selects the entity and draws it if the node
    budget left it out; the small control beside it calls onViewInSource, which
    switches to View mode positioned at that entity's first line.

    Only one page of rows is in the document at a time. The server caps a
    result set at 1,000 rows, and putting all of them in a 40vh scroller buried
    the panel — so the sort runs over every row and the slice happens after it,
    which is the only ordering that lets page one show the true top rows.

    The component is memoised. Growing the graph from a result chip changes
    App's state several times over — the neighbourhood, what the merge added,
    the live-region sentence — and every one of those renders QueryPanel again.
    Without the memo the table under the user's cursor would be rebuilt each
    time for no change at all. It only bites while all four props keep their
    identity, which is why QueryPanel and App hand over callbacks that do.

INPUTS / INPUT SOURCES (props)
    - results: the SparqlResults to display.
    - onPickIri: select an entity when its result chip is clicked, drawing it
      first if it is not on the canvas.
    - onViewInSource: show that entity's first line in the raw source.
    - onClear: empty the results area, leaving the query untouched.

EXPECTED OUTPUT
    - The rendered results table (or an empty-result note); onPickIri and
      onViewInSource on click; onClear when the clear control is pressed.
================================================================================
*/

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SparqlResults, SparqlTerm } from "../types";

interface Props {
  results: SparqlResults;
  onPickIri: (iri: string) => void;
  onViewInSource: (iri: string, prefixed?: string) => void;
  onClear: () => void;
}

/**
 * Rows to a page. Fifteen fills the results scroller at the current row height
 * without producing a scrollbar on a typical window, so the common case needs
 * no scrolling at all.
 */
const PAGE_SIZE = 15;

/** Which pagination control was last pressed, so focus can survive the change. */
type Pressed = "first" | "prev" | "next" | "last";

/** What a URI cell shows: the label if there is one, else the shortened IRI. */
function chipLabel(term: SparqlTerm): string {
  return term.label || term.prefixed || term.value;
}

function sortValue(term: SparqlTerm | null): string | number {
  if (!term) return "";
  if (term.type === "literal") {
    const asNumber = Number(term.value);
    return Number.isNaN(asNumber) || term.value.trim() === "" ? term.value.toLowerCase() : asNumber;
  }
  return (term.label ?? term.value).toLowerCase();
}

function ResultsTable({ results, onPickIri, onViewInSource, onClear }: Props) {
  const [sort, setSort] = useState<{ column: number; asc: boolean } | null>(null);
  const [page, setPage] = useState(0);

  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef<Pressed | null>(null);

  const rows = useMemo(() => {
    if (!sort) return results.rows;
    const copy = [...results.rows];
    copy.sort((a, b) => {
      const left = sortValue(a[sort.column]);
      const right = sortValue(b[sort.column]);
      if (left === right) return 0;
      const result = left < right ? -1 : 1;
      return sort.asc ? result : -result;
    });
    return copy;
  }, [results.rows, sort]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Clamped rather than trusted: a new, shorter result set arrives one render
  // before the effect below can reset `page`, and slicing past the end would
  // show an empty table for that frame.
  const current = Math.min(page, pageCount - 1);

  // The row at position 170 of the old result set has no claim to be the same
  // row in the new one. `page` deliberately does not depend on the sort here —
  // sorting resets it in the header's own handler, so the sort memo is not
  // invalidated by paging. See the "changing page does not re-sort" test.
  useEffect(() => {
    setPage(0);
  }, [results]);

  // A control that has just become disabled cannot hold focus: the browser
  // blurs it to <body> and re-enabling never gives it back (measured in Chrome
  // 2026-07-30, see CLAUDE.md). When the press lands on an end of the range,
  // hand focus to the control that still moves the other way; otherwise the
  // pressed control is still enabled and keeps focus without help.
  useEffect(() => {
    const which = pressed.current;
    if (!which) return;
    pressed.current = null;
    if ((which === "first" || which === "prev") && current === 0) nextRef.current?.focus();
    else if ((which === "next" || which === "last") && current === pageCount - 1) {
      prevRef.current?.focus();
    }
  }, [current, pageCount]);

  const goTo = (target: number, which: Pressed) => {
    pressed.current = which;
    setPage(Math.min(Math.max(target, 0), pageCount - 1));
  };

  const visible = useMemo(
    () => rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE),
    [rows, current],
  );

  if (results.vars.length === 0) return null;

  const paged = pageCount > 1;
  const firstRow = current * PAGE_SIZE + 1;
  const lastRow = Math.min(firstRow + PAGE_SIZE - 1, rows.length);

  return (
    <div className="results">
      <div className="results-header">
        <span>
          RESULTS <span className="count">{results.rowCount.toLocaleString()}</span>
        </span>
        <span className="dim">{results.durationMs.toLocaleString()} ms</span>
        {paged && (
          <span className="results-page">
            page {current + 1} of {pageCount}
          </span>
        )}
        {results.truncated && (
          <span className="results-truncated" title="The server caps result rows">
            capped at {results.rowCount.toLocaleString()} rows
          </span>
        )}
        <div className="spacer" />
        {/* "Clear results", not "Clear": the path bar already has a control
            called Clear path, and two controls sharing a word while doing
            different things is a defect in itself. */}
        <button
          className="ghost results-clear"
          onClick={onClear}
          title="Empty the results area. The query is not changed"
        >
          Clear results
        </button>
      </div>
      {results.rowCount === 0 ? (
        <p className="detail-note">
          No rows matched. Try removing a filter, or making a hop OPTIONAL.
        </p>
      ) : (
        <>
          <div className="results-scroll">
            <table className="results-table">
              <thead>
                <tr>
                  {results.vars.map((name, index) => (
                    <th
                      key={name}
                      onClick={() => {
                        setSort((prev) =>
                          prev && prev.column === index
                            ? { column: index, asc: !prev.asc }
                            : { column: index, asc: true },
                        );
                        // A sort whose top the user cannot see is not a sort.
                        setPage(0);
                      }}
                      title="Sort by this column"
                    >
                      {name}
                      {sort?.column === index && <span className="sort-arrow">{sort.asc ? "▲" : "▼"}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((term, cellIndex) => (
                      <td key={cellIndex}>
                        {term === null ? (
                          <span className="dim">—</span>
                        ) : term.type === "uri" ? (
                          // The chip keeps the meaning it has always had; the
                          // source control is deliberately second, smaller and
                          // not the thing a click lands on.
                          <span className="result-cell">
                            <button
                              className="result-chip"
                              title={term.value}
                              onClick={() => onPickIri(term.value)}
                            >
                              {chipLabel(term)}
                            </button>
                            {/* Named after its own entity, not "View in
                                source": forty identical names down a column
                                tell a screen reader user nothing about which
                                row they are on. The label is explicit rather
                                than name-from-contents because the contents are
                                a decorative glyph — see architecture.md v0.16. */}
                            <button
                              className="result-source"
                              aria-label={`View ${chipLabel(term)} in source`}
                              title={`View ${chipLabel(term)} in source`}
                              onClick={() => onViewInSource(term.value, term.prefixed)}
                            >
                              <span aria-hidden="true">◧</span>
                            </button>
                          </span>
                        ) : (
                          <span className="result-literal" title={term.datatype ?? undefined}>
                            {term.value}
                            {term.lang && <span className="term-tag">@{term.lang}</span>}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {paged && (
            <nav className="results-pager" aria-label="Result pages">
              <button
                className="pager-btn"
                aria-label="First page"
                aria-disabled={current === 0}
                disabled={current === 0}
                title={current === 0 ? "Already on the first page" : "First page"}
                onClick={() => goTo(0, "first")}
              >
                <span aria-hidden="true">|◀</span>
              </button>
              <button
                ref={prevRef}
                className="pager-btn"
                aria-label="Previous page"
                aria-disabled={current === 0}
                disabled={current === 0}
                title={current === 0 ? "Already on the first page" : "Previous page"}
                onClick={() => goTo(current - 1, "prev")}
              >
                <span aria-hidden="true">◀</span>
              </button>
              {/* The region is in the document whenever there is more than one
                  page, not created on the first change — a live region added at
                  the moment its content appears is not reliably announced. */}
              <span className="results-page-status" role="status" aria-live="polite">
                Page {current + 1} of {pageCount}, showing rows {firstRow.toLocaleString()} to{" "}
                {lastRow.toLocaleString()} of {rows.length.toLocaleString()}
              </span>
              <button
                ref={nextRef}
                className="pager-btn"
                aria-label="Next page"
                aria-disabled={current === pageCount - 1}
                disabled={current === pageCount - 1}
                title={current === pageCount - 1 ? "Already on the last page" : "Next page"}
                onClick={() => goTo(current + 1, "next")}
              >
                <span aria-hidden="true">▶</span>
              </button>
              <button
                className="pager-btn"
                aria-label="Last page"
                aria-disabled={current === pageCount - 1}
                disabled={current === pageCount - 1}
                title={current === pageCount - 1 ? "Already on the last page" : "Last page"}
                onClick={() => goTo(pageCount - 1, "last")}
              >
                <span aria-hidden="true">▶|</span>
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

export default memo(ResultsTable);
