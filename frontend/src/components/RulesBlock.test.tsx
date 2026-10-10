// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/RulesBlock.test.tsx
================================================================================

SUMMARY
    axioms-and-reasoning Stage B, the class form's Rules block and its
    sentence builder (AC-8, AC-11, AC-12, Section 6): the rules as
    sentences; Add a rule through the builder, a group named by its
    sentence with a labelled field per blank, one command; Edit sending
    ReplaceRestriction with the old rule's key; Remove; a refusal under the
    builder and in the live region; warnings under their rule and said once;
    a rule outside the form read-only with Edit in Turtle; Check it in data
    too on shapes.ttl; a rule begun on the canvas opening the builder; and
    focus, which goes back to Add a rule after an add, to the next rule
    after a remove, and never to the page.

BASIC IDEA
    The block is rendered with its runner, the api mocked as the other form
    tests mock it, and the rules handed in by a harness that can change them,
    as a refetch for the new revision does.

INPUTS / INPUT SOURCES
    - Inline rules, shaped as /node sends them.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import type { ClassRules, RuleItem, RuleRestriction } from "../types";
import { useRunner } from "./EditParts";
import RulesBlock from "./RulesBlock";

const { openProject, runCommand } = vi.hoisted(() => ({ openProject: vi.fn(), runCommand: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand };
});

const EX = "http://example.org/shop#";
const PID = "prj-0123456789ab";
const STATE = {
  doc: "model" as const,
  ontologyId: `${PID}-model`,
  revision: 2,
  dirty: true,
  canUndo: true,
  undoLabel: "x",
  canRedo: false,
  redoLabel: null,
  triples: 10,
};

const ref = (local: string, label: string) => ({ iri: EX + local, label });

function some(local = "OrderLine", label = "Order line"): RuleRestriction {
  return {
    type: "restriction",
    form: "every",
    property: { ...ref("hasLine", "has line"), kind: "relationship" },
    kind: "some",
    filler: ref(local, label),
    n: null,
    with: null,
    key: { form: "every", property: EX + "hasLine", kind: "some", filler: EX + local, n: null },
    editable: true,
  };
}

const disjoint: RuleItem = { type: "disjoint", other: ref("Person", "Person"), editable: true };

const CHOICES = {
  properties: { items: [{ ...ref("hasLine", "has line"), kind: "relationship" as const }], total: 1 },
  classes: { items: [ref("Order", "Order"), ref("OrderLine", "Order line"), ref("Person", "Person")], total: 3 },
  things: { items: [], total: 0 },
};

function rulesOf(items: RuleItem[], extra: Partial<ClassRules> = {}): ClassRules {
  return { items, warnings: [], choices: CHOICES, ...extra };
}

let setRules: (rules: ClassRules) => void = () => undefined;
const onSelect = vi.fn();

function Harness({ initial }: { initial: ClassRules }) {
  const [rules, set] = useState(initial);
  setRules = set;
  const runner = useRunner();
  return <RulesBlock iri={EX + "Order"} name="Order" rules={rules} runner={runner} onSelect={onSelect} />;
}

async function show(rules: ClassRules) {
  await act(async () => {
    render(<Harness initial={rules} />);
  });
}

async function refetch(rules: ClassRules) {
  await act(async () => setRules(rules));
}

const said = () => projectStore.getSnapshot().announcement.text;

beforeEach(async () => {
  projectStore._reset();
  openProject.mockReset();
  runCommand.mockReset();
  onSelect.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID,
      name: "Shop",
      createdAt: "",
      updatedAt: "",
      baseIri: EX,
      prefix: "shop",
      primaryLanguage: "en",
      languages: [],
      documents: [{ file: "model.ttl", role: "model" }],
      counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockImplementation(async (_p, _d, command: string) => ({ revision: 3, label: `Did ${command}`, state: STATE }));
});

afterEach(() => {
  cleanup();
});

