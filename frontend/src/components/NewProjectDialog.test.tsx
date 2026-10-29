/*
================================================================================
FILE: frontend/src/components/NewProjectDialog.test.tsx
================================================================================

SUMMARY
    The New project form (authoring-foundations 5.1, Section 6, AC-1, AC-2,
    AC-19; relationships 5.1, AC-1): Ontology or Taxonomy asked first with
    the spec's sentences, and each kind's two templates; the base IRI and
    prefix follow the name until edited, Create is unavailable with its
    reason until the form is valid, an invalid base IRI is said inline, a
    library ontology can be preselected and needs no kind, and the dialog
    behaves as a dialog. Reference ontologies (reference-ontologies 5.4,
    AC-4): *Reuse terms from* for a template only, nothing ticked; the
    description prefilled, following the name and the boxes until edited;
    its counter past 2,000; a prefix equal to a ticked reference's.

BASIC IDEA
    Rendered alone; onCreate is a spy, so what is asserted is exactly what the
    form hands over. The pure rules behind it (projects/form.ts) are checked
    at the foot, where they are cheaper to reach than through the form.

INPUTS / INPUT SOURCES
    - A fixed library list; listReferences mocked with FOAF and QUDT.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewProjectDialog, { type NewProjectRequest } from "./NewProjectDialog";
import { defaultBaseIri, defaultDescription, defaultPrefix, validate } from "../projects/form";
import type { ReferenceOntology } from "../types";

const REFERENCES: ReferenceOntology[] = [
  {
    key: "foaf",
    title: "FOAF",
    prefixes: { foaf: "http://xmlns.com/foaf/0.1/" },
    purpose: "people, organizations and their links",
    sentence: "It reuses FOAF for people and organizations.",
  },
  {
    key: "qudt",
    title: "QUDT",
    prefixes: { qudt: "http://qudt.org/schema/qudt/" },
    purpose: "quantities, units and dimensions",
    sentence: "It reuses QUDT for quantities and units.",
  },
];
const { listReferences } = vi.hoisted(() => ({ listReferences: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listReferences,
}));
listReferences.mockResolvedValue(REFERENCES);

const LIBRARY = [
  { id: "ont-1", name: "foaf.rdf" },
  { id: "ont-2", name: "schema.ttl" },
];

function renderDialog(props: Partial<React.ComponentProps<typeof NewProjectDialog>> = {}) {
  const onCreate = vi.fn(async (_request: NewProjectRequest) => undefined);
  const onClose = vi.fn();
  render(<NewProjectDialog library={LIBRARY} onCreate={onCreate} onClose={onClose} {...props} />);
  return { onCreate, onClose };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const create = () => screen.getByRole("button", { name: /^Create/ });
const kind = (name: "Ontology" | "Taxonomy") =>
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const reasonOf = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby")!)!.textContent;

afterEach(() => cleanup());

describe("NewProjectDialog", () => {
  it("is a named dialog whose heading takes focus", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "New project" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.textContent).toBe("New project");
  });

  it("the base IRI and prefix follow the name until edited", () => {
    renderDialog();
    fireEvent.change(field("Name"), { target: { value: "My Invoices" } });
    expect(field("Base IRI").value).toBe("http://example.org/my-invoices#");
    expect(field("Prefix").value).toBe("myinvoices");
    fireEvent.change(field("Base IRI"), { target: { value: "https://acme.test/inv/" } });
    fireEvent.change(field("Name"), { target: { value: "Bills" } });
    expect(field("Base IRI").value).toBe("https://acme.test/inv/");
    expect(field("Prefix").value).toBe("bills");
  });

  it("asks Ontology or Taxonomy first, each with its sentence, and nothing chosen", () => {
    renderDialog();
    const group = screen.getByRole("group", { name: "What are you making?" });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    // The first control of the form, before the name.
    expect(group.compareDocumentPosition(field("Name")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each radio is named by its sentence too, so it is read with the choice.
    expect(screen.getByRole("radio", { name: /^Ontology/ }).closest("label")!.textContent).toBe(
      "OntologyClasses of things, their attributes and the relationships between them. For example: a Person works for an Organization.",
    );
    expect(screen.getByRole("radio", { name: /^Taxonomy/ }).closest("label")!.textContent).toBe(
      "TaxonomyA vocabulary of concepts arranged from broad to narrow, with related terms. For example: Apple is narrower than Fruit.",
    );
  });

  it("offers each kind's two templates, and switches with the kind", () => {
    renderDialog();
    const select = field("Start from") as unknown as HTMLSelectElement;
    const templates = () => [...select.querySelectorAll('optgroup[label="Templates"] option')].map((o) => o.textContent);
    expect(templates()).toEqual([]);
    kind("Ontology");
    expect(templates()).toEqual(["Empty ontology", "Small ontology (two classes, one relationship)"]);
    expect(select.value).toBe("template:small");
    kind("Taxonomy");
    expect(templates()).toEqual(["Empty taxonomy (one concept scheme)", "Small taxonomy (a scheme with a few concepts)"]);
    expect(select.value).toBe("template:taxonomy-small");
  });

  it("Create is unavailable with its reason until the form is valid", async () => {
    const { onCreate } = renderDialog();
    const button = create();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Not disabled: it stays focusable, and its description says why.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(reasonOf(button)).toBe("Choose Ontology or Taxonomy.");
    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    expect(reasonOf(create())).toBe("Choose Ontology or Taxonomy.");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(field("Name"), { target: { value: "" } });
    kind("Ontology");
    expect(reasonOf(create())).toBe("Give the project a name.");

    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    expect(create().getAttribute("aria-disabled")).toBe("false");
    expect(create().getAttribute("aria-describedby")).toBeNull();
  });

  it("an invalid base IRI is said inline and blocks Create", async () => {
    renderDialog();
    kind("Ontology");
    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    fireEvent.change(field("Base IRI"), { target: { value: "http://example.org/invoices" } });
    fireEvent.blur(field("Base IRI"));
    const message = "The base IRI must be an absolute IRI ending in # or /, for example http://example.org/invoices#.";
    expect(field("Base IRI").getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field("Base IRI").getAttribute("aria-describedby")!)!.textContent).toBe(message);
    expect(create().getAttribute("aria-disabled")).toBe("true");
  });

  it("creates from a template with the fields it shows", async () => {
    const { onCreate } = renderDialog();
    fireEvent.change(field("Name"), { target: { value: "Pets" } });
    kind("Taxonomy");
    fireEvent.change(field("Start from"), { target: { value: "template:taxonomy-empty" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({
      name: "Pets",
      template: "taxonomy-empty",
      baseIri: "http://example.org/pets#",
      prefix: "pets",
      primaryLanguage: "en",
      references: [],
      description: "An ontology for Pets.",
    });
  });

  it("preselects a library ontology, which needs no kind: the server judges it", async () => {
    const { onCreate } = renderDialog({ initialSource: "ont-2" });
    const select = field("Start from") as unknown as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(["foaf.rdf", "schema.ttl"]);
    expect(select.value).toBe("library:ont-2");
    expect(create().getAttribute("aria-disabled")).toBe("false");
    expect(field("Name").value).toBe("schema");
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ fromOntologyId: "ont-2", name: "schema" });
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("template");
    // A copy keeps its own file: no references are sent, nor offered.
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("references");
    expect(screen.queryByRole("group", { name: "Reuse terms from" })).toBeNull();
  });

  it("a library copy clears the kind, and says how its kind is judged (review)", () => {
    renderDialog();
    kind("Ontology");
    fireEvent.change(field("Start from"), { target: { value: "library:ont-1" } });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    const hint = document.getElementById(field("Start from").getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toContain("concepts and no classes make a taxonomy");
    // Choosing a kind again is choosing its template, in sight in the select.
    kind("Taxonomy");
    expect(field("Start from").value).toBe("template:taxonomy-small");
    expect(field("Start from").getAttribute("aria-describedby")).toBeNull();
  });

  it("shows the server's refusal and stays open", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("The prefix must start with a letter.");
    });
    renderDialog({ onCreate });
    kind("Ontology");
    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.getByRole("alert").textContent).toBe("The prefix must start with a letter.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers Reuse terms from for a template only, each box named by its purpose, none ticked", async () => {
    renderDialog();
    await act(async () => undefined);
    // No template chosen yet: nothing to reuse terms in.
    expect(screen.queryByRole("group", { name: "Reuse terms from" })).toBeNull();
    kind("Ontology");
    const group = screen.getByRole("group", { name: "Reuse terms from" });
    const boxes = [...group.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false]);
    expect(screen.getByRole("checkbox", { name: "FOAF: people, organizations and their links" })).toBe(boxes[0]);
    expect(screen.getByRole("checkbox", { name: "QUDT: quantities, units and dimensions" })).toBe(boxes[1]);
    // After Start from (5.4 item 1).
    expect(field("Start from").compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(field("Start from"), { target: { value: "library:ont-1" } });
    expect(screen.queryByRole("group", { name: "Reuse terms from" })).toBeNull();
  });

  it("the description follows the name and the boxes until edited, then is left alone", async () => {
    const { onCreate } = renderDialog();
    await act(async () => undefined);
    kind("Ontology");
    const description = () => screen.getByLabelText("Description") as HTMLTextAreaElement;
    // Under the name.
    expect(field("Name").compareDocumentPosition(description()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(field("Name"), { target: { value: "Plant" } });
    expect(description().value).toBe("An ontology for Plant.");
    fireEvent.click(screen.getByRole("checkbox", { name: /^QUDT/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^FOAF/ }));
    expect(description().value).toBe(
      "An ontology for Plant. It reuses FOAF for people and organizations. It reuses QUDT for quantities and units.",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /^FOAF/ }));
    expect(description().value).toBe("An ontology for Plant. It reuses QUDT for quantities and units.");
    fireEvent.change(description(), { target: { value: "Pumps and their units." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^FOAF/ }));
    fireEvent.change(field("Name"), { target: { value: "Plant two" } });
    expect(description().value).toBe("Pumps and their units.");
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      references: ["foaf", "qudt"],
      description: "Pumps and their units.",
      template: "small",
    });
  });

  it("a cleared description is sent empty, which writes none", async () => {
    const { onCreate } = renderDialog();
    kind("Ontology");
    fireEvent.change(field("Name"), { target: { value: "Plant" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate.mock.calls[0][0].description).toBe("");
  });

  it("says the counter only past 2,000 characters, and blocks Create", () => {
    renderDialog();
    kind("Ontology");
    fireEvent.change(field("Name"), { target: { value: "Plant" } });
    const area = screen.getByLabelText("Description") as HTMLTextAreaElement;
    const count = document.getElementById("new-project-description-count")!;
    // A live region, there while empty, so its first words are heard.
    expect(count.getAttribute("aria-live")).toBe("polite");
    fireEvent.change(area, { target: { value: "x".repeat(2000) } });
    expect(count.textContent).toBe("");
    expect(create().getAttribute("aria-disabled")).toBe("false");
    fireEvent.change(area, { target: { value: "x".repeat(2001) } });
    expect(count.textContent).toBe("2,001 of 2,000 characters: shorten it by 1.");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    expect(area.getAttribute("aria-describedby")).toContain("new-project-description-count");
    expect(reasonOf(create())).toBe("A description can be at most 2,000 characters.");
  });

  it("refuses a prefix equal to a ticked reference's, under the field", async () => {
    renderDialog();
    await act(async () => undefined);
    kind("Ontology");
    fireEvent.change(field("Name"), { target: { value: "QUDT test" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^QUDT/ }));
    // The default, qudttest, is fine.
    expect(field("Prefix").value).toBe("qudttest");
    expect(create().getAttribute("aria-disabled")).toBe("false");
    fireEvent.change(field("Prefix"), { target: { value: "qudt" } });
    const message = "qudt is QUDT's prefix. Choose another for your project.";
    expect(document.getElementById(field("Prefix").getAttribute("aria-describedby")!)!.textContent).toBe(message);
    expect(reasonOf(create())).toBe(message);
    fireEvent.click(screen.getByRole("checkbox", { name: /^QUDT/ }));
    expect(create().getAttribute("aria-disabled")).toBe("false");
  });

  it("Escape and Cancel close it", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("the form's rules (projects/form.ts)", () => {
  it("defaults the base IRI and prefix from the name", () => {
    expect(defaultBaseIri("Café Menu 2")).toBe("http://example.org/caf-menu-2#");
    expect(defaultPrefix("2026 Plan")).toBe("p2026plan");
    expect(defaultBaseIri("   ")).toBe("http://example.org/project#");
  });

  it("names every invalid field", () => {
    expect(validate({ name: "", baseIri: "x", prefix: "1a", primaryLanguage: "english" })).toEqual({
      name: "Give the project a name.",
      baseIri: expect.stringContaining("ending in # or /"),
      prefix: expect.stringContaining("start with a letter"),
      primaryLanguage: "Use a language tag such as en, en-US or fr.",
    });
    expect(
      validate({ name: "A", baseIri: "urn:acme:vocab/", prefix: "acme", primaryLanguage: "en-US" }),
    ).toEqual({});
  });

  it("reads a reference's prefixes as own keys only", () => {
    const fields = { name: "A", baseIri: "urn:acme:vocab/", prefix: "constructor", primaryLanguage: "en" };
    expect(validate(fields, REFERENCES)).toEqual({});
    expect(validate({ ...fields, prefix: "foaf" }, REFERENCES).prefix).toBe(
      "foaf is FOAF's prefix. Choose another for your project.",
    );
  });

  it("writes the default description from the name and the references, in order", () => {
    expect(defaultDescription("Plant", [])).toBe("An ontology for Plant.");
    expect(defaultDescription("  ", [REFERENCES[1]])).toBe("It reuses QUDT for quantities and units.");
  });
});
