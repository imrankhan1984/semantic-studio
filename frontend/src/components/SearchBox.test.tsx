// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SearchBox.test.tsx
================================================================================

SUMMARY
    Tests for SearchBox: the "not drawn" marker that tells the user a result is
    outside the budgeted part of the graph, and the combobox the result list
    became in 2026-07-31's keyboard work — its roles and references, the arrow
    keys that move the active option without moving focus, Enter, Escape, and
    the polite count.

BASIC IDEA
    The component calls the /search endpoint through api.ts, so api.ts is
    mocked and the component is driven by typing into its input. The debounce
    is 200 ms of real time, so the timers are faked and advanced deliberately
    rather than waited on.

    The marker is asserted as text. The specification requires it not to be
    conveyed by colour alone, and a test that looked at a class name or a style
    would pass on an implementation that failed that requirement.

    The combobox assertions are mostly about references — aria-controls and
    aria-activedescendant name ids, and an id that names nothing is a reference
    to nowhere that no test comparing two strings would catch. Every one of them
    is resolved through getElementById rather than compared as text.

INPUTS / INPUT SOURCES
    - A mocked searchNodes from ../api.
    - A drawnIds set standing in for what the canvas currently shows.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-24 of partial-graph-rendering and
      AC-5 to AC-7 and AC-14 of keyboard-and-motion.
================================================================================
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SearchBox from "./SearchBox";
import type { VizNode } from "../types";

const { searchNodes } = vi.hoisted(() => ({ searchNodes: vi.fn() }));
vi.mock("../api", () => ({ searchNodes }));

const DRAWN: VizNode = { id: "http://ex.org/Drawn", label: "Drawn Thing", kind: "class", degree: 9 };
const UNDRAWN: VizNode = { id: "http://ex.org/Hidden", label: "Hidden Thing", kind: "class", degree: 1 };

/** 100 results, the size the performance budget names. */
const MANY: VizNode[] = Array.from({ length: 100 }, (_, i) => ({
  id: `http://ex.org/n${i}`,
  label: `Thing ${i}`,
  kind: "class",
  degree: 100 - i,
}));

