// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/App.test.tsx
================================================================================

SUMMARY
    Tests for App: the startup chooser (what is and is not requested on mount,
    what replaces it, and the two ways back to it) and the status bar's node
    and edge counts under a node budget.

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

INPUTS / INPUT SOURCES
    - A mocked api.ts returning one ontology summary and one budgeted graph.
    - A stubbed GraphView.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-5, AC-9 and AC-13 of
      startup-chooser-screen, and AC-23 of partial-graph-rendering.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { OntologySummary, VizGraph } from "./types";

const { listOntologies, getGraph, deleteOntology, searchNodes, fetchOntology, uploadOntology } =
  vi.hoisted(() => ({
    listOntologies: vi.fn(),
    getGraph: vi.fn(),
    deleteOntology: vi.fn(),
    searchNodes: vi.fn(),
    fetchOntology: vi.fn(),
    uploadOntology: vi.fn(),
  }));

vi.mock("./api", () => ({
  listOntologies,
  getGraph,
  deleteOntology,
  searchNodes,
  fetchOntology,
  uploadOntology,
}));

/** Every mocked client function, so a test can count what mount actually did. */
const ALL_API = { listOntologies, getGraph, deleteOntology, searchNodes, fetchOntology, uploadOntology };

// Sigma needs a WebGL context; jsdom has none. Nothing here asserts on the
// canvas, so a stub keeps the test about the status bar.
vi.mock("./components/GraphView", () => ({
  default: ({ leftRail }: { leftRail?: React.ReactNode }) => <div data-testid="graph">{leftRail}</div>,
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
    deleteOntology.mockResolvedValue(undefined);
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
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("status")).toBeNull();
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
    expect(screen.queryByRole("status")).toBeNull();
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
