import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteOntology, getGraph, listOntologies } from "./api";
import DetailPanel from "./components/DetailPanel";
import GraphView from "./components/GraphView";
import Legend from "./components/Legend";
import LoadDialog from "./components/LoadDialog";
import QueryPanel from "./components/QueryPanel";
import SearchBox from "./components/SearchBox";
import { useQueryBuilder } from "./sparql/useQueryBuilder";
import type { AppMode, OntologySummary, Theme, VizGraph } from "./types";

function initialTheme(): Theme {
  const saved = localStorage.getItem("semantic-viewer-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<VizGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("explore");
  const builder = useQueryBuilder(activeId, mode === "query");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("semantic-viewer-theme", theme);
  }, [theme]);

  useEffect(() => {
    listOntologies()
      .then((list) => {
        setOntologies(list);
        if (list.length > 0) setActiveId(list[list.length - 1].id);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    setGraphData(null);
    setSelected(null);
    setHiddenKinds(new Set());
    if (!activeId) return;
    setLoadingGraph(true);
    let cancelled = false;
    getGraph(activeId)
      .then((g) => !cancelled && setGraphData(g))
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoadingGraph(false));
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const active = ontologies.find((o) => o.id === activeId) ?? null;

  const onLoaded = (summary: OntologySummary) => {
    setOntologies((prev) => [...prev, summary]);
    setActiveId(summary.id);
    setDialogOpen(false);
    setError(null);
  };

  const onRemove = async () => {
    if (!activeId) return;
    const name = ontologies.find((o) => o.id === activeId)?.name ?? "this ontology";
    if (!window.confirm(`Remove “${name}” and delete its stored copy? It will no longer appear after a restart.`)) {
      return;
    }
    try {
      await deleteOntology(activeId);
      setOntologies((prev) => {
        const next = prev.filter((o) => o.id !== activeId);
        setActiveId(next.length > 0 ? next[next.length - 1].id : null);
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectAndFocus = useCallback((iri: string | null) => {
    setSelected(iri);
    if (iri) setFocusTick((t) => t + 1);
  }, []);

  // In Explore mode a click opens the detail panel; in Query mode it
  // appends a step to the query being built.
  const onGraphSelect = useCallback(
    (iri: string | null) => {
      if (mode === "query") {
        if (iri) void builder.addNode(iri);
        return;
      }
      setSelected(iri);
    },
    [mode, builder],
  );

  // Searching in Query mode adds the match to the path, so a query can be
  // built by name without hunting for a node in a large graph.
  const onSearchPick = useCallback(
    (iri: string) => {
      selectAndFocus(iri);
      if (mode === "query") void builder.addNode(iri);
    },
    [mode, builder, selectAndFocus],
  );

  const edgeKinds = useMemo(() => {
    if (!graphData) return [];
    const kinds = new Set(graphData.edges.map((e) => e.kind));
    return [...kinds].sort();
  }, [graphData]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">◉</span> Semantic Viewer
        </div>
        <button className="primary" onClick={() => setDialogOpen(true)}>
          + Load ontology
        </button>
        <div className="mode-switch" role="tablist" aria-label="Mode">
          <button
            role="tab"
            aria-selected={mode === "explore"}
            className={mode === "explore" ? "mode-tab active" : "mode-tab"}
            onClick={() => setMode("explore")}
            title="Browse the ontology and inspect entities"
          >
            Explore
          </button>
          <button
            role="tab"
            aria-selected={mode === "query"}
            className={mode === "query" ? "mode-tab active" : "mode-tab"}
            onClick={() => setMode("query")}
            title="Build a SPARQL query by clicking the graph"
          >
            Query
          </button>
        </div>
        {ontologies.length > 0 && (
          <select
            value={activeId ?? ""}
            onChange={(e) => setActiveId(e.target.value || null)}
            title="Active ontology"
          >
            {ontologies.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.triples.toLocaleString()} triples)
              </option>
            ))}
          </select>
        )}
        {active && (
          <button
            className="ghost"
            onClick={() => void onRemove()}
            title="Remove this ontology and delete its stored copy"
          >
            Remove
          </button>
        )}
        <div className="spacer" />
        <SearchBox
          ontologyId={activeId}
          theme={theme}
          onPick={onSearchPick}
          placeholder={
            mode === "query" ? "Search to add a step…" : "Search concepts, properties…"
          }
        />
        <button
          className="ghost icon-btn theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? "☀" : "🌙"}
        </button>
      </header>

      {error && (
        <div className="error-bar" onClick={() => setError(null)} title="Click to dismiss">
          {error}
        </div>
      )}

      <main className="main">
        <div className="graph-area">
          <GraphView
            data={graphData}
            theme={theme}
            hiddenKinds={hiddenKinds}
            selected={selected}
            onSelect={onGraphSelect}
            focusTick={focusTick}
            queryMode={mode === "query"}
            queryPathIris={builder.pathIris}
            queryCandidates={builder.candidates}
          />
          {graphData && (
            <Legend
              theme={theme}
              kindCounts={graphData.stats.kindCounts}
              edgeKinds={edgeKinds}
              hiddenKinds={hiddenKinds}
              onToggleKind={(kind) =>
                setHiddenKinds((prev) => {
                  const next = new Set(prev);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  return next;
                })
              }
            />
          )}
          {loadingGraph && <div className="loading-overlay">Building graph…</div>}
        </div>
        {mode === "query" ? (
          <QueryPanel
            ontologyId={activeId}
            theme={theme}
            builder={builder}
            onPickIri={selectAndFocus}
          />
        ) : (
          <DetailPanel
            ontologyId={activeId}
            iri={selected}
            onNavigate={selectAndFocus}
            onClose={() => setSelected(null)}
          />
        )}
      </main>

      <footer className="status-bar">
        {active ? (
          <>
            <span>{active.name}</span>
            <span>{active.triples.toLocaleString()} triples</span>
            <span>{graphData?.stats.nodeCount.toLocaleString() ?? "…"} nodes</span>
            <span>{graphData?.stats.edgeCount.toLocaleString() ?? "…"} edges</span>
            <span className="dim">{active.format}</span>
            {active.source !== "upload" && <span className="dim src">{active.source}</span>}
          </>
        ) : (
          <span className="dim">Load an ontology to begin — RDF, RDFS, OWL & SKOS supported.</span>
        )}
      </footer>

      {dialogOpen && <LoadDialog onLoaded={onLoaded} onClose={() => setDialogOpen(false)} />}
    </div>
  );
}
