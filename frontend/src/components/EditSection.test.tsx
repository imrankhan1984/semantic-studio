// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/EditSection.test.tsx
================================================================================

SUMMARY
    The editing form (visual-modeling Stage 1): each block sends the command
    and arguments 5.1 names, a refusal is the server's sentence under the
    field that caused it, read-only cases say why, names are listed per
    project language, pickers ask for one kind, and the delete flow shows the
    dry run, asks about children only when there are some, and deletes only
    on confirmation.

BASIC IDEA
    The component-test pattern: api.ts mocked, the project store opened on a
    mocked project, the form rendered straight from hand-built NodeDetails.
    "Sends the right command" is asserted on runCommand's arguments, which is
    what the server would receive.

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand, previewDelete, searchNodes,
      getAnnotationProperties).

EXPECTED OUTPUT
    - Pass/fail for AC-1, AC-3, AC-4 and AC-6.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P } from "../modeling/entity";
import { projectStore } from "../state/projectStore";
import type { NodeDetails, TermRef } from "../types";
import EditSection from "./EditSection";

const { openProject, runCommand, previewDelete, searchNodes, getAnnotationProperties } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  previewDelete: vi.fn(),
  searchNodes: vi.fn(),
  getAnnotationProperties: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand, previewDelete, searchNodes, getAnnotationProperties };
});

const EX = "http://example.org/shop#";
const PID = "prj-0123456789ab";
const OID = `${PID}-model`;
const OWL = "http://www.w3.org/2002/07/owl#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

const STATE = {
  doc: "model" as const,
  ontologyId: OID,
  revision: 2,
  dirty: true,
  canUndo: true,
  undoLabel: "x",
  canRedo: false,
  redoLabel: null,
  triples: 10,
};

const uri = (value: string, kind?: string): TermRef => ({
  type: "uri",
  value,
  prefixed: value.replace(EX, "shop:"),
  label: value.replace(EX, "").replace(OWL, "").replace(SKOS, ""),
  ...(kind ? { kind } : {}),
});
const lit = (value: string, lang?: string, datatype?: string): TermRef => ({
  type: "literal",
  value,
  lang: lang ?? null,
  datatype: datatype ?? null,
});

function details(
  local: string,
  kind: string,
  outgoing: [string, TermRef][],
  incoming: [TermRef, string][] = [],
  extra: Partial<NodeDetails> = {},
): NodeDetails {
  return {
    iri: EX + local,
    prefixed: `shop:${local}`,
    label: local,
    kind,
    outgoing: outgoing.map(([p, o]) => ({ predicate: uri(p), object: o })),
    incoming: incoming.map(([s, p]) => ({ subject: s, predicate: uri(p) })),
    outgoingTotal: outgoing.length,
    incomingTotal: incoming.length,
    ...extra,
  };
}

const invoice = () =>
  details(
    "Invoice",
    "class",
    [
      [P.type, uri(OWL + "Class")],
      [P.label, lit("Invoice", "en")],
      [P.subClassOf, uri(EX + "Document", "class")],
      ["http://purl.org/dc/terms/created", lit("2026-09-01", undefined, "xsd:date")],
    ],
    [
      [uri(EX + "total", "datatypeProperty"), P.domain],
      [uri(EX + "SalesInvoice", "class"), P.subClassOf],
    ],
  );

const onSelect = vi.fn();
const onDeleted = vi.fn();

async function renderForm(d: NodeDetails) {
  await act(async () => {
    render(
      <EditSection
        ontologyId={OID}
        details={d}
        primaryLanguage="en"
        languages={["fr"]}
        onSelect={onSelect}
        onDeleted={onDeleted}
      />,
    );
  });
}

