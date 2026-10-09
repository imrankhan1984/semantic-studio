// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/DetailPanel.test.tsx
================================================================================

SUMMARY
    The first test for DetailPanel. Covers the markup and the accessible names
    that the column-collision fix depends on, plus the shape of the panel's
    render cost as the statement count grows.

BASIC IDEA
    The collision itself is a layout defect and jsdom does not do layout, so
    these tests deliberately assert what jsdom *can* see: that the predicate
    and the value are in separate cells, that no string is shortened in
    JavaScript, and that the full text survives in the accessible name and the
    title. The visible ellipsis and the gap are CSS, checked by the rules test
    and confirmed in a browser.

    Saying that plainly matters more than a test that looks like it proves the
    fix. What would silently undo the fix is somebody "solving" truncation by
    slicing the string in React, which destroys the accessible name — so that
    is the regression this file exists to prevent.

    The cost test is a ratio, never a wall-clock threshold. An absolute limit
    encodes the machine that happened to run it; a ratio measures both halves on
    whatever machine is running now and cancels it out.

INPUTS / INPUT SOURCES
    - A mocked getNodeDetails from ../api.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6 to AC-10 and AC-13; and for
      visual-modeling-canvas.md, AC-7 (a javascript: IRI is text, never a
      link) and AC-4 (a read-only document says why, in text).
================================================================================
*/

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DetailPanel from "./DetailPanel";
import type { NodeDetails } from "../types";

const { getNodeDetails, getReasoningAbout, getWhy } = vi.hoisted(() => ({
  getNodeDetails: vi.fn(),
  getReasoningAbout: vi.fn(),
  getWhy: vi.fn(),
}));
vi.mock("../api", () => ({ getNodeDetails, getReasoningAbout, getWhy }));

const SUBJECT = "http://example.org/fibo#BONDMATCH";

// The predicate from the original defect report: clipped mid-word and run into
// the value column beside it.
const LONG_PREDICATE = {
  type: "uri" as const,
  value: "http://example.org/fibo#operatesInMunicipality",
  prefixed: "fibo:operatesInMunicipality",
  label: "operates in municipality",
};

function detailsWith(rows: number, predicate = LONG_PREDICATE): NodeDetails {
  return {
    iri: SUBJECT,
    prefixed: "fibo:BONDMATCH",
    label: "BONDMATCH",
    outgoing: Array.from({ length: rows }, (_, i) => ({
      predicate,
      object: { type: "literal" as const, value: `Paris ${i}`, lang: null, datatype: null },
    })),
    incoming: [],
    outgoingTotal: rows,
    incomingTotal: 0,
  };
}

async function renderPanel(
  details: NodeDetails,
  extra: { onExpand?: (iri: string) => void; expanding?: boolean } = {},
) {
  getNodeDetails.mockResolvedValue(details);
  await act(async () => {
    render(
      <DetailPanel
        ontologyId="o1"
        iri={SUBJECT}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        {...extra}
      />,
    );
  });
}

// One timed render, from an empty document, of a panel with `rows` statements.
// Unmounting first keeps the previous panel's DOM out of the next measurement.
async function costOf(rows: number): Promise<number> {
  cleanup();
  const start = performance.now();
  await renderPanel(detailsWith(rows));
  const elapsed = performance.now() - start;
  expect(document.querySelectorAll("table.detail-table tbody tr")).toHaveLength(rows);
  return elapsed;
}

// Median of three. A single sample of a few milliseconds is mostly scheduler
// noise, and noise in the 50-statement figure moves the ratio the dangerous
// way: an unluckily fast baseline makes an honest panel look quadratic.
async function medianCostOf(rows: number): Promise<number> {
  const samples = [await costOf(rows), await costOf(rows), await costOf(rows)];
  return samples.sort((a, b) => a - b)[1];
}

