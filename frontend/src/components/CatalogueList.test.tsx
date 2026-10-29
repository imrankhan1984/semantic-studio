// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/CatalogueList.test.tsx
================================================================================

SUMMARY
    Proves the catalogue renders as CATALOGUE says, in Settings → Library,
    and only there: the home screen's "Try one" section went when the bundled
    examples came (home-and-examples 5.5), and the Load dialog's "Suggested"
    tab when Settings came (home-and-settings 5.3); a test holds Home and the
    dialog to showing none of it.

BASIC IDEA
    The reason this file exists is drift, not rendering. Before CatalogueList
    the two screens would have carried two copies of the same markup over the
    same constant, and backlog L-1 is about to reorder that constant. A test
    that only checked one screen would let the other fall behind silently.

    So the assertion was a comparison, not a snapshot: render both callers
    and check the button names match, element for element, in order. With
    one caller left, Library is compared with the constant, and Home and the
    Load dialog with nothing.

    Since 2026-07-30 it also covers backlog L-1's rendering half: that the
    audience line reaches the screen, that it reaches the accessible name, and
    that the order a keyboard user tabs through is the order they read. Those
    were specified against a new LoadDialog.test.tsx, which was the right file
    before CatalogueList existed and is the wrong one now — the markup they
    assert on lives here, and asserting it through the dialog would test this
    component at one remove for no gain.

INPUTS / INPUT SOURCES
    - The real CATALOGUE constant, deliberately not mocked: the ordering is
      the thing under test.
    - A mocked api.ts, so neither caller can reach the network.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-15 and, for catalogue-order, AC-1,
      AC-7 and AC-8.
================================================================================
*/

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogueList from "./CatalogueList";
import LibrarySettings from "./LibrarySettings";
import LoadDialog from "./LoadDialog";
import HomeScreen from "./HomeScreen";
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
    <HomeScreen
      ontologies={[]}
      loading={false}
      error={null}
      theme="dark"
      workingId={null}
      pendingMode={null}
      onRetry={vi.fn()}
      onOpen={vi.fn()}
      onEnterMode={vi.fn()}
      onViewSource={vi.fn()}
      onRemove={vi.fn()}
      onOpenDialog={vi.fn()}
    />,
  ).container;
}

