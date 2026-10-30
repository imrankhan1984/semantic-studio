// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/RemoveDialog.test.tsx
================================================================================

SUMMARY
    The removal dialog (wording-and-query-export 5.11, 5.14; AC-12, AC-13,
    AC-16): its sentence is removalPrompt's in all three cases, Download is
    offered only for a known count above zero, the button's three states,
    the live region, the failure sentence, and the keyboard: focus starts on
    Cancel, Tab and Shift+Tab wrap, Escape cancels, and focus goes back to
    what held it when the dialog opened.

BASIC IDEA
    The dialog is rendered alone, with its download a promise the test holds,
    so *Preparing…* can be seen before the file is ready and a failure can be
    made on cue. jsdom has no sequential focus navigation, so Tab is a
    keydown on document, which is where the trap listens, and the assertion
    is where focus went. The opener is a real button focused before the
    dialog mounts, as the card's ⋮ is in the app.

INPUTS / INPUT SOURCES
    - RemoveDialog and removalPrompt, unmocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RemoveDialog from "./RemoveDialog";
import { removalPrompt } from "../removalPrompt";

afterEach(cleanup);

function renderDialog(props: Partial<React.ComponentProps<typeof RemoveDialog>> = {}) {
  const handlers = {
    onDownload: vi.fn(async () => "The Lord of the Rings saved queries.zip"),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
  };
  const result = render(
    <RemoveDialog name="The Lord of the Rings" savedQueries={3} names={["A", "B", "C"]} {...handlers} {...props} />,
  );
  return { ...result, ...handlers };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Remove from your library" });
}

function buttons(): string[] {
  return within(dialog()).getAllByRole("button").map((b) => b.textContent ?? "");
}

function button(name: string | RegExp): HTMLButtonElement {
  return within(dialog()).getByRole("button", { name }) as HTMLButtonElement;
}

describe("RemoveDialog: the words (5.11, AC-12)", () => {
  it("is a modal dialog named by its heading, its sentence removalPrompt's", () => {
    renderDialog();
    const d = dialog();
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-labelledby")).toBe("remove-dialog-title");
    expect(d.textContent).toContain(removalPrompt("The Lord of the Rings", 3, ["A", "B", "C"]));
  });

  it("offers Download the N saved queries for a count above zero, and the saved query for one", () => {
    renderDialog();
    expect(buttons()).toEqual(["Cancel", "Download the 3 saved queries", "Remove"]);
    cleanup();
    renderDialog({ savedQueries: 1, names: ["A"] });
    expect(buttons()).toEqual(["Cancel", "Download the saved query", "Remove"]);
  });

  it("with zero or an unknown count offers Cancel and Remove only, in removalPrompt's words", () => {
    renderDialog({ savedQueries: 0, names: [] });
    expect(buttons()).toEqual(["Cancel", "Remove"]);
    expect(dialog().textContent).toContain(removalPrompt("The Lord of the Rings", 0));
    cleanup();
    renderDialog({ savedQueries: null, names: [] });
    expect(buttons()).toEqual(["Cancel", "Remove"]);
    expect(dialog().textContent).toContain(removalPrompt("The Lord of the Rings", null));
  });

  it("Remove says what it does in words, and answers once", () => {
    const { onRemove, onCancel } = renderDialog();
    fireEvent.click(button("Remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("RemoveDialog: Download (5.11 item 3, AC-13)", () => {
  it("reads Preparing… and is aria-disabled while the file is made, keeping focus, then names the file", async () => {
    let finish!: (name: string) => void;
    const onDownload = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const { onRemove } = renderDialog({ onDownload });
    const region = within(dialog()).getByRole("status");
    // The region is there, empty, before there is anything to say.
    expect(region.textContent).toBe("");

    const download = button("Download the 3 saved queries");
    download.focus();
    await act(async () => {
      fireEvent.click(download);
    });
    expect(download.textContent).toBe("Preparing…");
    expect(download.getAttribute("aria-disabled")).toBe("true");
    expect(download.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(download);
    // A second press while preparing starts nothing.
    fireEvent.click(download);
    expect(onDownload).toHaveBeenCalledTimes(1);

    await act(async () => finish("The Lord of the Rings saved queries.zip"));
    expect(region.textContent).toBe("Downloaded 3 saved queries as The Lord of the Rings saved queries.zip.");
    expect(download.textContent).toBe("Download again");
    expect(download.getAttribute("aria-disabled")).toBe("false");
    // The dialog stays, and nothing was removed.
    expect(dialog()).toBeTruthy();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("a failed download is said in the dialog, and Remove stays", async () => {
    const onDownload = vi.fn(async () => {
      throw new Error("500");
    });
    renderDialog({ onDownload });
    await act(async () => {
      fireEvent.click(button("Download the 3 saved queries"));
    });
    expect(dialog().textContent).toContain(
      "The queries could not be downloaded. They are still saved; nothing was removed.",
    );
    expect(button("Download the 3 saved queries").getAttribute("aria-disabled")).toBe("false");
    expect(button("Remove")).toBeTruthy();
    expect(within(dialog()).getByRole("status").textContent).toBe("");
  });
});

describe("RemoveDialog: the keyboard (5.14, AC-16)", () => {
  /** The dialog opened while `opener` held focus, as the card's ⋮ does. */
  function openFrom() {
    const opener = document.createElement("button");
    opener.textContent = "More actions";
    document.body.appendChild(opener);
    opener.focus();
    const view = renderDialog();
    return { opener, ...view };
  }

  function tab(shift = false) {
    fireEvent.keyDown(document, { key: "Tab", shiftKey: shift });
  }

  it("starts on Cancel, the safe answer", () => {
    const { opener } = openFrom();
    expect(document.activeElement).toBe(button("Cancel"));
    opener.remove();
  });

  it("wraps Tab and Shift+Tab inside the dialog", () => {
    const { opener } = openFrom();
    button("Remove").focus();
    tab();
    expect(document.activeElement).toBe(button("Cancel"));
    tab(true);
    expect(document.activeElement).toBe(button("Remove"));
    // From outside, Tab is pulled back in.
    opener.focus();
    tab();
    expect(dialog().contains(document.activeElement)).toBe(true);
    opener.remove();
  });

  it("Escape is Cancel, and focus goes back to what opened it", () => {
    const { opener, onCancel, unmount } = openFrom();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    // App unmounts the dialog on Cancel.
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("the backdrop is Cancel too, and hidden from assistive technology", () => {
    const { onCancel, container } = renderDialog();
    const backdrop = container.querySelector(".confirm-backdrop")!;
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
