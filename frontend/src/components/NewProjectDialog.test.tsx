/*
================================================================================
FILE: frontend/src/components/NewProjectDialog.test.tsx
================================================================================

SUMMARY
    The New project form (authoring-foundations 5.1, Section 6, AC-1, AC-2,
    AC-19): the base IRI and prefix follow the name until edited, Create is
    unavailable with its reason until the form is valid, an invalid base IRI
    is said inline, the three templates and the library are offered, a
    library ontology can be preselected, and the dialog behaves as a dialog.

BASIC IDEA
    Rendered alone; onCreate is a spy, so what is asserted is exactly what the
    form hands over. The pure rules behind it (projects/form.ts) are checked
    at the foot, where they are cheaper to reach than through the form.

INPUTS / INPUT SOURCES
    - A fixed library list.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewProjectDialog, { type NewProjectRequest } from "./NewProjectDialog";
import { defaultBaseIri, defaultPrefix, validate } from "../projects/form";

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

  it("Create is unavailable with its reason until the form is valid", async () => {
    const { onCreate } = renderDialog();
    const button = create();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Not disabled: it stays focusable, and its description says why.
    expect(button.hasAttribute("disabled")).toBe(false);
    const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toBe("Give the project a name.");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    expect(create().getAttribute("aria-disabled")).toBe("false");
    expect(create().getAttribute("aria-describedby")).toBeNull();
  });

  it("an invalid base IRI is said inline and blocks Create", async () => {
    renderDialog();
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
    fireEvent.change(field("Start from"), { target: { value: "template:vocabulary" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate).toHaveBeenCalledWith({
      name: "Pets",
      template: "vocabulary",
      baseIri: "http://example.org/pets#",
      prefix: "pets",
      primaryLanguage: "en",
    });
  });

  it("offers the three templates and the library, and preselects a library ontology", async () => {
    const { onCreate } = renderDialog({ initialSource: "ont-2" });
    const select = field("Start from") as unknown as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual([
      "Empty ontology",
      "Simple vocabulary (a SKOS scheme with two concepts)",
      "Small ontology (two classes and one property)",
      "foaf.rdf",
      "schema.ttl",
    ]);
    expect(select.value).toBe("library:ont-2");
    expect(field("Name").value).toBe("schema");
    await act(async () => {
      fireEvent.click(create());
    });
    expect(onCreate.mock.calls[0][0]).toMatchObject({ fromOntologyId: "ont-2", name: "schema" });
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("template");
  });

  it("shows the server's refusal and stays open", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("The prefix must start with a letter.");
    });
    renderDialog({ onCreate });
    fireEvent.change(field("Name"), { target: { value: "Invoices" } });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(screen.getByRole("alert").textContent).toBe("The prefix must start with a letter.");
    expect(screen.getByRole("dialog")).toBeTruthy();
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
});
