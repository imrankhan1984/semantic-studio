/*
================================================================================
FILE: frontend/src/components/FilesPanel.test.tsx
================================================================================

SUMMARY
    The Files panel (multi-file-projects 5.5, Section 6, AC-3, AC-15, AC-16,
    AC-23): the tree's order and words, one tab stop, the active file
    aria-current, the keyboard (Up, Down, Right, Left, Home, End, Enter, F2,
    Shift+F10 and the context-menu key), and focus after Create, Rename and
    Remove; Remove refused on the last ontology file, aria-disabled with its
    reason; the folder index's notice; a folder's rename from its menu and
    with F2 (5.10 item 1, AC-29); and a file row's two lines (5.10 item 2).

BASIC IDEA
    api.ts is mocked and the real project store is opened on a fixed
    project, so a press goes through the same store action the app runs and
    the panel re-renders from the server's (mocked) answer. jsdom has no
    sequential focus navigation, so tab order is asserted as tabindex, and
    measured in a browser (a11y-check).

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  openProject, addProjectFile, moveProjectFile, removeProjectFile, createProjectFolder, removeProjectFolder,
  renameProjectFolder, listData,
} = vi.hoisted(() => ({
  openProject: vi.fn(),
  addProjectFile: vi.fn(),
  moveProjectFile: vi.fn(),
  removeProjectFile: vi.fn(),
  createProjectFolder: vi.fn(),
  removeProjectFolder: vi.fn(),
  renameProjectFolder: vi.fn(),
  listData: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  addProjectFile,
  moveProjectFile,
  removeProjectFile,
  createProjectFolder,
  removeProjectFolder,
  renameProjectFolder,
  listData,
}));

import { ApiError } from "../api";
import { projectStore } from "../state/projectStore";
import FilesPanel from "./FilesPanel";

const PID = "prj-0123456789ab";
const PROJECT = {
  id: PID, name: "Plant", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
  primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" as const,
};

function state(doc: string, file: string, role: "ontology" | "vocabulary" | "shapes", extra: Record<string, unknown> = {}) {
  return {
    doc, file, role, ontologyId: `${PID}-${doc}`, revision: 0, dirty: false, canUndo: false,
    undoLabel: null, canRedo: false, redoLabel: null, triples: 4, ...extra,
  };
}

const DOCS = [
  state("model", "model.ttl", "ontology"),
  state("shapes", "shapes.ttl", "shapes"),
  state("f00000001", "vocab/equipment.ttl", "vocabulary", { dirty: true, triples: 42 }),
];

let onOpenFile: ReturnType<typeof vi.fn<(doc: string) => void>>;

async function open(documents = DOCS, folders = ["vocab"], extra: Record<string, unknown> = {}) {
  openProject.mockResolvedValue({
    project: PROJECT, documents, recovery: { available: false, draftTime: null }, folders,
    found: [], missing: [], skipped: [], wroteModel: false, ...extra,
  });
  listData.mockResolvedValue({ generation: 0, snapshots: [] });
  await act(async () => {
    await projectStore.open(PID);
  });
  onOpenFile = vi.fn();
  render(<FilesPanel onOpenFile={onOpenFile} onError={() => undefined} />);
}

const rows = () => screen.getAllByRole("treeitem");
const row = (name: RegExp | string) => screen.getByRole("treeitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("the tree (5.5 item 2, Section 6)", () => {
  it("lists folders first, then files, each row's words its name", async () => {
    await open();
    expect(screen.getByRole("tree", { name: "Files" })).toBeTruthy();
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "vocab, folder, 1 file, expanded",
      "equipment.ttl, vocabulary file, unsaved, in vocab",
      "model.ttl, ontology file",
      "shapes.ttl, shapes file",
    ]);
    expect(rows().map((r) => r.getAttribute("aria-level"))).toEqual(["1", "2", "1", "1"]);
    // Role and unsaved state are words on the row, not colour alone.
    expect(within(row(/^equipment/)).getByText("vocabulary")).toBeTruthy();
    expect(within(row(/^equipment/)).getByText(/unsaved/)).toBeTruthy();
  });

  it("marks the active file aria-current and gives the tree one tab stop", async () => {
    await open();
    expect(row(/^model\.ttl/).getAttribute("aria-current")).toBe("true");
    expect(rows().filter((r) => r.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([row(/^model\.ttl/)]);
    // The row's ⋯ is no tab stop and not read (the row menu rule).
    for (const more of document.querySelectorAll(".files-more")) {
      expect(more.getAttribute("aria-hidden")).toBe("true");
      expect((more as HTMLElement).tabIndex).toBe(-1);
    }
  });

  it("says what the folder index found, once, until dismissed", async () => {
    await open(DOCS, ["vocab"], { found: ["vocab/equipment.ttl"], missing: ["core.ttl"] });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Found 1 file that was added outside Semantic Studio.");
    expect(status.textContent).toContain("core.ttl is no longer in the project folder.");
    fireEvent.click(within(status).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Found 1 file/)).toBeNull();
  });
});

describe("the keyboard (Section 6)", () => {
  it("moves with Up, Down, Home and End, and Left and Right through a folder", async () => {
    await open();
    const model = row(/^model\.ttl/);
    model.focus();
    fireEvent.keyDown(model, { key: "ArrowUp" });
    expect(document.activeElement).toBe(row(/^equipment/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(/^vocab, folder/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(row(/^vocab, folder/).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /^equipment/ })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(row(/^vocab, folder/).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(row(/^equipment/));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(row(/^shapes\.ttl/));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(row(/^vocab, folder/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(/^equipment/));
  });

  it("chooses a file with Enter", async () => {
    await open();
    fireEvent.keyDown(row(/^shapes\.ttl/), { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("shapes");
    fireEvent.click(row(/^equipment/));
    expect(onOpenFile).toHaveBeenCalledWith("f00000001");
  });

  it("opens the row's menu with Shift+F10 and the context-menu key, and Escape gives focus back", async () => {
    await open();
    const model = row(/^model\.ttl/);
    fireEvent.keyDown(model, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "More actions for model.ttl" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Rename…", "Move to folder…", "Remove…",
    ]);
    expect(document.activeElement?.textContent).toBe("Rename…");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row(/^model\.ttl/));
    fireEvent.keyDown(row(/^vocab, folder/), { key: "ContextMenu" });
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "New file here…", "Rename…", "Remove…",
    ]);
    // Not empty: Remove is there, aria-disabled with its reason.
    const remove = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Remove…" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-description")).toBe("Only an empty folder can be removed.");
  });
});

describe("New file, Rename, Remove (5.5 items 5 to 7)", () => {
  it("creates a file, focuses its row and opens it", async () => {
    await open();
    addProjectFile.mockResolvedValue({
      entry: { id: "f00000002", file: "vocab/core.ttl", role: "ontology" },
      document: state("f00000002", "vocab/core.ttl", "ontology"),
      folders: ["vocab"],
    });
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const dialog = screen.getByRole("dialog", { name: "New file" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "core" } });
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "vocab" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    });
    expect(addProjectFile).toHaveBeenCalledWith(PID, "ontology", "core.ttl", "vocab");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row("core.ttl, ontology file, in vocab"));
    expect(onOpenFile).toHaveBeenCalledWith("f00000002");
  });

  it("renames with F2, focus back on the renamed row", async () => {
    await open();
    moveProjectFile.mockResolvedValue({
      entry: { id: "f00000001", file: "vocab/kit.ttl", role: "vocabulary" },
      document: state("f00000001", "vocab/kit.ttl", "vocabulary", { dirty: true }),
      folders: ["vocab"],
    });
    fireEvent.keyDown(row(/^equipment/), { key: "F2" });
    const dialog = screen.getByRole("dialog", { name: "Rename equipment.ttl" });
    const field = within(dialog).getByLabelText("New name") as HTMLInputElement;
    expect(field.value).toBe("equipment.ttl");
    fireEvent.change(field, { target: { value: "kit" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(moveProjectFile).toHaveBeenCalledWith(PID, "f00000001", { name: "kit" });
    expect(document.activeElement).toBe(row("kit.ttl, vocabulary file, unsaved, in vocab"));
  });

  it("says a refused name beside its field, and changes nothing", async () => {
    await open();
    fireEvent.keyDown(row(/^equipment/), { key: "F2" });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "CON" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(moveProjectFile).not.toHaveBeenCalled();
    const field = within(dialog).getByLabelText("New name");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "CON.ttl is a name Windows keeps for a device.",
    );
    // The server's own refusal lands in the same place.
    moveProjectFile.mockRejectedValue(
      new ApiError("There is already a file called model.ttl in this folder.", 422, {
        code: "path", field: "name", message: "There is already a file called model.ttl in this folder.",
      }),
    );
    fireEvent.change(field, { target: { value: "Model" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "There is already a file called model.ttl in this folder.",
    );
  });

  it("asks before Remove, then focuses the next row", async () => {
    await open();
    removeProjectFile.mockResolvedValue({ trashed: ".trash/x", folders: ["vocab"] });
    fireEvent.keyDown(row(/^equipment/), { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove equipment.ttl?" });
    expect(dialog.textContent).toContain("its 42 statements leave the project's views. Its unsaved changes go with it.");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    expect(removeProjectFile).toHaveBeenCalledWith(PID, "f00000001");
    expect(screen.queryByRole("treeitem", { name: /^equipment/ })).toBeNull();
    expect(document.activeElement).toBe(row(/^model\.ttl/));
  });

  it("refuses Remove on the last ontology file, aria-disabled with the reason", async () => {
    await open([state("model", "model.ttl", "ontology"), state("shapes", "shapes.ttl", "shapes")], []);
    fireEvent.keyDown(row(/^model\.ttl/), { key: "F10", shiftKey: true });
    const remove = screen.getByRole("menuitem", { name: "Remove…" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-description")).toBe(
      "model.ttl is the project's last ontology or vocabulary file, so it cannot be removed.",
    );
    fireEvent.click(remove);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("makes a folder and focuses its row", async () => {
    await open();
    createProjectFolder.mockResolvedValue({ folders: ["spare", "vocab"] });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "spare" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    });
    expect(createProjectFolder).toHaveBeenCalledWith(PID, "spare");
    expect(document.activeElement).toBe(row("spare, folder, empty, expanded"));
  });

  it("renames a folder from its menu, and focus lands on the renamed row", async () => {
    await open();
    renameProjectFolder.mockResolvedValue({
      folders: ["kit"],
      files: [{ id: "f00000001", file: "kit/equipment.ttl", role: "vocabulary" }],
      documents: [state("f00000001", "kit/equipment.ttl", "vocabulary", { dirty: true })],
      revisionShift: 3,
    });
    fireEvent.keyDown(row(/^vocab, folder/), { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const dialog = screen.getByRole("dialog", { name: "Rename the folder vocab" });
    const field = within(dialog).getByLabelText("New name") as HTMLInputElement;
    expect(field.value).toBe("vocab");
    fireEvent.change(field, { target: { value: "kit" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(renameProjectFolder).toHaveBeenCalledWith(PID, "vocab", "kit");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row("kit, folder, 1 file, expanded"));
    // The file inside kept its unsaved state and moved with the folder.
    expect(row("equipment.ttl, vocabulary file, unsaved, in kit")).toBeTruthy();
  });

  it("renames a folder with F2 too, and says a refused name beside its field", async () => {
    await open();
    fireEvent.keyDown(row(/^vocab, folder/), { key: "F2" });
    const dialog = screen.getByRole("dialog", { name: "Rename the folder vocab" });
    const field = within(dialog).getByLabelText("New name");
    fireEvent.change(field, { target: { value: "NUL" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(renameProjectFolder).not.toHaveBeenCalled();
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "NUL is a name Windows keeps for a device.",
    );
    // The server's own refusal lands in the same place, and nothing moved.
    renameProjectFolder.mockRejectedValue(
      new ApiError("There is already a folder called spare in this folder.", 422, {
        code: "path", field: "name", message: "There is already a folder called spare in this folder.",
      }),
    );
    fireEvent.change(field, { target: { value: "spare" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "There is already a folder called spare in this folder.",
    );
    expect(row(/^vocab, folder/)).toBeTruthy();
  });

  it("shows a long file name in full, its role and unsaved state under it (5.10 item 2)", async () => {
    const long = "equipment-and-instrumentation-register.ttl"; // 42 characters
    await open([state("model", "model.ttl", "ontology"), state("f00000003", `vocab/${long}`, "vocabulary", { dirty: true })]);
    const file = row(new RegExp(`^${long.replace(/[.-]/g, "\$&")}`));
    const name = file.querySelector(".files-name")!;
    expect(name.textContent).toBe(long);
    // Nothing clips or ellipsises the name; the role and unsaved state are
    // on the row's second line.
    expect(getComputedStyle(name).textOverflow).not.toBe("ellipsis");
    const second = file.querySelector(".files-second")!;
    expect(second.textContent).toBe("vocabulary● unsaved");
  });

  it("collapses the whole section with its own button", async () => {
    await open();
    const fold = screen.getByRole("button", { name: "Files" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tree")).toBeNull();
  });
});
