// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/GraphNotice.test.tsx
================================================================================

SUMMARY
    The first test for GraphNotice, and one of the first three tests for any
    React component in this repository. Covers what the notice says, when it
    says nothing, what the two budget controls do at each end of the range, and
    the accessibility properties the specification requires of it.

BASIC IDEA
    GraphNotice is a pure function of its props, so every case is reachable by
    rendering it with a stats object and asserting on the DOM. No server, no
    graph renderer, no timers.

    The counts are asserted with digits and separators as a user sees them,
    because "2,000 of 18,717" is the whole point of the component: a test that
    accepted "2000" would pass while the interface said something a learner
    cannot scan.

    Every state of the pair is driven by stats.budget against defaultBudget,
    which is why neither "can reduce" nor "everything is drawn" is a prop: the
    component derives both, and a test states the two numbers instead of the
    conclusion it wants.

INPUTS / INPUT SOURCES
    - Constructed VizGraph["stats"] objects.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-3, AC-10, AC-20, AC-21 and AC-22 of
      partial-graph-rendering, AC-1 to AC-5 of show-less, and defect D-2.
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
  {
    atMaximum = false,
    defaultBudget = 2000,
    restoreFocus = null,
  }: {
    atMaximum?: boolean;
    defaultBudget?: number;
    restoreFocus?: "more" | "less" | null;
  } = {},
) {
  const onShowMore = vi.fn();
  const onShowLess = vi.fn();
  const onFocusRestored = vi.fn();
  render(
    <GraphNotice
      stats={stats}
      defaultBudget={defaultBudget}
      atMaximum={atMaximum}
      restoreFocus={restoreFocus}
      onShowMore={onShowMore}
      onShowLess={onShowLess}
      onFocusRestored={onFocusRestored}
    />,
  );
  return { onShowMore, onShowLess, onFocusRestored };
}

const showLess = () =>
  screen.getByRole("button", { name: /show less/i }) as HTMLButtonElement;
