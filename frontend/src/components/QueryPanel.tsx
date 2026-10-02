/*
================================================================================
FILE: frontend/src/components/QueryPanel.tsx
================================================================================

SUMMARY
    The right-hand panel shown in Query mode. It ties the whole visual query
    builder together: the guided start, the path bar, the per-chip menus, the
    live plain-English + SPARQL preview, the toolbar (Auto/Paths/Distinct/
    Count/LIMIT/Copy/Save/Execute), the results table, and the saved-query list.

BASIC IDEA
    QueryPanel is mostly orchestration. The real state lives in the shared
    useQueryBuilder hook (passed in as `builder`); this component renders it and
    wires the buttons. It adds a few local concerns: an auto-preview that runs a
    small LIMITed query as you build (only on small ontologies, so it stays
    instant), the Auto/refresh toggle for the preview, and the save flow.

    One piece of its markup is layout rather than orchestration: the toolbar,
    the save prompt and the SPARQL preview are wrapped in a single
    .query-pinned element so they can stick to the top of the panel while the
    results scroll under them.

    It also wires SPARQL as text (spec sparql-text-and-query-files). Edit as
    text and New text query open SparqlEditor in the preview's place; while
    the query is text the builder's controls sit in a disabled, labelled
    fieldset, the auto-preview stops, and Save stores `mode: "text"`. Saved
    text queries are marked with the word "text", and queries stored in the
    ontology itself are listed under the saved ones, fetched only when that
    list is opened. With the editor never opened, this panel renders and
    requests exactly what it did before, plus the two buttons (AC-1).

INPUTS / INPUT SOURCES (props)
    - ontologyId: the active ontology.
    - theme: colour theme (passed to child chips).
    - builder: the useQueryBuilder return value (state + actions).
    - onPickIri: select a node in the graph when a result chip is clicked,
      drawing it first if the node budget left it out.
    - onViewInSource: follow a result into the raw source text.
    - ontologyTriples: size gate for the auto-preview.
    - includeImports / importsCount: whether queries run over the ontology
      and its resolved imports (external-access Stage 2), and over how many
      imported documents. The panel states which, in text (AC-20).
    - dataSources: a project's switched-on data snapshots, each named on a
      source line, a sample's words included (csv-data-import 5.6).

EXPECTED OUTPUT
    - The rendered query panel and the side effects of its controls (executing
      queries, saving/loading/deleting saved queries, opening and downloading
      .rq files in the browser).
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteSavedQuery,
  getEmbeddedQueries,
  listSavedQueries,
  runSparql,
  saveQuery,
} from "../api";
import { triggerDownload } from "../download";
import { describeQuery } from "../sparql/describe";
import { assignVarNames, generateSparql, localName } from "../sparql/generate";
import {
  MAX_QUERY_BYTES,
  STARTER_COMMENT,
  TOO_LARGE_TO_RUN,
  byteLength,
  readQueryFile,
  rqFileName,
} from "../sparql/textQuery";
import { linkOptionsBetween } from "../sparql/useQueryBuilder";
import { dataLabel } from "../modeling/dataSentences";
import type { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { EmbeddedQueries, EmbeddedQuery, SavedQuery, SparqlResults, Theme, DataSource } from "../types";
import ClassPropsMenu from "./ClassPropsMenu";
import NextSteps from "./NextSteps";
import PathBar from "./PathBar";
import type { OpenMenu } from "./PathBar";
import PredicateMenu from "./PredicateMenu";
import QueryStart from "./QueryStart";
import ResultsTable from "./ResultsTable";
import SparqlEditor from "./SparqlEditor";
import SparqlPreview from "./SparqlPreview";

interface Props {
  ontologyId: string | null;
  /** The active ontology's display name, for the result-export filename (Q-2). */
  ontologyName?: string;
  theme: Theme;
  builder: ReturnType<typeof useQueryBuilder>;
  onPickIri: (iri: string) => void;
  onViewInSource: (iri: string, prefixed?: string) => void;
  /** Auto-preview is only worth running while it stays instant. */
  ontologyTriples: number;
  /** Run queries over the merged view. */
  includeImports?: boolean;
  /** Resolved imported documents, or null when the ontology has none known. */
  importsCount?: number | null;
  /** A project's switched-on data snapshots, named on the source line with
   *  their labels (csv-data-import 5.6). */
  dataSources?: DataSource[];
}

