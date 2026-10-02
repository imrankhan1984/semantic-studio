/*
================================================================================
FILE: frontend/src/components/TurtleEditor.tsx
================================================================================

SUMMARY
    The expert's door (authoring-foundations 5.3, D-072): View mode for a
    project document is this editor rather than the read-only source view.
    The whole document as Turtle, with line numbers; Apply (Ctrl+Enter) parses
    it and replaces the document as one undoable change; Discard edits returns
    to the document; a parse error names the line and column, with rdflib's
    own message behind a disclosure.

BASIC IDEA
    A plain textarea, as the SPARQL editor is (no editor dependency), labelled
    "Turtle source of model.ttl", and Tab is left alone so it leaves the field.
    The line numbers are a gutter beside it, aria-hidden and scrolled with it:
    they help the eye find "line 12" and say nothing a screen reader needs.

    The help line under it says how a relative IRI is read: written onto the
    project's base IRI by the server (CF-8), never resolved against a folder.

    What the user has typed and not applied lives in the project store
    (editorDraft), not here, because leaving is App's to arbitrate: switching
    mode, switching document or closing the project asks "Apply, discard, or
    stay?" before this component unmounts. While there is no draft the text
    is the server's, fetched again whenever the revision moves, so a command,
    an undo or a recovery regenerates it -- which is where formatting option A
    shows: after a visual change the text comes back as clean Turtle.

    Four states, each said in text: Clean (matches the document), Edited (not
    applied; Apply enabled), Error (line and column), and Applying.

    For shapes.ttl the toolbar gains Validate and the result panels show
    below the text (shacl-authoring 5.1, 5.6), the same check the Shapes
    view shows. Text not yet applied is not part of the document, so
    Validate waits for Apply rather than check something other than what is
    on screen. *Edit in Turtle* on a read-only shape leaves a target in the
    store; once the text is here the caret goes to the first place the
    shape is written (indexOf, never a pattern built from ontology text).

INPUTS / INPUT SOURCES (props)
    - projectId, doc, revision: what to load and when to load it again.
    - onSelectEntity, onError: a result's link and a failed check, for
      shapes.ttl's result panels.
    Plus the project store and getDocumentSource.

EXPECTED OUTPUT
    - The editor; store actions for apply and discard.
================================================================================
*/

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TurtleError, getDocumentSource } from "../api";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ProjectDocName } from "../types";
import ResultPanels, { ValidateButton } from "./ResultPanels";

interface Props {
  projectId: string;
  doc: ProjectDocName;
  revision: number;
  onSelectEntity?: (iri: string) => void;
  onError?: (message: string) => void;
}

const NOTHING = () => undefined;

const FILES: Record<ProjectDocName, string> = { model: "model.ttl", shapes: "shapes.ttl" };

interface ParseProblem {
  message: string;
  line: number | null;
  column: number | null;
  detail: string;
}

/** Where line N, column C sits in the text, for putting the caret there. */
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(0, column - 1), text.length);
}

