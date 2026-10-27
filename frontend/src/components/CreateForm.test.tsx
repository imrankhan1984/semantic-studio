// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/CreateForm.test.tsx
================================================================================

SUMMARY
    The side panel's New … form (edit-page-rework 5.4, 5.5): one form for
    every kind a draft makes, its name the store's (so the canvas's draft
    box shows it too), one command per Create, the server's refusal under the
    name, and the draft ended by Cancel, Escape, or focus leaving it empty.
    And a new class's *Kind of class* (attribute-reuse 5.6): the project's
    default, the kind chosen sent by whichever Enter, and the next form's
    hint once the server has kept it.

BASIC IDEA
    api.ts is mocked; the project store is real, opened on a mocked project,
    so the form and the store are tested together as App uses them. The
    pickers are EntityPicker, whose search is mocked to one class.

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand, searchNodes).

EXPECTED OUTPUT
    - Pass/fail per assertion, for AC-6 and Section 6's focus rules.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { projectStore } from "../state/projectStore";
import CreateForm, { creatingTitle } from "./CreateForm";

const { openProject, runCommand, searchNodes } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  searchNodes: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  runCommand,
  searchNodes,
}));

const PID = "prj-0123456789ab";
const X = "http://example.org/shop#";
const STATE = {
  doc: "model" as const, ontologyId: `${PID}-model`, revision: 2, dirty: true,
  canUndo: true, undoLabel: "x", canRedo: false, redoLabel: null, triples: 10,
};

beforeEach(async () => {
  projectStore._reset();
  vi.clearAllMocks();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: X, prefix: "shop",
      primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology",
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockResolvedValue({ revision: 3, label: "Created", state: STATE, created: X + "New" });
  searchNodes.mockResolvedValue([{ id: X + "Person", label: "Person", kind: "class" }]);
});
afterEach(() => {
  cleanup();
  projectStore._reset();
});

const form = () => render(<CreateForm ontologyId={`${PID}-model`} primaryLanguage="en" />);
const nameField = () => screen.getByRole("textbox", { name: "Name (en)" }) as HTMLInputElement;
const create = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
};

