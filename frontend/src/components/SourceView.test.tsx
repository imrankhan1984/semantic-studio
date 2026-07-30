// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/SourceView.test.tsx
================================================================================

SUMMARY
    The first test for SourceView, and it covers one thing: reaching an entity
    in the raw text from a query result. Where the line is found, in which of
    the two written forms, what is said when it cannot be found, and that the
    lookup stays a literal string search over ontology-controlled text.

BASIC IDEA
    Split in two on purpose. The rule lives in sourceTarget.ts, so the cases
    that matter — both written forms, regex metacharacters, the truncation
    message, and the 2 MB budget — are asserted against the function directly.
    Rendering a 60,000-line document into jsdom to time a string scan would
    measure jsdom, which is the mistake D-020 and D-021 record.

    The component half then asserts the wiring that the pure function cannot:
    that the located line carries the highlight, that the outcome is reported
    back exactly once, and that nothing is reported while the fetch is still in
    flight — a document that has not arrived yet contains no lines, and a
    lookup run against it would announce that the entity is absent from a file
    nobody has read.

INPUTS / INPUT SOURCES
    - A mocked ../api whose getSource returns a fixed document.
    - Synthetic line arrays built in this file for the pure-function cases.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-9 and AC-10.
================================================================================
*/

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SourceView from "./SourceView";
import { findTargetLine, targetMissingMessage } from "../sourceTarget";
import type { OntologySource } from "../types";

const { getSource } = vi.hoisted(() => ({ getSource: vi.fn() }));
vi.mock("../api", () => ({ getSource }));

/** A small pretty-printed document, with the entity written in prefixed form. */
const PRETTY = [
  "@prefix ex: <http://example.org/> .",
  "",
  "ex:Bond a owl:Class ;",
  '    rdfs:label "Bond" .',
  "",
  "ex:Issuer a owl:Class .",
].join("\n");

function sourceOf(text: string, truncated = false): OntologySource {
  return {
    text,
    format: "turtle",
    pretty: true,
    truncated,
    bytes: text.length,
    lines: text.split("\n").length,
    name: "FIBO",
  };
}

