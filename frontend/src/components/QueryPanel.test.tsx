// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/QueryPanel.test.tsx
================================================================================

SUMMARY
    The first test for QueryPanel, and it covers exactly one thing: that the
    results area can be emptied without destroying the query, and that the
    control which does it cannot be mistaken for the path bar's Clear path.

BASIC IDEA
    QueryPanel is orchestration over useQueryBuilder, so this renders it with a
    hand-built builder rather than the real hook. That keeps the test about the
    panel's own wiring — which callback the clear control is given — instead of
    about the hook's schema fetching, which has its own tests.

    Two Clear controls doing different things is the defect this file exists to
    prevent, so the second test asks for both by computed accessible name and
    fails if they ever converge.

INPUTS / INPUT SOURCES
    - A mocked ../api: runSparql returns a fixed result set, the saved-query
      calls return nothing.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-8.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueryPanel from "./QueryPanel";
import type { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { QueryState } from "../sparql/types";

const { runSparql, listSavedQueries, saveQuery, deleteSavedQuery } = vi.hoisted(() => ({
  runSparql: vi.fn(),
  listSavedQueries: vi.fn(),
  saveQuery: vi.fn(),
  deleteSavedQuery: vi.fn(),
}));
vi.mock("../api", () => ({ runSparql, listSavedQueries, saveQuery, deleteSavedQuery }));

const STATE: QueryState = {
  steps: [{ classIri: "http://example.org/Bond", label: "Bond", props: [] }],
  limit: 100,
  pathsMode: false,
  distinct: false,
  aggregate: "none",
};

const RESULTS = {
  vars: ["s"],
  rows: [[{ type: "uri" as const, value: "http://example.org/b1", label: "B1" }]],
  rowCount: 1,
  durationMs: 12,
  truncated: false,
};

const clear = vi.fn();

/**
 * A builder with one step in it, so the panel renders its query rather than
 * QueryStart. `ontologyTriples` is left at zero by the caller so the
 * auto-preview never fires and the only result set is the one Execute
 * produces.
 */
function builderStub() {
  return {
    schema: { classes: [], links: [], namespaces: {}, truncated: false },
    schemaError: null,
    loadingSchema: false,
    state: STATE,
    setState: vi.fn(),
    sparql: "SELECT ?s WHERE { ?s a <http://example.org/Bond> }",
    hint: null,
    setHint: vi.fn(),
    pathIris: [],
    candidates: new Set<string>(),
    addNode: vi.fn(),
    addClass: vi.fn(),
    addNextStep: vi.fn(),
    nextStepOptions: [],
    dataPropertiesFor: () => [],
    ancestorsOf: () => [],
    removeStep: vi.fn(),
    updateStep: vi.fn(),
    updateLink: vi.fn(),
    clear,
    openQuery: null,
    setOpenQuery: vi.fn(),
    loadState: vi.fn(),
  } as unknown as ReturnType<typeof useQueryBuilder>;
}

async function renderPanelWithResults() {
  render(
    <QueryPanel
      ontologyId="ont-1"
      theme="light"
      builder={builderStub()}
      onPickIri={vi.fn()}
      ontologyTriples={0}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
  });
  await waitFor(() => expect(document.querySelector(".results")).not.toBeNull());
}

beforeEach(() => {
  runSparql.mockReset().mockResolvedValue(RESULTS);
  listSavedQueries.mockReset().mockResolvedValue([]);
  clear.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("QueryPanel clear results", () => {
  it("clear empties the results and leaves the query alone", async () => {
    // AC-8. The whole distinction from Clear path: the results area goes, the
    // query stays. `clear` is the builder's query reset, and it must not be
    // called — if it ever is, the user has lost work they cannot get back
    // without rebuilding.
    await renderPanelWithResults();
    expect(document.querySelector(".results-table")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear results" }));

    expect(document.querySelector(".results")).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    // The query text and its toolbar are untouched.
    expect(document.querySelector(".sparql-preview")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Execute/ })).toBeTruthy();
  });

  it("clear results and the path bar clear have distinct accessible names", async () => {
    // AC-8. A learner who presses the wrong one loses nothing that cannot be
    // rebuilt, but they should not have to find that out. Queried by computed
    // accessible name, not by textContent, because that is what a screen
    // reader user is choosing between.
    await renderPanelWithResults();
    const results = screen.getByRole("button", { name: "Clear results" });
    const path = screen.getByRole("button", { name: /Clear path/ });
    expect(results).not.toBe(path);
    expect(path.textContent).not.toContain("Clear results");
  });
});
