// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/AboutPanel.test.tsx
================================================================================

SUMMARY
    Tests for AboutPanel: what it says, that what it says about the licence is
    still true of the LICENSE file, that it behaves as a modal dialog for a
    keyboard and a screen reader, and that it asks the network for nothing.

BASIC IDEA
    The panel is static text, so most of these are assertions about words. Two
    of them are worth more than they look.

    `the licence facts match the LICENSE file` reads the repository's LICENSE
    with Vite's ?raw and parses the copyright line out of it. The panel states
    the holder and the year on its own, so without this test a change to LICENSE
    would leave the interface making a false statement and nothing would notice.
    It asserts the file loaded first: a ?raw import that silently yields "" is
    the documented trap in this repository's CLAUDE.md, and every assertion
    below it would pass against an empty string.

    The dialog behaviour is asserted through the component's own key handler
    rather than through the browser's. jsdom implements no sequential focus
    navigation, so `userEvent.tab()` would test the polyfill; what is tested
    here is the handler that ships, which is also the thing that has to work,
    since a real browser's Tab is exactly what the trap has to interrupt.

INPUTS / INPUT SOURCES
    - The component's exported ABOUT copy constants.
    - frontend/src/index.css and the repository's LICENSE, both read as raw
      text by Vite.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-5 to AC-14 of about-panel.
================================================================================
*/

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutPanel, { ABOUT } from "./AboutPanel";
// The repository's licence, one directory above the frontend. Vite's ?raw
// rather than node:fs, which would need @types/node as a dependency — the same
// choice focus-visible.test.ts and no-raw-html.test.ts made.
import LICENSE from "../../../LICENSE?raw";
import CSS from "../index.css?raw";

// No auto-cleanup is configured, and every test here renders the same dialog:
// without this the second one finds two.
afterEach(() => {
  cleanup();
});

/** Render the panel and return its dialog element. */
function open(onClose = vi.fn()) {
  render(<AboutPanel onClose={onClose} />);
  return { dialog: screen.getByRole("dialog"), onClose };
}

/** The text of the whole panel, for the "does it say X" assertions. */
function panelText(): string {
  return screen.getByRole("dialog").textContent ?? "";
}

