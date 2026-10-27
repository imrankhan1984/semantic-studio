// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NewEntityForm.test.tsx
================================================================================

SUMMARY
    The first tests of the names-first form, for attribute-reuse 5.1 (AC-1,
    AC-12): suggestions once the name has two characters and typing rests;
    only the project's own properties of the kind asked, the other kind
    never; an answer older than the latest dropped; Enter still Create; the
    live region saying the count once, never the list; the suggestions'
    buttons in the tab order between the name and More options; and the
    choice a refused Create gives. And the *Kind of class* group of
    attribute-reuse 5.6 (AC-13): a fieldset and legend, two radios with
    what each means, the default and its hint, the kind sent with Create,
    and aria-disabled while a command runs.

BASIC IDEA
    The form is rendered alone with the api mocked: searchNodes and
    getNodeDetails answer as the server would, through promises a test can
    hold back to make one answer arrive after a newer one. Fake timers
    stand in for the 250 ms pause.

INPUTS / INPUT SOURCES
    - Inline search hits and node details.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeDetails } from "../types";
import NewEntityForm from "./NewEntityForm";
import { SUGGEST_MS } from "./useSuggestions";

const { searchNodes, getNodeDetails } = vi.hoisted(() => ({ searchNodes: vi.fn(), getNodeDetails: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, searchNodes, getNodeDetails };
});

const HR = "http://example.org/hr#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

function details(local: string, domain: NodeDetails["domain"], range?: { value: string; prefixed?: string; label?: string }): NodeDetails {
  return {
    iri: HR + local,
    prefixed: `hr:${local}`,
    label: local,
    outgoing: range
      ? [{ predicate: { type: "uri", value: "http://www.w3.org/2000/01/rdf-schema#range" }, object: { type: "uri", ...range } }]
      : [],
    incoming: [],
    outgoingTotal: 1,
    incomingTotal: 0,
    domain,
  } as NodeDetails;
}

const HAS_NAME = details(
  "hasName",
  { form: "one", classes: [{ iri: HR + "Employee", label: "Employee" }] },
  { value: XSD + "string", prefixed: "xsd:string" },
);
const HAS_NICK = details(
  "hasNick",
  { form: "union", classes: [{ iri: HR + "Employee", label: "Employee" }, { iri: HR + "Contractor", label: "Contractor" }] },
);

const onSubmit = vi.fn();
const onUse = vi.fn();

