// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ImportsPanel.test.tsx
================================================================================

SUMMARY
    Tests for the imports panel (external-access Stage 2): the listing and its
    states (AC-16, AC-19), the Resolve control, the failure actions and the
    folder picker (AC-40), a mismatched file asked about once (AC-42), the
    Include imports switch (AC-20), and statuses stated in text (AC-35).

BASIC IDEA
    api.ts is mocked, following the component tests' pattern, so every request
    the panel makes is a counted call with a fixed answer. The browser's file
    picker cannot be driven from jsdom; its `change` event can, with a FileList
    built from real File objects, which is what the component reads.

INPUTS / INPUT SOURCES
    - ImportsPanel, with api.ts's imports calls mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportRow, ImportsListing } from "../types";
import ImportsPanel, { statusText, summaryText } from "./ImportsPanel";

const { listImports, resolveImports, refreshImports, cancelImports, mapImport, chooseImportFiles } =
  vi.hoisted(() => ({
    listImports: vi.fn(),
    resolveImports: vi.fn(),
    refreshImports: vi.fn(),
    cancelImports: vi.fn(),
    mapImport: vi.fn(),
    chooseImportFiles: vi.fn(),
  }));

vi.mock("../api", () => ({
  listImports,
  resolveImports,
  refreshImports,
  cancelImports,
  mapImport,
  chooseImportFiles,
}));

function row(iri: string, patch: Partial<ImportRow> = {}): ImportRow {
  return {
    iri,
    status: "unresolved",
    source: null,
    sourceName: null,
    fetchedAt: null,
    error: null,
    documentCount: 0,
    depth: 1,
    importedBy: null,
    ...patch,
  };
}

function listing(rows: ImportRow[], patch: Partial<ImportsListing> = {}): ImportsListing {
  return { imports: rows, limit: null, resolving: null, offline: false, ...patch };
}

const FOAF = "http://xmlns.com/foaf/0.1/";
const REMOTE = "https://spec.example.org/core";

const UNRESOLVED = listing([row(FOAF), row(REMOTE), row("http://www.w3.org/2002/07/owl", { status: "builtin", source: "builtin", sourceName: "OWL" })]);

const PARTLY_FAILED = listing([
  row(FOAF, { status: "resolved", source: "bundled", sourceName: "FOAF", documentCount: 1 }),
  row(REMOTE, { status: "failed", error: "The site answered HTTP 404 for this import." }),
]);

async function renderPanel(props: Partial<Parameters<typeof ImportsPanel>[0]> = {}) {
  const onIncludeImportsChange = vi.fn();
  const onChanged = vi.fn();
  await act(async () => {
    render(
      <ImportsPanel
        ontologyId="ont-1"
        library={[{ id: "ont-2", name: "local-core.ttl" }]}
        includeImports={false}
        onIncludeImportsChange={onIncludeImportsChange}
        onChanged={onChanged}
        {...props}
      />,
    );
  });
  return { onIncludeImportsChange, onChanged };
}

function expand() {
  fireEvent.click(screen.getByRole("button", { name: /Imports/ }));
}

beforeEach(() => {
  for (const fn of [listImports, resolveImports, refreshImports, cancelImports, mapImport, chooseImportFiles]) {
    fn.mockReset();
  }
  listImports.mockResolvedValue(UNRESOLVED);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImportsPanel listing", () => {
  it("renders nothing for an ontology with no imports", async () => {
    listImports.mockResolvedValue(listing([]));
    await renderPanel();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText(/Imports/)).toBeNull();
  });

  it("lists each import with its status in words and asks for nothing else (AC-16)", async () => {
    await renderPanel();
    expect(listImports).toHaveBeenCalledTimes(1);
    expect(resolveImports).not.toHaveBeenCalled();
    expect(screen.getByText("This ontology imports 3 others.")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Imports/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expand();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("not loaded");
    expect(items[2].textContent).toContain("built in");
    expect(screen.getByRole("button", { name: "Resolve imports" })).toBeTruthy();
  });

  it("says offline in a sentence", async () => {
    listImports.mockResolvedValue({ ...UNRESOLVED, offline: true });
    await renderPanel();
    expand();
    expect(
      screen.getByText("Working offline. Only bundled and library imports can resolve."),
    ).toBeTruthy();
  });

  it("names a closure limit that was reached", async () => {
    listImports.mockResolvedValue({ ...PARTLY_FAILED, limit: "Only the first 100 imported documents were loaded." });
    await renderPanel();
    expand();
    expect(screen.getByText("Only the first 100 imported documents were loaded.")).toBeTruthy();
  });
});

