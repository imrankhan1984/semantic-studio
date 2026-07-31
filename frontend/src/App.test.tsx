// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/App.test.tsx
================================================================================

SUMMARY
    Tests for App: the startup chooser (what is and is not requested on mount,
    what replaces it, and the two ways back to it), the status bar's node and
    edge counts under a node budget, the removal sequence that counts saved
    queries before asking and reports what it took afterwards, which panel
    fills the Explore column, and where a query result leads — into the graph,
    drawing the entity first if the node budget left it out, or into the raw
    source text.

BASIC IDEA
    App is mocked down to the parts these assert on. GraphView is replaced with
    a stub because it drives Sigma over WebGL, which jsdom has no canvas for,
    and api.ts is replaced so the component is driven by fixed responses rather
    than a server.

    Mocking api.ts is also what makes the startup budget testable: with every
    client function a spy, "exactly one request on mount" is a claim about call
    counts rather than about network traffic nobody can observe from here. That
    is the negative budget this feature exists to hold — the whole point is
    that nothing is fetched, so the assertions are mostly that spies were NOT
    called.

    The status bar is the reason the second half of this file exists: it is the
    one place that keeps stating the ontology's real size after the user
    dismisses the notice, so a regression there would hide the truncation
    completely rather than merely making it less visible.

    The removal tests turn an ordering claim into an assertion. "The count
    happens before the dialog" is not observable from the rendered output, so
    window.confirm is stubbed with a spy that records what listSavedQueries had
    done by the time it was called. Anything weaker would pass against a
    version that opened the dialog first and counted afterwards, which is
    exactly the defect being fixed.

INPUTS / INPUT SOURCES
    - A mocked api.ts returning one ontology summary and one budgeted graph.
    - A stubbed GraphView.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-5, AC-9 and AC-13 of
      startup-chooser-screen, AC-23 of partial-graph-rendering, AC-11 to
      AC-16 of saved-query-deletion-warning, AC-1, AC-15 and AC-16 of
      explore-mode-starting-point, and AC-1 to AC-8 and AC-12 of
      result-navigation.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError } from "./api";
import type { MergeResult, OntologySummary, VizGraph, VizNeighborhood } from "./types";

const {
  listOntologies,
  getGraph,
  deleteOntology,
  searchNodes,
  fetchOntology,
  uploadOntology,
  listSavedQueries,
  getNeighborhood,
  getNodeDetails,
  getQuerySchema,
  getQueryNode,
  getSource,
  saveQuery,
  runSparql,
  deleteSavedQuery,
} = vi.hoisted(() => ({
  listOntologies: vi.fn(),
  getGraph: vi.fn(),
  deleteOntology: vi.fn(),
  searchNodes: vi.fn(),
  fetchOntology: vi.fn(),
  uploadOntology: vi.fn(),
  listSavedQueries: vi.fn(),
  getNeighborhood: vi.fn(),
  // The four below arrived with the Explore starting panel and the mode
  // regression test: the detail panel, the query builder and the source view all
  // fetch, and none of them could be rendered from here until they were mocked.
  getNodeDetails: vi.fn(),
  getQuerySchema: vi.fn(),
  getQueryNode: vi.fn(),
  getSource: vi.fn(),
  saveQuery: vi.fn(),
  runSparql: vi.fn(),
  deleteSavedQuery: vi.fn(),
}));

// importOriginal rather than a bare factory, so ApiError stays the real class.
// App tells a 404 from /neighborhood apart from a failure with `instanceof`, and
// a second copy of that class declared here would satisfy the type checker while
// never matching what App throws against.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listOntologies,
  getGraph,
  deleteOntology,
  searchNodes,
  fetchOntology,
  uploadOntology,
  listSavedQueries,
  getNeighborhood,
  getNodeDetails,
  getQuerySchema,
  getQueryNode,
  getSource,
  saveQuery,
  runSparql,
  deleteSavedQuery,
}));

/** Every mocked client function, so a test can count what mount actually did. */
const ALL_API = {
  listOntologies,
  getGraph,
  deleteOntology,
  searchNodes,
  fetchOntology,
  uploadOntology,
  listSavedQueries,
  getNeighborhood,
  getNodeDetails,
  getQuerySchema,
  getQueryNode,
  getSource,
  saveQuery,
  runSparql,
  deleteSavedQuery,
};

// Sigma needs a WebGL context; jsdom has none. Nothing here asserts on the
// canvas, so a stub keeps the test about the status bar.
//
// The stub carries one button standing in for a node, because clicking a node is
// a selection route with its own rules — it must not move focus the way a
// suggestion does — and there is no other way to reach onSelect from here.
//
// The second button stands in for a merge. The real one happens inside
// graphology and is asserted in GraphView.test.tsx; what App is responsible for
// is what it does with the result, so the stub reports every node in the
// expansion as newly added — the case where none of them were already drawn.
vi.mock("./components/GraphView", () => ({
  default: ({
    leftRail,
    onSelect,
    expansion,
    onExpanded,
    focusTick,
  }: {
    leftRail?: React.ReactNode;
    onSelect: (iri: string | null) => void;
    expansion?: { data: VizNeighborhood; token: number } | null;
    onExpanded?: (result: MergeResult) => void;
    focusTick: number;
  }) => (
    // focusTick is surfaced because "the camera re-centres" is not otherwise
    // observable from here: the real GraphView watches this prop and moves. Its
    // guard against a target that is not on the canvas is GraphView.test.tsx's.
    <div data-testid="graph" data-focus-tick={focusTick}>
      {leftRail}
      <button onClick={() => onSelect("http://x/issuedBy")}>fake node</button>
      {expansion && (
        <button
          onClick={() =>
            onExpanded?.({
              addedNodes: expansion.data.nodes.map((n) => n.id),
              addedEdges: expansion.data.edges.length,
            })
          }
        >
          fake merge
        </button>
      )}
    </div>
  ),
}));

/** Which entity the stubbed result row and search hit point at. Mutable so a
 *  test can aim them at a drawn entity, an undrawn one, or a predicate. */