describe("CatalogueList", () => {
  it("Settings → Library lists the catalogue in its order; Home and the Load dialog list none of it (home-and-settings 5.3)", () => {
    // AC-15, with one caller left: Home's catalogue went with Try one, the
    // Load dialog's with its Suggested tab.
    const chooser = renderChooser();
    expect(entryNames(chooser)).toEqual([]);
    document.body.innerHTML = "";

    const dialog = render(<LoadDialog onLoaded={vi.fn()} onClose={vi.fn()} />).container;
    expect(entryNames(dialog)).toEqual([]);
    document.body.innerHTML = "";

    const library = render(
      <LibrarySettings onLoaded={vi.fn()} bundledMissing={[]} focusTab={vi.fn()} />,
    ).container;
    const fromLibrary = entryNames(library);

    expect(fromLibrary).toHaveLength(CATALOGUE.length);
    CATALOGUE.forEach((entry, i) => expect(fromLibrary[i]).toContain(entry.name));
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
    // and nothing else can be started underneath it. aria-disabled, never
    // disabled, so the row pressed keeps focus (load-progress 5.3).
    const target = CATALOGUE[1];
    const onPick = vi.fn();
    render(<CatalogueList fetchingId={target.id} busy onPick={onPick} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect((button as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(button);
    }
    expect(onPick).not.toHaveBeenCalled();
    const downloading = document.querySelectorAll(".catalogue-loading");
    expect(downloading).toHaveLength(1);
    expect(downloading[0].closest("button")?.textContent).toContain(target.name);
  });

  it("draws the status under the entry it names, outside the button", () => {
    const target = CATALOGUE[2];
    render(
      <CatalogueList
        fetchingId={target.id}
        busy
        onPick={vi.fn()}
        status={<p className="load-step">Downloading and reading: 3 seconds so far.</p>}
        statusId={target.id}
      />,
    );
    const step = screen.getByText("Downloading and reading: 3 seconds so far.");
    expect(step.closest("button")).toBeNull();
    const row = document.querySelector(`[data-entry="${target.id}"]`)!;
    expect(row.nextElementSibling).toBe(step);
  });

  it("renders the audience line for each entry", () => {
    // AC-7. Beneath the description, and present for all four rather than for
    // whichever one happened to be checked.
    const { container } = render(
      <CatalogueList fetchingId={null} busy={false} onPick={vi.fn()} />,
    );
    const buttons = [...container.querySelectorAll("button.catalogue-entry")];

    buttons.forEach((button, i) => {
      const audience = button.querySelector(".catalogue-audience");
      expect(audience?.textContent).toBe(CATALOGUE[i].audience);
      // "Beneath the description" is a claim about order in the flow, which is
      // all jsdom can see; the appearance is confirmed in a browser.
      const desc = button.querySelector(".catalogue-desc");
      expect(
        desc!.compareDocumentPosition(audience!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it("renders entries in array order", () => {
    // AC-1's on-screen half. Anchored to the literal expected order rather than
    // to CATALOGUE, because comparing the render against the array it was
    // rendered from cannot fail — the existing order test above has that shape
    // deliberately, for the drift comparison, and this one must not.
    const { container } = render(
      <CatalogueList fetchingId={null} busy={false} onPick={vi.fn()} />,
    );
    const rendered = [...container.querySelectorAll("button.catalogue-entry")].map(
      (b) => b.querySelector(".catalogue-name")?.textContent?.trim() ?? "",
    );

    // FOAF left the list for the library's examples (home-and-examples 5.8).
    expect(rendered[0]).toContain("schema.org");
    expect(rendered.map((name) => name.split(" —")[0])).toEqual([
      "schema.org",
      "FIBO",
      "UNESCO Thesaurus",
      // Last since reference-ontologies 5.3.
      "QUDT 3.5.2, SHACL form",
    ]);
  });

  it("audience line is part of the row's accessible name", () => {
    // AC-8. Queried *by* accessible name rather than asserted on textContent:
    // getByRole's name option computes the real name through
    // dom-accessibility-api, so this fails if the line is ever moved somewhere
    // the name does not reach — aria-hidden, a title attribute, a
    // pseudo-element — all of which leave textContent looking correct.
    render(<CatalogueList fetchingId={null} busy={false} onPick={vi.fn()} />);

    for (const entry of CATALOGUE) {
      // Throws if no button's accessible name contains the audience line, and
      // throws if more than one does.
      const row = screen.getByRole("button", {
        name: new RegExp(escapeRegExp(entry.audience)),
      });
      // Confirms the line landed on the row it belongs to, not merely on some
      // row: a copy-paste that gave two entries the same audience would
      // otherwise pass the query above for one of them.
      expect(row.textContent).toContain(entry.name);
    }
  });

  it("tab order matches visual order", () => {
    // AC-8, the half that can be asserted here. The rows carry no tabindex, so
    // tab order is DOM order; that DOM order is also the *visual* order was
    // measured in Chrome on 2026-07-30 by comparing each row's bounding
    // rectangle against its position in the DOM, because jsdom has no layout and
    // cannot see it. Asserted as the absence of the mechanism that would break
    // it rather than by driving Tab, because jsdom does not implement
    // sequential focus navigation and a userEvent.tab() loop would be testing
    // the polyfill.
    const { container } = render(
      <CatalogueList fetchingId={null} busy={false} onPick={vi.fn()} />,
    );
    const buttons = [...container.querySelectorAll("button.catalogue-entry")];

    for (const button of buttons) {
      expect(button.hasAttribute("tabindex")).toBe(false);
    }
    // And nothing else in the list is focusable, so the four rows are the whole
    // tab sequence and it is in the order they are read.
    expect(container.querySelectorAll("button, [tabindex], a, input")).toHaveLength(
      buttons.length,
    );
  });
});

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
