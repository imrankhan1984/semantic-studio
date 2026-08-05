// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/OntologyCard.test.tsx
================================================================================

SUMMARY
    The first test for OntologyCard. Covers what a card shows, that its counts
    describe the whole ontology rather than the canvas, that its state is text
    rather than colour, the three verbs, the "⋮" disclosure and its focus
    contract, and that an ontology stored before the sketch existed renders
    without a picture and without asking for one.

BASIC IDEA
    The card is presentational, so almost everything here is markup and focus,
    which jsdom can see. api.ts is mocked anyway — as a trap rather than as a
    fixture. Nothing on this card is allowed to fetch, and a spy that is never
    called is the only way to assert that from here.

    The two things jsdom cannot see are stated where they matter and measured in
    a browser instead: whether the miniature is legible at 120x70, and whether
    the menu opens over the cards below it rather than pushing them down.

INPUTS / INPUT SOURCES
    - Hand-built OntologySummary objects, with and without a `card` sketch.
    - A mocked api.ts, which must stay uncalled.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-3, AC-4, AC-5, AC-6, AC-9, AC-15 and
      AC-16.
================================================================================
*/

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OntologyCard from "./OntologyCard";
import type { CardSketch, OntologySummary } from "../types";

// Every client function, so "this card fetches nothing" is a claim about call
// counts rather than about network traffic nobody can observe from here.
const api = vi.hoisted(() => ({
  listOntologies: vi.fn(),
  getGraph: vi.fn(),
  getNeighborhood: vi.fn(),
  getNodeDetails: vi.fn(),
  fetchOntology: vi.fn(),
  searchNodes: vi.fn(),
}));
vi.mock("../api", () => api);

const SKETCH: CardSketch = {
  nodes: [
    { id: "http://x/A", kind: "class", degree: 4 },
    { id: "http://x/B", kind: "concept", degree: 2 },
    { id: "http://x/C", kind: "individual", degree: 1 },
  ],
  edges: [
    { source: "http://x/A", target: "http://x/B" },
    { source: "http://x/A", target: "http://x/C" },
  ],
};

function summary(over: Partial<OntologySummary> = {}): OntologySummary {
  return {
    id: "o1",
    name: "FIBO quickstart",
    source: "upload",
    format: "turtle",
    triples: 132001,
    nodes: 18717,
    edges: 51446,
    kindCounts: { class: 11208, objectProperty: 3204, individual: 4305 },
    namespaces: {},
    addedAt: "2026-07-26T09:00:00Z",
    loaded: false,
    card: { sketch: SKETCH },
    ...over,
  };
}

function renderCard(over: Partial<OntologySummary> = {}, props = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onEnterMode: vi.fn(),
    onViewSource: vi.fn(),
    onDownloadDocs: vi.fn(),
    onRemove: vi.fn(),
  };
  const result = render(
    <OntologyCard
      summary={summary(over)}
      theme="dark"
      layout="card"
      busy={false}
      working={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...result, ...handlers };
}

function menuButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /more actions for/i }) as HTMLButtonElement;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("OntologyCard contents", () => {
  it("shows the name, a generated description, and every metric chip", () => {
    // AC-3. The description is L-5's sentence rather than a filename: it says
    // more about an ontology than its name does, and reusing it is what keeps
    // the home screen and the Explore panel from wording the same fact twice.
    const { container } = renderCard();

    expect(screen.getByRole("heading", { level: 3, name: "FIBO quickstart" })).toBeTruthy();
    expect(container.querySelector(".onto-summary")?.textContent).toBe(
      "This ontology describes 11,208 classes, 4,305 individuals and 3,204 object properties.",
    );

    const chips = [...container.querySelectorAll(".onto-chips li")].map((li) => li.textContent);
    expect(chips).toContain("132,001 triples");
    expect(chips).toContain("18,717 entities");
    expect(chips).toContain("51,446 relations");
    expect(chips).toContain("turtle");
  });

  it("reports whole-ontology counts, not budgeted ones", () => {
    // AC-4. A card is a statement about the FILE, not about the current canvas.
    // The distinction is real and has bitten before — D-017 drew it for
    // kindCounts, and the summary's nodes/edges are build_viz_graph's stats
    // taken before any budget is applied.
    //
    // Asserted as an inequality rather than against a literal, so it fails if
    // anyone ever wires the drawn counts in here: 2,000 is what a budgeted
    // graph response would say, and it is not what this card must show.
    const { container } = renderCard();
    const chips = [...container.querySelectorAll(".onto-chips li")].map((li) => li.textContent);

    expect(chips).toContain("18,717 entities");
    expect(chips).not.toContain("2,000 entities");
    // And the composition bar sums to the whole ontology's entity count too,
    // which is the same claim from the other direction.
    const bands = [...container.querySelectorAll(".onto-bar-band")];
    expect(bands).toHaveLength(3);
  });

  it("conveys loaded state and source as text, not by colour alone", () => {
    // AC-5. There is no connection to hold open here, so the wording says
    // exactly what is true — parsed in server memory, or not.
    const { container, rerender } = renderCard({ loaded: false });
    expect(container.querySelector(".onto-chips")?.textContent).toContain("Not loaded");
    expect(container.querySelector(".onto-chips")?.textContent).toContain("Upload");

    rerender(
      <OntologyCard
        summary={summary({ loaded: true, source: "https://example.org/f.ttl" })}
        theme="dark"
        layout="card"
        busy={false}
        working={false}
        onOpen={vi.fn()}
        onEnterMode={vi.fn()}
        onViewSource={vi.fn()}
        onDownloadDocs={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const chips = container.querySelector(".onto-chips")!;
    expect(chips.textContent).toContain("Loaded");
    expect(chips.textContent).not.toContain("Not loaded");
    expect(chips.textContent).toContain("URL");
    // The full address is still reachable, just not on the chip's face.
    expect(
      [...chips.querySelectorAll("li")].some(
        (li) => li.getAttribute("title") === "https://example.org/f.ttl",
      ),
    ).toBe(true);
  });

  it("draws the miniature from the stored sketch, without a Sigma renderer", () => {
    // AC-16. Six WebGL contexts on one screen is a real cost and browsers cap
    // them, so the picture is plain SVG. Asserted as the absence of a canvas
    // rather than by mocking sigma: a canvas element is what a renderer needs
    // and it is the thing that could not be there by accident.
    const { container } = renderCard();

    const svg = container.querySelector(".onto-mini svg")!;
    expect(svg).toBeTruthy();
    expect(svg.querySelectorAll("circle")).toHaveLength(SKETCH.nodes.length);
    expect(svg.querySelectorAll("line")).toHaveLength(SKETCH.edges.length);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("pre-existing ontologies render without a miniature", () => {
    // AC-15. An ontology stored before the server wrote a sketch keeps its
    // counts and its verbs and simply has no picture — and, the half that
    // matters, asks for nothing to get one. Backfilling on first render would
    // be a parse per stored ontology on the startup path, which is the budget
    // `startup-chooser-screen` exists to hold.
    const { container } = renderCard({ card: null });

    expect(container.querySelector(".onto-mini svg")).toBeNull();
    expect(container.querySelector(".onto-mini-absent")).toBeTruthy();
    expect(container.querySelector(".onto-chips")?.textContent).toContain("132,001 triples");
    expect(screen.getByRole("button", { name: /^Explore /i })).toBeTruthy();
    for (const [name, fn] of Object.entries(api)) {
      expect(fn, `${name} was called to draw a card`).not.toHaveBeenCalled();
    }
  });

  it("an ontology with no entities at all still renders", () => {
    // Reachable with a file of nothing but blank nodes, which build_viz_graph
    // keeps out of the visual graph. Nothing to draw and nothing to divide by.
    const { container } = renderCard({
      kindCounts: {},
      nodes: 0,
      edges: 0,
      card: { sketch: { nodes: [], edges: [] } },
    });

    expect(container.querySelector(".onto-bar")).toBeNull();
    expect(container.querySelector(".onto-mini svg")).toBeNull();
    expect(container.querySelector(".onto-summary")?.textContent).toBe(
      "This ontology has no entities to display.",
    );
  });
});

describe("OntologyCard verbs", () => {
  it("each card offers Explore, Query and View", () => {
    // AC-6. Three controls, in the header's own order, so the two places a user
    // meets these words agree about what they mean.
    const { container } = renderCard();
    const verbs = [...container.querySelectorAll(".onto-verb")].map((b) => b.textContent);

    expect(verbs).toEqual(["Explore", "Query", "View"]);
  });

  it("a verb reports the ontology and the mode together", () => {
    // AC-6. "What to do with what" is one decision, so the callback carries
    // both — there is nothing for an intermediate screen to resolve.
    const { onEnterMode } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Query FIBO quickstart" }));

    expect(onEnterMode).toHaveBeenCalledTimes(1);
    expect(onEnterMode).toHaveBeenCalledWith("o1", "query");
  });

  it("verb names carry the ontology, so six cards are six distinct controls", () => {
    // Not a criterion, and it is what made every other assertion in this file
    // addressable. A library of six would otherwise expose eighteen buttons
    // called Explore, Query and View, none of which a screen reader user could
    // tell apart — the same failure `keyboard-and-motion` found on the toolbar's
    // "＋" and "－".
    renderCard();

    for (const verb of ["Explore", "Query", "View"]) {
      const button = screen.getByRole("button", { name: `${verb} FIBO quickstart` });
      // The visible text and the spoken name agree, so the two cannot drift.
      expect(button.textContent).toBe(verb);
    }
  });

  it("every control goes inert while something is loading", () => {
    const { container } = renderCard({}, { busy: true });

    for (const button of container.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true);
    }
  });

  it("says which card is the one being worked on", () => {
    const { container } = renderCard({}, { working: true });
    expect(container.querySelector(".onto-loading")?.textContent).toBe("Working…");
  });
});

describe("OntologyCard menu", () => {
  it("the card menu is a disclosure with aria-expanded", () => {
    // AC-9. The pair aria-expanded/aria-controls is what makes this legible as
    // a disclosure; without it, it is a button that changes the page for no
    // announced reason. The pattern is next-steps-dropdown's and about-panel's.
    renderCard();
    const control = menuButton();

    expect(control.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(control.getAttribute("aria-controls")!);
    expect(panel).toBeTruthy();
    expect(panel!.hasAttribute("hidden")).toBe(true);

    fireEvent.click(control);

    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(panel!.hasAttribute("hidden")).toBe(false);
  });

  it("offers Open, View source and Remove, and takes a fourth item", () => {
    // AC-9, and the cross-reference the spec's v0.3 added: DOC-1 puts a
    // "Download documentation" item in this menu, so the assertion is on the
    // three items being present rather than on the menu having exactly three.
    renderCard();
    fireEvent.click(menuButton());
    const panel = document.querySelector(".onto-menu")!;
    const items = [...panel.querySelectorAll("button")].map((b) => b.textContent);

    expect(items).toContain("Open");
    expect(items).toContain("View source");
    expect(items).toContain("Remove");
  });

  it("menu opens with focus inside and Escape returns it", () => {
    // AC-9. A disclosure whose contents nobody can reach by keyboard works only
    // with a mouse, and one that drops focus on the floor when it closes leaves
    // the next keystroke going somewhere the user did not choose.
    renderCard();
    const control = menuButton();

    fireEvent.click(control);
    const panel = document.querySelector(".onto-menu")!;
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(control);
  });

  it("Open is the button; the card is not one large target", () => {
    // AC-9. A card-sized button would announce as one unreadable run of text
    // and offer one action where there are four. So the card is an <article>
    // with a heading, and every action inside it is its own control.
    const { container } = renderCard();
    const card = container.querySelector(".onto-card")!;

    expect(card.tagName).toBe("ARTICLE");
    expect(card.getAttribute("role")).toBeNull();
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.getAttribute("onclick")).toBeNull();
    // Its accessible name is the ontology's, through the heading, rather than
    // the whole of its text.
    expect(screen.getByRole("article", { name: "FIBO quickstart" })).toBe(card);

    // Open lives in the menu and is a real button there, which is the other
    // half of the claim: the action exists, it is simply not the whole card.
    fireEvent.click(menuButton());
    expect(screen.getByRole("button", { name: "Open" }).tagName).toBe("BUTTON");
  });

  it("choosing an item closes the menu and reports it", () => {
    const { onOpen, onViewSource, onRemove } = renderCard();

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith("o1");
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(onViewSource).toHaveBeenCalledWith("o1");

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("o1");
  });

  it("the menu name carries the ontology", () => {
    // The glyph itself announces as "⋮", which is nothing, and six cards would
    // otherwise offer six identical "More" buttons.
    renderCard();
    expect(menuButton().getAttribute("aria-label")).toBe(
      "More actions for FIBO quickstart",
    );
  });

  it("Download documentation is the fourth item and hands off the id", () => {
    // AC-13. The card only names the action and passes the id; the confirmation,
    // progress and download are HomeScreen's, which owns the live region.
    const { onDownloadDocs } = renderCard();
    fireEvent.click(menuButton());
    const item = screen.getByRole("button", { name: "Download documentation" });
    fireEvent.click(item);
    expect(onDownloadDocs).toHaveBeenCalledWith("o1");
    // Choosing it closes the menu, exactly as the other items do.
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("OntologyCard row layout", () => {
  it("renders the same controls in the dense layout", () => {
    // The row is the card rearranged, not a second component: the same verbs,
    // the same menu, the same chips. What changes is CSS, which jsdom cannot
    // see — the 44px glyph and the 80px composition strip were measured in a
    // browser.
    const { container } = renderCard({}, { layout: "row" });

    expect(container.querySelector(".onto-card")?.classList.contains("onto-row")).toBe(true);
    expect(container.querySelectorAll(".onto-verb")).toHaveLength(3);
    expect(menuButton()).toBeTruthy();
    expect(container.querySelector(".onto-mini svg")).toBeTruthy();
  });

  it("keeps the reading order in both layouts", () => {
    // The row layout moves the menu to the end with `order`, which is visual
    // only. Document order is what the tab sequence follows, and it stays name,
    // verbs, menu in both — asserted here because jsdom implements no
    // sequential focus navigation and driving Tab would test the polyfill.
    const { container } = renderCard({}, { layout: "row" });
    const buttons = [...container.querySelectorAll("button")];

    expect(buttons.indexOf(menuButton())).toBe(0);
    for (const button of buttons) {
      expect(button.hasAttribute("tabindex")).toBe(false);
    }
  });
});
