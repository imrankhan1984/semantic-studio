/*
================================================================================
FILE: frontend/src/components/ProjectsSection.test.tsx
================================================================================

SUMMARY
    "My projects" (authoring-foundations 5.1, AC-3, AC-4, AC-19): the empty
    state's sentence, a card per project with its counts, documents and date,
    Open, and the menu's four actions -- Rename in place, Duplicate, Export as
    zip, Delete -- each reached by keyboard and named for its project.

BASIC IDEA
    Rendered alone with spies for every callback; the actions themselves are
    App's and are tested there. What this file owns is that each control
    exists, is named, and hands over the right id.

INPUTS / INPUT SOURCES
    - Fixed project summaries.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectsSection from "./ProjectsSection";
import type { ProjectSummary } from "../types";

const PROJECT: ProjectSummary = {
  id: "prj-0123456789ab",
  name: "Invoices",
  createdAt: "2026-09-28T08:00:00+00:00",
  updatedAt: "2026-09-28T09:00:00+00:00",
  baseIri: "http://example.org/invoices#",
  prefix: "invoices",
  primaryLanguage: "en",
  languages: [],
  documents: [
    { file: "model.ttl", role: "model" },
    { file: "shapes.ttl", role: "shapes" },
  ],
  counts: { classes: 2, properties: 1, concepts: 0 },
  kind: "ontology",
};

function renderSection(props: Partial<React.ComponentProps<typeof ProjectsSection>> = {}) {
  const handlers = {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onRename: vi.fn(async () => undefined),
    onChangeKind: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ProjectsSection
      projects={[PROJECT]}
      loading={false}
      error={null}
      busyId={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(() => cleanup());

describe("ProjectsSection", () => {
  it("says what to do when there are no projects, beside New project", () => {
    const { onNew } = renderSection({ projects: [] });
    expect(
      screen.getByText(
        "No projects yet. Start one from a template or from any ontology in your library.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("shows each project's name, counts, documents and when it changed", () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 3, name: "Invoices" })).toBeTruthy();
    expect(screen.getByText("2 classes, 1 property, 0 concepts")).toBeTruthy();
    expect(screen.getByText("model.ttl, shapes.ttl")).toBeTruthy();
    expect(screen.getByText(/^Changed /)).toBeTruthy();
  });

  it("gives each data snapshot a line on the card, a sample's words included (csv-data-import 5.7)", () => {
    renderSection({ projects: [{ ...PROJECT, data: [{ ...{ id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true }, enabled: false }] }] });
    expect(screen.getByText("Data from people.csv, imported 2 October 2026; sample: first 2,000 of 12,480 rows (off)")).toBeTruthy();
  });

  it("Open is named for its project and hands over the id", () => {
    const { onOpen } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Open Invoices" }));
    expect(onOpen).toHaveBeenCalledWith(PROJECT.id);
  });

  it("the menu is named, moves focus in, and offers the four actions", async () => {
    const handlers = renderSection();
    const more = screen.getByRole("button", { name: "More actions for Invoices" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(more);
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = ["Rename", "Duplicate", "Export as zip", "Delete"];
    expect(document.activeElement?.textContent).toBe("Rename");
    for (const name of items) expect(screen.getByRole("button", { name })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(handlers.onDuplicate).toHaveBeenCalledWith(PROJECT.id);
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));
    expect(handlers.onExport).toHaveBeenCalledWith(PROJECT.id);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(handlers.onDelete).toHaveBeenCalledWith(PROJECT.id);
  });

  it("Escape closes the menu and gives focus back to its button", async () => {
    renderSection();
    const more = screen.getByRole("button", { name: "More actions for Invoices" });
    await act(async () => {
      fireEvent.click(more);
    });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });

  it("Rename happens in a labelled field: Enter saves, Escape abandons", async () => {
    const { onRename } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Invoices" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    const field = screen.getByLabelText("New name for Invoices") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Bills" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await act(async () => undefined);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New name for Invoices")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions for Invoices" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    const again = screen.getByLabelText("New name for Invoices");
    fireEvent.change(again, { target: { value: "Bills" } });
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
    });
    expect(onRename).toHaveBeenCalledWith(PROJECT.id, "Bills");
  });

  it("while one project is busy the controls say so and do nothing, keeping focus", () => {
    const { onOpen } = renderSection({ busyId: PROJECT.id });
    const open = screen.getByRole("button", { name: "Open Invoices" });
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.hasAttribute("disabled")).toBe(false);
    expect(open.textContent).toBe("Working…");
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says the project's kind, and offers to change it from its menu (relationships AC-1)", () => {
    const { onChangeKind } = renderSection({ projects: [PROJECT, { ...PROJECT, id: "prj-bbbbbbbbbbbb", name: "Fruit", kind: "taxonomy" }] });
    const [invoices, fruit] = screen.getAllByRole("article");
    expect(invoices.querySelector(".project-kind")!.textContent).toBe("Ontology");
    expect(fruit.querySelector(".project-kind")!.textContent).toBe("Taxonomy");
    fireEvent.click(screen.getByRole("button", { name: "More actions for Invoices" }));
    fireEvent.click(screen.getByRole("button", { name: "Change to taxonomy…" }));
    expect(onChangeKind).toHaveBeenCalledWith(PROJECT.id);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Fruit" }));
    expect(screen.getByRole("button", { name: "Change to ontology…" })).toBeTruthy();
  });

  it("a project from before kinds names none and offers no change until it is opened", () => {
    renderSection({ projects: [{ ...PROJECT, kind: null }] });
    expect(document.querySelector(".project-kind")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Invoices" }));
    expect(screen.queryByRole("button", { name: /Change to/ })).toBeNull();
  });
});
