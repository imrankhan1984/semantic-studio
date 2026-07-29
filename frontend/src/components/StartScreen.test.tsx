// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/StartScreen.test.tsx
================================================================================

SUMMARY
    The first test for StartScreen. Covers what each library state renders, the
    catalogue's in-flight and failure behaviour, the keyboard and screen-reader
    contract, and the fifty-row render budget.

BASIC IDEA
    StartScreen is the screen a learner meets first, and every claim this spec
    makes about it is either a piece of markup or a piece of focus behaviour —
    both of which jsdom can see. So unlike DetailPanel, almost nothing here is
    deferred to a browser; the one thing that is, that the tab no longer hangs
    with FIBO stored, is checked against the running application instead.

    api.ts is mocked so a catalogue pick resolves or rejects on command without
    a server. The CATALOGUE constant is NOT mocked: which entries appear and in
    what order is the subject of CatalogueList.test.tsx, and mocking it here
    would let the two disagree.

INPUTS / INPUT SOURCES
    - A mocked fetchOntology from ../api.
    - Ontology summaries built by `summaries()` below.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
      and AC-14.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StartScreen from "./StartScreen";
import { CATALOGUE } from "../catalogue";
import type { OntologySummary } from "../types";

const { fetchOntology } = vi.hoisted(() => ({ fetchOntology: vi.fn() }));
vi.mock("../api", () => ({ fetchOntology }));

/** `n` stored ontologies, sized so the digits in the assertions are readable. */
function summaries(n: number): OntologySummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    name: `Ontology ${i}`,
    source: "upload",
    format: "turtle",
    triples: 132001 + i,
    nodes: 18717 + i,
    edges: 51446 + i,
    kindCounts: { class: 1 },
    namespaces: {},
    addedAt: "2026-07-26T09:00:00Z",
  }));
}

/** Render the chooser with everything defaulted to the loaded, happy state. */
function renderScreen(props: Partial<React.ComponentProps<typeof StartScreen>> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    onLoaded: vi.fn(),
    onOpenDialog: vi.fn(),
  };
  const result = render(
    <StartScreen
      ontologies={summaries(3)}
      loading={false}
      error={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...result, ...handlers };
}

function libraryRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button.start-row")];
}

function catalogueRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button.catalogue-entry")];
}

