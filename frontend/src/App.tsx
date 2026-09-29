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
    active id the main area is the HomeScreen library; App requests the ontology
    list and nothing else. That is a change from selecting the most recently
    added ontology on mount, which rendered 18,717 nodes on every page load for
    anyone with FIBO stored, and the home screen inherits the budget: it draws a
    thumbnail per ontology from metadata the server wrote at ingest, so it costs
    no request of its own.

    Home is a fourth view rather than a state of having nothing open, and it is
    a VIEW rather than a reset: pressing it keeps the loaded ontology, the
    selection and the query being built, so it is safe to press and does not
    duplicate "Close this ontology". See D-026. Because Home exists, the three
    mode tabs are no longer disabled with nothing open — pressing one is
    remembered as a pendingMode and the library heading asks which ontology to
    act on, which teaches that modes act on an ontology where a disabled control
    taught nothing. A card's three verbs answer the same question in one press
    and are the ordinary route.

    Explore mode, the default, no longer shows nothing before the first click.
    With an ontology open and no selection the right-hand column is ExploreStart,
    which offers entities to open drawn from the graph response App already
    holds; DetailPanel takes over the moment something is selected, and closing
    it returns to the offer rather than to nothing.

    The graph the server hands over is budgeted, so it is usually part of the
    ontology, and App moves that budget in both directions. Show more doubles
    it and Show less halves it, down to a floor App learns rather than declares:
    the budget the first response for an ontology carried, which is the server's
    own default including any environment override. The bar carrying those two
    controls cannot be dismissed and there is no state here for having done so:
    a ✕ used to hide it for the rest of the session and take both controls with
    it, which is defect D-2.

    The main area opens with a skip link, hidden until it takes focus. The graph
    itself is a WebGL canvas with nothing in the accessibility tree to navigate,
    so the keyboard route through an ontology is the panel beside it — the
    suggestions, the search box and the detail panel's links — and the skip link
    is what makes that route reachable rather than something to tab past a
    canvas to find. See D-025.

    App can also grow the graph without changing the budget: a neighbourhood
    fetched for one entity is passed to GraphView as its own prop, merged into
    the graph already drawn, and what it added is reported back — which is why
    the drawn counts here are the response's plus what expansions have
    contributed. Replacing the graph response instead would rebuild the canvas
    and lose every settled position.

    Every route that names an entity from outside the canvas — the search box
    and the results table — goes through one function, so a result row can draw
    an entity the budget left out exactly as a search hit does. A result also
    leads the other way: its second control switches to View mode with that
    entity as the source pane's target.

    The header carries two controls that are about the application rather than
    about an ontology: About, which opens a static dialog naming the project,
    its author, its repository and its licence; and Network, which opens the
    offline switch, the sites allowed or blocked, and the recent connections.
    Each is held in the same shape as the Load dialog — one boolean, and the
    panel rendered only while open.

    App is also where a network question is answered (external-access Stage 1).
    On mount it registers a handler with api.ts; when any call meets a 409
    approval_required, the handler opens NetworkApprovalDialog and waits. The
    answer is posted as a grant and handed back, and api.ts repeats the call —
    so the component that started the action (the Load dialog, usually) only
    ever sees success or a sentence saying the connection was not made.

    Imports (external-access Stage 2) are resolved from the imports panel, shown
    in View and Hierarchy modes, and nothing is resolved on open. Whether the
    views include them is one switch per ontology, held here because every view
    reads it -- the graph, search, the detail panel, the hierarchy, the query
    builder and SPARQL all pass it to the server as ?imports=true. It is off
    unless the user turned it on, and remembered per ontology in this browser.

    Projects (authoring-foundations) are the user's own work, opened from the
    Home screen's first section. An open project document is just another
    activeId -- prj-<hex>-<doc> -- so every view works on it unchanged; what
    authoring adds lives in the project store (state/projectStore.ts, D-084)
    rather than here. App keeps three jobs for it: the revision and display
    language join the fetch keys, so every view refreshes after a change
    (D-081); View mode becomes the Turtle editor; and every way out of an
    edit asks first -- unapplied editor text asks "Apply, discard, or stay?",
    unsaved changes ask "Save, discard, or stay?" -- because only App sees
    both the edit and the way out. Mount now makes two requests: the ontology
    list and the project list, both from metadata files.

    A project is an ontology or a taxonomy (relationships 5.1, D-089). The
    kind travels with the editing context to the tree, the canvas and the
    form, which offer its tools and show the other kind read-only; it is
    changed from the project's card menu, after one sentence of what changes.
    A click on a subclass or broader line in the canvas opens LinkPanel where
    the detail panel stands; a click on a relationship's line selects the
    relationship like any entity (5.2).

    Removal is the one destructive action here, and it counts what it will
    destroy before it asks. Deleting an ontology has always deleted every query
    saved against it; onRemove now fetches that count first, puts it in the
    confirmation, and reports afterwards what the server says it actually took.

INPUTS / INPUT SOURCES
    - The backend API (via api.ts) for the ontology list and graph.
    - User interaction: header tabs, dropdown, graph clicks, search.
    - localStorage for the remembered theme and the per-ontology imports switch.

EXPECTED OUTPUT
    - The full rendered application UI, and the side effects of user actions
      (loading, switching, removing ontologies; building/running queries).
================================================================================
*/

import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  createProject,
  deleteOntology,
  deleteProject,
  downloadDocumentCopy,
  duplicateProject,
  exportProject,
  getGraph,
  getNeighborhood,
  grantNetwork,
  listImports,
  listOntologies,
  listProjects,
  listSavedQueries,
  setApprovalHandler,
  updateProject,
} from "./api";
import ConfirmDialog from "./components/ConfirmDialog";
import NewProjectDialog, { type NewProjectRequest } from "./components/NewProjectDialog";
import ProjectHeader from "./components/ProjectHeader";
import ProjectsSection from "./components/ProjectsSection";
import TurtleEditor from "./components/TurtleEditor";
import { triggerDownload } from "./download";
import {
  activeDocument,
  projectStore,
  revisionOf,
  useProjectSelector,
} from "./state/projectStore";
import AboutPanel from "./components/AboutPanel";
import DetailPanel from "./components/DetailPanel";
import ExploreStart from "./components/ExploreStart";
import GraphNotice from "./components/GraphNotice";
import GraphView from "./components/GraphView";
import HierarchyView from "./components/HierarchyView";
import HomeScreen from "./components/HomeScreen";
import ImportsPanel from "./components/ImportsPanel";
import LinkPanel from "./components/LinkPanel";
import Legend from "./components/Legend";
import LoadDialog from "./components/LoadDialog";
import Logo from "./components/Logo";
import NetworkApprovalDialog from "./components/NetworkApprovalDialog";
import NetworkPanel from "./components/NetworkPanel";
import QueryPanel from "./components/QueryPanel";
import SearchBox from "./components/SearchBox";
import SourceView from "./components/SourceView";
import {
  IconAbout,
  IconClose,
  IconExplore,
  IconHierarchy,
  IconHome,
  IconLoad,
  IconMoon,
  IconNetwork,
  IconQuery,
  IconSun,
  IconTrash,
  IconView,
} from "./components/icons";
import { removalConfirmation, removalPrompt } from "./removalPrompt";
import type { SourceTarget } from "./sourceTarget";
import { useQueryBuilder } from "./sparql/useQueryBuilder";
import type {
  AppMode,
  ApprovalRequest,
  CanvasLink,
  CanvasSet,
  ImportsListing,
  MergeResult,
  OntologySummary,
  ProjectDocName,
  ProjectSummary,
  Theme,
  VizGraph,
  VizNeighborhood,
} from "./types";