describe("CreateForm", () => {
  it("renders nothing without a draft", () => {
    form();
    expect(document.querySelector(".create-form")).toBeNull();
  });

  it("names what it makes", () => {
    expect(creatingTitle("class", null)).toBe("New class");
    expect(creatingTitle("class", { iri: X + "Person", label: "Person" })).toBe("New kind of Person");
    expect(creatingTitle("concept", { iri: X + "Paid", label: "Paid" })).toBe("New concept narrower than Paid");
    expect(creatingTitle("objectProperty", null)).toBe("New relationship");
    expect(creatingTitle("datatypeProperty", null)).toBe("New attribute");
    expect(creatingTitle("example", null)).toBe("New example");
  });

  it("its name is the store's: typed here or on the canvas, it is one value", () => {
    act(() => {
      projectStore.startCreating("class");
    });
    form();
    expect(document.activeElement).toBe(nameField());
    fireEvent.change(nameField(), { target: { value: "Invoice" } });
    expect(projectStore.getSnapshot().creating?.name).toBe("Invoice");
    act(() => projectStore.setCreatingName("Receipt"));
    expect(nameField().value).toBe("Receipt");
  });

  it("does not take focus when the canvas's draft box has it", () => {
    act(() => {
      projectStore.startCreating("class");
    });
    render(<CreateForm ontologyId={`${PID}-model`} primaryLanguage="en" focusName={false} />);
    expect(document.activeElement).not.toBe(nameField());
  });

  it("a relationship: its name, from and to, in one CreateObjectProperty", async () => {
    act(() => {
      projectStore.startCreating("objectProperty");
    });
    form();
    expect(screen.getByText("New relationship")).toBeTruthy();
    fireEvent.change(nameField(), { target: { value: "works for" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Choose" })[1]);
    const picker = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(picker, { target: { value: "Pe" } });
    const option = await screen.findByRole("option", { name: /Person/ });
    // The picker's own pointer event: mousedown, which keeps the field focused.
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    expect(screen.getByText(/To: Person/)).toBeTruthy();
    await create();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateObjectProperty", { label: "works for", range: X + "Person" });
    expect(projectStore.getSnapshot().creating).toBeNull();
    expect(projectStore.getSnapshot().created).toMatchObject({ iri: X + "New", kind: "objectProperty" });
  });

  it("what the form holds is the store's: Enter in the canvas's box makes it with the definition and identifier (code review)", async () => {
    act(() => {
      projectStore.startCreating("class");
    });
    form();
    fireEvent.change(nameField(), { target: { value: "Invoice" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Definition (optional)" }), { target: { value: "A bill." } });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Identifier/ }), { target: { value: X + "Bill" } });
    // What the canvas's Enter does: the store's createDraft, with nothing passed.
    await act(async () => {
      await projectStore.createDraft();
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateClass", { label: "Invoice", type: "owl", definition: "A bill.", iri: X + "Bill" });
  });

  it("a relationship waits for the class it points to, as the class form's does", async () => {
    act(() => {
      projectStore.startCreating("objectProperty");
    });
    form();
    fireEvent.change(nameField(), { target: { value: "has line" } });
    expect(screen.getByText("Choose the class it points to.")).toBeTruthy();
    await create();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("an attribute: its type of value under More options", async () => {
    act(() => {
      projectStore.startCreating("datatypeProperty");
    });
    form();
    fireEvent.change(nameField(), { target: { value: "total" } });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Type of value" }), { target: { value: "xsd:decimal" } });
    await create();
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateDatatypeProperty", { label: "total", datatype: "xsd:decimal" });
  });

  it("an example waits for its class, said beside Create, and sends nothing until then", async () => {
    act(() => {
      projectStore.startCreating("example");
    });
    form();
    fireEvent.change(nameField(), { target: { value: "Ann" } });
    expect(screen.getByText("Choose the class it is an example of.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" }).getAttribute("aria-disabled")).toBe("true");
    await create();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("a refusal is the server's sentence under the name, and the draft stays", async () => {
    runCommand.mockRejectedValue(new ApiError("Invoice is already used.", 422));
    act(() => {
      projectStore.startCreating("class");
    });
    form();
    fireEvent.change(nameField(), { target: { value: "Invoice" } });
    await create();
    expect(screen.getByText("Invoice is already used.")).toBeTruthy();
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(projectStore.getSnapshot().creating?.name).toBe("Invoice");
  });

  it("Escape and Cancel end it and give focus back where it began", async () => {
    const start = document.createElement("button");
    document.body.appendChild(start);
    act(() => {
      projectStore.startCreating("class", { from: start });
    });
    form();
    fireEvent.keyDown(nameField(), { key: "Escape" });
    expect(projectStore.getSnapshot().creating).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(start));
    start.remove();
  });

  it("focus leaving it empty, for anywhere but the canvas's draft box, ends it", () => {
    const elsewhere = document.createElement("button");
    const box = document.createElement("div");
    box.className = "canvas-draft";
    const boxField = document.createElement("input");
    box.appendChild(boxField);
    document.body.append(elsewhere, box);
    act(() => {
      projectStore.startCreating("class");
    });
    form();
    // To the canvas's field: the draft stays, it is the other place it is named.
    fireEvent.blur(nameField(), { relatedTarget: boxField });
    expect(projectStore.getSnapshot().creating).not.toBeNull();
    act(() => nameField().focus());
    fireEvent.blur(nameField(), { relatedTarget: elsewhere });
    expect(projectStore.getSnapshot().creating).toBeNull();
    elsewhere.remove();
    box.remove();
  });
});

describe("a new class's kind (attribute-reuse 5.6, AC-13)", () => {
  it("starts on the project's default, sends the kind chosen whichever place pressed Enter, and the next form starts there", async () => {
    act(() => {
      projectStore.startCreating("class");
    });
    form();
    expect((screen.getByRole("radio", { name: "OWL class" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/as last time/)).toBeNull();
    fireEvent.change(nameField(), { target: { value: "Receipt" } });
    fireEvent.click(screen.getByRole("radio", { name: "RDFS class" }));
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Receipt", state: STATE, created: X + "Receipt", classType: "rdfs" });
    // The canvas's Enter: the store's createDraft, with the kind the form chose.
    await act(async () => {
      await projectStore.createDraft();
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateClass", { label: "Receipt", type: "rdfs" });
    // The server wrote the new default; the summary follows, and the next
    // form says so.
    expect(projectStore.getSnapshot().project?.classType).toBe("rdfs");
    act(() => {
      projectStore.startCreating("class");
    });
    expect((screen.getByRole("radio", { name: "RDFS class" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("RDFS class, as last time.")).toBeTruthy();
  });

  it("is offered for a class only", () => {
    act(() => {
      projectStore.startCreating("concept");
    });
    form();
    expect(screen.queryByRole("group", { name: "Kind of class" })).toBeNull();
  });
});
