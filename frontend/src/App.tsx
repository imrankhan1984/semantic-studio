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

    Explore mode, the default, no longer shows nothing before the first click.
    With an ontology open and no selection the right-hand column is ExploreStart,
    which offers entities to open drawn from the graph response App already
    holds; DetailPanel takes over the moment something is selected, and closing
    it returns to the offer rather than to nothing.

    The graph the server hands over is budgeted, so it is usually part of the
    ontology. App can now grow it: a neighbourhood fetched for one entity is
    passed to GraphView as its own prop, merged into the graph already drawn,
    and what it added is reported back — which is why the drawn counts here are
    the response's plus what expansions have contributed. Replacing the graph
    response instead would rebuild the canvas and lose every settled position.

    Removal is the one destructive action here, and it counts what it will
    destroy before it asks. Deleting an ontology has always deleted every query
    saved against it; onRemove now fetches that count first, puts it in the
    confirmation, and reports afterwards what the server says it actually took.

INPUTS / INPUT SOURCES
    - The backend API (via api.ts) for the ontology list and graph.
    - User interaction: header tabs, dropdown, graph clicks, search.
    - localStorage for the remembered theme.

EXPECTED OUTPUT
    - The full rendered application UI, and the side effects of user actions
      (loading, switching, removing ontologies; building/running queries).
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteOntology,
  getGraph,
  getNeighborhood,
  listOntologies,
  listSavedQueries,
} from "./api";
import DetailPanel from "./components/DetailPanel";
import ExploreStart from "./components/ExploreStart";
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
import { removalConfirmation, removalPrompt } from "./removalPrompt";
import { useQueryBuilder } from "./sparql/useQueryBuilder";
import type {
  AppMode,
  MergeResult,
  OntologySummary,
  Theme,
  VizGraph,
  VizNeighborhood,
} from "./types";

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

/** What expansions have added to the budgeted graph. The node ids rather than a
 *  count, because the search box needs to know which entities became drawn. */
interface Expanded {
  nodes: Set<string>;
  edges: number;
}

const NOTHING_EXPANDED: Expanded = { nodes: new Set(), edges: 0 };

/**
 * The status-bar count for nodes or edges: "34" normally, "2,000 of 18,717"
 * when the budget dropped something, and "…" while the graph is loading.
 *
 * `extra` is what expansions have added since the graph was fetched. It is
 * added here rather than folded into `graphData`, because replacing that object
 * is what tears the canvas down and rebuilds it — the one thing an expansion
 * must not do.
 */
function countOf(graph: VizGraph | null, what: "node" | "edge", extra: Expanded): string {
  if (!graph) return "…";
  const added = what === "node" ? extra.nodes.size : extra.edges;
  const drawn = (what === "node" ? graph.stats.nodeCount : graph.stats.edgeCount) + added;
  const total = what === "node" ? graph.stats.nodeTotal : graph.stats.edgeTotal;
  if (!graph.stats.truncated) return drawn.toLocaleString();
  return `${drawn.toLocaleString()} of ${total.toLocaleString()}`;
}

/**
 * What an expansion is reported to have done, in one sentence.
 *
 * Three things it has to get right. Zero is its own case: "Added 0 entities"
 * reads like a failure when what happened is that everything this entity
 * connects to was already on the canvas. A truncated neighbourhood says so,
 * because the house rule is that when the server truncates something the
 * interface says it did. And the drawn total is repeated every time, since it
 * is the number the whole feature is about.
 */
function expansionAnnouncement(
  added: number,
  drawn: number,
  stats: VizNeighborhood["stats"],
): string {
  const where = `${drawn.toLocaleString()} of ${stats.nodeTotal.toLocaleString()} drawn.`;
  if (added === 0) {
    return `Nothing new to draw: those connections are already on the graph. ${where}`;
  }
  const what = added === 1 ? "1 entity" : `${added.toLocaleString()} entities`;
  const partial = stats.truncated
    ? ` Showing the ${stats.budget.toLocaleString()} most connected of ${stats.neighborTotal.toLocaleString()} connections.`
    : "";
  return `Added ${what}.${partial} ${where}`;
}