// The modeling canvas (visual-modeling 5.4, D-086): its own chunk, React Flow
// with it, fetched from the local server the first time a canvas opens in a
// session and from the browser's cache after that -- never before, and never
// from the internet. A factory, because React.lazy keeps a failed import: a
// retry needs a new one.
const loadCanvas = () => lazy(() => import("./canvas/ModelCanvas"));

/** A canvas that could not load leaves the tree and the form working. */
class CanvasBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="model-canvas canvas-message" aria-label="Modeling canvas">
        <p>The canvas could not load. The tree and the form still work.</p>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onRetry();
          }}
        >
          Retry
        </button>
      </section>
    );
  }
}

// The Canvas / Tree only switch, per browser (5.4). Storage can be refused.
const CANVAS_KEY = "semantic-studio-canvas";
function canvasPreference(): boolean {
  try {
    return localStorage.getItem(CANVAS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** The 5.6 warning, word for word, before a commented file is rewritten. */
const COMMENTS_WARNING =
  "This file has comments. Saving after a visual change rewrites it in a standard " +
  "layout and removes them.";

/** "28 Sep 2026, 14:05" for the recovery question. */
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** What a mode tab says when there is nothing for it to act on yet. The tabs
 *  used to be disabled here, which prevented the empty canvas by removing the
 *  choice rather than by answering it; now they route through Home and the
 *  library heading asks which ontology. */
const NO_ONTOLOGY_TITLE = "Pick an ontology on the home screen first";

/** What a 404 from /neighborhood means, said without calling it an error.
 *
 *  The endpoint refuses an IRI that is not a node in the visualization graph,
 *  and predicates never are — nor are blank nodes. Reaching that from a result
 *  row or a search hit is an ordinary thing to do, so it belongs in the polite
 *  region beside the expansion counts rather than in the red bar that means
 *  something went wrong. Before the crash fix on 2026-07-30 this route blanked
 *  the whole application; a silent non-response replaced it, and this replaces
 *  that. */
/**
 * What the skip link aims at, most specific first.
 *
 * The column beside the graph holds a different component per mode, and each
 * already has a heading it names itself by. In Explore that is the starting
 * panel or, once something is selected, the detail panel; View overlays the
 * source pane; Query has no heading of its own, so the panel itself is the
 * target and carries an aria-label instead.
 *
 * Order matters only where two could exist at once, which is View over Explore:
 * the source pane is on top and is what the user is reading, so it wins.
 */
const PANEL_HEADING_IDS = [
  "source-view-heading",
  "explore-start-heading",
  "detail-panel-heading",
  "query-panel-region",
];

const NOT_A_GRAPH_NODE =
  "That entity is not drawn on the graph, so the view did not move: relationships " +
  "and blank nodes are described but never shown as nodes.";

/** The theme to start in: saved preference, else the OS setting, else dark. */
function initialTheme(): Theme {
  const saved =
    localStorage.getItem("semantic-studio-theme") ??
    localStorage.getItem("semantic-viewer-theme"); // pre-rename preference
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Where the per-ontology "Include imports" switch is remembered. A browser
// convenience rather than server state: it changes what this viewer is shown,
// never what is stored, and losing it (a private window, cleared site data)
// only returns an ontology to the default, which is off.
const INCLUDE_IMPORTS_KEY = "semantic-studio-include-imports";

function readIncludeImports(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(INCLUDE_IMPORTS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolvedCount(listing: ImportsListing): number {
  return listing.imports.filter((r) => r.status === "resolved").length;
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
  // The About dialog, in the same shape as the Load dialog above: one boolean,
  // and the panel rendered only while it is true rather than rendered hidden.
  // The ref is what closing focuses back to — only App holds that element.
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutRef = useRef<HTMLButtonElement>(null);
  // Network settings, the same shape again. Focus goes back to the control by
  // the panel itself (useDialogTrap), because it records what opened it.
  const [networkOpen, setNetworkOpen] = useState(false);
  // The question the network broker is waiting on, and the resolver of the
  // api.ts promise that is paused until it is answered.
  const [approval, setApproval] = useState<{
    requests: ApprovalRequest[];
    resolve: (grantIds: string[] | null) => void;
  } | null>(null);
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
  // Which ontology the removal count is running against. It exists because
  // removal can now be started from a card as well as from the header, and the
  // card that started it is the one that has to say it is busy.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("explore");
  // A mode picked from the header with nothing open. It is remembered rather
  // than refused, so the library heading can ask which ontology it should act
  // on and the pick lands straight in that mode. Cleared by anything that
  // answers the question, and by pressing Home, which withdraws it.
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null);
  // How many nodes to ask for. null means "do not send a limit", so the server
  // applies its own configured default; it becomes a number only once the user
  // presses Show more. Per-ontology state, reset below when the active ontology
  // changes.
  const [graphBudget, setGraphBudget] = useState<number | null>(null);
  // The budget the server applied before the user changed anything, which is
  // the floor Show less stops at. Read from the first response for an ontology
  // rather than written here as 2,000: SEMANTIC_STUDIO_GRAPH_NODE_BUDGET moves
  // the server's default, and a second copy of the number in the client would
  // silently ignore it.
  const [defaultBudget, setDefaultBudget] = useState<number | null>(null);
  // Which budget control was pressed, handed to the notice once the new graph
  // arrives so focus can go back to the pair. Two halves, because the press and
  // the arrival are far apart: the ref carries the intent across the request,
  // and the state is what the remounted notice actually reads.
  const pendingBudgetPress = useRef<"more" | "less" | null>(null);
  const [budgetPress, setBudgetPress] = useState<"more" | "less" | null>(null);
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
  // How many expanded entities the last budget change discarded, reported in the
  // notice beside the counts so the graph shrinking is not a mystery (G-8). Zero
  // when a budget change cleared nothing, and zero on an ontology switch — which
  // clears expansions too, but a note about them there is noise about a view the
  // user just left (see the spec's edge-case table). Read from a ref in the
  // refetch effect, because that effect is keyed on the budget and must not gain
  // `expanded` as a dependency.
  const [clearedExpansions, setClearedExpansions] = useState(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Where the source pane should position itself. No token beside it, unlike
  // `expansion` above: this is set from a click rather than from a response, so
  // pressing the same control twice already hands over a new object and the
  // effect that reads it re-runs on its own.
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);
  // The shared query-builder state; the schema is only fetched in Query mode.
  // The merged-view switch, per ontology (external-access Stage 2). Off by
  // default, so opening a file shows the file, exactly as before (Section 7).
  const [includeImportsById, setIncludeImportsById] =
    useState<Record<string, boolean>>(readIncludeImports);
  const includeImports = activeId !== null && includeImportsById[activeId] === true;
  const includeImportsRef = useRef(includeImports);
  includeImportsRef.current = includeImports;
  const setIncludeImports = useCallback(
    (next: boolean) => {
      if (!activeId) return;
      setIncludeImportsById((prev) => {
        const updated = { ...prev, [activeId]: next };
        try {
          localStorage.setItem(INCLUDE_IMPORTS_KEY, JSON.stringify(updated));
        } catch {
          /* remembered for this session only */
        }
        return updated;
      });
    },
    [activeId],
  );
  // Bumped when the resolved closure changes, so views built over the merged
  // view are fetched again. Only the graph effect reads it, and only while the
  // switch is on: with it off, a new closure changes nothing on screen.
  const [importsVersion, setImportsVersion] = useState(0);
  // How many imported documents are resolved, for the query panel's sentence.
  // null until known, and never fetched on mount: only in Query mode, or when
  // the imports panel reports a change.
  const [importsCount, setImportsCount] = useState<number | null>(null);
  const onImportsChanged = useCallback((listing: ImportsListing) => {
    setImportsCount(resolvedCount(listing));
    setImportsVersion((v) => v + 1);
  }, []);
  // The open project (authoring-foundations). Its revision and display
  // language are part of every fetch key below, so a change refreshes the
  // views; for a library ontology both are constant (0 and null).
  // Read slice by slice: the editor's text is in the store too and changes on
  // every keystroke, which must not re-render all of App.
  const openProjectSummary = useProjectSelector((s) => s.project);
  const projectDocuments = useProjectSelector((s) => s.documents);
  const projectActiveDoc = useProjectSelector((s) => s.activeDoc);
  const projectRecovery = useProjectSelector((s) => s.recovery);
  const commentsWarning = useProjectSelector((s) => s.commentsWarning);
  const projectSaving = useProjectSelector((s) => s.saving);
  const projectDoc = activeDocument({ documents: projectDocuments, activeDoc: projectActiveDoc });
  const revision = revisionOf({ documents: projectDocuments }, activeId);
  const editingProjectDoc =
    openProjectSummary !== null && projectDocuments.some((d) => d.ontologyId === activeId);
  // Only a project document's views are named by it; a library ontology open
  // beside a project ignores it, and must not refetch when it moves.
  const storeLanguage = useProjectSelector((s) => s.displayLanguage);
  const displayLanguage = editingProjectDoc ? storeLanguage : null;
  // The editing form and the tree's actions (visual-modeling 5.1, 5.2) are
  // for the open project's model.ttl only. Memoized: the form derives its
  // blocks from the languages array, and a new array per render would
  // redo that on every keystroke anywhere in App.
  const openDocName = projectDocuments.find((d) => d.ontologyId === activeId)?.doc ?? null;
  const editingModel = useMemo(
    () =>
      openProjectSummary && openDocName === "model"
        ? {
            primaryLanguage: openProjectSummary.primaryLanguage,
            languages: openProjectSummary.languages,
            // Which tools the visual doors offer (D-089).
            kind: openProjectSummary.kind,
          }
        : null,
    [openProjectSummary, openDocName],
  );
  // The canvas beside the tree (visual-modeling 5.4): its lazily loaded
  // component, the per-browser switch, and the shown set it lends the tree
  // and the form past 300 boxes (5.6).
  const [ModelCanvas, setModelCanvas] = useState(loadCanvas);
  const [canvasOn, setCanvasOn] = useState(canvasPreference);
  const [canvasSet, setCanvasSet] = useState<CanvasSet | null>(null);
  // A subclass or broader line clicked on the canvas: LinkPanel shows it
  // where the detail panel stands, until anything else is selected or the
  // model changes under it (relationships 5.2).
  const [selectedLink, setSelectedLink] = useState<CanvasLink | null>(null);
  const selectLink = useCallback((link: CanvasLink) => {
    setSelected(null);
    setSelectedLink(link);
  }, []);
  useEffect(() => {
    if (selected !== null) setSelectedLink(null);
  }, [selected]);
  useEffect(() => setSelectedLink(null), [revision, activeId]);
  // The project whose kind is being changed, while the question is open.
  const [changingKind, setChangingKind] = useState<ProjectSummary | null>(null);
  const toggleCanvas = useCallback(() => {
    setCanvasOn((on) => {
      try {
        localStorage.setItem(CANVAS_KEY, on ? "off" : "on");
      } catch {
        /* the choice lasts this session only */
      }
      return !on;
    });
  }, []);
  const showCanvas = editingModel !== null && canvasOn;
  const canvasLent = showCanvas ? canvasSet : null;
  // Why there is no Edit section, when the document is the reason (AC-4).
  const readOnlyNote = !activeId
    ? null
    : openDocName === null
      ? "From the library, read-only. Start a project from it to change it."
      : openDocName === "shapes"
        ? "shapes.ttl is edited as Turtle, in View; this form edits model.ttl."
        : null;
  // The project list, for the Home screen's first section.
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectBusyId, setProjectBusyId] = useState<string | null>(null);
  // The New project form, and the library ontology it starts from, if any.
  const [newProject, setNewProject] = useState<{ source?: string } | null>(null);
  // The two questions an exit can need, each holding what to do on the way
  // out once it is answered.
  const [leaveEditor, setLeaveEditor] = useState<(() => void) | null>(null);
  const [leaveProject, setLeaveProject] = useState<(() => void) | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);

  // An entity deleted from the form or the tree (visual-modeling 5.3). The
  // panel describing it goes, and with it whatever held focus in it, so
  // focus goes to the heading of what replaces it: the tree in Hierarchy,
  // the starting panel in Explore.
  const onEntityDeleted = useCallback((iri: string) => {
    setSelected((current) => (current === iri ? null : current));
    window.setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      (
        document.getElementById("hierarchy-view-heading") ??
        document.getElementById("explore-start-heading")
      )?.focus();
    }, 0);
  }, []);

  // The shared query-builder state; the schema is only fetched in Query mode.
  const builder = useQueryBuilder(activeId, mode === "query", includeImports, revision);

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

  // The project list, from manifests alone. The second of mount's two
  // requests; like the ontology list it parses nothing.
  const refreshProjects = useCallback(() => {
    setProjectsError(null);
    return listProjects()
      .then((list) => setProjects(list))
      .catch((e) => setProjectsError(String(e.message ?? e)))
      .finally(() => setProjectsLoading(false));
  }, []);

  useEffect(() => {
    refreshList();
    void refreshProjects();
  }, [refreshList, refreshProjects]);

  // Unsaved changes survive a closed tab in the autosaved draft, but the
  // browser's own question is still worth asking before the tab goes.
  const anyDirty = projectDocuments.some((d) => d.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [anyDirty]);

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
    setDefaultBudget(null);
    pendingBudgetPress.current = null;
    setSelected(null);
    setFocusPanel(false);
    setHiddenKinds(new Set());
    setSourceTarget(null);
    setImportsCount(null);
  }

  // Fetch the graph whenever the ontology or the requested budget changes.
  // The `cancelled` flag ignores a stale response if the user switches again
  // before it arrives.
  // What the graph on screen was fetched for, so a refetch caused only by an
  // edit or a language switch keeps it up until the new one arrives rather
  // than blanking the canvas on every change (found in review).
  const graphFor = useRef<string | null>(null);
  useEffect(() => {
    const identity = `${activeId}|${graphBudget}|${includeImports}`;
    if (graphFor.current !== identity) setGraphData(null);
    graphFor.current = identity;
    // A new graph response replaces the canvas, so everything expansions added
    // to the old one is gone with it. That is the documented way to shrink the
    // view back: reloading returns to the budgeted graph. Reset here rather
    // than beside the activeId reset above, because "Show more" refetches
    // without changing the ontology and discards the merges just the same.
    //
    // Report the discard, but only when a budget press is what triggered this
    // refetch (G-8). pendingBudgetPress is set by Show more / Show less and null
    // on an ontology switch, which is the one clearing that must stay silent.
    // Read from a ref so this effect keeps its [activeId, graphBudget] keys and
    // still sees the current count. GraphNotice appends the sentence.
    setClearedExpansions(pendingBudgetPress.current ? expandedRef.current.nodes.size : 0);
    setExpansion(null);
    setExpanded(NOTHING_EXPANDED);
    setExpandingIri(null);
    if (!activeId) return;
    setLoadingGraph(true);
    let cancelled = false;
    getGraph(activeId, graphBudget ?? undefined, includeImports)
      .then((g) => {
        if (cancelled) return;
        setGraphData(g);
        // No limit was sent, so what came back is the server's own default,
        // environment override included. That is the floor for this ontology.
        if (graphBudget === null) setDefaultBudget(g.stats.budget);
        // Hand the press over only now. Set at click time it would reach a
        // notice still showing the old counts, which would send focus by the
        // old enabled states and then clear itself before the real bar mounted.
        setBudgetPress(pendingBudgetPress.current);
        pendingBudgetPress.current = null;
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e.message ?? e));
        // Drop the press with the response that never came. Left set, it would
        // be consumed by whatever graph arrived next and move focus for a
        // button nobody had just pressed.
        pendingBudgetPress.current = null;
      })
      .finally(() => !cancelled && setLoadingGraph(false));
    return () => {
      cancelled = true;
    };
    // importsVersion only while the switch is on: a closure resolved with it
    // off changes nothing drawn, so it must not cost a refetch.
  }, [
    activeId,
    graphBudget,
    includeImports,
    includeImports ? importsVersion : 0,
    // A project document's revision and display language: an edit, an undo
    // or a language switch refetches the graph (D-081, D-085).
    revision,
    displayLanguage,
  ]);

  // The query panel says what a query runs over, which needs the number of
  // resolved imports. Asked for in Query mode only, so neither mount nor
  // opening an ontology costs a request for it.
  const inQuery = mode === "query";
  useEffect(() => {
    if (!activeId || !inQuery || importsCount !== null) return;
    let live = true;
    listImports(activeId)
      .then((listing) => live && setImportsCount(resolvedCount(listing)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [activeId, inQuery, importsCount]);

  // The currently active ontology's summary (or null). An open project
  // document is not in the library list, so its summary is made from the
  // project store: what the status bar and the query panel read.
  const active: OntologySummary | null =
    ontologies.find((o) => o.id === activeId) ??
    (editingProjectDoc && projectDoc && openProjectSummary
      ? {
          id: projectDoc.ontologyId,
          name: `${openProjectSummary.name} (${projectDoc.doc}.ttl)`,
          source: "project",
          format: "turtle",
          triples: projectDoc.triples,
          nodes: 0,
          edges: 0,
          kindCounts: {},
          namespaces: {},
        }
      : null);

  // The home screen stands in for the whole main area, and there are two ways
  // to be on it: nothing is open, or the user pressed Home with something open.
  // The second is a view rather than a reset — see D-026.
  const showHome = activeId === null || mode === "home";

  // Which mode a pick from Home should land in. The mode the user asked for
  // while nothing was open wins; otherwise whatever they were last in, and
  // Explore if that was Home itself, because "home" is not a mode a pick can
  // enter.
  const modeAfterPick = (): AppMode =>
    pendingMode ?? (mode === "home" ? "explore" : mode);

  // Open an ontology and enter a mode in one action, which is what a card's
  // three verbs do. "What to do with what" is one decision, so there is no
  // intermediate "choose an ontology" screen and no pending-mode state to
  // resolve — pressing Query on the FIBO card queries FIBO.
  //
  // Setting the same activeId again is deliberately cheap: the graph effect is
  // keyed on it, so a verb pressed on the ontology already open changes the
  // mode and makes no request.
  const enterMode = useCallback((id: string, next: AppMode) => {
    setPendingMode(null);
    setSourceTarget(null);
    setNotice(null);
    setError(null);
    setActiveId(id);
    setMode(next);
  }, []);

  // Which tab reads as chosen. On Home that is the mode the user asked for and
  // has not yet answered, if any — never the mode they happened to leave, which
  // would show Explore as selected on a screen that is not Explore.
  //
  // Home itself is chosen only while no such question is outstanding. Written
  // as `aria-selected={showHome}` it was not, and Home and Query both reported
  // themselves selected at once — measured in Chrome, where two selected tabs
  // in one tablist is a contradiction a screen reader has no way to resolve.
  const tabSelected = (m: AppMode) =>
    m === "home" ? showHome && pendingMode === null : showHome ? pendingMode === m : mode === m;

  // Home is a view, not a reset. The loaded ontology, the selection and the
  // query being built all survive, because the alternative — treating Home as
  // "close everything" — would make it dangerous to press and would duplicate
  // "Close this ontology", which already exists and says what it does. D-026.
  // Unapplied text in the Turtle editor: ask before whatever would unmount it.
  // Read from the store at the moment of asking, not subscribed to: App has no
  // other reason to re-render while the user types.
  const guardEditor = useCallback((then: () => void) => {
    if (projectStore.getSnapshot().editorDraft !== null) setLeaveEditor(() => then);
    else then();
  }, []);

  const goHome = useCallback(() => {
    guardEditor(() => {
      setPendingMode(null);
      setMode("home");
    });
  }, [guardEditor]);

  // Called by the Load dialog and the chooser's catalogue once an ontology is
  // loaded: add it and select it. Someone who deliberately loaded a file
  // expects to see it, so this one path does open a graph without a second
  // click. Deduplicated by id because the same catalogue entry can be fetched
  // twice in a session and the backend returns the existing summary.
  const onLoaded = (summary: OntologySummary) => {
    setOntologies((prev) => [...prev.filter((o) => o.id !== summary.id), summary]);
    setDialogOpen(false);
    // Through the same route a card verb takes, so a file loaded after pressing
    // Query on an empty library opens in Query rather than dropping the mode
    // the user had already asked for.
    enterMode(summary.id, modeAfterPick());
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
  //
  // It takes an id rather than reading activeId, because removal can now be
  // started from a card's menu on the home screen as well as from the header,
  // and on that screen the ontology being removed is usually not the active one.
  const onRemove = async (id: string) => {
    const name = ontologies.find((o) => o.id === id)?.name ?? "this ontology";
    setRemoving(true);
    setRemovingId(id);
    let count: number | null = null;
    let names: string[] = [];
    try {
      const saved = await listSavedQueries(id);
      count = saved.length;
      names = saved.map((q) => q.name);
    } catch {
      count = null; // unknown, not zero
    } finally {
      setRemoving(false);
      setRemovingId(null);
    }
    if (!window.confirm(removalPrompt(name, count, names))) return;
    try {
      // The count comes back from the delete rather than being reused from
      // above: another tab may have saved one in between, and what was actually
      // destroyed is the only number worth repeating.
      const result = await deleteOntology(id);
      setOntologies((prev) => prev.filter((o) => o.id !== id));
      // Only if it was the one open. Removing an ontology from a card on the
      // home screen must not close a different one the user still has loaded.
      if (id === activeId) setActiveId(null);
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

  // Close About and give the control that opened it its focus back, on all
  // three dismissal routes — the close button, Escape, and the backdrop.
  //
  // A plain call rather than the effect the remove button needs: that control
  // is disabled while it works, and focus() on a disabled button does nothing.
  // This one is never disabled and never unmounts, so it can take focus the
  // moment the panel is asked to go. Stable, so the panel's key handler is not
  // rebound on every render of App.
  const closeAbout = useCallback(() => {
    setAboutOpen(false);
    aboutRef.current?.focus();
  }, []);

  // Register the approval dialog with api.ts for the life of the app. No
  // request is made here: this is a callback, and mount's budget of exactly
  // one request is unchanged.
  useEffect(() => {
    setApprovalHandler(
      (requests) => new Promise((resolve) => setApproval({ requests, resolve })),
    );
    return () => setApprovalHandler(null);
  }, []);

  // Turn the dialog's answer into grants, then let the paused call continue.
  // Allow, just this time: a grant whose id the retry presents, spent by it.
  // Allow, always: a remembered grant, so the retry needs no id. Don't allow,
  // always: a remembered Block. Don't allow, just this time: nothing recorded.
  const answerApproval = useCallback(
    async (allow: boolean, remember: boolean) => {
      if (!approval) return;
      const { requests, resolve } = approval;
      setApproval(null);
      try {
        if (!allow) {
          if (remember) {
            for (const r of requests) {
              await grantNetwork({
                capability: r.capability,
                host: r.host,
                decision: "block",
                remember: true,
              });
            }
          }
          resolve(null);
          return;
        }
        const ids: string[] = [];
        // One grant per capability and host: a SERVICE query can send two
        // blocks to the same site, and that is one question and one answer.
        const unique = requests.filter(
          (r, i) =>
            requests.findIndex((o) => o.capability === r.capability && o.host === r.host) === i,
        );
        for (const r of unique) {
          const grant = await grantNetwork({
            capability: r.capability,
            host: r.host,
            decision: "allow",
            remember,
          });
          if (!grant.remember) ids.push(grant.id);
        }
        resolve(ids);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        resolve(null);
      }
    },
    [approval],
  );

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
      const data = await getNeighborhood(id, iri, undefined, includeImportsRef.current);
      if (activeIdRef.current !== id) return;
      // The token, not the data, is what tells GraphView this is a new merge:
      // expanding the same entity twice hands over an equal object.
      setExpansion((prev) => ({ data, token: (prev?.token ?? 0) + 1 }));
    } catch (e: unknown) {
      // 404 is the endpoint's answer for "that IRI is not a node here", which is
      // a fact about the graph rather than a failure — see NOT_A_GRAPH_NODE.
      // Everything else is a real error and keeps the error bar.
      if (e instanceof ApiError && e.status === 404) setNotice(NOT_A_GRAPH_NODE);
      else setError(e instanceof Error ? e.message : String(e));
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

  // Selecting an entity from somewhere that is not the graph itself: the search
  // box, or a row in the results table. Both can name an entity the node budget
  // left out, so both have to be able to draw it before centring on it.
  //
  // A hit outside the budget is drawn rather than merely selected. That is the
  // whole of stage 2 from the user's side: before it, picking such a row opened
  // a panel about an entity the canvas could not show, and the row said "not
  // drawn" with nothing to be done about it.
  //
  // One function rather than two because they drifted apart once already —
  // stage 2 taught search to draw, and the result chips, which had the same
  // problem for the same reason, were never told.
  const selectFromOutsideGraph = useCallback(
    (iri: string) => {
      selectAndFocus(iri);
      if (drawnIdsRef.current && !drawnIdsRef.current.has(iri)) void onExpand(iri);
    },
    [selectAndFocus, onExpand],
  );

  // Searching in Query mode additionally adds the match to the path, so a query
  // can be built by name without hunting for a node in a large graph. That half
  // is search's alone: clicking a result is inspecting an answer, not building
  // a query, and a chip that quietly extended the query would be a trap.
  const onSearchPick = useCallback(
    (iri: string) => {
      selectFromOutsideGraph(iri);
      if (mode === "query") void builder.addNode(iri);
    },
    [mode, builder, selectFromOutsideGraph],
  );

  // Follow a result into the file itself. The prefixed form travels with the
  // IRI because the pane usually shows pretty-printed Turtle, in which the
  // entity is written `ex:Thing` and the full IRI appears nowhere.
  //
  // The notice is cleared first: the sentence about to be announced is this
  // action's answer, and leaving the previous one up would have the live region
  // holding a stale reply to a different question.
  const onViewInSource = useCallback((iri: string, prefixed?: string) => {
    setNotice(null);
    setSourceTarget({ iri, prefixed });
    setMode("view");
  }, []);

  // What the source pane made of it. Only a miss is worth saying: a hit scrolls
  // the line into view and highlights it, and focus is already on the heading.
  //
  // A hit still clears, rather than being ignored. The pane re-runs its lookup
  // when the Original / Formatted toggle changes the document, and an entity
  // absent from one form is regularly present in the other — so ignoring the
  // null would leave "that entity does not appear" standing over a line that is
  // now highlighted.
  const onSourceTargetResolved = useCallback((missing: string | null) => {
    setNotice(missing);
  }, []);

  // Switching mode from the tab bar drops any source target. Without this,
  // leaving View and coming back re-runs the lookup, which moves focus to the
  // source heading — stealing it from the tab the user has just pressed, which
  // is the one thing the focus rule in SourceView exists to avoid.
  //
  // With nothing open it becomes a question rather than a dead end: the mode is
  // remembered, Home stays up, and its library heading asks which ontology to
  // act on. The tabs used to be disabled here, which prevented the empty canvas
  // by removing the choice instead of answering it.
  const onPickMode = useCallback(
    (next: AppMode) => {
      const go = () => {
        setSourceTarget(null);
        if (!activeId) {
          setPendingMode(next);
          setMode("home");
          return;
        }
        setPendingMode(null);
        setMode(next);
      };
      if (next === "view") go();
      else guardEditor(go);
    },
    [activeId, guardEditor],
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

  // Both budget controls step from stats.budget, what the server actually
  // granted, rather than from what was asked for: above the ceiling those two
  // differ, and stepping from the request would make the first press after a
  // clamp do nothing visible. Halving is the exact inverse of the doubling
  // Show more has always done, so the sequence up is the sequence back down.
  // Math.floor guards a configured odd default; the limit reaches the server as
  // an integer query parameter.
  const showMore = () => {
    if (!graphData) return;
    pendingBudgetPress.current = "more";
    setGraphBudget(graphData.stats.budget * 2);
  };
  const showLess = () => {
    if (!graphData || defaultBudget === null) return;
    pendingBudgetPress.current = "less";
    setGraphBudget(Math.max(defaultBudget, Math.floor(graphData.stats.budget / 2)));
  };
  // Stable, so the notice's focus effect runs on a new instruction and not on
  // every render of this component.
  const clearBudgetPress = useCallback(() => setBudgetPress(null), []);

  // Where the skip link sends focus: whichever panel currently fills the column
  // beside the graph, tried in the order the modes put them there. A button and
  // a lookup rather than an <a href="#…">, because this application has no
  // routing and a hash in the address bar would be a URL that means nothing;
  // and by id rather than by ref because four different components can be the
  // target and each already names its own heading for aria-labelledby.
  //
  // Every heading in the list carries tabIndex -1, so it can take focus from
  // script without adding a stop to the tab order.
  const skipToPanel = useCallback(() => {
    for (const id of PANEL_HEADING_IDS) {
      const heading = document.getElementById(id);
      if (heading) {
        heading.focus();
        return;
      }
    }
  }, []);

  // --- projects (authoring-foundations) -----------------------------------

  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Leave the open project, asking "Save, discard, or stay?" when it has
  // unsaved changes. `then` runs once the project is closed.
  const exitProject = useCallback(
    (then: () => void) => {
      guardEditor(() => {
        const state = projectStore.getSnapshot();
        if (!state.project) {
          then();
          return;
        }
        if (state.documents.some((d) => d.dirty)) {
          setLeaveProject(() => then);
          return;
        }
        projectStore
          .close()
          .then(() => {
            then();
            void refreshProjects();
          })
          .catch(failed);
      });
    },
    [guardEditor, refreshProjects],
  );

  const openProjectById = useCallback(
    (pid: string) => {
      const go = async () => {
        setProjectBusyId(pid);
        try {
          const oid = await projectStore.open(pid);
          // A project opens on its model: the tree, the canvas and the form
          // (5.4), so a learner starts where the building is done.
          enterMode(oid, "hierarchy");
        } catch (e: unknown) {
          failed(e);
        } finally {
          setProjectBusyId(null);
        }
      };
      const current = projectStore.getSnapshot().project;
      if (current?.id === pid) {
        enterMode(projectStore.getSnapshot().documents[0].ontologyId, "hierarchy");
        return;
      }
      if (current) exitProject(() => void go());
      else void go();
    },
    [enterMode, exitProject],
  );

  // A library ontology opened while a project is open leaves the project.
  const enterLibrary = useCallback(
    (id: string, next: AppMode) => {
      if (projectStore.getSnapshot().project) exitProject(() => enterMode(id, next));
      else enterMode(id, next);
    },
    [enterMode, exitProject],
  );

  const onCreateProject = async (request: NewProjectRequest) => {
    const created = await createProject(request);
    setNewProject(null);
    await refreshProjects();
    openProjectById(created.id);
  };

  const onRenameProject = async (pid: string, name: string) => {
    await updateProject(pid, { name });
    await refreshProjects();
    if (projectStore.getSnapshot().project?.id === pid) await projectStore.reload();
  };

  // The kind changes the tools, never the model (D-089): the manifest only.
  const onChangeKind = async (project: ProjectSummary) => {
    const kind = project.kind === "ontology" ? "taxonomy" : "ontology";
    setProjectBusyId(project.id);
    try {
      await updateProject(project.id, { kind });
      setNotice(`${project.name} is now ${kind === "ontology" ? "an ontology" : "a taxonomy"}. Nothing in the model was changed.`);
      await refreshProjects();
      if (projectStore.getSnapshot().project?.id === project.id) await projectStore.reload();
    } catch (e: unknown) {
      failed(e);
    } finally {
      setProjectBusyId(null);
    }
  };

  const onDuplicateProject = (pid: string) => {
    setProjectBusyId(pid);
    duplicateProject(pid)
      .then((copy) => {
        setNotice(`Made an independent copy: ${copy.name}.`);
        return refreshProjects();
      })
      .catch(failed)
      .finally(() => setProjectBusyId(null));
  };

  const onExportProject = (pid: string) => {
    setProjectBusyId(pid);
    exportProject(pid)
      .then(({ blob, filename }) => triggerDownload(blob, filename))
      .catch(failed)
      .finally(() => setProjectBusyId(null));
  };

  // Delete moves the folder into the trash and says where: nothing is
  // destroyed, and the confirmation says so before and after (5.1).
  const onDeleteProject = (pid: string) => {
    const project = projects.find((p) => p.id === pid);
    const name = project?.name ?? "this project";
    const question =
      `Delete "${name}"? Its folder moves into projects/.trash/ in your ` +
      "Semantic Studio data folder, where you can still recover it.";
    if (!window.confirm(question)) return;
    const run = () => {
      setProjectBusyId(pid);
      deleteProject(pid)
        .then((result) => {
          if (projectStore.getSnapshot().project?.id === pid) projectStore.reset();
          setNotice(`Deleted "${name}". Its folder was moved to ${result.location} in your data folder; nothing was destroyed.`);
          return refreshProjects();
        })
        .catch(failed)
        .finally(() => setProjectBusyId(null));
    };
    if (projectStore.getSnapshot().project?.id === pid) {
      exitProject(() => {
        setActiveId(null);
        run();
      });
    } else run();
  };

  const onSwitchDocument = (doc: ProjectDocName) => {
    guardEditor(() => {
      const target = projectStore.getSnapshot().documents.find((d) => d.doc === doc);
      if (!target) return;
      projectStore.switchDocument(doc);
      setActiveId(target.ontologyId);
    });
  };

  const onCloseProject = () =>
    exitProject(() => {
      setActiveId(null);
      setMode("home");
    });

  const onSaveCopy = () => {
    const state = projectStore.getSnapshot();
    if (!state.project) return;
    downloadDocumentCopy(state.project.id, state.activeDoc)
      .then(({ blob, filename }) => triggerDownload(blob, filename))
      .catch(failed);
  };

  // "Apply, discard, or stay?" (5.3), then whatever the user was leaving for.
  const answerLeaveEditor = async (answer: string) => {
    const then = leaveEditor;
    if (answer === "stay" || !then) {
      setLeaveEditor(null);
      return;
    }
    if (answer === "apply") {
      setPromptBusy(true);
      try {
        await projectStore.applyEditor();
      } catch (e: unknown) {
        // Invalid Turtle: nothing changed and nothing is lost. Stay, and let
        // the editor's own error say where.
        setPromptBusy(false);
        setLeaveEditor(null);
        failed(e);
        return;
      }
      setPromptBusy(false);
    } else {
      projectStore.setEditorDraft(null);
    }
    setLeaveEditor(null);
    then();
  };

  // "Save, discard, or stay?" (5.7), then whatever the user was leaving for.
  const answerLeaveProject = async (answer: string) => {
    const then = leaveProject;
    if (answer === "stay" || !then) {
      setLeaveProject(null);
      return;
    }
    setPromptBusy(true);
    try {
      if (answer === "save" && (await projectStore.saveAll()) === "warning") {
        // The comments question takes over; leaving waits for another try.
        setLeaveProject(null);
        return;
      }
      await projectStore.close(answer === "discard");
      setLeaveProject(null);
      then();
      void refreshProjects();
    } catch (e: unknown) {
      failed(e);
    } finally {
      setPromptBusy(false);
    }
  };

  // Layout: a header (brand + nav rows), a main area (graph + right panel that
  // depends on the mode), a status bar, and the Load dialog when open.
  return (
    <div className="app">
      <header className="app-header">
        <div className="nav-row">
          <Logo />
          <nav className="main-nav" role="tablist" aria-label="Workspace">
            {/* Home is a real fourth view of the workspace, so it is a tab
                rather than a plain button: it swaps the main region exactly as
                the other three do. It is first because it is where the
                application starts and where every route back leads. */}
            <button
              role="tab"
              aria-selected={tabSelected("home")}
              className={showHome ? "nav-item active" : "nav-item"}
              onClick={goHome}
              title="Your library, the catalogue and the file routes"
            >
              <IconHome />
              <span>Home</span>
            </button>
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
            {/* No longer disabled with nothing open. Pressing one is now a
                question the home screen answers — "choose an ontology to
                query" — which teaches that modes act on an ontology, where a
                disabled control taught nothing. The tab still reads as chosen
                while the question is outstanding, because it is. */}
            <button
              role="tab"
              aria-selected={tabSelected("view")}
              className={tabSelected("view") ? "nav-item active" : "nav-item"}
              onClick={() => onPickMode("view")}
              title={activeId ? "Read the ontology file itself" : NO_ONTOLOGY_TITLE}
            >
              <IconView />
              <span>View</span>
            </button>
            <button
              role="tab"
              aria-selected={tabSelected("explore")}
              className={tabSelected("explore") ? "nav-item active" : "nav-item"}
              onClick={() => onPickMode("explore")}
              title={activeId ? "Browse the ontology and inspect entities" : NO_ONTOLOGY_TITLE}
            >
              <IconExplore />
              <span>Explore</span>
            </button>
            <button
              role="tab"
              aria-selected={tabSelected("query")}
              className={tabSelected("query") ? "nav-item active" : "nav-item"}
              onClick={() => onPickMode("query")}
              title={activeId ? "Build a SPARQL query by clicking the graph" : NO_ONTOLOGY_TITLE}
            >
              <IconQuery />
              <span>Query</span>
            </button>
            <button
              role="tab"
              aria-selected={tabSelected("hierarchy")}
              className={tabSelected("hierarchy") ? "nav-item active" : "nav-item"}
              onClick={() => onPickMode("hierarchy")}
              title={
                activeId
                  ? "See the class and concept hierarchy as an indented tree"
                  : NO_ONTOLOGY_TITLE
              }
            >
              <IconHierarchy />
              <span>Hierarchy</span>
            </button>
          </nav>
          {/* Outside the tablist on purpose. View, Explore and Query select
              between views of an ontology; About opens a dialog, and joining
              them would tell a screen reader user there are four views, one of
              which is a dead end. It stays enabled with nothing open — that is
              the moment a newcomer most wants to know what this is. */}
          <button
            ref={aboutRef}
            className="nav-item about-item"
            onClick={() => setAboutOpen(true)}
            aria-haspopup="dialog"
            title="What this is, who made it, and its licence"
          >
            <IconAbout />
            <span>About</span>
          </button>
          {/* Beside About and outside the tablist for the same reason: it
              opens a dialog about the application, not a view of an
              ontology. */}
          <button
            className="nav-item about-item"
            onClick={() => setNetworkOpen(true)}
            aria-haspopup="dialog"
            title="Work offline, and see which sites Semantic Studio may connect to"
          >
            <IconNetwork />
            <span>Network</span>
          </button>
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
          {editingProjectDoc ? (
            <ProjectHeader
              guard={guardEditor}
              onSwitchDocument={onSwitchDocument}
              onClose={onCloseProject}
              onError={(message) => setError(message)}
              onSaveCopy={onSaveCopy}
            />
          ) : active ? (
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
                title="Close this ontology and return to the home screen"
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
                onClick={() => void onRemove(activeId!)}
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
          {/* Absent on Home, where it would search inside an ontology the user
              is not currently looking at and put its results nowhere. The home
              screen has its own search, over the library rather than into one
              ontology, and two search boxes on one screen meaning different
              things is worse than one. Absent in Hierarchy too: the tree has its
              own filter, and two search-like inputs meaning different things is
              the same trap. */}
          {!showHome && mode !== "hierarchy" && (
            <SearchBox
              ontologyId={activeId}
              theme={theme}
              onPick={onSearchPick}
              drawnIds={drawnIds}
              imports={includeImports}
              placeholder={
                mode === "query" ? "Search to add a step…" : "Search concepts, properties…"
              }
            />
          )}
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

          The region is rendered even when empty, for the reason HomeScreen's
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
      {/* defaultBudget is set from the same response as graphData, so waiting
          for it costs no frame; it is in the condition because the floor is not
          knowable before the first graph arrives. */}
      {/* Not on Home: the bar is about the canvas, and pressing Home does not
          throw the canvas away — so without this guard it would sit above the
          library saying how much of an ontology nobody is looking at is drawn.
          Not in Hierarchy either: the tree is unbudgeted, so a "Show more"
          about the graph is meaningless above it. */}
      {!showHome && mode !== "hierarchy" && graphData && defaultBudget !== null && (
        <GraphNotice
          stats={graphData.stats}
          defaultBudget={defaultBudget}
          atMaximum={atMaximum}
          restoreFocus={budgetPress}
          clearedExpansions={clearedExpansions}
          onShowMore={showMore}
          onShowLess={showLess}
          onFocusRestored={clearBudgetPress}
        />
      )}

      {/* The home screen IS the main region, rather than sitting inside one: it
          carries its own <main> and its own heading, so the document never has
          two. Note it is rendered rather than hidden, so pressing Home really
          does unmount the graph — but App keeps activeId, the selection and the
          query builder's state, which is what makes Home a view. D-026. */}
      {/* The imports panel, in the two modes Section 6 puts it in. It renders
          nothing for an ontology with no imports, and asks for its listing only
          when it mounts, so neither mount nor opening an ontology in Explore
          costs a request. Keyed on the ontology so one ontology's panel state
          never shows another's rows. */}
      {!showHome && activeId && (mode === "view" || mode === "hierarchy") && (
        <ImportsPanel
          key={activeId}
          ontologyId={activeId}
          library={ontologies
            .filter((o) => o.id !== activeId)
            .map((o) => ({ id: o.id, name: o.name }))}
          includeImports={includeImports}
          onIncludeImportsChange={setIncludeImports}
          onChanged={onImportsChanged}
        />
      )}

      {showHome ? (
        <HomeScreen
          ontologies={ontologies}
          loading={listLoading}
          error={listError}
          theme={theme}
          workingId={removingId}
          pendingMode={pendingMode}
          onRetry={refreshList}
          onOpen={(id) => enterLibrary(id, modeAfterPick())}
          onEnterMode={enterLibrary}
          onViewSource={(id) => enterLibrary(id, "view")}
          onRemove={(id) => void onRemove(id)}
          onLoaded={onLoaded}
          onOpenDialog={openDialog}
          onStartProject={(id) => setNewProject({ source: id })}
          projects={
            <ProjectsSection
              projects={projects}
              loading={projectsLoading}
              error={projectsError}
              busyId={projectBusyId}
              onNew={() => setNewProject({})}
              onOpen={openProjectById}
              onRename={onRenameProject}
              onChangeKind={(pid) => setChangingKind(projects.find((p) => p.id === pid) ?? null)}
              onDuplicate={onDuplicateProject}
              onExport={onExportProject}
              onDelete={onDeleteProject}
            />
          }
        />
      ) : mode === "hierarchy" ? (
        // Hierarchy replaces the graph rather than overlaying it: it is a tree,
        // not a view of the canvas, so it fills the main area on its own. A row
        // selects through the same handler search and the results table use, so
        // picking an entity the node budget left out draws it when the user
        // switches back to the graph (AC-13). Leaving Hierarchy unmounts it and
        // re-runs the graph layout, the honest cost of a second, separate view.
        //
        // The tree navigates; the panel beside it explains. It is the SAME
        // reused Explore DetailPanel, driven by the same shared selection, the
        // same `selected === null ? empty : DetailPanel` shape Explore uses
        // (D-047) — the fix for v0.2, where the tree could select an entity but
        // nothing in the view said anything about it. A panel link reselects
        // through selectFromOutsideGraph too, so following a connection behaves
        // exactly like clicking a tree row (AC-16), and the tree highlights the
        // new selection wherever it is drawn.
        <main className={showCanvas ? "main with-canvas" : "main"}>
          <HierarchyView
            ontologyId={activeId}
            theme={theme}
            selected={selected}
            onSelect={selectFromOutsideGraph}
            imports={includeImports}
            revision={revision}
            language={displayLanguage}
            editing={editingModel}
            onDeleted={onEntityDeleted}
            canvas={canvasLent}
            canvasSwitch={editingModel ? { on: canvasOn, onToggle: toggleCanvas } : null}
          />
          {showCanvas && openProjectSummary && editingModel && (
            <CanvasBoundary onRetry={() => setModelCanvas(loadCanvas)}>
              <Suspense
                fallback={
                  <section className="model-canvas canvas-message" aria-label="Modeling canvas" aria-busy="true">
                    <p role="status">Loading the canvas…</p>
                  </section>
                }
              >
                <ModelCanvas
                  projectId={openProjectSummary.id}
                  doc="model"
                  revision={revision}
                  language={displayLanguage}
                  primaryLanguage={editingModel.primaryLanguage}
                  selected={selected}
                  onSelect={selectFromOutsideGraph}
                  onSelectLink={selectLink}
                  onDeleted={onEntityDeleted}
                  onCanvasSet={setCanvasSet}
                />
              </Suspense>
            </CanvasBoundary>
          )}
          {selected === null && selectedLink && showCanvas ? (
            <LinkPanel link={selectedLink} onSelect={selectFromOutsideGraph} onClose={() => setSelectedLink(null)} />
          ) : selected === null ? (
            <aside className="detail-panel detail-empty" aria-label="Entity details">
              <p className="detail-note">
                Select a class, property or concept to see its details and
                connections.
              </p>
            </aside>
          ) : (
            <DetailPanel
              ontologyId={activeId}
              iri={selected}
              onNavigate={selectFromOutsideGraph}
              onClose={() => setSelected(null)}
              onExpand={(entity) => void onExpand(entity)}
              expanding={expandingIri === selected}
              imports={includeImports}
              revision={revision}
              language={displayLanguage}
              editing={editingModel}
              readOnlyNote={readOnlyNote}
              onDeleted={onEntityDeleted}
              canvas={canvasLent}
            />
          )}
        </main>
      ) : (
        <main className="main">
          {/* The keyboard route past the graph. It is the first focusable thing
              in the main area and it is visually hidden until it takes focus,
              which is the standard treatment and deliberate: a skip link nobody
              can see is a skip link nobody uses, including sighted keyboard
              users. */}
          <button className="skip-link" onClick={skipToPanel}>
            Skip to the entity list
          </button>
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
          {/* A project document's View is the Turtle editor, the expert's
              door (5.3); a library ontology keeps the read-only source view
              with its Original and Formatted toggle. */}
          {mode === "view" &&
            (editingProjectDoc && openProjectSummary && projectDoc ? (
              <TurtleEditor
                projectId={openProjectSummary.id}
                doc={projectDoc.doc}
                revision={revision}
              />
            ) : (
              <SourceView
                ontologyId={activeId}
                target={sourceTarget}
                onTargetResolved={onSourceTargetResolved}
              />
            ))}
          {mode === "query" ? (
            <QueryPanel
              ontologyId={activeId}
              ontologyName={active?.name}
              theme={theme}
              builder={builder}
              onPickIri={selectFromOutsideGraph}
              onViewInSource={onViewInSource}
              ontologyTriples={active?.triples ?? 0}
              includeImports={includeImports}
              importsCount={importsCount}
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
                imports={includeImports}
                revision={revision}
                language={displayLanguage}
                editing={editingModel}
                readOnlyNote={readOnlyNote}
                onDeleted={onEntityDeleted}
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
            {active.source !== "upload" && active.source !== "project" && (
              <span className="dim src">{active.source}</span>
            )}
          </>
        ) : (
          <span className="dim">Load an ontology to begin — RDF, RDFS, OWL & SKOS supported.</span>
        )}
      </footer>

      {aboutOpen && <AboutPanel onClose={closeAbout} />}

      {networkOpen && <NetworkPanel onClose={() => setNetworkOpen(false)} />}

      {dialogOpen && (
        <LoadDialog
          onLoaded={onLoaded}
          onClose={() => setDialogOpen(false)}
          initialTab={dialogTab}
        />
      )}

      {newProject && (
        <NewProjectDialog
          library={ontologies.map((o) => ({ id: o.id, name: o.name }))}
          initialSource={newProject.source}
          onCreate={onCreateProject}
          onClose={() => setNewProject(null)}
        />
      )}

      {projectRecovery && (
        <ConfirmDialog
          title="Recover unsaved changes?"
          escape="later"
          busy={promptBusy}
          actions={[
            { id: "discard", label: "Discard them", danger: true },
            { id: "recover", label: "Recover", primary: true },
          ]}
          onAnswer={(answer) => {
            if (answer === "later") {
              projectStore.dismissRecovery();
              return;
            }
            setPromptBusy(true);
            projectStore
              .recover(answer as "recover" | "discard")
              .catch(failed)
              .finally(() => setPromptBusy(false));
          }}
        >
          <p>
            This project has changes from {when(projectRecovery.draftTime)} that were
            never saved. Recovering loads them as unsaved changes; the undo history is not
            recovered.
          </p>
        </ConfirmDialog>
      )}

      {commentsWarning && (
        <ConfirmDialog
          title="Save and remove the comments?"
          escape="cancel"
          busy={projectSaving}
          actions={[
            { id: "cancel", label: "Don't save" },
            { id: "save", label: "Save and keep a backup", primary: true },
          ]}
          onAnswer={(answer) => {
            if (answer === "save") projectStore.save(true).catch(failed);
            else projectStore.cancelCommentsWarning();
          }}
        >
          <p>
            {COMMENTS_WARNING} The current file will be kept as{" "}
            <code>{commentsWarning.backup}</code>.
          </p>
        </ConfirmDialog>
      )}

      {changingKind && (
        <ConfirmDialog
          title={`Change ${changingKind.name} to ${changingKind.kind === "ontology" ? "a taxonomy" : "an ontology"}?`}
          escape="cancel"
          actions={[
            { id: "cancel", label: "Cancel" },
            { id: "change", label: "Change", primary: true },
          ]}
          onAnswer={(answer) => {
            const project = changingKind;
            setChangingKind(null);
            if (answer === "change") void onChangeKind(project);
          }}
        >
          <p>
            {changingKind.kind === "ontology"
              ? "The canvas and the tree will offer concepts instead of classes. Nothing in the model is rewritten: its classes stay, shown read-only and editable in Turtle."
              : "The canvas and the tree will offer classes instead of concepts. Nothing in the model is rewritten: its concepts stay, shown read-only and editable in Turtle."}
          </p>
        </ConfirmDialog>
      )}

      {leaveEditor && (
        <ConfirmDialog
          title="Apply your Turtle edits?"
          escape="stay"
          busy={promptBusy}
          actions={[
            { id: "stay", label: "Stay" },
            { id: "discard", label: "Discard", danger: true },
            { id: "apply", label: "Apply", primary: true },
          ]}
          onAnswer={(answer) => void answerLeaveEditor(answer)}
        >
          <p>The text in the editor has changes that are not applied yet. Apply, discard, or stay?</p>
        </ConfirmDialog>
      )}

      {leaveProject && (
        <ConfirmDialog
          title="Save your changes?"
          escape="stay"
          busy={promptBusy}
          actions={[
            { id: "stay", label: "Stay" },
            { id: "discard", label: "Discard", danger: true },
            { id: "save", label: "Save", primary: true },
          ]}
          onAnswer={(answer) => void answerLeaveProject(answer)}
        >
          <p>
            {openProjectSummary?.name ?? "This project"} has unsaved changes. Save, discard, or
            stay?
          </p>
        </ConfirmDialog>
      )}

      {/* Last, so it stacks over the Load dialog that usually caused it. */}
      {approval && (
        <NetworkApprovalDialog
          requests={approval.requests}
          onAnswer={(allow, remember) => void answerApproval(allow, remember)}
        />
      )}
    </div>
  );
}
