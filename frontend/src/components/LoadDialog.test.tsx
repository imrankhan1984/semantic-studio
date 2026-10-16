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
    (csv-data-import X4). Suggested lists schema.org, FIBO and UNESCO, and
    offers *Add the examples back* only while an example is missing, which
    calls the restore endpoint and keeps focus on the tab
    (home-and-examples 5.8, AC-10).

BASIC IDEA
    api.ts is mocked; the snapshot list reads the real project store, left
    empty, so the list says it is reading -- opened on a fixed project where
    the focus test needs the list itself.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchHierarchy, inspectData, previewData, openProject, listData, restoreExamples, uploadOntology } = vi.hoisted(() => ({
  fetchHierarchy: vi.fn(() => new Promise(() => {})),
  inspectData: vi.fn(),
  previewData: vi.fn(),
  openProject: vi.fn(),
  listData: vi.fn(),
  restoreExamples: vi.fn(),
  uploadOntology: vi.fn(),
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
}));

import { ApiError } from "../api";
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

describe("LoadDialog suggestions (home-and-examples 5.8)", () => {
  const SUMMARY = {
    source: "example",
    format: "turtle",
    triples: 1,
    nodes: 1,
    edges: 0,
    kindCounts: {},
    namespaces: {},
  };

  it("suggests schema.org, FIBO and UNESCO, in that order, and not FOAF", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    const names = [...document.querySelectorAll(".catalogue-entry")].map((b) => b.textContent ?? "");
    expect(names).toHaveLength(3);
    expect(names[0]).toContain("schema.org");
    expect(names[1]).toContain("FIBO");
    expect(names[2]).toContain("UNESCO");
    expect(names.join(" ")).not.toMatch(/FOAF/);
  });

  it("offers Add the examples back only while an example is missing", () => {
    const { rerender } = render(
      <LoadDialog onLoaded={() => {}} onClose={() => {}} examplesMissing={0} onExamplesRestored={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Add the examples back" })).toBeNull();
    rerender(<LoadDialog onLoaded={() => {}} onClose={() => {}} examplesMissing={1} onExamplesRestored={() => {}} />);
    const button = screen.getByRole("button", { name: "Add the examples back" });
    // Above the list.
    const first = document.querySelector(".catalogue-entry")!;
    expect(button.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Secondary, not primary.
    expect(button.className).not.toContain("primary");
  });

  it("calls the restore endpoint, hands App the library, says what came back and keeps focus on the tab", async () => {
    const result = {
      restored: ["ont-a", "ont-b"],
      ontologies: [
        { ...SUMMARY, id: "ont-a", name: "Space Exploration" },
        { ...SUMMARY, id: "ont-keep", name: "Mine" },
        { ...SUMMARY, id: "ont-b", name: "FOAF (Friend of a Friend)" },
      ],
    };
    restoreExamples.mockResolvedValue(result);
    const onExamplesRestored = vi.fn();
    const { rerender } = render(
      <LoadDialog onLoaded={() => {}} onClose={() => {}} examplesMissing={2} onExamplesRestored={onExamplesRestored} />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the examples back" }));
    });
    expect(restoreExamples).toHaveBeenCalledTimes(1);
    expect(onExamplesRestored).toHaveBeenCalledWith(result);
    expect(status.textContent).toBe("Added back: Space Exploration, FOAF (Friend of a Friend).");
    // App's list now has every example, so the button goes; focus is on the
    // tab, never the page.
    rerender(
      <LoadDialog onLoaded={() => {}} onClose={() => {}} examplesMissing={0} onExamplesRestored={onExamplesRestored} />,
    );
    expect(screen.queryByRole("button", { name: "Add the examples back" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Suggested" }));
  });

  it("a failed restore says why and keeps the button", async () => {
    restoreExamples.mockRejectedValue(new Error("The examples could not be added back."));
    const onExamplesRestored = vi.fn();
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} examplesMissing={1} onExamplesRestored={onExamplesRestored} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the examples back" }));
    });
    expect(screen.getByText("The examples could not be added back.")).toBeTruthy();
    expect(onExamplesRestored).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Add the examples back" }) as HTMLButtonElement).disabled).toBe(false);
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

  it("keeps the URL field's own focus when it opens on the URL tab", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="url" />);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

describe("LoadDialog", () => {
  it("has the three ontology tabs and no Data tab without a project", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} />);
    for (const name of ["Suggested", "Local file", "URL / GitHub"]) {
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
    const suggested = screen.getByRole("button", { name: "Suggested" });
    suggested.focus();
    fireEvent.click(suggested);
    const data = screen.getByRole("button", { name: "Data for this project" });
    data.focus();
    await act(async () => {
      fireEvent.click(data);
    });
    expect(document.activeElement).toBe(data);
  });

  it("falls back to Suggested when Data is asked for with no project open", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="data" />);
    expect(screen.getByRole("heading", { name: "Load ontology" })).toBeTruthy();
    expect(screen.getByText(/Well-known public ontologies/)).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "Suggested" }));
      expect(screen.getByRole("heading", { name: "Step 3 of 4: the columns" })).toBeTruthy();
      fireEvent.click(within(screen.getByRole("group", { name: "Leave the wizard?" })).getByRole("button", { name: "Leave" }));
      expect(screen.getByText(/Well-known public ontologies/)).toBeTruthy();
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
