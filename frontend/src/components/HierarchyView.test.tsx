// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/HierarchyView.test.tsx
================================================================================

SUMMARY
    The test for HierarchyView: the labelled sections (class, concept and the
    three v0.3 property forests), collapsed-to-roots default, expand/collapse,
    the filter that keeps ancestors, the virtualization that bounds the DOM
    regardless of tree size, the keyboard tree operation and its ARIA, and the
    reserved "inferred" rendering channel proven by a synthetic derived edge.

BASIC IDEA
    HierarchyView fetches its forests from api.ts, so the module is mocked and
    each test hands it a constructed Hierarchy. Most assertions are a render and
    a query. Two are not. Virtualization is a claim about how many rows are in
    the DOM, checked by feeding a 4,000-node forest and counting treeitems — a
    mutation that renders every row instead of the window turns it red. The
    inferred row proves the D-046 seam: a forest carrying one origin:"inferred"
    edge lights up the derived badge, cue and aria mention with no code change.

INPUTS / INPUT SOURCES
    - Constructed Hierarchy objects.
    - A mocked api.ts (fetchHierarchy; for the project's actions also
      openProject, runCommand and previewDelete; ApiError stays real).

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6 to AC-9, AC-11, AC-12 and AC-14 of
      hierarchy-view.md, and AC-5 of visual-modeling-canvas.md: in a project,
      New class, New concept and the row menu, all by keyboard.
================================================================================
*/

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HierarchyView from "./HierarchyView";
import { projectStore } from "../state/projectStore";
import type { Hierarchy, HierarchyForest } from "../types";

const { fetchHierarchy, openProject, runCommand, previewDelete } = vi.hoisted(() => ({
  fetchHierarchy: vi.fn(),
  openProject: vi.fn(),
  runCommand: vi.fn(),
  previewDelete: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, fetchHierarchy, openProject, runCommand, previewDelete };
});

const EX = "http://example.org/#";

/** A leaf/branch node entry. */
function node(label: string, kind = "class", hasChildren = false) {
  return { label, prefixed: `ex:${label}`, kind, hasChildren };
}

/** A forest from a {parent: [children]} map and a roots list; every node gets a
 *  label from its local name. Edges are asserted unless the child id ends in a
 *  marker the caller sets via `inferred`. */
function forestOf(
  nodes: Record<string, ReturnType<typeof node>>,
  edges: Record<string, string[]>,
  roots: string[],
  inferred: Set<string> = new Set(),
): HierarchyForest {
  const children: HierarchyForest["children"] = {};
  for (const [parent, kids] of Object.entries(edges)) {
    children[parent] = kids.map((id) => ({
      id,
      origin: inferred.has(`${parent}->${id}`) ? "inferred" : "asserted",
    }));
  }
  return { nodes, children, roots };
}

const EMPTY: HierarchyForest = { nodes: {}, children: {}, roots: [] };

function hierarchyOf(classes: HierarchyForest, concepts: HierarchyForest): Hierarchy {
  return {
    classes,
    concepts,
    counts: {
      classes: Object.keys(classes.nodes).length,
      concepts: Object.keys(concepts.nodes).length,
    },
    truncated: false,
  };
}

/** A small mixed hierarchy: a two-level class tree and a scheme with one top
 *  concept, so both sections have something to show. */
function mixed(): Hierarchy {
  const classes = forestOf(
    {
      [EX + "Alpha"]: node("Alpha", "class", true),
      [EX + "Beta"]: node("Beta", "class"),
    },
    { [EX + "Alpha"]: [EX + "Beta"] },
    [EX + "Alpha"],
  );
  const concepts = forestOf(
    {
      [EX + "Scheme"]: node("Scheme", "conceptScheme", true),
      [EX + "Water"]: node("Water", "concept"),
    },
    { [EX + "Scheme"]: [EX + "Water"] },
    [EX + "Scheme"],
  );
  return hierarchyOf(classes, concepts);
}

function renderView(hierarchy: Hierarchy, onSelect = vi.fn(), selected: string | null = null) {
  fetchHierarchy.mockResolvedValue(hierarchy);
  render(
    <HierarchyView ontologyId="o1" theme="dark" selected={selected} onSelect={onSelect} />,
  );
  return { onSelect };
}

/** All treeitems currently in the DOM, in document order. */
function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

function itemByLabel(label: string): HTMLElement | undefined {
  return items().find((el) => el.querySelector(".hierarchy-label")?.textContent === label);
}

