/*
================================================================================
FILE: frontend/src/App.tsx
================================================================================

SUMMARY
    The root component. It owns the top-level application state (theme, the list
    of loaded ontologies, which one is active, its graph data, the selected
    node, the current mode) and lays out the header, the graph area, and the
    right-hand panel that changes with the mode.

BASIC IDEA
    App is the conductor: it fetches the ontology list and the active graph,
    holds the query-builder hook (shared by the graph and the query panel), and
    routes user actions. The three modes (View / Explore / Query) all render
    over the SAME graph so switching between them never throws away the settled
    layout — View overlays a source pane, Explore shows the detail panel, Query
    shows the builder panel.

INPUTS / INPUT SOURCES
    - The backend API (via api.ts) for the ontology list and graph.
    - User interaction: header tabs, dropdown, graph clicks, search.
    - localStorage for the remembered theme.

EXPECTED OUTPUT
    - The full rendered application UI, and the side effects of user actions
      (loading, switching, removing ontologies; building/running queries).
================================================================================
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteOntology, getGraph, listOntologies } from "./api";
import DetailPanel from "./components/DetailPanel";
import GraphNotice from "./components/GraphNotice";
import GraphView from "./components/GraphView";
import Legend from "./components/Legend";
import LoadDialog from "./components/LoadDialog";
import Logo from "./components/Logo";
import QueryPanel from "./components/QueryPanel";
import SearchBox from "./components/SearchBox";
import SourceView from "./components/SourceView";
import {
  IconExplore,
  IconLoad,
  IconMoon,
  IconQuery,
  IconSun,
  IconTrash,
  IconView,
} from "./components/icons";
import { useQueryBuilder } from "./sparql/useQueryBuilder";
import type { AppMode, OntologySummary, Theme, VizGraph } from "./types";

/** The theme to start in: saved preference, else the OS setting, else dark. */
function initialTheme(): Theme {
  const saved =
    localStorage.getItem("semantic-studio-theme") ??
    localStorage.getItem("semantic-viewer-theme"); // pre-rename preference
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * The status-bar count for nodes or edges: "34" normally, "2,000 of 18,717"
 * when the budget dropped something, and "…" while the graph is loading.
 */
function countOf(graph: VizGraph | null, what: "node" | "edge"): string {
  if (!graph) return "…";
  const drawn = what === "node" ? graph.stats.nodeCount : graph.stats.edgeCount;
  const total = what === "node" ? graph.stats.nodeTotal : graph.stats.edgeTotal;
  if (!graph.stats.truncated) return drawn.toLocaleString();
  return `${drawn.toLocaleString()} of ${total.toLocaleString()}`;
}

export default function App() {
  // --- top-level state ---
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);   // dropdown list
  const [activeId, setActiveId] = useState<string | null>(null);          // selected ontology
  const [graphData, setGraphData] = useState<VizGraph | null>(null);      // its graph
  const [selected, setSelected] = useState<string | null>(null);          // clicked node (Explore)
  const [focusTick, setFocusTick] = useState(0);                          // bump to re-centre camera
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set()); // legend filters
  const [dialogOpen, setDialogOpen] = useState(false);                    // Load dialog open?
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("explore");
  // How many nodes to ask for. null means "do not send a limit", so the server
  // applies its own configured default; it becomes a number only once the user
  // presses Show more. Both this and the dismissal are per-ontology state and
  // are reset below when the active ontology changes.
  const [graphBudget, setGraphBudget] = useState<number | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // The shared query-builder state; the schema is only fetched in Query mode.
  const builder = useQueryBuilder(activeId, mode === "query");

  // Apply and persist the theme whenever it changes (data-theme drives the CSS).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("semantic-studio-theme", theme);
  }, [theme]);

  // On first mount, load the ontology list and select the most recent one.
  useEffect(() => {
    listOntologies()
      .then((list) => {
        setOntologies(list);
        if (list.length > 0) setActiveId(list[list.length - 1].id);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  // Reset the per-ontology view state the moment the ontology changes, during
  // render rather than in an effect. In an effect the fetch below would fire
  // once against the new ontology while still carrying the previous one's
  // budget, then again after the reset — two requests, the first one wrong.
  const [budgetFor, setBudgetFor] = useState<string | null>(null);
  if (budgetFor !== activeId) {
    setBudgetFor(activeId);
    setGraphBudget(null);
    setNoticeDismissed(false);
    setSelected(null);
    setHiddenKinds(new Set());
  }

  // Fetch the graph whenever the ontology or the requested budget changes.
  // The `cancelled` flag ignores a stale response if the user switches again
  // before it arrives.
  useEffect(() => {
    setGraphData(null);
    if (!activeId) return;
    setLoadingGraph(true);
    let cancelled = false;
    getGraph(activeId, graphBudget ?? undefined)
      .then((g) => !cancelled && setGraphData(g))
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoadingGraph(false));
    return () => {
      cancelled = true;
    };
  }, [activeId, graphBudget]);

  // The currently active ontology's summary (or null).
  const active = ontologies.find((o) => o.id === activeId) ?? null;

  // Called by the Load dialog once an ontology is loaded: add it and select it.
  const onLoaded = (summary: OntologySummary) => {
    setOntologies((prev) => [...prev, summary]);
    setActiveId(summary.id);
    setDialogOpen(false);
    setError(null);
  };

  // Remove the active ontology after confirmation, then select another (or none).
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
        // Fall back to the last remaining ontology, or clear if none left.
        setActiveId(next.length > 0 ? next[next.length - 1].id : null);
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Select a node AND re-centre the camera on it (focusTick is the trigger the
  // graph watches). Used by search picks and detail-panel navigation.
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

  // The distinct edge kinds present, for the legend's "relations" section.
  const edgeKinds = useMemo(() => {
    if (!graphData) return [];
    const kinds = new Set(graphData.edges.map((e) => e.kind));
    return [...kinds].sort();
  }, [graphData]);

  // Which entities are actually on the canvas, so the search box can mark the
  // results that are not. Search reads the whole ontology, so under a budget it
  // routinely finds entities the graph cannot show.
  const drawnIds = useMemo(
    () => (graphData ? new Set(graphData.nodes.map((n) => n.id)) : null),
    [graphData],
  );

  // The server clamps a budget above its maximum and reports what it clamped
  // to, so asking for more than we got is what "no more to draw" looks like.
  // Derived rather than mirroring the server's constant here, which would be a
  // second copy of a number to keep in step.
  const atMaximum =
    graphData !== null && graphBudget !== null && graphBudget > graphData.stats.budget;

  // Layout: a header (brand + nav rows), a main area (graph + right panel that
  // depends on the mode), a status bar, and the Load dialog when open.
  return (
    <div className="app">
      <header className="app-header">
        <div className="nav-row">
          <Logo />
          <nav className="main-nav" role="tablist" aria-label="Workspace">
            <button
              className="nav-item"
              onClick={() => setDialogOpen(true)}
              title="Load an ontology from a file or a URL"
            >
              <IconLoad />
              <span>Load</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "view"}
              className={mode === "view" ? "nav-item active" : "nav-item"}
              onClick={() => setMode("view")}
              title="Read the ontology file itself"
            >
              <IconView />
              <span>View</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "explore"}
              className={mode === "explore" ? "nav-item active" : "nav-item"}
              onClick={() => setMode("explore")}
              title="Browse the ontology and inspect entities"
            >
              <IconExplore />
              <span>Explore</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "query"}
              className={mode === "query" ? "nav-item active" : "nav-item"}
              onClick={() => setMode("query")}
              title="Build a SPARQL query by clicking the graph"
            >
              <IconQuery />
              <span>Query</span>
            </button>
          </nav>
          <div className="spacer" />
          <button
            className="header-icon-btn"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle colour theme"
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>

        <div className="context-row">
          {ontologies.length > 0 ? (
            <>
              <label className="context-label" htmlFor="ontology-select">
                ONTOLOGY
              </label>
              <select
                id="ontology-select"
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
              {active && (
                <button
                  className="ghost icon-btn danger"
                  onClick={() => void onRemove()}
                  title="Remove this ontology and delete its stored copy"
                  aria-label="Remove ontology"
                >
                  <IconTrash />
                </button>
              )}
            </>
          ) : (
            <span className="context-label">NO ONTOLOGY LOADED</span>
          )}
          <div className="spacer" />
          <SearchBox
            ontologyId={activeId}
            theme={theme}
            onPick={onSearchPick}
            drawnIds={drawnIds}
            placeholder={
              mode === "query" ? "Search to add a step…" : "Search concepts, properties…"
            }
          />
        </div>
      </header>

      {error && (
        <div className="error-bar" onClick={() => setError(null)} title="Click to dismiss">
          {error}
        </div>
      )}

      {/* Above the canvas, below the search box, so it reads before the graph
          and sits where the tab order already is. */}
      {graphData && !noticeDismissed && (
        <GraphNotice
          stats={graphData.stats}
          atMaximum={atMaximum}
          onShowMore={() => setGraphBudget(graphData.stats.budget * 2)}
          onDismiss={() => setNoticeDismissed(true)}
        />
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
            leftRail={
              graphData ? (
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
              ) : null
            }
          />
          {loadingGraph && <div className="loading-overlay">Building graph…</div>}
        </div>
        {/* View sits over the graph rather than replacing it, so switching
            back to Explore does not throw away the settled layout. */}
        {mode === "view" && <SourceView ontologyId={activeId} />}
        {mode === "query" ? (
          <QueryPanel
            ontologyId={activeId}
            theme={theme}
            builder={builder}
            onPickIri={selectAndFocus}
            ontologyTriples={active?.triples ?? 0}
          />
        ) : mode === "explore" ? (
          <DetailPanel
            ontologyId={activeId}
            iri={selected}
            onNavigate={selectAndFocus}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </main>

      <footer className="status-bar">
        {active ? (
          <>
            <span>{active.name}</span>
            <span>{active.triples.toLocaleString()} triples</span>
            {/* Under a budget these read "2,000 of 18,717". The status bar
                keeps saying so after the notice is dismissed, so the fact that
                the view is partial is never fully hidden. */}
            <span>{countOf(graphData, "node")} nodes</span>
            <span>{countOf(graphData, "edge")} edges</span>
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
