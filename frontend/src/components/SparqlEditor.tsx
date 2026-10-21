/*
================================================================================
FILE: frontend/src/components/SparqlEditor.tsx
================================================================================

SUMMARY
    The SPARQL text editor that takes the preview's place in Query mode when
    the user asks for it (spec sparql-text-and-query-files): a labelled
    textarea, the fork notice with its way back, and Run, Save, Download .rq,
    Open .rq file and Close editor; and, when a run fails on a prefix the
    ontology binds, Add PREFIX (query-page-rework 5.3).

BASIC IDEA
    It opens in one of two conditions. Opened on the builder's query, it shows
    the generated text and the query is still visual; the first change calls
    onFork and from then on the text is the query (D-071). Opened as a text
    query -- from nothing, a file, the ontology or a saved text query -- it
    starts from the text it was handed. A new text query is handed the
    prefixes the ontology uses, and the caret starts at its end; every
    other text is opened exactly as written, nothing added to it. What
    takes Insert prefixes' place for those is one button on the error: a
    run that fails on a prefix the ontology binds offers to add that one
    line and run again.

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
    - namespaces: every prefix the ontology binds, for Add PREFIX.
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
import { RUN_HELP, STARTED_HELP, addPrefixLine, unknownPrefix } from "../sparql/textQuery";

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

  // Focus enters the editor when it opens (AC-15), the caret at the end:
  // after a new query's prefixes, on the line where the query goes
  // (query-page-rework 5.3). A fork does not remount it, so typing is never
  // interrupted by this.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  // Add PREFIX: only for a prefix the ontology binds, as only then is there
  // a line to write. Own-key, as the prefix is the person's text.
  const missing = textQuery && !readOnly ? unknownPrefix(error) : null;
  const missingNs =
    missing !== null && Object.prototype.hasOwnProperty.call(namespaces, missing) ? namespaces[missing] : null;
  const addRef = useRef<HTMLButtonElement>(null);
  // The button takes focus when the error that offers it shows (5.5).
  useEffect(() => {
    if (missingNs !== null) addRef.current?.focus();
  }, [missingNs, error]);

  const addPrefix = () => {
    if (missing === null || missingNs === null) return;
    const next = addPrefixLine(value, missing, missingNs);
    change(next);
    onRun(next);
    // Back to the text, where the query is, once it has run again.
    areaRef.current?.focus();
  };

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
      {error && (
        <div className="detail-error sparql-error">
          <p>{error}</p>
          {missing !== null && missingNs !== null && (
            <button ref={addRef} className="ghost add-prefix" onClick={addPrefix}>
              Add PREFIX {missing}:
            </button>
          )}
        </div>
      )}

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
      {/* Visible, not only to a screen reader (5.3): it says what is in the
          box. Tab's meaning is the one part only a keyboard user needs. */}
      <p id="sparql-editor-help" className="sparql-editor-help">
        {textQuery?.fresh ? STARTED_HELP : RUN_HELP}{" "}
        <span className="visually-hidden">Tab moves to the next control.</span>
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
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>
          Close editor
        </button>
      </div>
    </div>
  );
}