beforeEach(() => {
  fetchHierarchy.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("HierarchyView", () => {
  it("renders class and concept sections when both are present", async () => {
    // AC-6. A mixed ontology shows both labelled trees.
    renderView(mixed());

    await screen.findByRole("heading", { name: "Class hierarchy" });
    expect(screen.getByRole("heading", { name: "Concept hierarchy" })).toBeTruthy();
    // Each section is its own WAI-ARIA tree.
    expect(screen.getAllByRole("tree")).toHaveLength(2);
    // The asserted-not-inferred note is present and says so.
    expect(document.querySelector(".hierarchy-note")?.textContent).toMatch(/asserted/i);
  });

  it("shows only one section for a single-forest ontology", async () => {
    // AC-6 tail. A pure-OWL ontology shows the class tree and no empty concept
    // section; a pure-SKOS one the reverse.
    renderView(hierarchyOf(mixed().classes, EMPTY));

    await screen.findByRole("heading", { name: "Class hierarchy" });
    expect(screen.queryByRole("heading", { name: "Concept hierarchy" })).toBeNull();
    expect(screen.getAllByRole("tree")).toHaveLength(1);
  });

  it("shows an empty state when there is no hierarchy", async () => {
    // AC-9. A file with no subClassOf and no broader says so rather than drawing
    // an empty tree.
    renderView(hierarchyOf(EMPTY, EMPTY));

    await waitFor(() =>
      expect(document.querySelector(".hierarchy-status")?.textContent).toMatch(
        /declares no/i,
      ),
    );
    expect(items()).toHaveLength(0);
  });

  it("opens collapsed to its roots", async () => {
    // AC-7. Only the roots are shown; a newcomer meets a short list, not a wall.
    renderView(mixed());

    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    // Alpha and Scheme (the two roots); their children are not rendered.
    expect(itemByLabel("Alpha")).toBeTruthy();
    expect(itemByLabel("Scheme")).toBeTruthy();
    expect(itemByLabel("Beta")).toBeUndefined();
    expect(itemByLabel("Water")).toBeUndefined();
    // A collapsed branch reports its state and its child count.
    expect(itemByLabel("Alpha")!.getAttribute("aria-expanded")).toBe("false");
    expect(itemByLabel("Alpha")!.querySelector(".hierarchy-count")?.textContent).toBe("1");
  });

  it("expand and collapse reveals and hides direct children", async () => {
    // AC-6. The triangle toggles; the child appears and disappears.
    renderView(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());

    const twistie = itemByLabel("Alpha")!.querySelector<HTMLElement>(".hierarchy-twistie")!;
    await act(async () => fireEvent.click(twistie));
    expect(itemByLabel("Beta")).toBeTruthy();
    expect(itemByLabel("Alpha")!.getAttribute("aria-expanded")).toBe("true");

    await act(async () => fireEvent.click(itemByLabel("Alpha")!.querySelector(".hierarchy-twistie")!));
    expect(itemByLabel("Beta")).toBeUndefined();
  });

  it("filter narrows to matches and their ancestors", async () => {
    // AC-8. Filtering for a leaf keeps the leaf and the path to it, and the
    // section with no match says so — with the tree unchanged when it clears.
    renderView(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());

    const filter = screen.getByRole("searchbox", { name: /filter the hierarchy/i });
    await act(async () => fireEvent.change(filter, { target: { value: "Beta" } }));

    // Beta matches; Alpha is kept as its ancestor and auto-expanded.
    expect(itemByLabel("Beta")).toBeTruthy();
    expect(itemByLabel("Alpha")).toBeTruthy();
    // The concept section has no match.
    expect(itemByLabel("Scheme")).toBeUndefined();
    const conceptTree = screen.getByRole("heading", { name: "Concept hierarchy" }).parentElement!;
    expect(conceptTree.textContent).toMatch(/no matches/i);

    // Clearing restores the collapsed tree unchanged.
    await act(async () => fireEvent.change(filter, { target: { value: "" } }));
    expect(itemByLabel("Beta")).toBeUndefined();
    expect(itemByLabel("Scheme")).toBeTruthy();
  });

  it("carries role, aria-expanded, aria-level and aria-selected", async () => {
    // AC-12. The tree's ARIA is what makes it the graph's accessible equivalent.
    renderView(mixed(), vi.fn(), EX + "Alpha");
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());

    const alpha = itemByLabel("Alpha")!;
    expect(alpha.getAttribute("role")).toBe("treeitem");
    expect(alpha.getAttribute("aria-level")).toBe("1");
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    // Selected because it is the shared selection passed in.
    expect(alpha.getAttribute("aria-selected")).toBe("true");

    // A child is one level deeper once revealed.
    await act(async () => fireEvent.click(alpha.querySelector(".hierarchy-twistie")!));
    expect(itemByLabel("Beta")!.getAttribute("aria-level")).toBe("2");
    // A leaf carries no aria-expanded (there is nothing to expand).
    expect(itemByLabel("Beta")!.getAttribute("aria-expanded")).toBeNull();
  });

  it("is operable from the keyboard: arrows move, right expands, left collapses, enter selects", async () => {
    // AC-12. The whole tree from one tab stop.
    const classes = forestOf(
      {
        [EX + "Alpha"]: node("Alpha", "class", true),
        [EX + "Beta"]: node("Beta", "class"),
        [EX + "Gamma"]: node("Gamma", "class"),
      },
      { [EX + "Alpha"]: [EX + "Beta"] },
      [EX + "Alpha", EX + "Gamma"],
    );
    const { onSelect } = renderView(hierarchyOf(classes, EMPTY));
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());

    const tree = screen.getByRole("tree");
    // The first root is the roving tab stop.
    await waitFor(() => expect(itemByLabel("Alpha")!.getAttribute("tabindex")).toBe("0"));

    // Right expands the collapsed root.
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(itemByLabel("Beta")).toBeTruthy());
    expect(itemByLabel("Alpha")!.getAttribute("aria-expanded")).toBe("true");

    // Down moves onto the revealed child and focuses it.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(itemByLabel("Beta")));

    // Left from a leaf steps back to the parent.
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(itemByLabel("Alpha")));
    // Left again collapses it.
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    await waitFor(() => expect(itemByLabel("Beta")).toBeUndefined());

    // Enter selects the focused node through the shared handler.
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(EX + "Alpha");
  });

  it("selecting a row calls the shared selection handler", async () => {
    // AC-13 at the component. A click is the ordinary route.
    const { onSelect } = renderView(mixed());
    await waitFor(() => expect(itemByLabel("Scheme")).toBeTruthy());

    await act(async () => fireEvent.click(itemByLabel("Scheme")!));
    expect(onSelect).toHaveBeenCalledWith(EX + "Scheme");
  });

  it("virtualizes: DOM rows stay bounded regardless of tree size", async () => {
    // AC-11, the row Section 10 calls load-bearing. A 4,000-child tree fully
    // expanded is a handful of rows in the DOM, not 4,000. A mutation that
    // renders every row instead of the window turns this red.
    const nodes: Record<string, ReturnType<typeof node>> = {
      [EX + "Root"]: node("Root", "class", true),
    };
    const kids: string[] = [];
    for (let i = 0; i < 4000; i++) {
      nodes[EX + "n" + i] = node("n" + i, "class");
      kids.push(EX + "n" + i);
    }
    const classes = forestOf(nodes, { [EX + "Root"]: kids }, [EX + "Root"]);
    renderView(hierarchyOf(classes, EMPTY));
    await waitFor(() => expect(itemByLabel("Root")).toBeTruthy());

    // Expand everything.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /expand all/i })));

    // 4,001 rows exist logically; the DOM holds only the virtual window.
    await waitFor(() => expect(items().length).toBeGreaterThan(1));
    expect(items().length).toBeLessThan(60);
  });

  it("renders property forests as their own labelled sections", async () => {
    // AC-17 (frontend). object / datatype / annotation subPropertyOf forests
    // render beside the class and concept trees, each only when present.
    const classes = forestOf(
      { [EX + "Alpha"]: node("Alpha", "class") },
      {},
      [EX + "Alpha"],
    );
    const objectProperties = forestOf(
      {
        [EX + "hasRelative"]: node("hasRelative", "objectProperty", true),
        [EX + "hasParent"]: node("hasParent", "objectProperty"),
      },
      { [EX + "hasRelative"]: [EX + "hasParent"] },
      [EX + "hasRelative"],
    );
    const annotationProperties = forestOf(
      { [EX + "note"]: node("note", "annotationProperty") },
      {},
      [EX + "note"],
    );
    const hierarchy: Hierarchy = {
      classes,
      concepts: EMPTY,
      objectProperties,
      annotationProperties,
      counts: { classes: 1, concepts: 0, objectProperties: 2, annotationProperties: 1 },
      truncated: false,
    };
    renderView(hierarchy);

    await screen.findByRole("heading", { name: "Class hierarchy" });
    expect(screen.getByRole("heading", { name: "Object properties" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Annotation properties" })).toBeTruthy();
    // No datatype forest in the payload, so no datatype section.
    expect(screen.queryByRole("heading", { name: "Datatype properties" })).toBeNull();
    // The object-property root is a branch and expand-all opens it.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /expand all/i })));
    expect(itemByLabel("hasParent")).toBeTruthy();
  });

  it("renders an inferred edge as derived with no code change", async () => {
    // AC-14. The D-046 seam: a synthetic origin:"inferred" edge lights up the
    // derived badge, a non-colour cue and an aria mention, proving the asserted-
    // only build reserves the channel for inference without rework.
    const classes = forestOf(
      {
        [EX + "Alpha"]: node("Alpha", "class", true),
        [EX + "Derived"]: node("Derived", "class"),
      },
      { [EX + "Alpha"]: [EX + "Derived"] },
      [EX + "Alpha"],
      new Set([`${EX + "Alpha"}->${EX + "Derived"}`]),
    );
    renderView(hierarchyOf(classes, EMPTY));
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());

    await act(async () => fireEvent.click(itemByLabel("Alpha")!.querySelector(".hierarchy-twistie")!));

    const derived = itemByLabel("Derived")!;
    // A visible badge, a non-colour cue (the inferred class → dashed border in
    // CSS), and an aria mention that it is derived.
    expect(within(derived).getByText("inferred")).toBeTruthy();
    expect(derived.classList.contains("inferred")).toBe(true);
    expect(derived.querySelector('[aria-label="inferred, derived"]')).toBeTruthy();
  });
});

