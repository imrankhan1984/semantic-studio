// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/AnnotationAdder.test.tsx
================================================================================

SUMMARY
    Adding an annotation (visual-modeling 5.1.1, AC-2): the property list and
    its groups, the default type each property brings, the input each type
    asks for, Add unavailable while the value is invalid, a new annotation
    property, and the server's refusal shown under the value.

BASIC IDEA
    api.ts mocked; the project store opened on a mocked project so commands
    have somewhere to go. The list is the server's shape, three suggested
    properties and one the model declares.

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand, getAnnotationProperties).

EXPECTED OUTPUT
    - Pass/fail for AC-2.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import AnnotationAdder from "./AnnotationAdder";

const { openProject, runCommand, getAnnotationProperties } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  getAnnotationProperties: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, getAnnotationProperties };
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

const LIST = [
  { iri: "http://www.w3.org/2004/02/skos/core#definition", prefixed: "skos:definition", defaultType: { kind: "text" }, source: "suggested" },
  { iri: "http://purl.org/dc/terms/created", prefixed: "dcterms:created", defaultType: { kind: "typed", datatype: "xsd:date" }, source: "suggested" },
  { iri: "http://www.w3.org/2000/01/rdf-schema#seeAlso", prefixed: "rdfs:seeAlso", defaultType: { kind: "link" }, source: "suggested" },
  { iri: "http://www.w3.org/2002/07/owl#deprecated", prefixed: "owl:deprecated", defaultType: { kind: "typed", datatype: "xsd:boolean" }, source: "suggested" },
  { iri: EX + "reviewedOn", prefixed: "shop:reviewedOn", defaultType: { kind: "typed", datatype: "xsd:date" }, source: "document" },
];

const onDone = vi.fn();

async function renderAdder() {
  await act(async () => {
    render(<AnnotationAdder iri={EX + "Invoice"} primaryLanguage="en" languages={["fr"]} onDone={onDone} />);
  });
}

const property = () => screen.getByRole("combobox", { name: "Property" }) as HTMLSelectElement;
const valueType = () => screen.getByRole("combobox", { name: "Value type" }) as HTMLSelectElement;
const add = () => screen.getByRole("button", { name: "Add" });

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [openProject, runCommand, getAnnotationProperties, onDone]) mock.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "shop",
      primaryLanguage: "en", languages: ["fr"], documents: [{ file: "model.ttl", role: "model" }], counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  getAnnotationProperties.mockResolvedValue(LIST);
  runCommand.mockImplementation(async (_p, _d, command: string) => ({ revision: 3, label: command, state: STATE }));
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("AnnotationAdder", () => {
  it("lists the properties grouped Common and In this model, with New annotation property…", async () => {
    await renderAdder();
    expect(document.activeElement).toBe(property());
    const groups = Array.from(property().querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Common", "In this model"]);
    expect(within(property()).getByRole("option", { name: "shop:reviewedOn" })).toBeTruthy();
    expect(within(property()).getByRole("option", { name: "New annotation property…" })).toBeTruthy();
  });

  it("preselects each property's default type, which can be changed", async () => {
    await renderAdder();
    fireEvent.change(property(), { target: { value: LIST[0].iri } });
    expect(valueType().value).toBe("text");
    expect(screen.getByRole("textbox", { name: "Value" }).tagName).toBe("TEXTAREA");
    expect((screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement).value).toBe("en");

    fireEvent.change(property(), { target: { value: LIST[1].iri } });
    expect(valueType().value).toBe("xsd:date");
    expect((document.querySelector(".value-input input") as HTMLInputElement).type).toBe("date");

    fireEvent.change(property(), { target: { value: LIST[2].iri } });
    expect(valueType().value).toBe("link");
    expect((screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).type).toBe("url");

    fireEvent.change(property(), { target: { value: LIST[3].iri } });
    const toggle = screen.getByRole("switch", { name: "Value" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // Changed by the user: the date property as a whole number instead.
    fireEvent.change(property(), { target: { value: LIST[1].iri } });
    fireEvent.change(valueType(), { target: { value: "xsd:integer" } });
    expect((screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).inputMode).toBe("decimal");
  });

  it("keeps Add unavailable while the value is invalid, and sends nothing", async () => {
    await renderAdder();
    fireEvent.change(property(), { target: { value: LIST[1].iri } });
    fireEvent.change(valueType(), { target: { value: "xsd:integer" } });
    const field = screen.getByRole("textbox", { name: "Value" });
    fireEvent.change(field, { target: { value: "4.5" } });
    expect(screen.getByText('"4.5" is not a valid integer (expected a whole number such as 42).')).toBeTruthy();
    expect(add().getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(add());
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("adds text in another language as one AddAnnotation", async () => {
    await renderAdder();
    fireEvent.change(property(), { target: { value: LIST[0].iri } });
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "Une facture." } });
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "fr" } });
    await act(async () => {
      fireEvent.click(add());
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "AddAnnotation", {
      iri: EX + "Invoice",
      property: LIST[0].iri,
      value: { kind: "text", value: "Une facture.", lang: "fr" },
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("takes any BCP 47 tag under Other…", async () => {
    await renderAdder();
    fireEvent.change(property(), { target: { value: LIST[0].iri } });
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "Rechnung" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "__other" } });
    const tag = screen.getByRole("textbox", { name: /Language tag/ });
    fireEvent.change(tag, { target: { value: "de_DE" } });
    expect(add().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(tag, { target: { value: "de-DE" } });
    await act(async () => {
      fireEvent.click(add());
    });
    expect(runCommand.mock.calls[0][3]).toMatchObject({ value: { kind: "text", value: "Rechnung", lang: "de-DE" } });
  });

  it("shows the server's refusal under the value, and stays open", async () => {
    runCommand.mockRejectedValueOnce(new Error("Invoice already has a skos:prefLabel in en."));
    await renderAdder();
    fireEvent.change(property(), { target: { value: LIST[0].iri } });
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "Bill" } });
    await act(async () => {
      fireEvent.click(add());
    });
    const error = screen.getByText("Invoice already has a skos:prefLabel in en.");
    expect(screen.getByRole("textbox", { name: "Value" }).getAttribute("aria-describedby")).toBe(error.id);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("declares a new annotation property with its value type, then selects it", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created", state: STATE, created: EX + "approvedBy" });
    await renderAdder();
    fireEvent.change(property(), { target: { value: "__new" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Name of the new property/ }), { target: { value: "approved by" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Its values are" }), { target: { value: "link" } });
    getAnnotationProperties.mockResolvedValue([
      ...LIST,
      { iri: EX + "approvedBy", prefixed: "shop:approvedBy", defaultType: { kind: "link" }, source: "document" },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateAnnotationProperty", {
      label: "approved by",
      valueType: { kind: "link" },
    });
    expect(property().value).toBe(EX + "approvedBy");
    expect(valueType().value).toBe("link");
  });
});