/** What the panel says about what a query runs over. Null says nothing: an
 *  ontology with no resolved imports has only one thing to query. */
export function queryScopeText(includeImports: boolean, importsCount: number | null): string | null {
  if (includeImports) {
    const n = importsCount ?? 0;
    return `Querying this ontology and ${n} ${n === 1 ? "import" : "imports"}.`;
  }
  if (importsCount && importsCount > 0) return "Querying this ontology on its own, without its imports.";
  return null;
}

export const DISCARD_TEXT = "Your text changes will be discarded.";
export const ONLY_SELECT = "Only SELECT queries can run here.";
export const CUT_SHORT = "This query is longer than 100 KB and was cut short, so it cannot run.";
export const SHACL_VARIABLES_NOTE =
  "This query uses $this or $value, which a SHACL engine fills in. Run here, they are ordinary variables.";

/** What opening a query stored in the ontology gives the editor. */
export function embeddedOptions(query: EmbeddedQuery) {
  return {
    name: query.label,
    runBlocked: query.form !== "SELECT" ? ONLY_SELECT : query.truncated ? CUT_SHORT : null,
    note: query.shaclVariables ? SHACL_VARIABLES_NOTE : null,
  };
}

/** Above this size a preview is no longer guaranteed to feel immediate. */
const AUTO_PREVIEW_MAX_TRIPLES = 50000;
const PREVIEW_ROWS = 5;

