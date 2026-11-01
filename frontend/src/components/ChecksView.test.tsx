// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ChecksView.test.tsx
================================================================================

SUMMARY
    The Checks report (design-checks 5.4, AC-3, AC-7, AC-8, AC-10, AC-11):
    Problems before Worth a look, a passing group closed with (0) and a tick,
    *Showing 100 of N*, the stale line keeping the old findings, the level
    as a word and a mark, *open* going where 5.9 says, *Open as a query*
    handing over the check's text, Run again, a failure with Try again, the
    empty sentence, and the render budget of Section 10.

BASIC IDEA
    api.ts is mocked, the component tests' pattern. Where *open* goes is
    the caller's to carry out (App, which App.test.tsx exercises); here the
    destination handed to it is asserted. Groups are native <details>, so
    their keyboard and expanded state are the browser's; the test asserts
    the heading sits in the summary.

INPUTS / INPUT SOURCES
    - ChecksView, with getChecks and listChecks mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { limitMs } from "../budget";

const { getChecks, listChecks } = vi.hoisted(() => ({ getChecks: vi.fn(), listChecks: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChecks,
  listChecks,
}));

import type { CheckGroup, ChecksReport } from "../api";
import ChecksView from "./ChecksView";

const BASE = "http://example.org/shop#";

function report(groups: CheckGroup[], changes: Partial<ChecksReport> = {}): ChecksReport {
  return {
    revision: 0,
    generation: 0,
    ran_ms: 213,
    empty: false,
    emptySentence: null,
    measures: {
      counts: { classes: 2, properties: 1, concepts: 0, individuals: 2 },
      hierarchy: { depth: 1, widest: 1, tops: 2 },
      documentation: { documented: 2, terms: 3 },
      reuse: { namespaces: 0, reused: 0, used: 4 },
      level: { step: 6, of: 6, name: "Formal model with data", next: null },
    },
    groups,
    skipped: [],
    notes: ["These checks run on this computer."],
    namespace: null,
    ...changes,
  };
}

const GROUPS: CheckGroup[] = [
  {
    id: "DC-07", level: "Worth a look", heading: "Labels copied from the name", fix: "Write the label for people.", total: 1,
    findings: [{ iri: `${BASE}LaunchPad`, sentence: "LaunchPad's label reads LaunchPad.", block: "label" }],
  },
  { id: "DC-01", level: "Problem", heading: "Terms without an English label", fix: "Add a label.", total: 0, findings: [] },
  {
    id: "DC-03", level: "Problem", heading: "Terms without a definition", fix: "Write what it is.", total: 2,
    findings: [
      { iri: `${BASE}Rover`, sentence: "Rover has no definition.", block: "definition" },
      { iri: "http://xmlns.com/foaf/0.1/Person", sentence: "Person has no definition.", block: "definition" },
    ],
  },
];

