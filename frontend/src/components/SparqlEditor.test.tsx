// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SparqlEditor.test.tsx
================================================================================

SUMMARY
    SPARQL as text, end to end inside the query panel (spec sparql-text-and-
    query-files): the editor opens on exactly the generated text, the first
    change forks, the fork dims the builder and ignores the graph, Back to the
    visual version restores the builder state exactly, Run and Ctrl+Enter
    send the text, New text query, .rq open and download, saved text queries,
    queries stored in the file, hostile text, keyboard and focus, and the
    keystroke render budget.

BASIC IDEA
    Rendered through the real useQueryBuilder hook and the real QueryPanel,
    not a hand-built builder, because the property most worth defending is
    the hook and the panel agreeing: that the fork leaves the builder's state
    untouched, and that going back finds it. A stubbed hook would assert
    whatever the stub was told. Only api.ts and download.ts are mocked.

    The render budget is measured the way result-navigation measured the
    results table's memo: the results object's `rows` is a getter that
    counts, so every render of ResultsTable is a read. Typing must add none.

    jsdom implements no sequential focus navigation, so "Tab leaves the
    editor" is asserted as the absence of anything that would stop it: the
    keydown is not default-prevented and inserts nothing. A browser walk
    confirmed the rest.

INPUTS / INPUT SOURCES
    - A mocked ../api and ../download.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-2 to AC-11, AC-14, AC-15 and
      Section 10's keystroke row.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueryPanel, { CUT_SHORT, DISCARD_TEXT, ONLY_SELECT, SHACL_VARIABLES_NOTE } from "./QueryPanel";
import { FORK_NOTICE } from "./SparqlEditor";
import { generateSparql } from "../sparql/generate";
import { MAX_QUERY_BYTES, NOT_UTF8, STARTER_COMMENT, TOO_LARGE_TO_OPEN } from "../sparql/textQuery";
import { useQueryBuilder } from "../sparql/useQueryBuilder";
import type { QueryState } from "../sparql/types";
import type { EmbeddedQuery, SavedQuery } from "../types";

const api = vi.hoisted(() => ({
  runSparql: vi.fn(),
  listSavedQueries: vi.fn(),
  saveQuery: vi.fn(),
  deleteSavedQuery: vi.fn(),
  getQuerySchema: vi.fn(),
  getQueryNode: vi.fn(),
  getEmbeddedQueries: vi.fn(),
}));
vi.mock("../api", () => api);

const { triggerDownload } = vi.hoisted(() => ({ triggerDownload: vi.fn() }));
vi.mock("../download", () => ({ triggerDownload }));

const EX = "http://example.org/";
const NAMESPACES = { ex: EX, rdfs: "http://www.w3.org/2000/01/rdf-schema#" };

const STATE: QueryState = {
  steps: [{ classIri: `${EX}Bond`, label: "Bond", props: [] }],
  limit: 100,
  pathsMode: false,
  distinct: true,
  aggregate: "none",
};

const SCHEMA = {
  classes: [{ iri: `${EX}Bond`, label: "Bond", prefixed: "ex:Bond", instances: 3, kind: "class" }],
  links: [],
  superClasses: {},
  dataProperties: {},
  namespaces: NAMESPACES,
  truncated: false,
  embeddedQueryCount: 0,
};

let rowReads = 0;
function countingResults() {
  const rows = [[{ type: "uri" as const, value: `${EX}b1`, label: "B1" }]];
  const results = { vars: ["s"], rowCount: 1, durationMs: 3, truncated: false } as Record<string, unknown>;
  Object.defineProperty(results, "rows", {
    get() {
      rowReads += 1;
      return rows;
    },
  });
  return results;
}

let builder: ReturnType<typeof useQueryBuilder>;
let harnessRenders = 0;

/** Stands where App stands: it owns the hook and renders the panel. */
function Harness(props: Partial<ComponentProps<typeof QueryPanel>>) {
  harnessRenders += 1;
  builder = useQueryBuilder("ont-1", true, props.includeImports ?? false);
  return (
    <QueryPanel
      ontologyId="ont-1"
      theme="light"
      builder={builder}
      onPickIri={vi.fn()}
      onViewInSource={vi.fn()}
      ontologyTriples={0}
      {...props}
    />
  );
}