describe("HierarchyView imports (external-access Stage 2)", () => {
  it("names the import an imported row comes from, in text (AC-21)", async () => {
    const classes: HierarchyForest = {
      nodes: {
        [EX + "Agent"]: { ...node("Agent", "class", true), importedFrom: "FOAF" },
        [EX + "Student"]: node("Student"),
      },
      children: { [EX + "Agent"]: [{ id: EX + "Student", origin: "asserted" }] },
      roots: [EX + "Agent"],
    };
    renderView(hierarchyOf(classes, EMPTY));
    await screen.findByText("Agent");
    expect(itemByLabel("Agent")?.textContent).toContain("from FOAF");
    fireEvent.click(itemByLabel("Agent")!.querySelector(".hierarchy-twistie")!);
    expect(itemByLabel("Student")?.textContent).not.toContain("from");
  });

  it("fetches the merged forests only when told to", async () => {
    fetchHierarchy.mockResolvedValue(mixed());
    render(<HierarchyView ontologyId="o1" theme="dark" selected={null} onSelect={vi.fn()} imports />);
    await screen.findByText("Alpha");
    expect(fetchHierarchy).toHaveBeenCalledWith("o1", true);
  });
});

describe("HierarchyView in a project (visual-modeling 5.2, AC-5)", () => {
  const PID = "prj-0123456789ab";
  const STATE = {
    doc: "model" as const,
    ontologyId: `${PID}-model`,
    revision: 2,
    dirty: true,
    canUndo: true,
    undoLabel: "x",
    canRedo: false,
    redoLabel: null,
    triples: 10,
  };

  beforeEach(async () => {
    projectStore._reset();
    for (const mock of [openProject, runCommand, previewDelete]) mock.mockReset();
    openProject.mockResolvedValue({
      project: {
        id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "ex",
        primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {},
      },
      documents: [STATE],
      recovery: { available: false, draftTime: null },
    });
    await projectStore.open(PID);
    runCommand.mockImplementation(async (_p, _d, command: string) => ({ revision: 3, label: command, state: STATE }));
  });

  afterEach(() => projectStore._reset());

  function renderProject(hierarchy: Hierarchy, onSelect = vi.fn(), onDeleted = vi.fn()) {
    fetchHierarchy.mockResolvedValue(hierarchy);
    render(
      <HierarchyView
        ontologyId="o1"
        theme="dark"
        selected={null}
        onSelect={onSelect}
        editing={{ primaryLanguage: "en" }}
        onDeleted={onDeleted}
      />,
    );
    return { onSelect, onDeleted };
  }

  // The row's button is for the pointer and hidden from assistive
  // technology, so it is found by its class and checked by its label.
  const menuOf = (label: string) => {
    const button = itemByLabel(label)!.querySelector<HTMLElement>(".hierarchy-menu-btn")!;
    expect(button.getAttribute("aria-label")).toBe(`More actions for ${label}`);
    return button;
  };

  it("offers nothing to change outside a project", async () => {
    renderView(mixed());
    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: "New class" })).toBeNull();
    expect(document.querySelector(".hierarchy-menu-btn")).toBeNull();
  });

  it("shows New class even on an empty model, and New concept beside the concepts", async () => {
    renderProject(hierarchyOf(EMPTY, EMPTY));
    expect(await screen.findByRole("button", { name: "New class" })).toBeTruthy();
    expect(screen.getByText("No classes yet. New class makes the first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New concept" })).toBeNull();
    document.body.innerHTML = "";

    renderProject(mixed());
    expect(await screen.findByRole("button", { name: "New concept" })).toBeTruthy();
  });

  it("creates a class by name and selects it", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Invoice", state: STATE, created: EX + "Invoice" });
    const { onSelect } = renderProject(mixed());
    fireEvent.click(await screen.findByRole("button", { name: "New class" }));
    const name = screen.getByRole("textbox", { name: "Name (en)" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Invoice" } });
    await act(async () => {
      fireEvent.submit(name.closest("form")!);
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateClass", { label: "Invoice", iri: undefined, parent: undefined });
    expect(onSelect).toHaveBeenCalledWith(EX + "Invoice");
  });

  it("creates a concept in the scheme there is", async () => {
    renderProject(mixed());
    fireEvent.click(await screen.findByRole("button", { name: "New concept" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Ice" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateConcept", { prefLabel: "Ice", iri: undefined, scheme: EX + "Scheme" });
  });

  it("opens the row menu from the keyboard, moves through it, and Escape returns to the row", async () => {
    renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    const row = itemByLabel("Alpha")!;
    // The row names its shortcut, and its name is not swollen by the button's.
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Shift+F10");
    expect(row.querySelector(".hierarchy-menu-btn")!.getAttribute("aria-hidden")).toBe("true");
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "More actions for Alpha" });
    const entries = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    expect(entries).toEqual(["Add subclass", "Rename", "Delete…"]);
    expect(document.activeElement?.textContent).toBe("Add subclass");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Rename");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Delete…");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(itemByLabel("Alpha")));
  });

  it("offers Add narrower concept on a concept, and the row's button opens the same menu", async () => {
    renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Scheme")).toBeTruthy());
    fireEvent.click(itemByLabel("Scheme")!.querySelector(".hierarchy-twistie")!);
    await waitFor(() => expect(itemByLabel("Water")).toBeTruthy());
    const button = menuOf("Water");
    expect(button.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Add narrower concept",
      "Rename",
      "Delete…",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add narrower concept" }));
    expect(screen.getByText("New narrower concept of Water")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Ice" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateConcept", { prefLabel: "Ice", iri: undefined, broader: EX + "Water" });
  });

  it("adds a subclass from the menu under that class", async () => {
    renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    fireEvent.click(menuOf("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add subclass" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Delta" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateClass", { label: "Delta", iri: undefined, parent: EX + "Alpha" });
  });

  it("renames in place in the primary language; Escape cancels and sends nothing", async () => {
    renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    fireEvent.click(menuOf("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    let field = screen.getByRole("textbox", { name: "New name for Alpha" }) as HTMLInputElement;
    expect(field.value).toBe("Alpha");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "New name for Alpha" })).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();

    fireEvent.click(menuOf("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    field = screen.getByRole("textbox", { name: "New name for Alpha" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "First" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "SetLabel", { iri: EX + "Alpha", value: "First", lang: "en" });
  });

  it("treats Enter on an unchanged name as a cancel (found in review)", async () => {
    renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    fireEvent.click(menuOf("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "New name for Alpha" });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "New name for Alpha" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes from the menu only after the impact is confirmed", async () => {
    previewDelete.mockResolvedValue({
      dryRun: true,
      revision: 2,
      impact: {
        iri: EX + "Alpha", label: "Alpha", kind: "class", statements: 4, strategy: "reparent",
        children: [{ iri: EX + "Beta", label: "Beta" }], reparentedTo: [], properties: [], individuals: [], importMentions: 0,
      },
    });
    const { onDeleted } = renderProject(mixed());
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    fireEvent.click(menuOf("Alpha"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Delete Alpha?" });
    // One child is "it" (5.8 item 7).
    expect(within(dialog).getByRole("radio", { name: "Move it up to the top level" })).toBeTruthy();
    expect(runCommand).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "DeleteEntity", { iri: EX + "Alpha", strategy: "reparent" });
    expect(onDeleted).toHaveBeenCalledWith(EX + "Alpha");
  });

  it("offers only Add subclass on an imported class, and no menu on other imported rows", async () => {
    const classes: HierarchyForest = {
      nodes: { [EX + "Agent"]: { ...node("Agent"), importedFrom: "FOAF" } },
      children: {},
      roots: [EX + "Agent"],
    };
    const concepts: HierarchyForest = {
      nodes: { [EX + "Topic"]: { ...node("Topic", "concept"), importedFrom: "SKOS" } },
      children: {},
      roots: [EX + "Topic"],
    };
    renderProject(hierarchyOf(classes, concepts));
    await waitFor(() => expect(itemByLabel("Agent")).toBeTruthy());
    expect(itemByLabel("Topic")!.querySelector(".hierarchy-menu-btn")).toBeNull();
    fireEvent.click(menuOf("Agent"));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Add subclass"]);
  });
});

describe("HierarchyView, Stage 2 follow-ups (visual-modeling 5.8)", () => {
  const PID = "prj-0123456789ab";
  const STATE = {
    doc: "model" as const, ontologyId: `${PID}-model`, revision: 2, dirty: true,
    canUndo: true, undoLabel: "x", canRedo: false, redoLabel: null, triples: 10,
  };

  beforeEach(async () => {
    projectStore._reset();
    for (const mock of [openProject, runCommand]) mock.mockReset();
    openProject.mockResolvedValue({
      project: {
        id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "ex",
        primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {},
      },
      documents: [STATE],
      recovery: { available: false, draftTime: null },
    });
    await projectStore.open(PID);
  });

  afterEach(() => projectStore._reset());

  const view = (props: Partial<React.ComponentProps<typeof HierarchyView>> = {}) => (
    <HierarchyView
      ontologyId="o1"
      theme="dark"
      selected={null}
      onSelect={vi.fn()}
      editing={{ primaryLanguage: "en" }}
      {...props}
    />
  );

  it("item 1: a create in flight shows the view busy", async () => {
    let finish: (value: unknown) => void = () => {};
    runCommand.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fetchHierarchy.mockResolvedValue(mixed());
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "New class" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Late" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(document.querySelector(".hierarchy-view .edit-status")!.textContent).toBe("Saving change…");
    await act(async () => finish({ revision: 3, label: "Created", state: STATE }));
    expect(document.querySelector(".hierarchy-view .edit-status")!.textContent).toBe("");
  });

  it("item 4: a create does not select the new entity once the selection moved", async () => {
    let finish: (value: unknown) => void = () => {};
    runCommand.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fetchHierarchy.mockResolvedValue(mixed());
    const onSelect = vi.fn();
    const { rerender } = render(view({ onSelect }));
    fireEvent.click(await screen.findByRole("button", { name: "New class" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Late" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    rerender(view({ onSelect, selected: EX + "Alpha" }));
    await act(async () => finish({ revision: 3, label: "Created", state: STATE, created: EX + "Late" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("item 6: the tree's forms and menu close when the document changes", async () => {
    fetchHierarchy.mockResolvedValue(mixed());
    const { rerender } = render(view());
    fireEvent.click(await screen.findByRole("button", { name: "New class" }));
    expect(screen.getByRole("textbox", { name: "Name (en)" })).toBeTruthy();
    await act(async () => {
      rerender(view({ ontologyId: "o2" }));
    });
    expect(screen.queryByRole("textbox", { name: "Name (en)" })).toBeNull();
  });

  it("5.6: past 300 boxes the row menu offers Show on canvas and Hide from canvas", async () => {
    fetchHierarchy.mockResolvedValue(mixed());
    const show = vi.fn();
    render(view({ canvas: { limited: true, shown: [], show, hide: vi.fn() } }));
    await waitFor(() => expect(itemByLabel("Alpha")).toBeTruthy());
    fireEvent.click(itemByLabel("Alpha")!.querySelector(".hierarchy-menu-btn")!);
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Add subclass", "Rename", "Delete…", "Show on canvas",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show on canvas" }));
    expect(show).toHaveBeenCalledWith(EX + "Alpha");
  });

  it("5.4: the Canvas switch is a pressed-state button in the toolbar", async () => {
    fetchHierarchy.mockResolvedValue(mixed());
    const onToggle = vi.fn();
    render(view({ canvasSwitch: { on: true, onToggle } }));
    const toggle = await screen.findByRole("button", { name: "Canvas" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });
});