describe("AboutPanel content", () => {
  it("names the application and its purpose", () => {
    // AC-5. The shortest true answer to "what is this", which the interface
    // gives nowhere else, and it has to name all four of the languages.
    open();
    const text = panelText();
    expect(text).toContain("Semantic Studio");
    for (const language of ["RDF", "RDFS", "OWL", "SKOS"]) {
      expect(text, `${language} is not named`).toContain(language);
    }
    expect(text).toContain(ABOUT.description);
  });

  it("names the author and the copyright holder", () => {
    // AC-6, the author half.
    open();
    expect(panelText()).toContain("Created by Imran Khan");
    expect(panelText()).toContain("© 2026 Imran Khan");
  });

  it("names the MIT licence", () => {
    // AC-6, the licence half.
    open();
    expect(panelText()).toContain("MIT");
  });

  it("carries the as-is no-warranty sentence", () => {
    // AC-7. "Express or implied" was cut as boilerplate; "as is" and "without
    // warranty" are the two phrases that carry the meaning and must both stay.
    open();
    expect(panelText()).toContain('"as is"');
    expect(panelText()).toContain("without warranty of any kind");
  });

  it("states that ontologies stay on this machine", () => {
    // AC-8. This is the one line here that is a promise rather than a
    // description, and this assertion is what keeps it honest: a feature that
    // ever sends ontology content anywhere has to come through here and change
    // the words. See about-panel.md Section 15.
    open();
    expect(panelText()).toContain("stay on this machine");
    expect(panelText()).toContain("does not upload them");
  });

  it("links to the repository with rel noreferrer", () => {
    // AC-9. noreferrer implies noopener, which is what stops the opened page
    // reaching back through window.opener.
    open();
    const link = screen.getByRole("link", { name: /view source/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(ABOUT.repository);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("the licence facts match the LICENSE file", () => {
    // AC-6, as a regression rather than as a reading. A ?raw import that
    // resolves to "" passes every assertion below while proving nothing, so
    // prove the file loaded before believing anything it says.
    expect(LICENSE.length).toBeGreaterThan(500);
    expect(LICENSE).toContain("Permission is hereby granted");

    const copyright = LICENSE.match(/Copyright \(c\) (\d{4}) (.+)/);
    expect(copyright, "no copyright line in LICENSE").not.toBeNull();
    const [, year, holder] = copyright!;

    expect(LICENSE.startsWith("MIT License")).toBe(true);
    expect(ABOUT.licence).toContain("MIT");
    expect(ABOUT.licence).toContain(`© ${year} ${holder.trim()}`);
    expect(ABOUT.author).toContain(holder.trim());
  });

  it("makes no network request", () => {
    // AC-13. The panel is static text and must stay that way: an About panel
    // that phoned home would contradict the promise printed three lines above
    // the fold in it. fetch is the only route out of this component's reach.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    open();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("AboutPanel as a dialog", () => {
  it("is a dialog labelled by its heading", () => {
    // AC-10. aria-modal is what tells a screen reader the rest of the
    // application is not currently reachable; the label is what names it.
    const { dialog } = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { name: ABOUT.name });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("opening moves focus into the panel", () => {
    // AC-11, the opening half. Focus lands on the heading, which carries
    // tabindex="-1" so that script can reach it and Tab cannot.
    const { dialog } = open();
    const heading = screen.getByRole("heading", { name: ABOUT.name });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("the close control dismisses the panel", () => {
    // AC-11, one of the three routes. Focus is returned by App, which owns the
    // About control; all this component can do is say it is done.
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: /close about/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the panel", () => {
    // AC-11, the keyboard route. Bound to the document rather than the panel,
    // because pressing on the panel's own prose blurs focus to <body> in a
    // browser and a panel-scoped handler would then never see the key.
    const { onClose } = open();
    document.body.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click on the backdrop closes the panel", () => {
    // AC-11, the pointer route. The backdrop is a sibling of the dialog, not
    // its parent: aria-hidden on an ancestor would remove the dialog from the
    // accessibility tree, which is the opposite of what AC-10 asks for.
    const { onClose } = open();
    const backdrop = document.querySelector(".modal-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.contains(screen.getByRole("dialog"))).toBe(false);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focus is trapped while open", () => {
    // AC-12. Asserted against the component's own key handler, not against
    // sequential focus navigation, which jsdom does not implement — driving
    // userEvent.tab() here would test the polyfill instead of the trap.
    open();
    const close = screen.getByRole("button", { name: /close about/i });
    const link = screen.getByRole("link", { name: /view source/i });

    // Forwards from the last focusable wraps to the first.
    link.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // Backwards from the first wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(link);

    // And focus that has fallen out of the panel — onto <body>, which is where
    // a press on the panel's prose leaves it — is pulled back in rather than
    // continuing into the application behind the backdrop.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});

describe("AboutPanel typography", () => {
  /** The stylesheet with comments removed, so prose about a rule cannot be
   *  mistaken for the rule — and, more practically here, so a rule preceded by
   *  a comment is still preceded by the closing brace the matcher anchors on. */
  const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

  /** The declaration block of one rule in index.css, or "" if there is none. */
  function rule(selector: string): string {
    const found = RULES.match(new RegExp(`(^|})\\s*${selector}\\s*{([^}]*)}`));
    return found ? found[2] : "";
  }

  it("actually loaded the stylesheet", () => {
    // The same guard focus-visible.test.ts carries, for the same reason: vitest
    // stubs CSS out of the module graph unless test.css is set, and against ""
    // every assertion below would pass while measuring nothing.
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS).toContain(".about-panel");
  });

  it("body copy fits between 45 and 70 characters a line at the specified width", () => {
    // AC-14, the measure. The count is derived from the stylesheet rather than
    // written here, so widening the panel or changing the body size fails this
    // test instead of quietly moving the line length out of range.
    const panel = rule("\\.about-panel");
    const width = Number(panel.match(/width:\s*(\d+)px/)![1]);
    const padding = Number(panel.match(/padding:\s*(\d+)px/)![1]);
    const body = Number(rule("\\.about-description").match(/font-size:\s*(\d+)px/)![1]);
    expect(width).toBe(420);

    // Half the font size per character is the usual working figure for a
    // proportional face at this size, and the range is wide enough that a
    // better figure would not move the verdict. jsdom does no layout, so this
    // is arithmetic on the declared numbers — whether it reads well is the
    // browser check in Section 11 of the spec, not this.
    const measure = Math.floor((width - 2 * padding) / (body / 2));
    expect(measure).toBeGreaterThanOrEqual(45);
    expect(measure).toBeLessThanOrEqual(70);

    // And nothing in the copy is a single unbroken run longer than the upper
    // bound, which is the only way a string can break the measure the CSS sets.
    // A per-string minimum is deliberately NOT asserted: "Created by Imran
    // Khan" is 21 characters and is a label, not a paragraph.
    for (const [key, value] of Object.entries(ABOUT)) {
      if (key === "repository") continue; // a URL, which does not wrap by words
      for (const word of value.split(/\s+/)) {
        expect(word.length, `${key} has an unbreakable run: ${word}`).toBeLessThanOrEqual(70);
      }
      const longest = value
        .split(/\s+/)
        .reduce(
          (lines: string[], word) => {
            const line = lines[lines.length - 1];
            if (line.length === 0) lines[lines.length - 1] = word;
            else if (line.length + 1 + word.length <= measure) lines[lines.length - 1] = `${line} ${word}`;
            else lines.push(word);
            return lines;
          },
          [""],
        )
        .reduce((max, line) => Math.max(max, line.length), 0);
      expect(longest, `${key} wraps past 70 characters`).toBeLessThanOrEqual(70);
    }
  });

  it("the four blocks are separated by hairline rules", () => {
    // AC-14, the grouping. Three hairlines between four blocks, and they are
    // rules rather than boxes: a border around each block would make four edges
    // to read before reading any of the text.
    const { dialog } = open();
    expect(dialog.querySelectorAll("hr.about-rule")).toHaveLength(3);
    expect(dialog.querySelectorAll(".about-block")).toHaveLength(4);
    expect(rule("\\.about-rule")).toMatch(/border-top:\s*1px solid var\(--border\)/);
    // The panel keeps its own frame; the blocks inside it do not get one each.
    expect(rule("\\.about-block")).not.toMatch(/border/);
  });

  it("the panel stays inside a narrow window", () => {
    // AC-14, the max-width. 420px alone would overflow a phone-width viewport
    // and put a horizontal scrollbar on the whole application.
    expect(rule("\\.about-panel")).toMatch(/max-width:\s*calc\(100vw - 32px\)/);
  });
});
