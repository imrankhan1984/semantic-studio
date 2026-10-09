// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ReasoningPanel.test.tsx
================================================================================

SUMMARY
    Reason, Stop, Show inferred and the results panel (axioms-and-reasoning
    5.1 to 5.7, Section 6, AC-1, AC-2, AC-6): every state of Section 6's
    table, the start and the end announced and the seconds not, Stop, a
    result gone stale with Reason again, Include data snapshots, a group
    paged with Show more, facts about imported terms collapsed, and a run
    that outlives its project ignored.

BASIC IDEA
    The run lives in the project store, so the store is opened for real over
    a mocked api.ts, and the controls and the panel are rendered as App
    renders them. A run is a promise the test resolves when it chooses, so
    the Running state can be looked at before it ends.

INPUTS / INPUT SOURCES
    - A mocked api.ts: openProject, listData, reasonProject, stopReasoning,
      getReasoningPage, getWhy.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectKind, ReasoningGroup, ReasoningResult } from "../types";

const { openProject, listData, reasonProject, stopReasoning, getReasoningPage, getWhy } = vi.hoisted(() => ({
  openProject: vi.fn(),
  listData: vi.fn(),
  reasonProject: vi.fn(),
  stopReasoning: vi.fn(),
  getReasoningPage: vi.fn(),
  getWhy: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  listData,
  reasonProject,
  stopReasoning,
  getReasoningPage,
  getWhy,
}));

import { projectStore } from "../state/projectStore";
import ReasoningPanel, { ReasonControls } from "./ReasoningPanel";

const PID = "prj-0123456789ab";
const X = "http://example.org/shop#";
const T = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const NOW = { revision: 3, generation: 0, imports: false };

function fact(s: string, o: string, sentence: string) {
  return { s: X + s, p: T, o: X + o, sLabel: s, pLabel: "type", oLabel: o, sentence };
}

function group(kind: ReasoningGroup["kind"], items: ReturnType<typeof fact>[], total = items.length): ReasoningGroup {
  return { kind, total, offset: 0, items };
}

function result(changes: Partial<ReasoningResult> = {}): ReasoningResult {
  return {
    status: "done",
    key: "3+0|model|no-data",
    includeData: false,
    imports: false,
    basis: { revision: 3, generation: 0, imports: false },
    durationMs: 4200,
    statements: 39,
    sentence: null,
    problems: [
      {
        kind: "neverMembers",
        sentence: "Robot can never have members: it is a kind of Person and a kind of Organization, and no Person is an Organization.",
        subject: X + "Robot",
        causes: [
          { s: X + "Robot", p: "sub", o: X + "Person", sentence: "Robot is a kind of Person", inferred: false },
          { s: X + "Robot", p: "sub", o: X + "Organization", sentence: "Robot is a kind of Organization", inferred: false },
          { s: X + "Person", p: "dw", o: X + "Organization", sentence: "no Person is an Organization", inferred: false },
        ],
        reasoner: "Disjoint classes Person and Organization have a common individual a test member of Robot (the reasoner's words)",
      },
    ],
    groups: [
      group("kinds", [fact("Employee", "Agent", "Employee is a kind of Agent")]),
      group("same", []),
      group("memberships", [fact("alice", "Person", "Alice is a Person"), fact("acme", "Organization", "Acme is an Organization")]),
      group("links", []),
    ],
    importedFacts: group("imported", []),
    stale: false,
    ...changes,
  };
}

let onSelect: ReturnType<typeof vi.fn<(iri: string) => void>>;

function view(kind: ProjectKind | null = "ontology", now = NOW, hasData = false) {
  return (
    <>
      <ReasonControls kind={kind} now={now} hasData={hasData} />
      <ReasoningPanel projectId={PID} kind={kind} hasData={hasData} now={now} onSelect={onSelect} />
    </>
  );
}

async function setup(kind: ProjectKind | null = "ontology", hasData = false) {
  await projectStore.open(PID);
  onSelect = vi.fn<(iri: string) => void>();
  return render(view(kind, NOW, hasData));
}

/** A run the test answers when it chooses. */
function pending(): { answer: (r: ReasoningResult) => Promise<void> } {
  let resolve: (r: ReasoningResult) => void = () => {};
  reasonProject.mockReturnValue(new Promise<ReasoningResult>((done) => (resolve = done)));
  return {
    answer: async (r) => {
      await act(async () => {
        resolve(r);
      });
    },
  };
}

const said = () => projectStore.getSnapshot().announcement.text;
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  projectStore._reset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: X, prefix: "shop", primaryLanguage: "en",
      languages: [], documents: [], counts: {}, kind: "ontology",
    },
    documents: [
      {
        doc: "model", ontologyId: `${PID}-model`, revision: 3, dirty: false, canUndo: false, undoLabel: null,
        canRedo: false, redoLabel: null, triples: 39,
      },
    ],
    recovery: { available: false, draftTime: null },
  });
  listData.mockResolvedValue({ generation: 0, snapshots: [] });
  stopReasoning.mockResolvedValue({ stopped: true });
});
afterEach(cleanup);