describe("ImportsPanel resolving", () => {
  it("resolves, reports the new listing to App, and announces it politely", async () => {
    resolveImports.mockResolvedValue(PARTLY_FAILED);
    const { onChanged } = await renderPanel();
    expand();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resolve imports" }));
    });
    expect(resolveImports).toHaveBeenCalledWith("ont-1");
    expect(onChanged).toHaveBeenCalledWith(PARTLY_FAILED);
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Imports resolved: 1 document loaded.");
  });

  it("shows the progress and a Cancel while the request runs", async () => {
    let finish: (l: ImportsListing) => void = () => undefined;
    resolveImports.mockReturnValue(new Promise((r) => (finish = r)));
    cancelImports.mockResolvedValue({ cancelled: true });
    await renderPanel();
    expand();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resolve imports" }));
    });
    expect(screen.getByRole("status").textContent).toBe("Resolving imports…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelImports).toHaveBeenCalledWith("ont-1");
    await act(async () => finish(PARTLY_FAILED));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("a declined approval says so and still shows what resolved", async () => {
    resolveImports.mockRejectedValue(
      new Error("Semantic Studio did not connect to spec.example.org, so nothing was sent."),
    );
    listImports.mockResolvedValueOnce(UNRESOLVED).mockResolvedValueOnce(PARTLY_FAILED);
    await renderPanel();
    expand();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resolve imports" }));
    });
    expect(screen.getByText(/did not connect to spec.example.org/)).toBeTruthy();
    expect(screen.getByText("bundled")).toBeTruthy();
  });
});

