// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NextSteps.test.tsx
================================================================================

SUMMARY
    The first test for NextSteps. Covers the two shapes the component now has —
    a plain open list at three options or fewer, a closed disclosure above that
    — and the disclosure contract: aria-expanded, aria-controls, focus into the
    filter on open and back to the control on close, and no option rows in the
    document while it is closed.

BASIC IDEA
    The point of the change is vertical space, and vertical space is layout,
    which jsdom does not have. So the assertions are structural instead: the
    count of option rows in the document, which is what actually consumed the
    height, and a ratio between two closed renders, which is what would give
    the game away if the options were being built anyway.

    The recovered space itself is confirmed in a browser.

INPUTS / INPUT SOURCES
    - Synthetic NextStepOption arrays built in this file. No network, no mocks.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-11.
================================================================================
*/

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NextSteps from "./NextSteps";
import type { NextStepOption } from "./NextSteps";

function optionsWith(count: number): NextStepOption[] {
  return Array.from({ length: count }, (_, i) => ({
    anchor: 0,
    anchorLabel: "Instrument",
    predicate: `http://example.org/p${i}`,
    predicateLabel: `is issued by ${i}`,
    inverse: false,
    targetClass: `http://example.org/C${i}`,
    targetLabel: `Target ${i}`,
    count: 0,
    declared: true,
  }));
}

function renderSteps(options: NextStepOption[], onAdd = vi.fn()) {
  const view = render(<NextSteps options={options} stepCount={1} onAdd={onAdd} />);
  return { ...view, onAdd };
}

const chips = () => document.querySelectorAll("button.next-chip");
const toggle = () => document.querySelector("button.next-steps-toggle");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("NextSteps shape", () => {
  it("renders nothing when there are no options", () => {
    // AC-1. Unchanged behaviour, asserted because it would be easy to lose
    // while adding a disclosure around everything else.
    const { container } = renderSteps([]);
    expect(container.innerHTML).toBe("");
  });

  it("renders an open plain list at three options or fewer", () => {
    // AC-2, and this is the learner concession rather than an optimisation.
    // Three continuations cost almost nothing to show, and showing them is how
    // the builder teaches what is possible.
    renderSteps(optionsWith(3));
    expect(chips()).toHaveLength(3);
    expect(toggle()).toBeNull();
  });

  it("renders no filter at three options or fewer", () => {
    // AC-2. Nothing to filter, so nothing to explain.
    renderSteps(optionsWith(3));
    expect(document.querySelector("input.next-filter")).toBeNull();
  });

  it("renders a closed control at four options or more", () => {
    // AC-3. Four is the first count that closes.
    renderSteps(optionsWith(4));
    expect(toggle()).not.toBeNull();
    expect(chips()).toHaveLength(0);
  });

  it("the closed control names the option count", () => {
    // AC-4. A count that is only visible is a count a screen reader user does
    // not have, so this queries by computed accessible name rather than by
    // textContent.
    renderSteps(optionsWith(23));
    const control = screen.getByRole("button", { name: "Add a step, 23 options" });
    expect(control).toBe(toggle());
    // The name is an explicit aria-label, which means it can drift from what
    // is on screen without anything visibly breaking. So assert it does not:
    // both halves of the visible label appear in the spoken one.
    expect(control.textContent).toContain("Add a step");
    expect(control.textContent).toContain("23 options");
  });
});

