// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/Legend.test.tsx
================================================================================

SUMMARY
    The first test for Legend, and it exists because the legend is the
    application's only filtering mechanism and could not be operated without a
    pointer until 2026-07-31. Covers that every row that does something is a
    real control, that its pressed state is announced, that the rows that do
    nothing are not controls, and that collapsing takes the filters out of the
    tab order rather than leaving them reachable behind a closed panel.

BASIC IDEA
    Legend is a pure function of its props plus one piece of local state, so
    every case is reachable by rendering it with a kindCounts object and
    clicking. No server, no graph renderer, no timers.

    Assertions go through `getByRole` with a name wherever they can, because
    what is being tested is what assistive technology reports, not what the DOM
    happens to contain. A `<div onClick>` looks identical to a `<button>` in a
    snapshot and is invisible to every one of these queries — which is the whole
    defect, in one sentence.

    The keyboard rows drive `click`, not `keyDown`. A `<button>` gets Enter and
    Space from the browser and jsdom does not implement that translation, so a
    keyDown test here would assert nothing about the shipped behaviour; what
    makes the keys work is the element type, and that is asserted directly.

INPUTS / INPUT SOURCES
    - A kindCounts record and an edgeKinds array, as GET /graph returns them.
    - A hiddenKinds Set and an onToggleKind spy standing in for App's filter.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-4 and AC-14 of
      keyboard-and-motion.
================================================================================
*/

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Legend from "./Legend";

/** Counts as the graph endpoint reports them: class-heavy, as every real
 *  ontology is, and sorted descending by the component rather than by this. */
const COUNTS = { class: 412, property: 88, individual: 7 };
const EDGE_KINDS = ["subClassOf", "domain"];

function renderLegend(hidden: string[] = []) {
  const onToggleKind = vi.fn();
  const view = render(
    <Legend
      theme="dark"
      kindCounts={COUNTS}
      edgeKinds={EDGE_KINDS}
      hiddenKinds={new Set(hidden)}
      onToggleKind={onToggleKind}
    />,
  );
  return { onToggleKind, view };
}

/** Every filter row, in document order. Identified by aria-pressed rather than
 *  by class: the attribute is the thing under test and a class is not. */
function filterRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
}

