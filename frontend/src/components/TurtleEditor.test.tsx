/*
================================================================================
FILE: frontend/src/components/TurtleEditor.test.tsx
================================================================================

SUMMARY
    The Turtle editor (authoring-foundations 5.3, AC-8, AC-19): it shows the
    document's text with line numbers; Apply and Ctrl+Enter send the edited
    text; invalid Turtle leaves the text in place and names the line and
    column, with rdflib's message behind a disclosure; Discard edits returns
    to the document; a refetch never overwrites unapplied edits; the field is
    labelled and Tab is left to leave it.

BASIC IDEA
    api.ts is mocked and the real project store drives the component, so the
    draft lives where App will look for it. The leave prompt ("Apply, discard,
    or stay?") is App's, because only App sees the way out; it is tested in
    App.test.tsx, and this file checks the half that belongs here -- that the
    unapplied text is in the store for App to ask about.

INPUTS / INPUT SOURCES
    - A mocked api.ts; the project store opened on a fixed project.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentSource, applyDocumentSource, openProject } = vi.hoisted(() => ({
  getDocumentSource: vi.fn(),
  applyDocumentSource: vi.fn(),
  openProject: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getDocumentSource,
  applyDocumentSource,
  openProject,
}));

import { TurtleError } from "../api";
import { projectStore } from "../state/projectStore";
import TurtleEditor from "./TurtleEditor";

const TEXT = "@prefix : <http://x#> .\n# a comment\n:A a :B .\n";
const EDITED = TEXT + ":C a :D .\n";

function state(revision = 0) {
  return {
    doc: "model" as const,
    ontologyId: "prj-0123456789ab-model",
    revision,
    dirty: revision > 0,
    canUndo: revision > 0,
    undoLabel: revision > 0 ? "Applied Turtle edits" : null,
    canRedo: false,
    redoLabel: null,
    triples: 3,
  };
}

async function renderEditor(revision = 0) {
  await act(async () => {
    render(<TurtleEditor projectId="prj-0123456789ab" doc="model" revision={revision} />);
  });
}

const editor = () => screen.getByRole("textbox", { name: "Turtle source of model.ttl" }) as HTMLTextAreaElement;
const applyButton = () => screen.getByRole("button", { name: /^Apply/ });

beforeEach(async () => {
  projectStore._reset();
  getDocumentSource.mockResolvedValue({ text: TEXT, revision: 0, fromEditor: true });
  openProject.mockResolvedValue({
    project: {
      id: "prj-0123456789ab", name: "P", createdAt: "", updatedAt: "", baseIri: "http://x#",
      prefix: "x", primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {},
    },
    documents: [state()],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open("prj-0123456789ab");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TurtleEditor", () => {
  it("is a labelled field holding the document's text, with line numbers beside it", async () => {
    await renderEditor();
    expect(editor().value).toBe(TEXT);
    expect(getDocumentSource).toHaveBeenCalledWith("prj-0123456789ab", "model");
    const gutter = document.querySelector(".turtle-gutter")!;
    expect(gutter.getAttribute("aria-hidden")).toBe("true");
    expect(gutter.textContent).toBe("1234");
    expect(screen.getByText("Matches the document.")).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("says a relative IRI is read on the project's base IRI (CF-8)", async () => {
    await renderEditor();
    expect(editor().getAttribute("aria-describedby")).toBe("turtle-editor-help");
    expect(document.getElementById("turtle-editor-help")!.textContent).toContain(
      "A relative IRI such as <owns> is read as the project's base IRI followed by owns.",
    );
  });

  it("Tab is left to the browser, so it leaves the field", async () => {
    await renderEditor();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    editor().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByText(/Tab moves to the next control/)).toBeTruthy();
  });

  it("editing marks it edited and puts the draft in the store for App to ask about", async () => {
    await renderEditor();
    fireEvent.change(editor(), { target: { value: EDITED } });
    expect(screen.getByText("Edited — not applied yet.")).toBeTruthy();
    expect(projectStore.getSnapshot().editorDraft).toBe(EDITED);
    expect(applyButton().getAttribute("aria-disabled")).toBe("false");
    // Typing back to the document's own text is no draft at all.
    fireEvent.change(editor(), { target: { value: TEXT } });
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
  });

  it("Apply sends the text and the document moves on (AC-8)", async () => {
    applyDocumentSource.mockResolvedValue({ revision: 1, label: "Applied Turtle edits", state: state(1) });
    await renderEditor();
    fireEvent.change(editor(), { target: { value: EDITED } });
    await act(async () => {
      fireEvent.click(applyButton());
    });
    expect(applyDocumentSource).toHaveBeenCalledWith("prj-0123456789ab", "model", EDITED);
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
    expect(projectStore.getSnapshot().documents[0].revision).toBe(1);
    expect(editor().value).toBe(EDITED);
    expect(projectStore.getSnapshot().announcement.text).toBe("Applied Turtle edits. Unsaved changes.");
  });

  it("Ctrl+Enter applies", async () => {
    applyDocumentSource.mockResolvedValue({ revision: 1, label: "Applied Turtle edits", state: state(1) });
    await renderEditor();
    fireEvent.change(editor(), { target: { value: EDITED } });
    await act(async () => {
      fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    });
    expect(applyDocumentSource).toHaveBeenCalledTimes(1);
  });

  it("invalid Turtle keeps the text and names the line and column, the detail behind a disclosure", async () => {
    applyDocumentSource.mockRejectedValue(
      new TurtleError("Line 4, column 3: expected '.'", 4, 3, "Bad syntax (expected '.') at ^ in ..."),
    );
    await renderEditor();
    fireEvent.change(editor(), { target: { value: EDITED + ":E :f" } });
    await act(async () => {
      fireEvent.click(applyButton());
    });
    expect(screen.getByRole("alert").textContent).toContain("Line 4, column 3: expected '.'");
    const disclosure = screen.getByText("rdflib's message").closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain("Bad syntax");
    expect(editor().value).toBe(EDITED + ":E :f");
    expect(editor().getAttribute("aria-invalid")).toBe("true");
    expect(projectStore.getSnapshot().editorDraft).toBe(EDITED + ":E :f");
    // The caret is put where rdflib stopped.
    const lineStart = EDITED.split("\n").slice(0, 3).join("\n").length + 1;
    expect(editor().selectionStart).toBe(lineStart + 2);
    expect(document.querySelector(".turtle-gutter-error")!.textContent).toBe("4");
  });

  it("Discard edits returns the text to the document", async () => {
    await renderEditor();
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(editor().value).toBe(TEXT);
    expect(projectStore.getSnapshot().editorDraft).toBeNull();
  });

  it("a new revision regenerates the text, but never over unapplied edits", async () => {
    const view = render(<TurtleEditor projectId="prj-0123456789ab" doc="model" revision={0} />);
    await act(async () => undefined);
    getDocumentSource.mockResolvedValue({ text: "@prefix : <http://x#> .\n\n:A\n    a :B ;\n.\n", revision: 1, fromEditor: false });
    await act(async () => {
      view.rerender(<TurtleEditor projectId="prj-0123456789ab" doc="model" revision={1} />);
    });
    expect(editor().value).toContain(":A\n    a :B ;");

    fireEvent.change(editor(), { target: { value: "mine" } });
    await act(async () => {
      view.rerender(<TurtleEditor projectId="prj-0123456789ab" doc="model" revision={2} />);
    });
    expect(editor().value).toBe("mine");
  });
});


describe("TurtleEditor, found in code review", () => {
  it("switching document drops the old text at once, so nothing is typed against the wrong one", async () => {
    const view = render(<TurtleEditor projectId="prj-0123456789ab" doc="model" revision={0} />);
    await act(async () => undefined);
    expect(editor().value).toBe(TEXT);
    let resolve: (v: { text: string; revision: number; fromEditor: boolean }) => void = () => undefined;
    getDocumentSource.mockImplementation(() => new Promise((r) => (resolve = r)));
    await act(async () => {
      view.rerender(<TurtleEditor projectId="prj-0123456789ab" doc="shapes" revision={0} />);
    });
    const box = screen.getByRole("textbox", { name: "Turtle source of shapes.ttl" }) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    expect(box.readOnly).toBe(true);
    await act(async () => resolve({ text: "@prefix sh: <http://www.w3.org/ns/shacl#> .\n", revision: 0, fromEditor: true }));
    expect(box.value).toContain("sh:");
    expect(box.readOnly).toBe(false);
  });
});
