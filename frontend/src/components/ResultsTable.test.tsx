// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ResultsTable.test.tsx
================================================================================

SUMMARY
    Tests for ResultsTable. Covers paging: that one page and only one page of
    rows reaches the document, that the sort runs over the whole result set
    before the slice, that the pagination controls move and disable and
    announce correctly, and that the truncation notice and the clear control
    survive all of it. Also covers the per-row "view in source" control: that
    it names its own entity, that its glyph is hidden, and that it does not
    displace the chip's meaning.

BASIC IDEA
    The point of the change this file tests is that up to 1,000 rows used to be
    in the DOM at once. So the assertions that matter most are counts of DOM
    rows, and a ratio between two render costs — never a wall-clock threshold,
    for the reason recorded in architecture.md D-021.

    Two tests need to see work that leaves no trace in the DOM: whether the
    rows were sorted again when only the page changed. They observe it by
    counting reads of `value` on the terms, which is what the sort comparator
    touches. That is indirect, and the comment on the test says what the number
    means and what it does not.

    Nothing here can test the pinned SPARQL preview. `position: sticky` is
    layout, jsdom has none, and the pinning is confirmed in a browser instead.

INPUTS / INPUT SOURCES
    - Synthetic SparqlResults built in this file. No network, no mocks.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-7 and AC-9 to AC-12 of
      query-results-area, and AC-2 and AC-11 of result-navigation.
================================================================================
*/

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultsTable from "./ResultsTable";
import type { SparqlResults, SparqlTerm } from "../types";

const PAGE_SIZE = 15;

/**
 * `count` rows of two columns. `n` is zero-padded so text sort and numeric
 * order agree, which keeps the sort assertions about paging rather than about
 * collation.
 */
function resultsWith(count: number, truncated = false): SparqlResults {
  const rows: (SparqlTerm | null)[][] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push([
      { type: "uri", value: `http://example.org/e${String(i).padStart(4, "0")}`, label: `E${String(i).padStart(4, "0")}` },
      { type: "literal", value: String(count - i) },
    ]);
  }
  return {
    vars: ["s", "n"],
    rows,
    rowCount: count,
    durationMs: 28,
    truncated,
  };
}

function renderTable(results: SparqlResults, onClear = vi.fn()) {
  const onPickIri = vi.fn();
  const onViewInSource = vi.fn();
  const view = render(
    <ResultsTable
      results={results}
      onPickIri={onPickIri}
      onViewInSource={onViewInSource}
      onClear={onClear}
    />,
  );
  return { ...view, onClear, onPickIri, onViewInSource };
}