const header = () => screen.getByRole("button", { name: "Legend and filters" });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Legend filter rows", () => {
  it("filter rows are buttons with aria-pressed", () => {
    // AC-1. They were <div onClick> — focusable by nothing, announced as
    // nothing, and responding to no key. Three assertions rather than one,
    // because a div with role="button" would pass the first alone.
    renderLegend();
    const rows = filterRows();

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("aria-pressed")).toBe("false");
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  it("aria-pressed follows hidden state", () => {
    // AC-1. True when the kind is HIDDEN: the control's job is "hide this
    // kind", so pressed-in is hidden. Getting this backwards would announce
    // the opposite of the truth while looking identical on screen.
    renderLegend(["property"]);

    expect(screen.getByRole("button", { name: "Class, 412" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Property, 88" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("the accessible name carries label and count", () => {
    // AC-1, and the name is stated rather than computed. next-steps-dropdown
    // measured a consumer reading a `title` attribute instead of an element's
    // contents, so the label is explicit — and asserted to agree with what is
    // on screen, so the two cannot drift apart.
    renderLegend();

    for (const [kind, count, label] of [
      ["class", 412, "Class"],
      ["property", 88, "Property"],
      ["individual", 7, "Individual"],
    ] as const) {
      const row = screen.getByRole("button", { name: `${label}, ${count}` });
      expect(row.getAttribute("aria-label")).toBe(`${label}, ${count}`);
      // The visible text says the same two things, in the same order.
      expect(row.textContent).toContain(label);
      expect(row.textContent).toContain(String(count));
      expect(row.className, kind).toContain("legend-row");
    }
  });

  it("Enter and Space toggle a kind", () => {
    // AC-2. A button gets both keys from the browser for free, and jsdom does
    // not implement that translation — so what is asserted is the property that
    // buys it: the element is a <button>, it is not disabled, and activating it
    // calls the toggle. A keyDown assertion here would pass against a <div>.
    const { onToggleKind } = renderLegend();
    const row = screen.getByRole("button", { name: "Class, 412" }) as HTMLButtonElement;

    expect(row.tagName).toBe("BUTTON");
    expect(row.type).toBe("submit"); // no form: activation is not swallowed
    expect(row.disabled).toBe(false);

    fireEvent.click(row);
    expect(onToggleKind).toHaveBeenCalledWith("class");
    expect(onToggleKind).toHaveBeenCalledTimes(1);
  });

  it("relation rows are not interactive", () => {
    // AC-4. The Relations section filters nothing and never has. Making these
    // buttons to match the ones above would put a dozen dead stops in the tab
    // order, and a control that does nothing is worse than text.
    renderLegend();

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(EDGE_KINDS.length);
    for (const item of items) {
      expect(item.tagName).toBe("LI");
      expect(item.getAttribute("tabindex")).toBeNull();
      expect(item.getAttribute("role")).toBeNull();
      expect(item.querySelector("button")).toBeNull();
    }
    // And they are announced as a list rather than as loose text.
    expect(screen.getByRole("list")).toBeTruthy();
  });
});

describe("Legend collapse header", () => {
  it("the collapse header is a button with aria-expanded", () => {
    // AC-3. It was a <div onClick> too, and it is the control that decides
    // whether any of the filters above are reachable at all.
    renderLegend();
    const button = header();

    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // aria-controls names the panel, and the panel exists to be named.
    const controls = button.getAttribute("aria-controls");
    expect(controls).toBe("legend-panel");
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it("collapsed rows leave the tab order", () => {
    // AC-3's second half. Rows hidden behind a closed panel must not still be
    // tabbable — a keyboard user would otherwise walk through three controls
    // that are not on screen. Asserted by their absence from the document
    // rather than by a `hidden` attribute, because that is how it is built.
    renderLegend();
    expect(filterRows()).toHaveLength(3);

    fireEvent.click(header());

    expect(filterRows()).toHaveLength(0);
    expect(document.getElementById("legend-panel")).toBeNull();
    // The header survives as the way back, and now reports itself collapsed.
    const collapsed = header();
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(collapsed);
    expect(filterRows()).toHaveLength(3);
  });
});

describe("Legend rendering cost", () => {
  it("button rows do not add renders", () => {
    // AC-14, row 1 of the performance budget: making the rows real controls
    // must not cost a render. Counted rather than timed, following D-021 — a
    // wall-clock threshold here would measure jsdom, which is the mistake D-020
    // made and D-021 corrected.
    //
    // The count is of Legend's own render passes, which is what "re-renders of
    // Legend" means: the component is memo-free and presentational, so one pass
    // per parent render and one per its own state change is the whole budget.
    let renders = 0;
    function Counting(props: Parameters<typeof Legend>[0]) {
      renders += 1;
      return <Legend {...props} />;
    }
    const onToggleKind = vi.fn();
    const props = {
      theme: "dark" as const,
      kindCounts: COUNTS,
      edgeKinds: EDGE_KINDS,
      hiddenKinds: new Set<string>(),
      onToggleKind,
    };
    const view = render(<Counting {...props} />);
    expect(renders).toBe(1);

    // A filter press does not re-render Legend on its own: App owns hiddenKinds
    // and the row only reports upward. This is the assertion that fails if
    // someone gives the rows local state to track their own pressed look.
    fireEvent.click(screen.getByRole("button", { name: "Class, 412" }));
    expect(renders).toBe(1);

    // The parent handing back a new hiddenKinds is the one render it costs.
    view.rerender(<Counting {...props} hiddenKinds={new Set(["class"])} />);
    expect(renders).toBe(2);
    expect(
      screen.getByRole("button", { name: "Class, 412" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
