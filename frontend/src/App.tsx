import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteOntology, getGraph, listOntologies } from "./api";
import DetailPanel from "./components/DetailPanel";
import GraphView from "./components/GraphView";
import Legend from "./components/Legend";
import LoadDialog from "./components/LoadDialog";
import SearchBox from "./components/SearchBox";
import type { OntologySummary, Theme, VizGraph } from "./types";

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
          <button className="ghost" onClick={() => void onRemove()} title="Remove this ontology from the viewer">
            Remove
          </button>
        )}
        <div className="spacer" />
        <SearchBox ontologyId={activeId} theme={theme} onPick={selectAndFocus} />
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
            onSelect={setSelected}
            focusTick={focusTick}
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
        <DetailPanel
          ontologyId={activeId}
          iri={selected}
          onNavigate={selectAndFocus}
          onClose={() => setSelected(null)}
        />
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
