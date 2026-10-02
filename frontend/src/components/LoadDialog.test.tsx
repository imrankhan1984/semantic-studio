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
    while the wizard runs.

BASIC IDEA
    api.ts is mocked; the snapshot list reads the real project store, left
    empty, so the list says it is reading.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fetchHierarchy: vi.fn(() => new Promise(() => {})),
}));

import LoadDialog from "./LoadDialog";

const PROJECT = { id: "prj-0123456789ab", name: "Shop", modelOntologyId: "prj-0123456789ab-model", taxonomy: false };

afterEach(cleanup);

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

  it("falls back to Suggested when Data is asked for with no project open", () => {
    render(<LoadDialog onLoaded={() => {}} onClose={() => {}} initialTab="data" />);
    expect(screen.getByRole("heading", { name: "Load ontology" })).toBeTruthy();
    expect(screen.getByText(/Well-known public ontologies/)).toBeTruthy();
  });
});
