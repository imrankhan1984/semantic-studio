/*
================================================================================
FILE: frontend/src/components/ProjectHeader.test.tsx
================================================================================

SUMMARY
    The project header (authoring-foundations 5.2, 5.4.2, Section 6, AC-10,
    AC-19): the status in words, Undo and Redo named by what they would do and
    unavailable without dropping focus, Save, the shortcuts anywhere except
    inside a text field, the polite live region, the document switcher, and
    the language menu with the display switch and missing counts; and the
    one-row bar of edit-page-rework 5.2: Turtle, the ⋯ menu by keyboard,
    Show canvas as a checkbox item, Save primary while unsaved; and
    Description… (reference-ontologies 5.5, AC-6): the header's comment
    read, one SetComment on Save, Undo takes it back, focus back on ⋯.

BASIC IDEA
    api.ts is mocked and the real store is opened on a fixed project, so
    pressing a control goes through the same action App's header runs.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, undoChange, redoChange, saveDocument, getLanguageReport, updateProject, getNodeDetails, runCommand } =
  vi.hoisted(() => ({
    openProject: vi.fn(),
    undoChange: vi.fn(),
    redoChange: vi.fn(),
    saveDocument: vi.fn(),
    getLanguageReport: vi.fn(),
    updateProject: vi.fn(),
    getNodeDetails: vi.fn(),
    runCommand: vi.fn(),
  }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  undoChange,
  redoChange,
  saveDocument,
  getLanguageReport,
  updateProject,
  getNodeDetails,
  runCommand,
}));

import { projectStore } from "../state/projectStore";
import ProjectHeader from "./ProjectHeader";

const PROJECT = {
  id: "prj-0123456789ab",
  name: "Invoices",
  createdAt: "",
  updatedAt: "",
  baseIri: "http://x#",
  prefix: "x",
  primaryLanguage: "en",
  languages: ["fr"],
  documents: [{ file: "model.ttl", role: "model" as const }],
  counts: {},
};

function doc(changes: Record<string, unknown> = {}) {
  return {
    doc: "model" as const,
    ontologyId: "prj-0123456789ab-model",
    revision: 3,
    dirty: true,
    canUndo: true,
    undoLabel: "Created class Invoice",
    canRedo: false,
    redoLabel: null,
    triples: 12,
    ...changes,
  };
}

let handlers: {
  onSwitchDocument: ReturnType<typeof vi.fn<(doc: string) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onError: ReturnType<typeof vi.fn<(message: string) => void>>;
  onSaveCopy: ReturnType<typeof vi.fn<() => void>>;
  onTurtle: ReturnType<typeof vi.fn<() => void>>;
};
let canvasToggle: ReturnType<typeof vi.fn<() => void>>;

async function renderHeader(changes: Record<string, unknown> = {}) {
  openProject.mockResolvedValue({
    project: PROJECT,
    documents: [doc(changes)],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PROJECT.id);
  handlers = {
    onSwitchDocument: vi.fn<(doc: string) => void>(),
    onClose: vi.fn<() => void>(),
    onError: vi.fn<(message: string) => void>(),
    onSaveCopy: vi.fn<() => void>(),
    onTurtle: vi.fn<() => void>(),
  };
  canvasToggle = vi.fn<() => void>();
  await act(async () => {
    render(
      <>
        <ProjectHeader {...handlers} canvas={{ on: true, onToggle: canvasToggle }} />
        <input aria-label="A text field" />
      </>,
    );
  });
}

const status = () => document.querySelector(".project-status")!.textContent;

/** Open the ⋯ menu and press one of its items. */
async function fromMenu(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name }));
  });
}
const live = () => document.querySelector("[role=status]")!.textContent;

