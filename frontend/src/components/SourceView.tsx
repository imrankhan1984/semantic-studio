/*
================================================================================
FILE: frontend/src/components/SourceView.tsx
================================================================================

SUMMARY
    The View tab. Shows the ontology's source text with line numbers and syntax
    highlighting, an Original / Formatted-Turtle toggle, find-in-file with match
    navigation, copy, and safe handling of very large files.

BASIC IDEA
    Fetches /source (original or pretty). To keep an 8 MB file from freezing the
    browser, only a window of lines is rendered at once ("show more" / search
    reveal more). Search runs over the whole loaded document (not just the
    rendered window) and scrolls the active match into view. The correct
    highlighter (Turtle vs XML) is chosen from the format.

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology's source to show (null = empty state).
    Plus getSource (the API) and highlighterFor (the tokenizer picker).

EXPECTED OUTPUT
    - The rendered, searchable, highlighted source pane.
================================================================================
*/

import { useEffect, useMemo, useRef, useState } from "react";
import { getSource } from "../api";
import { highlighterFor } from "../sparql/highlight";
import type { OntologySource } from "../types";

interface Props {
  ontologyId: string | null;
}

/** Lines rendered at once; more are revealed on demand or by a search hit. */
const WINDOW = 800;

export default function SourceView({ ontologyId }: Props) {
  const [source, setSource] = useState<OntologySource | null>(null);
  const [pretty, setPretty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(WINDOW);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSource(null);
    setVisible(WINDOW);
    setError(null);
    if (!ontologyId) return;
    setLoading(true);
    let cancelled = false;
    getSource(ontologyId, pretty)
      .then((s) => !cancelled && setSource(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ontologyId, pretty]);

  const lines = useMemo(() => (source ? source.text.split("\n") : []), [source]);
  const highlight = useMemo(() => highlighterFor(source?.format ?? "turtle"), [source]);

  // Search runs over the whole document, not just the rendered window.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) hits.push(i);
      if (hits.length >= 5000) break;
    }
    return hits;
  }, [lines, query]);

  useEffect(() => setMatchIndex(0), [query]);

  const goToMatch = (next: number) => {
    if (matches.length === 0) return;
    const wrapped = (next + matches.length) % matches.length;
    setMatchIndex(wrapped);
    const line = matches[wrapped];
    // Reveal enough of the document to contain the hit before scrolling.
    setVisible((current) => (line + 20 > current ? line + 200 : current));
    window.setTimeout(() => {
      scrollRef.current
        ?.querySelector(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 40);
  };

  if (!ontologyId) {
    return (
      <div className="source-view empty">
        <p>No ontology loaded yet.</p>
        <p className="hint">Use “Load” to add one, then come back to read it here.</p>
      </div>
    );
  }

  const activeLine = matches[matchIndex];
  const needle = query.trim().toLowerCase();

  return (
    <div className="source-view">
      <div className="source-toolbar">
        <div className="mode-switch small">
          <button
            className={pretty ? "mode-tab" : "mode-tab active"}
            onClick={() => setPretty(false)}
            title="The file exactly as it was uploaded or fetched"
          >
            Original
          </button>
          <button
            className={pretty ? "mode-tab active" : "mode-tab"}
            onClick={() => setPretty(true)}
            title="Re-serialized as tidy, prefixed Turtle"
          >
            Formatted Turtle
          </button>
        </div>

        <div className="source-search">
          <input
            type="search"
            placeholder="Find in file…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToMatch(matchIndex + (e.shiftKey ? -1 : 1));
            }}
          />
          {needle.length >= 2 && (
            <>
              <span className="source-match-count">
                {matches.length === 0
                  ? "no matches"
                  : `${matchIndex + 1} of ${matches.length.toLocaleString()}`}
              </span>
              <button className="tool-btn" onClick={() => goToMatch(matchIndex - 1)} title="Previous">
                ↑
              </button>
              <button className="tool-btn" onClick={() => goToMatch(matchIndex + 1)} title="Next">
                ↓
              </button>
            </>
          )}
        </div>

        <div className="spacer" />
        {source && (
          <span className="source-meta">
            {source.format} · {source.lines.toLocaleString()} lines ·{" "}
            {(source.bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB
          </span>
        )}
        <button
          className="tool-btn"
          disabled={!source}
          onClick={() => {
            if (!source) return;
            void navigator.clipboard?.writeText(source.text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy the whole document"
        >
          {copied ? "✓ Copied" : "⧉ Copy"}
        </button>
      </div>

      {loading && <p className="detail-note">Reading the file…</p>}
      {error && <p className="detail-error">{error}</p>}

      {source?.truncated && (
        <p className="query-hint">
          This file is too large to show in full: you are reading the first{" "}
          {lines.length.toLocaleString()} lines (
          {Math.round(source.text.length / 1024).toLocaleString()} KB of{" "}
          {Math.round(source.bytes / 1024).toLocaleString()} KB). Search and Copy cover only
          this portion — Explore and Query still work across the whole ontology.
        </p>
      )}

      {source && (
        <div className="source-scroll" ref={scrollRef}>
          <pre>
            <code>
              {lines.slice(0, visible).map((line, index) => (
                <span
                  key={index}
                  data-line={index}
                  className={
                    index === activeLine ? "sparql-line source-line active" : "sparql-line source-line"
                  }
                >
                  <span className="sparql-gutter">{index + 1}</span>
                  <span className="sparql-code">
                    {highlight(line).map((token, tokenIndex) => (
                      <span key={tokenIndex} className={token.cls}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
          {visible < lines.length && (
            <button className="ghost show-more" onClick={() => setVisible(visible + WINDOW * 2)}>
              Show more — {(lines.length - visible).toLocaleString()} lines remaining
            </button>
          )}
        </div>
      )}
    </div>
  );
}
