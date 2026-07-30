// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ExploreStart.test.tsx
================================================================================

SUMMARY
    The first test for ExploreStart: what the starting panel shows, what it shows
    while the graph loads, what activating a suggestion does, the four
    accessibility properties the specification requires of it, and the two
    performance rows.

BASIC IDEA
    ExploreStart is a function of its props, so most cases are a render and an
    assertion. Two rows are not, and both are worth explaining.

    The memoization row is a claim about how often the ranking runs, which is not
    visible in the DOM. The suggestions module is therefore mocked with wrappers
    that count calls and delegate to the real implementation, and the panel is
    re-rendered with an unchanged graph. Deleting the useMemo in ExploreStart
    makes this row fail, which was checked — the point of the row is that a
    40,000-node ranking must not run on every hover that re-renders App.

    The focus row spans two components, because the requirement does: activating
    a suggestion replaces this panel with DetailPanel, and focus has to land on
    the heading of the panel that arrived. A small harness renders whichever of
    the two the selection calls for, exactly as App does, so what is asserted is
    the real mechanism rather than a mock of it.

INPUTS / INPUT SOURCES
    - Constructed VizGraph objects.
    - A mocked api.ts, for the harness's DetailPanel only.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1, AC-8 to AC-13 of
      explore-mode-starting-point.
================================================================================
*/

import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DetailPanel from "./DetailPanel";
import ExploreStart from "./ExploreStart";
import type { VizGraph, VizNode } from "../types";

/** Call counts for the two pure functions, for the memoization row. */
const counts = vi.hoisted(() => ({ ranking: 0, summary: 0 }));

// Wrapped, not replaced: every other test in this file wants the real ranking,
// and a stub would make them assert on a fixture rather than on the rule.
vi.mock("../explore/suggestions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../explore/suggestions")>();
  return {
    suggestedEntities: (...args: Parameters<typeof actual.suggestedEntities>) => {
      counts.ranking += 1;
      return actual.suggestedEntities(...args);
    },
    describeContents: (...args: Parameters<typeof actual.describeContents>) => {
      counts.summary += 1;
      return actual.describeContents(...args);
    },
  };
});

const getNodeDetails = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ getNodeDetails }));

function node(id: string, label: string, kind: string, degree: number): VizNode {
  return { id, label, kind, degree };
}

/** The panel's example ontology: three kinds, descending degrees. */
const NODES: VizNode[] = [
  node("http://x/FinancialInstrument", "Financial Instrument", "class", 214),
  node("http://x/isIssuedBy", "is issued by", "objectProperty", 189),
  node("http://x/NYSE", "New York Stock Exchange", "individual", 143),
  node("http://x/Security", "Security", "class", 96),
];

function graphOf(nodes: VizNode[], kindCounts?: Record<string, number>): VizGraph {
  const counted: Record<string, number> = {};
  for (const n of nodes) counted[n.kind] = (counted[n.kind] ?? 0) + 1;
  return {
    nodes,
    edges: [],
    stats: {
      nodeCount: nodes.length,
      edgeCount: 0,
      nodeTotal: nodes.length,
      edgeTotal: 0,
      truncated: false,
      budget: 2000,
      kindCounts: kindCounts ?? counted,
    },
  };
}

function renderPanel(
  graph: VizGraph | null,
  { loading = false } = {},
): { onSelect: (iri: string) => void } {
  const onSelect = vi.fn();
  render(<ExploreStart graph={graph} loading={loading} theme="dark" onSelect={onSelect} />);
  return { onSelect };
}

/** The suggestion rows, in document order. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".explore-start .starter"));
}

/**
 * The Explore column as App assembles it: whichever of the two panels the
 * selection calls for, with the focus flag travelling with the selection. Two
 * tests below need both halves, because both requirements span them.
 */
function Column({ graph = graphOf(NODES) }: { graph?: VizGraph }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [focusPanel, setFocusPanel] = useState(false);
  const select = (iri: string, panelTakesFocus: boolean) => {
    setSelected(iri);
    setFocusPanel(panelTakesFocus);
  };
  return selected === null ? (
    <>
      <ExploreStart
        graph={graph}
        loading={false}
        theme="dark"
        onSelect={(iri) => select(iri, true)}
      />
      {/* Stands in for a graph click, which selects without asking for focus. */}
      <button onClick={() => select("http://x/NYSE", false)}>graph click</button>
    </>
  ) : (
    <DetailPanel
      ontologyId="o1"
      iri={selected}
      onNavigate={(iri) => select(iri, false)}
      onClose={() => setSelected(null)}
      focusHeading={focusPanel}
    />
  );
}

