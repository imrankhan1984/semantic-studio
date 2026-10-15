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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
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

// In the order explore-and-query-layout 5.4 puts them: the query's toolbar
// first, then the builder's path bar.
const BUTTONS_BEFORE = [
  "✓Auto",
  "Paths",
  "Distinct",
  "Count",
  "⧉ Copy",
  "⌸ Save",
  "▶ Execute",
  "1Bond",
  "✕",
  "✕ Clear path",
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

  it("names a project's data on the source line, a sample's words included (csv-data-import 5.6)", () => {
    render(
      <QueryPanel ontologyId="ont-1" theme="light" builder={builderStub()} onPickIri={vi.fn()}
        onViewInSource={vi.fn()} ontologyTriples={0} dataSources={[{ id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true }]} />,
    );
    expect(screen.getByText("Includes data from people.csv, imported 2 October 2026; sample: first 2,000 of 12,480 rows.")).toBeTruthy();
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

describe("QueryPanel order (explore-and-query-layout 5.4, AC-6)", () => {
  /** Whether `a` comes before `b` in the document. */
  const before = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("the pinned block comes before the builder, the builder before the results, the results before the saved queries", async () => {
    listSavedQueries.mockResolvedValue([
      {
        id: "q1",
        name: "Bonds",
        ontologyId: "ont-1",
        ontologyName: "Bonds ontology",
        state: STATE,
        sparql: "SELECT * WHERE {}",
        mode: "visual",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    await renderPanelWithResults();
    await waitFor(() => expect(document.querySelector(".saved-queries")).not.toBeNull());
    const pinned = document.querySelector(".query-pinned")!;
    const builder = document.querySelector(".path-bar-wrap")!;
    const sentence = document.querySelector(".plain-english")!;
    const results = document.querySelector(".results")!;
    const saved = document.querySelector(".saved-queries")!;
    expect(pinned.querySelector("button.primary")?.textContent).toContain("Execute");
    expect(before(pinned, builder)).toBe(true);
    expect(before(builder, sentence)).toBe(true);
    expect(before(sentence, results)).toBe(true);
    expect(before(results, saved)).toBe(true);
    // The builder is not inside the sticky block: it scrolls under it.
    expect(pinned.contains(builder)).toBe(false);
  });

  it("with nothing picked, the starting options come after Execute", () => {
    const empty = { ...builderStub(), state: { ...STATE, steps: [] }, sparql: "" };
    render(
      <QueryPanel
        ontologyId="ont-1"
        theme="light"
        builder={empty as unknown as ReturnType<typeof useQueryBuilder>}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        ontologyTriples={0}
      />,
    );
    const execute = screen.getByRole("button", { name: /Execute/ });
    const start = document.querySelector(".query-start")!;
    expect(start).not.toBeNull();
    expect(before(execute, start)).toBe(true);
  });
});

describe("Query's four switches (explore-and-query-layout 5.5, AC-7)", () => {
  /** The panel over a builder whose state really changes, so a switch's
   *  pressed state can follow a click. */
  function Harness() {
    const [state, setState] = useState<QueryState>(STATE);
    const builder = { ...builderStub(), state, setState };
    return (
      <QueryPanel
        ontologyId="ont-1"
        theme="light"
        builder={builder as unknown as ReturnType<typeof useQueryBuilder>}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        ontologyTriples={0}
      />
    );
  }

  const group = () => screen.getByRole("group", { name: "Query options" });
  const switchNamed = (name: string) =>
    within(group()).getByRole("button", { name: new RegExp(`^${name}$`) });

  it("the four sit in one group, each a toggle with aria-pressed", () => {
    render(<Harness />);
    const buttons = within(group()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.replace("✓", ""))).toEqual([
      "Auto",
      "Paths",
      "Distinct",
      "Count",
    ]);
    for (const button of buttons) expect(["true", "false"]).toContain(button.getAttribute("aria-pressed"));
    expect(switchNamed("Auto").getAttribute("aria-pressed")).toBe("true");
    expect(switchNamed("Paths").getAttribute("aria-pressed")).toBe("false");
  });

  it("each follows its own click, and they combine", () => {
    render(<Harness />);
    fireEvent.click(switchNamed("Distinct"));
    fireEvent.click(switchNamed("Count"));
    expect(switchNamed("Distinct").getAttribute("aria-pressed")).toBe("true");
    expect(switchNamed("Count").getAttribute("aria-pressed")).toBe("true");
    expect(switchNamed("Paths").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(switchNamed("Distinct"));
    expect(switchNamed("Distinct").getAttribute("aria-pressed")).toBe("false");
    expect(switchNamed("Count").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(switchNamed("Auto"));
    expect(switchNamed("Auto").getAttribute("aria-pressed")).toBe("false");
  });

  it("an on switch shows a check mark, hidden from assistive technology; an off one none", () => {
    render(<Harness />);
    const auto = switchNamed("Auto");
    const mark = auto.querySelector("span[aria-hidden='true']");
    expect(mark?.textContent).toBe("✓");
    expect(switchNamed("Paths").textContent).not.toContain("✓");
    fireEvent.click(switchNamed("Paths"));
    expect(switchNamed("Paths").querySelector("span[aria-hidden='true']")?.textContent).toBe("✓");
  });

  it("Refresh, shown when Auto is off, is outside the group", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    fireEvent.click(switchNamed("Auto"));
    const refresh = screen.getByRole("button", { name: /Refresh/ });
    expect(group().contains(refresh)).toBe(false);
  });
});

describe("a name already used (explore-and-query-layout 5.7, U-4, AC-10)", () => {
  const BONDS = {
    id: "q1",
    name: "Bonds",
    ontologyId: "ont-1",
    ontologyName: "Bonds ontology",
    state: STATE,
    sparql: "SELECT * WHERE {}",
    mode: "visual" as const,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
  const NOTE = "You already have a query called “Bonds”. Saving keeps both.";

  beforeEach(() => {
    saveQuery.mockReset();
  });

  function renderWith(openQuery: { id: string; name: string } | null) {
    const builder = { ...builderStub(), openQuery };
    render(
      <QueryPanel
        ontologyId="ont-1"
        theme="light"
        builder={builder as unknown as ReturnType<typeof useQueryBuilder>}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        ontologyTriples={0}
      />,
    );
  }

  it("a new query named like a saved one, in another case with spaces, shows the note and still saves", async () => {
    listSavedQueries.mockResolvedValue([BONDS]);
    saveQuery.mockResolvedValue({ ...BONDS, id: "q2", name: "  bONDS " });
    renderWith(null);
    await waitFor(() => expect(document.querySelector(".saved-queries")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    const field = screen.getByPlaceholderText("Query name");
    fireEvent.change(field, { target: { value: "Bond" } });
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(field, { target: { value: "  bONDS " } });
    const note = screen.getByText(NOTE);
    expect(field.getAttribute("aria-describedby")).toBe(note.id);
    await act(async () => {
      fireEvent.click(within(document.querySelector(".save-row")!).getByRole("button", { name: "Save" }));
    });
    // Saved as a new query, beside the other: no id, so nothing is replaced.
    expect(saveQuery).toHaveBeenCalledTimes(1);
    expect(saveQuery.mock.calls[0][0]).toMatchObject({ name: "  bONDS " });
    expect(saveQuery.mock.calls[0][0].id).toBeUndefined();
  });

  it("the open query saved under its own name shows nothing", async () => {
    listSavedQueries.mockResolvedValue([BONDS]);
    saveQuery.mockResolvedValue(BONDS);
    renderWith({ id: "q1", name: "Bonds" });
    await waitFor(() => expect(document.querySelector(".saved-queries")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Update/ }));
    });
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(saveQuery.mock.calls[0][0]).toMatchObject({ id: "q1", name: "Bonds" });
  });
});