describe("NextSteps closed cost", () => {
  it("renders no options while closed", () => {
    // AC-5. 200 is well beyond what FIBO offers at any point in a path, and
    // the number that matters is zero: the option rows are what filled the
    // panel, and a hidden row still fills the document.
    renderSteps(optionsWith(200));
    expect(chips()).toHaveLength(0);
    expect(document.querySelectorAll("button")).toHaveLength(1);
  });

  it("closed render cost does not scale with option count", () => {
    // AC-5. A ratio rather than a threshold, for the reason in D-021.
    //
    // Ten times the options must cost almost nothing extra while closed. The
    // `matching` memo still runs over every option, but with an empty filter
    // it returns the array unchanged, so the only work left that scales is the
    // caller's — which is why the tolerance is 1.5x and not 3x.
    //
    // Mutation-tested 2026-07-31 by rendering the panel's contents regardless
    // of `open`: 2.58 ms against 9.83 ms, a ratio of 3.81x against a limit of
    // 1.5, and this failed. The zero-rows test above went red on the same
    // mutation, which is the point of having both.
    const cost = (count: number) => {
      cleanup();
      const options = optionsWith(count);
      const start = performance.now();
      renderSteps(options);
      const elapsed = performance.now() - start;
      expect(chips()).toHaveLength(0);
      return elapsed;
    };
    cost(20); // discarded warm-up: module init and the first JIT passes

    const median = (count: number) =>
      [cost(count), cost(count), cost(count)].sort((a, b) => a - b)[1];
    const small = median(20);
    const large = median(200);
    const ratio = large / small;

    expect(
      ratio,
      `20 options: ${small.toFixed(2)} ms, 200 options: ${large.toFixed(2)} ms, ` +
        `ratio ${ratio.toFixed(2)}x for 10x the input`,
    ).toBeLessThanOrEqual(1.5);
  });
});

describe("NextSteps disclosure", () => {
  it("activating the control opens the panel", () => {
    // AC-6.
    renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    expect(chips()).toHaveLength(23);
    expect(document.querySelector("input.next-filter")).not.toBeNull();
  });

  it("opening moves focus to the filter", () => {
    // AC-7. The filter is what the user opened the panel to use.
    renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    expect(document.activeElement).toBe(document.querySelector("input.next-filter"));
  });

  it("Escape closes and returns focus to the control", () => {
    // AC-7. Matches the rest of the application: QueryPanel already closes its
    // chip menus on Escape.
    renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    fireEvent.keyDown(document.querySelector("input.next-filter")!, { key: "Escape" });
    expect(chips()).toHaveLength(0);
    expect(document.activeElement).toBe(toggle());
  });

  it("aria-expanded tracks the open state", () => {
    // AC-9. Open and closed are conveyed by aria-expanded, not by the glyph.
    renderSteps(optionsWith(23));
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle()!);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("aria-controls names the panel", () => {
    // AC-9. And it names it while closed too, which is why the panel element
    // stays in the document with only its contents removed. An aria-controls
    // pointing at nothing is worse than none.
    renderSteps(optionsWith(23));
    const target = toggle()!.getAttribute("aria-controls")!;
    expect(target).toBeTruthy();
    const panel = document.getElementById(target);
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains("next-steps-panel")).toBe(true);
    expect(panel!.hasAttribute("hidden")).toBe(true);

    fireEvent.click(toggle()!);
    expect(document.getElementById(target)!.hasAttribute("hidden")).toBe(false);
  });

  it("the disclosure arrow is hidden from assistive technology", () => {
    // AC-9. It is decoration; aria-expanded carries the meaning.
    renderSteps(optionsWith(23));
    expect(document.querySelector(".next-steps-arrow")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("NextSteps filtering and staleness", () => {
  it("the filter still narrows the list", () => {
    // AC-10. Unchanged behaviour, moved inside the panel.
    renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    fireEvent.change(document.querySelector("input.next-filter")!, {
      target: { value: "Target 1" },
    });
    // Target 1 and Target 10 to Target 19.
    expect(chips()).toHaveLength(11);
  });

  it("an unmatched filter keeps the panel open with its message", () => {
    // AC-10. The panel stays open so the user can correct what they typed.
    renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    fireEvent.change(document.querySelector("input.next-filter")!, {
      target: { value: "nothing like this" },
    });
    expect(chips()).toHaveLength(0);
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("choosing an option closes the panel and reports the choice", () => {
    // AC-8. A step changes what the next legal options are, so a list left
    // open is showing options computed for a path that no longer exists.
    const { onAdd } = renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    fireEvent.click(chips()[4]);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].targetLabel).toBe("Target 4");
    expect(chips()).toHaveLength(0);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("changing options closes an open panel", () => {
    // AC-11. This is the step added from the graph or from search: NextSteps
    // never sees the click, only a new options array, and a stale open list
    // invites a wrong click.
    const { rerender } = renderSteps(optionsWith(23));
    fireEvent.click(toggle()!);
    expect(chips()).toHaveLength(23);

    rerender(<NextSteps options={optionsWith(19)} stepCount={2} onAdd={vi.fn()} />);
    expect(chips()).toHaveLength(0);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
  });
});