const { pick } = vi.hoisted(() => ({
  pick: { iri: "http://x/Bond", prefixed: "x:Bond" as string | undefined },
}));

// QueryPanel is stubbed for the same reason GraphView is: reaching a result row
// through the real one means a schema, a built path and an executed query, none
// of which this file is about. What App owns is which handler each control
// gets, so the stub is two buttons over those two props.
//
// It keeps the .query-panel class, because an existing test uses that class to
// prove the Explore starting panel is Explore-only.
//
// That QueryPanel actually passes both callbacks down to ResultsTable is not
// covered from here — it is asserted in QueryPanel.test.tsx, against the real
// component and the real table.
vi.mock("./components/QueryPanel", () => ({
  default: ({
    onPickIri,
    onViewInSource,
  }: {
    onPickIri: (iri: string) => void;
    onViewInSource: (iri: string, prefixed?: string) => void;
  }) => (
    <div className="query-panel">
      <button onClick={() => onPickIri(pick.iri)}>fake result chip</button>
      <button onClick={() => onViewInSource(pick.iri, pick.prefixed)}>fake source control</button>
    </div>
  ),
}));

// SearchBox is stubbed only in service of one assertion: that a search pick and
// a result pick take the same route. Driving the real box means typing, a
// debounce and a mocked response, all of which is SearchBox.test.tsx's job.
vi.mock("./components/SearchBox", () => ({
  default: ({ onPick }: { onPick: (iri: string) => void }) => (
    <button onClick={() => onPick(pick.iri)}>fake search hit</button>
  ),
}));

const SUMMARY: OntologySummary = {
  id: "o1",
  name: "FIBO",
  source: "upload",
  format: "turtle",
  triples: 132001,
  nodes: 18717,
  edges: 51446,
  kindCounts: { class: 18717 },
  namespaces: {},
};

/** A budgeted response at FIBO's real size: 2,000 drawn of 18,717. */
const TRUNCATED: VizGraph = {
  nodes: [],
  edges: [],
  stats: {
    nodeCount: 2000,
    edgeCount: 5180,
    nodeTotal: 18717,
    edgeTotal: 51446,
    truncated: true,
    budget: 2000,
    kindCounts: { class: 18717 },
  },
};

