// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NamingSettings.test.tsx
================================================================================

SUMMARY
    Settings → Naming (design-checks 5.1, AC-1, AC-11): the field after the
    fixed https://w3id.org/, the sentence, the pattern and the examples with
    the namespace typed, a refused value said under the field by
    aria-describedby with Save waiting (aria-disabled, never disabled),
    Save sending the value, Clear asking once, Cancel closing without
    asking, and the field disabled and the group busy while a save is on
    its way.

BASIC IDEA
    api.ts is mocked, the component tests' pattern; the panel is rendered
    alone with the props SettingsDialog hands it. SettingsDialog.test.tsx
    covers the tab itself.

INPUTS / INPUT SOURCES
    - NamingSettings, with saveNamespace mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { saveNamespace } = vi.hoisted(() => ({ saveNamespace: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  saveNamespace,
}));

import { ApiError, type AppSettings } from "../api";
import { CLEAR_QUESTION, GUIDELINES } from "../naming/words";
import NamingSettings from "./NamingSettings";

function settingsWith(namespace: string | null): AppSettings {
  return { limits: [], dataDir: "/data", naming: { namespace, prefix: "https://w3id.org/" } };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(namespace: string | null = null) {
  const props = { onSaved: vi.fn(), onDirtyChange: vi.fn(), onCancel: vi.fn() };
  render(<NamingSettings settings={settingsWith(namespace)} failed={null} {...props} />);
  return props;
}

const field = () => screen.getByLabelText("Your organization's namespace") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save" });

describe("Settings → Naming (5.1)", () => {
  it("shows the field after the fixed prefix, the sentence and the example line while empty", () => {
    show();
    expect(field().value).toBe("");
    expect(screen.getByText("https://w3id.org/")).toBeTruthy();
    expect(document.body.textContent).toContain(GUIDELINES);
    expect(document.body.textContent).toContain("http://example.org/");
    // The guidelines sentence is the field's description.
    expect(field().getAttribute("aria-describedby")).toBe("naming-guidelines");
  });

  it("puts the typed namespace in the pattern and the examples", () => {
    show();
    fireEvent.change(field(), { target: { value: "widgets/lab" } });
    const text = document.body.textContent ?? "";
    expect(text).toContain("https://w3id.org/widgets/lab/{layer}/{subject}-{type}");
    expect(text).toContain("https://w3id.org/widgets/lab/data/{data-domain}/{class}/{id}");
    const details = document.querySelector("details.naming-examples")!;
    expect(details.querySelector("summary")!.textContent).toBe("Show examples");
    expect(details.textContent).toContain("https://w3id.org/widgets/lab/domain/finance/invoice-ontology#Invoice");
    expect(details.textContent).toContain("https://w3id.org/widgets/lab/data/finance/invoice/inv-10442");
    expect(details.textContent).not.toContain("w3id.org/acme/");
    expect(details.querySelectorAll("table")).toHaveLength(2);
  });

  it.each([
    ["Acme", "Use lowercase letters, digits and hyphens"],
    ["acme//x", "Use lowercase letters, digits and hyphens"],
    ["acme/v2", "A namespace never holds a version or a date"],
    ["acme/2026", "A namespace never holds a version or a date"],
  ])("refuses %s under the field, by aria-describedby, and Save waits", (value, sentence) => {
    show();
    fireEvent.change(field(), { target: { value } });
    expect(field().getAttribute("aria-invalid")).toBe("true");
    const ids = field().getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("naming-error");
    expect(document.getElementById("naming-error")!.textContent).toContain(sentence);
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save());
    expect(saveNamespace).not.toHaveBeenCalled();
  });

  it("Save waits while nothing changed, then sends the value and says so", async () => {
    saveNamespace.mockResolvedValue(settingsWith("acme"));
    const props = show();
    expect(save().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(field(), { target: { value: "acme" } });
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(save().getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(save());
    });
    expect(saveNamespace).toHaveBeenCalledWith("acme");
    expect(props.onSaved).toHaveBeenCalledWith(settingsWith("acme"));
    expect(screen.getByRole("status").textContent).toContain("Saved.");
  });

  it("disables the field and marks the group busy while saving, focus kept on Save", async () => {
    let answer!: (s: AppSettings) => void;
    saveNamespace.mockReturnValue(new Promise<AppSettings>((r) => (answer = r)));
    show();
    fireEvent.change(field(), { target: { value: "acme" } });
    const button = save();
    button.focus();
    fireEvent.click(button);
    expect(field().disabled).toBe(true);
    expect(document.querySelector(".settings-naming")!.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Saving…");
    await act(async () => answer(settingsWith("acme")));
    expect(field().disabled).toBe(false);
  });

  it("says a refusal from the server under the buttons", async () => {
    saveNamespace.mockRejectedValue(new ApiError("Use lowercase letters.", 422));
    show();
    fireEvent.change(field(), { target: { value: "acme" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(document.body.textContent).toContain("Use lowercase letters.");
  });

  it("Clear asks once, then empties it; Keep it keeps it", async () => {
    saveNamespace.mockResolvedValue(settingsWith(null));
    show("acme");
    expect(screen.queryByText(CLEAR_QUESTION)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const question = screen.getByRole("group", { name: "Clear the namespace?" });
    expect(question.textContent).toContain(CLEAR_QUESTION);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(saveNamespace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(saveNamespace).toHaveBeenCalledWith(null);
  });

  it("offers no Clear while nothing is saved", () => {
    show();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("Cancel closes without asking and saves nothing", () => {
    const props = show();
    fireEvent.change(field(), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalled();
    expect(saveNamespace).not.toHaveBeenCalled();
  });

  it("names every control", () => {
    show("acme");
    for (const name of ["Clear", "Cancel", "Save"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Your organization's namespace" })).toBeTruthy();
  });
});