function changed(label: string, created?: string) {
  return { revision: 3, label, state: STATE, ...(created ? { created } : {}) };
}

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [openProject, runCommand, previewDelete, searchNodes, getAnnotationProperties, onSelect, onDeleted]) {
    mock.mockReset();
  }
  openProject.mockResolvedValue({
    project: {
      id: PID,
      name: "Shop",
      createdAt: "",
      updatedAt: "",
      baseIri: EX,
      prefix: "shop",
      primaryLanguage: "en",
      languages: ["fr"],
      documents: [{ file: "model.ttl", role: "model" }],
      counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  runCommand.mockImplementation(async (_pid, _doc, command: string) => changed(`Did ${command}`));
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

const lastCommand = () => runCommand.mock.calls[runCommand.mock.calls.length - 1].slice(2);

describe("Names (AC-1)", () => {
  it("lists every project language, a missing one said in text", async () => {
    await renderForm(invoice());
    const names = screen.getByRole("heading", { name: "Names" }).closest("section")!;
    expect(within(names).getByText("en (required)")).toBeTruthy();
    expect(within(names).getByText("missing")).toBeTruthy();
  });

  it("sets a name in another language with SetLabel in that language", async () => {
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Add name in fr" }));
    const field = screen.getByRole("textbox", { name: "name in fr" });
    fireEvent.change(field, { target: { value: "Facture" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["SetLabel", { iri: EX + "Invoice", value: "Facture", lang: "fr" }]);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal under the field, and keeps it open", async () => {
    runCommand.mockRejectedValueOnce(new Error("A label cannot be empty."));
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Edit name in en" }));
    const field = screen.getByRole("textbox", { name: "name in en" });
    fireEvent.change(field, { target: { value: "" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["SetLabel", { iri: EX + "Invoice", value: "", lang: "en" }]);
    const error = screen.getByText("A label cannot be empty.");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(screen.getByRole("textbox", { name: "name in en" })).toBe(field);
  });
});

describe("Definition and annotations (AC-1, AC-2)", () => {
  it("adds a definition as skos:definition in the primary language", async () => {
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Add definition" }));
    const field = screen.getByRole("textbox", { name: "definition" });
    fireEvent.change(field, { target: { value: "A request for payment." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(lastCommand()).toEqual([
      "AddAnnotation",
      { iri: EX + "Invoice", property: "skos:definition", value: { kind: "text", value: "A request for payment.", lang: "en" } },
    ]);
  });

  it("edits an existing definition in place with ReplaceAnnotation", async () => {
    const d = invoice();
    d.outgoing.push({ predicate: uri(P.comment), object: lit("Old.", "en") });
    await renderForm(d);
    fireEvent.click(screen.getByRole("button", { name: "Edit definition" }));
    fireEvent.change(screen.getByRole("textbox", { name: "definition" }), { target: { value: "New." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(lastCommand()).toEqual([
      "ReplaceAnnotation",
      {
        iri: EX + "Invoice",
        property: P.comment,
        oldValue: { kind: "text", value: "Old.", lang: "en" },
        newValue: { kind: "text", value: "New.", lang: "en" },
      },
    ]);
  });

  it("lists other annotations with their kind, and removes one exactly", async () => {
    await renderForm(invoice());
    const row = screen.getByText("2026-09-01").closest("li")!;
    expect(row.textContent).toContain("(date)");
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: /^Remove/ }));
    });
    expect(lastCommand()).toEqual([
      "RemoveAnnotation",
      {
        iri: EX + "Invoice",
        property: "http://purl.org/dc/terms/created",
        value: { kind: "typed", value: "2026-09-01", datatype: "xsd:date" },
      },
    ]);
  });

  it("refuses an invalid value before sending when editing in place", async () => {
    // An integer rather than the date: a date field, in jsdom as in a
    // browser, cannot hold an invalid date at all.
    const d = invoice();
    d.outgoing.push({ predicate: uri(EX + "pages"), object: lit("12", undefined, "xsd:integer") });
    await renderForm(d);
    const row = screen.getByText("12").closest("li")!;
    expect(row.textContent).toContain("(whole number)");
    fireEvent.click(within(row).getByRole("button", { name: /^Edit/ }));
    const field = document.querySelector<HTMLInputElement>(".edit-annotation.editing input")!;
    fireEvent.change(field, { target: { value: "4.5" } });
    expect(screen.getByText('"4.5" is not a valid integer (expected a whole number such as 42).')).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(save);
    });
    expect(runCommand).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "13" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(lastCommand()[0]).toBe("ReplaceAnnotation");
  });
});

describe("Structure (AC-1, AC-3)", () => {
  it("adds a parent through a picker that asks for classes, imports included", async () => {
    searchNodes.mockResolvedValue([
      { id: "http://xmlns.com/foaf/0.1/Document", label: "Document", kind: "class", degree: 1, importedFrom: "FOAF" },
    ]);
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Add parent" }));
    const box = screen.getByRole("combobox", { name: "New parent of Invoice" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Doc" } });
    const option = await screen.findByRole("option");
    expect(option.textContent).toBe("Document, from FOAF");
    expect(searchNodes).toHaveBeenLastCalledWith(OID, "Doc", true, "class");
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(lastCommand()).toEqual([
      "AddSubClassOf",
      { child: EX + "Invoice", parent: "http://xmlns.com/foaf/0.1/Document" },
    ]);
  });

  it("removes a parent with RemoveSubClassOf", async () => {
    await renderForm(invoice());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Document as a parent of Invoice" }));
    });
    expect(lastCommand()).toEqual(["RemoveSubClassOf", { child: EX + "Invoice", parent: EX + "Document" }]);
  });

  it("adds a subclass by name only, and selects it", async () => {
    runCommand.mockResolvedValueOnce(changed("Created class Credit note", EX + "CreditNote"));
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Add subclass" }));
    const name = screen.getByRole("textbox", { name: "Name (en)" });
    expect(document.activeElement).toBe(name);
    // Names first: nothing but the name is asked for until More options.
    expect(screen.getByRole("button", { name: "More options" }).getAttribute("aria-expanded")).toBe("false");
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(name, { target: { value: "Credit note" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual(["CreateClass", { label: "Credit note", parent: EX + "Invoice", iri: undefined }]);
    expect(onSelect).toHaveBeenCalledWith(EX + "CreditNote");
  });

  it("adds an attribute with this domain and a relationship with this domain and a chosen range", async () => {
    await renderForm(invoice());
    expect(screen.getByRole("button", { name: "total" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add attribute" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "due date" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual([
      "CreateDatatypeProperty",
      { label: "due date", domain: EX + "Invoice", datatype: "xsd:string", iri: undefined },
    ]);

    searchNodes.mockResolvedValue([{ id: EX + "Customer", label: "Customer", kind: "class", degree: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Add relationship" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "billed to" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose a class" }));
    fireEvent.change(screen.getByRole("combobox", { name: "It points to (a class)" }), { target: { value: "Cus" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Customer" }));
    expect(screen.getByText(/It points to: Customer/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual([
      "CreateObjectProperty",
      { label: "billed to", domain: EX + "Invoice", range: EX + "Customer", iri: undefined },
    ]);
  });

  it("changes a datatype property's range to one of the seven datatypes", async () => {
    await renderForm(
      details("total", "datatypeProperty", [
        [P.type, uri(OWL + "DatatypeProperty")],
        [P.domain, uri(EX + "Invoice", "class")],
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set range" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Type of value" }), { target: { value: "xsd:decimal" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set range" }));
    });
    expect(lastCommand()).toEqual(["SetRange", { property: EX + "total", target: "xsd:decimal" }]);
  });

  it("changes a relationship's domain through a class picker", async () => {
    searchNodes.mockResolvedValue([{ id: EX + "Order", label: "Order", kind: "class", degree: 1 }]);
    await renderForm(details("billedTo", "objectProperty", [[P.type, uri(OWL + "ObjectProperty")]]));
    fireEvent.click(screen.getByRole("button", { name: "Set domain" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Domain of billedTo" }), { target: { value: "Or" } });
    const option = await screen.findByRole("option", { name: "Order" });
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    expect(lastCommand()).toEqual(["SetDomain", { property: EX + "billedTo", target: EX + "Order" }]);
  });

  it("adds a broader concept through a concept picker, and a narrower one by name", async () => {
    searchNodes.mockResolvedValue([{ id: EX + "Status", label: "Status", kind: "concept", degree: 1 }]);
    runCommand.mockImplementation(async (_p, _d, command: string) =>
      changed(command, command === "CreateConcept" ? EX + "Late" : undefined),
    );
    await renderForm(details("Paid", "concept", [[P.type, uri(SKOS + "Concept")], [P.prefLabel, lit("Paid", "en")]]));
    fireEvent.click(screen.getByRole("button", { name: "Add broader concept" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "St" } });
    await screen.findByRole("option", { name: "Status" });
    expect(searchNodes).toHaveBeenLastCalledWith(OID, "St", true, "concept");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["AddBroader", { concept: EX + "Paid", broader: EX + "Status" }]);

    fireEvent.click(screen.getByRole("button", { name: "Add narrower concept" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Late" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual(["CreateConcept", { prefLabel: "Late", broader: EX + "Paid", iri: undefined }]);
    expect(onSelect).toHaveBeenCalledWith(EX + "Late");
  });
});

describe("Identifier", () => {
  it("says other files will not follow, then renames and selects the new IRI", async () => {
    runCommand.mockResolvedValueOnce(changed("Renamed", EX + "Bill"));
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Change identifier…" }));
    expect(screen.getByText("Other files that use the old identifier will not follow the change.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "New identifier" }), { target: { value: "shop:Bill" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change identifier" }));
    });
    expect(lastCommand()).toEqual(["RenameIri", { old: EX + "Invoice", new: "shop:Bill" }]);
    expect(onSelect).toHaveBeenCalledWith(EX + "Bill");
  });
});

describe("read-only cases (AC-4)", () => {
  it("says an imported class is read-only and offers only a subclass here", async () => {
    runCommand.mockResolvedValueOnce(changed("Created class Student", EX + "Student"));
    await renderForm(
      details("Agent", "class", [[P.type, uri(OWL + "Class")]], [], { importedFrom: "FOAF" }),
    );
    expect(screen.getByText("From FOAF, read-only.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Names" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a subclass in this project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name (en)" }), { target: { value: "Student" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual(["CreateClass", { label: "Student", parent: EX + "Agent", iri: undefined }]);
  });

  it("says an entity with no type in this document is defined elsewhere", async () => {
    await renderForm(details("Agent", "other", [], [[uri(EX + "Invoice", "class"), P.subClassOf]]));
    expect(screen.getByText("Defined outside this document, read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });
});

describe("DeleteFlow (AC-6)", () => {
  const impact = (children: { iri: string; label: string }[]) => ({
    dryRun: true,
    revision: 2,
    impact: {
      iri: EX + "Invoice",
      label: "Invoice",
      kind: "class",
      statements: 7,
      strategy: "reparent",
      children,
      reparentedTo: [{ iri: EX + "Document", label: "Document" }],
      properties: [{ iri: EX + "belongsTo", label: "belongs to", role: "range" }],
      individuals: [],
      importMentions: 3,
    },
  });

  it("shows the dry run and deletes only after confirmation", async () => {
    previewDelete.mockResolvedValue(
      impact([
        { iri: EX + "SalesInvoice", label: "Sales Invoice" },
        { iri: EX + "CreditNote", label: "Credit Note" },
      ]),
    );
    runCommand.mockResolvedValueOnce(changed("Deleted class Invoice"));
    await renderForm(invoice());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Invoice…" }));
    });
    const dialog = screen.getByRole("dialog");
    expect(previewDelete).toHaveBeenCalledWith(PID, "model", EX + "Invoice", "reparent");
    expect(runCommand).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Deleting Invoice removes 7 statements.")).toBeTruthy();
    expect(within(dialog).getByText("Its 2 subclasses (Sales Invoice, Credit Note):")).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Move them up to Document" })).toHaveProperty("checked", true);
    expect(dialog.textContent).toContain("belongs to, as its range");
    expect(dialog.textContent).toContain("It is used 3 times in read-only imports, which are not changed.");

    fireEvent.click(within(dialog).getByRole("radio", { name: "Leave them without a parent" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(lastCommand()).toEqual(["DeleteEntity", { iri: EX + "Invoice", strategy: "orphan" }]);
    expect(onDeleted).toHaveBeenCalledWith(EX + "Invoice");
    expect(projectStore.getSnapshot().announcement.text).toBe("Deleted class Invoice. Undo is available.");
  });

  it("offers no strategy when there are no children, and Cancel sends nothing", async () => {
    previewDelete.mockResolvedValue(impact([]));
    await renderForm(invoice());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Invoice…" }));
    });
    await waitFor(() => expect(screen.getByText("Deleting Invoice removes 7 statements.")).toBeTruthy());
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("while a command is in flight", () => {
  it("says so, and keeps the field focusable rather than disabled", async () => {
    let finish: (value: unknown) => void = () => {};
    runCommand.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await renderForm(invoice());
    fireEvent.click(screen.getByRole("button", { name: "Add name in fr" }));
    const field = screen.getByRole("textbox", { name: "name in fr" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Facture" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(document.querySelector(".edit-status")!.textContent).toBe("Saving change…");
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(true);
    await act(async () => finish(changed("Set label")));
    expect(document.querySelector(".edit-status")!.textContent).toBe("");
  });
});

describe("found in review", () => {
  it("sends one SetRange for a double submit while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    runCommand.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await renderForm(details("total", "datatypeProperty", [[P.type, uri(OWL + "DatatypeProperty")]]));
    fireEvent.click(screen.getByRole("button", { name: "Set range" }));
    const form = screen.getByRole("combobox", { name: "Type of value" }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    await act(async () => finish(changed("Set range")));
  });

  it("edits a date with a timezone without blanking it", async () => {
    const d = invoice();
    d.outgoing.push({ predicate: uri(EX + "reviewed"), object: lit("2024-01-01Z", undefined, "xsd:date") });
    await renderForm(d);
    const row = screen.getByText("2024-01-01Z").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /^Edit/ }));
    const field = document.querySelector<HTMLInputElement>(".edit-annotation.editing input")!;
    expect(field.value).toBe("2024-01-01Z");
    expect(field.placeholder).toBe("YYYY-MM-DD");
  });

  it("says so when the lists are read from a capped set of statements", async () => {
    await renderForm({ ...invoice(), incomingTotal: 900 });
    expect(screen.getByText(/more statements than the panel loads/)).toBeTruthy();
    cleanup();
    await renderForm(invoice());
    expect(screen.queryByText(/more statements than the panel loads/)).toBeNull();
  });
});