beforeEach(() => {
  vi.useFakeTimers();
  searchNodes.mockReset();
  searchNodes.mockResolvedValue([DRAWN, UNDRAWN]);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const input = () => screen.getByRole("combobox") as HTMLInputElement;
const options = () => screen.getAllByRole("option");

/** Type a query and let the 200 ms debounce and the mocked promise settle. */
async function search(drawnIds: Set<string> | null, onPick = vi.fn()) {
  const view = render(
    <SearchBox ontologyId="o1" theme="dark" onPick={onPick} drawnIds={drawnIds} />,
  );
  fireEvent.change(input(), { target: { value: "thing" } });
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  return { onPick, view };
}

describe("SearchBox results", () => {
  it("search result outside the graph is marked not drawn", async () => {
    // AC-24: only the entity missing from the canvas carries the marker.
    await search(new Set([DRAWN.id]));

    const rows = options();
    expect(rows).toHaveLength(2);

    const drawnRow = rows.find((r) => r.textContent?.includes("Drawn Thing"))!;
    const hiddenRow = rows.find((r) => r.textContent?.includes("Hidden Thing"))!;
    expect(hiddenRow.textContent).toContain("not drawn");
    expect(drawnRow.textContent).not.toContain("not drawn");
  });

  it("marks nothing while no graph is loaded", async () => {
    // null means "unknown", not "nothing is drawn". Marking every row before
    // the graph arrives would tell the user the opposite of the truth.
    await search(null);
    for (const row of options()) {
      expect(row.textContent).not.toContain("not drawn");
    }
  });
});

describe("SearchBox as a combobox", () => {
  it("the input is a combobox with aria-expanded", async () => {
    // AC-5. A text field with a list beneath it IS a combobox, and it said so
    // nowhere: the list was <li onClick>, reachable by pointer only.
    render(<SearchBox ontologyId="o1" theme="dark" onPick={vi.fn()} />);
    const box = input();

    // Closed to begin with, and the reference is already in place: an
    // aria-controls that only appears when the list does is a reference the
    // assistive technology has to re-read at the wrong moment.
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.getAttribute("aria-autocomplete")).toBe("list");
    expect(box.getAttribute("aria-controls")).toBeTruthy();

    fireEvent.change(box, { target: { value: "thing" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(box.getAttribute("aria-expanded")).toBe("true");
    // The list it names is the list that appeared, resolved rather than compared.
    const list = document.getElementById(box.getAttribute("aria-controls")!);
    expect(list).not.toBeNull();
    expect(list!.getAttribute("role")).toBe("listbox");
    for (const option of options()) {
      expect(option.getAttribute("role")).toBe("option");
      expect(option.id, "options need stable ids to be referenced").toBeTruthy();
    }
  });

  it("arrow keys move the active option without moving focus", async () => {
    // AC-6, and the reason this is aria-activedescendant rather than roving
    // real focus: focus has to stay in the text field or typing stops working.
    await search(null);
    const box = input();
    box.focus();
    expect(box.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement, "focus left the input").toBe(box);

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("false");

    // Down from the last option wraps, and Up from the first wraps back.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(document.activeElement).toBe(box);
  });

  it("Enter picks the active option", async () => {
    // AC-6. And with nothing active Enter belongs to the input: pre-selecting
    // the first row would make Enter pick something nobody chose.
    const { onPick } = await search(null);
    const box = input();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(UNDRAWN.id);
    // Picking closes the list, as clicking a row always has.
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the list and keeps the text", async () => {
    // AC-6. The text surviving is the point: a native type="search" input
    // clears itself on Escape, which would throw away what the user typed.
    const { onPick } = await search(null);
    const box = input();

    fireEvent.keyDown(box, { key: "Escape" });

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.value).toBe("thing");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("the result count is announced politely", async () => {
    // AC-7. The list appearing is a visual event and nothing else; without this
    // a screen reader user types and hears silence.
    const { view } = await search(null);
    const region = document.querySelector("[role='status'][aria-live='polite']")!;
    expect(region.textContent).toBe("2 results");

    // Singular, because "1 results" is the kind of detail that makes an
    // interface sound like a form letter.
    searchNodes.mockResolvedValue([DRAWN]);
    fireEvent.change(input(), { target: { value: "drawn" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(region.textContent).toBe("1 result");

    // Nothing found is its own sentence, and the list closes with it.
    searchNodes.mockResolvedValue([]);
    fireEvent.change(input(), { target: { value: "nothing here" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(region.textContent).toBe("No results");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });

  it("activedescendant does not slow typing", async () => {
    // AC-14, row 4 of the performance budget, with 100 results as it specifies.
    //
    // Counted, not timed. A wall-clock ratio in jsdom measures jsdom — the
    // mistake D-020 made and D-021 corrected — so what is counted is the work
    // that would make typing slow: the DOM the browser has to touch when the
    // active option moves. If that is proportional to the number of results,
    // arrowing through a long list is quadratic and the user feels it.
    //
    // The measurement is deliberately independent of React's render count. A
    // render pass over 100 memo-free rows is cheap; replacing 100 DOM nodes is
    // not, and only the second is observable from outside the component.
    searchNodes.mockResolvedValue(MANY);
    render(<SearchBox ontologyId="o1" theme="dark" onPick={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "thing" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(options()).toHaveLength(100);

    const before = options();
    const list = document.querySelector(".search-box")!;
    const observer = new MutationObserver(() => {});
    observer.observe(list, { subtree: true, childList: true, attributes: true });

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    const records = observer.takeRecords();
    observer.disconnect();

    // Nothing was added or removed: the list survives an arrow press intact.
    expect(records.filter((r) => r.type === "childList")).toHaveLength(0);
    // And the attribute churn is a constant per press — the input's
    // aria-activedescendant plus aria-selected and class on the two rows that
    // changed — rather than anything that scales with the 100 rows.
    expect(records.filter((r) => r.type === "attributes").length).toBeLessThanOrEqual(18);

    // Every one of the 100 rows is the SAME DOM node it was. This is the
    // assertion that fails if the option ids are ever derived from the active
    // index, which would rewrite every id on every press.
    const after = options();
    expect(after).toHaveLength(100);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(before[i]);
    expect(input().getAttribute("aria-activedescendant")).toBe(after[2].id);
  });
});
