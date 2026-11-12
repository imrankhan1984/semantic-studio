/*
================================================================================
FILE: frontend/src/components/FolderBrowser.test.tsx
================================================================================

SUMMARY
    The folder browser (projects-anywhere 5.3, Section 6, AC-14, AC-15): a
    listbox the keys drive (arrows, Enter, Backspace, Alt+Up), the folder
    change said in a polite live region, a *Project* row in words, the action
    aria-disabled with the server's reason joined to it, the cap's true
    total, a refusal kept in the dialog, and Escape giving focus back.

BASIC IDEA
    listFolders is mocked over api.ts with a small tree of three folders; each
    answer is what GET /api/folders would give. jsdom has no layout, so what
    is asserted is roles, attributes and the requests made.

INPUTS / INPUT SOURCES
    - A fake listing by path.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FolderBrowser, { resetFolderMemory } from "./FolderBrowser";
import type { FolderListing } from "../types";

const { listFolders } = vi.hoisted(() => ({ listFolders: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFolders,
}));

const PLACES = [
  { name: "Home folder", path: "C:\\Users\\ann" },
  { name: "C:", path: "C:\\" },
  { name: "D:", path: "D:\\" },
];

function listing(path: string, extra: Partial<FolderListing> = {}): FolderListing {
  const parts = path.split("\\").filter(Boolean);
  return {
    path,
    parts: parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join("\\") + (i === 0 ? "\\" : ""),
    })),
    parent: parts.length > 1 ? parts.slice(0, -1).join("\\") + (parts.length === 2 ? "\\" : "") : null,
    places: PLACES,
    folders: [],
    total: 0,
    truncated: false,
    project: false,
    choosable: true,
    reason: null,
    ...extra,
  };
}

const TREE: Record<string, FolderListing> = {
  "C:\\Users\\ann": listing("C:\\Users\\ann", {
    folders: [
      { name: "Archive", path: "C:\\Users\\ann\\Archive", project: false },
      { name: "Motors", path: "C:\\Users\\ann\\Motors", project: true },
      { name: "Pumps", path: "C:\\Users\\ann\\Pumps", project: false },
    ],
    total: 3,
  }),
  "C:\\Users\\ann\\Archive": listing("C:\\Users\\ann\\Archive"),
  "C:\\Users\\ann\\Motors": listing("C:\\Users\\ann\\Motors", {
    project: true,
  }),
  "C:\\Users": listing("C:\\Users", {
    choosable: false,
    reason: "That folder belongs to another person on this computer.",
  }),
};

function answer(path: string | null, mode: "create" | "open"): FolderListing {
  const found = TREE[path ?? "C:\\Users\\ann"];
  if (!found) throw new Error(`no fixture for ${path}`);
  if (mode === "open") {
    return found.project
      ? { ...found, choosable: true, reason: null }
      : {
          ...found,
          choosable: false,
          reason: "This folder holds no project.json. Open the folder of a project.",
        };
  }
  return found;
}

beforeEach(() => {
  resetFolderMemory();
  listFolders.mockReset();
  listFolders.mockImplementation(async (path: string | null, mode: "create" | "open") => answer(path, mode));
});
afterEach(() => cleanup());

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function show(props: Partial<React.ComponentProps<typeof FolderBrowser>> = {}) {
  const onChoose = vi.fn(async (_path: string) => undefined);
  const onCancel = vi.fn();
  render(<FolderBrowser mode="create" onChoose={onChoose} onCancel={onCancel} {...props} />);
  await settle();
  return { onChoose, onCancel };
}

const list = () => screen.getByRole("listbox");
const live = () => document.querySelector(".folder-live")!;
const action = (name: RegExp) => screen.getByRole("button", { name });

describe("FolderBrowser", () => {
  it("is a named dialog that starts at the home folder and says so", async () => {
    await show();
    expect(screen.getByRole("dialog", { name: "Choose a folder" })).toBeTruthy();
    expect(listFolders).toHaveBeenCalledWith(null, "create", "", expect.anything());
    expect(live().textContent).toBe("C:\\Users\\ann, 3 folders");
    expect(screen.getByRole("heading", { name: "Folders (3)" })).toBeTruthy();
  });

  it("marks a project row in words, never colour alone", async () => {
    await show();
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Archive", "Motors Project", "Pumps"]);
  });

  it("moves with the arrow keys and opens a folder with Enter", async () => {
    await show();
    const box = list();
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "End" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Home" });
    fireEvent.keyDown(box, { key: "Enter" });
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users\\ann\\Archive", "create", "", expect.anything());
    expect(live().textContent).toBe("C:\\Users\\ann\\Archive, 0 folders");
    expect(screen.getByText("No folders here.")).toBeTruthy();
    // An empty folder keeps the list, which holds the focus, so Backspace
    // still goes up (found in Chrome: the list went and focus with it).
    expect(list().getAttribute("aria-describedby")).toBe(document.querySelector(".folder-empty")!.id);
    fireEvent.keyDown(list(), { key: "Backspace" });
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users\\ann", "create", "", expect.anything());
  });

  it("goes up one level with Backspace and with Alt+Up", async () => {
    await show();
    fireEvent.keyDown(list(), { key: "Backspace" });
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users", "create", "", expect.anything());
    // The other people's folder: listed, not choosable, its reason said.
    const choose = action(/Choose this folder/);
    expect(choose.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(choose.getAttribute("aria-describedby")!)!.textContent).toBe(
      "That folder belongs to another person on this computer.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Home folder" }));
    await settle();
    fireEvent.keyDown(list(), { key: "ArrowUp", altKey: true });
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users", "create", "", expect.anything());
  });

  it("chooses the folder shown, with the preview sentence, and remembers it", async () => {
    const { onChoose } = await show({
      preview: (path) => `The project will be made in ${path}\\X.`,
    });
    expect(screen.getByText("The project will be made in C:\\Users\\ann\\X.")).toBeTruthy();
    const choose = action(/Choose this folder/);
    expect(choose.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(choose);
    });
    expect(onChoose).toHaveBeenCalledWith("C:\\Users\\ann");
    cleanup();
    await show();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users\\ann", "create", "", expect.anything());
  });

  it("in Open mode opens only a project, and Enter on a project row opens it", async () => {
    const { onChoose } = await show({ mode: "open" });
    expect(screen.getByRole("dialog", { name: "Open a project folder" })).toBeTruthy();
    const open = action(/Open this project/);
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe(
      "This folder holds no project.json. Open the folder of a project.",
    );
    fireEvent.click(open);
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(list(), { key: "Enter" });
    });
    expect(onChoose).toHaveBeenCalledWith("C:\\Users\\ann\\Motors");
  });

  it("keeps a refusal in the dialog: a project.json that fails a field", async () => {
    const onChoose = vi.fn(async () => {
      throw new Error("This project.json has a base IRI the app cannot use.");
    });
    await show({ mode: "open", onChoose });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(list(), { key: "Enter" });
    });
    expect(screen.getByRole("alert").textContent).toBe("This project.json has a base IRI the app cannot use.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says the true total past the cap, and filters on the server", async () => {
    listFolders.mockImplementation(async (_path: string | null, _mode: string, filter: string) =>
      listing("D:\\Big", {
        folders: Array.from({ length: 1000 }, (_, i) => ({
          name: `f${i}`,
          path: `D:\\Big\\f${i}`,
          project: false,
        })),
        total: filter ? 5 : 3412,
        truncated: !filter,
      }),
    );
    await show();
    expect(
      screen.getByText("Showing 1,000 of 3,412 folders. Type the start of a name to narrow the list."),
    ).toBeTruthy();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("Show only folders whose name starts with"), { target: { value: "f10" } });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith(null, "create", "f10", expect.anything());
  });

  it("says a refused folder and keeps the path bar working", async () => {
    listFolders.mockImplementation(async (path: string | null) => {
      if (path === "C:\\") throw new Error("Choose a folder on this drive, not the whole drive.");
      return answer(path, "create");
    });
    await show();
    fireEvent.click(within(screen.getByRole("group", { name: "Places" })).getByRole("button", { name: "C:" }));
    await settle();
    expect(document.querySelector(".folder-error")!.textContent).toBe(
      "Choose a folder on this drive, not the whole drive.",
    );
    // The action's reason is that sentence, joined to it.
    const choose = action(/Choose this folder/);
    expect(document.getElementById(choose.getAttribute("aria-describedby")!)!.className).toContain("folder-error");
    expect(live().textContent).toBe("Choose a folder on this drive, not the whole drive.");
    expect(action(/Choose this folder/).getAttribute("aria-disabled")).toBe("true");
    // The path bar of the folder still shown goes on working.
    fireEvent.click(screen.getByRole("button", { name: "ann" }));
    await settle();
    expect(listFolders).toHaveBeenLastCalledWith("C:\\Users\\ann", "create", "", expect.anything());
    expect(document.querySelector(".folder-error")).toBeNull();
  });

  it("closes on Escape and gives focus back to its opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();
    const { unmount } = render(<FolderBrowser mode="create" onChoose={vi.fn()} onCancel={onCancel} />);
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