export default function QueryPanel({
  ontologyId,
  ontologyName,
  theme,
  builder,
  onPickIri,
  onViewInSource,
  ontologyTriples,
  includeImports = false,
  importsCount = null,
  dataSources = [],
}: Props) {
  const {
    schema,
    schemaError,
    loadingSchema,
    state,
    setState,
    sparql,
    hint,
    removeStep,
    updateStep,
    updateLink,
    clear,
    openQuery,
    setOpenQuery,
    loadState,
    addClass,
    addNextStep,
    nextStepOptions,
    dataPropertiesFor,
    ancestorsOf,
    textQuery,
    textRef,
    forkToText,
    openTextQuery,
    setText,
    markTextSaved,
    leaveText,
    textIsDirty,
  } = builder;

  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const [auto, setAuto] = useState(true);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [results, setResults] = useState<SparqlResults | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [saveName, setSaveName] = useState("");
  const [savePrompt, setSavePrompt] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  // The editor opened on the builder's own query. A text query opens it too,
  // and keeps it open across a visit to another mode, because the hook holds
  // it and this panel remounts.
  const [editorOpen, setEditorOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const [embeddedOpen, setEmbeddedOpen] = useState(false);
  const [embedded, setEmbedded] = useState<EmbeddedQueries | null>(null);
  const [embeddedError, setEmbeddedError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);

  const inText = textQuery !== null;
  const editorShown = editorOpen || inText;
  const embeddedCount = schema?.embeddedQueryCount ?? 0;

  const preview = auto ? sparql : frozen ?? sparql;
  const { stepVars } = useMemo(() => assignVarNames(state), [state]);

  const classKinds = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cls of schema?.classes ?? []) map[cls.iri] = cls.kind;
    return map;
  }, [schema]);

  const labelFor = useCallback(
    (iri: string) => {
      for (const link of schema?.links ?? []) {
        if (link.predicate === iri) return link.label;
      }
      return localName(iri);
    },
    [schema],
  );

  // Empties the results area only. The query, the path, the pins and the saved
  // queries are untouched — that is the whole distinction from the path bar's
  // Clear path.
  //
  // A useCallback rather than an inline arrow because ResultsTable is memoised:
  // a fresh identity here would re-render the table on every App render, which
  // is exactly what the memo is there to stop while a graph expansion is in
  // flight underneath it.
  const clearResults = useCallback(() => setResults(null), []);

  const refreshSaved = useCallback(() => {
    if (!ontologyId) return;
    listSavedQueries(ontologyId)
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [ontologyId]);

  useEffect(() => {
    refreshSaved();
    setResults(null);
    setError(null);
    setOpenMenu(null);
  }, [refreshSaved]);

  // The stored queries belong to one ontology and one view of it. The key is
  // also what a response is checked against when it lands: one started for
  // the other view must not fill this one's list.
  const embeddedKey = `${ontologyId}|${includeImports}`;
  const embeddedKeyRef = useRef(embeddedKey);
  embeddedKeyRef.current = embeddedKey;
  useEffect(() => {
    setEmbedded(null);
    setEmbeddedError(null);
    setEmbeddedOpen(false);
  }, [ontologyId, includeImports]);

  // Focus goes back to Edit as text when the editor closes (AC-15). It is
  // disabled with no query to edit, and a disabled button cannot take focus,
  // so New text query beside it takes it then.
  useEffect(() => {
    if (!returnFocus || editorShown) return;
    setReturnFocus(false);
    const edit = editButtonRef.current;
    (edit && !edit.disabled ? edit : newButtonRef.current)?.focus();
  }, [returnFocus, editorShown]);

  // Menus close on Escape, like the rest of the app's popovers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A step that disappears must not leave its menu open.
  useEffect(() => {
    if (openMenu && openMenu.index >= state.steps.length) setOpenMenu(null);
  }, [openMenu, state.steps.length]);

  const plainEnglish = useMemo(
    () => describeQuery(state, labelFor),
    [state, labelFor],
  );

  const scope = queryScopeText(includeImports, importsCount);

  const execute = async () => {
    if (!ontologyId || !sparql) return;
    setRunning(true);
    setError(null);
    try {
      setResults(await runSparql(ontologyId, preview, includeImports));
      setIsPreview(false);
    } catch (e: unknown) {
      setResults(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // Small ontologies preview themselves as the query is built, so a
  // newcomer sees real rows immediately instead of guessing whether the
  // query works. Larger ones wait for an explicit Execute.
  const autoPreviewable =
    ontologyTriples > 0 && ontologyTriples <= AUTO_PREVIEW_MAX_TRIPLES;

  useEffect(() => {
    // A text query only runs when asked: its text is not what the builder
    // would preview, and a half-typed query is not worth a request.
    if (inText || !autoPreviewable || !ontologyId || state.steps.length === 0 || !schema) {
      return;
    }
    const previewQuery = generateSparql(
      { ...state, limit: PREVIEW_ROWS },
      schema.namespaces,
    );
    if (!previewQuery) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      runSparql(ontologyId, previewQuery, includeImports)
        .then((res) => {
          if (cancelled) return;
          setResults(res);
          setIsPreview(true);
          setError(null);
        })
        .catch(() => {
          /* a partially built query may not be valid yet; stay quiet */
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inText, autoPreviewable, ontologyId, schema, state, includeImports]);

  const doSave = async (name: string) => {
    if (!ontologyId || !name.trim()) return;
    // Read now, not from the render: the text is in a ref precisely so that
    // typing does not render this panel.
    const text = textQuery ? textRef.current : null;
    try {
      const entry = await saveQuery(
        text === null
          ? { id: openQuery?.id, name, ontologyId, state, sparql, mode: "visual" }
          : {
              id: openQuery?.id,
              name,
              ontologyId,
              state: textQuery?.forkedFrom ?? null,
              sparql: text,
              mode: "text",
            },
      );
      setOpenQuery({ id: entry.id, name: entry.name });
      if (text !== null) markTextSaved(text);
      setSavePrompt(false);
      setSaveName("");
      refreshSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = () => {
    if (openQuery) void doSave(openQuery.name);
    else {
      if (textQuery?.name) setSaveName(textQuery.name);
      setSavePrompt(true);
    }
  };

  // --- text queries (sparql-text-and-query-files) --------------------------

  /** Whether typed text may be dropped: asks only when some would be lost. */
  const mayDiscard = () => !textIsDirty() || window.confirm(DISCARD_TEXT);

  const runText = async (text: string) => {
    if (!ontologyId) return;
    // Refused here with a sentence rather than sent for a 422, and counted in
    // bytes, which is the stricter of the two measures.
    if (byteLength(text) > MAX_QUERY_BYTES) {
      setError(TOO_LARGE_TO_RUN);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      setResults(await runSparql(ontologyId, text, includeImports));
      setIsPreview(false);
    } catch (e: unknown) {
      setResults(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const startText = (text: string, options: Parameters<typeof openTextQuery>[1] = {}) => {
    openTextQuery(text, options);
    setEditorOpen(true);
    setSavePrompt(false);
    setOpenMenu(null);
    setError(null);
  };

  const newTextQuery = () => {
    if (!mayDiscard()) return;
    startText(STARTER_COMMENT);
  };

  const openFile = async (file: File) => {
    const read = await readQueryFile(file);
    if (!read.ok) {
      setError(read.error);
      return;
    }
    if (!mayDiscard()) return;
    startText(read.text, { name: read.name });
  };

  const download = (text: string) => {
    const name = textQuery?.name ?? openQuery?.name ?? null;
    triggerDownload(new Blob([text], { type: "application/sparql-query" }), rqFileName(name));
  };

  const closeEditor = () => {
    if (inText) {
      if (!mayDiscard()) return;
      leaveText();
    }
    setEditorOpen(false);
    setSavePrompt(false);
    setError(null);
    setReturnFocus(true);
  };

  // Asks every time, as the spec says: going back is the one way out of a
  // fork that always throws the text away.
  const backToVisual = () => {
    if (!window.confirm(DISCARD_TEXT)) return;
    leaveText();
    setEditorOpen(false);
    setSavePrompt(false);
    setError(null);
    setReturnFocus(true);
  };

  const openSaved = (entry: SavedQuery) => {
    if (inText && !mayDiscard()) return;
    if (entry.mode === "text") {
      startText(entry.sparql, {
        forkedFrom: entry.state,
        name: entry.name,
        opened: { id: entry.id, name: entry.name },
      });
    } else if (entry.state) {
      loadState(entry.state, { id: entry.id, name: entry.name });
      setEditorOpen(false);
    }
    setResults(null);
    setError(null);
  };

  const toggleEmbedded = () => {
    const next = !embeddedOpen;
    setEmbeddedOpen(next);
    if (!next || embedded || !ontologyId) return;
    setEmbeddedError(null);
    const requestedFor = embeddedKey;
    const current = () => embeddedKeyRef.current === requestedFor;
    getEmbeddedQueries(ontologyId, includeImports)
      .then((listing) => current() && setEmbedded(listing))
      .catch((e: unknown) => current() && setEmbeddedError(e instanceof Error ? e.message : String(e)));
  };

  const openEmbedded = (query: EmbeddedQuery) => {
    if (!mayDiscard()) return;
    startText(query.text, embeddedOptions(query));
    setResults(null);
  };

  const menu = (() => {
    if (!openMenu || !schema) return null;
    const step = state.steps[openMenu.index];
    if (!step) return null;
    if (openMenu.kind === "class") {
      return (
        <ClassPropsMenu
          step={step}
          available={dataPropertiesFor(step.classIri)}
          onChange={(patch) => updateStep(openMenu.index, patch)}
          onClose={() => setOpenMenu(null)}
        />
      );
    }
    const link = step.link;
    if (!link) return null;
    const anchor = state.steps[link.anchor];
    return (
      <PredicateMenu
        link={link}
        anchorLabel={anchor?.label ?? "?"}
        targetLabel={step.label}
        options={linkOptionsBetween(schema, anchor?.classIri ?? "", step.classIri, ancestorsOf)}
        onChange={(patch) => updateLink(openMenu.index, patch)}
        onClose={() => setOpenMenu(null)}
      />
    );
  })();

  // Everything that builds the query by clicking. While the query is text it
  // sits in a disabled fieldset, dimmed and labelled, so none of it can change
  // a query it no longer describes (AC-4). With the editor never opened it is
  // rendered exactly as before, not wrapped at all (AC-1).
  const builderParts = (
    <>
      <div className="path-bar-wrap">
        <PathBar
          state={state}
          stepVars={stepVars}
          theme={theme}
          classKinds={classKinds}
          labelFor={labelFor}
          openMenu={openMenu}
          onOpenMenu={setOpenMenu}
          onRemoveStep={removeStep}
          onClear={clear}
        />
        {menu}
      </div>

      {state.steps.length === 0 && !loadingSchema && (
        <QueryStart
          schema={schema}
          theme={theme}
          onUseStarter={(next, title) => {
            setState(next);
            setOpenQuery(null);
            setSaveName(title);
          }}
          onPickClass={addClass}
        />
      )}

      {state.steps.length > 0 && (
        <>
          <p className="plain-english">{plainEnglish}</p>
          <NextSteps
            options={nextStepOptions}
            stepCount={state.steps.length}
            onAdd={addNextStep}
          />
        </>
      )}

      {hint && <p className="query-hint">{hint}</p>}
    </>
  );

  return (
    // Named and script-focusable, so the main area's skip link has somewhere to
    // land in Query mode: this is the only one of the four panels beside the
    // graph with no heading of its own. tabIndex -1 adds no stop to the tab
    // order. Backlog X-1.
    <aside className="query-panel" id="query-panel-region" aria-label="Query builder" tabIndex={-1}>
      {scope && <p className="query-scope">{scope}</p>}
      {dataSources.map((source) => (
        <p key={source.id} className="query-scope data-source-line">
          Includes data {dataLabel(source)}.
        </p>
      ))}
      {loadingSchema && <div className="detail-note">Analysing the ontology…</div>}
      {schemaError && <p className="detail-error">{schemaError}</p>}

      {inText ? (
        <fieldset className="builder-dimmed" disabled>
          <legend className="builder-dimmed-label">Not in use while editing text</legend>
          {builderParts}
        </fieldset>
      ) : (
        builderParts
      )}
      {schema?.truncated && (
        <p className="query-hint">
          This ontology is very large, so the schema was sampled — some rare relationships
          may be missing.
        </p>
      )}

      {/* The toolbar, the save prompt and the query text are one sticky
          block. Reading results used to mean scrolling the query out of
          sight, which is exactly when it is needed — so this stays at the
          top of the panel while everything below scrolls under it. The
          opaque background in .query-pinned is load-bearing: without one,
          the table shows through. */}
      <div className={editorShown ? "query-pinned editing" : "query-pinned"}>
        {/* The builder's own controls step aside while the editor is open,
            which has its own row: they describe the visual query, and a
            toggle that silently did nothing to a text query would mislead. */}
        {!editorShown && (
          <div className="query-toolbar">
            <span className="query-toolbar-label">SPARQL</span>
            <button
              className={auto ? "toggle-pill active" : "toggle-pill"}
              onClick={() => {
                if (auto) setFrozen(sparql);
                setAuto(!auto);
              }}
              title="Regenerate the query on every edit"
            >
              Auto
            </button>
            {!auto && (
              <button className="ghost" onClick={() => setFrozen(sparql)} title="Regenerate now">
                ↻ Refresh
              </button>
            )}
            <button
              className={state.pathsMode ? "toggle-pill active" : "toggle-pill"}
              onClick={() => setState({ ...state, pathsMode: !state.pathsMode })}
              title="Collapse plain hops into compact property paths"
            >
              Paths
            </button>
            <button
              className={state.distinct ? "toggle-pill active" : "toggle-pill"}
              onClick={() => setState({ ...state, distinct: !state.distinct })}
              title="Remove duplicate rows"
            >
              Distinct
            </button>
            <button
              className={state.aggregate === "count" ? "toggle-pill active" : "toggle-pill"}
              onClick={() =>
                setState({
                  ...state,
                  aggregate: state.aggregate === "count" ? "none" : "count",
                })
              }
              title={
                state.steps.length > 1
                  ? "Count the last step, grouped by the first"
                  : "Count how many there are"
              }
            >
              Count
            </button>
            <label className="limit-field" title="Maximum rows to return">
              LIMIT
              <input
                type="number"
                min={1}
                max={10000}
                value={state.limit}
                onChange={(e) =>
                  setState({ ...state, limit: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </label>
            <div className="spacer" />
            <button
              className="ghost"
              disabled={!sparql}
              onClick={() => {
                void navigator.clipboard?.writeText(preview);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              title="Copy the query to the clipboard"
            >
              {copied ? "✓ Copied" : "⧉ Copy"}
            </button>
            <button
              className="ghost"
              disabled={!sparql}
              onClick={save}
              title={openQuery ? `Update “${openQuery.name}”` : "Save this query"}
            >
              ⌸ {openQuery ? "Update" : "Save"}
            </button>
            <button className="primary" disabled={!sparql || running} onClick={() => void execute()}>
              {running ? "Running…" : "▶ Execute"}
            </button>
          </div>
        )}

        {savePrompt && (
          <div className="save-row">
            <input
              autoFocus
              placeholder="Query name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSave(saveName);
                if (e.key === "Escape") setSavePrompt(false);
              }}
            />
            <button className="primary" onClick={() => void doSave(saveName)}>
              Save
            </button>
            <button className="ghost" onClick={() => setSavePrompt(false)}>
              Cancel
            </button>
          </div>
        )}

        {editorShown ? (
          <SparqlEditor
            // A new text query is a new editor; a fork keeps this one, and
            // with it the caret the user is typing at.
            key={builder.editorSession}
            generated={sparql}
            textQuery={textQuery}
            initialText={textRef.current}
            namespaces={schema?.namespaces ?? {}}
            running={running}
            error={error}
            saveLabel={openQuery ? "Update" : "Save"}
            saveTitle={openQuery ? `Update “${openQuery.name}”` : "Save this query"}
            onFork={(text, baseline) => {
              // A chip menu open at the moment of the fork would edit a query
              // that is no longer the one on screen.
              setOpenMenu(null);
              forkToText(text, baseline);
            }}
            onChange={setText}
            onRun={(text) => void runText(text)}
            onSave={save}
            onDownload={download}
            onOpenFile={(file) => void openFile(file)}
            onBack={backToVisual}
            onClose={closeEditor}
          />
        ) : (
          <SparqlPreview
            sparql={preview}
            onEditAsText={() => setEditorOpen(true)}
            onNewTextQuery={newTextQuery}
            editButtonRef={editButtonRef}
            newButtonRef={newButtonRef}
          />
        )}
      </div>

      {/* With the editor open its errors are shown above it, where the text
          that caused them is. */}
      {!editorShown && error && <p className="detail-error">{error}</p>}
      {results && (
        <>
          {isPreview && (
            <p className="preview-badge">
              Live preview — first {PREVIEW_ROWS} rows. Press Execute for the full result.
            </p>
          )}
          <ResultsTable
            results={results}
            ontologyName={ontologyName}
            onPickIri={onPickIri}
            onViewInSource={onViewInSource}
            onClear={clearResults}
          />
        </>
      )}

      {saved.length > 0 && (
        <section className="saved-queries">
          <h3>Saved queries</h3>
          {saved.map((entry) => (
            <div
              className={openQuery?.id === entry.id ? "saved-row open" : "saved-row"}
              key={entry.id}
            >
              <button
                className="saved-name"
                onClick={() => openSaved(entry)}
                title={`Open “${entry.name}”`}
              >
                {entry.name}
              </button>
              {/* A word, not a colour, so it reads the same to everyone. */}
              {entry.mode === "text" && <span className="saved-mode">text</span>}
              <span className="dim">{new Date(entry.updatedAt).toLocaleDateString()}</span>
              <button
                className="icon-btn"
                title="Delete this saved query"
                onClick={() => {
                  if (!window.confirm(`Delete saved query “${entry.name}”?`)) return;
                  void deleteSavedQuery(entry.id).then(() => {
                    if (openQuery?.id === entry.id) setOpenQuery(null);
                    refreshSaved();
                  });
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Only for a file that stores queries: the count comes with the schema,
          so a file without any shows nothing and costs nothing. */}
      {embeddedCount > 0 && (
        <section className="saved-queries embedded-queries">
          <h3>
            <button
              className="embedded-toggle"
              aria-expanded={embeddedOpen}
              aria-controls="embedded-query-list"
              onClick={toggleEmbedded}
            >
              {embeddedOpen ? "▾" : "▸"} Queries in this file ({embeddedCount})
            </button>
          </h3>
          {embeddedOpen && (
            <div id="embedded-query-list">
              {embeddedError && <p className="detail-error">{embeddedError}</p>}
              {!embedded && !embeddedError && <p className="detail-note">Reading the file…</p>}
              {embedded?.truncated && (
                <p className="detail-note">
                  Showing {embedded.queries.length} of {embedded.total}.
                </p>
              )}
              {embedded?.queries.map((query, index) => (
                <div className="saved-row embedded-row" key={`${query.subject ?? ""}|${index}`}>
                  <button
                    className="saved-name"
                    onClick={() => openEmbedded(query)}
                    title={`Open “${query.label}” in the editor`}
                  >
                    {query.label}
                  </button>
                  <span className="saved-mode">{query.form}</span>
                  {query.shaclVariables && (
                    <span className="dim" title={SHACL_VARIABLES_NOTE}>
                      uses $this or $value
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