describe("ImportsPanel failure actions (AC-19, AC-40)", () => {
  beforeEach(() => listImports.mockResolvedValue(PARTLY_FAILED));

  it("a failed row names its reason and offers the four ways out", async () => {
    await renderPanel();
    expand();
    const failed = screen.getAllByRole("listitem")[1];
    expect(failed.textContent).toContain("failed");
    expect(failed.textContent).toContain("The site answered HTTP 404 for this import.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open the link in my browser" });
    expect(link.getAttribute("href")).toBe(REMOTE);
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("button", { name: "Copy the link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose a file…" })).toBeTruthy();
  });

  it("a row left unresolved by a declined connection offers the same ways out", async () => {
    listImports.mockResolvedValue(
      listing([
        row(REMOTE, { error: "Not loaded: this needs your permission to connect to spec.example.org." }),
      ]),
    );
    await renderPanel();
    expand();
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("needs your permission");
    expect(screen.getByRole("button", { name: "Choose a file…" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the link in my browser" })).toBeTruthy();
  });

  it("offers files or a folder for everything unresolved", async () => {
    await renderPanel();
    expand();
    const group = screen.getByRole("group", { name: "Choose files or a folder" });
    expect(group.textContent).toContain("Choose files…");
    expect(group.textContent).toContain("Choose a folder…");
    expect(screen.getByTestId("imports-folder").hasAttribute("webkitdirectory")).toBe(true);
  });

  it("never renders a link for an IRI that is not http(s)", async () => {
    listImports.mockResolvedValue(
      listing([row("javascript:alert(1)", { status: "failed", error: "Only http(s) URLs." })]),
    );
    await renderPanel();
    expand();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy the link" })).toBeTruthy();
  });

  it("copies the link and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderPanel();
    expand();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the link" }));
    });
    expect(writeText).toHaveBeenCalledWith(REMOTE);
    expect(screen.getByRole("status").textContent).toBe(`Copied ${REMOTE}.`);
  });

  it("a folder sends only its RDF files", async () => {
    chooseImportFiles.mockResolvedValue({
      matched: [{ iri: REMOTE, file: "core.ttl" }],
      unmatched: [],
      mismatch: [],
      invalid: [],
      imports: PARTLY_FAILED,
    });
    await renderPanel();
    expand();
    const input = screen.getByTestId("imports-folder") as HTMLInputElement;
    const files = [
      new File(["x"], "core.ttl"),
      new File(["x"], "budget.xlsx"),
      new File(["x"], "other.owl"),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    const sent = chooseImportFiles.mock.calls[0][1] as File[];
    expect(sent.map((f) => f.name)).toEqual(["core.ttl", "other.owl"]);
    expect(screen.getByRole("status").textContent).toContain("Used core.ttl for 1 import.");
  });

  it("a file chosen for one import that declares another is used only after confirming (AC-42)", async () => {
    const file = new File(["x"], "core-v2.ttl");
    chooseImportFiles
      .mockResolvedValueOnce({
        matched: [],
        unmatched: [],
        mismatch: [{ file: "core-v2.ttl", declares: "https://spec.example.org/core/2", forIri: REMOTE }],
        invalid: [],
        imports: PARTLY_FAILED,
      })
      .mockResolvedValueOnce({
        matched: [{ iri: REMOTE, file: "core-v2.ttl" }],
        unmatched: [],
        mismatch: [],
        invalid: [],
        imports: PARTLY_FAILED,
      });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPanel();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    const input = screen.getByTestId("imports-row-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    expect(confirm).toHaveBeenCalledWith(
      `This file declares https://spec.example.org/core/2, not ${REMOTE}. Use it for ${REMOTE} anyway?`,
    );
    expect(chooseImportFiles).toHaveBeenNthCalledWith(1, "ont-1", [file], { forIri: REMOTE });
    expect(chooseImportFiles).toHaveBeenNthCalledWith(2, "ont-1", [file], {
      forIri: REMOTE,
      acceptMismatch: true,
    });
  });

  it("declining the mismatch sends nothing more", async () => {
    chooseImportFiles.mockResolvedValue({
      matched: [],
      unmatched: [],
      mismatch: [{ file: "x.ttl", declares: null, forIri: REMOTE }],
      invalid: [],
      imports: PARTLY_FAILED,
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderPanel();
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    const input = screen.getByTestId("imports-row-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "x.ttl")], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    expect(chooseImportFiles).toHaveBeenCalledTimes(1);
  });

  it("maps a failed import to a library ontology", async () => {
    mapImport.mockResolvedValue(PARTLY_FAILED);
    await renderPanel();
    expand();
    await act(async () => {
      fireEvent.change(
        screen.getByRole("combobox", { name: `Use an ontology from your library for ${REMOTE}` }),
        { target: { value: "ont-2" } },
      );
    });
    expect(mapImport).toHaveBeenCalledWith("ont-1", REMOTE, "ont-2");
  });
});

describe("ImportsPanel Include imports (AC-20)", () => {
  it("is a switch, shown once something resolved, stating its state", async () => {
    listImports.mockResolvedValue(PARTLY_FAILED);
    const { onIncludeImportsChange } = await renderPanel();
    expand();
    const toggle = screen.getByRole("switch", { name: "Include imports" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Showing this ontology on its own.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(onIncludeImportsChange).toHaveBeenCalledWith(true);
  });

  it("is absent while nothing has resolved", async () => {
    await renderPanel();
    expand();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says imported entities are read-only when on", async () => {
    listImports.mockResolvedValue(PARTLY_FAILED);
    await renderPanel({ includeImports: true });
    expand();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText(
        "Showing this ontology together with its imports. Imported entities are read-only.",
      ),
    ).toBeTruthy();
  });
});

describe("ImportsPanel words (AC-35)", () => {
  it("every source is a word, not a colour", () => {
    expect(statusText(row(FOAF, { status: "resolved", source: "bundled" }))).toBe("bundled");
    expect(
      statusText(row(FOAF, { status: "resolved", source: "library", sourceName: "foaf.ttl" })),
    ).toBe("from your library (foaf.ttl)");
    expect(
      statusText(row(FOAF, { status: "resolved", source: "mapped", sourceName: "mine.ttl" })),
    ).toBe("mapped to mine.ttl");
    expect(
      statusText(row(FOAF, { status: "resolved", source: "file", sourceName: "f.ttl" })),
    ).toBe("chosen file f.ttl");
    expect(
      statusText(
        row(FOAF, { status: "resolved", source: "network", fetchedAt: "2026-09-26T10:00:00Z" }),
      ),
    ).toMatch(/^downloaded .*2026/);
    expect(statusText(row(FOAF, { status: "blocked" }))).toBe("blocked");
  });

  it("summarises what is loaded and what is not", () => {
    expect(summaryText(PARTLY_FAILED)).toBe(
      "This ontology imports 2 others. 1 document loaded, 1 not loaded.",
    );
  });
});