function show(kind: "datatypeProperty" | "objectProperty" = "datatypeProperty") {
  render(
    <NewEntityForm
      title="New attribute of Manager"
      primaryLanguage="en"
      datatypes
      onSubmit={onSubmit}
      onCancel={() => undefined}
      suggest={{ ontologyId: "prj-0123456789ab-model", kind, className: "Manager", onUse }}
    />,
  );
  return screen.getByLabelText("Name (en)") as HTMLInputElement;
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

async function pause(ms = SUGGEST_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // The search's and the details' promises settle.
  await act(async () => undefined);
  await act(async () => undefined);
}

const status = () => document.querySelector('[role="status"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of [searchNodes, getNodeDetails, onSubmit, onUse]) m.mockReset();
  searchNodes.mockResolvedValue([{ id: HR + "hasName" }, { id: HR + "hasNick" }]);
  getNodeDetails.mockImplementation(async (_id: string, iri: string) => (iri === HR + "hasName" ? HAS_NAME : HAS_NICK));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("suggestions while typing (attribute-reuse 5.1)", () => {
  it("waits for two characters and the pause, then lists what the project has", async () => {
    const field = show();
    await type(field, "h");
    await pause();
    expect(searchNodes).not.toHaveBeenCalled();
    await type(field, "ha");
    await pause(SUGGEST_MS - 1);
    expect(searchNodes).not.toHaveBeenCalled();
    await pause(1);
    // The document only, not its imports; one kind; five at most.
    expect(searchNodes).toHaveBeenCalledWith("prj-0123456789ab-model", "ha", false, "datatypeProperty", expect.any(AbortSignal), 5);
    expect(screen.getByText("Already in this project")).toBeTruthy();
    expect(screen.getByText("hasName, an attribute of Employee (text).")).toBeTruthy();
    expect(screen.getByText("hasNick, an attribute of Employee or Contractor.")).toBeTruthy();
    const use = screen.getByRole("button", { name: "Use it on Manager (hasName)" });
    expect(use.textContent).toBe("Use it on Manager");
    // The name says what is on screen first, then which one (label in name).
    expect(use.getAttribute("aria-label")!.startsWith(use.textContent!)).toBe(true);
    await act(async () => fireEvent.click(use));
    expect(onUse).toHaveBeenCalledWith({ iri: HR + "hasName", label: "hasName" });
  });

  it("asks for relationships only on Add relationship: the other kind is never listed", async () => {
    const field = show("objectProperty");
    await type(field, "rep");
    await pause();
    expect(searchNodes.mock.calls[0][3]).toBe("objectProperty");
  });

  it("drops an answer older than the latest", async () => {
    let release: (value: unknown) => void = () => undefined;
    searchNodes.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    searchNodes.mockResolvedValueOnce([{ id: HR + "hasNick" }]);
    const field = show();
    await type(field, "ha");
    await pause();
    await type(field, "hasN");
    await pause();
    expect(screen.getByText("hasNick, an attribute of Employee or Contractor.")).toBeTruthy();
    // The search it replaced was aborted (CF-4), and answering last it is not shown.
    expect((searchNodes.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
    expect((searchNodes.mock.calls[1][4] as AbortSignal).aborted).toBe(false);
    await act(async () => release([{ id: HR + "hasName" }]));
    await pause(0);
    expect(screen.queryByText("hasName, an attribute of Employee (text).")).toBeNull();
  });

  it("shows nothing when the search fails, and Create still works", async () => {
    searchNodes.mockRejectedValue(new Error("down"));
    const field = show();
    await type(field, "hasName");
    await pause();
    expect(screen.queryByText("Already in this project")).toBeNull();
    await act(async () => {
      fireEvent.submit(field.form!);
    });
    expect(onSubmit).toHaveBeenCalledWith({ name: "hasName", datatype: "xsd:string" });
  });

  it("Enter in the name field still creates", async () => {
    const field = show();
    await type(field, "hasName");
    await pause();
    expect(screen.getByText("Already in this project")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(field.form!);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("says the count once typing rests, never the list (5.5)", async () => {
    const field = show();
    expect(status()).toBe("");
    await type(field, "has");
    await pause();
    expect(status()).toBe("2 existing attributes match");
    searchNodes.mockResolvedValue([{ id: HR + "hasName" }]);
    await type(field, "hasNa");
    await pause();
    expect(status()).toBe("1 existing attribute matches");
  });

  it("puts the suggestions between the name and More options", async () => {
    const field = show();
    await type(field, "has");
    await pause();
    // jsdom has no sequential focus navigation: document order is the tab
    // order here, as no control sets a positive tabIndex.
    const order = [...document.querySelectorAll<HTMLElement>("input, button, select")];
    const use = screen.getByRole("button", { name: "Use it on Manager (hasName)" });
    const more = screen.getByRole("button", { name: "More options" });
    expect(order.indexOf(field)).toBe(0);
    expect(order.indexOf(use)).toBeGreaterThan(order.indexOf(field));
    expect(order.indexOf(use)).toBeLessThan(order.indexOf(more));
    expect(order.every((el) => el.tabIndex >= 0 || el.getAttribute("type") === "hidden")).toBe(true);
  });
});

describe("a Create refused because the name exists (5.1)", () => {
  it("offers the same choice in place of the sentence", () => {
    const onExisting = vi.fn();
    const onAnother = vi.fn();
    render(
      <NewEntityForm
        title="New attribute of Manager"
        primaryLanguage="en"
        error="There is already an attribute hasName, of Employee."
        existing={{ sentence: "There is already an attribute hasName, of Employee.", className: "Manager", onUse: onExisting, onAnother }}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getAllByText("There is already an attribute hasName, of Employee.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Use it on Manager" }));
    expect(onExisting).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose another name" }));
    expect(onAnother).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Name (en)"));
  });
});

/** What a screen reader reads after an element's name: its description. */
function described(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
}

describe("the Kind of class group (attribute-reuse 5.6, AC-13)", () => {
  function Holder({ start, remembered, busy = false }: { start: "owl" | "rdfs"; remembered: "owl" | "rdfs" | null; busy?: boolean }) {
    const [value, onChange] = useState<"owl" | "rdfs">(start);
    return (
      <NewEntityForm
        title="New class"
        primaryLanguage="en"
        busy={busy}
        classKind={{ value, onChange, remembered }}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />
    );
  }

  it("is a fieldset named by its legend, two radios with what each means, the default checked", () => {
    render(<Holder start="owl" remembered={null} />);
    const group = screen.getByRole("group", { name: "Kind of class" });
    expect(group.tagName).toBe("FIELDSET");
    const owl = screen.getByRole("radio", { name: "OWL class" }) as HTMLInputElement;
    const rdfs = screen.getByRole("radio", { name: "RDFS class" }) as HTMLInputElement;
    expect(owl.checked).toBe(true);
    expect(rdfs.checked).toBe(false);
    // One group for the arrow keys: the same name, so one tab stop.
    expect(owl.name).toBe(rdfs.name);
    expect(described(owl)).toBe("Can take rules, and works with the reasoner.");
    expect(described(rdfs)).toBe("The simpler standard. No rules.");
    // No remembered choice, no hint: OWL, as a project always had.
    expect(described(group)).toBe("");
  });

  it("starts on the project's last choice and says so", () => {
    render(<Holder start="rdfs" remembered="rdfs" />);
    expect((screen.getByRole("radio", { name: "RDFS class" }) as HTMLInputElement).checked).toBe(true);
    expect(described(screen.getByRole("group", { name: "Kind of class" }))).toBe("RDFS class, as last time.");
  });

  it("sends the kind chosen with Create, and Enter in the name still creates", () => {
    render(<Holder start="owl" remembered={null} />);
    fireEvent.change(screen.getByLabelText("Name (en)"), { target: { value: "Receipt" } });
    fireEvent.click(screen.getByRole("radio", { name: "RDFS class" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ name: "Receipt", type: "rdfs" });
    fireEvent.submit(screen.getByLabelText("Name (en)"));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("sits between the name and More options in the tab order", () => {
    render(<Holder start="owl" remembered={null} />);
    const order = Array.from(document.querySelectorAll<HTMLElement>("input, button, select, textarea"));
    const name = order.indexOf(screen.getByLabelText("Name (en)"));
    const owl = order.indexOf(screen.getByRole("radio", { name: "OWL class" }));
    const more = order.indexOf(screen.getByRole("button", { name: "More options" }));
    expect(name).toBeLessThan(owl);
    expect(owl).toBeLessThan(more);
  });

  it("while a command runs it is aria-disabled, never disabled, and ignores a change", () => {
    render(<Holder start="owl" remembered={null} busy />);
    const group = screen.getByRole("group", { name: "Kind of class" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    const rdfs = screen.getByRole("radio", { name: "RDFS class" }) as HTMLInputElement;
    expect(rdfs.disabled).toBe(false);
    fireEvent.click(rdfs);
    expect((screen.getByRole("radio", { name: "OWL class" }) as HTMLInputElement).checked).toBe(true);
  });

  it("is not offered by a form that makes something else", () => {
    show();
    expect(screen.queryByRole("group", { name: "Kind of class" })).toBeNull();
  });
});
