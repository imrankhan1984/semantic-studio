// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/CatalogueList.test.tsx
================================================================================

SUMMARY
    Proves the catalogue renders identically wherever it appears: the start
    screen's "Try one" section and the Load dialog's "Suggested" tab must show
    the same entries in the same order, because they are the same component.

BASIC IDEA
    The reason this file exists is drift, not rendering. Before CatalogueList
    the two screens would have carried two copies of the same markup over the
    same constant, and backlog L-1 is about to reorder that constant. A test
    that only checked one screen would let the other fall behind silently.

    So the assertion is a comparison, not a snapshot: render both callers and
    check the button names match, element for element, in order. It fails the
    moment either screen grows its own copy.

INPUTS / INPUT SOURCES
    - The real CATALOGUE constant, deliberately not mocked: the ordering is
      the thing under test.
    - A mocked api.ts, so neither caller can reach the network.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-15.
================================================================================
*/

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogueList from "./CatalogueList";
import LoadDialog from "./LoadDialog";
import StartScreen from "./StartScreen";
import { CATALOGUE } from "../catalogue";

const { fetchOntology, uploadOntology } = vi.hoisted(() => ({
  fetchOntology: vi.fn(),
  uploadOntology: vi.fn(),
}));
vi.mock("../api", () => ({ fetchOntology, uploadOntology }));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/** The accessible names of the catalogue rows inside one container, in order. */
function entryNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".catalogue-entry")].map(
    (b) => b.textContent?.trim() ?? "",
  );
}

function renderChooser() {
  return render(
    <StartScreen
      ontologies={[]}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onOpen={vi.fn()}
      onLoaded={vi.fn()}
      onOpenDialog={vi.fn()}
    />,
  ).container;
}

describe("CatalogueList", () => {
  it("catalogue list renders identically in the chooser and the dialog", () => {
    // AC-15. Same entries, same order, from the same component.
    const chooser = renderChooser();
    const fromChooser = entryNames(chooser);
    document.body.innerHTML = "";

    const dialog = render(<LoadDialog onLoaded={vi.fn()} onClose={vi.fn()} />).container;
    const fromDialog = entryNames(dialog);

    expect(fromChooser).toHaveLength(CATALOGUE.length);
    expect(fromChooser).toEqual(fromDialog);
    // Anchored to the constant as well as to each other, so two screens that
    // agreed on the same wrong list would still fail.
    CATALOGUE.forEach((entry, i) => expect(fromChooser[i]).toContain(entry.name));
  });

  it("renders every catalogue entry as a button, in CATALOGUE order", () => {
    const { container } = render(
      <CatalogueList fetchingId={null} busy={false} onPick={vi.fn()} />,
    );
    const buttons = [...container.querySelectorAll("button.catalogue-entry")];

    expect(buttons).toHaveLength(CATALOGUE.length);
    buttons.forEach((button, i) => {
      expect(button.tagName).toBe("BUTTON");
      expect(within(button as HTMLElement).getByText(CATALOGUE[i].name)).toBeTruthy();
      expect(button.textContent).toContain(CATALOGUE[i].size);
    });
  });

  it("marks only the downloading entry and disables all of them", () => {
    // The busy contract both callers rely on: one row says what it is doing,
    // and nothing else can be started underneath it.
    const target = CATALOGUE[1];
    render(<CatalogueList fetchingId={target.id} busy onPick={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    const downloading = document.querySelectorAll(".catalogue-loading");
    expect(downloading).toHaveLength(1);
    expect(downloading[0].closest("button")?.textContent).toContain(target.name);
  });
});
