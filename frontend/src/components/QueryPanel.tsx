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

INPUTS / INPUT SOURCES (props)
    - ontologyId: the active ontology.
    - theme: colour theme (passed to child chips).
    - builder: the useQueryBuilder return value (state + actions).
    - onPickIri: select a node in the graph when a result chip is clicked,
      drawing it first if the node budget left it out.
    - onViewInSource: follow a result into the raw source text.
    - ontologyTriples: size gate for the auto-preview.

EXPECTED OUTPUT
    - The rendered query panel and the side effects of its controls (executing
      queries, saving/loading/deleting saved queries).
================================================================================
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSavedQuery, listSavedQueries, runSparql, saveQuery } from "../api";
import { describeQuery } from "../sparql/describe";
import { assignVarNames, generateSparql, localName } from "../sparql/generate";
import { linkOptionsBetween } from "../sparql/useQueryBuilder";
import type { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { SavedQuery, SparqlResults, Theme } from "../types";
import ClassPropsMenu from "./ClassPropsMenu";
import NextSteps from "./NextSteps";
import PathBar from "./PathBar";
import type { OpenMenu } from "./PathBar";
import PredicateMenu from "./PredicateMenu";
import QueryStart from "./QueryStart";
import ResultsTable from "./ResultsTable";
import SparqlPreview from "./SparqlPreview";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  builder: ReturnType<typeof useQueryBuilder>;
  onPickIri: (iri: string) => void;
  onViewInSource: (iri: string, prefixed?: string) => void;
  /** Auto-preview is only worth running while it stays instant. */
  ontologyTriples: number;
}

/** Above this size a preview is no longer guaranteed to feel immediate. */
const AUTO_PREVIEW_MAX_TRIPLES = 50000;
const PREVIEW_ROWS = 5;

export default function QueryPanel({
  ontologyId,
  theme,
  builder,
  onPickIri,
  onViewInSource,
  ontologyTriples,
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

  const execute = async () => {
    if (!ontologyId || !sparql) return;
    setRunning(true);
    setError(null);
    try {
      setResults(await runSparql(ontologyId, preview));
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
    if (!autoPreviewable || !ontologyId || state.steps.length === 0 || !schema) {
      return;
    }
    const previewQuery = generateSparql(
      { ...state, limit: PREVIEW_ROWS },
      schema.namespaces,
    );
    if (!previewQuery) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      runSparql(ontologyId, previewQuery)
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
  }, [autoPreviewable, ontologyId, schema, state]);

  const doSave = async (name: string) => {
    if (!ontologyId || !name.trim()) return;
    try {
      const entry = await saveQuery({
        id: openQuery?.id,
        name,
        ontologyId,
        state,
        sparql,
      });
      setOpenQuery({ id: entry.id, name: entry.name });
      setSavePrompt(false);
      setSaveName("");
      refreshSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
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

  return (
    <aside className="query-panel">
      {loadingSchema && <div className="detail-note">Analysing the ontology…</div>}
      {schemaError && <p className="detail-error">{schemaError}</p>}

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
      <div className="query-pinned">
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
            onClick={() => (openQuery ? void doSave(openQuery.name) : setSavePrompt(true))}
            title={openQuery ? `Update “${openQuery.name}”` : "Save this query"}
          >
            ⌸ {openQuery ? "Update" : "Save"}
          </button>
          <button className="primary" disabled={!sparql || running} onClick={() => void execute()}>
            {running ? "Running…" : "▶ Execute"}
          </button>
        </div>

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

        <SparqlPreview sparql={preview} />
      </div>

      {error && <p className="detail-error">{error}</p>}
      {results && (
        <>
          {isPreview && (
            <p className="preview-badge">
              Live preview — first {PREVIEW_ROWS} rows. Press Execute for the full result.
            </p>
          )}
          <ResultsTable
            results={results}
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
                onClick={() => {
                  loadState(entry.state, { id: entry.id, name: entry.name });
                  setResults(null);
                  setError(null);
                }}
                title={`Open “${entry.name}”`}
              >
                {entry.name}
              </button>
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
    </aside>
  );
}