beforeEach(() => {
  getNodeDetails.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DetailPanel", () => {
  it("detail table markup keeps predicate and value in separate cells", async () => {
    // AC-6. The columns can only be made not to collide if they are columns.
    await renderPanel(detailsWith(1));
    const table = document.querySelector("table.detail-table")!;
    expect(table).toBeTruthy();

    const cells = table.querySelectorAll("tbody tr:first-child > td");
    expect(cells).toHaveLength(2);
    expect(cells[0].classList.contains("pred")).toBe(true);
    expect(cells[0].textContent).toContain("operates in municipality");
    expect(cells[1].textContent).toContain("Paris 0");
    // The predicate must not have leaked into the value cell.
    expect(cells[1].textContent).not.toContain("municipality");
  });

  it("predicate cell keeps full text in the accessible name when truncated", async () => {
    // AC-7. text-overflow is visual only, which is the reason to fix this in
    // CSS: the whole label stays available to assistive technology.
    await renderPanel(detailsWith(1));
    const link = screen.getAllByRole("button", { name: /operates in municipality/i })[0];
    expect(link.textContent).toBe("operates in municipality");
  });

  it("predicate title carries both the label and the IRI", async () => {
    // AC-8. Hovering a truncated predicate has to finish the sentence for the
    // user, so the readable label belongs in the title beside the IRI.
    await renderPanel(detailsWith(1));
    const link = screen.getAllByRole("button", { name: /operates in municipality/i })[0];
    const title = link.getAttribute("title") ?? "";
    expect(title).toContain("operates in municipality");
    expect(title).toContain(LONG_PREDICATE.value);
  });

  it("no predicate text is shortened in JavaScript", async () => {
    // AC-9. The regression that would quietly undo AC-7. A 200-character
    // predicate with no spaces must arrive in the DOM whole.
    const huge = "a".repeat(200);
    await renderPanel(
      detailsWith(1, { ...LONG_PREDICATE, label: huge, prefixed: "fibo:x" }),
    );
    const link = screen.getAllByRole("button", { name: new RegExp(huge) })[0];
    expect(link.textContent).toHaveLength(200);
    expect(link.textContent).not.toContain("…");
    expect(link.textContent).not.toContain("...");
  });

  it("term links are reachable by keyboard and show full text on focus", async () => {
    // AC-10. Real <button> elements, in the tab order, carrying their own
    // accessible name. A <span onClick> would look identical and fail this.
    await renderPanel(detailsWith(2));
    const links = screen.getAllByRole("button", { name: /operates in municipality/i });
    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      expect(link.tagName).toBe("BUTTON");
      expect(link.getAttribute("tabindex")).not.toBe("-1");
    }
    links[0].focus();
    expect(document.activeElement).toBe(links[0]);
    // The full text is on the element itself, so focus reveals it via the
    // title without needing a pointer.
    expect(links[0].getAttribute("title")).toContain(LONG_PREDICATE.value);
  });

  it("[budget] panel cost scales roughly linearly with statement count", async () => {
    // AC-13. 500 is the largest panel the application can produce, because
    // node_details caps outgoing and incoming rows at 500 each. What matters is
    // not how many milliseconds that takes on one machine but that the cost
    // follows the input rather than its square.
    //
    // There is no absolute threshold here on purpose. The 100 ms budget this
    // replaced measured 52-58 ms on the author's machine and 128-147 ms on a
    // shared Linux container, same commit — green in one place and red in every
    // other, including any CI this repo gains. Both halves of a ratio run on
    // the same hardware in the same process, so the machine cancels out.
    //
    // 15x for a 10x input is the whole tolerance. The honest ratio sits below
    // 10 because fixed per-panel work — the fetch, the header, the layout
    // around the table — is paid once and inflates the small case. Measured
    // 2026-07-28 over five runs: 4.8x to 8.9x.
    //
    // What this does NOT catch, measured rather than assumed. A quadratic does
    // not automatically read as 100x, because it inflates the 50-statement
    // baseline as well and the quotient is damped. Mutation-tested: an O(n²)
    // scan of the statement list per row, cheap enough per operation that jsdom's
    // DOM construction still dominates, measured 6.9 ms and 92.1 ms — 13.3x, and
    // passed. A quadratic has to be expensive enough to overtake the linear DOM
    // cost before this trips. Read the assertion as a bound on the growth curve,
    // not as proof of linearity, and see architecture.md D-021.
    //
    // The warm-up render is discarded. It pays for module initialisation and
    // the first JIT passes, which would otherwise land entirely on the baseline
    // and make anything that followed look linear.
    await costOf(50);

    const small = await medianCostOf(50);
    const large = await medianCostOf(500);
    const ratio = large / small;

    expect(
      ratio,
      `50 statements: ${small.toFixed(1)} ms, 500 statements: ${large.toFixed(1)} ms, ` +
        `ratio ${ratio.toFixed(1)}x for 10x the input`,
    ).toBeLessThanOrEqual(15);
  });
});

