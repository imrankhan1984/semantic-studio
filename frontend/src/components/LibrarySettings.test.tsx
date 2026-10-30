// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/LibrarySettings.test.tsx
================================================================================

SUMMARY
    The first test for Settings → Library: *Bundled with Semantic Studio*
    comes before the catalogue (wording-and-query-export 5.7, AC-8), so
    *Add them back* is in view at 1280×720 without a scroll.

BASIC IDEA
    Order in the document is what a person scrolls through and what Tab
    reaches, so the test compares document positions: the bundled heading
    and its button before the catalogue's heading and its first entry. The
    section shows only while something bundled is missing, which is asserted
    too, so a test that rendered nothing could not pass. Whether it fits on
    the screen is a browser fact jsdom cannot measure; the PR's browser row
    measures it.

INPUTS / INPUT SOURCES
    - A mocked api.ts, so nothing reaches the network; the real CATALOGUE.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  fetchOntology: vi.fn(),
  restoreExamples: vi.fn(),
}));

import LibrarySettings from "./LibrarySettings";

afterEach(cleanup);

function renderLibrary(bundledMissing: string[]) {
  render(
    <LibrarySettings
      onLoaded={vi.fn()}
      bundledMissing={bundledMissing}
      onExamplesRestored={vi.fn()}
      focusTab={vi.fn()}
      dataDir="/data"
    />,
  );
}

function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("Settings → Library (wording 5.7, AC-8)", () => {
  it("puts Bundled with Semantic Studio, and Add them back, before the catalogue", () => {
    renderLibrary(["FOAF", "QUDT 3.5.2"]);
    const bundled = screen.getByRole("heading", { level: 3, name: "Bundled with Semantic Studio" });
    const addBack = screen.getByRole("button", { name: "Add them back" });
    const catalogue = screen.getByRole("heading", { level: 3, name: "Add a reference ontology" });
    const firstEntry = document.querySelector("[data-entry]")!;
    expect(firstEntry).not.toBeNull();
    expect(before(bundled, catalogue)).toBe(true);
    expect(before(addBack, catalogue)).toBe(true);
    expect(before(addBack, firstEntry)).toBe(true);
    expect(screen.getByText("Missing: FOAF, QUDT 3.5.2.")).toBeTruthy();
  });

  it("shows no Bundled section when nothing bundled is missing, and the catalogue leads", () => {
    renderLibrary([]);
    expect(screen.queryByRole("heading", { name: "Bundled with Semantic Studio" })).toBeNull();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe("Add a reference ontology");
  });
});
