import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSavedQuery, listSavedQueries, runSparql, saveQuery } from "../api";
import { assignVarNames, localName } from "../sparql/generate";
import { linkOptionsBetween } from "../sparql/useQueryBuilder";
import type { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { SavedQuery, SparqlResults, Theme } from "../types";
import ClassPropsMenu from "./ClassPropsMenu";
import PathBar from "./PathBar";
import type { OpenMenu } from "./PathBar";
import PredicateMenu from "./PredicateMenu";
import ResultsTable from "./ResultsTable";
import SparqlPreview from "./SparqlPreview";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  builder: ReturnType<typeof useQueryBuilder>;
  onPickIri: (iri: string) => void;
}

export default function QueryPanel({ ontologyId, theme, builder, onPickIri }: Props) {
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

  const execute = async () => {
    if (!ontologyId || !sparql) return;
    setRunning(true);
    setError(null);
    try {
      setResults(await runSparql(ontologyId, preview));
    } catch (e: unknown) {
      setResults(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

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
          available={schema.dataProperties[step.classIri] ?? []}
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
        options={linkOptionsBetween(schema, anchor?.classIri ?? "", step.classIri)}
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

      {hint && <p className="query-hint">{hint}</p>}
      {schema?.truncated && (
        <p className="query-hint">
          This ontology is very large, so the schema was sampled — some rare relationships
          may be missing.
        </p>
      )}

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

      {error && <p className="detail-error">{error}</p>}
      {results && <ResultsTable results={results} onPickIri={onPickIri} />}

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
