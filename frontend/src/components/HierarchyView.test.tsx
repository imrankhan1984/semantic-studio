// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/HierarchyView.test.tsx
================================================================================

SUMMARY
    The first test for HierarchyView: the two labelled sections, collapsed-to-
    roots default, expand/collapse, the filter that keeps ancestors, the
    virtualization that bounds the DOM regardless of tree size, the keyboard tree
    operation and its ARIA, and the reserved "inferred" rendering channel proven
    by a synthetic derived edge.

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
    - A mocked api.ts (fetchHierarchy only; ApiError stays real).

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6 to AC-9, AC-11, AC-12 and AC-14 of
      hierarchy-view.md.
================================================================================
*/

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HierarchyView from "./HierarchyView";
import type { Hierarchy, HierarchyForest } from "../types";

const fetchHierarchy = vi.hoisted(() => vi.fn());
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, fetchHierarchy };
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
