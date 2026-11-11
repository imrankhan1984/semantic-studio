// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ChecksView.test.tsx
================================================================================

SUMMARY
    The Checks report (design-checks 5.4, AC-3, AC-7, AC-8, AC-10, AC-11,
    AC-12a): Problems before Worth a look, a passing group closed with (0)
    and a tick, *Showing 100 of N*, the stale line keeping the old findings,
    the level as a word and a mark, *open* going where 5.9 says, *Open as a
    query* handing over the check's text, Run again, a failure with Try
    again, the empty sentence, a document above the cap shown as one sentence
    with both numbers (5.10), and the render budget of Section 10. Stage B:
    hints after Worth a look (AC-13), each Open as a query named by its
    check, no Run again over the cap, a group's note, and the review aids
    (5.8): a read-aloud tick showing the server's answer, never the click
    (AC-14), the four definition tests, and the questions.

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

const { getChecks, listChecks, putReadAloud } = vi.hoisted(() => ({
  getChecks: vi.fn(),
  listChecks: vi.fn(),
  putReadAloud: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChecks,
  listChecks,
  putReadAloud,
}));

import type { CheckGroup, ChecksAids, ChecksReport } from "../api";
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
    expect(screen.getByRole("status").textContent).toBe("Checking… (31 checks, 12 hints)");
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
      fireEvent.click(within(dc03).getByRole("button", { name: "Open as a query: Terms without a definition" }));
    });
    expect(onOpenQuery).toHaveBeenCalledWith(
      "# Terms with no definition.\nSELECT ?iri WHERE { ?iri ?p ?o }",
      "DC-03 Terms without a definition",
    );
    await act(async () => {
      fireEvent.click(within(dc03).getByRole("button", { name: "Open as a query: Terms without a definition" }));
    });
    expect(listChecks).toHaveBeenCalledTimes(1);
  });

  it("renders a finding's name as text, never markup", async () => {
    getChecks.mockResolvedValue(report([{ ...GROUPS[0], findings: [{ iri: `${BASE}X`, sentence: "<img src=x onerror=alert(1)> has no label." }] }]));
    await show();
    expect(document.querySelector(".checks-findings img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)> has no label.")).toBeTruthy();
  });

  it("above the cap shows one sentence with both numbers and offers each check as a query (AC-12a)", async () => {
    const groups: CheckGroup[] = [
      { id: "DC-01", level: "Problem", heading: "Terms without an English label", fix: "Add a label.", total: 0, findings: [] },
      { id: "DC-03", level: "Problem", heading: "Terms without a definition", fix: "Write what it is.", total: 0, findings: [] },
    ];
    getChecks.mockResolvedValue(report(groups, { measures: null, overCap: { statements: 132166, cap: 10000 } }));
    const { onOpenQuery } = await show();
    expect(
      screen.getByText("Shop has 132,166 statements, more than the 10,000 these checks run on, so they were not run."),
    ).toBeTruthy();
    // No measures, no summary, no findings: nothing ran.
    expect(document.querySelector(".checks-measures")).toBeNull();
    expect(document.querySelector(".checks-summary")).toBeNull();
    expect(document.querySelector(".checks-findings")).toBeNull();
    expect(screen.getByText("These checks run on this computer.")).toBeTruthy();
    // Every check is still offered as a query, each button named by its check.
    const queryButtons = screen.getAllByRole("button", { name: /^Open as a query: / });
    expect(queryButtons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Open as a query: Terms without an English label",
      "Open as a query: Terms without a definition",
    ]);
    // Nothing ran: nothing to run again, and no run to time (Stage B follow-up).
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    expect(document.querySelector(".checks-last-run")).toBeNull();
    await act(async () => {
      fireEvent.click(queryButtons[1]); // DC-03, the one the catalogue mock returns
    });
    expect(onOpenQuery).toHaveBeenCalledWith(
      "# Terms with no definition.\nSELECT ?iri WHERE { ?iri ?p ?o }",
      "DC-03 Terms without a definition",
    );
  });

  it("puts hints after Worth a look, each with its word and mark (AC-13)", async () => {
    const hint: CheckGroup = {
      id: "H12", level: "Hint", heading: "Functional properties", fix: "Keep the mark if two values can never both be true.", total: 1,
      findings: [{ iri: `${BASE}launchTime`, sentence: "Can launch time ever have two values?" }],
    };
    getChecks.mockResolvedValue(report([hint, ...GROUPS]));
    await show();
    expect(groupHeadings()).toEqual([
      "▲ Problem · Terms without a definition (2)",
      "● Worth a look · Labels copied from the name (1)",
      "? Hint · Functional properties (1)",
      "✓ Passed · Terms without an English label (0)",
    ]);
    expect(screen.getByText("Shop: 1 problem, 1 worth a look, 1 hint")).toBeTruthy();
  });

  it("says a group's note: no reasoning result to read is not a pass", async () => {
    const h3: CheckGroup = {
      id: "H3", level: "Hint", heading: "Types reasoning gave that nobody wrote", fix: "Look at the rule that gave it.", total: 0,
      findings: [], note: "No current reasoning result: run reasoning in Edit, then Run again.",
    };
    getChecks.mockResolvedValue(report([h3]));
    await show();
    expect(screen.getByText("No current reasoning result: run reasoning in Edit, then Run again.")).toBeTruthy();
    // Nothing was checked, so no tick says it passed: the level word stays.
    expect(groupHeadings()).toEqual(["? Hint · Types reasoning gave that nobody wrote (0)"]);
  });

  it("names each Open as a query by its check's heading (Stage B follow-up)", async () => {
    await show();
    const names = screen.getAllByRole("button", { name: /^Open as a query: / }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Open as a query: Terms without a definition",
      "Open as a query: Labels copied from the name",
      "Open as a query: Terms without an English label",
    ]);
    expect(new Set(names).size).toBe(names.length);
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

const PERSON = `${BASE}Person`;
const KEY = `${BASE}Customer|subClassOf|${PERSON}`;

function aids(changes: Partial<ChecksAids> = {}): ChecksAids {
  return {
    readAloud: {
      links: [
        { key: KEY, iri: `${BASE}Customer`, sentence: "Every Customer is a Person.", agreed: false },
        { key: `${BASE}Vip|subClassOf|${BASE}Customer`, iri: `${BASE}Vip`, sentence: "Every Vip is a Customer.", agreed: true },
      ],
      total: 2,
      agreed: 1,
      editable: true,
    },
    definitions: { items: [{ iri: `${BASE}Customer`, name: "Customer", text: "A person who buys." }], total: 1 },
    questions: [
      { id: "q-000000000001", name: "Every customer", total: 12 },
      { id: "q-000000000002", name: "Overdue invoices", total: 0 },
      { id: "q-000000000003", name: "Far away", error: "Not run here: it asks another service, and these checks run on this computer." },
    ],
    ...changes,
  };
}

describe("the review aids (design-checks 5.8, Stage B)", () => {
  const box = (sentence: string) => screen.getByRole("checkbox", { name: sentence }) as HTMLInputElement;

  it("reads the hierarchy aloud with each link's tick and the count", async () => {
    getChecks.mockResolvedValue(report(GROUPS, { aids: aids() }));
    await show({ projectId: "prj-1" });
    expect(box("Every Customer is a Person.").checked).toBe(false);
    expect(box("Every Vip is a Customer.").checked).toBe(true);
    expect(screen.getByText("Read it aloud (1 of 2 read and agreed.)")).toBeTruthy();
    // The heading is in the summary, as the groups' are.
    expect(screen.getByText("Read it aloud (1 of 2 read and agreed.)").closest("summary")).toBeTruthy();
  });

  it("a tick shows the server's answer, never the click (AC-14)", async () => {
    getChecks.mockResolvedValue(report(GROUPS, { aids: aids() }));
    let answer!: (r: { key: string; agreed: boolean; count: number; total: number }) => void;
    putReadAloud.mockReturnValue(new Promise((r) => (answer = r)));
    await show({ projectId: "prj-1" });
    fireEvent.click(box("Every Customer is a Person."));
    expect(putReadAloud).toHaveBeenCalledWith("prj-1", KEY, true);
    // On its way: unticked still, every box aria-disabled (never disabled,
    // which would drop the focus), and a second click sends nothing.
    expect(box("Every Customer is a Person.").checked).toBe(false);
    expect(box("Every Vip is a Customer.").getAttribute("aria-disabled")).toBe("true");
    expect(box("Every Vip is a Customer.").disabled).toBe(false);
    fireEvent.click(box("Every Vip is a Customer."));
    expect(putReadAloud).toHaveBeenCalledTimes(1);
    await act(async () => answer({ key: KEY, agreed: true, count: 2, total: 2 }));
    expect(box("Every Customer is a Person.").checked).toBe(true);
    expect(document.querySelector(".checks-read-aloud-count")!.textContent).toBe("2 of 2 read and agreed.");
    // Nothing else is asked for: a tick is no reason to run the checks again.
    expect(getChecks).toHaveBeenCalledTimes(1);
  });

  it("a refused tick leaves the box as it was and says why", async () => {
    getChecks.mockResolvedValue(report(GROUPS, { aids: aids() }));
    putReadAloud.mockRejectedValue(new Error("That link is not in the model now. Run the checks again to read it as it stands."));
    await show({ projectId: "prj-1" });
    await act(async () => {
      fireEvent.click(box("Every Customer is a Person."));
    });
    expect(box("Every Customer is a Person.").checked).toBe(false);
    expect(screen.getByText("That link is not in the model now. Run the checks again to read it as it stands.")).toBeTruthy();
  });

  it("reads a library ontology's hierarchy without ticks", async () => {
    const library = aids({ readAloud: { ...aids().readAloud, editable: false }, questions: null });
    getChecks.mockResolvedValue(report(GROUPS, { aids: library }));
    await show({ ownBase: null, ontologyId: "space" });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Every Customer is a Person.")).toBeTruthy();
    expect(screen.getByText("Ticks are kept for a project; a library ontology is read without them.")).toBeTruthy();
    // A library entry has no saved queries of a project to run.
    expect(screen.queryByText(/^Your questions/)).toBeNull();
  });

  it("lists the four definition tests and each definition, open going to its block", async () => {
    getChecks.mockResolvedValue(report(GROUPS, { aids: aids() }));
    const { onOpen } = await show({ projectId: "prj-1" });
    const tests = [...document.querySelectorAll(".checks-definition-tests li")].map((li) => li.textContent);
    expect(tests).toEqual([
      "What kind of thing is it, and what sets it apart?",
      "Does the sentence stay true with the definition in place of the term?",
      "Can you name something almost like it that it excludes?",
      "Would a new colleague understand it?",
    ]);
    expect(screen.getByText("A person who buys.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the definition of Customer" }));
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ iri: `${BASE}Customer`, block: "definition" }),
      "edit",
    );
  });

  it("lists the saved queries as questions, one that returns nothing as Worth a look", async () => {
    getChecks.mockResolvedValue(report(GROUPS, { aids: aids() }));
    await show({ projectId: "prj-1" });
    expect(screen.getByText("Every customer: 12 rows")).toBeTruthy();
    const nothing = screen.getByText(/Overdue invoices returns nothing\./);
    expect(nothing.textContent).toBe("● Worth a look · Overdue invoices returns nothing.");
    expect(nothing.querySelector("[aria-hidden='true']")!.textContent).toBe("● ");
    expect(screen.getByText(/^Far away: Not run here/)).toBeTruthy();
  });

  it("renders a link's sentence and a definition as text, never markup", async () => {
    const hostile = aids({
      readAloud: { links: [{ key: KEY, iri: `${BASE}X`, sentence: "Every <img src=x onerror=alert(1)> is a Person.", agreed: false }], total: 1, agreed: 0, editable: true },
      definitions: { items: [{ iri: `${BASE}X`, name: "X", text: "<b>bold</b>" }], total: 1 },
    });
    getChecks.mockResolvedValue(report(GROUPS, { aids: hostile }));
    await show({ projectId: "prj-1" });
    expect(document.querySelector(".checks-aids img, .checks-aids b")).toBeNull();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
  });
});
