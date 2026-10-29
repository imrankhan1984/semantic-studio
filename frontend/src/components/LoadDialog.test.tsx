// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/LoadDialog.test.tsx
================================================================================

SUMMARY
    The Load dialog's tabs, its first test (CLAUDE.md lists them untested):
    the three ontology tabs always, and the project's Data tab only while a
    project is open (csv-data-import 5.1), opening with the wizard started
    when the tree asked for an import, and not closed by a click outside
    while the wizard runs. Past step 3 the ✕ and a tab switch ask "Leave the
    wizard?" as Cancel does (PR #53 review), driven through the real wizard.
    Focus goes to the Data heading when the wizard closes, and only then
    (csv-data-import X4). There is no Suggested tab, no catalogue and no
    *Add the examples back* here (home-and-settings 5.3, AC-4): they are in
    Settings → Library, and SettingsDialog.test.tsx has their tests; the
    dialog opens on the tab it is asked for. A failed load shows
    the server's sentence with the raw text under a closed Technical
    details (5.1); the dialog is announced as one, Escape closes it or asks
    past the wizard's step 3, and focus goes back to its opener (5.2).
    While a load runs (load-progress 5.2 to 5.4): each step's sentence and
    bar under the control it started from, the expected time only over
    5 MB and *Still reading* past it, under fake timers; Cancel aborts,
    posts the cancel and says each of its two endings, focus going back to
    the starting control; the ✕, Escape and a click outside cancel and
    close, and nothing opens afterwards; the live region speaks the steps,
    never the seconds.

BASIC IDEA
    api.ts is mocked; a load is held by its mock until the test answers it,
    and rejects on its abort signal as the real request does; the snapshot list reads the real project store, left
    empty, so the list says it is reading -- opened on a fixed project where
    the focus test needs the list itself.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchHierarchy,
  inspectData,
  previewData,
  openProject,
  listData,
  restoreExamples,
  uploadOntology,
  fetchOntology,
  cancelLoad,
} = vi.hoisted(() => ({
  fetchHierarchy: vi.fn(() => new Promise(() => {})),
  inspectData: vi.fn(),
  previewData: vi.fn(),
  openProject: vi.fn(),
  listData: vi.fn(),
  restoreExamples: vi.fn(),
  uploadOntology: vi.fn(),
  fetchOntology: vi.fn(),
  cancelLoad: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fetchHierarchy,
  inspectData,
  previewData,
  openProject,
  listData,
  restoreExamples,
  uploadOntology,
  fetchOntology,
  cancelLoad,
}));

import { ApiError, type LoadOptions } from "../api";
import { projectStore } from "../state/projectStore";
import LoadDialog from "./LoadDialog";

const PROJECT = { id: "prj-0123456789ab", name: "Shop", modelOntologyId: "prj-0123456789ab-model", taxonomy: false };

afterEach(() => {
  cleanup();
  projectStore._reset();
  restoreExamples.mockReset();
  uploadOntology.mockReset();
});

describe("a failed load (load-and-shapes 5.1, AC-2)", () => {
  const SENTENCE =
    "Line 3: the statement before this line is not finished. It probably needs a full stop (.) at its end.";
  // Markup in the raw text must arrive as characters, not elements.
  const TECHNICAL = "Could not parse the file as RDF. Attempts:\nturtle: at line 3 of <>:\n<b>Bad syntax</b>";

  async function failWith(error: Error) {
    uploadOntology.mockRejectedValue(error);
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="file" />);
    await act(async () => {
      fireEvent.change(document.querySelector(".dropzone input[type=file]")!, {
        target: { files: [new File(["x"], "missing-dot.ttl")] },
      });
    });
  }

  it("shows the sentence, and the raw text as text under a closed Technical details", async () => {
    await failWith(
      new ApiError(SENTENCE, 422, { code: "parse_error", message: SENTENCE, line: 3, format: "Turtle", technical: TECHNICAL }),
    );
    expect(screen.getByText(SENTENCE).className).toBe("detail-error");
    const details = document.querySelector("details.technical-details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Technical details");
    const pre = details.querySelector("pre")!;
    expect(pre.textContent).toBe(TECHNICAL);
    expect(pre.querySelector("b")).toBeNull();
    // The sentence above it carries none of the raw text.
    expect(screen.getByText(SENTENCE).textContent).not.toContain("Attempts");
  });

  it("has no disclosure without technical text", async () => {
    await failWith(new ApiError("The uploaded file is empty.", 400, "The uploaded file is empty."));
    expect(screen.getByText("The uploaded file is empty.")).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
  });

  it("has no disclosure for a parse_error whose technical text is null", async () => {
    await failWith(
      new ApiError("Refused.", 422, { code: "parse_error", message: "Refused.", line: null, format: null, technical: null }),
    );
    expect(screen.getByText("Refused.")).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
  });
});

