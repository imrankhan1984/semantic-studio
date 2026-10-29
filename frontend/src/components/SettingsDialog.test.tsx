// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SettingsDialog.test.tsx
================================================================================

SUMMARY
    The tests for Settings (home-and-settings 5.4, 5.5, 5.7): a
    modal dialog that opens on Network or on the tab named; the tablist's
    keys, its one tab stop and its hidden panels; Escape, the ✕ and the
    backdrop closing it, an Escape meant for a dialog over it left alone,
    and Tab kept inside; Network being today's panel; Library listing the
    catalogue and loading an entry as the Load dialog's Suggested tab did,
    its status, Cancel and focus included, a look at Network not cancelling
    it and closing cancelling it; *Add the examples back* only while one is
    missing, and what it says and where focus goes. Stage B: where the work
    is kept and Copy path; Limits' fields, their ranges, Save waiting on a
    refused value, Save, Cancel and Reset to defaults, the read-only
    administrator line, and asking once on closing with a change; a
    catalogue entry refused for its size offering Limits. AC-5 to AC-7, AC-9.

BASIC IDEA
    api.ts is mocked, the component tests' pattern; a load is held by its
    mock until the test answers it, and rejects on its abort signal as the
    real request does. Focus going back to the Settings button is App's, and
    App.test.tsx asserts it.

INPUTS / INPUT SOURCES
    - SettingsDialog, with api.ts's network, fetch, restore and settings
      calls mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getNetworkPolicy, getNetworkActivity, fetchOntology, restoreExamples, cancelLoad, getSettings, saveLimits } =
  vi.hoisted(() => ({
    getNetworkPolicy: vi.fn(),
    getNetworkActivity: vi.fn(),
    fetchOntology: vi.fn(),
    restoreExamples: vi.fn(),
    cancelLoad: vi.fn(),
    getSettings: vi.fn(),
    saveLimits: vi.fn(),
  }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getNetworkPolicy,
  getNetworkActivity,
  fetchOntology,
  restoreExamples,
  cancelLoad,
  getSettings,
  saveLimits,
}));

import { ApiError, type AppSettings, type LimitSetting, type LoadOptions } from "../api";
import { CATALOGUE } from "../catalogue";
import SettingsDialog, { type SettingsTab } from "./SettingsDialog";

const SUMMARY = {
  source: "example",
  format: "turtle",
  triples: 1,
  nodes: 1,
  edges: 0,
  kindCounts: {},
  namespaces: {},
};

const LIMITS: LimitSetting[] = [
  { key: "largestFile", name: "Largest file to load", unit: "MB", value: 50, default: 50, min: 1, max: 200, source: "default", variables: [] },
  { key: "readTime", name: "Longest time to read a file", unit: "s", value: 60, default: 60, min: 10, max: 600, source: "default", variables: [] },
  { key: "firstDrawing", name: "Items drawn when a graph opens", unit: "items", value: 2000, default: 2000, min: 100, max: 20000, source: "default", variables: [] },
];
const SETTINGS: AppSettings = { limits: LIMITS, dataDir: "/home/learner/.local/share/semantic-studio" };

beforeEach(() => {
  getSettings.mockResolvedValue(SETTINGS);
  getNetworkPolicy.mockResolvedValue({ offline: false, grants: [] });
  getNetworkActivity.mockResolvedValue([]);
  cancelLoad.mockResolvedValue({ stopped: true });
});

afterEach(() => {
  // Unmounted first: closing mid-load cancels it, through the mock.
  cleanup();
  vi.clearAllMocks();
  fetchOntology.mockReset();
  restoreExamples.mockReset();
  saveLimits.mockReset();
});

async function open(props: Partial<Parameters<typeof SettingsDialog>[0]> = {}, initialTab?: SettingsTab) {
  const handlers = { onClose: vi.fn(), onLoaded: vi.fn(), onLibraryChanged: vi.fn(), onExamplesRestored: vi.fn() };
  await act(async () => {
    render(<SettingsDialog {...handlers} examplesMissing={0} initialTab={initialTab} {...props} />);
  });
  return handlers;
}

