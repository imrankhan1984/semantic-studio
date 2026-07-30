// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/App.test.tsx
================================================================================

SUMMARY
    Tests for App: the startup chooser (what is and is not requested on mount,
    what replaces it, and the two ways back to it), the status bar's node and
    edge counts under a node budget, the removal sequence that counts saved
    queries before asking and reports what it took afterwards, and which panel
    fills the Explore column.

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
      AC-16 of saved-query-deletion-warning, and AC-1, AC-15 and AC-16 of
      explore-mode-starting-point.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
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

vi.mock("./api", () => ({
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
  }: {
    leftRail?: React.ReactNode;
    onSelect: (iri: string | null) => void;
    expansion?: { data: VizNeighborhood; token: number } | null;
    onExpanded?: (result: MergeResult) => void;
  }) => (
    <div data-testid="graph">
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