describe("Reason and the results panel (Section 6)", () => {
  it("is empty before a run, says what reasoning does, and offers no Show inferred yet", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Reason" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show inferred/ })).toBeNull();
    expect(screen.getByText(/draws conclusions about the classes and things you have/)).toBeTruthy();
    expect(screen.getByText("Press Reason to see what follows from your model.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Results" })).toBeTruthy();
    // No snapshot switched on: no data checkbox.
    expect(screen.queryByLabelText("Include data snapshots")).toBeNull();
  });

  it("announces the start, reads Stop on the same button while running, and announces the end", async () => {
    await setup();
    const run = pending();
    const button = screen.getByRole("button", { name: "Reason" });
    button.focus();
    await press("Reason");
    expect(said()).toBe("Reasoning started.");
    expect(reasonProject).toHaveBeenCalledWith(PID, false, false);
    // One button whose name changes: focus is still on it.
    expect(button.textContent).toBe("Stop");
    expect(document.activeElement).toBe(button);
    // The seconds are counted on the status line, which is not a live region.
    const status = document.querySelector(".reasoning-status")!;
    expect(status.textContent).toMatch(/^Reasoning… \d+ s$/);
    expect(status.getAttribute("role")).toBeNull();
    expect(status.getAttribute("aria-live")).toBeNull();
    await run.answer(result());
    expect(said()).toBe("Reasoned in 4 s: 1 problem, 3 new facts.");
    expect(button.textContent).toBe("Reason");
    expect(status.textContent).toBe("Reasoned in 4 s: 1 problem, 3 new facts");
    // Show inferred: on after a run, pressed state in words and aria.
    const toggle = screen.getByRole("button", { name: /Show inferred/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(projectStore.getSnapshot().showInferred).toBe(true);
  });

  it("shows problems first, then the groups with their true counts, each fact a link with Why?", async () => {
    await setup();
    const run = pending();
    await press("Reason");
    await run.answer(result());
    const panel = screen.getByRole("region", { name: "Results: reasoned in 4 s" });
    const headings = within(panel).getAllByRole("heading").map((h) => h.textContent);
    // Empty groups are not listed.
    expect(headings).toEqual(["Results: reasoned in 4 s", "Problems (1)", "New kinds (1)", "New memberships (2)"]);
    // A problem's subject and each cause are links that select.
    fireEvent.click(within(panel).getByRole("button", { name: /^Robot can never have members/ }));
    expect(onSelect).toHaveBeenLastCalledWith(X + "Robot");
    const causes = within(panel).getByRole("list", { name: "Caused by" });
    expect(within(causes).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Robot is a kind of Person stated",
      "Robot is a kind of Organization stated",
      "no Person is an Organization stated",
    ]);
    fireEvent.click(within(causes).getByRole("button", { name: "no Person is an Organization" }));
    expect(onSelect).toHaveBeenLastCalledWith(X + "Person");
    // The probe's own words behind Why?, as a disclosure.
    const why = within(panel).getAllByRole("button", { name: "Why?" })[0];
    expect(why.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(why);
    expect(screen.getByText(/the reasoner's words/)).toBeTruthy();
    // Each fact: its sentence selects its subject, and it has its own Why?.
    fireEvent.click(within(panel).getByRole("button", { name: "Alice is a Person" }));
    expect(onSelect).toHaveBeenLastCalledWith(X + "alice");
    expect(within(panel).getByRole("button", { name: "Why? Alice is a Person" })).toBeTruthy();
    expect(screen.getByText(/Values in your data are checked by Validate \(SHACL\), not here\./)).toBeTruthy();
  });

  it("says when nothing follows and nothing contradicts", async () => {
    await setup();
    const run = pending();
    await press("Reason");
    await run.answer(result({ problems: [], groups: [], importedFacts: group("imported", []) }));
    expect(screen.getByText("Nothing new follows, and nothing contradicts.")).toBeTruthy();
  });

  it("stops a run with Stop, and says so", async () => {
    await setup();
    const run = pending();
    await press("Reason");
    await press("Stop");
    expect(stopReasoning).toHaveBeenCalledWith(PID);
    await run.answer(result({ status: "stopped", sentence: "Stopped. Nothing was concluded.", problems: [], groups: [] }));
    expect(screen.getAllByText("Stopped. Nothing was concluded.").length).toBeGreaterThan(0);
    expect(said()).toBe("Stopped. Nothing was concluded.");
    expect(screen.getByRole("button", { name: "Reason" })).toBeTruthy();
    // No marks to show for a run that concluded nothing.
    expect(screen.queryByRole("button", { name: /Show inferred/ })).toBeNull();
  });

  it.each([
    ["timedOut", "Stopped after 30 seconds. Try without the data snapshots, or with fewer imports."],
    ["failed", "The reasoner stopped with an error: the process ended with exit code 1"],
    [
      "tooLarge",
      "This project has 250,000 statements to reason over. Semantic Studio reasons over at most 200,000: try without the data snapshots, or with fewer imports.",
    ],
  ] as const)("ends %s with its sentence", async (status, sentence) => {
    await setup();
    const run = pending();
    await press("Reason");
    await run.answer(result({ status, sentence, problems: [], groups: [] }));
    expect(document.querySelector(".reasoning-ending")!.textContent).toBe(sentence);
    // Announced as a sentence: a reasoner's error line gets its full stop.
    expect(said()).toBe(sentence.endsWith(".") ? sentence : `${sentence}.`);
  });

  it("goes stale when the model moves: the panel says so, Show inferred hides, Reason again runs", async () => {
    const { rerender } = await setup();
    const run = pending();
    await press("Reason");
    await run.answer(result());
    expect(screen.getByRole("button", { name: /Show inferred/ })).toBeTruthy();
    rerender(view("ontology", { ...NOW, revision: 4 }));
    expect(screen.getByText("The model changed after this run.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show inferred/ })).toBeNull();
    // The heading no longer claims the run's time for this model.
    expect(screen.getByRole("heading", { name: "Results" })).toBeTruthy();
    // The data generation and the imports switch count too.
    rerender(view("ontology", { ...NOW, generation: 2 }));
    expect(screen.getByText("The model changed after this run.")).toBeTruthy();
    rerender(view("ontology", { ...NOW, imports: true }));
    expect(screen.getByText("The model changed after this run.")).toBeTruthy();
    const again = pending();
    await press("Reason again");
    expect(reasonProject).toHaveBeenLastCalledWith(PID, false, true);
    await again.answer(result({ basis: { revision: 3, generation: 0, imports: true } }));
    expect(screen.queryByText("The model changed after this run.")).toBeNull();
  });

  it("is not offered in a taxonomy", async () => {
    await setup("taxonomy");
    expect(screen.queryByRole("button", { name: "Reason" })).toBeNull();
    expect(screen.getByText("Reasoning is for ontology projects.")).toBeTruthy();
  });

  it("includes the snapshots only when asked, off by default", async () => {
    await setup("ontology", true);
    const box = screen.getByLabelText("Include data snapshots") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/slower: about a second per 1,000 rows/)).toBeTruthy();
    const first = pending();
    await press("Reason");
    expect(reasonProject).toHaveBeenLastCalledWith(PID, false, false);
    await first.answer(result());
    await act(async () => {
      fireEvent.click(box);
    });
    expect(box.checked).toBe(true);
    const second = pending();
    await press("Reason");
    expect(reasonProject).toHaveBeenLastCalledWith(PID, true, false);
    await second.answer(result());
  });

  it("pages a long group with Show more, the true total always in its heading", async () => {
    await setup();
    const many = Array.from({ length: 200 }, (_, i) => fact(`e${i}`, "Person", `e${i} is a Person`));
    const run = pending();
    await press("Reason");
    await run.answer(result({ problems: [], groups: [group("memberships", many, 450)] }));
    expect(screen.getByRole("heading", { name: "New memberships (450)" })).toBeTruthy();
    expect(screen.getByText("200 of 450 shown")).toBeTruthy();
    getReasoningPage.mockResolvedValue({
      ...group("memberships", Array.from({ length: 200 }, (_, i) => fact(`f${i}`, "Person", `f${i} is a Person`)), 450),
      offset: 200,
      stale: false,
    });
    await press("Show more");
    expect(getReasoningPage).toHaveBeenCalledWith(PID, "memberships", 200, false);
    expect(screen.getByText("400 of 450 shown")).toBeTruthy();
    expect(screen.getByRole("button", { name: "f199 is a Person" })).toBeTruthy();
  });

  it("counts facts about imported terms alone in one line, collapsed until opened", async () => {
    await setup();
    const run = pending();
    await press("Reason");
    await run.answer(
      result({ problems: [], importedFacts: group("imported", [fact("Agent", "Thing", "Agent is a kind of Thing")], 12) }),
    );
    const line = screen.getByRole("button", { name: "12 facts about imported terms" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Agent is a kind of Thing" })).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Agent is a kind of Thing" })).toBeTruthy();
  });

  it("says a refused run in the panel and the live region", async () => {
    await setup();
    reasonProject.mockRejectedValue(new Error("A run is already going."));
    await press("Reason");
    expect(screen.getByRole("alert").textContent).toBe("A run is already going.");
    expect(said()).toBe("A run is already going.");
    expect(screen.getByRole("button", { name: "Reason" })).toBeTruthy();
  });

  it("ignores a run that outlives its project, and the panel can be closed", async () => {
    await setup();
    const run = pending();
    await press("Reason");
    await act(async () => {
      projectStore.reset();
    });
    await run.answer(result());
    expect(projectStore.getSnapshot().reasoning).toBeNull();
    expect(projectStore.getSnapshot().reasoningSince).toBeNull();
    cleanup();
    await setup();
    const second = pending();
    await press("Reason");
    await second.answer(result());
    await press("Close the results");
    expect(screen.queryByRole("region")).toBeNull();
  });
});
