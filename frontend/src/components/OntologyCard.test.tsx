// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/OntologyCard.test.tsx
================================================================================

SUMMARY
    The first test for OntologyCard. Covers what a card shows -- since
    home-and-examples 5.6 (AC-8), one sentence and two facts, the statements
    and the date added or *Example* (*Reference* for a reference ontology,
    reference-ontologies 5.2), and *Read-only* in words -- that its
    count describes the whole ontology rather than the canvas, the three
    verbs, the "⋮" disclosure and its focus contract, and that an ontology
    stored before the sketch existed renders without asking for one; since
    home-and-settings 5.2 (AC-3), that no card draws a graph thumbnail and
    every other part of it stays.

BASIC IDEA
    The card is presentational, so almost everything here is markup and focus,
    which jsdom can see. api.ts is mocked anyway — as a trap rather than as a
    fixture. Nothing on this card is allowed to fetch, and a spy that is never
    called is the only way to assert that from here.

    The one thing jsdom cannot see is stated where it matters and measured in
    a browser instead: whether the menu opens over the cards below it rather
    than pushing them down.

INPUTS / INPUT SOURCES
    - Hand-built OntologySummary objects, with and without a `card` sketch.
    - A mocked api.ts, which must stay uncalled.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-3, AC-4, AC-5, AC-6, AC-9, AC-15 and
      AC-16.
================================================================================
*/

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      busy={false}
      working={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...result, ...handlers };
}

/** The card's facts, as read. */
function facts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".onto-chips li")].map((li) => li.textContent ?? "");
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
  it("shows the name, the sentence, and two facts: statements and the date added (home-and-examples AC-8)", () => {
    // AC-3. The description is L-5's sentence rather than a filename: it says
    // more about an ontology than its name does, and reusing it is what keeps
    // the home screen and the Explore panel from wording the same fact twice.
    const { container } = renderCard({ addedAt: "2026-10-14T09:00:00Z" });

    expect(screen.getByRole("heading", { level: 3, name: "FIBO quickstart" })).toBeTruthy();
    expect(container.querySelector(".onto-summary")?.textContent).toBe(
      "This ontology describes 11,208 classes, 4,305 individuals and 3,204 object properties.",
    );

    const added = new Date("2026-10-14T09:00:00Z").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
    expect(facts(container)).toEqual(["132,001 statements", `Added ${added}`, "Read-only"]);
  });

  it("drops the other chips: entities, relations, format, loaded and source (F-9)", () => {
    const { container } = renderCard({ loaded: true, source: "https://example.org/f.ttl" });
    const text = container.querySelector(".onto-chips")!.textContent ?? "";
    for (const gone of ["entities", "relations", "turtle", "Loaded", "URL", "Upload", "triples"]) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it("an example shows its purpose and Example, never a date", () => {
    const { container } = renderCard({
      source: "example",
      addedAt: "2026-10-14T09:00:00Z",
      example: { key: "space", purpose: "The Solar System and its missions." },
    });
    expect(container.querySelector(".onto-summary")?.textContent).toBe(
      "The Solar System and its missions.",
    );
    expect(facts(container)).toEqual(["132,001 statements", "Example", "Read-only"]);
  });

  it("a reference ontology says Reference, never Example (reference-ontologies 5.2)", () => {
    const { container } = renderCard({
      source: "example",
      example: { key: "qudt", purpose: "Quantities, units and dimensions.", group: "reference" },
    });
    expect(facts(container)).toEqual(["132,001 statements", "Reference", "Read-only"]);
    expect(container.querySelector(".onto-summary")?.textContent).toBe("Quantities, units and dimensions.");
  });

  it("the group is the server's; a server that predates groups is read by the key", () => {
    // FOAF from an older server, with no group: still a reference.
    const { container } = renderCard({ source: "example", example: { key: "foaf", purpose: "People." } });
    expect(facts(container)).toContain("Reference");
    cleanup();
    // The server's word wins over the key.
    const told = renderCard({ source: "example", example: { key: "foaf", purpose: "People.", group: "example" } });
    expect(facts(told.container)).toContain("Example");
  });

  it("an undated file keeps its statements and Read-only and drops the date", () => {
    const { container } = renderCard({ addedAt: undefined });
    expect(facts(container)).toEqual(["132,001 statements", "Read-only"]);
  });

  it("says statement, singular, for one", () => {
    const { container } = renderCard({ triples: 1 });
    expect(facts(container)[0]).toBe("1 statement");
  });

  it("reports whole-ontology counts, not budgeted ones", () => {
    // AC-4. A card is a statement about the FILE, not about the current canvas.
    // The distinction is real and has bitten before: D-017 drew it for
    // kindCounts. The statement count is the file's own, and the composition
    // bar reads kindCounts, the whole ontology's.
    const { container } = renderCard();

    expect(facts(container)).toContain("132,001 statements");
    const bands = [...container.querySelectorAll(".onto-bar-band")];
    expect(bands).toHaveLength(3);
  });

  it("draws no graph thumbnail, though the sketch is there, and keeps everything else (home-and-settings AC-3)", () => {
    // The server still writes the sketch at ingest; the card stopped drawing
    // it, unreadable at card size. No canvas either: a canvas is what a
    // renderer needs and it is the thing that could not be there by accident.
    const { container } = renderCard();
    expect(summary().card?.sketch.nodes.length).toBe(SKETCH.nodes.length);

    expect(container.querySelector(".onto-mini")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();

    // Everything else: name, menu, sentence, composition bar, chips, verbs.
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(summary().name);
    expect(menuButton()).toBeTruthy();
    expect(container.querySelector(".onto-summary")?.textContent).toBeTruthy();
    expect(container.querySelectorAll(".onto-bar-band").length).toBeGreaterThan(0);
    expect(facts(container)).toContain("132,001 statements");
    expect([...container.querySelectorAll(".onto-verb")].map((b) => b.textContent)).toEqual([
      "Explore",
      "Query",
      "View",
    ]);
  });

  it("pre-existing ontologies render with no sketch and ask for none", () => {
    // AC-15. An ontology stored before the server wrote a sketch keeps its
    // counts and its verbs and simply has no picture — and, the half that
    // matters, asks for nothing to get one. Backfilling on first render would
    // be a parse per stored ontology on the startup path, which is the budget
    // `startup-chooser-screen` exists to hold.
    const { container } = renderCard({ card: null });

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".onto-chips")?.textContent).toContain("132,001 statements");
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
    expect(container.querySelector("svg")).toBeNull();
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

    // The ⋮ button is aria-disabled rather than disabled, so a removal's
    // count never drops its focus to the page (portal-foundations 5.7); a
    // press on it opens nothing.
    for (const button of container.querySelectorAll("button")) {
      const inert = (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";
      expect(inert, button.textContent ?? "").toBe(true);
    }
    fireEvent.click(menuButton());
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
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

describe("OntologyCard reading order", () => {
  it("keeps the reading order: menu, then the verbs, no tabindex", () => {
    // Document order is what the tab sequence follows, and it stays name,
    // menu, verbs -- asserted here because jsdom implements no sequential
    // focus navigation and driving Tab would test the polyfill.
    const { container } = renderCard();
    const buttons = [...container.querySelectorAll("button")];

    expect(buttons.indexOf(menuButton())).toBe(0);
    for (const button of buttons) {
      expect(button.hasAttribute("tabindex")).toBe(false);
    }
  });
});