beforeEach(() => projectStore._reset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectHeader", () => {
  it("names the project and says the status in words", async () => {
    await renderHeader();
    expect(screen.getByText("Invoices")).toBeTruthy();
    expect(status()).toBe("Unsaved changes");
    cleanup();
    projectStore._reset();
    await renderHeader({ dirty: false });
    expect(status()).toBe("Saved");
  });

  it("Undo and Redo carry what they would do, and are unavailable without being disabled", async () => {
    await renderHeader();
    const undo = screen.getByRole("button", { name: "Undo: Created class Invoice" });
    expect(undo.getAttribute("title")).toBe("Undo: Created class Invoice (Ctrl+Z)");
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(redo);
    expect(redoChange).not.toHaveBeenCalled();
  });

  it("undoing the last step keeps focus on Undo and announces what was undone (AC-10)", async () => {
    undoChange.mockResolvedValue({
      revision: 4,
      label: "Created class Invoice",
      state: doc({ revision: 4, canUndo: false, undoLabel: null, canRedo: true, redoLabel: "Created class Invoice" }),
    });
    await renderHeader();
    const undo = screen.getByRole("button", { name: "Undo: Created class Invoice" });
    undo.focus();
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(undoChange).toHaveBeenCalledWith(PROJECT.id, "model");
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(undo);
    expect(screen.getByRole("button", { name: "Redo: Created class Invoice" })).toBeTruthy();
    expect(live()).toBe("Undid: Created class Invoice. Unsaved changes.");
    expect(projectStore.getSnapshot().documents[0].revision).toBe(4);
  });

  it("Save saves and the status says so", async () => {
    saveDocument.mockResolvedValue({ savedAt: "now", state: doc({ dirty: false }) });
    await renderHeader();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(saveDocument).toHaveBeenCalledWith(PROJECT.id, "model", false);
    expect(status()).toBe("Saved");
    expect(live()).toBe("Saved.");
  });

  it("Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and Ctrl+S work outside text fields", async () => {
    undoChange.mockResolvedValue({ revision: 4, label: "x", state: doc({ canRedo: true, redoLabel: "x" }) });
    redoChange.mockResolvedValue({ revision: 5, label: "x", state: doc({ canRedo: true, redoLabel: "x" }) });
    saveDocument.mockResolvedValue({ savedAt: "now", state: doc() });
    await renderHeader({ canRedo: true, redoLabel: "x" });
    for (const init of [
      { key: "z", ctrlKey: true },
      { key: "y", ctrlKey: true },
      { key: "Z", ctrlKey: true, shiftKey: true },
      { key: "s", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      await act(async () => {
        document.body.dispatchEvent(event);
      });
      expect(event.defaultPrevented, init.key).toBe(true);
    }
    expect(undoChange).toHaveBeenCalledTimes(1);
    expect(redoChange).toHaveBeenCalledTimes(2);
    expect(saveDocument).toHaveBeenCalledTimes(1);
  });

  it("inside a text field the field's own undo wins", async () => {
    await renderHeader();
    const field = screen.getByLabelText("A text field");
    for (const key of ["z", "y", "s"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        field.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(undoChange).not.toHaveBeenCalled();
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("the document switcher is labelled and hands the choice to App", async () => {
    await renderHeader();
    const select = screen.getByLabelText("Document") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["model.ttl (unsaved)"]);
    // Add shapes.ttl is in the ⋯ menu now, so the row stays one row.
    fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
    expect(screen.getByRole("menuitem", { name: "Add shapes.ttl" })).toBeTruthy();
  });

  it("the language menu switches the display language and says what is missing", async () => {
    getLanguageReport.mockResolvedValue({ entities: 40, languages: ["en", "fr"], missing: { en: 0, fr: 12 } });
    await renderHeader();
    await fromMenu("Language: en…");
    expect(screen.getByRole("group", { name: "Show names in" })).toBeTruthy();
    expect(screen.getByText(/12 of 40 entities have no name in fr/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /^fr/ }));
    });
    expect(projectStore.getSnapshot().displayLanguage).toBe("fr");
    expect(live()).toBe("Showing names in fr.");
    // Escape in the panel gives focus back to ⋯, which names the language next time.
    fireEvent.keyDown(screen.getByRole("group", { name: "Show names in" }), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More project actions" }));
    fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
    expect(screen.getByRole("menuitem", { name: "Language: fr…" })).toBeTruthy();
  });

  it("adding a language checks the tag before asking the server", async () => {
    updateProject.mockResolvedValue({ ...PROJECT, languages: ["fr", "es"] });
    getLanguageReport.mockResolvedValue({ entities: 1, languages: ["en", "fr"], missing: { en: 0, fr: 0 } });
    await renderHeader();
    await fromMenu("Language: en…");
    const input = screen.getByLabelText("Add a language");
    fireEvent.change(input, { target: { value: "not a tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Use a language tag such as fr, es or pt-BR.")).toBeTruthy();
    expect(updateProject).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "es" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(updateProject).toHaveBeenCalledWith(PROJECT.id, { languages: ["fr", "es"] });
  });

  it("a failed action goes to App's error bar", async () => {
    undoChange.mockRejectedValue(new Error("There is nothing to undo."));
    await renderHeader();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo: Created class Invoice" }));
    });
    expect(handlers.onError).toHaveBeenCalledWith("There is nothing to undo.");
  });
});


describe("ProjectHeader, found in code review", () => {
  it("Undo, Redo and Save go through the guard, keyboard included", async () => {
    await renderHeader({ canRedo: true, redoLabel: "x" });
    cleanup();
    const guard = vi.fn();
    await act(async () => {
      render(
        <ProjectHeader guard={guard} onSwitchDocument={vi.fn()} onClose={vi.fn()} onError={vi.fn()} onSaveCopy={vi.fn()} />,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo: Created class Invoice" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo: x" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(guard).toHaveBeenCalledTimes(4);
    expect(undoChange).not.toHaveBeenCalled();
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("saving every document leaves the active one where it was", async () => {
    openProject.mockResolvedValue({
      project: { ...PROJECT, documents: [...PROJECT.documents, { file: "shapes.ttl", role: "shapes" as const }] },
      documents: [doc(), { ...doc(), doc: "shapes" as const, ontologyId: "prj-0123456789ab-shapes" }],
      recovery: { available: false, draftTime: null },
    });
    await projectStore.open(PROJECT.id);
    saveDocument
      .mockResolvedValueOnce({ savedAt: "now", state: doc({ dirty: false }) })
      .mockResolvedValueOnce({ needsCommentsWarning: true, backup: "shapes.original.ttl" })
      .mockResolvedValueOnce({
        savedAt: "now",
        state: { ...doc({ dirty: false }), doc: "shapes" as const, ontologyId: "prj-0123456789ab-shapes" },
      });
    expect(await projectStore.saveAll()).toBe("warning");
    expect(projectStore.getSnapshot().activeDoc).toBe("model");
    expect(projectStore.getSnapshot().commentsWarning).toEqual({ doc: "shapes", backup: "shapes.original.ttl" });
    await projectStore.save(true);
    expect(saveDocument).toHaveBeenLastCalledWith(PROJECT.id, "shapes", true);
    expect(projectStore.getSnapshot().activeDoc).toBe("model");
  });

  it("one row: the name, the document, the status, Undo, Redo, Save, then Turtle and ⋯ (5.2)", async () => {
    await renderHeader();
    const row = document.querySelector(".project-header")!;
    const names = [...row.querySelectorAll(":scope > button, :scope > div > button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(names).toEqual(["Undo: Created class Invoice", "Redo", "Save", "Turtle", "More project actions"]);
    // Save a copy and Close project are no longer in the row: they are in ⋯.
    expect(screen.queryByRole("button", { name: "Save a copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close project" })).toBeNull();
    // The status is a dot beside its word, never the dot alone.
    expect(document.querySelector(".project-status-dot")!.getAttribute("aria-hidden")).toBe("true");
    expect(status()).toBe("Unsaved changes");
  });

  it("Save is the primary button while there are unsaved changes, and only then", async () => {
    await renderHeader();
    expect(screen.getByRole("button", { name: "Save" }).className).toBe("primary");
    cleanup();
    projectStore._reset();
    await renderHeader({ dirty: false });
    expect(screen.getByRole("button", { name: "Save" }).className).toBe("ghost");
  });

  it("Turtle opens the current document in View's editor, through App", async () => {
    await renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Turtle" }));
    expect(handlers.onTurtle).toHaveBeenCalledTimes(1);
  });

  it("the ⋯ menu: Language, Add shapes.ttl, Save a copy, Show canvas and Close project, by keyboard", async () => {
    await renderHeader();
    const more = screen.getByRole("button", { name: "More project actions" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(more);
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "More project actions" });
    const items = [...menu.querySelectorAll("[role^='menuitem']")].map((m) => m.textContent);
    expect(items).toEqual([
      "Language: en…",
      "Description…",
      "Add shapes.ttl",
      "Save a copy",
      "✓Show canvas",
      "Close project",
    ]);
    // Focus is on the first item; arrows, End and Home move it.
    expect(document.activeElement?.textContent).toBe("Language: en…");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Description…");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Close project");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Language: en…");
    // Show canvas is a checkbox item: its state is aria-checked, not colour.
    const canvas = screen.getByRole("menuitemcheckbox", { name: "Show canvas" });
    expect(canvas.getAttribute("aria-checked")).toBe("true");
    // Escape closes and gives focus back to ⋯.
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });

  it("each ⋯ item does its one thing and leaves focus on ⋯", async () => {
    await renderHeader();
    await fromMenu("Save a copy");
    expect(handlers.onSaveCopy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More project actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show canvas" }));
    });
    expect(canvasToggle).toHaveBeenCalledTimes(1);
    await fromMenu("Close project");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  describe("Description… (reference-ontologies 5.5)", () => {
    const HEADER = "http://x";
    const COMMENT = "http://www.w3.org/2000/01/rdf-schema#comment";
    const details = (comments: { value: string; lang: string }[]) => ({
      iri: HEADER,
      prefixed: "<http://x>",
      label: "Invoices",
      outgoing: comments.map((c) => ({
        predicate: { type: "uri", value: COMMENT },
        object: { type: "literal", value: c.value, lang: c.lang },
      })),
      incoming: [],
      outgoingTotal: comments.length,
      incomingTotal: 0,
    });

    async function openDescription() {
      await fromMenu("Description…");
      return screen.getByRole("dialog", { name: "Description" });
    }

    it("reads the header's comment in the primary language and saves one SetComment", async () => {
      await renderHeader({ header: HEADER });
      getNodeDetails.mockResolvedValue(details([{ value: "Les factures.", lang: "fr" }, { value: "Invoices.", lang: "en" }]));
      runCommand.mockResolvedValue({
        revision: 4,
        label: "Set comment of Invoices (en)",
        state: doc({ header: HEADER, revision: 4, undoLabel: "Set comment of Invoices (en)" }),
      });
      const dialog = await openDescription();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(getNodeDetails).toHaveBeenCalledWith("prj-0123456789ab-model", HEADER);
      const area = screen.getByLabelText(/What this project is about/) as HTMLTextAreaElement;
      expect(area.value).toBe("Invoices.");
      fireEvent.change(area, { target: { value: "  Invoices and the parties to them.  " } });
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog", { name: "Description" })).getByRole("button", { name: "Save" }));
      });
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(runCommand).toHaveBeenCalledWith("prj-0123456789ab", "model", "SetComment", {
        iri: HEADER,
        value: "Invoices and the parties to them.",
        lang: "en",
      });
      expect(live()).toBe("Description saved.");
      expect(screen.queryByRole("dialog", { name: "Description" })).toBeNull();
      // Focus back on ⋯, the menu's way back (5.5).
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "More project actions" }));
      // One step: Undo names it and takes it back.
      const undo = screen.getByRole("button", { name: "Undo: Set comment of Invoices (en)" });
      undoChange.mockResolvedValue({ revision: 5, label: "Set comment of Invoices (en)", state: doc({ header: HEADER, revision: 5, canUndo: false }) });
      await act(async () => {
        fireEvent.click(undo);
      });
      expect(undoChange).toHaveBeenCalledTimes(1);
    });

    it("works for a project made before E-12, with no description yet", async () => {
      await renderHeader({ header: HEADER });
      getNodeDetails.mockResolvedValue(details([]));
      await openDescription();
      const area = screen.getByLabelText(/What this project is about/) as HTMLTextAreaElement;
      expect(area.value).toBe("");
      const save = within(screen.getByRole("dialog", { name: "Description" })).getByRole("button", { name: "Save" });
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(save.getAttribute("aria-describedby")!)!.textContent).toBe(
        "Write a description to save it.",
      );
      fireEvent.change(area, { target: { value: "Invoices." } });
      expect(within(screen.getByRole("dialog", { name: "Description" })).getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("false");
    });

    it("Escape and the ✕ close it without a change, focus back on ⋯", async () => {
      await renderHeader({ header: HEADER });
      getNodeDetails.mockResolvedValue(details([]));
      await openDescription();
      await act(async () => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(screen.queryByRole("dialog", { name: "Description" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "More project actions" }));
      await openDescription();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close Description" }));
      });
      expect(screen.queryByRole("dialog", { name: "Description" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "More project actions" }));
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("says the counter past 2,000 characters and does not save", async () => {
      await renderHeader({ header: HEADER });
      getNodeDetails.mockResolvedValue(details([]));
      await openDescription();
      fireEvent.change(screen.getByLabelText(/What this project is about/), { target: { value: "y".repeat(2001) } });
      expect(document.getElementById("description-dialog-count")!.textContent).toBe(
        "2,001 of 2,000 characters: shorten it by 1.",
      );
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog", { name: "Description" })).getByRole("button", { name: "Save" }));
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("a model with no header says so instead of opening", async () => {
      await renderHeader({ header: null });
      await fromMenu("Description…");
      expect(screen.queryByRole("dialog", { name: "Description" })).toBeNull();
      expect(handlers.onError).toHaveBeenCalledWith(
        "This model has no ontology header (owl:Ontology) to describe. Add one in Turtle first.",
      );
    });
  });

  it("a press outside closes the menu", async () => {
    await renderHeader();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More project actions" }));
    });
    expect(screen.getByRole("menu", { name: "More project actions" })).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText("A text field"));
    });
    expect(screen.queryByRole("menu", { name: "More project actions" })).toBeNull();
  });
});
