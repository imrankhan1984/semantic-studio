import { useMemo, useState } from "react";
import type { SparqlResults, SparqlTerm } from "../types";

interface Props {
  results: SparqlResults;
  onPickIri: (iri: string) => void;
}

function sortValue(term: SparqlTerm | null): string | number {
  if (!term) return "";
  if (term.type === "literal") {
    const asNumber = Number(term.value);
    return Number.isNaN(asNumber) || term.value.trim() === "" ? term.value.toLowerCase() : asNumber;
  }
  return (term.label ?? term.value).toLowerCase();
}

export default function ResultsTable({ results, onPickIri }: Props) {
  const [sort, setSort] = useState<{ column: number; asc: boolean } | null>(null);

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

  if (results.vars.length === 0) return null;

  return (
    <div className="results">
      <div className="results-header">
        <span>
          RESULTS <span className="count">{results.rowCount.toLocaleString()}</span>
        </span>
        <span className="dim">{results.durationMs.toLocaleString()} ms</span>
        {results.truncated && (
          <span className="results-truncated" title="The server caps result rows">
            capped at {results.rowCount.toLocaleString()} rows
          </span>
        )}
      </div>
      {results.rowCount === 0 ? (
        <p className="detail-note">
          No rows matched. Try removing a filter, or making a hop OPTIONAL.
        </p>
      ) : (
        <div className="results-scroll">
          <table className="results-table">
            <thead>
              <tr>
                {results.vars.map((name, index) => (
                  <th
                    key={name}
                    onClick={() =>
                      setSort((prev) =>
                        prev && prev.column === index
                          ? { column: index, asc: !prev.asc }
                          : { column: index, asc: true },
                      )
                    }
                    title="Sort by this column"
                  >
                    {name}
                    {sort?.column === index && <span className="sort-arrow">{sort.asc ? "▲" : "▼"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((term, cellIndex) => (
                    <td key={cellIndex}>
                      {term === null ? (
                        <span className="dim">—</span>
                      ) : term.type === "uri" ? (
                        <button
                          className="result-chip"
                          title={term.value}
                          onClick={() => onPickIri(term.value)}
                        >
                          {term.label || term.prefixed || term.value}
                        </button>
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
      )}
    </div>
  );
}