beforeEach(() => {
  for (const fn of Object.values(ALL_API)) fn.mockReset();
  pick.iri = "http://x/Bond";
  pick.prefixed = "x:Bond";
  // jsdom implements no scrolling and does not define this at all, so the
  // source pane's deferred scroll throws into a timer nothing is awaiting.
  // Stubbed rather than guarded in the component: the guard would be dead code
  // in every browser, and the throw is jsdom's gap, not the pane's.
  Element.prototype.scrollIntoView = vi.fn();
  listOntologies.mockResolvedValue([SUMMARY]);
  getGraph.mockResolvedValue(TRUNCATED);
  searchNodes.mockResolvedValue([]);
  listSavedQueries.mockResolvedValue([]);
  deleteOntology.mockResolvedValue({ deleted: "o1", deletedQueries: 0 });
  getNodeDetails.mockResolvedValue({
    iri: "http://x/Bond",
    prefixed: "x:Bond",
    label: "Bond",
    outgoing: [],
    incoming: [],
    outgoingTotal: 0,
    incomingTotal: 0,
  });
  // A search hit in Query mode adds a step, which asks the server what the
  // clicked node's type is. Every entity here answers "it is a class".
  getQueryNode.mockImplementation((_id: string, iri: string) =>
    Promise.resolve({ iri, isClass: true, label: iri, types: [] }),
  );
  getQuerySchema.mockResolvedValue({
    classes: [],
    links: [],
    superClasses: {},
    dataProperties: {},
    namespaces: {},
    truncated: false,
  });
  getSource.mockResolvedValue({
    text: "",
    format: "turtle",
    pretty: false,
    truncated: false,
    bytes: 0,
    lines: 0,
    name: "FIBO",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/** Render App and let the mount-time list request settle. Stops at the chooser. */
async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

/**
 * A saved-library row by ontology name. Anchored on the comma because a
 * library row's accessible name is "FIBO, 132,001 triples, …" while the
 * catalogue below it offers "FIBO — Financial Industry Business Ontology";
 * a bare /FIBO/ matches both.
 */
function libraryRow(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name},`) });
}

/** Render App and open the first saved ontology, as a user would. */
async function renderAppOpened() {
  await renderApp();
  await act(async () => {
    fireEvent.click(libraryRow("FIBO"));
  });
}

function statusBar(): string {
  return document.querySelector(".status-bar")!.textContent ?? "";
}

function chooserShown(): boolean {
  return document.querySelector(".start-screen") !== null;
}

describe("App startup chooser", () => {
  it("does not request a graph on mount", async () => {
    // AC-1 and the negative half of AC-13. This is the whole feature: with
    // FIBO stored, mounting used to fetch 18,717 nodes nobody asked for.
    await renderApp();
    expect(getGraph).not.toHaveBeenCalled();
  });

  it("requests only the ontology list on mount", async () => {
    // AC-13. Exactly one request, and it is the list.
    await renderApp();

    expect(listOntologies).toHaveBeenCalledTimes(1);
    const others = Object.entries(ALL_API).filter(([name]) => name !== "listOntologies");
    for (const [name, fn] of others) {
      expect(fn, `${name} was called on mount`).not.toHaveBeenCalled();
    }
  });

  it("shows the chooser when no ontology is active", async () => {
    // AC-2. The chooser stands in for the graph and the mode panel, and it
    // lists the saved library it was handed.
    await renderApp();

    expect(chooserShown()).toBe(true);
    expect(screen.queryByTestId("graph")).toBeNull();
    expect(libraryRow("FIBO")).toBeTruthy();
    // The context row admits there is nothing open rather than showing an
    // ontology dropdown with no selection in it.
    expect(screen.getByText("NO ONTOLOGY OPEN")).toBeTruthy();
  });

  it("mode tabs are disabled while the chooser is shown", async () => {
    // AC-9. Disabled AND titled: a control that does nothing without saying
    // why is worse than one that is absent.
    await renderApp();

    for (const name of ["View", "Explore", "Query"]) {
      const tab = screen.getByRole("tab", { name }) as HTMLButtonElement;
      expect(tab.disabled, `${name} tab`).toBe(true);
      expect(tab.getAttribute("title")).toBe("Open an ontology first");
    }
    // Load is the way out of an empty library, so it stays available.
    expect((screen.getByRole("button", { name: "Load" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("opening a library entry hides the chooser and loads it", async () => {
    // AC-3. The graph request happens here, on the pick, and nowhere earlier.
    await renderAppOpened();

    expect(getGraph).toHaveBeenCalledTimes(1);
    expect(getGraph).toHaveBeenCalledWith("o1", undefined);
    expect(chooserShown()).toBe(false);
    expect(screen.getByTestId("graph")).toBeTruthy();
    expect(statusBar()).toContain("FIBO");
  });

  it("closing an ontology returns to the chooser without deleting", async () => {
    // AC-4. Nothing is removed: the entry is still in the library behind it.
    await renderAppOpened();
    expect(chooserShown()).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /close this ontology/i }));
    });

    expect(chooserShown()).toBe(true);
    expect(deleteOntology).not.toHaveBeenCalled();
    expect(libraryRow("FIBO")).toBeTruthy();
    // And the list is not refetched to get it back: closing is browser state.
    expect(listOntologies).toHaveBeenCalledTimes(1);
  });

  it("close and delete are distinguishable by name, not only by color", async () => {
    // AC-4. They sit side by side and do very different things. Colour is the
    // only visual difference, so the accessible names have to carry it.
    await renderAppOpened();

    const close = screen.getByRole("button", { name: /close this ontology/i });
    const remove = screen.getByRole("button", { name: /remove ontology/i });

    expect(close).not.toBe(remove);
    expect(close.getAttribute("aria-label")).toBe("Close this ontology");
    expect(remove.getAttribute("aria-label")).toBe("Remove ontology");
    // Only one of the two is the destructive one.
    expect(close.classList.contains("danger")).toBe(false);
    expect(remove.classList.contains("danger")).toBe(true);
  });

  it("removing the active ontology returns to the chooser", async () => {
    // AC-5. It used to fall back to the last remaining entry, which is the
    // same unasked-for render this feature exists to stop.
    listOntologies.mockResolvedValue([SUMMARY, { ...SUMMARY, id: "o2", name: "FOAF" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderApp();
    await act(async () => {
      fireEvent.click(libraryRow("FIBO"));
    });
    getGraph.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /remove ontology/i }));
    });

    expect(deleteOntology).toHaveBeenCalledWith("o1");
    expect(chooserShown()).toBe(true);
    // FOAF is still saved and is NOT opened in FIBO's place.
    expect(getGraph).not.toHaveBeenCalled();
    expect(libraryRow("FOAF")).toBeTruthy();
    confirm.mockRestore();
  });
});

describe("App status bar", () => {
  it("status bar reads n of total when truncated", async () => {
    // AC-23 of partial-graph-rendering: drawn and total, for BOTH nodes and
    // edges.
    await renderAppOpened();
    expect(statusBar()).toContain("2,000 of 18,717 nodes");
    expect(statusBar()).toContain("5,180 of 51,446 edges");
  });

  it("keeps saying n of total after the notice is dismissed", async () => {
    // AC-23's second half. Dismissing the notice hides the notice, not the
    // fact: this is what stops the truncation from becoming invisible.
    await renderAppOpened();
    // Selected by class rather than by role: the removal message is a second
    // polite live region, so `role="status"` no longer identifies this one.
    expect(document.querySelector(".graph-notice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(document.querySelector(".graph-notice")).toBeNull();
    expect(statusBar()).toContain("2,000 of 18,717 nodes");
    expect(statusBar()).toContain("5,180 of 51,446 edges");
  });

  it("reads a plain count when nothing was truncated", async () => {
    // AC-3 of partial-graph-rendering at the App level: a small ontology reads
    // "34 nodes", as before.
    getGraph.mockResolvedValue({
      nodes: [],
      edges: [],
      stats: {
        nodeCount: 34,
        edgeCount: 41,
        nodeTotal: 34,
        edgeTotal: 41,
        truncated: false,
        budget: 2000,
        kindCounts: { class: 34 },
      },
    } satisfies VizGraph);
    await renderAppOpened();

    expect(statusBar()).toContain("34 nodes");
    expect(statusBar()).not.toContain("of");
    expect(document.querySelector(".graph-notice")).toBeNull();
  });

  it("show more asks for double the budget the server applied", async () => {
    // AC-21 of partial-graph-rendering end to end: the doubling is computed
    // from stats.budget, so a clamped response doubles from what was granted,
    // not what was asked for.
    await renderAppOpened();
    expect(getGraph).toHaveBeenLastCalledWith("o1", undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    });

    expect(getGraph).toHaveBeenLastCalledWith("o1", 4000);
  });
});

describe("App graph budget range", () => {
  /**
   * Make getGraph answer the way the server does, so a budget can be walked up
   * and back down across several presses. The fixed TRUNCATED response cannot
   * do this: App computes each step from stats.budget, so a mock that always
   * reports 2,000 makes every press ask for 4,000 and every assertion after the
   * first one meaningless.
   *
   * Mirrors ontologies.py: the granted budget is the requested one clamped at
   * MAX_GRAPH_NODE_BUDGET, the drawn count never exceeds the ontology's total,
   * and truncated is whether anything was left out.
   */
  function serverLike({ nodeTotal = 18717, serverDefault = 2000 } = {}) {
    getGraph.mockImplementation((_id: string, limit?: number) => {
      const budget = Math.min(limit ?? serverDefault, 20000);
      const nodeCount = Math.min(budget, nodeTotal);
      return Promise.resolve({
        nodes: [],
        edges: [],
        stats: {
          nodeCount,
          edgeCount: 0,
          nodeTotal,
          edgeTotal: 0,
          truncated: nodeCount < nodeTotal,
          budget,
          kindCounts: { class: nodeTotal },
        },
      } satisfies VizGraph);
    });
  }

  const showLess = () =>
    screen.getByRole("button", { name: /show less/i }) as HTMLButtonElement;
  const showMore = () =>
    screen.getByRole("button", { name: /show more/i }) as HTMLButtonElement;

  async function press(button: () => HTMLButtonElement) {
    await act(async () => {
      fireEvent.click(button());
    });
  }

  it("show less halves the budget", async () => {
    // AC-6. Halving is the exact inverse of the doubling Show more has always
    // done, so the sequence up is the sequence back down.
    serverLike();
    await renderAppOpened();
    await press(showMore);
    await press(showMore);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 8000);

    await press(showLess);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 4000);
  });

  it("show less clamps to the floor rather than going below", async () => {
    // AC-6, and the only route that reaches the clamp with real numbers: the
    // server's ceiling. With a configured default of 15,000, Show more asks for
    // 30,000 and is granted 20,000, so halving lands on 10,000 — below the
    // floor. It must come back to 15,000, not refuse and not go under.
    serverLike({ nodeTotal: 40000, serverDefault: 15000 });
    await renderAppOpened();
    await press(showMore);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 30000);

    await press(showLess);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 15000);
  });

  it("show more and show less are inverses", async () => {
    // AC-6 and the third performance budget: the values reachable walking up
    // are exactly the values walking back down, ending on the starting one.
    // Mutation tested — replacing the halving with a fixed subtraction of the
    // default turns the descent into 14,000 / 12,000 / 10,000 and fails here.
    serverLike();
    await renderAppOpened();
    for (let i = 0; i < 3; i++) await press(showMore);
    for (let i = 0; i < 3; i++) await press(showLess);

    expect(getGraph.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      undefined, 4000, 8000, 16000, 8000, 4000, 2000,
    ]);
  });

  it("show less refetches once", async () => {
    // AC-7 and the first performance budget: one request per press, to /graph.
    serverLike();
    await renderAppOpened();
    await press(showMore);
    getGraph.mockClear();

    await press(showLess);
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("disabled controls make no request", async () => {
    // AC-7 and the second performance budget. At the floor Show less is
    // disabled, and a disabled button fires no click handler — so this asserts
    // the disabling is real rather than a class that only looks disabled.
    serverLike();
    await renderAppOpened();
    expect(showLess().disabled).toBe(true);
    getGraph.mockClear();

    await press(showLess);
    expect(getGraph).not.toHaveBeenCalled();
  });

  it("the floor follows the server default, not a hard-coded 2000", async () => {
    // AC-8. With SEMANTIC_STUDIO_GRAPH_NODE_BUDGET set to 500 the floor is 500,
    // and App learns that from the first response rather than declaring it.
    // A hard-coded 2,000 fails loudly here rather than quietly: halving 1,000
    // against a floor of 2,000 asks for 2,000, which is more than is drawn.
    serverLike({ serverDefault: 500 });
    await renderAppOpened();
    await press(showMore);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 1000);

    await press(showLess);
    expect(getGraph).toHaveBeenLastCalledWith("o1", 500);
    expect(showLess().disabled).toBe(true);
  });

  it("focus moves to show more when show less becomes disabled", async () => {
    // AC-9. The press that reaches the floor disables the control that made it,
    // and a browser drops focus from a disabled element to <body> rather than
    // anywhere useful — the defect measured in Chrome on 2026-07-30 against the
    // remove control. Here it is worse than a blur: App blanks graphData while
    // the new graph is in flight, so the whole bar unmounts and remounts, and
    // nothing inside it could remember what had been pressed.
    serverLike();
    await renderAppOpened();
    await press(showMore);
    await press(showLess);

    expect(showLess().disabled).toBe(true);
    expect(document.activeElement).toBe(showMore());
  });

  it("a budget change is announced politely", async () => {
    // AC-9, the second half. The bar is already a polite live region, so the
    // new counts are announced without moving focus; this asserts the counts
    // that reach it are the new ones and the region survived the refetch.
    serverLike();
    await renderAppOpened();
    await press(showMore);

    const notice = document.querySelector(".graph-notice")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.textContent).toContain("4,000");
    expect(notice.textContent).toContain("18,717");
  });
});

describe("App expand on demand", () => {
  /** One entity and two neighbours, none of them in TRUNCATED's empty node list. */
  const NEIGHBORHOOD: VizNeighborhood = {
    nodes: [
      { id: "http://x/issuedBy", label: "is issued by", kind: "objectProperty", degree: 9 },
      { id: "http://x/Bond", label: "Bond", kind: "class", degree: 12 },
      { id: "http://x/Issuer", label: "Issuer", kind: "class", degree: 4 },
    ],
    edges: [
      { source: "http://x/issuedBy", target: "http://x/Bond", kind: "domain", label: "" },
      { source: "http://x/issuedBy", target: "http://x/Issuer", kind: "range", label: "" },
    ],
    stats: {
      nodeCount: 3,
      edgeCount: 2,
      nodeTotal: 18717,
      edgeTotal: 51446,
      truncated: false,
      budget: 200,
      kindCounts: { class: 18717 },
      neighborTotal: 2,
      center: "http://x/issuedBy",
    },
  };

  function liveRegion(): string {
    return document.querySelector(".notice-region")!.textContent ?? "";
  }

  /** Open FIBO, select a node, ask for its connections, and let the merge land. */
  async function expandTheSelectedNode(response: VizNeighborhood = NEIGHBORHOOD) {
    getNeighborhood.mockResolvedValue(response);
    await renderAppOpened();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake node" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /show its connections/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake merge" }));
    });
  }

  it("the detail panel asks for the selected entity's neighbourhood", async () => {
    // AC-15 from the client's side. The IRI it sends is the selected one, not
    // whatever the panel happens to have loaded: the two can differ while the
    // detail request is still in flight.
    await expandTheSelectedNode();
    expect(getNeighborhood).toHaveBeenCalledWith("o1", "http://x/issuedBy");
  });

  it("expanding announces the new drawn count", async () => {
    // AC-26. The announcement is App's, not the graph's, because the number it
    // states — how much of the ontology is now drawn — is the budgeted count
    // plus every merge, and only App holds both halves.
    await expandTheSelectedNode();
    expect(liveRegion()).toContain("Added 3 entities");
    expect(liveRegion()).toContain("2,003 of 18,717 drawn");
  });

  it("the announcement is a polite live region", async () => {
    // The same region the removal report uses. Polite and a status rather than
    // an alert: the merge has already happened and nothing needs a decision.
    await expandTheSelectedNode();
    const region = document.querySelector(".notice-region")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("the status bar counts what the merge added", async () => {
    // AC-23 under stage 2: the drawn figure grows, the total does not. Without
    // this the status bar would keep reporting the budgeted count and the user
    // would have no way to see the graph growing.
    await expandTheSelectedNode();
    expect(statusBar()).toContain("2,003 of 18,717 nodes");
    expect(statusBar()).toContain("5,182 of 51,446 edges");
  });

  it("says so plainly when a truncated neighbourhood was returned", async () => {
    // The house rule: when the server truncates something the interface says
    // it did. A partial expansion that reported only what it added would let a
    // user believe they had drawn everything this entity connects to.
    await expandTheSelectedNode({
      ...NEIGHBORHOOD,
      stats: { ...NEIGHBORHOOD.stats, truncated: true, neighborTotal: 640, budget: 200 },
    });
    expect(liveRegion()).toContain("Showing the 200 most connected of 640 connections");
  });

  it("says nothing was added rather than reporting zero", async () => {
    // "Added 0 entities" reads as a failure. What happened is that everything
    // this entity connects to was already drawn, which is worth saying in words.
    await expandTheSelectedNode({ ...NEIGHBORHOOD, nodes: [], edges: [] });
    expect(liveRegion()).toContain("Nothing new to draw");
    expect(liveRegion()).not.toContain("Added 0");
    expect(statusBar()).toContain("2,000 of 18,717 nodes");
  });

  it("a new graph response discards what expansions added", async () => {
    // Merging is additive and never removes, so the documented way back to the
    // budgeted view is to reload — which Show more does. If the added count
    // survived that, the status bar would over-report for the rest of the
    // session and no reload would fix it.
    await expandTheSelectedNode();
    expect(statusBar()).toContain("2,003 of 18,717 nodes");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    });

    expect(statusBar()).toContain("2,000 of 18,717 nodes");
    expect(screen.queryByRole("button", { name: "fake merge" })).toBeNull();
  });
});

describe("App explore column", () => {
  /** A graph with entities in it, so the starting panel has something to offer. */
  const DRAWN: VizGraph = {
    nodes: [
      { id: "http://x/Bond", label: "Bond", kind: "class", degree: 12 },
      { id: "http://x/issuedBy", label: "is issued by", kind: "objectProperty", degree: 7 },
    ],
    edges: [],
    stats: {
      nodeCount: 2,
      edgeCount: 0,
      nodeTotal: 2,
      edgeTotal: 0,
      truncated: false,
      budget: 2000,
      kindCounts: { class: 1, objectProperty: 1 },
    },
  };

  function startPanel(): HTMLElement | null {
    return document.querySelector(".explore-start");
  }

  it("explore mode shows the start panel when nothing is selected", async () => {
    // AC-1 at the App level. Explore is the default mode, so this is what
    // everyone sees on opening an ontology — where the column used to render
    // nothing at all, DetailPanel returning null before its first line of markup.
    getGraph.mockResolvedValue(DRAWN);
    await renderAppOpened();

    expect(screen.getByRole("tab", { name: "Explore" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(startPanel()).toBeTruthy();
    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(startPanel()!.textContent).toContain("This ontology describes");
    // And it did not cost a request: the ranking comes out of the graph response
    // App already holds.
    expect(getGraph).toHaveBeenCalledTimes(1);
    expect(getNodeDetails).not.toHaveBeenCalled();
  });

  it("closing the detail panel returns to the start panel", async () => {
    // AC-15 and AC-10 end to end. Closing used to leave the user back where they
    // started, with nothing; the close button now returns them to an offer.
    getGraph.mockResolvedValue(DRAWN);
    await renderAppOpened();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Bond.*Class/ }));
    });
    expect(document.querySelector(".detail-panel")).toBeTruthy();
    expect(startPanel()).toBeNull();
    expect(getNodeDetails).toHaveBeenCalledWith("o1", "http://x/Bond");

    // By title rather than by accessible name: that control's name is the glyph
    // it contains, "✕", because name-from-contents wins over a title attribute.
    // Pre-existing and out of scope here, but it is why this query is not
    // getByRole.
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('[title="Close panel"]')!);
    });

    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(startPanel()).toBeTruthy();
  });

  it("a graph click after a suggestion does not move focus", async () => {
    // Not in the spec's test plan; the first implementation of AC-12 failed it.
    // A counter that only ever incremented left the panel wanting focus forever,
    // so a node clicked with the mouse — after a suggestion had been used once —
    // pulled focus into the panel heading. The flag has to travel with the
    // selection, and this is the assertion that says so from App, where the
    // routes are.
    getGraph.mockResolvedValue(DRAWN);
    await renderAppOpened();

    // Use a suggestion, which does take focus, then close.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Bond.*Class/ }));
    });
    expect(document.activeElement).toBe(document.querySelector("#detail-panel-heading"));
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('[title="Close panel"]')!);
    });

    // Now select the same way a user clicking the canvas does.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake node" }));
    });

    expect(document.querySelector(".detail-panel")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.querySelector("#detail-panel-heading"));
  });

  it("query and view modes are unaffected", async () => {
    // AC-16. This panel is Explore-only. Asserted from App because the mode
    // conditional is here, and a misplaced branch would show it in all three.
    getGraph.mockResolvedValue(DRAWN);
    await renderAppOpened();
    expect(startPanel()).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Query" }));
    });
    expect(startPanel()).toBeNull();
    expect(document.querySelector(".query-panel")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "View" }));
    });
    expect(startPanel()).toBeNull();
    expect(document.querySelector(".source-view")).toBeTruthy();

    // Back to Explore, and the offer is there again.
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    });
    expect(startPanel()).toBeTruthy();
  });
});

describe("App result navigation", () => {
  /** A graph carrying one entity, so a result can name a drawn one or not. */
  const DRAWN: VizGraph = {
    nodes: [{ id: "http://x/Bond", label: "Bond", kind: "class", degree: 12 }],
    edges: [],
    stats: {
      nodeCount: 1,
      edgeCount: 0,
      nodeTotal: 18717,
      edgeTotal: 51446,
      truncated: true,
      budget: 2000,
      kindCounts: { class: 18717 },
    },
  };

  /** What the expansion of an undrawn result returns. */
  const NEIGHBORHOOD: VizNeighborhood = {
    nodes: [
      { id: "http://x/Issuer", label: "Issuer", kind: "class", degree: 4 },
      { id: "http://x/Jurisdiction", label: "Jurisdiction", kind: "class", degree: 3 },
    ],
    edges: [{ source: "http://x/Issuer", target: "http://x/Jurisdiction", kind: "domain", label: "" }],
    stats: {
      nodeCount: 2,
      edgeCount: 1,
      nodeTotal: 18717,
      edgeTotal: 51446,
      truncated: false,
      budget: 200,
      kindCounts: { class: 18717 },
      neighborTotal: 1,
      center: "http://x/Issuer",
    },
  };

  function liveRegion(): string {
    return document.querySelector(".notice-region")!.textContent ?? "";
  }

  function focusTick(): string {
    return screen.getByTestId("graph").getAttribute("data-focus-tick") ?? "";
  }

  /** Open FIBO and switch to Query mode, where a results table would be. */
  async function renderInQueryMode() {
    getGraph.mockResolvedValue(DRAWN);
    await renderAppOpened();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Query" }));
    });
  }

  async function clickResultChip() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake result chip" }));
    });
  }

  it("clicking a drawn result selects and centres it", async () => {
    // AC-1. Unchanged behaviour, asserted because everything else in this block
    // is about not changing it: the primary click keeps the meaning it has, and
    // the camera is told to move.
    await renderInQueryMode();
    const before = focusTick();

    await clickResultChip();

    expect(focusTick()).not.toBe(before);
    // And the selection is real: switching to Explore describes that entity.
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    });
    expect(getNodeDetails).toHaveBeenCalledWith("o1", "http://x/Bond");
  });

  it("clicking a drawn result makes no request", async () => {
    // Section 10, row 1. A count, not a timing. The entity is already on the
    // canvas, so growing the graph would be a request that buys nothing.
    await renderInQueryMode();
    getNeighborhood.mockClear();

    await clickResultChip();

    expect(getNeighborhood).not.toHaveBeenCalled();
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("clicking an undrawn result expands once", async () => {
    // AC-2 and section 10 row 2, the mutation-tested one. This is the whole of
    // gap 1: the node budget is 2,000 and a query can return any entity in the
    // ontology, so a result row routinely names something the canvas cannot
    // show. Before this it selected the entity and moved the camera nowhere.
    pick.iri = "http://x/Issuer";
    getNeighborhood.mockResolvedValue(NEIGHBORHOOD);
    await renderInQueryMode();

    await clickResultChip();

    expect(getNeighborhood).toHaveBeenCalledTimes(1);
    expect(getNeighborhood).toHaveBeenCalledWith("o1", "http://x/Issuer");
  });

  it("clicking an undrawn result announces what was added", async () => {
    // AC-3. The same sentence stage 2 already produces for a search pick and
    // for Show its connections — reused rather than reworded, because three
    // wordings for one event is how they drift.
    pick.iri = "http://x/Issuer";
    getNeighborhood.mockResolvedValue(NEIGHBORHOOD);
    await renderInQueryMode();
    await clickResultChip();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake merge" }));
    });

    expect(liveRegion()).toContain("Added 2 entities");
    expect(liveRegion()).toContain("3 of 18,717 drawn");
    expect(statusBar()).toContain("3 of 18,717 nodes");
  });

  it("a failed expansion leaves the selection intact", async () => {
    // AC-4. The failure is the graph's, not the entity's: the detail panel
    // reads the ontology, not the canvas, so it can still describe what was
    // selected. Asserted through the Explore column because that is where a
    // detail panel is, and the selection survives the mode change.
    pick.iri = "http://x/Issuer";
    getNeighborhood.mockRejectedValue(new Error("network down"));
    await renderInQueryMode();
    await clickResultChip();

    expect(document.querySelector(".error-bar")!.textContent).toContain("network down");

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    });
    expect(getNodeDetails).toHaveBeenCalledWith("o1", "http://x/Issuer");
    expect(document.querySelector(".detail-panel")).toBeTruthy();
  });

  it("a predicate result selects without claiming to move the camera", async () => {
    // AC-5, and the route that used to blank the whole application before the
    // crash fix on 2026-07-30. A predicate is never a node in the viz graph, so
    // /neighborhood answers 404 — a fact rather than a fault, which is why it
    // reaches the polite region and not the red bar.
    //
    // That the camera does not actually move is GraphView's focusTarget guard
    // and is asserted in GraphView.test.tsx; what App owns is saying so.
    pick.iri = "http://x/issuedBy";
    getNeighborhood.mockRejectedValue(new ApiError("No entity with that IRI is drawn", 404));
    await renderInQueryMode();
    await clickResultChip();

    expect(liveRegion()).toContain("not drawn on the graph");
    expect(document.querySelector(".error-bar")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    });
    expect(document.querySelector(".detail-panel")).toBeTruthy();
  });

  it("search picks and result picks use the same handler", async () => {
    // AC-6. Asserted as identical behaviour rather than as identical source,
    // which is what "the same function" is actually worth: the same entity,
    // undrawn, reached from either control, must produce the same one request.
    // These two drifted apart once already — stage 2 taught search to draw an
    // entity outside the budget and nobody told the results table.
    pick.iri = "http://x/Issuer";
    getNeighborhood.mockResolvedValue(NEIGHBORHOOD);
    await renderInQueryMode();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake search hit" }));
    });
    const fromSearch = getNeighborhood.mock.calls.slice();
    getNeighborhood.mockClear();

    await clickResultChip();

    expect(getNeighborhood.mock.calls).toEqual(fromSearch);
    expect(fromSearch).toHaveLength(1);
  });

  it("result chips do not add a query step", async () => {
    // AC-7. The one thing a result pick must NOT inherit from a search pick.
    // Clicking a result is inspecting an answer; a chip that quietly extended
    // the query being built would be a trap, and in Query mode the search box
    // does exactly that two controls away.
    pick.iri = "http://x/Issuer";
    getNeighborhood.mockResolvedValue(NEIGHBORHOOD);
    await renderInQueryMode();
    getQueryNode.mockClear();

    await clickResultChip();

    expect(getQueryNode).not.toHaveBeenCalled();

    // The contrast, from the same state: a search hit in Query mode does add one.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake search hit" }));
    });
    expect(getQueryNode).toHaveBeenCalledWith("o1", "http://x/Issuer");
  });

  it("view in source switches mode and passes the target", async () => {
    // AC-8 and AC-9 end to end. The source pane had no concept of a current
    // entity at all before this, so clicking a result while reading the file
    // did nothing whatever.
    getSource.mockResolvedValue({
      text: ["@prefix x: <http://x/> .", "", "x:Bond a owl:Class ."].join("\n"),
      format: "turtle",
      pretty: true,
      truncated: false,
      bytes: 60,
      lines: 3,
      name: "FIBO",
    });
    await renderInQueryMode();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake source control" }));
    });
    // Two passes: the located line is scrolled to on a deferred callback that
    // React only queues as the first act scope closes. See SourceView.test.tsx.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(screen.getByRole("tab", { name: "View" }).getAttribute("aria-selected")).toBe("true");
    const marked = document.querySelector(".source-line.target")!;
    expect(marked.getAttribute("data-line")).toBe("2");
    expect(marked.textContent).toContain("x:Bond");
    // Found, so nothing is announced: the highlight and the focus move are the
    // answer, and a sentence on every success is a sentence nobody reads.
    expect(liveRegion()).toBe("");
  });

  it("says so when the target is not in the text shown", async () => {
    // AC-10 at the App level. The pane's report has to reach the same polite
    // region as everything else, or a non-response is ambiguous again.
    await renderInQueryMode();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake source control" }));
    });

    expect(liveRegion()).toContain("does not appear in the source text");
    expect(document.querySelector(".error-bar")).toBeNull();
  });

  it("switching mode from the tab bar drops the source target", async () => {
    // Not an acceptance criterion; it is the defect the focus rule causes if
    // the target outlives the action that set it. Leaving View and coming back
    // re-runs the lookup, which moves focus to the source heading — stealing it
    // from the View tab the user has just pressed, which is exactly what the
    // rule in SourceView is written to avoid.
    await renderInQueryMode();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake source control" }));
    });
    expect(document.activeElement).toBe(document.querySelector("#source-view-heading"));

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    });
    const viewTab = screen.getByRole("tab", { name: "View" });
    viewTab.focus();
    await act(async () => {
      fireEvent.click(viewTab);
    });

    expect(document.querySelector(".source-view")).toBeTruthy();
    expect(document.activeElement).toBe(viewTab);
    expect(document.querySelector(".source-line.target")).toBeNull();
  });

  it("a later hit clears the message an earlier miss left up", async () => {
    // The Original / Formatted toggle re-runs the lookup against a different
    // document, and an entity absent from one form is regularly present in the
    // other. A resolution that only ever set the message would leave "that
    // entity does not appear" standing over a line that is now highlighted.
    getSource.mockResolvedValue({
      text: "nothing here",
      format: "turtle",
      pretty: false,
      truncated: false,
      bytes: 12,
      lines: 1,
      name: "FIBO",
    });
    await renderInQueryMode();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake source control" }));
    });
    expect(liveRegion()).toContain("does not appear in the source text");

    // The other tab, whose text does contain the entity.
    getSource.mockResolvedValue({
      text: ["@prefix x: <http://x/> .", "x:Bond a owl:Class ."].join("\n"),
      format: "turtle",
      pretty: true,
      truncated: false,
      bytes: 45,
      lines: 2,
      name: "FIBO",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Formatted Turtle/ }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(document.querySelector(".source-line.target")).toBeTruthy();
    expect(liveRegion()).toBe("");
  });

  it("focus moves to the source heading after switching", async () => {
    // AC-12. The control that was pressed is in the query panel, which the
    // source pane now covers, so leaving focus where it was would leave it on
    // nothing.
    await renderInQueryMode();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake source control" }));
    });

    expect(document.activeElement).toBe(document.querySelector("#source-view-heading"));
  });
});

describe("App removal warning", () => {
  /** Two saved queries against the ontology the tests remove. */
  const SAVED = [
    { id: "q1", name: "Bonds by issuer" },
    { id: "q2", name: "All jurisdictions" },
  ];

  /** The remove control, by the accessible name a screen reader would read. */
  function removeButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: /remove ontology/i }) as HTMLButtonElement;
  }

  async function clickRemove() {
    await act(async () => {
      fireEvent.click(removeButton());
    });
  }

  it("counts saved queries before showing the dialog", async () => {
    // AC-11. The ordering is the feature. A confirm spy that records the
    // count's state at the moment it is called is the only way to assert it
    // from here — asserting merely that both happened would pass against a
    // version that asked first and counted afterwards.
    listSavedQueries.mockResolvedValue(SAVED);
    let countedFirst = false;
    // The probe records state and nothing else. An expect() inside the mock
    // would throw through onRemove, which is called as `void onRemove()`, so a
    // failure would surface as an unhandled rejection rather than as this test
    // failing. The message is asserted afterwards, from the recorded call.
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      countedFirst = listSavedQueries.mock.calls.length === 1;
      return false;
    });

    await renderAppOpened();
    await clickRemove();

    expect(listSavedQueries).toHaveBeenCalledWith("o1");
    expect(countedFirst).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    // And the number reached the sentence, not just the network.
    const message = String(confirm.mock.calls[0][0]);
    expect(message).toContain("2 saved queries");
    expect(message).toContain("“Bonds by issuer”");
    confirm.mockRestore();
  });

  it("disables the remove control while counting", async () => {
    // AC-12. A dialog must never open over a stale count, so the control is
    // inert while the count is in flight, and says so rather than only
    // looking it.
    let release: (queries: unknown[]) => void = () => {};
    listSavedQueries.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await renderAppOpened();
    // Not awaited: the count is deliberately left unresolved.
    await act(async () => {
      fireEvent.click(removeButton());
    });

    expect(removeButton().disabled).toBe(true);
    expect(removeButton().getAttribute("aria-busy")).toBe("true");
    expect(confirm).not.toHaveBeenCalled();

    await act(async () => {
      release([]);
    });

    expect(removeButton().disabled).toBe(false);
    expect(removeButton().getAttribute("aria-busy")).toBe("false");
    confirm.mockRestore();
  });

  it("gives the remove control its focus back after counting", async () => {
    // Not in the spec's test plan; it is here because the browser said so.
    // Disabling a focused button blurs it to the body, and re-enabling does not
    // undo that — measured in Chrome on the built application, where
    // document.activeElement read BODY after the count. A keyboard user who
    // declined the dialog was left outside the tab order, which quietly undoes
    // the reason section 6 gives for keeping window.confirm at all: that it
    // returns focus on dismissal.
    //
    // This asserts on the mechanism rather than on document.activeElement, and
    // the reason is a measurement: jsdom does not blur a focused element when
    // it is disabled, and will not let focus be moved off a disabled one
    // either, so the losing condition cannot be reproduced here at all. An
    // activeElement assertion passed with the fix deleted — checked. What can
    // be held is that focus is deliberately put back, and that does fail
    // without it. The state it recovers from is browser-only and is recorded
    // in App.tsx beside the effect.
    let release: (queries: unknown[]) => void = () => {};
    listSavedQueries.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await renderAppOpened();
    const focused = vi.spyOn(removeButton(), "focus");
    await act(async () => {
      fireEvent.click(removeButton());
    });
    expect(removeButton().disabled).toBe(true);
    expect(focused).not.toHaveBeenCalled(); // not while it is still inert

    await act(async () => {
      release([]);
    });

    expect(focused).toHaveBeenCalledTimes(1);
    expect(removeButton().disabled).toBe(false);
    confirm.mockRestore();
  });

  it("a failed count still opens the dialog with cautious wording", async () => {
    // AC-13. A failed count must never become "0 queries", and it must not
    // block the removal either: the user asked to delete something.
    listSavedQueries.mockRejectedValue(new Error("network down"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderAppOpened();
    await clickRemove();

    const message = String(confirm.mock.calls[0][0]);
    expect(message).toContain("any queries saved against it");
    expect(message).not.toContain("0 saved");
    expect(deleteOntology).toHaveBeenCalledWith("o1");
    // The failed count is not an error bar: nothing the user did went wrong.
    expect(document.querySelector(".error-bar")).toBeNull();
    confirm.mockRestore();
  });

  it("cancelling makes no delete request", async () => {
    // AC-14. Counting is a read; declining must leave everything as it was.
    listSavedQueries.mockResolvedValue(SAVED);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await renderAppOpened();
    await clickRemove();

    expect(deleteOntology).not.toHaveBeenCalled();
    expect(chooserShown()).toBe(false);
    expect(document.querySelector(".notice-bar")).toBeNull();
    confirm.mockRestore();
  });

  it("reports the deleted query count afterwards", async () => {
    // AC-15. The number comes from the response, not from the count taken
    // before the dialog, so it is right even when the two disagree — which is
    // why this test has the server report three where the client counted two.
    listSavedQueries.mockResolvedValue(SAVED);
    deleteOntology.mockResolvedValue({ deleted: "o1", deletedQueries: 3 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderAppOpened();
    await clickRemove();

    expect(document.querySelector(".notice-bar")!.textContent).toBe(
      "Removed FIBO and 3 saved queries.",
    );
    confirm.mockRestore();
  });

  it("reports nothing extra when no queries were deleted", async () => {
    // AC-16. The ordinary case stays silent. The ontology visibly went; a
    // message saying so would be the noise that stops the other one being read.
    listSavedQueries.mockResolvedValue([]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderAppOpened();
    await clickRemove();

    expect(chooserShown()).toBe(true);
    expect(document.querySelector(".notice-bar")).toBeNull();
    // The region itself stays, and stays empty: it is what a screen reader is
    // already watching, so removing it would be the announcement bug it exists
    // to avoid. What must not happen is that it says anything.
    expect(document.querySelector(".notice-region")!.textContent).toBe("");
    confirm.mockRestore();
  });

  it("the confirmation is a polite live region", async () => {
    // AC-12's second half. It is announced without interrupting, and it is a
    // status rather than an alert because the action has already happened and
    // nothing needs a decision.
    listSavedQueries.mockResolvedValue(SAVED);
    deleteOntology.mockResolvedValue({ deleted: "o1", deletedQueries: 2 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderAppOpened();
    // The region exists before there is anything to say. A live region added
    // to the DOM in the same commit as its text is unreliably announced, and
    // this removal replaces the whole main area in that same commit.
    const region = document.querySelector(".notice-region")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");

    await clickRemove();

    expect(document.querySelector(".notice-region")).toBe(region);
    expect(region.textContent).toContain("Removed FIBO");
    expect(region.querySelector("[role='alert']")).toBeNull();
    confirm.mockRestore();
  });
});