const bodyRows = () => document.querySelectorAll("table.results-table tbody tr");
const pager = () => document.querySelector("nav.results-pager");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("ResultsTable paging", () => {
  it("renders one page of rows, not the whole set", () => {
    // AC-1, and the whole reason this file exists. 1,000 is the server cap in
    // sparql_exec.py, so this is the largest result set the application can
    // produce — before the change every one of those rows was in the document.
    renderTable(resultsWith(1000));
    expect(bodyRows()).toHaveLength(PAGE_SIZE);
  });

  it("render cost is bounded by page size, not result size", () => {
    // AC-1. A ratio, never a millisecond threshold: an absolute limit encodes
    // the machine that ran it, and both halves of a ratio run on the same
    // hardware in the same process. See architecture.md D-021.
    //
    // Ten times the rows must not cost ten times the render, because the page
    // slice is what reaches the DOM either way. What is left scaling with the
    // input is building the array and copying it — real, but not rendering.
    //
    // Mutation-tested 2026-07-31, and it is worth saying which assertion
    // caught it. Replacing the slice with the full `rows` trips the row-count
    // expectation below first; with that expectation removed so the timing
    // could be read, the same mutation measured 7.7 ms against 50.3 ms — a
    // ratio of 6.6x against a limit of 3. Both halves of this test are real.
    const cost = (count: number) => {
      cleanup();
      const results = resultsWith(count);
      const start = performance.now();
      renderTable(results);
      const elapsed = performance.now() - start;
      expect(bodyRows()).toHaveLength(PAGE_SIZE);
      return elapsed;
    };
    // Discarded: it pays for module initialisation and the first JIT passes,
    // which would otherwise land entirely on the baseline.
    cost(100);

    const median = (count: number) =>
      [cost(count), cost(count), cost(count)].sort((a, b) => a - b)[1];
    const small = median(100);
    const large = median(1000);
    const ratio = large / small;

    expect(
      ratio,
      `100 rows: ${small.toFixed(1)} ms, 1000 rows: ${large.toFixed(1)} ms, ` +
        `ratio ${ratio.toFixed(1)}x for 10x the input`,
    ).toBeLessThanOrEqual(3);
  });

  it("shows no pagination controls under sixteen rows", () => {
    // AC-2. A learner running small queries never meets a pagination control.
    renderTable(resultsWith(PAGE_SIZE));
    expect(pager()).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("shows pagination controls above fifteen rows", () => {
    // AC-2.
    renderTable(resultsWith(PAGE_SIZE + 1));
    expect(pager()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
  });

  it("page indicator reports position and total", () => {
    // AC-3. Both the header's short form and the pager's full sentence, because
    // the two are read in different places by different people.
    renderTable(resultsWith(412));
    expect(document.querySelector(".results-header")!.textContent).toContain("page 1 of 28");
    expect(document.querySelector(".results-page-status")!.textContent).toBe(
      "Page 1 of 28, showing rows 1 to 15 of 412",
    );
  });

  it("next and previous move by one page", () => {
    // AC-4.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 2 of 28");
    expect(bodyRows()[0].textContent).toContain("E0015");

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 1 of 28");
    expect(bodyRows()[0].textContent).toContain("E0000");
  });

  it("first and last jump to the ends", () => {
    // AC-4. 412 rows over 28 pages leaves 7 on the last one, which is also the
    // arithmetic most likely to be wrong.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toBe(
      "Page 28 of 28, showing rows 406 to 412 of 412",
    );
    expect(bodyRows()).toHaveLength(7);

    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 1 of 28");
    expect(bodyRows()).toHaveLength(PAGE_SIZE);
  });

  it("first and previous are disabled on page one", () => {
    // AC-5.
    renderTable(resultsWith(412));
    for (const name of ["First page", "Previous page"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("next and last are disabled on the final page", () => {
    // AC-5.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    for (const name of ["Next page", "Last page"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    expect(
      (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disabled controls carry a reason in their title", () => {
    // AC-5. The state must not be conveyed by dimming alone, and "First page"
    // as a title on a control that does nothing is not a reason.
    renderTable(resultsWith(412));
    expect(screen.getByRole("button", { name: "First page" }).getAttribute("title")).toBe(
      "Already on the first page",
    );
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("title")).toBe(
      "Next page",
    );

    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(screen.getByRole("button", { name: "Last page" }).getAttribute("title")).toBe(
      "Already on the last page",
    );
  });
});

describe("ResultsTable sorting", () => {
  it("sorting applies to the whole result set", () => {
    // AC-6. The bug this forbids is sorting the visible page: column `n` counts
    // down from 412, so its smallest value is on the LAST page of the unsorted
    // order. If the sort were per-page, page one after sorting would start at
    // 412 - 14, not at 1.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getAllByRole("columnheader")[1]);
    const first = bodyRows()[0];
    expect(within(first as HTMLElement).getByText("1")).toBeTruthy();
    expect(bodyRows()[1].textContent).toContain("2");
  });

  it("sorting returns to page one", () => {
    // AC-6. A sort whose top the user cannot see is not a sort.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 28 of 28");

    fireEvent.click(screen.getAllByRole("columnheader")[1]);
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 1 of 28");
  });

  it("changing page does not re-sort", () => {
    // AC-9, and a performance budget rather than a behaviour one. The sort is
    // memoised on the rows and the sort key, so paging must not invalidate it.
    //
    // Nothing about a re-sort shows in the DOM, so this counts reads of `value`
    // on the terms — the property the comparator reads. Rendering a page reads
    // it too, which is why the assertion is a bound and not zero: one page of
    // 15 rows x 2 columns touches each cell a small number of times, while
    // re-sorting 400 rows costs several thousand comparisons.
    //
    // Measured 2026-07-31: 30 reads, which is exactly the 15 rows x 2 columns
    // the page renders. Mutation-tested the same day by adding `page` to the
    // sort memo's dependencies: 1,626 reads, and this failed. The limit sits
    // between the two by a wide margin in both directions on purpose.
    let reads = 0;
    const results = resultsWith(400);
    results.rows = results.rows.map((row) =>
      row.map((term) => {
        const raw = term!.value;
        return {
          ...term!,
          get value() {
            reads += 1;
            return raw;
          },
        } as SparqlTerm;
      }),
    );

    renderTable(results);
    fireEvent.click(screen.getAllByRole("columnheader")[1]);
    reads = 0;

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(reads, `${reads} reads of term.value while changing page`).toBeLessThan(400);
  });
});

describe("ResultsTable view in source", () => {
  /** One row whose URI term carries a label and a prefixed form. */
  const LABELLED: SparqlResults = {
    vars: ["s"],
    rows: [
      [
        {
          type: "uri",
          value: "http://example.org/FinancialInstrument",
          label: "Financial Instrument",
          prefixed: "ex:FinancialInstrument",
        },
      ],
    ],
    rowCount: 1,
    durationMs: 9,
    truncated: false,
  };

  it("each source control names its entity", () => {
    // AC-11. "View in source" repeated down a column of forty rows tells a
    // screen reader user nothing about which row they are on. Queried by
    // computed accessible name, which is what such a user is choosing between.
    renderTable(LABELLED);
    expect(screen.getByRole("button", { name: "View Financial Instrument in source" })).toBeTruthy();
  });

  it("the source icon is hidden from assistive technology", () => {
    // AC-11. The glyph is decoration. It is also why the name is an explicit
    // aria-label rather than name-from-contents — hide the contents and there is
    // no name left to compute. See architecture.md v0.16, where the same
    // arrangement was measured on the disclosure control.
    renderTable(LABELLED);
    const control = screen.getByRole("button", { name: "View Financial Instrument in source" });
    const glyph = control.querySelector("span")!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(control.getAttribute("aria-label")).toBe("View Financial Instrument in source");
  });

  it("the source control follows its chip in the tab order", () => {
    // AC-11 and section 6: it is a real button immediately after the chip it
    // belongs to. Asserted as document order with no tabindex anywhere, for the
    // reason CatalogueList.test.tsx gives — jsdom implements neither layout nor
    // sequential focus navigation, so driving Tab would test the polyfill.
    renderTable(LABELLED);
    const cell = document.querySelector(".result-cell")!;
    const buttons = [...cell.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].classList.contains("result-chip")).toBe(true);
    expect(buttons[1].classList.contains("result-source")).toBe(true);
    for (const button of buttons) expect(button.hasAttribute("tabindex")).toBe(false);
  });

  it("the two controls do different things with the same row", () => {
    // The primary click keeps the meaning it has today — that is the learner
    // safeguard in section 7 — and the secondary one carries the prefixed form,
    // without which the pretty-printed Turtle view could not be searched.
    const { onPickIri, onViewInSource } = renderTable(LABELLED);

    fireEvent.click(screen.getByRole("button", { name: "Financial Instrument" }));
    expect(onPickIri).toHaveBeenCalledWith("http://example.org/FinancialInstrument");
    expect(onViewInSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View Financial Instrument in source" }));
    expect(onViewInSource).toHaveBeenCalledWith(
      "http://example.org/FinancialInstrument",
      "ex:FinancialInstrument",
    );
    expect(onPickIri).toHaveBeenCalledTimes(1);
  });

  it("literal and unbound cells gain no control", () => {
    // Out of scope by design, and worth an assertion because the temptation is
    // to make every cell do something. Literals are not entities.
    renderTable({
      vars: ["s", "n"],
      rows: [[{ type: "literal", value: "42" }, null]],
      rowCount: 1,
      durationMs: 4,
      truncated: false,
    });
    expect(document.querySelectorAll(".result-source")).toHaveLength(0);
    expect(document.querySelectorAll(".result-cell")).toHaveLength(0);
  });
});

describe("ResultsTable results area", () => {
  it("a new result set returns to page one", () => {
    // AC-7. The row at position 170 of the old result set has no claim to be
    // the same row in the new one.
    const { rerender } = renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 28 of 28");

    rerender(
      <ResultsTable
        results={resultsWith(300)}
        onPickIri={vi.fn()}
        onViewInSource={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(document.querySelector(".results-page-status")!.textContent).toContain("Page 1 of 20");
  });

  it("the truncation notice survives pagination", () => {
    // AC-10. The user must be able to see both that they are on page 3 of 67
    // and that 67 is not the whole truth.
    renderTable(resultsWith(1000, true));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const header = document.querySelector(".results-header")!;
    expect(header.textContent).toContain("capped at 1,000 rows");
    expect(header.textContent).toContain("page 3 of 67");
  });

  it("zero rows still offers clear", () => {
    // AC-11. An empty result set still occupies the panel.
    const { onClear } = renderTable(resultsWith(0));
    expect(screen.getByText(/No rows matched/)).toBeTruthy();
    const clear = screen.getByRole("button", { name: "Clear results" });
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(pager()).toBeNull();
  });

  it("page changes are announced politely", () => {
    // AC-12. The region is in the document from the first render, not created
    // when the page first changes: a live region added at the moment its
    // content appears is not reliably announced.
    renderTable(resultsWith(412));
    const live = document.querySelector(".results-page-status")!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(document.querySelector(".results-page-status")).toBe(live);
    expect(live.textContent).toBe("Page 2 of 28, showing rows 16 to 30 of 412");
  });

  it("focus stays on the pressed control after a page change", () => {
    // AC-12. The user pressed Next and will likely press it again.
    renderTable(resultsWith(412));
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
  });

  it("expansion does not re-render the table", () => {
    // Section 10 of result-navigation.md, row 4. Clicking a result chip that
    // names an undrawn entity sets App state three times over — the
    // neighbourhood, what the merge added, the live-region sentence — and every
    // one of those renders QueryPanel again. Under the user's cursor is a table
    // that has not changed.
    //
    // Nothing about a re-render shows in the DOM when the output is identical,
    // so this counts reads of `term.value`, which the chip's title and the
    // source control's handler both come from. Zero is the honest number here,
    // not a bound: React.memo either bailed out or it did not.
    //
    // Mutation-tested 2026-07-31: removing `memo(...)` from the export gives 60
    // reads and this fails.
    let reads = 0;
    const results = resultsWith(40);
    results.rows = results.rows.map((row) =>
      row.map((term) => {
        const raw = term!.value;
        return {
          ...term!,
          get value() {
            reads += 1;
            return raw;
          },
        } as SparqlTerm;
      }),
    );

    // The props a memoised child needs: identities that survive a parent
    // render. App and QueryPanel hand over useCallbacks for exactly this.
    const props = { results, onPickIri: vi.fn(), onViewInSource: vi.fn(), onClear: vi.fn() };
    const { rerender } = render(<ResultsTable {...props} />);
    reads = 0;

    rerender(<ResultsTable {...props} />);
    rerender(<ResultsTable {...props} />);

    expect(reads, `${reads} reads of term.value across two parent renders`).toBe(0);
  });

  it("focus moves off a control the page change disabled", () => {
    // Not an acceptance criterion, and the reason it is here anyway is in
    // CLAUDE.md: a focused button that becomes disabled is blurred to <body>
    // by the browser and never gets focus back. AC-12 asks for focus to stay
    // on the pressed control, which is impossible for the press that reaches
    // the last page, so it goes to the one control still worth pressing.
    //
    // jsdom does not reproduce the blur, so this asserts the redirect the
    // component performs rather than where the browser would have left focus.
    renderTable(resultsWith(412));
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Previous page" }));
  });
});
