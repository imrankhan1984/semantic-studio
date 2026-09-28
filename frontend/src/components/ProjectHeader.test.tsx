/*
================================================================================
FILE: frontend/src/components/ProjectHeader.test.tsx
================================================================================

SUMMARY
    The project header (authoring-foundations 5.2, 5.4.2, Section 6, AC-10,
    AC-19): the status in words, Undo and Redo named by what they would do and
    unavailable without dropping focus, Save, the shortcuts anywhere except
    inside a text field, the polite live region, the document switcher, and
    the language menu with the display switch and missing counts.

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

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, undoChange, redoChange, saveDocument, getLanguageReport, updateProject } =
  vi.hoisted(() => ({
    openProject: vi.fn(),
    undoChange: vi.fn(),
    redoChange: vi.fn(),
    saveDocument: vi.fn(),
    getLanguageReport: vi.fn(),
    updateProject: vi.fn(),
  }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  undoChange,
  redoChange,
  saveDocument,
  getLanguageReport,
  updateProject,
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
};

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
  };
  await act(async () => {
    render(
      <>
        <ProjectHeader {...handlers} />
        <input aria-label="A text field" />
      </>,
    );
  });
}

const status = () => document.querySelector(".project-status")!.textContent;
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
    expect(screen.getByRole("button", { name: "Add shapes.ttl" })).toBeTruthy();
  });

  it("the language menu switches the display language and says what is missing", async () => {
    getLanguageReport.mockResolvedValue({ entities: 40, languages: ["en", "fr"], missing: { en: 0, fr: 12 } });
    await renderHeader();
    const button = screen.getByRole("button", { name: "Language: en" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/12 of 40 entities have no name in fr/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /^fr/ }));
    });
    expect(projectStore.getSnapshot().displayLanguage).toBe("fr");
    expect(screen.getByRole("button", { name: "Language: fr" })).toBeTruthy();
    expect(live()).toBe("Showing names in fr.");
  });

  it("adding a language checks the tag before asking the server", async () => {
    updateProject.mockResolvedValue({ ...PROJECT, languages: ["fr", "es"] });
    getLanguageReport.mockResolvedValue({ entities: 1, languages: ["en", "fr"], missing: { en: 0, fr: 0 } });
    await renderHeader();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Language: en" }));
    });
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
