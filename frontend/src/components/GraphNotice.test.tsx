// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/GraphNotice.test.tsx
================================================================================

SUMMARY
    The first test for GraphNotice, and one of the first three tests for any
    React component in this repository. Covers what the notice says, when it
    says nothing, what Show more does, and the accessibility properties the
    specification requires of it.

BASIC IDEA
    GraphNotice is a pure function of its props, so every case is reachable by
    rendering it with a stats object and asserting on the DOM. No server, no
    graph renderer, no timers.

    The counts are asserted with digits and separators as a user sees them,
    because "2,000 of 18,717" is the whole point of the component: a test that
    accepted "2000" would pass while the interface said something a learner
    cannot scan.

INPUTS / INPUT SOURCES
    - Constructed VizGraph["stats"] objects.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-3, AC-10, AC-20, AC-21 and AC-22.
================================================================================
*/

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphNotice from "./GraphNotice";
import type { VizGraph } from "../types";

/** Stats for a graph of 2,000 drawn nodes out of 18,717 — FIBO's real size. */
function truncatedStats(overrides: Partial<VizGraph["stats"]> = {}): VizGraph["stats"] {
  return {
    nodeCount: 2000,
    edgeCount: 5180,
    nodeTotal: 18717,
    edgeTotal: 51446,
    truncated: true,
    budget: 2000,
    kindCounts: { class: 18717 },
    ...overrides,
  };
}

function renderNotice(
  stats: VizGraph["stats"],
  { atMaximum = false } = {},
): { onShowMore: () => void; onDismiss: () => void } {
  const onShowMore = vi.fn();
  const onDismiss = vi.fn();
  render(
    <GraphNotice
      stats={stats}
      atMaximum={atMaximum}
      onShowMore={onShowMore}
      onDismiss={onDismiss}
    />,
  );
  return { onShowMore, onDismiss };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("GraphNotice", () => {
  it("renders the truncation notice with both counts", () => {
    // AC-20: the drawn count and the total count, both as digits.
    renderNotice(truncatedStats());
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("2,000");
    expect(notice.textContent).toContain("18,717");
    // And says plainly that more exists than is on screen.
    expect(notice.textContent).toMatch(/most connected/i);
  });

  it("hides the notice when truncated is false", () => {
    // AC-3: a small ontology must look exactly as it did before the budget.
    renderNotice(truncatedStats({ truncated: false, nodeCount: 34, nodeTotal: 34 }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("show more doubles the budget and refetches", () => {
    // AC-21: App turns this callback into a request for stats.budget * 2. The
    // component's own contract is that pressing the button asks for more.
    const { onShowMore } = renderNotice(truncatedStats());
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("show more is disabled at the maximum", () => {
    // AC-10: disabled, and the reason is in its title rather than left to be
    // guessed from a button that does nothing.
    renderNotice(truncatedStats({ nodeCount: 20000, budget: 20000, nodeTotal: 40000 }), {
      atMaximum: true,
    });
    const button = screen.getByRole("button", { name: /show more/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/maximum/i);
    // The wording changes too, so the notice does not keep offering more.
    expect(screen.getByRole("status").textContent).toMatch(
      /maximum this view will draw/i,
    );
  });

  it("notice is a polite live region", () => {
    // AC-22: announced when a truncated graph loads, without stealing focus.
    renderNotice(truncatedStats());
    const notice = screen.getByRole("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
  });

  it("show more and dismiss are reachable by keyboard", () => {
    // AC-22: real <button> elements, in the tab order, with accessible names.
    // A div with an onClick would satisfy the visual design and fail this.
    const { onDismiss } = renderNotice(truncatedStats());
    const showMore = screen.getByRole("button", { name: /show more/i });
    const dismiss = screen.getByRole("button", { name: /dismiss/i });

    for (const button of [showMore, dismiss]) {
      expect(button.tagName).toBe("BUTTON");
      // Nothing has removed them from the tab order.
      expect(button.getAttribute("tabindex")).not.toBe("-1");
      button.focus();
      expect(document.activeElement).toBe(button);
    }

    // A focused button responds to activation, which is what a keyboard does.
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
