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
import QueryPanel, { queryScopeText } from "./QueryPanel";
import type { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { QueryState } from "../sparql/types";

const { runSparql, listSavedQueries, saveQuery, deleteSavedQuery, getEmbeddedQueries } = vi.hoisted(
  () => ({
    runSparql: vi.fn(),
    listSavedQueries: vi.fn(),
    saveQuery: vi.fn(),
    deleteSavedQuery: vi.fn(),
    getEmbeddedQueries: vi.fn(),
  }),
);
vi.mock("../api", () => ({
  runSparql,
  listSavedQueries,
  saveQuery,
  deleteSavedQuery,
  getEmbeddedQueries,
}));

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
    // The text query, never started here: these tests are the builder's.
    textQuery: null,
    textRef: { current: "" },
    forkToText: vi.fn(),
    openTextQuery: vi.fn(),
    setText: vi.fn(),
    markTextSaved: vi.fn(),
    leaveText: vi.fn(),
    textIsDirty: () => false,
  } as unknown as ReturnType<typeof useQueryBuilder>;
}

async function renderPanelWithResults() {
  const onPickIri = vi.fn();
  const onViewInSource = vi.fn();
  render(
    <QueryPanel
      ontologyId="ont-1"
      theme="light"
      builder={builderStub()}
      onPickIri={onPickIri}
      onViewInSource={onViewInSource}
      ontologyTriples={0}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
  });
  await waitFor(() => expect(document.querySelector(".results")).not.toBeNull());
  return { onPickIri, onViewInSource };
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

describe("QueryPanel result navigation", () => {
  it("both result controls reach the props App passed in", async () => {
    // AC-8 of result-navigation, and the reason this test is here rather than
    // only in App.test.tsx: that file stubs QueryPanel out, so nothing else
    // would notice if the panel stopped handing either callback down. The chip
    // and the source control are asserted together because a wiring mistake
    // that swapped them would leave both props "called".
    const { onPickIri, onViewInSource } = await renderPanelWithResults();

    fireEvent.click(screen.getByRole("button", { name: "B1" }));
    expect(onPickIri).toHaveBeenCalledWith("http://example.org/b1");
    expect(onViewInSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View B1 in source" }));
    expect(onViewInSource).toHaveBeenCalledWith("http://example.org/b1", undefined);
  });
});

const BUTTONS_BEFORE = [
  "1Bond",
  "✕",
  "✕ Clear path",
  "Auto",
  "Paths",
  "Distinct",
  "Count",
  "⧉ Copy",
  "⌸ Save",
  "▶ Execute",
];

describe("QueryPanel with the editor never opened (sparql-text-and-query-files, AC-1)", () => {
  function renderPanel() {
    render(
      <QueryPanel
        ontologyId="ont-1"
        theme="light"
        builder={builderStub()}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        ontologyTriples={0}
      />,
    );
  }

  it("shows today's controls plus exactly the two new buttons", async () => {
    renderPanel();
    await act(async () => undefined);
    const names = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    const added = ["Edit as text", "New text query"];
    // Every control the panel had on main at b176e60, in its order, read from
    // that build with this stub...
    expect(names.filter((n) => !added.includes(n ?? ""))).toEqual(BUTTONS_BEFORE);
    // ...and the only additions are the two the spec names.
    expect(names.filter((n) => added.includes(n ?? ""))).toEqual(added);
    // Nothing of the editor is rendered, and the builder is not wrapped.
    expect(screen.queryByRole("textbox", { name: "SPARQL query text" })).toBeNull();
    expect(document.querySelector("fieldset")).toBeNull();
    expect(screen.queryByText(/Queries in this file/)).toBeNull();
    // The same generated text in the same preview.
    expect(document.querySelector(".sparql-preview")?.textContent).toContain(
      "SELECT ?s WHERE { ?s a <http://example.org/Bond> }",
    );
  });

  it("makes the same requests as before: the saved list, and nothing else", async () => {
    renderPanel();
    await act(async () => undefined);
    expect(listSavedQueries).toHaveBeenCalledTimes(1);
    expect(getEmbeddedQueries).not.toHaveBeenCalled();
    expect(runSparql).not.toHaveBeenCalled();
    expect(saveQuery).not.toHaveBeenCalled();
  });

  it("the builder's controls are live, not disabled", () => {
    renderPanel();
    expect((screen.getByRole("button", { name: /Clear path/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("QueryPanel imports (external-access Stage 2, AC-20)", () => {
  it("states what a query runs over, in text", () => {
    expect(queryScopeText(true, 3)).toBe("Querying this ontology and 3 imports.");
    expect(queryScopeText(true, 1)).toBe("Querying this ontology and 1 import.");
    expect(queryScopeText(false, 3)).toBe(
      "Querying this ontology on its own, without its imports.",
    );
    // Nothing to say for an ontology with nothing resolved.
    expect(queryScopeText(false, 0)).toBeNull();
    expect(queryScopeText(false, null)).toBeNull();
  });

  it("runs over the merged view when the switch is on, and says so", async () => {
    render(
      <QueryPanel
        ontologyId="ont-1"
        theme="light"
        builder={builderStub()}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        ontologyTriples={0}
        includeImports
        importsCount={2}
      />,
    );
    expect(screen.getByText("Querying this ontology and 2 imports.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
    });
    expect(runSparql).toHaveBeenCalledWith("ont-1", expect.any(String), true);
  });
});
