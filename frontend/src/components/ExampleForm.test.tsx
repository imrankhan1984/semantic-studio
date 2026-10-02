// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ExampleForm.test.tsx
================================================================================

SUMMARY
    Example data in the editing form (shacl-authoring 5.8, AC-8): a class's
    Examples block and *Add an example*; an example's form with its classes
    and one field per attribute and relationship; a wrong value refused
    before it is sent, with the type's sentence (row S22); a link chosen
    from the examples of the end class; Remove, with focus kept in the
    field; and an example's values kept out of its annotations.

BASIC IDEA
    EditSection hosts the form as the detail panel does. api.ts is mocked
    and the real project store opened on a fixed project, so every control
    is asserted by the command and arguments the server would receive.

INPUTS / INPUT SOURCES
    - A mocked api.ts; NodeDetails as /node answers them for a project.

EXPECTED OUTPUT
    - Pass/fail for AC-8 as the interface carries it, and row S22.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P } from "../modeling/entity";
import { projectStore } from "../state/projectStore";
import type { ExampleField, NodeDetails, TermRef } from "../types";
import EditSection from "./EditSection";

const { openProject, runCommand, getAnnotationProperties } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  getAnnotationProperties: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  runCommand,
  getAnnotationProperties,
}));

const EX = "http://example.org/shop#";
const PID = "prj-0123456789ab";
const OID = `${PID}-model`;
const OWL = "http://www.w3.org/2002/07/owl#";

const STATE = {
  doc: "model" as const, ontologyId: OID, revision: 2, dirty: true,
  canUndo: true, undoLabel: "x", canRedo: false, redoLabel: null, triples: 10,
};

const uri = (value: string, kind?: string, label?: string): TermRef => ({
  type: "uri", value, prefixed: value.replace(EX, "shop:"),
  label: label ?? value.replace(EX, "").replace(OWL, ""), ...(kind ? { kind } : {}),
});
const lit = (value: string, lang?: string, datatype?: string): TermRef => ({
  type: "literal", value, lang: lang ?? null, datatype: datatype ?? null,
});

const BIRTH: ExampleField = {
  property: `${EX}birthDate`, label: "birth date", kind: "attribute", functional: true,
  values: [], datatype: "xsd:date",
};
const MEMBER: ExampleField = {
  property: `${EX}memberOf`, label: "member of", kind: "relationship", functional: false,
  values: [{ kind: "link", value: `${EX}acme`, label: "Acme" }],
  range: `${EX}Organization`, rangeLabel: "Organization",
  options: [{ iri: `${EX}acme`, label: "Acme" }, { iri: `${EX}initech`, label: "Initech" }], optionsTotal: 2,
};

function bob(fields: ExampleField[] = [BIRTH, MEMBER], outgoing: [string, TermRef][] = []): NodeDetails {
  const rows: [string, TermRef][] = [
    [P.type, uri(`${EX}Person`, "class", "Person")],
    [P.type, uri(`${OWL}NamedIndividual`)],
    [P.label, lit("Bob", "en")],
    ...outgoing,
  ];
  return {
    iri: `${EX}bob`, prefixed: "shop:bob", label: "Bob", kind: "individual",
    outgoing: rows.map(([p, o]) => ({ predicate: uri(p), object: o })), incoming: [],
    outgoingTotal: rows.length, incomingTotal: 0,
    example: { classes: [{ iri: `${EX}Person`, label: "Person" }], fields },
  };
}

function person(examples: TermRef[] = []): NodeDetails {
  const rows: [string, TermRef][] = [[P.type, uri(`${OWL}Class`)], [P.label, lit("Person", "en")]];
  return {
    iri: `${EX}Person`, prefixed: "shop:Person", label: "Person", kind: "class",
    outgoing: rows.map(([p, o]) => ({ predicate: uri(p), object: o })),
    incoming: examples.map((s) => ({ subject: s, predicate: uri(P.type) })),
    outgoingTotal: rows.length, incomingTotal: examples.length,
  };
}

const onSelect = vi.fn();

async function renderForm(d: NodeDetails) {
  await act(async () => {
    render(
      <EditSection ontologyId={OID} details={d} primaryLanguage="en" languages={["fr"]} onSelect={onSelect} onDeleted={vi.fn()} />,
    );
  });
}

function changed(label: string, created?: string) {
  return { revision: 3, label, state: STATE, ...(created ? { created } : {}) };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [openProject, runCommand, getAnnotationProperties, onSelect]) mock.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "shop",
      primaryLanguage: "en", languages: ["fr"], documents: [{ file: "model.ttl", role: "model" }], counts: {}, kind: "ontology",
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockImplementation(async (_pid, _doc, command: string) => changed(`Did ${command}`));
});

