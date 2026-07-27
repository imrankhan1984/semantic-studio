// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SearchBox.test.tsx
================================================================================

SUMMARY
    The first test for SearchBox. Covers the "not drawn" marker that tells the
    user a search result is outside the budgeted part of the graph.

BASIC IDEA
    The component calls the /search endpoint through api.ts, so api.ts is
    mocked and the component is driven by typing into its input. The debounce
    is 200 ms of real time, so the timers are faked and advanced deliberately
    rather than waited on.

    The marker is asserted as text. The specification requires it not to be
    conveyed by colour alone, and a test that looked at a class name or a style
    would pass on an implementation that failed that requirement.

INPUTS / INPUT SOURCES
    - A mocked searchNodes from ../api.
    - A drawnIds set standing in for what the canvas currently shows.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-24.
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

beforeEach(() => {
  vi.useFakeTimers();
  searchNodes.mockReset();
  searchNodes.mockResolvedValue([DRAWN, UNDRAWN]);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Type a query and let the 200 ms debounce and the mocked promise settle. */
async function search(drawnIds: Set<string> | null) {
  render(
    <SearchBox ontologyId="o1" theme="dark" onPick={vi.fn()} drawnIds={drawnIds} />,
  );
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "thing" } });
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

describe("SearchBox", () => {
  it("search result outside the graph is marked not drawn", async () => {
    // AC-24: only the entity missing from the canvas carries the marker.
    await search(new Set([DRAWN.id]));

    const rows = screen.getAllByRole("listitem");
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
    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).not.toContain("not drawn");
    }
  });
});