export default function TurtleEditor({ projectId, doc, revision, onSelectEntity = NOTHING, onError = NOTHING }: Props) {
  const editorDraft = useProjectSelector((s) => s.editorDraft);
  const editorTarget = useProjectSelector((s) => s.editorTarget);
  const shownTarget = useRef(0);
  const [base, setBase] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<ParseProblem | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Another document: the old text goes at once, so nothing can be typed
  // into it and drafted against the wrong document while the new one loads
  // (found in review). The box is read-only until it arrives.
  useEffect(() => {
    setBase(null);
    setProblem(null);
  }, [projectId, doc]);

  // The document's own text, again whenever it changes -- unless the user has
  // edits in hand, which a refetch must never overwrite.
  useEffect(() => {
    let live = true;
    setLoadError(null);
    getDocumentSource(projectId, doc)
      .then((source) => live && setBase(source.text))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [projectId, doc, revision]);

  const text = editorDraft ?? base ?? "";
  const edited = editorDraft !== null;

  // Edit in Turtle (5.5): once, when the text is here, the caret goes to
  // the first place the shape is written and the line is scrolled to.
  useEffect(() => {
    const area = textRef.current;
    if (!editorTarget || base === null || !area || shownTarget.current === editorTarget.token) return;
    shownTarget.current = editorTarget.token;
    projectStore.editorTargetShown();
    const at = editorTarget.find.map((needle) => text.indexOf(needle)).filter((i) => i >= 0);
    area.focus();
    if (!at.length) return;
    const start = Math.min(...at);
    area.setSelectionRange(start, start);
    const line = text.slice(0, start).split("\n").length - 1;
    area.scrollTop = Math.max(0, line - 3) * (parseFloat(getComputedStyle(area).lineHeight) || 18);
  }, [editorTarget, base, text]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);

  const apply = async () => {
    if (!edited || applying) return;
    setApplying(true);
    setProblem(null);
    const applied = editorDraft;
    try {
      await projectStore.applyEditor();
      // What the server now holds as the editor's text, so the box does not
      // flash back to the old text while the refetch is in flight.
      setBase(applied);
    } catch (e: unknown) {
      if (e instanceof TurtleError) {
        setProblem({ message: e.message, line: e.line, column: e.column, detail: e.detail });
        // Put the caret where rdflib stopped, so the fix starts there.
        const area = textRef.current;
        if (area && e.line !== null && e.column !== null) {
          const at = offsetOf(area.value, e.line, e.column);
          area.focus();
          area.setSelectionRange(at, at);
        }
      } else {
        setProblem({
          message: e instanceof Error ? e.message : String(e),
          line: null,
          column: null,
          detail: "",
        });
      }
    } finally {
      setApplying(false);
    }
  };

  const discard = () => {
    setProblem(null);
    projectStore.setEditorDraft(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter applies. Tab is left alone on purpose: in a textarea it moves
    // focus on, and a field that traps Tab traps a keyboard user.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void apply();
    }
  };

  const state = applying
    ? "Applying…"
    : problem
      ? "Not applied: the text has an error."
      : edited
        ? "Edited — not applied yet."
        : "Matches the document.";

  return (
    <section className="source-view turtle-editor" aria-labelledby="source-view-heading">
      <div className="source-toolbar">
        <h2 id="source-view-heading" className="source-title" tabIndex={-1}>
          Turtle · {FILES[doc]}
        </h2>
        <span className="turtle-state" data-state={applying ? "applying" : problem ? "error" : edited ? "edited" : "clean"}>
          {state}
        </span>
        <div className="spacer" />
        <button
          className="ghost"
          aria-disabled={!edited || applying}
          onClick={discard}
          title={edited ? "Return the text to the document" : "Nothing to discard"}
        >
          Discard edits
        </button>
        <button
          className="primary"
          aria-disabled={!edited || applying}
          onClick={() => void apply()}
          title={edited ? "Parse the text and replace the document (Ctrl+Enter)" : "Nothing to apply"}
        >
          {applying ? "Applying…" : "Apply  Ctrl+Enter"}
        </button>
        {doc === "shapes" && (
          <ValidateButton onError={onError} blocked={edited ? "Apply the text first, so what is checked is what you see." : null} />
        )}
      </div>

      {problem && (
        <div className="turtle-error" role="alert">
          <p>{problem.message}</p>
          {problem.detail && (
            <details>
              <summary>rdflib's message</summary>
              <pre>{problem.detail}</pre>
            </details>
          )}
        </div>
      )}
      {loadError && <p className="detail-error">{loadError}</p>}

      <div className="turtle-body">
        <div className="turtle-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={problem?.line === i + 1 ? "turtle-gutter-error" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={textRef}
          className="turtle-textarea"
          aria-label={`Turtle source of ${FILES[doc]}`}
          aria-describedby="turtle-editor-help"
          aria-invalid={problem ? true : undefined}
          value={text}
          spellCheck={false}
          wrap="off"
          readOnly={base === null && editorDraft === null}
          onChange={(e) => {
            setProblem(null);
            projectStore.setEditorDraft(e.target.value === base ? null : e.target.value);
          }}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <p id="turtle-editor-help" className="hint turtle-help">
        Press Ctrl+Enter to apply. Tab moves to the next control. An apply is one step of Undo.
        A relative IRI such as &lt;owns&gt; is read as the project&apos;s base IRI followed by owns.
      </p>
      {doc === "shapes" && (
        <section className="turtle-results" aria-label="Validation results">
          <ResultPanels onSelect={onSelectEntity} />
        </section>
      )}
    </section>
  );
}