const showMore = () =>
  screen.getByRole("button", { name: /show more/i }) as HTMLButtonElement;

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

  it("hides the notice when the ontology is below the floor", () => {
    // AC-3 of partial-graph-rendering and AC-5 of show-less, which are the same
    // test: an ontology smaller than the default budget was never truncated and
    // can never be reduced, so the bar has nothing to offer and must not appear.
    // Show less is asserted absent as well — added naively to the existing
    // markup it would have shown up here, on a graph with no budget decision in
    // it. This is the one case where returning null is right.
    renderNotice(truncatedStats({ truncated: false, nodeCount: 34, nodeTotal: 34 }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show less/i })).toBeNull();
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

  it("both budget controls are reachable by keyboard", () => {
    // AC-22: real <button> elements, in the tab order, with accessible names.
    // A div with an onClick would satisfy the visual design and fail this.
    const { onShowMore } = renderNotice(truncatedStats({ budget: 4000 }));
    const more = screen.getByRole("button", { name: /show more/i });
    const less = screen.getByRole("button", { name: /show less/i });

    for (const button of [less, more]) {
      expect(button.tagName).toBe("BUTTON");
      // Nothing has removed them from the tab order.
      expect(button.getAttribute("tabindex")).not.toBe("-1");
      button.focus();
      expect(document.activeElement).toBe(button);
    }

    // A focused button responds to activation, which is what a keyboard does.
    fireEvent.click(more);
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("offers no way to dismiss the bar", () => {
    // Defect D-2. The ✕ set `noticeDismissed` in App, which reset only when the
    // active ontology changed — so one press took Show more AND Show less away
    // for the rest of the session with no way back. It was specified when this
    // bar was a sentence and one button; show-less gave it something worth
    // losing. The bar and its summary are permanent now.
    //
    // Asserted over every button in the bar rather than by querying for the one
    // that used to be here, so any future control that hides the notice fails
    // this too.
    renderNotice(truncatedStats({ budget: 4000 }));
    const buttons = [...screen.getByRole("status").querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.textContent, "an extra control appeared on the notice").toMatch(
        /^Show (more|less)$/,
      );
    }
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("renders show less beside show more", () => {
    // AC-1: immediately before, so the pair reads in the order the range runs.
    // Asserted as document order with no tabindex anywhere, rather than by
    // driving Tab: jsdom implements no sequential focus navigation, so a
    // userEvent.tab() loop here would be testing the polyfill. Same argument as
    // CatalogueList.test.tsx, and the visual half is verified in a browser.
    renderNotice(truncatedStats({ budget: 8000 }));
    const buttons = [...screen.getByRole("status").querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Show less", "Show more"]);
    for (const button of buttons) expect(button.getAttribute("tabindex")).toBeNull();
  });

  it("show less is disabled at the default budget", () => {
    // AC-2, the floor. Nothing below the default is a view worth having.
    const { onShowLess } = renderNotice(truncatedStats({ budget: 2000 }));
    expect(showLess().disabled).toBe(true);
    fireEvent.click(showLess());
    expect(onShowLess).not.toHaveBeenCalled();
  });

  it("show less is enabled above the default budget", () => {
    // AC-2, the other half. The comparison is against the prop, not against a
    // 2,000 written here: pass a server default of 500 and 2,000 is reducible.
    const { onShowLess } = renderNotice(truncatedStats({ budget: 2000 }), {
      defaultBudget: 500,
    });
    expect(showLess().disabled).toBe(false);
    fireEvent.click(showLess());
    expect(onShowLess).toHaveBeenCalledTimes(1);
  });

  it("disabled controls carry a reason in their title", () => {
    // AC-3: the reason is stated, not implied by dimming. A disabled control
    // with no explanation is indistinguishable from a broken one, and dimming
    // reaches nobody using a screen reader.
    renderNotice(truncatedStats({ budget: 2000 }), { defaultBudget: 2000 });
    expect(showLess().disabled).toBe(true);
    expect(showLess().getAttribute("title")).toBe("2,000 entities is the smallest view.");

    document.body.innerHTML = "";
    renderNotice(truncatedStats({ nodeCount: 20000, budget: 20000, nodeTotal: 40000 }), {
      atMaximum: true,
    });
    expect(showMore().disabled).toBe(true);
    expect(showMore().getAttribute("title")).toMatch(/maximum/i);
  });

  it("the notice still renders when everything is drawn", () => {
    // AC-4, and the regression this spec exists for. The old condition was
    // `if (!stats.truncated) return null`, so pressing Show more until the
    // whole ontology was drawn deleted the bar — counts, dismiss control and
    // any Show less on it — at the moment the user most wanted to reduce.
    renderNotice(
      truncatedStats({ truncated: false, nodeCount: 12400, nodeTotal: 12400, budget: 16000 }),
    );
    expect(screen.getByRole("status")).not.toBeNull();
    expect(showLess().disabled).toBe(false);
  });

  it("the sentence changes when everything is drawn", () => {
    // AC-4: "the 12,400 most connected of 12,400" would be true and useless.
    renderNotice(
      truncatedStats({ truncated: false, nodeCount: 12400, nodeTotal: 12400, budget: 16000 }),
    );
    expect(screen.getByRole("status").textContent).toContain("Showing all 12,400 entities.");
    expect(screen.getByRole("status").textContent).not.toMatch(/most connected/i);
  });

  it("show more is disabled when everything is drawn", () => {
    // AC-4. Also the case where allDrawn and atMaximum are true together:
    // asking for 32,000 of FIBO's 18,717 is clamped to 20,000 and returns
    // everything. The reason the user is given must be the ontology rather
    // than the ceiling, because that is the true one.
    renderNotice(
      truncatedStats({ truncated: false, nodeCount: 18717, nodeTotal: 18717, budget: 20000 }),
      { atMaximum: true },
    );
    expect(showMore().disabled).toBe(true);
    expect(showMore().getAttribute("title")).toBe("Every entity is already drawn.");
    expect(screen.getByRole("status").textContent).toContain("Showing all 18,717 entities.");
  });

  it("restoring focus onto a disabled control moves it to the partner", () => {
    // Beyond the test plan, which covers the focus move at App level only. The
    // rule has two directions and App's test drives one; this isolates the
    // other, that a press which disables Show MORE hands focus to Show less.
    renderNotice(
      truncatedStats({ truncated: false, nodeCount: 12400, nodeTotal: 12400, budget: 16000 }),
      { restoreFocus: "more" },
    );
    expect(showMore().disabled).toBe(true);
    expect(document.activeElement).toBe(showLess());
  });
});