describe("DetailPanel expand control", () => {
  it("offers to draw the entity's connections, as a real button", async () => {
    // The canvas draws only what the node budget allowed, so the entity being
    // described is regularly not on it. This is the one control that fixes
    // that, and it has to be a button rather than anything clickable: the graph
    // itself is unreachable by keyboard (backlog X-1) and this must not add to
    // that list.
    const onExpand = vi.fn();
    await renderPanel(detailsWith(1), { onExpand });

    const button = screen.getByRole("button", { name: /show its connections/i });
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("disabled")).toBe(false);

    // The phrase is deliberate. "Expand the subgraph" would be a new concept to
    // learn; clicking a node already selects it, and this is one more button on
    // a panel the user has opened.
    expect(button.textContent).toBe("Show its connections");

    button.click();
    expect(onExpand).toHaveBeenCalledWith(SUBJECT);
  });

  it("renders no expand control when the panel is given no way to expand", async () => {
    // Not cosmetic: the panel is used with and without a graph behind it, and a
    // control that cannot do anything is worse than an absent one.
    await renderPanel(detailsWith(1));
    expect(screen.queryByRole("button", { name: /show its connections/i })).toBeNull();
  });

  it("says it is busy while the neighbourhood is being fetched", async () => {
    // aria-busy as well as disabled, so a screen reader user is told why the
    // control went inert rather than only finding that it did. The wording
    // changes too, because a disabled button with unchanged text reads as
    // broken.
    await renderPanel(detailsWith(1), { onExpand: vi.fn(), expanding: true });

    const button = screen.getByRole("button", { name: /drawing/i });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("DetailPanel imports (external-access Stage 2)", () => {
  it("says an entity is imported, and from where, in text (AC-21)", async () => {
    await renderPanel({ ...detailsWith(1), importedFrom: "FOAF" });
    expect(screen.getByText("Imported from FOAF (read-only)")).toBeTruthy();
  });

  it("says where a snapshot's individual came from, its row and that it is read-only (csv-data-import 5.6)", async () => {
    await renderPanel({ ...detailsWith(1), fromData: { ...{ id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true }, row: 7 } });
    expect(screen.getByText("Data from people.csv, imported 2 October 2026; sample: first 2,000 of 12,480 rows, row 7 (read-only)")).toBeTruthy();
  });

  it("says nothing of the kind for the ontology's own entity", async () => {
    await renderPanel(detailsWith(1));
    expect(screen.queryByText(/Imported from/)).toBeNull();
  });

  it("asks for the merged view only when told to", async () => {
    await renderPanel(detailsWith(1));
    expect(getNodeDetails).toHaveBeenLastCalledWith("o1", SUBJECT, false);
    cleanup();
    getNodeDetails.mockResolvedValue(detailsWith(1));
    await act(async () => {
      render(
        <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} imports />,
      );
    });
    expect(getNodeDetails).toHaveBeenLastCalledWith("o1", SUBJECT, true);
  });
});

describe("DetailPanel names (authoring-foundations 5.4.2)", () => {
  it("lists each project language with its name, and writes missing where there is none (AC-6b)", async () => {
    await renderPanel({
      ...detailsWith(1),
      names: [
        { lang: "en", value: "Organization" },
        { lang: "fr", value: null },
      ],
    });
    expect(screen.getByRole("heading", { level: 3, name: "Names" })).toBeTruthy();
    const block = document.querySelector(".detail-names")!;
    const rows = [...block.querySelectorAll("div")].map((row) => row.textContent);
    expect(rows).toEqual(["enOrganization", "frmissing"]);
    // In text, not only by colour: the word is there for a screen reader.
    expect(screen.getByText("missing").tagName).toBe("DD");
  });

  it("shows no Names block for a library ontology, whose details carry none", async () => {
    await renderPanel(detailsWith(1));
    expect(screen.queryByRole("heading", { name: "Names" })).toBeNull();
  });

  it("asks again when a project document's revision moves", async () => {
    getNodeDetails.mockResolvedValue(detailsWith(1));
    const view = render(
      <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={1} />,
    );
    await act(async () => undefined);
    const calls = getNodeDetails.mock.calls.length;
    await act(async () => {
      view.rerender(
        <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={2} />,
      );
    });
    expect(getNodeDetails.mock.calls.length).toBe(calls + 1);
  });
});

describe("DetailPanel links and editing (visual-modeling Stage 1)", () => {
  it("links an http IRI, and shows a javascript: IRI as text with Copy (AC-7)", async () => {
    await renderPanel(detailsWith(1));
    const link = screen.getByRole("link", { name: SUBJECT });
    expect(link.getAttribute("href")).toBe(SUBJECT);
    cleanup();

    const hostile = "javascript:alert(document.domain)";
    getNodeDetails.mockResolvedValue({ ...detailsWith(1), iri: hostile });
    await act(async () => {
      render(<DetailPanel ontologyId="o1" iri={hostile} onNavigate={vi.fn()} onClose={vi.fn()} />);
    });
    // The panel rendered (the assertion below is about an absence).
    expect(screen.getByRole("heading", { level: 2, name: "BONDMATCH" })).toBeTruthy();
    expect(screen.getByText(hostile).tagName).toBe("SPAN");
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy IRI" })).toBeTruthy();
  });

  it("says in text why a document cannot be edited here (AC-4)", async () => {
    getNodeDetails.mockResolvedValue(detailsWith(1));
    await act(async () => {
      render(
        <DetailPanel
          ontologyId="o1"
          iri={SUBJECT}
          onNavigate={vi.fn()}
          onClose={vi.fn()}
          readOnlyNote="From the library, read-only. Start a project from it to change it."
        />,
      );
    });
    expect(screen.getByText("From the library, read-only. Start a project from it to change it.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Edit" })).toBeNull();
  });

  it("shows the Edit section above the statements for the project's model", async () => {
    getNodeDetails.mockResolvedValue({
      ...detailsWith(1),
      kind: "class",
      outgoing: [
        {
          predicate: { type: "uri", value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", prefixed: "rdf:type" },
          object: { type: "uri", value: "http://www.w3.org/2002/07/owl#Class", prefixed: "owl:Class" },
        },
      ],
      names: [{ lang: "en", value: null }],
    });
    await act(async () => {
      render(
        <DetailPanel
          ontologyId="o1"
          iri={SUBJECT}
          onNavigate={vi.fn()}
          onClose={vi.fn()}
          editing={{ primaryLanguage: "en", languages: [] }}
        />,
      );
    });
    const edit = screen.getByRole("region", { name: "Edit" });
    const statements = screen.getByRole("heading", { name: /Statements/ });
    expect(edit.compareDocumentPosition(statements) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The form's Names block replaces the read-only one: one Names heading.
    expect(screen.getAllByRole("heading", { name: "Names" })).toHaveLength(1);
  });

  it("keeps the details on screen while a new revision is fetched", async () => {
    getNodeDetails.mockResolvedValue(detailsWith(1));
    const view = render(
      <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={1} />,
    );
    await act(async () => undefined);
    let finish: (d: NodeDetails) => void = () => {};
    getNodeDetails.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      view.rerender(
        <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={2} />,
      );
    });
    // Still the old details, not "Loading…": the field the user was in stays.
    expect(screen.getByRole("heading", { level: 2, name: "BONDMATCH" })).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    await act(async () => finish({ ...detailsWith(1), label: "BOND MATCH" }));
    expect(screen.getByRole("heading", { level: 2, name: "BOND MATCH" })).toBeTruthy();
  });
});

describe("DetailPanel after a failed refetch (found in review)", () => {
  it("drops the kept details when the entity is gone", async () => {
    getNodeDetails.mockResolvedValue(detailsWith(1));
    const view = render(
      <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={1} />,
    );
    await act(async () => undefined);
    expect(screen.getByRole("heading", { level: 2, name: "BONDMATCH" })).toBeTruthy();
    getNodeDetails.mockRejectedValueOnce(new Error(`No triples found for ${SUBJECT}`));
    await act(async () => {
      view.rerender(
        <DetailPanel ontologyId="o1" iri={SUBJECT} onNavigate={vi.fn()} onClose={vi.fn()} revision={2} />,
      );
    });
    expect(screen.getByText(`No triples found for ${SUBJECT}`)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Statements/ })).toBeNull();
  });
});

