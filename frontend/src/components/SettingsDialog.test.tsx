// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SettingsDialog.test.tsx
================================================================================

SUMMARY
    The first tests for Settings (home-and-settings 5.4, 5.7, Stage A): a
    modal dialog that opens on Network or on the tab named; the tablist's
    keys, its one tab stop and its hidden panels; Escape, the ✕ and the
    backdrop closing it, an Escape meant for a dialog over it left alone,
    and Tab kept inside; Network being today's panel; Library listing the
    catalogue and loading an entry as the Load dialog's Suggested tab did,
    its status, Cancel and focus included, a look at Network not cancelling
    it and closing cancelling it; *Add the examples back* only while one is
    missing, and what it says and where focus goes. AC-5 and AC-6 (Stage A).

BASIC IDEA
    api.ts is mocked, the component tests' pattern; a load is held by its
    mock until the test answers it, and rejects on its abort signal as the
    real request does. Focus going back to the Settings button is App's, and
    App.test.tsx asserts it.

INPUTS / INPUT SOURCES
    - SettingsDialog, with api.ts's network, fetch and restore calls mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getNetworkPolicy, getNetworkActivity, fetchOntology, restoreExamples, cancelLoad } = vi.hoisted(() => ({
  getNetworkPolicy: vi.fn(),
  getNetworkActivity: vi.fn(),
  fetchOntology: vi.fn(),
  restoreExamples: vi.fn(),
  cancelLoad: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getNetworkPolicy,
  getNetworkActivity,
  fetchOntology,
  restoreExamples,
  cancelLoad,
}));

import type { LoadOptions } from "../api";
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

beforeEach(() => {
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

  it("has Network and Library tabs in a tablist, and opens on Network", async () => {
    await open();
    const list = screen.getByRole("tablist", { name: "Settings" });
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Network", "Library"]);
    expect(tab("Network").getAttribute("aria-selected")).toBe("true");
    expect(tab("Library").getAttribute("aria-selected")).toBe("false");
    expect(panel("Network").hidden).toBe(false);
    expect(panel("Library").hidden).toBe(true);
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

  it("the Network tab is today's panel, its two requests made once", async () => {
    await open();
    expect(screen.getByRole("switch", { name: "Work offline" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Allowed and blocked sites" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent connections" })).toBeTruthy();
    fireEvent.click(tab("Library"));
    fireEvent.click(tab("Network"));
    expect(getNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(getNetworkActivity).toHaveBeenCalledTimes(1);
  });
});

describe("the tablist (home-and-settings 5.7)", () => {
  it("is one tab stop, the selected tab, each tab naming its panel", async () => {
    await open();
    expect(tab("Network").tabIndex).toBe(0);
    expect(tab("Library").tabIndex).toBe(-1);
    for (const name of ["Network", "Library"]) {
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
    expect(document.activeElement).toBe(tab("Network"));
    fireEvent.keyDown(tab("Network"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Library"));
    fireEvent.keyDown(tab("Library"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Network"));
    fireEvent.keyDown(tab("Network"), { key: "End" });
    expect(document.activeElement).toBe(tab("Library"));
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
