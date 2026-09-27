/*
================================================================================
FILE: frontend/src/components/SparqlEditor.tsx
================================================================================

SUMMARY
    The SPARQL text editor that takes the preview's place in Query mode when
    the user asks for it (spec sparql-text-and-query-files): a labelled
    textarea, the fork notice with its way back, and Run, Save, Download .rq,
    Open .rq file, Insert prefixes and Close editor.

BASIC IDEA
    It opens in one of two conditions. Opened on the builder's query, it shows
    the generated text and the query is still visual; the first change calls
    onFork and from then on the text is the query (D-071). Opened as a text
    query -- from nothing, a file, the ontology or a saved text query -- it
    starts from the text it was handed.

    The text lives in this component's own state and is reported upward
    through a ref-writing callback, so a keystroke renders this component and
    nothing above it: not the panel, not the results table, not App and the
    graph under it. The parent keys it on the text query's session, so a new
    query starts a fresh editor, while a fork keeps this one and the caret the
    user is typing at.

    A plain textarea, deliberately (spec Section 15, question 1): no editor
    library, so no dependency, and Tab keeps its native meaning of moving
    focus, which is what keeps a keyboard user from being trapped in it.
    Everything the user or a file supplies is rendered by React as text.

INPUTS / INPUT SOURCES (props)
    - generated: the builder's text, shown while the query is still visual.
    - textQuery: the builder hook's text query, or null while visual.
    - initialText: the live text held by the hook, for a remount.
    - namespaces: the ontology's prefixes, for Insert prefixes.
    - running / error / saveLabel: the panel's run and save state.
    - onFork / onChange / onRun / onSave / onDownload / onOpenFile / onBack /
      onClose: the panel's handlers.

EXPECTED OUTPUT
    - The editor region, and calls to the handlers above.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { TextQuery } from "../sparql/useQueryBuilder";
import { insertPrefixes } from "../sparql/textQuery";

interface Props {
  generated: string;
  textQuery: TextQuery | null;
  initialText: string;
  namespaces: Record<string, string>;
  running: boolean;
  error: string | null;
  /** "Save", or "Update" when a saved query is open. */
  saveLabel: string;
  saveTitle: string;
  onFork: (text: string, baseline: string) => void;
  onChange: (text: string) => void;
  onRun: (text: string) => void;
  onSave: () => void;
  onDownload: (text: string) => void;
  onOpenFile: (file: File) => void;
  onBack: () => void;
  onClose: () => void;
}

export const FORK_NOTICE = "This query is now text. The graph and the path bar no longer change it.";

export default function SparqlEditor({
  generated,
  textQuery,
  initialText,
  namespaces,
  running,
  error,
  saveLabel,
  saveTitle,
  onFork,
  onChange,
  onRun,
  onSave,
  onDownload,
  onOpenFile,
  onBack,
  onClose,
}: Props) {
  const [text, setText] = useState(() => (textQuery ? initialText : generated));
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // While the query is visual the builder owns the text, so a step added on
  // the graph shows up here too. After the fork this component owns it.
  const value = textQuery ? text : generated;
  const readOnly = !!textQuery?.runBlocked;
  const runReason = textQuery?.runBlocked ?? null;

  // Focus enters the editor when it opens (AC-15). A fork does not remount
  // it, so typing is never interrupted by this.
  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const change = (next: string) => {
    setText(next);
    if (textQuery) onChange(next);
    else onFork(next, generated);
  };

  const run = () => {
    if (running || runReason || !value.trim()) return;
    onRun(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter runs. Tab is left alone on purpose: a textarea moves focus on
    // Tab by default, and inserting a tab character would trap a keyboard user.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  };

  return (
    <div className="sparql-editor">
      {textQuery?.forkedFrom && (
        // role="status" so it is announced once, when the fork happens. Its
        // text never changes afterwards, so it is never announced again.
        <div className="fork-notice" role="status">
          <span>{FORK_NOTICE}</span>{" "}
          <button className="link-btn" onClick={onBack}>
            Back to the visual version
          </button>
        </div>
      )}
      {textQuery?.name && <p className="sparql-editor-name">{textQuery.name}</p>}
      {textQuery?.note && <p className="query-hint">{textQuery.note}</p>}
      {runReason && <p className="query-hint">{runReason}</p>}
      {error && <p className="detail-error">{error}</p>}

      <textarea
        ref={areaRef}
        className="sparql-textarea"
        aria-label="SPARQL query text"
        aria-describedby="sparql-editor-help"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        rows={9}
        value={value}
        readOnly={readOnly}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p id="sparql-editor-help" className="visually-hidden">
        Press Ctrl+Enter to run the query. Tab moves to the next control.
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {running ? "Running query…" : ""}
      </p>

      <div className="query-toolbar sparql-editor-actions">
        <button
          className="primary"
          disabled={running || !!runReason || !value.trim()}
          onClick={run}
          aria-label={runReason ? `Run. ${runReason}` : undefined}
          title={runReason ?? "Run the query (Ctrl+Enter)"}
        >
          {running ? "Running…" : "▶ Run  Ctrl+Enter"}
        </button>
        <button className="ghost" disabled={!value.trim()} onClick={onSave} title={saveTitle}>
          ⌸ {saveLabel}
        </button>
        <button className="ghost" disabled={!value} onClick={() => onDownload(value)}>
          Download .rq
        </button>
        <button className="ghost" onClick={() => fileRef.current?.click()}>
          Open .rq file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".rq,.sparql,.txt,application/sparql-query,text/plain"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file again still fires a change.
            event.target.value = "";
            if (file) onOpenFile(file);
          }}
        />
        {textQuery && !readOnly && Object.keys(namespaces).length > 0 && (
          <button className="ghost" onClick={() => change(insertPrefixes(value, namespaces))}>
            Insert prefixes
          </button>
        )}
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>
          Close editor
        </button>
      </div>
    </div>
  );
}