describe("DetailPanel: the Inferred block (axioms-and-reasoning 5.7)", () => {
  const X = "http://example.org/shop#";
  const ROBOT = { ...detailsWith(1), iri: `${X}Robot`, label: "Robot", prefixed: "shop:Robot" };
  const INFERRED = { projectId: "prj-1", resultKey: "3+0|model|no-data|120", imports: false };

  async function show(inferred: typeof INFERRED | null) {
    getReasoningAbout.mockClear();
    getNodeDetails.mockResolvedValue(ROBOT);
    getReasoningAbout.mockResolvedValue({
      iri: `${X}Robot`,
      neverMembers: true,
      stale: false,
      facts: [
        {
          s: `${X}Robot`, p: "http://www.w3.org/2000/01/rdf-schema#subClassOf", o: `${X}Agent`,
          sLabel: "Robot", pLabel: "subClassOf", oLabel: "Agent", sentence: "Robot is a kind of Agent",
        },
      ],
    });
    const onNavigate = vi.fn();
    await act(async () => {
      render(
        <DetailPanel ontologyId="o1" iri={`${X}Robot`} onNavigate={onNavigate} onClose={vi.fn()} inferred={inferred} />,
      );
    });
    return onNavigate;
  }

  it("lists what a current result concluded, under the statements, each with Why?", async () => {
    const onNavigate = await show(INFERRED);
    expect(getReasoningAbout).toHaveBeenCalledWith("prj-1", `${X}Robot`, false);
    const block = screen.getByRole("region", { name: "Inferred about Robot" });
    // After the statements, in words and outlined dashed: never colour alone.
    const statements = screen.getByRole("heading", { name: /^Statements/ });
    expect(statements.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.classList.contains("detail-inferred")).toBe(true);
    expect(within(block).getByRole("heading", { name: /^Inferred/ })).toBeTruthy();
    expect(within(block).getByText("Robot can never have members.")).toBeTruthy();
    expect(within(block).getByText("inferred")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Why? Robot is a kind of Agent" })).toBeTruthy();
    // The other end is a link through the app's selection.
    within(block).getByRole("button", { name: "Robot is a kind of Agent" }).click();
    expect(onNavigate).toHaveBeenCalledWith(`${X}Agent`);
  });

  it("is not there without a current result shown", async () => {
    await show(null);
    expect(getReasoningAbout).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /Inferred/ })).toBeNull();
  });
});