describe("a refusal by a limit (home-and-settings 5.5, AC-9)", () => {
  const TOO_LARGE = "This file is larger than the 50 MB limit. You can raise it in Settings → Limits.";
  const TOO_SLOW = "This file took longer than 60 seconds to read and was stopped. You can raise the limit in Settings → Limits.";
  const SET = "This file is larger than the 50 MB limit, which the administrator set.";

  async function refuse(error: Error, onOpenLimits = vi.fn(), onClose = vi.fn()) {
    uploadOntology.mockRejectedValue(error);
    render(<LoadDialog onLoaded={() => {}} onClose={onClose} onOpenLimits={onOpenLimits} initialTab="file" />);
    await act(async () => {
      fireEvent.change(document.querySelector(".dropzone input[type=file]")!, {
        target: { files: [new File(["x"], "big.ttl")] },
      });
    });
    return { onOpenLimits, onClose };
  }

  it("a too-large refusal says where to raise it and offers Settings, which opens Limits", async () => {
    const { onOpenLimits } = await refuse(
      new ApiError(TOO_LARGE, 413, { message: TOO_LARGE, code: "limit", limit: "largestFile", settable: true }),
    );
    expect(screen.getByText(TOO_LARGE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenLimits).toHaveBeenCalledTimes(1);
  });

  it("a too-slow refusal offers it too", async () => {
    await refuse(new ApiError(TOO_SLOW, 504, { message: TOO_SLOW, code: "limit", limit: "readTime", settable: true }));
    expect(screen.getByText(TOO_SLOW)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("a limit the administrator set says so and offers no button", async () => {
    await refuse(new ApiError(SET, 413, { message: SET, code: "limit", limit: "largestFile", settable: false }));
    expect(screen.getByText(SET)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("is told by the detail's code, never by the sentence", async () => {
    await refuse(new ApiError(TOO_LARGE, 413, TOO_LARGE));
    expect(screen.getByText(TOO_LARGE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});

describe("no Suggested tab (home-and-settings 5.3, AC-4)", () => {
  it("has Local file and URL / GitHub, and no Suggested tab, catalogue or examples button", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    const tabs = [...document.querySelectorAll(".tabs .tab")].map((b) => b.textContent);
    expect(tabs).toEqual(["Local file", "URL / GitHub"]);
    expect(screen.queryByRole("button", { name: "Suggested" })).toBeNull();
    expect(document.querySelector(".catalogue-entry")).toBeNull();
    expect(screen.queryByText(/Well-known public ontologies/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add the examples back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add them back" })).toBeNull();
  });

  it("opens on Local file unless another tab is asked for", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    expect(document.querySelector(".tab.active")?.textContent).toBe("Local file");
    expect(screen.getByText("Drop an ontology file here, or click to browse.")).toBeTruthy();
  });

  it("opens on the tab asked for: Local file or URL / GitHub", () => {
    const { unmount } = render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="file" />);
    expect(document.querySelector(".tab.active")?.textContent).toBe("Local file");
    unmount();
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="url" />);
    expect(document.querySelector(".tab.active")?.textContent).toBe("URL / GitHub");
    expect(screen.getByRole("textbox", { name: "Address of an RDF file" })).toBeTruthy();
  });
});

describe("the Load dialog is a dialog (load-and-shapes 5.2, AC-3)", () => {
  it("is announced as a modal dialog, labelled by its heading", () => {
    const { rerender } = render(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} />);
    const dialog = screen.getByRole("dialog", { name: "Load ontology" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(heading.tagName).toBe("H2");
    fireEvent.click(screen.getByRole("button", { name: "Data for this project" }));
    rerender(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} />);
    expect(screen.getByRole("dialog", { name: "Data for Shop" })).toBeTruthy();
  });

  it("closes on Escape, wherever focus is in it or on the page's body", () => {
    const onClose = vi.fn();
    render(<LoadDialog onLoaded={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Local file" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("button", { name: "Local file" }), { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves an Escape pressed in another dialog over it to that dialog", () => {
    const onClose = vi.fn();
    render(
      <>
        <LoadDialog onLoaded={() => {}} onClose={onClose} />
        <div role="dialog" aria-label="Approval">
          <button type="button">Don't allow</button>
        </div>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Don't allow" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes focus on open, and gives it back to what opened it on close", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open a file
          </button>
          {open && <LoadDialog onLoaded={() => {}} onClose={() => setOpen(false)} initialTab="file" />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open a file" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Load ontology" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves an Escape from the page's body to a modal dialog open over it (found in review)", () => {
    const onClose = vi.fn();
    render(
      <>
        <LoadDialog onLoaded={() => {}} onClose={onClose} />
        <div role="dialog" aria-modal="true" aria-label="Approval">
          <button type="button">Don't allow</button>
        </div>
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("gives focus back to the opener when it opened on the URL tab, the field already focused (found in review)", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Load from a URL
          </button>
          {open && <LoadDialog onLoaded={() => {}} onClose={() => setOpen(false)} initialTab="url" />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Load from a URL" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab inside: past the last control to the first, and back (found in review)", () => {
    render(
      <>
        <button type="button">Behind</button>
        <LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="file" />
      </>,
    );
    const dialog = screen.getByRole("dialog");
    // The file input is `hidden` and Tab never stops on it: it is not an end.
    expect(dialog.querySelector('input[type="file"][hidden]')).not.toBeNull();
    // The drop area is a stop of its own since load-progress 5.3.
    const items = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, a[href], [tabindex="0"]')]
      .filter((el) => !el.closest("[hidden]"));
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("keeps the URL field's own focus when it opens on the URL tab", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="url" />);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

describe("LoadDialog", () => {
  it("has the two ontology tabs and no Data tab without a project", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    for (const name of ["Local file", "URL / GitHub"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Data for this project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Local file" }));
    expect(screen.getByText("Drop an ontology file here, or click to browse.")).toBeTruthy();
  });

  it("adds the project's Data tab, titled with the project", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: "Data for this project" }));
    expect(screen.getByRole("heading", { name: "Data for Shop" })).toBeTruthy();
    expect(screen.getByText("Reading the project's data…")).toBeTruthy();
  });

  it("opens on Data with the wizard started, and a click outside does not drop it", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
    });
    expect(screen.getByRole("heading", { name: "Step 1 of 4: the file" })).toBeTruthy();
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Reading the project's data…")).toBeTruthy();
  });

  it("gives focus to the Data heading when the wizard closes, and not again after a tab switch (X4)", async () => {
    openProject.mockResolvedValue({
      project: { id: PROJECT.id, name: "Shop", createdAt: "", updatedAt: "", baseIri: "http://x#", prefix: "x",
        primaryLanguage: "en", languages: [], documents: [], counts: {}, kind: "ontology" },
      documents: [{ doc: "model", ontologyId: `${PROJECT.id}-model`, revision: 1, dirty: false, canUndo: false,
        undoLabel: null, canRedo: false, redoLabel: null, triples: 1 }],
      recovery: { available: false, draftTime: null },
    });
    listData.mockResolvedValue({ generation: 1, snapshots: [] });
    await act(async () => {
      await projectStore.open(PROJECT.id);
    });
    await act(async () => {
      render(<LoadDialog onLoaded={() => {}} onClose={() => {}} project={PROJECT} initialTab="data" startImport />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    const heading = screen.getByRole("heading", { name: "Data" });
    expect(document.activeElement).toBe(heading);
    const local = screen.getByRole("button", { name: "Local file" });
    local.focus();
    fireEvent.click(local);
    const data = screen.getByRole("button", { name: "Data for this project" });
    data.focus();
    await act(async () => {
      fireEvent.click(data);
    });
    expect(document.activeElement).toBe(data);
  });

  it("falls back to Local file when Data is asked for with no project open", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="data" />);
    expect(screen.getByRole("heading", { name: "Load ontology" })).toBeTruthy();
    expect(screen.getByText("Drop an ontology file here, or click to browse.")).toBeTruthy();
  });

  describe("leaving a wizard with a mapping (PR #53 review)", () => {
    const X = "http://example.org/shop#";

    async function toStep3(onClose = vi.fn()) {
      fetchHierarchy.mockResolvedValue({
        classes: { nodes: { [`${X}Person`]: { label: "Person", prefixed: "shop:Person", kind: "class", hasChildren: false } }, children: {}, roots: [] },
        concepts: { nodes: {}, children: {}, roots: [] }, counts: { classes: 1, concepts: 0 }, truncated: false,
      } as never);
      inspectData.mockResolvedValue({
        separator: ",", separatorName: "comma", encoding: "utf-8", header: true,
        columns: [{ name: "id", empty: 0, unique: true, repeats: 0, wholeNumbers: true, numbers: true, dates: false, dateTimes: false }],
        renamed: [], rows: [["1"]], total: 1, kept: 1, limit: 2000, sample: false, limitSentence: null,
        idSuggestion: "id", nameSuggestion: null,
      });
      previewData.mockResolvedValue({
        idCheck: { column: "id", ok: true, missing: { count: 0, rows: [] }, repeats: 0, repeated: { count: 0, rows: [] } },
        fields: [], suggestions: {}, className: "Person",
      });
      await act(async () => {
        render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
      });
      await act(async () => {
        fireEvent.change(document.querySelector(".data-wizard input[type=file]")!, {
          target: { files: [new File(["id,1"], "a.csv")] },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Each row is"), { target: { value: `${X}Person` } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      });
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      return onClose;
    }

    it("asks before the ✕ closes the dialog, and Keep going keeps the wizard", async () => {
      const onClose = await toStep3();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
      const ask = screen.getByRole("group", { name: "Leave the wizard?" });
      fireEvent.click(within(ask).getByRole("button", { name: "Keep going" }));
      expect(screen.queryByRole("group", { name: "Leave the wizard?" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("asks before another tab drops the wizard", async () => {
      await toStep3();
      fireEvent.click(screen.getByRole("button", { name: "Local file" }));
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(screen.getByText("Drop an ontology file here, or click to browse.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Data for this project" }));
      expect(screen.queryByRole("heading", { name: "Step 3 of 4: the columns" })).toBeNull();
    });

    it("past step 3 Escape asks, Escape again keeps going, and Leave closes (load-and-shapes 5.2)", async () => {
      const onClose = await toStep3();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("group", { name: "Leave the wizard?" })).toBeTruthy();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(screen.queryByRole("group", { name: "Leave the wizard?" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not ask before step 3, where there is nothing to lose", async () => {
      const onClose = vi.fn();
      await act(async () => {
        render(<LoadDialog onLoaded={() => {}} onClose={onClose} project={PROJECT} initialTab="data" startImport />);
      });
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a load's steps and Cancel (load-progress 5.2 to 5.4)", () => {
  const MB = 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  type Pending = {
    options: LoadOptions;
    resolve: (summary: unknown) => void;
  };

  /** The mocked load: held until the test answers it, rejected on abort. */
  function hold(mock: typeof uploadOntology | typeof fetchOntology) {
    const pending: Pending[] = [];
    mock.mockImplementation((_what: unknown, options: LoadOptions) =>
      new Promise((resolve, reject) => {
        pending.push({ options, resolve });
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    return pending;
  }

  function bigFile(name: string, size: number): File {
    const file = new File(["x"], name);
    Object.defineProperty(file, "size", { value: size });
    return file;
  }

  const live = () => document.querySelector<HTMLElement>('p.visually-hidden[role="status"]')!;
  const step = () => document.querySelector<HTMLElement>(".load-status .load-step")?.textContent ?? null;
  const bar = () => screen.getByRole("progressbar");

  function openFile(props: Partial<Parameters<typeof LoadDialog>[0]> = {}) {
    const handlers = { onLoaded: vi.fn(), onClose: vi.fn(), onLibraryChanged: vi.fn() };
    render(<LoadDialog {...handlers} initialTab="file" {...props} />);
    return handlers;
  }

  async function chooseFile(file: File) {
    await act(async () => {
      fireEvent.change(document.querySelector(".dropzone input[type=file]")!, { target: { files: [file] } });
    });
  }

  beforeEach(() => {
    cancelLoad.mockResolvedValue({ stopped: true });
  });

  afterEach(() => {
    // Unmounted first: a dialog closed mid-load cancels it, through the mock.
    cleanup();
    vi.useRealTimers();
    fetchOntology.mockReset();
    cancelLoad.mockReset();
  });

  it("sends with real progress, then reads with the seconds and the expected time", async () => {
    vi.useFakeTimers();
    const pending = hold(uploadOntology);
    openFile();
    // The live region is there before any load, empty: one added with its
    // text is unreliably announced.
    expect(live().textContent).toBe("");
    await chooseFile(bigFile("big-file.ttl", 35 * MB));

    const { options } = pending[0];
    expect(options.loadId).toMatch(UUID);
    expect(step()).toBe("Sending big-file.ttl: 0 of 35 MB.");
    act(() => options.onSent!(12 * MB, 35 * MB));
    expect(step()).toBe("Sending big-file.ttl: 12 of 35 MB.");
    expect(bar().getAttribute("aria-valuenow")).toBe("34");
    expect(live().textContent).toBe("Sending big-file.ttl");

    act(() => options.onSent!(35 * MB, 35 * MB));
    expect(step()).toBe(
      "Reading big-file.ttl (35 MB): 0 seconds so far. Files this size often take about 15 seconds.",
    );
    // No value while reading: it is moving, not measured.
    expect(bar().hasAttribute("aria-valuenow")).toBe(false);
    expect(live().textContent).toBe("Reading big-file.ttl");

    act(() => vi.advanceTimersByTime(6000));
    expect(step()).toBe(
      "Reading big-file.ttl (35 MB): 6 seconds so far. Files this size often take about 15 seconds.",
    );
    // The seconds are not announced: the live region did not change.
    expect(live().textContent).toBe("Reading big-file.ttl");

    act(() => vi.advanceTimersByTime(16000));
    expect(step()).toBe("Still reading: 22 seconds so far.");
    expect(live().textContent).toBe("Still reading big-file.ttl");
    expect(live().textContent).not.toMatch(/\d/);
  });

  it("says no expected time for a file of 5 MB or less", async () => {
    hold(uploadOntology);
    openFile();
    await chooseFile(bigFile("small.ttl", 5 * MB));
    const { onSent } = uploadOntology.mock.calls[0][1] as LoadOptions;
    act(() => onSent!(5 * MB, 5 * MB));
    expect(step()).toBe("Reading small.ttl (5 MB): 0 seconds so far.");
  });

  it("a web address downloads and reads, counting the seconds, with its id and signal", async () => {
    vi.useFakeTimers();
    const pending = hold(fetchOntology);
    render(<LoadDialog onLoaded={vi.fn()} onClose={vi.fn()} initialTab="url" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.org/a.ttl" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    });
    expect(fetchOntology.mock.calls[0][0]).toBe("https://example.org/a.ttl");
    expect(pending[0].options.loadId).toMatch(UUID);
    expect(pending[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(step()).toBe("Downloading and reading: 0 seconds so far.");
    act(() => vi.advanceTimersByTime(6000));
    expect(step()).toBe("Downloading and reading: 6 seconds so far.");
    expect(live().textContent).toBe("Downloading and reading");
    // Fetch is aria-disabled, never disabled: it keeps focus.
    const fetchButton = screen.getByRole("button", { name: "Fetch" }) as HTMLButtonElement;
    expect(fetchButton.getAttribute("aria-disabled")).toBe("true");
    expect(fetchButton.disabled).toBe(false);
  });

  it("Cancel aborts, asks the server, says Stopped and gives focus back; nothing opens", async () => {
    const pending = hold(uploadOntology);
    let answer!: (value: { stopped: boolean }) => void;
    cancelLoad.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { onLoaded, onLibraryChanged } = openFile();
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    const { options, resolve } = pending[0];
    act(() => options.onSent!(35 * MB, 35 * MB));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const dropzone = document.querySelector<HTMLElement>(".dropzone")!;
    // Cancel comes after the control the load started from.
    expect(dropzone.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      fireEvent.click(cancel);
    });
    expect(options.signal!.aborted).toBe(true);
    expect(cancelLoad).toHaveBeenCalledWith(options.loadId);
    expect(document.activeElement).toBe(dropzone);
    await act(async () => answer({ stopped: true }));
    expect(step()).toBe("Stopped. Nothing was added to your library.");
    expect(live().textContent).toBe("Stopped. Nothing was added to your library.");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // An answer arriving after the cancel is never applied.
    await act(async () => resolve({ id: "ont-late" }));
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onLibraryChanged).not.toHaveBeenCalled();
    // No error from the aborted request either.
    expect(document.querySelector(".load-error")).toBeNull();
  });

  it("too late to stop: says so, refreshes the library, opens nothing", async () => {
    hold(uploadOntology);
    cancelLoad.mockResolvedValue({ stopped: false });
    const { onLoaded, onLibraryChanged } = openFile();
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    const { onSent } = uploadOntology.mock.calls[0][1] as LoadOptions;
    act(() => onSent!(35 * MB, 35 * MB));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(step()).toBe("It had already finished, so it is in your library.");
    expect(onLibraryChanged).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("a file still being sent never reached the server whole: it is stopped", async () => {
    hold(uploadOntology);
    cancelLoad.mockResolvedValue({ stopped: false });
    const { onLibraryChanged } = openFile();
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(cancelLoad).toHaveBeenCalledTimes(1);
    expect(step()).toBe("Stopped. Nothing was added to your library.");
    expect(onLibraryChanged).not.toHaveBeenCalled();
  });

  for (const [way, leave] of [
    ["the ✕", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
    ["Escape", () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })],
    ["a click outside", () => fireEvent.click(document.querySelector(".modal-backdrop")!)],
  ] as const) {
    it(`${way} cancels a running load and closes; nothing opens afterwards`, async () => {
      const pending = hold(uploadOntology);
      cancelLoad.mockResolvedValue({ stopped: false });
      const handlers = { onLoaded: vi.fn(), onLibraryChanged: vi.fn() };
      // Aborted before the dialog is told to go, not only by its unmount.
      const onClose = vi.fn(() => pending[0].options.signal!.aborted);
      function Host() {
        const [open, setOpen] = useState(true);
        return open ? (
          <LoadDialog
            {...handlers}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            initialTab="file"
          />
        ) : null;
      }
      render(<Host />);
      await chooseFile(bigFile("big-file.ttl", 35 * MB));
      const { options, resolve } = pending[0];
      act(() => options.onSent!(35 * MB, 35 * MB));
      await act(async () => {
        leave();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose.mock.results[0].value).toBe(true);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(options.signal!.aborted).toBe(true);
      expect(cancelLoad).toHaveBeenCalledWith(options.loadId);
      // Too late to stop: the library is read again, and nothing opens.
      expect(handlers.onLibraryChanged).toHaveBeenCalledTimes(1);
      await act(async () => resolve({ id: "ont-late" }));
      expect(handlers.onLoaded).not.toHaveBeenCalled();
    });
  }

  it("a file of no bytes is sending, with a bar at 0, never a reading bar", async () => {
    hold(uploadOntology);
    openFile();
    await chooseFile(bigFile("empty.ttl", 0));
    expect(step()).toBe("Sending empty.ttl: 0 of 0 KB.");
    expect(bar().getAttribute("aria-valuenow")).toBe("0");
    expect(bar().getAttribute("aria-label")).toBe("Sending the file");
  });

  it("draws again only when the words or the bar's percent change, not on every progress event", async () => {
    const pending = hold(uploadOntology);
    let commits = 0;
    render(
      <Profiler id="load" onRender={() => commits++}>
        <LoadDialog onLoaded={vi.fn()} onClose={vi.fn()} initialTab="file" />
      </Profiler>,
    );
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    const { onSent } = pending[0].options;
    act(() => onSent!(12 * MB, 35 * MB));
    const before = commits;
    // A hundred events inside one shown megabyte and one percent, each in
    // its own act, as the browser delivers them: React would batch one act.
    for (let i = 1; i <= 100; i++) act(() => onSent!(12 * MB + i * 100, 35 * MB));
    expect(commits - before).toBe(0);
    expect(step()).toBe("Sending big-file.ttl: 12 of 35 MB.");
    act(() => onSent!(20 * MB, 35 * MB));
    expect(step()).toBe("Sending big-file.ttl: 20 of 35 MB.");
    // The last bytes change neither the words nor the percent; the step
    // still changes to reading.
    act(() => onSent!(35 * MB - 10, 35 * MB));
    expect(step()).toBe("Sending big-file.ttl: 35 of 35 MB.");
    act(() => onSent!(35 * MB, 35 * MB));
    expect(step()).toMatch(/^Reading big-file.ttl/);
  });

  it("an answer the abort did not stop is still never applied", async () => {
    let resolve!: (summary: unknown) => void;
    // A request that ignores its signal: only the dialog's own check stands.
    uploadOntology.mockImplementation(() => new Promise((r) => (resolve = r)));
    const { onLoaded } = openFile();
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await act(async () => resolve({ id: "ont-late" }));
    expect(onLoaded).not.toHaveBeenCalled();
    expect(step()).toBe("Stopped. Nothing was added to your library.");
  });

  it("a dialog taken away mid-load by its parent cancels the load too", async () => {
    const pending = hold(uploadOntology);
    cancelLoad.mockResolvedValue({ stopped: false });
    const handlers = { onLoaded: vi.fn(), onClose: vi.fn(), onLibraryChanged: vi.fn() };
    const { rerender } = render(<LoadDialog {...handlers} initialTab="file" />);
    await chooseFile(bigFile("big-file.ttl", 35 * MB));
    const { options, resolve } = pending[0];
    await act(async () => {
      rerender(<></>);
    });
    expect(options.signal!.aborted).toBe(true);
    expect(cancelLoad).toHaveBeenCalledWith(options.loadId);
    await act(async () => resolve({ id: "ont-late" }));
    expect(handlers.onLoaded).not.toHaveBeenCalled();
  });

  it("closing with no load running posts no cancel", () => {
    const { onClose } = openFile();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelLoad).not.toHaveBeenCalled();
  });

  it("a finished load opens as before, and the next one starts clean", async () => {
    const pending = hold(uploadOntology);
    const { onLoaded } = openFile();
    await chooseFile(bigFile("a.ttl", 1000));
    await act(async () => pending[0].resolve({ id: "ont-a" }));
    expect(onLoaded).toHaveBeenCalledWith({ id: "ont-a" });
    expect(document.querySelector(".load-status")).toBeNull();
    expect(live().textContent).toBe("");
  });

  it("the drop area is a control: Enter opens the picker", () => {
    openFile();
    const dropzone = document.querySelector<HTMLElement>(".dropzone")!;
    expect(dropzone.getAttribute("role")).toBe("button");
    expect(dropzone.tabIndex).toBe(0);
    const input = document.querySelector<HTMLInputElement>(".dropzone input[type=file]")!;
    const picked = vi.spyOn(input, "click");
    fireEvent.keyDown(dropzone, { key: "Enter" });
    expect(picked).toHaveBeenCalledTimes(1);
  });
});
