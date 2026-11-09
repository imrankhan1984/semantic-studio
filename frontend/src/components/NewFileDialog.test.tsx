/*
================================================================================
FILE: frontend/src/components/NewFileDialog.test.tsx
================================================================================

SUMMARY
    New file (multi-file-projects 5.5 item 5, Section 6, AC-3, AC-6): a modal
    whose heading takes focus, the role a radio group of three with a
    sentence each, the project's kind preselected, a refusal's sentence
    beside the field it concerns -- found here or by the server -- Escape
    cancels, and focus goes back to the control that opened it.

BASIC IDEA
    The dialog alone, its onCreate a mock: what it sends, and what it shows
    when that rejects with the server's refusal.

INPUTS / INPUT SOURCES
    - None beyond the component.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import NewFileDialog from "./NewFileDialog";

afterEach(cleanup);

function Opener({ onCreate, kind = "ontology" as "ontology" | "taxonomy" }: {
  onCreate: (role: string, name: string, folder: string) => Promise<void>;
  kind?: "ontology" | "taxonomy";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>New file</button>
      {open && (
        <NewFileDialog
          kind={kind}
          folders={["vocab", "a/b"]}
          onCancel={() => setOpen(false)}
          onCreate={async (role, name, folder) => {
            await onCreate(role, name, folder);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const describedBy = (field: HTMLElement) =>
  document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent;

describe("New file (5.5 item 5)", () => {
  it("is a modal named New file, its heading focused", () => {
    render(<Opener onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const dialog = screen.getByRole("dialog", { name: "New file" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "New file" }));
  });

  it("offers the three roles as a radio group, each with its sentence, the kind preselected", () => {
    render(<Opener onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const group = screen.getByRole("group", { name: "What the file holds" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["ontology", "vocabulary", "shapes"]);
    expect(radios.map((r) => describedBy(r))).toEqual([
      "Classes and the relationships between them.",
      "Concepts arranged in a hierarchy, for tagging and lookup.",
      "Rules that check data against your model.",
    ]);
    expect(radios.find((r) => r.checked)?.value).toBe("ontology");
    // One name: arrow keys move between them.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    cleanup();
    render(<Opener onCreate={vi.fn()} kind="taxonomy" />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).find((r) => r.checked)?.value).toBe("vocabulary");
  });

  it("offers the project folder first, then each folder", () => {
    render(<Opener onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const select = screen.getByLabelText("Folder") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["The project folder", "a/b", "vocab"]);
  });

  it("sends the name with .ttl, the folder and the role", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<Opener onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "rules" } });
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "vocab" } });
    fireEvent.click(screen.getByRole("radio", { name: /Shapes/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(onCreate).toHaveBeenCalledWith("shapes", "rules.ttl", "vocab");
  });

  it("says a name outside the rule beside the name, and sends nothing", async () => {
    const onCreate = vi.fn();
    render(<Opener onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "../escape" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(name)).toMatch(/^A name starts with a letter or a digit/);
  });

  it("puts the server's refusal beside the field it names, or under the form", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(
      new ApiError("There is no folder gone in this project.", 422, {
        code: "path", field: "folder", message: "There is no folder gone in this project.",
      }),
    ).mockRejectedValueOnce(
      new ApiError("This project has 100 files, the most it can hold.", 422, {
        code: "path", field: null, message: "This project has 100 files, the most it can hold.",
      }),
    );
    render(<Opener onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "core" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    const folder = screen.getByLabelText("Folder");
    expect(folder.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(folder)).toBe("There is no folder gone in this project.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("This project has 100 files, the most it can hold.");
  });

  it("cancels on Escape, focus back on the control that opened it", () => {
    render(<Opener onCreate={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "New file" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