export default function App() {
  // --- top-level state ---
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);   // dropdown list
  const [activeId, setActiveId] = useState<string | null>(null);          // selected ontology
  const [graphData, setGraphData] = useState<VizGraph | null>(null);      // its graph
  const [selected, setSelected] = useState<string | null>(null);          // clicked node (Explore)
  const [focusTick, setFocusTick] = useState(0);                          // bump to re-centre camera
  const [focusPanel, setFocusPanel] = useState(false);                    // panel takes focus?
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
  // The removal pair: `removing` covers the count request that runs before the
  // confirmation dialog, and `notice` is what the removal is reported in
  // afterwards. Kept apart from `error` because neither is a failure.
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const wasRemoving = useRef(false);
  const [mode, setMode] = useState<AppMode>("explore");
  // How many nodes to ask for. null means "do not send a limit", so the server
  // applies its own configured default; it becomes a number only once the user
  // presses Show more. Both this and the dismissal are per-ontology state and
  // are reset below when the active ontology changes.
  const [graphBudget, setGraphBudget] = useState<number | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // The expansion trio. `expansion` is handed to GraphView to merge and carries
  // a token, because two expansions of the same entity are two merges and a
  // prop that compared equal would collapse them into one. `expanded` is what
  // the merges actually added, which only GraphView can know. `expandingIri` is
  // the request in flight, so the control that started it can say so.
  const [expansion, setExpansion] = useState<{
    data: VizNeighborhood;
    token: number;
  } | null>(null);
  const [expanded, setExpanded] = useState<Expanded>(NOTHING_EXPANDED);
  const [expandingIri, setExpandingIri] = useState<string | null>(null);
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

  // Give the remove control its focus back when the count finishes.
  //
  // Disabling a focused button blurs it to the document body, and re-enabling
  // it does not undo that. Measured in Chrome on 2026-07-30 against the built
  // application: after pressing Remove, `document.activeElement` was BODY, so a
  // keyboard user who declined the dialog was returned to nowhere. The whole
  // argument for keeping `window.confirm` (spec section 6) is that it returns
  // focus on dismissal, and it can only return focus to something that had it.
  //
  // It has to be an effect rather than a line after `setRemoving(false)`,
  // because at that point React has not re-rendered and `focus()` on a still
  // disabled button does nothing.
  useEffect(() => {
    if (wasRemoving.current && !removing) removeRef.current?.focus();
    wasRemoving.current = removing;
  }, [removing]);

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
    setFocusPanel(false);
    setHiddenKinds(new Set());
  }

  // Fetch the graph whenever the ontology or the requested budget changes.
  // The `cancelled` flag ignores a stale response if the user switches again
  // before it arrives.
  useEffect(() => {
    setGraphData(null);
    // A new graph response replaces the canvas, so everything expansions added
    // to the old one is gone with it. That is the documented way to shrink the
    // view back: reloading returns to the budgeted graph. Reset here rather
    // than beside the activeId reset above, because "Show more" refetches
    // without changing the ontology and discards the merges just the same.
    setExpansion(null);
    setExpanded(NOTHING_EXPANDED);
    setExpandingIri(null);
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
    setNotice(null);
  };

  // Remove the active ontology after confirmation, then return to the chooser.
  // It used to fall back to the last remaining ontology, which reintroduced
  // exactly the unasked-for render this screen exists to stop.
  //
  // The saved queries are counted BEFORE the dialog opens, because the dialog
  // is where the user decides and the number is the thing they are deciding
  // about. The endpoint already deleted those queries; all that was missing was
  // saying so. A failure to count is carried as null, never as zero — see
  // removalPrompt.ts, which is where that distinction is enforced and tested.
  const onRemove = async () => {
    if (!activeId) return;
    const name = ontologies.find((o) => o.id === activeId)?.name ?? "this ontology";
    setRemoving(true);
    let count: number | null = null;
    let names: string[] = [];
    try {
      const saved = await listSavedQueries(activeId);
      count = saved.length;
      names = saved.map((q) => q.name);
    } catch {
      count = null; // unknown, not zero
    } finally {
      setRemoving(false);
    }
    if (!window.confirm(removalPrompt(name, count, names))) return;
    try {
      // The count comes back from the delete rather than being reused from
      // above: another tab may have saved one in between, and what was actually
      // destroyed is the only number worth repeating.
      const result = await deleteOntology(activeId);
      setOntologies((prev) => prev.filter((o) => o.id !== activeId));
      setActiveId(null);
      // `?? 0` guards a server that predates the field: without it the message
      // would read "and undefined saved queries".
      setNotice(removalConfirmation(name, result.deletedQueries ?? 0));
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
  //
  // `panelTakesFocus` travels with the selection rather than being separate
  // state, because it is a property of *this* selection and of no other. Every
  // route that selects therefore states it, and the default is no: a search pick
  // leaves the user in the search box, and a term link inside the panel leaves
  // them where they were reading.
  const selectAndFocus = useCallback((iri: string | null, panelTakesFocus = false) => {
    setSelected(iri);
    setFocusPanel(panelTakesFocus);
    if (iri) setFocusTick((t) => t + 1);
  }, []);

  // Picking one of Explore mode's suggestions. It selects and re-centres like a
  // search pick, and additionally hands focus to the detail panel's heading:
  // this is the one selection route where the control the user was standing on
  // is the thing being replaced, so leaving focus where it was would leave it
  // nowhere.
  const onSuggestionSelect = useCallback(
    (iri: string) => selectAndFocus(iri, true),
    [selectAndFocus],
  );

  // In Explore mode a click opens the detail panel; in Query mode it
  // appends a step to the query being built.
  const onGraphSelect = useCallback(
    (iri: string | null) => {
      if (mode === "query") {
        if (iri) void builder.addNode(iri);
        return;
      }
      setSelected(iri);
      // A graph click is not a suggestion, and it has to say so: without this
      // the flag left behind by an earlier suggestion would send focus to the
      // panel heading on a click the user made with the mouse, somewhere else.
      setFocusPanel(false);
    },
    [mode, builder],
  );

  // Which entities are actually on the canvas, so the search box can mark the
  // results that are not. Search reads the whole ontology, so under a budget it
  // routinely finds entities the graph cannot show — and what an expansion adds
  // has to count here too, or a row would keep saying "not drawn" about
  // something the user has just drawn.
  const drawnIds = useMemo(() => {
    if (!graphData) return null;
    const ids = new Set(graphData.nodes.map((n) => n.id));
    for (const id of expanded.nodes) ids.add(id);
    return ids;
  }, [graphData, expanded]);
  // Read by onSearchPick, which must not be rebuilt every time the drawn set
  // changes: SearchBox would then see a new onPick on each merge.
  const drawnIdsRef = useRef(drawnIds);
  drawnIdsRef.current = drawnIds;

  // Draw one entity and everything it connects to, without refetching the
  // graph. The response goes to GraphView as its own prop rather than into
  // graphData, because replacing graphData rebuilds the scene from scratch and
  // an expansion that threw away every settled position would be worse than no
  // expansion at all.
  //
  // The active-ontology check is not theoretical: the request is in flight
  // while the user can still switch ontologies, and merging a stale
  // neighbourhood into a different ontology's graph would draw entities that
  // are not in it.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const onExpand = useCallback(async (iri: string) => {
    const id = activeIdRef.current;
    if (!id) return;
    setExpandingIri(iri);
    try {
      const data = await getNeighborhood(id, iri);
      if (activeIdRef.current !== id) return;
      // The token, not the data, is what tells GraphView this is a new merge:
      // expanding the same entity twice hands over an equal object.
      setExpansion((prev) => ({ data, token: (prev?.token ?? 0) + 1 }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (activeIdRef.current === id) setExpandingIri(null);
    }
  }, []);

  // What the merge actually did. Deliberately not a useCallback: GraphView
  // holds this in a ref, so a fresh identity per render costs nothing, and it
  // is what keeps `graphData` and `expansion` current here without a dependency
  // array that would have to list them.
  const onExpanded = (result: MergeResult) => {
    if (!graphData || !expansion) return;
    const nodes = new Set(expanded.nodes);
    for (const id of result.addedNodes) nodes.add(id);
    setExpanded({ nodes, edges: expanded.edges + result.addedEdges });
    setNotice(
      expansionAnnouncement(
        result.addedNodes.length,
        graphData.stats.nodeCount + nodes.size,
        expansion.data.stats,
      ),
    );
  };

  // Searching in Query mode adds the match to the path, so a query can be
  // built by name without hunting for a node in a large graph.
  //
  // A hit outside the budget is drawn rather than merely selected. That is the
  // whole of stage 2 from the user's side: before it, picking such a row opened
  // a panel about an entity the canvas could not show, and the row said "not
  // drawn" with nothing to be done about it.
  const onSearchPick = useCallback(
    (iri: string) => {
      selectAndFocus(iri);
      if (mode === "query") void builder.addNode(iri);
      if (drawnIdsRef.current && !drawnIdsRef.current.has(iri)) void onExpand(iri);
    },
    [mode, builder, selectAndFocus, onExpand],
  );

  // The distinct edge kinds present, for the legend's "relations" section.
  const edgeKinds = useMemo(() => {
    if (!graphData) return [];
    const kinds = new Set(graphData.edges.map((e) => e.kind));
    return [...kinds].sort();
  }, [graphData]);

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
              {/* Disabled and aria-busy while the saved queries are counted,
                  so no dialog can open over a stale number and a screen reader
                  user is told why the control is briefly inert. */}
              <button
                ref={removeRef}
                className="ghost icon-btn danger"
                onClick={() => void onRemove()}
                disabled={removing}
                aria-busy={removing}
                title={
                  removing
                    ? "Counting saved queries…"
                    : "Remove this ontology and delete its stored copy"
                }
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

      {/* What a removal actually took. Polite rather than assertive, and a
          status rather than an alert, because the action has already happened
          and nothing needs a decision.

          The region is rendered even when empty, for the reason StartScreen's
          own live region records: a live region added to the DOM at the same
          moment as its text is unreliably announced. That matters more here
          than there, because the same render also swaps the whole main area
          back to the chooser. The visible bar inside it is conditional, so an
          idle region occupies no space and draws nothing. */}
      <div className="notice-region" role="status" aria-live="polite">
        {notice && (
          <div className="notice-bar" onClick={() => setNotice(null)} title="Click to dismiss">
            {notice}
          </div>
        )}
      </div>

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
          onOpen={(id) => {
            setNotice(null);
            setActiveId(id);
          }}
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
              expansion={expansion}
              onExpanded={onExpanded}
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
            // The two halves of the Explore column. Which one shows is decided
            // here rather than inside DetailPanel: that component describes one
            // entity and fetches on mount, and giving it a second job needing no
            // fetch would make the least-tested component harder to test.
            selected === null ? (
              <ExploreStart
                graph={graphData}
                loading={loadingGraph}
                theme={theme}
                onSelect={onSuggestionSelect}
              />
            ) : (
              <DetailPanel
                ontologyId={activeId}
                iri={selected}
                onNavigate={selectAndFocus}
                onClose={() => setSelected(null)}
                focusHeading={focusPanel}
                onExpand={(entity) => void onExpand(entity)}
                expanding={expandingIri === selected}
              />
            )
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
            <span>{countOf(graphData, "node", expanded)} nodes</span>
            <span>{countOf(graphData, "edge", expanded)} edges</span>
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