/** Render with the schema loaded and, unless told otherwise, STATE built. */
async function setup(props: Partial<ComponentProps<typeof QueryPanel>> = {}, state: QueryState | null = STATE) {
  render(<Harness {...props} />);
  await waitFor(() => expect(builder.schema).not.toBeNull());
  if (state) act(() => builder.setState(state));
}

const textarea = () => screen.getByRole("textbox", { name: "SPARQL query text" }) as HTMLTextAreaElement;
const editButton = () => screen.getByRole("button", { name: "Edit as text" });

function type(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

async function openEditorAndFork(text = "SELECT ?s WHERE { { ?s ?p ?o } UNION { ?o ?p ?s } }") {
  fireEvent.click(editButton());
  type(text);
  await waitFor(() => expect(builder.textQuery).not.toBeNull());
}

beforeEach(() => {
  rowReads = 0;
  api.runSparql.mockReset().mockImplementation(async () => countingResults());
  api.listSavedQueries.mockReset().mockResolvedValue([]);
  api.saveQuery.mockReset().mockImplementation(async (body) => ({
    ...body,
    id: body.id ?? "q-0123456789ab",
    ontologyName: "o",
    createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z",
  }));
  api.deleteSavedQuery.mockReset();
  api.getQuerySchema.mockReset().mockResolvedValue(SCHEMA);
  api.getQueryNode.mockReset().mockResolvedValue({
    iri: `${EX}Coupon`,
    isClass: true,
    label: "Coupon",
    types: [],
  });
  api.getEmbeddedQueries.mockReset();
  triggerDownload.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("from the builder to text", () => {
  it("opens with exactly the generated text (AC-2)", async () => {
    await setup();
    fireEvent.click(editButton());
    expect(textarea().value).toBe(generateSparql(STATE, NAMESPACES));
    expect(textarea().value).toBe(builder.sparql);
  });

  it("closes unchanged with nothing lost and no notice (AC-3)", async () => {
    await setup();
    const before = builder.state;
    fireEvent.click(editButton());
    expect(screen.queryByText(FORK_NOTICE)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    expect(screen.queryByRole("textbox", { name: "SPARQL query text" })).toBeNull();
    expect(builder.state).toBe(before);
    expect(builder.textQuery).toBeNull();
    expect(document.querySelector(".sparql-preview")?.textContent).toContain("SELECT");
  });

  it("the first change forks: notice, dimmed path bar, graph ignored (AC-4)", async () => {
    await setup();
    const before = builder.state;
    await openEditorAndFork();

    expect(screen.getByText(FORK_NOTICE).closest("[role=status]")).not.toBeNull();
    const fieldset = document.querySelector("fieldset.builder-dimmed") as HTMLFieldSetElement;
    expect(fieldset).not.toBeNull();
    expect(fieldset.disabled).toBe(true);
    expect(fieldset.querySelector("legend")?.textContent).toBe("Not in use while editing text");
    // The path bar is inside it, so its controls are disabled with it.
    expect(fieldset.querySelector(".path-bar-wrap")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Clear path/ }).closest("fieldset")).toBe(fieldset);

    // A graph click (and a search pick, which uses the same route) changes nothing.
    await act(async () => {
      await builder.addNode(`${EX}Coupon`);
    });
    expect(api.getQueryNode).not.toHaveBeenCalled();
    expect(builder.state).toBe(before);
    expect(textarea().value).toContain("UNION");
  });

  it("the fork keeps the editor the user is typing in, and so the caret", async () => {
    // Found in review: keyed "visual" before the fork and by session after it,
    // the first keystroke replaced the textarea and every later one landed at
    // the end of the query. Identity is the claim; the caret goes with it.
    await setup();
    fireEvent.click(editButton());
    const before = textarea();
    before.setSelectionRange(10, 10);
    type(before.value.slice(0, 10) + "X" + before.value.slice(10));
    await waitFor(() => expect(builder.textQuery).not.toBeNull());
    expect(textarea()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("graph clicks still build while the editor is open and unchanged", async () => {
    // Before the fork the query is still visual (Section 5.1, step 3).
    await setup();
    fireEvent.click(editButton());
    await act(async () => {
      await builder.addNode(`${EX}Coupon`);
    });
    expect(api.getQueryNode).toHaveBeenCalled();
  });

  it("Back to the visual version asks once and restores the exact state (AC-5)", async () => {
    await setup();
    const snapshot = structuredClone(builder.state);
    const before = builder.state;
    await openEditorAndFork();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Back to the visual version" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(DISCARD_TEXT);
    expect(builder.textQuery).toBeNull();
    expect(builder.state).toBe(before);
    expect(builder.state).toEqual(snapshot);
    expect(document.querySelector("fieldset.builder-dimmed")).toBeNull();
    expect(document.querySelector(".sparql-preview")?.textContent).not.toContain("UNION");
  });

  it("declining the confirmation keeps the text", async () => {
    await setup();
    await openEditorAndFork("SELECT ?kept WHERE { ?kept ?p ?o }");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Back to the visual version" }));
    expect(textarea().value).toContain("?kept");
    expect(builder.textQuery).not.toBeNull();
  });
});

describe("running (AC-6)", () => {
  it("Run and Ctrl+Enter send the editor text, honouring Include imports", async () => {
    await setup({ includeImports: true, importsCount: 2 });
    await openEditorAndFork("SELECT ?x WHERE { ?x ?p ?o }");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    expect(api.runSparql).toHaveBeenLastCalledWith("ont-1", "SELECT ?x WHERE { ?x ?p ?o }", true);
    await waitFor(() => expect(document.querySelector(".results-table")).not.toBeNull());

    type("SELECT ?y WHERE { ?y ?p ?o }");
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true });
    });
    expect(api.runSparql).toHaveBeenLastCalledWith("ont-1", "SELECT ?y WHERE { ?y ?p ?o }", true);
  });

  it("shows the server's sentence above the editor", async () => {
    api.runSparql.mockRejectedValueOnce(new Error("Could not parse the SPARQL query: nope"));
    await setup();
    await openEditorAndFork("SELEKT");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    const error = screen.getByText(/Could not parse the SPARQL query/);
    expect(error.closest(".sparql-editor")).not.toBeNull();
  });

  it("refuses text over 100 KB with a sentence and sends nothing", async () => {
    await setup();
    await openEditorAndFork("SELECT * {} #" + "x".repeat(MAX_QUERY_BYTES));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    expect(api.runSparql).not.toHaveBeenCalled();
    expect(screen.getByText(/larger than the 100 KB limit/)).toBeTruthy();
  });

  it("the builder's auto-preview does not run for a text query", async () => {
    // Control first: on a small ontology the builder previews by itself, so
    // silence below means the text query stopped it, not that it never runs.
    await setup({ ontologyTriples: 100 });
    await waitFor(() => expect(api.runSparql).toHaveBeenCalledTimes(1), { timeout: 2000 });
    cleanup();
    api.runSparql.mockClear();

    await setup({ ontologyTriples: 100 }, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    act(() => builder.setState(STATE));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(api.runSparql).not.toHaveBeenCalled();
  });
});

describe("a text query from nothing (AC-7)", () => {
  it("opens empty with the starter comment, offers prefixes, and has no way back", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    expect(textarea().value).toBe(STARTER_COMMENT);
    expect(screen.queryByRole("button", { name: "Back to the visual version" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Insert prefixes" }));
    const lines = textarea().value.split("\n");
    expect(lines[0]).toBe(STARTER_COMMENT.trim());
    expect(lines).toContain(`PREFIX ex: <${EX}>`);
    expect(lines).toContain("PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>");
    // Pressed again, nothing is declared twice.
    fireEvent.click(screen.getByRole("button", { name: "Insert prefixes" }));
    expect(textarea().value.match(/PREFIX ex:/g)).toHaveLength(1);
  });
});

describe(".rq files (AC-8)", () => {
  function choose(file: File) {
    const input = document.querySelector(".sparql-editor input[type=file]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  }

  it("opens a file as an unsaved text query named after it", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    const text = "SELECT ?s WHERE { ?s ?p ?o } LIMIT 5\n";
    await act(async () => choose(new File([text], "planets.rq")));
    await waitFor(() => expect(textarea().value).toBe(text));
    expect(document.querySelector(".sparql-editor-name")?.textContent).toBe("planets");
    expect(builder.openQuery).toBeNull();
    expect(api.saveQuery).not.toHaveBeenCalled();
    expect(api.runSparql).not.toHaveBeenCalled();
  });

  it("refuses a file over 100 KB with a sentence", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    await act(async () => choose(new File(["#".repeat(MAX_QUERY_BYTES + 1)], "big.rq")));
    await waitFor(() => expect(screen.getByText(TOO_LARGE_TO_OPEN)).toBeTruthy());
    expect(textarea().value).toBe(STARTER_COMMENT);
  });

  it("accepts a file of exactly 100 KB", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    const text = "#".repeat(MAX_QUERY_BYTES);
    await act(async () => choose(new File([text], "edge.rq")));
    await waitFor(() => expect(textarea().value).toBe(text));
  });

  it("refuses a file that is not UTF-8", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    await act(async () => choose(new File([new Uint8Array([0xff, 0xfe, 0x00, 0xd8])], "bin.rq")));
    await waitFor(() => expect(screen.getByText(NOT_UTF8)).toBeTruthy());
  });

  it("downloads the current text as <name>.rq, and the download opens again unchanged", async () => {
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    const text = "SELECT ?s WHERE { ?s ?p \"é\" }\n";
    await act(async () => choose(new File([text], "round/trip.rq")));
    await waitFor(() => expect(textarea().value).toBe(text));

    fireEvent.click(screen.getByRole("button", { name: "Download .rq" }));
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    const [blob, filename] = triggerDownload.mock.calls[0] as [Blob, string];
    // The slash in the name must not become a folder.
    expect(filename).toBe("round-trip.rq");
    expect(await blob.text()).toBe(text);

    await act(async () => choose(new File([blob], filename)));
    await waitFor(() => expect(document.querySelector(".sparql-editor-name")?.textContent).toBe("round-trip"));
    expect(textarea().value).toBe(text);
  });

  it("downloads a visual query's text too, named query.rq", async () => {
    await setup();
    fireEvent.click(editButton());
    fireEvent.click(screen.getByRole("button", { name: "Download .rq" }));
    const [blob, filename] = triggerDownload.mock.calls[0] as [Blob, string];
    expect(filename).toBe("query.rq");
    expect(await blob.text()).toBe(builder.sparql);
    expect(builder.textQuery).toBeNull();
  });
});

describe("saved text queries (AC-9, AC-10)", () => {
  it("Save stores mode text with the state it forked from", async () => {
    await setup();
    const before = builder.state;
    await openEditorAndFork("SELECT ?u WHERE { { ?u ?p ?o } UNION { ?o ?p ?u } }");
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    fireEvent.change(screen.getByPlaceholderText("Query name"), { target: { value: "Union" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(api.saveQuery).toHaveBeenCalledWith({
      id: undefined,
      name: "Union",
      ontologyId: "ont-1",
      state: before,
      sparql: "SELECT ?u WHERE { { ?u ?p ?o } UNION { ?o ?p ?u } }",
      mode: "text",
    });
  });

  it("text typed while a save is in flight still counts as unsaved", async () => {
    // Found in review: the baseline was taken from the live text when the
    // response landed, so a keystroke during the request was marked saved and
    // Close editor discarded it without asking.
    let respond: (value: unknown) => void = () => undefined;
    api.saveQuery.mockImplementation(
      (body) =>
        new Promise((r) => {
          respond = () => r({ ...body, id: "q-0123456789ab", ontologyName: "o", createdAt: "", updatedAt: "" });
        }),
    );
    await setup();
    await openEditorAndFork("SELECT ?a WHERE { ?a ?b ?c }");
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    fireEvent.change(screen.getByPlaceholderText("Query name"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    type("SELECT ?a WHERE { ?a ?b ?c } LIMIT 1");
    await act(async () => respond(undefined));

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(confirm).toHaveBeenCalledWith(DISCARD_TEXT);
    expect(textarea().value).toContain("LIMIT 1");
  });

  it("a visual save sends mode visual and today's body otherwise", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    fireEvent.change(screen.getByPlaceholderText("Query name"), { target: { value: "Bonds" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(api.saveQuery).toHaveBeenCalledWith({
      id: undefined,
      name: "Bonds",
      ontologyId: "ont-1",
      state: builder.state,
      sparql: builder.sparql,
      mode: "visual",
    });
  });

  const SAVED_TEXT: SavedQuery = {
    id: "q-aaaaaaaaaaaa",
    name: "My union",
    ontologyId: "ont-1",
    ontologyName: "o",
    mode: "text",
    state: STATE,
    sparql: "SELECT ?z WHERE { { ?z ?p ?o } UNION { ?o ?p ?z } }",
    createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z",
  };
  const SAVED_OLD: SavedQuery = {
    id: "q-bbbbbbbbbbbb",
    name: "Old visual",
    ontologyId: "ont-1",
    ontologyName: "o",
    // No `mode`: saved before the feature.
    state: { ...STATE, distinct: false },
    sparql: "SELECT …",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("marks text queries with a word, reopens them in the editor, and can go back after a reload", async () => {
    api.listSavedQueries.mockResolvedValue([SAVED_TEXT, SAVED_OLD]);
    // A fresh render with an empty builder: what a reload gives.
    await setup({}, null);
    await waitFor(() => expect(screen.getByText("My union")).toBeTruthy());

    const textRow = screen.getByText("My union").closest(".saved-row") as HTMLElement;
    expect(textRow.querySelector(".saved-mode")?.textContent).toBe("text");
    const oldRow = screen.getByText("Old visual").closest(".saved-row") as HTMLElement;
    expect(oldRow.querySelector(".saved-mode")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "My union" }));
    expect(textarea().value).toBe(SAVED_TEXT.sparql);
    expect(builder.openQuery).toEqual({ id: SAVED_TEXT.id, name: SAVED_TEXT.name });

    // AC-10: the state it forked from came back with it.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to the visual version" }));
    expect(builder.state).toEqual(STATE);
    expect(builder.textQuery).toBeNull();
  });

  it("an entry saved before the feature opens in the builder (AC-9)", async () => {
    api.listSavedQueries.mockResolvedValue([SAVED_OLD]);
    await setup({}, null);
    await waitFor(() => expect(screen.getByText("Old visual")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Old visual" }));
    expect(builder.state.distinct).toBe(false);
    expect(builder.state.steps).toEqual(STATE.steps);
    expect(builder.textQuery).toBeNull();
    expect(screen.queryByRole("textbox", { name: "SPARQL query text" })).toBeNull();
  });
});

describe("queries stored in the file (AC-11)", () => {
  const QUERIES: EmbeddedQuery[] = [
    {
      subject: `${EX}Find`,
      label: "Find bonds",
      predicate: "http://spinrdf.org/sp#text",
      form: "SELECT",
      text: "SELECT ?b WHERE { ?b a <http://example.org/Bond> }",
      truncated: false,
      shaclVariables: false,
    },
    {
      subject: null,
      label: "Person shape",
      predicate: "http://www.w3.org/ns/shacl#ask",
      form: "ASK",
      text: "ASK { $this ?p ?o }",
      truncated: false,
      shaclVariables: true,
    },
    {
      subject: `${EX}Long`,
      label: "Long one",
      predicate: "http://www.w3.org/ns/shacl#select",
      form: "SELECT",
      text: "SELECT * {}",
      truncated: true,
      shaclVariables: false,
    },
  ];

  it("is not shown for a file without stored queries", async () => {
    await setup();
    expect(screen.queryByText(/Queries in this file/)).toBeNull();
  });

  it("lists them on request, runs SELECT, and refuses the other forms with a reason", async () => {
    api.getQuerySchema.mockResolvedValue({ ...SCHEMA, embeddedQueryCount: 3 });
    api.getEmbeddedQueries.mockResolvedValue({ queries: QUERIES, total: 3, truncated: false });
    await setup({}, null);

    const toggle = await screen.findByRole("button", { name: /Queries in this file \(3\)/ });
    // Nothing is fetched until the list is opened.
    expect(api.getEmbeddedQueries).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(api.getEmbeddedQueries).toHaveBeenCalledTimes(1);

    const askRow = (await screen.findByText("Person shape")).closest(".saved-row") as HTMLElement;
    expect(askRow.textContent).toContain("ASK");
    expect(askRow.textContent).toContain("uses $this or $value");

    // A SELECT opens editable and runs.
    fireEvent.click(screen.getByRole("button", { name: "Find bonds" }));
    expect(textarea().readOnly).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    expect(api.runSparql).toHaveBeenCalledWith("ont-1", QUERIES[0].text, false);

    // An ASK opens read-only with Run disabled and its reason as the label.
    fireEvent.click(screen.getByRole("button", { name: "Person shape" }));
    expect(textarea().value).toBe(QUERIES[1].text);
    expect(textarea().readOnly).toBe(true);
    const run = screen.getByRole("button", { name: `Run. ${ONLY_SELECT}` });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(ONLY_SELECT)).toBeTruthy();
    expect(screen.getByText(SHACL_VARIABLES_NOTE)).toBeTruthy();

    // A text cut at 100 KB is not the author's query and does not run.
    fireEvent.click(screen.getByRole("button", { name: "Long one" }));
    expect(screen.getByRole("button", { name: `Run. ${CUT_SHORT}` })).toHaveProperty("disabled", true);

    // Closing and reopening the list does not fetch again.
    await act(async () => fireEvent.click(toggle));
    await act(async () => fireEvent.click(toggle));
    expect(api.getEmbeddedQueries).toHaveBeenCalledTimes(1);
  });

  it("a listing that lands after the view changed is dropped", async () => {
    // Found in review: open the list, turn Include imports on before the
    // answer arrives, and the file-only answer filled the merged view's list.
    api.getQuerySchema.mockResolvedValue({ ...SCHEMA, embeddedQueryCount: 3 });
    let answer: (value: unknown) => void = () => undefined;
    api.getEmbeddedQueries.mockImplementation(() => new Promise((r) => (answer = r)));
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(builder.schema).not.toBeNull());
    await act(async () =>
      fireEvent.click(await screen.findByRole("button", { name: /Queries in this file/ })),
    );
    const stale = answer;

    rerender(<Harness includeImports importsCount={1} />);
    await waitFor(() => expect(builder.schema).not.toBeNull());
    // Reopened on the new view: its own request is now pending too. The list
    // is open, so a stale answer that got through would be on screen.
    await act(async () =>
      fireEvent.click(await screen.findByRole("button", { name: /Queries in this file/ })),
    );
    expect(api.getEmbeddedQueries).toHaveBeenLastCalledWith("ont-1", true);
    await act(async () => stale({ queries: QUERIES, total: 3, truncated: false }));

    expect(screen.queryByText("Find bonds")).toBeNull();
    expect(screen.getByText("Reading the file…")).toBeTruthy();
  });

  it("says when the list is capped", async () => {
    api.getQuerySchema.mockResolvedValue({ ...SCHEMA, embeddedQueryCount: 250 });
    api.getEmbeddedQueries.mockResolvedValue({ queries: QUERIES, total: 250, truncated: true });
    await setup({}, null);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: /Queries in this file/ })));
    expect(await screen.findByText("Showing 3 of 250.")).toBeTruthy();
  });
});

describe("hostile text (AC-14)", () => {
  const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

  it("query text, a file name and a stored query's label are all shown as text", async () => {
    api.getQuerySchema.mockResolvedValue({ ...SCHEMA, embeddedQueryCount: 1 });
    api.getEmbeddedQueries.mockResolvedValue({
      queries: [{ ...{ subject: null, predicate: "p", form: "SELECT", truncated: false, shaclVariables: false }, label: HOSTILE, text: HOSTILE }],
      total: 1,
      truncated: false,
    });
    await setup({}, null);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: /Queries in this file/ })));
    fireEvent.click(await screen.findByRole("button", { name: HOSTILE }));

    expect(textarea().value).toBe(HOSTILE);
    expect(document.querySelector(".sparql-editor-name")?.textContent).toBe(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    // And in the read-only preview, once back in the builder.
    act(() => builder.leaveText());
    act(() => builder.setState({ ...STATE, steps: [{ ...STATE.steps[0], label: HOSTILE }] }));
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("keyboard and screen readers (AC-15)", () => {
  it("labels the editor, moves focus in on open and back on close", async () => {
    await setup();
    fireEvent.click(editButton());
    expect(document.activeElement).toBe(textarea());
    expect(textarea().getAttribute("aria-describedby")).toBe("sparql-editor-help");
    expect(document.getElementById("sparql-editor-help")?.textContent).toContain("Ctrl+Enter");
    // The hint is visible on the button as well.
    expect(screen.getByRole("button", { name: /Run/ }).textContent).toContain("Ctrl+Enter");

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    await waitFor(() => expect(document.activeElement).toBe(editButton()));
  });

  it("focus returns to Edit as text after Back to the visual version", async () => {
    await setup();
    await openEditorAndFork();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to the visual version" }));
    await waitFor(() => expect(document.activeElement).toBe(editButton()));
  });

  it("with no query to edit, focus goes to New text query instead", async () => {
    // Edit as text is disabled on an empty builder, and a disabled button
    // cannot hold focus -- the blur-to-body defect this project has met twice.
    await setup({}, null);
    fireEvent.click(screen.getByRole("button", { name: "New text query" }));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New text query" })),
    );
  });

  it("Tab is not captured: it is not prevented and inserts nothing", async () => {
    await setup();
    await openEditorAndFork("SELECT * {}");
    const notPrevented = fireEvent.keyDown(textarea(), { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(textarea().value).toBe("SELECT * {}");
  });

  it("the fork notice is a status region whose text does not change afterwards", async () => {
    await setup();
    await openEditorAndFork("SELECT * {}");
    const notice = screen.getByText(FORK_NOTICE).closest("[role=status]") as HTMLElement;
    const text = notice.textContent;
    type("SELECT * { ?a ?b ?c }");
    type("SELECT * { ?a ?b ?d }");
    // Same element, same words: announced once, not on every keystroke.
    expect(screen.getByText(FORK_NOTICE).closest("[role=status]")).toBe(notice);
    expect(notice.textContent).toBe(text);
  });

  it("announces a run politely", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    api.runSparql.mockImplementation(() => new Promise((r) => (resolve = r)));
    await setup();
    await openEditorAndFork("SELECT * {}");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    const live = [...document.querySelectorAll("[aria-live=polite]")].find((el) =>
      el.textContent?.includes("Running query…"),
    );
    expect(live).toBeTruthy();
    await act(async () => resolve(countingResults()));
  });
});

describe("performance (Section 10)", () => {
  it("keystroke_does_not_render_results", async () => {
    await setup();
    await openEditorAndFork("SELECT ?s WHERE { ?s ?p ?o }");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    });
    await waitFor(() => expect(document.querySelector(".results-table")).not.toBeNull());
    // Assert the counter works before trusting its silence below.
    expect(rowReads).toBeGreaterThan(0);
    const settled = rowReads;
    const hostRenders = harnessRenders;

    for (const suffix of [" ", "L", "LI", "LIM", "LIMIT 5"]) {
      type(`SELECT ?s WHERE { ?s ?p ?o }${suffix}`);
    }
    expect(textarea().value).toBe("SELECT ?s WHERE { ?s ?p ?o }LIMIT 5");
    expect(rowReads).toBe(settled);
    // Stronger than the spec's row, and the reason the text is in a ref: the
    // hook's owner -- App, with the graph under it -- is not rendered either.
    // ResultsTable's memo alone would keep the first assertion green.
    expect(harnessRenders).toBe(hostRenders);
    // And the typed text still reached the hook, for Run and Save to read.
    expect(builder.textRef.current).toBe("SELECT ?s WHERE { ?s ?p ?o }LIMIT 5");
  });
});