beforeEach(() => {
  getChecks.mockResolvedValue(report(GROUPS));
  listChecks.mockResolvedValue([
    { id: "DC-03", level: "Problem", heading: "Terms without a definition", fix: "Write what it is.", query: "# Terms with no definition.\nSELECT ?iri WHERE { ?iri ?p ?o }" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show(props: Partial<React.ComponentProps<typeof ChecksView>> = {}) {
  const handlers = { onOpen: vi.fn(), onOpenQuery: vi.fn() };
  let rerender!: (ui: React.ReactElement) => void;
  const element = (more: Partial<React.ComponentProps<typeof ChecksView>> = {}) => (
    <ChecksView ontologyId="prj-1-model" name="Shop" revision={0} ownBase={BASE} {...handlers} {...props} {...more} />
  );
  await act(async () => {
    ({ rerender } = render(element()));
  });
  return { ...handlers, rerender: (more: Partial<React.ComponentProps<typeof ChecksView>>) => rerender(element(more)) };
}

const groupHeadings = () => [...document.querySelectorAll(".checks-group-heading")].map((h) => h.textContent);

describe("the Checks report (design-checks 5.4)", () => {
  it("asks once, on mount, and shows the measures and the summary", async () => {
    await show();
    expect(getChecks).toHaveBeenCalledTimes(1);
    expect(getChecks.mock.calls[0][0]).toBe("prj-1-model");
    expect(screen.getByText("Shop: 1 problem, 1 worth a look")).toBeTruthy();
    expect(screen.getByText("2 classes · 1 property · 0 concepts · 2 individuals")).toBeTruthy();
    expect(screen.getByText("Level: Formal model with data (step 6 of 6)")).toBeTruthy();
    expect(screen.getByText("Last run 0.2 s")).toBeTruthy();
    expect(screen.getByText("These checks run on this computer.")).toBeTruthy();
  });

  it("orders Problems first, passing groups after, closed with (0) and a tick (AC-3)", async () => {
    await show();
    expect(groupHeadings()).toEqual([
      "▲ Problem · Terms without a definition (2)",
      "● Worth a look · Labels copied from the name (1)",
      "✓ Passed · Terms without an English label (0)",
    ]);
    const details = [...document.querySelectorAll<HTMLDetailsElement>("details.checks-group")];
    expect(details.map((d) => d.open)).toEqual([true, true, false]);
    // The heading is inside the summary, the level a word with its mark
    // hidden from a screen reader: no meaning rests on colour (AC-11).
    for (const d of details) expect(d.querySelector("summary > h4")).toBeTruthy();
    const marks = [...document.querySelectorAll(".checks-level-word > [aria-hidden='true']")];
    expect(marks).toHaveLength(3);
  });

  it("says Showing 100 of N with the true total (AC-7)", async () => {
    const many: CheckGroup = {
      id: "DC-01", level: "Problem", heading: "Terms without an English label", fix: "Add a label.", total: 1500,
      findings: Array.from({ length: 100 }, (_, i) => ({ iri: `${BASE}C${i}`, sentence: `C${i} has no English label.` })),
    };
    getChecks.mockResolvedValue(report([many]));
    await show();
    expect(screen.getByText("Showing 100 of 1,500")).toBeTruthy();
    expect(document.querySelectorAll(".checks-findings li")).toHaveLength(100);
    expect(groupHeadings()[0]).toBe("▲ Problem · Terms without an English label (1,500)");
  });

  it("says a group's failure in that group, and the others still show (AC-7)", async () => {
    getChecks.mockResolvedValue(report([{ ...GROUPS[1], error: "This check did not finish in 30 seconds." }, GROUPS[0]]));
    await show();
    expect(screen.getByText("This check did not finish in 30 seconds.")).toBeTruthy();
    expect(screen.getByText("LaunchPad's label reads LaunchPad.")).toBeTruthy();
  });

  it("keeps the old findings under the stale line after an edit, until Run again (AC-8)", async () => {
    const { rerender } = await show();
    expect(screen.queryByText("The model has changed since these checks ran.")).toBeNull();
    rerender({ revision: 1 });
    expect(screen.getByText("The model has changed since these checks ran.")).toBeTruthy();
    expect(screen.getByText("Rover has no definition.")).toBeTruthy();
    expect(getChecks).toHaveBeenCalledTimes(1);
    getChecks.mockResolvedValue(report(GROUPS, { revision: 1 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    });
    expect(getChecks).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("The model has changed since these checks ran.")).toBeNull();
  });

  it("says it is checking while it runs, in a live region", async () => {
    let answer!: (r: ChecksReport) => void;
    getChecks.mockReturnValue(new Promise<ChecksReport>((r) => (answer = r)));
    await show();
    expect(screen.getByRole("status").textContent).toBe("Checking… (28 checks)");
    expect(document.querySelector(".checks-view")!.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Run again" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => answer(report(GROUPS)));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("says a whole failure in one sentence with Try again", async () => {
    getChecks.mockRejectedValueOnce(new Error("The server did not answer."));
    await show();
    expect(screen.getByText("The checks could not run. The server did not answer.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByText("Rover has no definition.")).toBeTruthy();
  });

  it("says when there is nothing to check yet", async () => {
    getChecks.mockResolvedValue(report([], { empty: true, emptySentence: "Nothing to check yet: add a class or a concept." }));
    await show();
    expect(screen.getByText("Nothing to check yet: add a class or a concept.")).toBeTruthy();
  });

  it("open leads a project's own term to Edit and a borrowed one to Explore (AC-10)", async () => {
    const { onOpen } = await show();
    fireEvent.click(screen.getByRole("button", { name: "Open: Rover has no definition." }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ iri: `${BASE}Rover` }), "edit");
    fireEvent.click(screen.getByRole("button", { name: "Open: Person has no definition." }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ iri: "http://xmlns.com/foaf/0.1/Person" }), "explore");
  });

  it("open leads a library's term to Explore", async () => {
    const { onOpen } = await show({ ownBase: null, ontologyId: "space" });
    fireEvent.click(screen.getByRole("button", { name: "Open: Rover has no definition." }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), "explore");
  });

  it("Open as a query hands over the check's text and its name, reading the catalogue once (AC-6)", async () => {
    const { onOpenQuery } = await show();
    const dc03 = document.querySelectorAll("details.checks-group")[0] as HTMLElement;
    await act(async () => {
      fireEvent.click(within(dc03).getByRole("button", { name: "Open as a query" }));
    });
    expect(onOpenQuery).toHaveBeenCalledWith(
      "# Terms with no definition.\nSELECT ?iri WHERE { ?iri ?p ?o }",
      "DC-03 Terms without a definition",
    );
    await act(async () => {
      fireEvent.click(within(dc03).getByRole("button", { name: "Open as a query" }));
    });
    expect(listChecks).toHaveBeenCalledTimes(1);
  });

  it("renders a finding's name as text, never markup", async () => {
    getChecks.mockResolvedValue(report([{ ...GROUPS[0], findings: [{ iri: `${BASE}X`, sentence: "<img src=x onerror=alert(1)> has no label." }] }]));
    await show();
    expect(document.querySelector(".checks-findings img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)> has no label.")).toBeTruthy();
  });

  it("[budget] renders 28 groups and 1,000 findings within 200 ms, median of 7", async () => {
    const groups: CheckGroup[] = Array.from({ length: 28 }, (_, g) => ({
      id: `DC-${String(g + 1).padStart(2, "0")}`,
      level: g % 2 ? "Worth a look" : "Problem",
      heading: `Check ${g + 1}`,
      fix: "Fix it.",
      total: g < 10 ? 100 : 0,
      findings: g < 10 ? Array.from({ length: 100 }, (_, i) => ({ iri: `${BASE}T${g}-${i}`, sentence: `T${g}-${i} is wrong.` })) : [],
    }));
    getChecks.mockResolvedValue(report(groups));
    const once = async () => {
      cleanup();
      const start = performance.now();
      await act(async () => {
        render(<ChecksView ontologyId="big" name="Big" revision={0} ownBase={null} onOpen={() => {}} onOpenQuery={() => {}} />);
      });
      const elapsed = performance.now() - start;
      expect(document.querySelectorAll(".checks-findings li")).toHaveLength(1000);
      return elapsed;
    };
    await once(); // warm-up: module initialisation and the first JIT passes
    const runs: number[] = [];
    for (let i = 0; i < 7; i += 1) runs.push(await once());
    runs.sort((a, b) => a - b);
    expect(runs[3], `median ${runs[3].toFixed(1)} ms of ${runs.map((r) => r.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(
      limitMs(200),
    );
  });
});