afterEach(cleanup);

describe("a class's Examples block (5.8)", () => {
  it("lists the class's examples, each a link to its form", async () => {
    await renderForm(person([uri(`${EX}bob`, "individual", "Bob"), uri(`${EX}alice`, "other", "Alice")]));
    const block = screen.getByRole("heading", { name: "Examples" }).parentElement!;
    const links = within(block).getAllByRole("button").filter((b) => b.className.includes("link-btn"));
    expect(links.map((b) => b.textContent)).toEqual(["Alice", "Bob"]);
    fireEvent.click(links[1]);
    expect(onSelect).toHaveBeenCalledWith(`${EX}bob`);
  });

  it("adds an example with a name, as one CreateExample, and opens it", async () => {
    await renderForm(person());
    expect(screen.getByText("No examples yet. Add one, and a shape on Person has something to check.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an example" }));
    runCommand.mockResolvedValue(changed("Created example Bob of Person", `${EX}bob`));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Bob" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add example" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "CreateExample", { class: `${EX}Person`, label: "Bob" });
    expect(onSelect).toHaveBeenCalledWith(`${EX}bob`);
  });

  it("returns focus to Add an example after Cancel", async () => {
    await renderForm(person());
    fireEvent.click(screen.getByRole("button", { name: "Add an example" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add an example" }));
  });
});

describe("an example's form (5.8)", () => {
  it("says which class it is an example of, in place of a class's structure", async () => {
    await renderForm(bob());
    const block = screen.getByRole("heading", { name: "Example of" }).parentElement!;
    fireEvent.click(within(block).getByRole("button", { name: "Person" }));
    expect(onSelect).toHaveBeenCalledWith(`${EX}Person`);
    expect(screen.queryByRole("heading", { name: "Parents" })).toBeNull();
  });

  it("refuses a wrong value before sending it, with the type's sentence (row S22)", async () => {
    await renderForm(bob());
    const field = screen.getByRole("group", { name: /birth date/ });
    const input = within(field).getByLabelText("birth date");
    fireEvent.change(input, { target: { value: "yesterday" } });
    const add = within(field).getByRole("button", { name: "Add birth date" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const sentence = '"yesterday" is not a valid date (expected YYYY-MM-DD).';
    expect(within(field).getByText(sentence)).toBeTruthy();
    expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")?.textContent).toBe(sentence);
    await act(async () => {
      fireEvent.click(add);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("sets a one-value attribute with SetExampleValue once the value is right", async () => {
    await renderForm(bob());
    const field = screen.getByRole("group", { name: /birth date/ });
    fireEvent.change(within(field).getByLabelText("birth date"), { target: { value: "1990-05-01" } });
    await act(async () => {
      fireEvent.click(within(field).getByRole("button", { name: "Add birth date" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "SetExampleValue", {
      iri: `${EX}bob`, property: `${EX}birthDate`, value: { kind: "typed", value: "1990-05-01", datatype: "xsd:date" },
    });
  });

  it("links to an example of the end class, never offering one already linked", async () => {
    await renderForm(bob());
    const field = screen.getByRole("group", { name: /member of/ });
    const choice = within(field).getByLabelText("Link to") as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(["Choose an Organization…", "Initech"]);
    fireEvent.change(choice, { target: { value: `${EX}initech` } });
    await act(async () => {
      fireEvent.click(within(field).getByRole("button", { name: "Link member of" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "AddExampleValue", {
      iri: `${EX}bob`, property: `${EX}memberOf`, value: { kind: "link", value: `${EX}initech` },
    });
  });

  it("removes a value as one command and keeps focus in the field", async () => {
    await renderForm(bob());
    const field = screen.getByRole("group", { name: /member of/ });
    await act(async () => {
      fireEvent.click(within(field).getByRole("button", { name: "Remove Acme from member of of Bob" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "RemoveExampleValue", {
      iri: `${EX}bob`, property: `${EX}memberOf`, value: { kind: "link", value: `${EX}acme` },
    });
    await settle();
    expect(document.activeElement).toBe(within(field).getByLabelText("Link to"));
  });

  it("says how to make a link possible when the end class has no example yet", async () => {
    await renderForm(bob([{ ...MEMBER, values: [], options: [], optionsTotal: 0 }]));
    expect(
      screen.getByText("No Organization yet. Add one from the Organization form, then link it here."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link member of" })).toBeNull();
  });

  it("keeps an example's values out of its annotations", async () => {
    const value = lit("1990-05-01", undefined, "xsd:date");
    await renderForm(bob([{ ...BIRTH, values: [{ kind: "typed", value: "1990-05-01", datatype: "xsd:date" }] }], [[`${EX}birthDate`, value]]));
    expect(screen.getByText("No other annotations.")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: /birth date/ })).getByText("1990-05-01")).toBeTruthy();
  });
});

describe("an example's form: PR #51 review", () => {
  it("sends a type outside the seven with its datatype, the hint naming it (item 1)", async () => {
    const FLOAT = "http://www.w3.org/2001/XMLSchema#float";
    await renderForm(bob([{ ...BIRTH, property: `${EX}height`, label: "height", functional: false, datatype: FLOAT }]));
    const field = screen.getByRole("group", { name: /height/ });
    expect(within(field).getByText(/a value of type xsd:float/)).toBeTruthy();
    fireEvent.change(within(field).getByLabelText("height"), { target: { value: "1.75" } });
    await act(async () => {
      fireEvent.click(within(field).getByRole("button", { name: "Add height" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "AddExampleValue", {
      iri: `${EX}bob`, property: `${EX}height`, value: { kind: "typed", value: "1.75", datatype: FLOAT },
    });
  });

  it("starts a yes/no field at yes, ready to add (item 4)", async () => {
    await renderForm(bob([{ ...BIRTH, property: `${EX}active`, label: "active", datatype: "xsd:boolean" }]));
    const field = screen.getByRole("group", { name: /active/ });
    expect(within(field).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    const add = within(field).getByRole("button", { name: "Add active" });
    expect(add.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(add);
    });
    expect(runCommand.mock.calls[0][3].value).toEqual({ kind: "typed", value: "true", datatype: "xsd:boolean" });
  });

  it("returns focus to the field's heading when the last choice has been linked (item 3)", async () => {
    let view!: ReturnType<typeof render>;
    const one = { ...MEMBER, values: [MEMBER.values[0]] };
    await act(async () => {
      view = render(
        <EditSection ontologyId={OID} details={bob([one])} primaryLanguage="en" languages={["fr"]} onSelect={onSelect} onDeleted={vi.fn()} />,
      );
    });
    const field = () => screen.getByRole("group", { name: /member of/ });
    fireEvent.change(within(field()).getByLabelText("Link to"), { target: { value: `${EX}initech` } });
    within(field()).getByRole("button", { name: "Link member of" }).focus();
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "Link member of" }));
    });
    await settle();
    // The panel refetches: Initech is linked, no choice is left, the select
    // and its button go, and focus would fall to the page.
    const linked = { ...MEMBER, values: [...MEMBER.values, { kind: "link" as const, value: `${EX}initech`, label: "Initech" }] };
    await act(async () => {
      view.rerender(
        <EditSection ontologyId={OID} details={bob([linked])} primaryLanguage="en" languages={["fr"]} onSelect={onSelect} onDeleted={vi.fn()} />,
      );
    });
    await settle();
    expect(within(field()).queryByLabelText("Link to")).toBeNull();
    expect(document.activeElement).toBe(within(field()).getByRole("heading", { name: /member of/ }));
  });

  it("keeps focus in the field after Remove when no control is left to take it (item 3)", async () => {
    // Every Organization is linked, so the field has no select: removing a
    // link takes away the button that had focus and leaves nothing else.
    const full = {
      ...MEMBER,
      values: [...MEMBER.values, { kind: "link" as const, value: `${EX}initech`, label: "Initech" }],
    };
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <EditSection ontologyId={OID} details={bob([full])} primaryLanguage="en" languages={["fr"]} onSelect={onSelect} onDeleted={vi.fn()} />,
      );
    });
    const field = () => screen.getByRole("group", { name: /member of/ });
    expect(within(field()).queryByLabelText("Link to")).toBeNull();
    const remove = within(field()).getByRole("button", { name: "Remove Acme from member of of Bob" });
    remove.focus();
    await act(async () => {
      fireEvent.click(remove);
    });
    await settle();
    // The refetch: Acme is gone and is a choice again.
    await act(async () => {
      view.rerender(
        <EditSection ontologyId={OID} details={bob([{ ...full, values: [full.values[1]] }])} primaryLanguage="en" languages={["fr"]} onSelect={onSelect} onDeleted={vi.fn()} />,
      );
    });
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    expect(field().contains(document.activeElement)).toBe(true);
  });
});