/**
 * Let the mount-time fetch settle and the deferred scroll fire.
 *
 * Two passes, and the second one is not padding. A timer scheduled by an effect
 * that itself runs *inside* an async `act` body does not fire before that body
 * resolves: React flushes the passive effect at the end of the act scope, so
 * the component's 40 ms scroll is only queued as the first wait finishes.
 * Measured 2026-07-31 against a four-line probe component — one pass leaves
 * scrollIntoView at zero calls no matter how long it waits.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

beforeEach(() => {
  getSource.mockReset().mockResolvedValue(sourceOf(PRETTY));
  // jsdom implements no scrolling. Nothing here asserts on the viewport; what
  // matters is which element the component asked to bring into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("locating a target in the source", () => {
  it("locates a target by full IRI", () => {
    // AC-9. The Original view of an N-Triples or RDF/XML file writes IRIs out,
    // so the full form has to be tried and it is tried first.
    const lines = ["# header", "<http://example.org/Issuer> a owl:Class .", "<http://example.org/Bond> a owl:Class ."];
    expect(findTargetLine(lines, { iri: "http://example.org/Bond" })).toBe(2);
  });

  it("locates a target by prefixed form", () => {
    // AC-9, and the half most likely to be missed. GET /source serves pretty
    // Turtle on the Formatted tab, in which the full IRI appears in the @prefix
    // line and nowhere else — searching only for it would land on the header.
    const lines = PRETTY.split("\n");
    expect(
      findTargetLine(lines, { iri: "http://example.org/Bond", prefixed: "ex:Bond" }),
    ).toBe(2);
  });

  it("prefers the full IRI over the prefixed form", () => {
    // The order is a preference about the document, not about a line: a file
    // that spells the entity out somewhere should land there rather than on an
    // unrelated line that merely shares a prefix.
    const lines = ["ex:BondHolder a owl:Class .", "<http://example.org/Bond> a owl:Class ."];
    expect(findTargetLine(lines, { iri: "http://example.org/Bond", prefixed: "ex:Bond" })).toBe(1);
  });

  it("an IRI with regex metacharacters is matched literally", () => {
    // AC-10, and the security assertion of this file. The needle comes out of
    // the ontology. Interpolated into a RegExp, `.` would match any character
    // and the decoy on line 0 would win — so an uploaded file could choose
    // which line the reader is sent to. sourceTarget.ts uses indexOf.
    const lines = [
      "<http://exXorg/AxB> a owl:Class .",   // only a regex would match this
      "",
      "<http://ex.org/A.B> a owl:Class .",   // the literal match
    ];
    expect(findTargetLine(lines, { iri: "http://ex.org/A.B" })).toBe(2);
  });

  it("does not match a longer term that starts the same way", () => {
    // Found in Chrome on 2026-07-31, not here: asking for Mars in the Formatted
    // Turtle view landed on `ns1:Mars2020`, three declarations above the real
    // one. A plain substring search is right about the characters and wrong
    // about the term, and the reader has no way to tell they were misdirected.
    const lines = [
      "ns1:Mars2020 a ns1:Mission ;",
      "ns1:MarsRover a ns1:Spacecraft ;",
      "ns1:Mars a ns1:Planet ;",
    ];
    expect(findTargetLine(lines, { iri: "http://example.org/space#Mars", prefixed: ":Mars" })).toBe(2);
  });

  it("matches a term ending at any of the delimiters RDF uses", () => {
    // The boundary rule has to hold at a comma, a semicolon, a full stop, a
    // closing angle bracket and end of line, or it trades one wrong answer for
    // a different one. `>` is the case that matters most: the Original view of
    // an N-Triples file writes every IRI inside brackets.
    for (const line of [":Mars .", ":Mars,", ":Mars;", "<http://x/Mars> a :Planet", "x [:Mars]", ":Mars"]) {
      expect(findTargetLine([line], { iri: "http://x/Mars", prefixed: ":Mars" }), line).toBe(0);
    }
  });

  it("puts the colon back on a default-namespace prefixed form", () => {
    // The second thing Chrome caught on 2026-07-31. rdflib shortens a term in
    // the default namespace to a bare local name, so the backend sends `Mars`
    // rather than `:Mars` — and searching a document for `Mars` lands on
    // `rdfs:label "Mars 2020"`, in the middle of a different entity.
    const lines = [
      ":Mars2020 a :Mission ;",
      '    rdfs:label "Mars 2020" ;',
      ":Mars a :Planet ;",
    ];
    expect(findTargetLine(lines, { iri: "http://example.org/space#Mars", prefixed: "Mars" })).toBe(2);
  });

  it("returns -1 when the entity is absent", () => {
    expect(findTargetLine(PRETTY.split("\n"), { iri: "http://example.org/Absent" })).toBe(-1);
  });

  it("reports when the target is past a truncated source", () => {
    // AC-10. GET /source caps the text at 2 MB, so on a large file "not found"
    // usually means "further down than this pane goes". Saying it is absent
    // would be false, and the two sentences must not converge.
    const past = targetMissingMessage(true);
    const absent = targetMissingMessage(false);
    expect(past).toBe("That entity is past the part of the file shown here.");
    expect(absent).not.toBe(past);
    expect(absent).toContain("Original and Formatted Turtle");
  });

  it("locates a target within budget", () => {
    // Section 10, row 3. An absolute millisecond figure, which this project
    // otherwise avoids — and it is defensible here because it times a string
    // scan over a fixed array, with no DOM construction anywhere in the
    // measured region. That is what made the detail-panel budget in D-020
    // unhonest: it measured jsdom.
    //
    // The worst case is measured, not the common one: an entity that is not in
    // the document at all makes both passes run to the end.
    const line = "<http://example.org/Filler> rdfs:comment \"padding padding padding\" .";
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 2 * 1024 * 1024) {
      lines.push(line);
      bytes += line.length + 1;
    }

    const elapsed = (): number => {
      const start = performance.now();
      findTargetLine(lines, { iri: "http://example.org/Missing", prefixed: "ex:Missing" });
      return performance.now() - start;
    };
    elapsed(); // discarded: it pays for the first JIT passes
    const runs = [elapsed(), elapsed(), elapsed(), elapsed(), elapsed()].sort((a, b) => a - b);
    const median = runs[2];

    expect(
      median,
      `${lines.length.toLocaleString()} lines, ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
        `median ${median.toFixed(1)} ms of ${runs.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThanOrEqual(50);
  });
});

describe("SourceView target", () => {
  it("highlights the located line and scrolls to it", async () => {
    // AC-9 through the component. The class is what the reader sees; the
    // scrollIntoView call is what puts it on screen, and neither is worth much
    // without the other.
    const resolved = vi.fn();
    render(
      <SourceView
        ontologyId="o1"
        target={{ iri: "http://example.org/Bond", prefixed: "ex:Bond" }}
        onTargetResolved={resolved}
      />,
    );
    await settle();

    const marked = document.querySelectorAll(".source-line.target");
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("data-line")).toBe("2");
    expect(marked[0].textContent).toContain("ex:Bond");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // A hit is not announced: the highlight and the focus move are the answer.
    expect(resolved).toHaveBeenCalledWith(null);
  });

  it("does not animate the scroll when motion is not wanted", async () => {
    // The one motion this feature adds, so it is the one that has to ask. No
    // CSS rule can reach a scrollIntoView option, which is why this is in the
    // component rather than in the stylesheet.
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    render(
      <SourceView ontologyId="o1" target={{ iri: "http://example.org/Bond", prefixed: "ex:Bond" }} />,
    );
    await settle();

    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "auto",
    });
    vi.unstubAllGlobals();
  });

  it("reports a miss with the reason, and only once the file has arrived", async () => {
    // AC-10, and the assertion that pins the `!source` guard. Deleting that
    // guard makes this fail on its first expectation rather than its last: the
    // lookup runs against an empty document while the fetch is in flight and
    // announces that the entity is absent from a file nobody has read.
    let release: (source: OntologySource) => void = () => {};
    getSource.mockReturnValue(
      new Promise<OntologySource>((resolve) => {
        release = resolve;
      }),
    );
    const resolved = vi.fn();

    await act(async () => {
      render(
        <SourceView
          ontologyId="o1"
          target={{ iri: "http://example.org/Absent" }}
          onTargetResolved={resolved}
        />,
      );
    });
    expect(resolved).not.toHaveBeenCalled();

    await act(async () => {
      release(sourceOf(PRETTY));
    });
    await settle();

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(targetMissingMessage(false));
    expect(document.querySelector(".source-line.target")).toBeNull();
  });

  it("says the entity is past the shown part of a truncated file", async () => {
    // AC-10. The 2 MB cap is the ordinary case on a large ontology, so this is
    // the message a FIBO user meets, not an edge case.
    getSource.mockResolvedValue(sourceOf(PRETTY, true));
    const resolved = vi.fn();
    render(
      <SourceView
        ontologyId="o1"
        target={{ iri: "http://example.org/Absent" }}
        onTargetResolved={resolved}
      />,
    );
    await settle();

    expect(resolved).toHaveBeenCalledWith("That entity is past the part of the file shown here.");
  });

  it("the target highlight survives a find-in-file search", async () => {
    // The two highlights answer different questions. Searching after arriving
    // from a result must not throw away where the result sent you, which is why
    // the classes are separate rather than one `active` reused.
    render(
      <SourceView
        ontologyId="o1"
        target={{ iri: "http://example.org/Bond", prefixed: "ex:Bond" }}
        onTargetResolved={vi.fn()}
      />,
    );
    await settle();

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      search.value = "Issuer";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.querySelector(".source-line.target")!.getAttribute("data-line")).toBe("2");
  });

  it("takes focus on a target and leaves it alone without one", async () => {
    // AC-12 at the component level. The control that was pressed is in the
    // query panel, which this pane now covers — but switching to View from the
    // tab bar must not steal focus from the tab the user just pressed.
    const { rerender } = render(<SourceView ontologyId="o1" />);
    await settle();
    expect(document.activeElement).not.toBe(document.querySelector("#source-view-heading"));

    rerender(<SourceView ontologyId="o1" target={{ iri: "http://example.org/Bond" }} />);
    expect(document.activeElement).toBe(document.querySelector("#source-view-heading"));
  });

  it("the heading names the pane and is not a tab stop", async () => {
    // A heading exists at all, which it did not before: the pane had nothing
    // naming it and nothing for a mode change to land on. tabIndex -1 keeps it
    // script-focusable without adding a stop to the tab order.
    render(<SourceView ontologyId="o1" />);
    await settle();

    const heading = document.querySelector("#source-view-heading")!;
    expect(heading.tagName).toBe("H2");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.querySelector(".source-view")!.getAttribute("aria-labelledby")).toBe(
      "source-view-heading",
    );
  });
});