beforeEach(() => {
  fetchOntology.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("StartScreen library", () => {
  it("renders one row per saved ontology with counts and format", () => {
    // AC-6. Name, triples, nodes and format on every row, as text — the size
    // of a choice has to survive being read aloud, so none of it is a colour.
    renderScreen();
    const rows = libraryRows();
    expect(rows).toHaveLength(3);

    expect(rows[0].textContent).toContain("Ontology 0");
    expect(rows[0].textContent).toContain("132,001 triples");
    expect(rows[0].textContent).toContain("18,717 nodes");
    expect(rows[0].textContent).toContain("turtle");

    // The accessible name carries the whole row, including the date, so a
    // screen reader user hears the same choice a sighted one sees.
    const name = rows[0].getAttribute("aria-label") ?? "";
    expect(name).toContain("Ontology 0");
    expect(name).toContain("132,001 triples");
    expect(name).toContain("18,717 nodes");
    expect(name).toContain("turtle");
    expect(name).toContain("added");
  });

  it("shows the empty-library message when nothing is saved", () => {
    // AC-7. An empty library is a normal state now, not a one-time first run,
    // and the rest of the screen has to carry it.
    renderScreen({ ontologies: [] });

    expect(screen.getByText(/nothing saved yet/i)).toBeTruthy();
    expect(libraryRows()).toHaveLength(0);
    expect(catalogueRows()).toHaveLength(CATALOGUE.length);
    expect(screen.getByRole("button", { name: /open a file/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /load from a url/i })).toBeTruthy();
  });

  it("shows a single saved ontology as a choice rather than opening it", () => {
    // AC-8. Auto-opening the only entry would be a hidden rule of exactly the
    // kind D-006 rejected, so one row is still a row.
    const { onOpen } = renderScreen({ ontologies: summaries(1) });

    expect(libraryRows()).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(fetchOntology).not.toHaveBeenCalled();
  });

  it("says the library is loading without disabling the rest", () => {
    renderScreen({ loading: true, ontologies: [] });

    expect(screen.getByText(/loading your library/i)).toBeTruthy();
    expect(catalogueRows().every((b) => !b.disabled)).toBe(true);
  });

  it("list failure keeps the catalogue and file routes usable", () => {
    // AC-10. A backend that cannot list should not block an upload.
    renderScreen({ error: "Failed to fetch", ontologies: [] });

    expect(screen.getByText("Failed to fetch")).toBeTruthy();
    expect(catalogueRows()).toHaveLength(CATALOGUE.length);
    expect(catalogueRows().every((b) => !b.disabled)).toBe(true);
    expect(screen.getByRole("button", { name: /open a file/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /load from a url/i })).toBeTruthy();
  });

  it("try again refetches the list", () => {
    // AC-10's second half: the error offers a way out of itself.
    const { onRetry } = renderScreen({ error: "Failed to fetch", ontologies: [] });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("opening a library row reports the id and fetches nothing itself", () => {
    // The chooser costs nothing to open: picking hands the id upward and the
    // screen makes no request of its own.
    const { onOpen } = renderScreen();

    fireEvent.click(libraryRows()[1]);
    expect(onOpen).toHaveBeenCalledWith("o1");
    expect(fetchOntology).not.toHaveBeenCalled();
  });

  it("hands the file and URL routes to the Load dialog on the right tab", () => {
    const { onOpenDialog } = renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /open a file/i }));
    expect(onOpenDialog).toHaveBeenCalledWith("file");

    fireEvent.click(screen.getByRole("button", { name: /load from a url/i }));
    expect(onOpenDialog).toHaveBeenCalledWith("url");
  });
});

describe("StartScreen catalogue", () => {
  it("catalogue rows are disabled while one is downloading", async () => {
    // AC-11. A download that never resolves, so the in-flight state can be
    // inspected rather than raced.
    fetchOntology.mockReturnValue(new Promise(() => {}));
    renderScreen();

    await act(async () => {
      fireEvent.click(catalogueRows()[0]);
    });

    expect(catalogueRows().every((b) => b.disabled)).toBe(true);
    // Library rows too: starting a second ontology underneath a download in
    // flight would leave the finished download overriding the user's later
    // choice.
    expect(libraryRows().every((b) => b.disabled)).toBe(true);
    expect(document.querySelectorAll(".catalogue-loading")).toHaveLength(1);
  });

  it("a failed catalogue fetch shows an error and restores the row", async () => {
    // AC-11's second half. The row comes back: a failure is not a dead end.
    fetchOntology.mockRejectedValue(new Error("That URL could not be reached."));
    const { onLoaded } = renderScreen();

    await act(async () => {
      fireEvent.click(catalogueRows()[0]);
    });

    expect(screen.getByText("That URL could not be reached.")).toBeTruthy();
    expect(catalogueRows().every((b) => !b.disabled)).toBe(true);
    expect(document.querySelectorAll(".catalogue-loading")).toHaveLength(0);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("a successful catalogue fetch reports the summary upward", async () => {
    const summary = summaries(1)[0];
    fetchOntology.mockResolvedValue(summary);
    const { onLoaded } = renderScreen();

    await act(async () => {
      fireEvent.click(catalogueRows()[0]);
    });

    expect(fetchOntology).toHaveBeenCalledWith(CATALOGUE[0].url);
    expect(onLoaded).toHaveBeenCalledWith(summary);
  });
});

describe("StartScreen keyboard and screen reader", () => {
  it("focus starts on the first library row", () => {
    // AC-12. For a user with one saved ontology the whole launch sequence is
    // start, Enter — which is what makes the extra click affordable.
    renderScreen();
    expect(document.activeElement).toBe(libraryRows()[0]);
  });

  it("the row focus lands on is marked so a ring is drawn on it", () => {
    // AC-12's "visible focus indicator", for the one case the global
    // :focus-visible rule cannot cover. Measured in Chrome on 2026-07-29:
    // script-driven focus IS focus-visible on a fresh page load, but is NOT
    // after a pointer interaction — so returning here with the mouse, via
    // "Close this ontology", focused a row and drew nothing on it.
    //
    // jsdom has no cascade and cannot see a ring, so what this asserts is that
    // the marker the CSS keys on lands on the focused row and nowhere else.
    renderScreen();

    expect(libraryRows()[0].dataset.startFocus).toBe("");
    expect(document.querySelectorAll("[data-start-focus]")).toHaveLength(1);
  });

  it("drops the focus marker once focus moves away", () => {
    // Otherwise the row keeps a ring the ordinary rules would not give it, and
    // the marker outlives the one moment it exists for.
    renderScreen();
    const row = libraryRows()[0];

    fireEvent.blur(row);

    expect(row.dataset.startFocus).toBeUndefined();
    expect(document.querySelectorAll("[data-start-focus]")).toHaveLength(0);
  });

  it("focus starts on the first catalogue row when the library is empty", () => {
    // AC-12. Nothing above it to land on, so focus falls to the next thing
    // that is actually a choice.
    renderScreen({ ontologies: [] });
    expect(document.activeElement).toBe(catalogueRows()[0]);
  });

  it("does not take focus while the library is still loading", () => {
    // Taking focus before the rows exist would land it on a catalogue row and
    // then leave it there once the library arrived, which is the wrong row.
    renderScreen({ loading: true, ontologies: [] });
    expect(document.activeElement).toBe(document.body);
  });

  it("every row is a button in a single tab sequence", () => {
    // AC-12. Library rows, then catalogue rows, then the two file routes, all
    // real <button> elements. A <div onClick> would look identical on screen
    // and be unreachable, which is backlog X-1's whole complaint elsewhere.
    renderScreen();
    const rows = [...libraryRows(), ...catalogueRows()];

    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
      // No positive tabindex anywhere: the order is the document order.
      expect(Number(row.getAttribute("tabindex") ?? 0)).toBeLessThanOrEqual(0);
    }

    // Document order is the tab order, and it is the order the spec states.
    const all = [...document.querySelectorAll("button")];
    expect(all.indexOf(libraryRows()[0])).toBeLessThan(all.indexOf(catalogueRows()[0]));
    const lastCatalogue = catalogueRows()[catalogueRows().length - 1];
    expect(all.indexOf(lastCatalogue)).toBeLessThan(
      all.indexOf(screen.getByRole("button", { name: /open a file/i })),
    );
  });

  it("download state is announced through a polite live region", async () => {
    // AC-12. The region exists before the text does: one added to the DOM at
    // the same moment as its content is not reliably announced.
    fetchOntology.mockReturnValue(new Promise(() => {}));
    renderScreen();

    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");

    await act(async () => {
      fireEvent.click(catalogueRows()[0]);
    });

    expect(screen.getByRole("status").textContent).toBe(`Downloading ${CATALOGUE[0].name}…`);
    // Announced, not focused: the user is left where they were.
    expect(document.activeElement).not.toBe(live);
  });

  it("the screen is a main region labelled by its heading", () => {
    // AC-12's structure half: a real landmark and real headings, so the screen
    // can be navigated by heading rather than only by tabbing through it.
    renderScreen();
    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading", { level: 1 });

    expect(main.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("Semantic Studio");
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(3);
  });
});

describe("StartScreen performance", () => {
  it("renders fifty rows within budget", () => {
    // AC-14. Fifty is far past what anyone accumulates; if it renders in
    // 100 ms the real case is not worth measuring.
    //
    // The warm-up render is discarded on purpose. Module initialisation and
    // the first JIT passes would otherwise land entirely on the measured
    // render — the trap recorded in D-018 and met again in D-021.
    //
    // An absolute threshold survives here where D-021 had to abandon one for
    // the detail panel, and the reason is margin rather than principle.
    // Measured 2026-07-29, jsdom on Windows over five runs: 13-15 ms, roughly
    // a seventh of the limit. The container D-021 measured on ran about four
    // times slower than the same machine, which would put this at ~60 ms and
    // still inside the budget. A ratio would need a second size to divide by
    // and would buy nothing at that margin.
    render(
      <StartScreen
        ontologies={summaries(50)}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        onOpen={vi.fn()}
        onLoaded={vi.fn()}
        onOpenDialog={vi.fn()}
      />,
    );
    document.body.innerHTML = "";

    const start = performance.now();
    renderScreen({ ontologies: summaries(50) });
    const elapsed = performance.now() - start;

    expect(libraryRows()).toHaveLength(50);
    // Interactive means the rows are buttons that can be pressed, not merely
    // that they are in the DOM.
    expect(libraryRows()[0].disabled).toBe(false);
    expect(elapsed, `rendering fifty rows took ${elapsed.toFixed(0)} ms`).toBeLessThanOrEqual(
      100,
    );
  });
});
