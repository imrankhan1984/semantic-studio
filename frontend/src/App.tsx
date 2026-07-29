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

    Nothing is fetched or parsed until the user picks an ontology. With no
    active id the main area is the StartScreen chooser and the mode tabs are
    disabled; App requests the ontology list and nothing else. That is a change
    from selecting the most recently added ontology on mount, which rendered
    18,717 nodes on every page load for anyone with FIBO stored.

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
import StartScreen from "./components/StartScreen";
import {
  IconClose,
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

/** Why the three mode tabs are disabled with nothing open. One string, because
 *  it is the same reason on all three and it belongs in the title attribute
 *  rather than only in the disabled styling. */
const NO_ONTOLOGY_TITLE = "Open an ontology first";

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
  const [dialogTab, setDialogTab] = useState<"file" | "url" | "suggested">("suggested");
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The ontology list's own loading and failure state, kept apart from `error`
  // above. A list that will not load is reported inside the chooser's library
  // section, because the catalogue and the file routes still work without it
  // and the error bar would imply the whole screen was broken.
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
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

  // Load the ontology list. It sets the list and NOTHING else: selecting the
  // most recent entry here is what made every page load render whatever the
  // user last happened to add. `activeId` stays null, so the chooser decides.
  // Also the retry the chooser offers when this fails.
  const refreshList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    listOntologies()
      .then((list) => setOntologies(list))
      .catch((e) => setListError(String(e.message ?? e)))
      .finally(() => setListLoading(false));
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

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

  // Called by the Load dialog and the chooser's catalogue once an ontology is
  // loaded: add it and select it. Someone who deliberately loaded a file
  // expects to see it, so this one path does open a graph without a second
  // click. Deduplicated by id because the same catalogue entry can be fetched
  // twice in a session and the backend returns the existing summary.
  const onLoaded = (summary: OntologySummary) => {
    setOntologies((prev) => [...prev.filter((o) => o.id !== summary.id), summary]);
    setActiveId(summary.id);
    setDialogOpen(false);
    setError(null);
  };

  // Remove the active ontology after confirmation, then return to the chooser.
  // It used to fall back to the last remaining ontology, which reintroduced
  // exactly the unasked-for render this screen exists to stop.
  const onRemove = async () => {
    if (!activeId) return;
    const name = ontologies.find((o) => o.id === activeId)?.name ?? "this ontology";
    if (!window.confirm(`Remove “${name}” and delete its stored copy? It will no longer appear after a restart.`)) {
      return;
    }
    try {
      await deleteOntology(activeId);
      setOntologies((prev) => prev.filter((o) => o.id !== activeId));
      setActiveId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Close without deleting: back to the chooser, the stored copy untouched.
  const onCloseOntology = () => {
    setActiveId(null);
    setError(null);
  };

  // Open the Load dialog on a named tab, so the chooser's file and URL routes
  // reuse the dialog's drag-and-drop and GitHub URL rewriting rather than
  // growing a second copy of either.
  const openDialog = (tab: "file" | "url" | "suggested") => {
    setDialogTab(tab);
    setDialogOpen(true);
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
            {/* Load stays enabled with no ontology open: it is the way out of
                an empty library, so disabling it would be a dead end. */}
            <button
              className="nav-item"
              onClick={() => openDialog("suggested")}
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
              disabled={!activeId}
              title={activeId ? "Read the ontology file itself" : NO_ONTOLOGY_TITLE}
            >
              <IconView />
              <span>View</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "explore"}
              className={mode === "explore" ? "nav-item active" : "nav-item"}
              onClick={() => setMode("explore")}
              disabled={!activeId}
              title={activeId ? "Browse the ontology and inspect entities" : NO_ONTOLOGY_TITLE}
            >
              <IconExplore />
              <span>Explore</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "query"}
              className={mode === "query" ? "nav-item active" : "nav-item"}
              onClick={() => setMode("query")}
              disabled={!activeId}
              title={activeId ? "Build a SPARQL query by clicking the graph" : NO_ONTOLOGY_TITLE}
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
          {/* Keyed off `active`, not the list length: with a saved library and
              the chooser open there is nothing for the dropdown to select, and
              a select showing a blank row would look like a defect. */}
          {active ? (
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
              {/* Close and remove sit side by side and do very different
                  things, so only one of them is red and their accessible names
                  say which is which. Close is the ordinary icon button. */}
              <button
                className="ghost icon-btn"
                onClick={onCloseOntology}
                title="Close this ontology and return to the start screen"
                aria-label="Close this ontology"
              >
                <IconClose />
              </button>
              <button
                className="ghost icon-btn danger"
                onClick={() => void onRemove()}
                title="Remove this ontology and delete its stored copy"
                aria-label="Remove ontology"
              >
                <IconTrash />
              </button>
            </>
          ) : (
            <span className="context-label">NO ONTOLOGY OPEN</span>
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

      {/* With nothing open the chooser IS the main region, rather than sitting
          inside one: it carries its own <main> and its own heading, so the
          document never has two. */}
      {activeId === null ? (
        <StartScreen
          ontologies={ontologies}
          loading={listLoading}
          error={listError}
          onRetry={refreshList}
          onOpen={setActiveId}
          onLoaded={onLoaded}
          onOpenDialog={openDialog}
        />
      ) : (
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
      )}

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

      {dialogOpen && (
        <LoadDialog
          onLoaded={onLoaded}
          onClose={() => setDialogOpen(false)}
          initialTab={dialogTab}
        />
      )}
    </div>
  );
}
