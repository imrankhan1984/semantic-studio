/*
================================================================================
FILE: frontend/src/components/SourceView.tsx
================================================================================

SUMMARY
    The View tab. Shows the ontology's source text with line numbers and syntax
    highlighting, an Original / Formatted-Turtle toggle, find-in-file with match
    navigation, copy, safe handling of very large files, and a way in from a
    query result: given a target entity it scrolls to and highlights the first
    line that mentions it.

BASIC IDEA
    Fetches /source (original or pretty). To keep an 8 MB file from freezing the
    browser, only a window of lines is rendered at once ("show more" / search
    reveal more). Search runs over the whole loaded document (not just the
    rendered window) and scrolls the active match into view. The correct
    highlighter (Turtle vs XML) is chosen from the format.

    A `target` is the same idea driven from outside: "View in source" on a
    result row hands over one entity, this locates it with findTargetLine and
    reports back through onTargetResolved so App can announce a miss. It is
    kept apart from the find-in-file state — a different highlight class and a
    different line — because the two are answering different questions and a
    user who then searches for something else should not lose the target.

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology's source to show (null = empty state).
    - target: an entity to scroll to and highlight, or null.
    - onTargetResolved: called with the outcome, so App can say what happened.
    Plus getSource (the API) and highlighterFor (the tokenizer picker).

EXPECTED OUTPUT
    - The rendered, searchable, highlighted source pane, positioned at the
      target when there is one.
================================================================================
*/

import { useEffect, useMemo, useRef, useState } from "react";
import { getSource } from "../api";
import { findTargetLine, targetMissingMessage } from "../sourceTarget";
import type { SourceTarget } from "../sourceTarget";
import { highlighterFor } from "../sparql/highlight";
import type { OntologySource } from "../types";

interface Props {
  ontologyId: string | null;
  /** The entity to position on. A fresh object each time it is requested, so
   *  asking for the same entity twice re-runs the lookup and re-scrolls. */
  target?: SourceTarget | null;
  /** null when the target was found, otherwise the sentence explaining why not. */
  onTargetResolved?: (missing: string | null) => void;
}

/** Lines rendered at once; more are revealed on demand or by a search hit. */
const WINDOW = 800;

/** The heading focus lands on when the mode switches, and the pane's name. */
const HEADING_ID = "source-view-heading";

export default function SourceView({ ontologyId, target = null, onTargetResolved }: Props) {
  const [source, setSource] = useState<OntologySource | null>(null);
  const [pretty, setPretty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(WINDOW);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Held in a ref rather than listed as a dependency: App re-renders on every
  // hover, and a callback identity in the effect below would re-run the lookup
  // and re-announce each time. GraphView holds onExpanded the same way.
  const resolvedRef = useRef(onTargetResolved);
  resolvedRef.current = onTargetResolved;

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

  // Arriving from a result row: move focus to the heading before anything has
  // loaded. The control that was pressed is in the query panel, which this pane
  // now covers, so leaving focus on it would leave it on nothing — and waiting
  // for the fetch would send any keystroke made in between wherever the browser
  // fell back to. Keyed on `target`, so switching to View from the tab bar does
  // not steal focus from the tab the user just pressed.
  useEffect(() => {
    if (target) headingRef.current?.focus();
  }, [target]);

  // Locate the target once there is a document to look in, then reveal enough
  // of it to contain the line and scroll there.
  //
  // The `!source` guard is load-bearing rather than defensive: without it this
  // runs against an empty `lines` while the fetch is still in flight, finds
  // nothing, and announces that the entity is not in a file nobody has read yet.
  useEffect(() => {
    if (!target) {
      setTargetLine(null);
      return;
    }
    if (!source) return;
    const line = findTargetLine(lines, target);
    setTargetLine(line === -1 ? null : line);
    if (line === -1) {
      resolvedRef.current?.(targetMissingMessage(source.truncated));
      return;
    }
    resolvedRef.current?.(null);
    setVisible((current) => (line + 20 > current ? line + 200 : current));
    // Smooth is motion, so it asks. index.css does carry a global
    // prefers-reduced-motion rule now, and it cannot help here: that rule
    // reaches `scroll-behavior` and this is the `behavior` option of a
    // scrollIntoView call, which no stylesheet can override.
    // `matchMedia` is guarded because jsdom leaves it undefined.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The same deferral goToMatch uses: the line may only have just been
    // revealed, so the element it scrolls to does not exist until React commits.
    window.setTimeout(() => {
      scrollRef.current
        ?.querySelector(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    }, 40);
  }, [lines, source, target]);

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
    <div className="source-view" aria-labelledby={HEADING_ID}>
      <div className="source-toolbar">
        {/* tabIndex -1: script-focusable and not a tab stop, the same
            arrangement DetailPanel's heading uses. Until now this pane had no
            heading at all, so there was nothing for a mode change to land on
            and nothing naming the region. */}
        <h2 id={HEADING_ID} ref={headingRef} tabIndex={-1} className="source-title">
          Source
        </h2>
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
                  // Two independent highlights, not one: `active` is the current
                  // find-in-file hit and `target` is where a result row sent us.
                  // Searching afterwards must not throw the target away.
                  className={
                    "sparql-line source-line" +
                    (index === activeLine ? " active" : "") +
                    (index === targetLine ? " target" : "")
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