beforeEach(() => {
  counts.ranking = 0;
  counts.summary = 0;
  getNodeDetails.mockReset();
  getNodeDetails.mockResolvedValue({
    iri: "http://x/FinancialInstrument",
    prefixed: "x:FinancialInstrument",
    label: "Financial Instrument",
    outgoing: [],
    incoming: [],
    outgoingTotal: 0,
    incomingTotal: 0,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExploreStart", () => {
  it("shows the panel when nothing is selected", () => {
    // AC-1. The whole feature: this column used to render nothing at all, so
    // the first assertion is that the panel exists, and the rest is what it says
    // — the contents sentence, the offer, and the three ways to select.
    renderPanel(graphOf(NODES));

    const panel = screen.getByRole("complementary", { name: "Explore" });
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain(
      "This ontology describes 2 classes, 1 individual and 1 object property.",
    );
    expect(screen.getByRole("heading", { name: /start with one of these/i })).toBeTruthy();
    expect(rows()).toHaveLength(4);
    // Highest degree first, and the label is the entity's own, not its IRI.
    expect(rows()[0].textContent).toContain("Financial Instrument");
    // The hint names all three routes, because two of them are not this panel.
    expect(panel.textContent).toMatch(/click any node in the graph, or search/i);
  });

  it("shows loading while the graph is loading", () => {
    // AC-9. No suggestions from a partial graph, and the panel keeps its place
    // in the layout rather than appearing once the graph arrives.
    renderPanel(null, { loading: true });

    expect(screen.getByRole("complementary", { name: "Explore" }).textContent).toContain(
      "Loading…",
    );
    expect(rows()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: /start with one of these/i })).toBeNull();
  });

  it("says an ontology has nothing to display when it has nothing", () => {
    // AC-8 at the panel. The summary sentence stands alone: no heading over an
    // empty list, and no crash. Reachable with a file of only blank nodes.
    renderPanel(graphOf([]));

    const panel = screen.getByRole("complementary", { name: "Explore" });
    expect(panel.textContent).toContain("This ontology has no entities to display.");
    expect(screen.queryByRole("heading", { name: /start with one of these/i })).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("renders nothing when the graph failed to load", () => {
    // Section 6's state table: the error bar carries the failure, and the panel
    // shows nothing rather than a confident summary of an unread ontology.
    renderPanel(null);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("clicking a suggestion selects that entity", () => {
    // AC-10. The IRI, not the label: the label is not unique and is not what the
    // detail panel fetches by.
    const { onSelect } = renderPanel(graphOf(NODES));

    fireEvent.click(rows()[0]);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("http://x/FinancialInstrument");
  });

  it("renders the kind as text on every row", () => {
    // AC-11. This is what makes the coloured dot decorative. The words are the
    // legend's own, from KIND_LABELS, so the panel and the legend agree.
    renderPanel(graphOf(NODES));

    expect(rows()[0].textContent).toContain("Class");
    expect(rows()[1].textContent).toContain("Object property");
    expect(rows()[2].textContent).toContain("Individual");
    // The connection count is text too, and singular when it is one. A second
    // panel in the same body would leave two sets of rows to count, so the
    // first one goes first.
    expect(rows()[0].textContent).toContain("214 connections");
    document.body.innerHTML = "";
    renderPanel(graphOf([node("http://x/One", "Lonely", "class", 1)]));
    expect(rows()[0].textContent).toContain("1 connection");
  });

  it("colour dots are hidden from assistive technology", () => {
    // AC-11. Every dot, not just the first: one unhidden swatch would read as a
    // stray graphic in the middle of the row's name.
    renderPanel(graphOf(NODES));

    const dots = document.querySelectorAll(".explore-start .dot");
    expect(dots).toHaveLength(4);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("every suggestion is a button in tab order with visible focus", () => {
    // AC-11. A div with an onClick would satisfy the design and fail this. The
    // ring itself is the global :focus-visible rule, which focus-visible.test.ts
    // asserts exists and that nothing suppresses; there is no per-component
    // focus rule here and there should not be one.
    renderPanel(graphOf(NODES));

    for (const row of rows()) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("tabindex")).toBeNull();
      row.focus();
      expect(document.activeElement).toBe(row);
    }
    // Each row's accessible name is its whole content, so a screen reader reads
    // the entity, its kind and its connection count as one name.
    expect(
      screen.getByRole("button", { name: /Financial Instrument.*Class.*214 connections/ }),
    ).toBeTruthy();
  });

  it("selecting a suggestion moves focus to the detail heading", async () => {
    // AC-12. The row that had focus is the element being replaced, so focus has
    // to go somewhere deliberate. This spans both components because the
    // requirement does — see the note at the top of this file.
    await act(async () => {
      render(<Column />);
    });
    rows()[0].focus();

    await act(async () => {
      fireEvent.click(rows()[0]);
    });

    const heading = screen.getByRole("heading", { level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(heading.textContent).toBe("Financial Instrument");
    // And the heading names the panel it belongs to, rather than being an
    // unlabelled region a screen reader user has just been dropped into.
    expect(screen.getByRole("complementary").getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("a selection made another way does not move focus", async () => {
    // Not in the spec's test plan; it is here because the first implementation
    // got it wrong. Focus following the selection is right for a suggestion and
    // wrong for everything else — a graph click is made with the pointer,
    // somewhere else entirely, and taking focus from it would be a defect rather
    // than a courtesy. A counter that only ever incremented passed the row above
    // and failed this one.
    await act(async () => {
      render(<Column />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "graph click" }));
    });

    expect(document.querySelector(".detail-panel")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("ExploreStart budgets", () => {
  /** A graph whose eight suggestions all come out of a realistic ranking. */
  function eightSuggestions(): VizGraph {
    const kinds = ["class", "objectProperty", "individual", "concept"];
    return graphOf(
      Array.from({ length: 40 }, (_, i) =>
        node(`http://x/e${i}`, `Entity ${i}`, kinds[i % kinds.length], 400 - i),
      ),
    );
  }

  it("renders within budget", () => {
    // AC-13. 20 ms for eight rows. The warm-up render is discarded, because the
    // first render in the process pays module initialisation and React's first
    // reconciliation — the trap D-021 records, met again here.
    //
    // Measured on Windows/jsdom 2026-07-30: 1.0–1.6 ms, so this has roughly ten
    // times the headroom the detail panel's absolute budget had before D-021
    // replaced it with a ratio. If it ever fails on a slower machine, read that
    // entry before raising the number.
    const graph = eightSuggestions();
    const { unmount } = render(
      <ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />,
    );
    unmount();

    const samples = [0, 0, 0].map(() => {
      const started = performance.now();
      const view = render(
        <ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />,
      );
      const elapsed = performance.now() - started;
      view.unmount();
      return elapsed;
    });
    const median = samples.sort((a, b) => a - b)[1];

    // Asserted so a render that drew nothing cannot pass on being fast.
    render(<ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />);
    expect(rows()).toHaveLength(8);
    expect(median).toBeLessThan(20);
  });

  it("memoizes the ranking across re-renders", () => {
    // AC-13, and the row that matters in practice. App re-renders on a hover;
    // the ranking is a pass over every node in the ontology. Both must be keyed
    // on the graph, so an unchanged graph costs nothing.
    const graph = eightSuggestions();
    const { rerender } = render(
      <ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />,
    );
    expect(counts.ranking).toBe(1);
    expect(counts.summary).toBe(1);

    // Three more renders with the same graph, one of them with a different
    // callback identity — which is what App hands over on an unrelated state
    // change, and must not be mistaken for new data.
    rerender(<ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />);
    rerender(<ExploreStart graph={graph} loading={false} theme="dark" onSelect={() => {}} />);
    rerender(<ExploreStart graph={graph} loading={false} theme="light" onSelect={() => {}} />);

    expect(counts.ranking).toBe(1);
    expect(counts.summary).toBe(1);

    // A new graph does recompute, once. A memo keyed on nothing would pass the
    // assertions above and fail the user.
    rerender(
      <ExploreStart graph={eightSuggestions()} loading={false} theme="dark" onSelect={() => {}} />,
    );
    expect(counts.ranking).toBe(2);
    expect(counts.summary).toBe(2);
  });
});
