// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/App.test.tsx
================================================================================

SUMMARY
    The first test for App. Covers the status bar's node and edge counts under
    a node budget, including that they survive the notice being dismissed.

BASIC IDEA
    App is mocked down to the parts this asserts on. GraphView is replaced with
    a stub because it drives Sigma over WebGL, which jsdom has no canvas for,
    and api.ts is replaced so the component is driven by fixed responses rather
    than a server.

    The status bar is the reason this test exists: it is the one place that
    keeps stating the ontology's real size after the user dismisses the notice,
    so a regression here would hide the truncation completely rather than
    merely making it less visible.

INPUTS / INPUT SOURCES
    - A mocked api.ts returning one ontology summary and one budgeted graph.
    - A stubbed GraphView.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-23.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { OntologySummary, VizGraph } from "./types";

const { listOntologies, getGraph, deleteOntology, searchNodes } = vi.hoisted(() => ({
  listOntologies: vi.fn(),
  getGraph: vi.fn(),
  deleteOntology: vi.fn(),
  searchNodes: vi.fn(),
}));

vi.mock("./api", () => ({ listOntologies, getGraph, deleteOntology, searchNodes }));

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
  listOntologies.mockResolvedValue([SUMMARY]);
  getGraph.mockResolvedValue(TRUNCATED);
  searchNodes.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/** Render App and let the mount-time list and graph requests settle. */
async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

function statusBar(): string {
  return document.querySelector(".status-bar")!.textContent ?? "";
}

describe("App status bar", () => {
  it("status bar reads n of total when truncated", async () => {
    // AC-23: drawn and total, for BOTH nodes and edges.
    await renderApp();
    expect(statusBar()).toContain("2,000 of 18,717 nodes");
    expect(statusBar()).toContain("5,180 of 51,446 edges");
  });

  it("keeps saying n of total after the notice is dismissed", async () => {
    // AC-23's second half. Dismissing the notice hides the notice, not the
    // fact: this is what stops the truncation from becoming invisible.
    await renderApp();
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(statusBar()).toContain("2,000 of 18,717 nodes");
    expect(statusBar()).toContain("5,180 of 51,446 edges");
  });

  it("reads a plain count when nothing was truncated", async () => {
    // AC-3 at the App level: a small ontology reads "34 nodes", as before.
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
    await renderApp();

    expect(statusBar()).toContain("34 nodes");
    expect(statusBar()).not.toContain("of");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("show more asks for double the budget the server applied", async () => {
    // AC-21 end to end: the doubling is computed from stats.budget, so a
    // clamped response doubles from what was granted, not what was asked for.
    await renderApp();
    expect(getGraph).toHaveBeenLastCalledWith("o1", undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    });

    expect(getGraph).toHaveBeenLastCalledWith("o1", 4000);
  });
});
