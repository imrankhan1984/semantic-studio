/*
================================================================================
FILE: frontend/src/components/ProjectsSection.test.tsx
================================================================================

SUMMARY
    A project's card (authoring-foundations 5.1, AC-3, AC-4, AC-19): its
    counts, documents and date, Open, and the menu's four actions -- Rename in
    place, Duplicate, Export as zip, Delete -- each reached by keyboard and
    named for its project. Since home-and-examples 5.5 the card stands in
    Home's one library; the heading, New project and the empty sentence are
    HomeScreen's and tested there.

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
import ProjectCard from "./ProjectsSection";
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

function renderSection(props: Partial<React.ComponentProps<typeof ProjectCard>> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onRename: vi.fn(async () => undefined),
    onChangeKind: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    onRemoveFromHome: vi.fn(),
    onLocate: vi.fn(),
  };
  render(<ProjectCard project={PROJECT} busy={false} disabled={false} {...handlers} {...props} />);
  return handlers;
}

afterEach(() => cleanup());

describe("ProjectCard in a chosen folder (projects-anywhere Section 6)", () => {
  const ELSEWHERE = { ...PROJECT, folder: "D:\\Work\\A very long folder name that a narrow card has to wrap\\Motors" };

  it("shows its folder on a line of its own, whole (AC-16)", () => {
    renderSection({ project: ELSEWHERE });
    const line = screen.getByText(`In ${ELSEWHERE.folder}`);
    expect(line.className).toBe("project-folder");
    // Whole in the text, and nothing in its class cuts it.
    expect(line.textContent).toBe(`In ${ELSEWHERE.folder}`);
  });

  it("offers Remove from Home and no Delete (AC-9, AC-16)", () => {
    const handlers = renderSection({ project: ELSEWHERE });
    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    const remove = screen.getByRole("button", { name: "Remove from Home" });
    fireEvent.click(remove);
    expect(handlers.onRemoveFromHome).toHaveBeenCalledWith(PROJECT.id);
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("a project in Semantic Studio's folder keeps Delete and has no folder line", () => {
    renderSection();
    expect(document.querySelector(".project-folder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove from Home" })).toBeNull();
  });

  it("a missing folder says so in words, with Locate… and Remove from Home and no counts (AC-8)", () => {
    const handlers = renderSection({
      project: { ...ELSEWHERE, missing: true, counts: {}, documents: [] },
    });
    const card = screen.getByRole("article");
    expect(card.className).toContain("missing");
    expect(screen.getByText(`Folder not found: ${ELSEWHERE.folder}`)).toBeTruthy();
    expect(card.textContent).not.toMatch(/class|propert|concept/);
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Locate the folder of Invoices" }));
    expect(handlers.onLocate).toHaveBeenCalledWith(PROJECT.id);
    fireEvent.click(screen.getByRole("button", { name: "Remove Invoices from Home" }));
    expect(handlers.onRemoveFromHome).toHaveBeenCalledWith(PROJECT.id);
    // Locate… is the card's start control, for Home's focus.
    expect(screen.getByRole("button", { name: "Locate the folder of Invoices" }).hasAttribute("data-card-start")).toBe(true);
  });
});

describe("ProjectCard", () => {
  it("is laid out as a row when the library around it is (home-and-examples 5.5)", () => {
    renderSection({ layout: "row" });
    expect(screen.getByRole("article").className).toContain("onto-row");
    cleanup();
    renderSection();
    expect(screen.getByRole("article").className).not.toContain("onto-row");
  });

  it("hands Home its Open button for the start focus", () => {
    const openRef = { current: null as HTMLButtonElement | null };
    renderSection({ openRef });
    expect(openRef.current).toBe(screen.getByRole("button", { name: "Open Invoices" }));
  });

  it("shows each project's name, counts, documents and when it changed", () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 3, name: "Invoices" })).toBeTruthy();
    expect(screen.getByText("2 classes, 1 property, 0 concepts")).toBeTruthy();
    expect(screen.getByText("model.ttl, shapes.ttl")).toBeTruthy();
    expect(screen.getByText(/^Changed /)).toBeTruthy();
  });

  it("gives each data snapshot a line on the card, a sample's words included (csv-data-import 5.7)", () => {
    renderSection({ project: { ...PROJECT, data: [{ ...{ id: "people-abc123", source: "people.csv", importedAt: "2026-10-02T12:00:00Z", rows: 2000, total: 12480, sample: true }, enabled: false }] } });
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
    const { onOpen } = renderSection({ busy: true, disabled: true });
    const open = screen.getByRole("button", { name: "Open Invoices" });
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.hasAttribute("disabled")).toBe(false);
    expect(open.textContent).toBe("Working…");
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says the project's kind, and offers to change it from its menu (relationships AC-1)", () => {
    const { onChangeKind } = renderSection();
    render(
      <ProjectCard
        project={{ ...PROJECT, id: "prj-bbbbbbbbbbbb", name: "Fruit", kind: "taxonomy" }}
        busy={false}
        disabled={false}
        onOpen={vi.fn()}
        onRename={vi.fn(async () => undefined)}
        onChangeKind={vi.fn()}
        onDuplicate={vi.fn()}
        onExport={vi.fn()}
        onRemoveFromHome={vi.fn()}
        onLocate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
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
    renderSection({ project: { ...PROJECT, kind: null } });
    expect(document.querySelector(".project-kind")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Invoices" }));
    expect(screen.queryByRole("button", { name: /Change to/ })).toBeNull();
  });
});