describe("the Rules block (5.9)", () => {
  it("lists the rules as sentences under its heading, or says there are none", async () => {
    await show(rulesOf([some(), disjoint]));
    const block = screen.getByRole("region", { name: "What is true of every Order" });
    expect(within(block).getByText("Every Order has at least one has line that is an Order line")).toBeTruthy();
    expect(within(block).getByText("No Order is a Person")).toBeTruthy();
    expect(within(block).getByText(/an Order with no line is not an error here/)).toBeTruthy();
    cleanup();
    await show(rulesOf([]));
    expect(screen.getByText("No rules yet.")).toBeTruthy();
  });

  it("adds a rule through the builder: one command, announced, focus back on Add a rule (R9, R14)", async () => {
    await show(rulesOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    // A group named by its sentence; the first blank has focus.
    const group = screen.getByRole("group", { name: "Every Order …" });
    expect(document.activeElement).toBe(within(group).getByRole("combobox", { name: "Rule" }));
    // Each blank is a labelled field.
    fireEvent.change(within(group).getByRole("combobox", { name: "Relationship or attribute" }), {
      target: { value: EX + "hasLine" },
    });
    fireEvent.change(within(group).getByRole("combobox", { name: "What is true of it" }), { target: { value: "some" } });
    const add = within(group).getByRole("button", { name: "Add" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(add);
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.change(within(group).getByRole("combobox", { name: "That is a (class)" }), { target: { value: EX + "OrderLine" } });
    expect(screen.getByRole("group", { name: "Every Order has at least one has line that is an Order line" })).toBe(group);
    await act(async () => {
      fireEvent.click(add);
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0].slice(1)).toEqual([
      "model",
      "AddRestriction",
      { class: EX + "Order", form: "every", property: EX + "hasLine", kind: "some", filler: EX + "OrderLine", n: null },
    ]);
    expect(said()).toBe("Added: Every Order has at least one has line that is an Order line. Did AddRestriction.");
    expect(screen.queryByRole("group")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a rule" })));
  });

  it("a number field for a count, and the pairs by the other class", async () => {
    await show(rulesOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Relationship or attribute" }), { target: { value: EX + "hasLine" } });
    fireEvent.change(screen.getByRole("combobox", { name: "What is true of it" }), { target: { value: "atLeast" } });
    const n = screen.getByRole("spinbutton", { name: "How many (0 to 1,000)" });
    fireEvent.change(n, { target: { value: "3" } });
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Every Order has at least 3 has line");
    fireEvent.change(screen.getByRole("combobox", { name: "Rule" }), { target: { value: "disjoint" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Never a (class)" }), { target: { value: EX + "Person" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(runCommand.mock.calls[0].slice(2)).toEqual(["AddDisjointWith", { a: EX + "Order", b: EX + "Person" }]);
  });

  it("a refusal stands under the builder and is said in the live region; the builder stays (AC-10)", async () => {
    runCommand.mockRejectedValueOnce(new Error("Order already has this rule."));
    await show(rulesOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Relationship or attribute" }), { target: { value: EX + "hasLine" } });
    fireEvent.change(screen.getByRole("combobox", { name: "What is true of it" }), { target: { value: "some" } });
    fireEvent.change(screen.getByRole("combobox", { name: "That is a (class)" }), { target: { value: EX + "OrderLine" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    const group = screen.getByRole("group");
    expect(within(group).getByText("Order already has this rule.")).toBeTruthy();
    expect(said()).toBe("Order already has this rule.");
  });

  it("Escape closes the builder and gives focus back to Add a rule", async () => {
    await show(rulesOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Rule" }), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a rule" })));
  });

  it("Edit opens the builder on the rule, and Save sends ReplaceRestriction with its key", async () => {
    const rule = some();
    await show(rulesOf([rule]));
    fireEvent.click(screen.getByRole("button", { name: "Edit: Every Order has at least one has line that is an Order line" }));
    fireEvent.change(screen.getByRole("combobox", { name: "What is true of it" }), { target: { value: "only" } });
    fireEvent.change(screen.getByRole("combobox", { name: "That is a (class)" }), { target: { value: EX + "OrderLine" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    });
    expect(runCommand.mock.calls[0].slice(2)).toEqual([
      "ReplaceRestriction",
      {
        class: EX + "Order",
        form: "every",
        property: EX + "hasLine",
        kind: "only",
        filler: EX + "OrderLine",
        n: null,
        restriction: rule.key,
      },
    ]);
  });

  it("after a remove, focus goes to the next rule once the old one has gone, then to Add a rule", async () => {
    const first = some();
    const second = some("Person", "Person");
    await show(rulesOf([first, second]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove: Every Order has at least one has line that is an Order line" }));
    });
    expect(runCommand.mock.calls[0].slice(2)).toEqual(["RemoveRestriction", { class: EX + "Order", restriction: first.key }]);
    expect(said()).toMatch(/^Removed: Every Order has at least one has line that is an Order line\./);
    await refetch(rulesOf([second]));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Every Order has at least one has line that is a Person"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Remove: / }));
    });
    await refetch(rulesOf([]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a rule" })));
  });

  it("a rule outside the form is its Turtle, read-only, with Edit in Turtle (R12)", async () => {
    const turtle = "shop:Order rdfs:subClassOf [ owl:onProperty shop:hasLine ; owl:someValuesFrom [ owl:unionOf ( shop:A shop:B ) ] ] .";
    await show(rulesOf([{ type: "turtle", turtle, editable: false }, { ...some(), editable: false }]));
    expect(screen.getByText(turtle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove:/ })).toBeNull();
    expect(screen.getByText("(read-only)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit in Turtle" }));
    expect(projectStore.getSnapshot().editorTarget?.find).toEqual([`<${EX}Order>`, "shop:Order"]);
  });

  it("no Add a rule, Edit or Remove on a class this document does not define", async () => {
    await show(rulesOf([some()], { choices: null }));
    expect(screen.queryByRole("button", { name: "Add a rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove:/ })).toBeNull();
  });

  it("warnings stand under their rule, the rest under the heading, and a new one is said once", async () => {
    await show(rulesOf([disjoint]));
    const robot = "Robot can never have members: it would be a kind of Organization and of Person.";
    await refetch(
      rulesOf([disjoint], {
        warnings: [{ text: robot, disjoint: EX + "Person" }, { text: "Order can never have members: it is a kind of X." }],
      }),
    );
    const rule = screen.getByText("No Order is a Person").closest("li")!;
    expect(within(rule).getByText(robot)).toBeTruthy();
    expect(screen.getByText("Order can never have members: it is a kind of X.").closest("li")!.parentElement!.closest("li")).toBeNull();
    expect(said()).toBe(`Warning: ${robot} Order can never have members: it is a kind of X.`);
  });

  it("Check it in data too runs CheckInData on shapes.ttl (AC-12, R13)", async () => {
    const rule = some();
    await show(rulesOf([rule]));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Check it in data too: Every Order has at least one has line that is an Order line" }),
      );
    });
    expect(runCommand.mock.calls[0].slice(1)).toEqual(["shapes", "CheckInData", { class: EX + "Order", restriction: rule.key }]);
    expect(said()).toBe("Did CheckInData. Validate checks it in your data.");
  });

  it("a rule begun on the canvas opens the builder with its class at the other end, once (AC-11)", async () => {
    await show(rulesOf([]));
    await act(async () => projectStore.startRule(EX + "Order", EX + "OrderLine"));
    const group = screen.getByRole("group", { name: "Every Order has at least one … that is an Order line" });
    expect((within(group).getByRole("combobox", { name: "That is a (class)" }) as HTMLSelectElement).value).toBe(EX + "OrderLine");
    expect(projectStore.getSnapshot().ruleDraft).toBeNull();
  });

  it("a canvas draft keeps its class when the relationship is chosen (code review)", async () => {
    await show(rulesOf([]));
    await act(async () => projectStore.startRule(EX + "Order", EX + "OrderLine"));
    fireEvent.change(screen.getByRole("combobox", { name: "Relationship or attribute" }), { target: { value: EX + "hasLine" } });
    expect((screen.getByRole("combobox", { name: "That is a (class)" }) as HTMLSelectElement).value).toBe(EX + "OrderLine");
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Every Order has at least one has line that is an Order line");
  });

  it("a canvas draft arriving while the builder is open starts it afresh (code review)", async () => {
    await show(rulesOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Rule" }), { target: { value: "disjoint" } });
    await act(async () => projectStore.startRule(EX + "Order", EX + "Person"));
    expect((screen.getByRole("combobox", { name: "That is a (class)" }) as HTMLSelectElement).value).toBe(EX + "Person");
    expect(projectStore.getSnapshot().ruleDraft).toBeNull();
  });

  it("never disables a control: every one keeps its focus (aria-disabled)", async () => {
    await show(rulesOf([some(), disjoint]));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    expect(document.querySelectorAll(".rules-block [disabled]").length).toBe(0);
  });
});