const tab = (name: string) => screen.getByRole("tab", { name });
const panel = (name: string) => document.getElementById(tab(name).getAttribute("aria-controls")!)!;

/** The mocked fetch: held until the test answers it, rejected on abort. */
function hold() {
  const pending: { options: LoadOptions; resolve: (s: unknown) => void }[] = [];
  fetchOntology.mockImplementation((_url: string, options: LoadOptions) =>
    new Promise((resolve, reject) => {
      pending.push({ options, resolve });
      options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  );
  return pending;
}

describe("Settings is a dialog (home-and-settings 5.4, AC-5)", () => {
  it("is a modal dialog named Settings, its heading focused on open", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Settings" }));
  });

  it("has Network, Library and Limits tabs in a tablist, and opens on Network", async () => {
    await open();
    const list = screen.getByRole("tablist", { name: "Settings" });
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Network", "Library", "Limits"]);
    expect(tab("Network").getAttribute("aria-selected")).toBe("true");
    expect(tab("Library").getAttribute("aria-selected")).toBe("false");
    expect(panel("Network").hidden).toBe(false);
    expect(panel("Library").hidden).toBe(true);
    expect(panel("Limits").hidden).toBe(true);
    expect(screen.getByRole("tabpanel", { name: "Network" })).toBeTruthy();
  });

  it("opens on the tab a caller names", async () => {
    await open({}, "library");
    expect(tab("Library").getAttribute("aria-selected")).toBe("true");
    expect(panel("Library").hidden).toBe(false);
    expect(panel("Network").hidden).toBe(true);
  });

  it("Escape, the ✕ and the backdrop close it", async () => {
    const { onClose } = await open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("leaves an Escape to a modal dialog open over it (the network approval)", async () => {
    const { onClose } = await open();
    const over = document.createElement("div");
    over.setAttribute("role", "dialog");
    over.setAttribute("aria-modal", "true");
    document.body.appendChild(over);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    over.remove();
  });

  it("keeps Tab inside: past the last control to the first, and back", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input, [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !el.closest("[hidden]"));
    items[items.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("the Network tab is today's panel, its two requests made on opening", async () => {
    await open();
    expect(screen.getByRole("switch", { name: "Work offline" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Allowed and blocked sites" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent connections" })).toBeTruthy();
    expect(getNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(getNetworkActivity).toHaveBeenCalledTimes(1);
    // Library alone asks nothing more of the network panel.
    fireEvent.click(tab("Library"));
    expect(getNetworkPolicy).toHaveBeenCalledTimes(1);
  });

  it("coming back to Network reads both lists again: what happened meanwhile shows (found in review)", async () => {
    await open();
    expect(screen.getByText("No sites allowed yet.")).toBeTruthy();
    getNetworkPolicy.mockResolvedValue({
      offline: false,
      grants: [{ id: "g1", capability: "ontology:fetch", host: "spec.edmcouncil.org", decision: "allow", remember: true, grantedAt: "2026-10-28T10:00:00+00:00" }],
    });
    fireEvent.click(tab("Library"));
    await act(async () => {
      fireEvent.click(tab("Network"));
    });
    expect(getNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(getNetworkActivity).toHaveBeenCalledTimes(2);
    expect(screen.getByText("spec.edmcouncil.org")).toBeTruthy();
    // Selecting the tab already shown is not a visit.
    fireEvent.click(tab("Network"));
    expect(getNetworkPolicy).toHaveBeenCalledTimes(2);
  });
});

describe("the tablist (home-and-settings 5.7)", () => {
  it("is one tab stop, the selected tab, each tab naming its panel", async () => {
    await open();
    expect(tab("Network").tabIndex).toBe(0);
    expect(tab("Library").tabIndex).toBe(-1);
    expect(tab("Limits").tabIndex).toBe(-1);
    for (const name of ["Network", "Library", "Limits"]) {
      expect(panel(name).getAttribute("role")).toBe("tabpanel");
      expect(panel(name).getAttribute("aria-labelledby")).toBe(tab(name).id);
    }
  });

  it("Right and Left move between tabs and select, wrapping; Home and End go to the ends", async () => {
    await open();
    tab("Network").focus();
    fireEvent.keyDown(tab("Network"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Library"));
    expect(tab("Library").getAttribute("aria-selected")).toBe("true");
    expect(tab("Library").tabIndex).toBe(0);
    expect(panel("Library").hidden).toBe(false);
    fireEvent.keyDown(tab("Library"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Limits"));
    fireEvent.keyDown(tab("Limits"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Network"));
    fireEvent.keyDown(tab("Network"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Limits"));
    fireEvent.keyDown(tab("Limits"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Network"));
    fireEvent.keyDown(tab("Network"), { key: "End" });
    expect(document.activeElement).toBe(tab("Limits"));
    expect(panel("Network").hidden).toBe(true);
  });

  it("a click selects a tab too", async () => {
    await open();
    fireEvent.click(tab("Library"));
    expect(tab("Library").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Library"));
  });
});

describe("Library: a reference ontology (home-and-settings 5.4 item 1, AC-6)", () => {
  it("lists the catalogue in its order, each with its description", async () => {
    await open({}, "library");
    const rows = [...document.querySelectorAll<HTMLElement>(".catalogue-entry")];
    expect(rows).toHaveLength(CATALOGUE.length);
    CATALOGUE.forEach((entry, i) => {
      expect(rows[i].textContent).toContain(entry.name);
      expect(rows[i].textContent).toContain(entry.description);
    });
    expect(screen.getByRole("heading", { name: "Add a reference ontology" })).toBeTruthy();
  });

  it("loads an entry as the Load dialog did: its id and signal, then onLoaded", async () => {
    const pending = hold();
    const { onLoaded } = await open({}, "library");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    expect(fetchOntology).toHaveBeenCalledTimes(1);
    expect(fetchOntology.mock.calls[0][0]).toBe(CATALOGUE[0].url);
    expect(pending[0].options.loadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending[0].options.signal).toBeTruthy();
    const done = { ...SUMMARY, id: "ont-schema", name: "schema.org" };
    await act(async () => pending[0].resolve(done));
    expect(onLoaded).toHaveBeenCalledWith(done);
  });

  it("stands its status under the row, and Cancel says Stopped and gives the row focus", async () => {
    hold();
    await open({}, "library");
    const row = document.querySelectorAll<HTMLElement>(".catalogue-entry")[1];
    await act(async () => {
      fireEvent.click(row);
    });
    expect(row.nextElementSibling?.classList.contains("load-status")).toBe(true);
    expect(row.nextElementSibling?.textContent).toContain("Downloading and reading: 0 seconds so far.");
    // Every row is aria-disabled, so the row pressed keeps focus.
    expect(row.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(cancelLoad).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(row);
    expect(row.nextElementSibling?.textContent).toBe("Stopped. Nothing was added to your library.");
  });

  it("a failed load says the server's sentence", async () => {
    fetchOntology.mockRejectedValue(new Error("The address could not be reached."));
    await open({}, "library");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    expect(screen.getByText("The address could not be reached.")).toBeTruthy();
  });

  it("a look at Network does not cancel a running load", async () => {
    const pending = hold();
    const { onLoaded } = await open({}, "library");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    fireEvent.click(tab("Network"));
    expect(pending[0].options.signal!.aborted).toBe(false);
    expect(cancelLoad).not.toHaveBeenCalled();
    await act(async () => pending[0].resolve({ ...SUMMARY, id: "ont-x", name: "x" }));
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it("closing Settings mid-load cancels it, and nothing opens", async () => {
    const pending = hold();
    const { onLoaded } = await open({}, "library");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    await act(async () => {
      cleanup();
    });
    expect(pending[0].options.signal!.aborted).toBe(true);
    expect(cancelLoad).toHaveBeenCalledWith(pending[0].options.loadId);
    await act(async () => pending[0].resolve({ ...SUMMARY, id: "ont-x", name: "x" }));
    expect(onLoaded).not.toHaveBeenCalled();
  });
});

describe("Library: the examples (home-and-settings 5.4 item 2, AC-6)", () => {
  it("offers Add the examples back only while an example is missing", async () => {
    await open({ examplesMissing: 0 }, "library");
    expect(screen.queryByRole("button", { name: "Add the examples back" })).toBeNull();
    cleanup();
    await open({ examplesMissing: 1 }, "library");
    const button = screen.getByRole("button", { name: "Add the examples back" });
    // Secondary, not primary, as it was.
    expect(button.className).not.toContain("primary");
  });

  it("calls the restore endpoint, hands App the library, says what came back and gives the Library tab focus", async () => {
    const result = {
      restored: ["ont-a", "ont-b"],
      ontologies: [
        { ...SUMMARY, id: "ont-a", name: "Space Exploration" },
        { ...SUMMARY, id: "ont-keep", name: "Mine" },
        { ...SUMMARY, id: "ont-b", name: "FOAF (Friend of a Friend)" },
      ],
    };
    restoreExamples.mockResolvedValue(result);
    const { onExamplesRestored } = await open({ examplesMissing: 2 }, "library");
    const status = document.querySelector<HTMLElement>(".examples-restored")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the examples back" }));
    });
    expect(restoreExamples).toHaveBeenCalledTimes(1);
    expect(onExamplesRestored).toHaveBeenCalledWith(result);
    expect(status.textContent).toBe("Added back: Space Exploration, FOAF (Friend of a Friend).");
    expect(document.activeElement).toBe(tab("Library"));
    // Nothing is downloaded.
    expect(fetchOntology).not.toHaveBeenCalled();
  });

  it("a load started afterwards clears what the restore said (found in review)", async () => {
    restoreExamples.mockResolvedValue({ restored: ["ont-a"], ontologies: [{ ...SUMMARY, id: "ont-a", name: "Space Exploration" }] });
    fetchOntology.mockRejectedValue(new Error("The address could not be reached."));
    await open({ examplesMissing: 1 }, "library");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the examples back" }));
    });
    const status = document.querySelector<HTMLElement>(".examples-restored")!;
    expect(status.textContent).toBe("Added back: Space Exploration.");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    expect(status.textContent).toBe("");
    expect(screen.getByText("The address could not be reached.")).toBeTruthy();
  });

  it("is aria-disabled while it works, never disabled; a failure says why and keeps focus on it", async () => {
    let fail!: (e: Error) => void;
    restoreExamples.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const { onExamplesRestored } = await open({ examplesMissing: 1 }, "library");
    const button = screen.getByRole("button", { name: "Add the examples back" }) as HTMLButtonElement;
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(restoreExamples).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail(new Error("The examples could not be added back."));
    });
    expect(screen.getByText("The examples could not be added back.")).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(onExamplesRestored).not.toHaveBeenCalled();
  });
});

describe("Library: where your work is kept (home-and-settings 5.4 item 3, AC-6)", () => {
  it("shows the data folder's full path as text, with its sentence, read once per opening", async () => {
    await open({}, "library");
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Where your work is kept" })).toBeTruthy();
    expect(screen.getByText("Projects, the library and saved queries are kept here, on this computer.")).toBeTruthy();
    const path = document.querySelector(".settings-path")!;
    expect(path.textContent).toBe(SETTINGS.dataDir);
    // Text, not a field: selectable, never editable.
    expect(path.tagName).toBe("CODE");
  });

  it("Copy path copies it and says Path copied in a polite live region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open({}, "library");
    const said = document.querySelector<HTMLElement>(".settings-copied")!;
    expect(said.getAttribute("role")).toBe("status");
    expect(said.textContent).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });
    expect(writeText).toHaveBeenCalledWith(SETTINGS.dataDir);
    expect(said.textContent).toBe("Path copied");
  });

  it("a refused clipboard says to select the path instead", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await open({}, "library");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });
    expect(document.querySelector(".settings-copied")!.textContent).toBe("Could not copy. Select the path to copy it.");
  });

  it("says so when the folder cannot be read, never Reading… for ever (code review)", async () => {
    getSettings.mockRejectedValue(new Error("The server did not answer."));
    await open({}, "library");
    expect(document.querySelector(".settings-path")!.textContent).toBe("Could not be read. Close Settings and open it again.");
    expect(screen.getByRole("button", { name: "Copy path" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("a catalogue entry refused for its size offers Settings, which opens Limits (5.5)", async () => {
    fetchOntology.mockRejectedValue(
      new ApiError("This file is larger than the 50 MB limit. You can raise it in Settings → Limits.", 413, {
        message: "This file is larger than the 50 MB limit. You can raise it in Settings → Limits.",
        code: "limit",
        limit: "largestFile",
        settable: true,
      }),
    );
    await open({}, "library");
    await act(async () => {
      fireEvent.click(document.querySelectorAll<HTMLElement>(".catalogue-entry")[0]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(tab("Limits").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Limits"));
  });
});

const field = (name: RegExp) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: "Save" });

describe("Limits (home-and-settings 5.4, AC-7)", () => {
  it("shows each limit as a field labelled with its name and unit, its default, range and what it changes", async () => {
    await open({}, "limits");
    const largest = field(/^Largest file to load \(MB\)$/);
    expect(largest.value).toBe("50");
    expect(largest.getAttribute("inputmode")).toBe("numeric");
    expect(field(/^Longest time to read a file \(seconds\)$/).value).toBe("60");
    expect(field(/^Items drawn when a graph opens \(items\)$/).value).toBe("2000");
    // The range and the sentence are tied to the field.
    const described = largest.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual([
      "The largest file you can open from this computer or load from a web address.",
      "Default 50 MB. From 1 to 200 MB.",
    ]);
    expect(screen.getByText("Default 2,000 items. From 100 to 20,000 items.")).toBeTruthy();
    expect(screen.getByText(/The query limits stay fixed/)).toBeTruthy();
  });

  it("refuses a value outside its range under its field, and Save waits, aria-disabled", async () => {
    await open({}, "limits");
    type(/^Largest file/, "201");
    const largest = field(/^Largest file/);
    expect(largest.getAttribute("aria-invalid")).toBe("true");
    const ids = largest.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(ids[2])!.textContent).toBe("Enter a whole number from 1 to 200 MB.");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(saveLimits).not.toHaveBeenCalled();
    for (const text of ["0", "50.5", "", "1e2", " 7", "-3"]) {
      type(/^Largest file/, text);
      expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    }
    type(/^Largest file/, "100");
    expect(largest.getAttribute("aria-invalid")).toBeNull();
    expect(saveButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("Save waits while nothing has changed", async () => {
    await open({}, "limits");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("Save sends only what changed, takes the answer and says when it applies", async () => {
    const answer = { ...SETTINGS, limits: LIMITS.map((l) => (l.key === "largestFile" ? { ...l, value: 100, source: "settings" as const } : l)) };
    saveLimits.mockResolvedValue(answer);
    await open({}, "limits");
    type(/^Largest file/, "100");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveLimits).toHaveBeenCalledWith({ largestFile: 100 });
    expect(field(/^Largest file/).value).toBe("100");
    const status = document.querySelector<HTMLElement>(".settings-limit-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Saved. The new limits apply to the next file you load and the next graph you open.");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("a Save the server refuses says why and keeps the typed value", async () => {
    saveLimits.mockRejectedValue(new ApiError("Largest file to load must be a whole number from 1 to 200 MB.", 422));
    await open({}, "limits");
    type(/^Largest file/, "150");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByText("Largest file to load must be a whole number from 1 to 200 MB.")).toBeTruthy();
    expect(field(/^Largest file/).value).toBe("150");
  });

  it("Cancel puts the saved values back", async () => {
    await open({}, "limits");
    type(/^Largest file/, "120");
    type(/^Longest time/, "5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(field(/^Largest file/).value).toBe("50");
    expect(field(/^Longest time/).value).toBe("60");
    expect(saveLimits).not.toHaveBeenCalled();
  });

  it("Reset to defaults puts the defaults in the fields, to be saved", async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS,
      limits: LIMITS.map((l) => ({ ...l, value: l.key === "readTime" ? 300 : l.key === "largestFile" ? 120 : l.value, source: "settings" as const })),
    });
    saveLimits.mockResolvedValue(SETTINGS);
    await open({}, "limits");
    expect(field(/^Longest time/).value).toBe("300");
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(field(/^Largest file/).value).toBe("50");
    expect(field(/^Longest time/).value).toBe("60");
    expect(saveLimits).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveLimits).toHaveBeenCalledWith({ largestFile: 50, readTime: 60 });
  });

  it("a limit an environment variable owns is read-only, names the variable, and is never sent", async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS,
      limits: LIMITS.map((l) =>
        l.key === "largestFile"
          ? { ...l, value: 300, source: "environment" as const, variables: ["SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", "SEMANTIC_STUDIO_MAX_FETCH_BYTES"] }
          : l,
      ),
    });
    saveLimits.mockResolvedValue(SETTINGS);
    await open({}, "limits");
    expect(screen.queryByRole("textbox", { name: /^Largest file/ })).toBeNull();
    const group = screen.getByRole("group", { name: "Largest file to load" });
    expect(group.textContent).toContain("300 MB");
    expect(group.textContent).toContain(
      "Set by the administrator (SEMANTIC_STUDIO_MAX_UPLOAD_BYTES, SEMANTIC_STUDIO_MAX_FETCH_BYTES).",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(screen.queryByRole("textbox", { name: /^Largest file/ })).toBeNull();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    // Reset changed nothing editable, so there is nothing to send.
    expect(saveLimits).not.toHaveBeenCalled();
    type(/^Longest time/, "90");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveLimits).toHaveBeenCalledWith({ readTime: 90 });
  });

  it("with every limit read-only there are no buttons to press", async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS,
      limits: LIMITS.map((l) => ({ ...l, source: "environment" as const, variables: ["SEMANTIC_STUDIO_X"] })),
    });
    await open({}, "limits");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("says so when the settings cannot be read", async () => {
    getSettings.mockRejectedValue(new Error("The server did not answer."));
    await open({}, "limits");
    expect(screen.getByText("Could not read the settings: The server did not answer.")).toBeTruthy();
  });

  it("a value typed survives a look at another tab", async () => {
    await open({}, "limits");
    type(/^Largest file/, "75");
    fireEvent.click(tab("Network"));
    fireEvent.click(tab("Limits"));
    expect(field(/^Largest file/).value).toBe("75");
  });
});

describe("closing with an unsaved limit asks once (home-and-settings 5.4)", () => {
  it("closes at once with nothing changed", async () => {
    const { onClose } = await open({}, "limits");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the ✕, Escape and the backdrop each ask; Close discards and closes", async () => {
    const { onClose } = await open({}, "limits");
    type(/^Largest file/, "75");
    for (const leave of [
      () => fireEvent.click(screen.getByRole("button", { name: "Close Settings" })),
      () => fireEvent.keyDown(document.body, { key: "Escape" }),
      () => fireEvent.click(document.querySelector(".modal-backdrop")!),
    ]) {
      leave();
      const question = screen.getByRole("group", { name: "Close without saving?" });
      expect(question.textContent).toContain("Close without saving? The limits you changed are not kept.");
      // Focus on the answer that keeps the work.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.queryByRole("group", { name: "Close without saving?" })).toBeNull();
    }
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveLimits).not.toHaveBeenCalled();
  });

  it("Escape while it asks keeps editing, on Limits, the value still there", async () => {
    const { onClose } = await open({}, "limits");
    type(/^Largest file/, "75");
    fireEvent.click(tab("Library"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("group", { name: "Close without saving?" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Close without saving?" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(tab("Limits").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Limits"));
    expect(field(/^Largest file/).value).toBe("75");
  });

  it("the question goes once the change is saved or put back while it stands (code review)", async () => {
    await open({}, "limits");
    type(/^Largest file/, "75");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("group", { name: "Close without saving?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Close without saving?" })).toBeNull();
  });

  it("asks nothing once the change is saved, or put back", async () => {
    saveLimits.mockResolvedValue({ ...SETTINGS, limits: LIMITS.map((l) => (l.key === "readTime" ? { ...l, value: 90 } : l)) });
    const { onClose } = await open({}, "limits");
    type(/^Longest time/, "90");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    type(/^Largest file/, "75");
    type(/^Largest file/, "50");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
