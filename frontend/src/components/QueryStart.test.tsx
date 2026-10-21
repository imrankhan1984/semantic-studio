// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/QueryStart.test.tsx
================================================================================

SUMMARY
    QueryStart's first test (explore-and-query-layout 5.6, AC-8): the start
    list draws a class the schema marks RDFS-only in the RDFS class colour,
    and an OWL class in the class colour, as the graph does; and a bundled
    example's questions, first in Try one of these (query-page-rework 5.4).

BASIC IDEA
    QueryStart is pure over its props, so it is rendered with a hand-made
    schema and the swatch colours are read back and compared with what
    theme/kinds.ts says, never with hex values written here.

INPUTS / INPUT SOURCES
    - QueryStart.tsx, a two-class QuerySchema, kindColor from types.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryStart from "./QueryStart";
import type { QuerySchema } from "../types";
import { kindColor } from "../types";

const SCHEMA: QuerySchema = {
  classes: [
    { iri: "http://x/Plain", label: "Plain", prefixed: "x:Plain", instances: 2, kind: "class", classType: "rdfs" },
    { iri: "http://x/Owl", label: "Owl", prefixed: "x:Owl", instances: 1, kind: "class" },
  ],
  links: [],
  superClasses: {},
  dataProperties: {},
  namespaces: {},
  truncated: false,
};

/** The colour jsdom resolves a hex to, so the two compare like for like. */
function resolved(hex: string): string {
  const probe = document.createElement("span");
  probe.style.background = hex;
  return probe.style.background;
}

afterEach(cleanup);

describe("QueryStart's start list colours (explore-and-query-layout 5.6, AC-8)", () => {
  it.each(["light", "dark"] as const)("an RDFS-only class in the RDFS class colour, an OWL class in the class colour (%s)", (theme) => {
    render(<QueryStart schema={SCHEMA} theme={theme} onUseStarter={vi.fn()} onPickClass={vi.fn()} />);
    const dotOf = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`^${name}`) }).querySelector<HTMLElement>(".dot")!;
    const rdfs = kindColor("class", theme, "rdfs");
    const owl = kindColor("class", theme);
    // The two colours differ, or the assertions below would prove nothing.
    expect(rdfs).not.toBe(owl);
    expect(dotOf("Plain").style.background).toBe(resolved(rdfs));
    expect(dotOf("Owl").style.background).toBe(resolved(owl));
  });

  it("picking an RDFS class still begins the path from it", () => {
    const onPickClass = vi.fn();
    render(<QueryStart schema={SCHEMA} theme="light" onUseStarter={vi.fn()} onPickClass={onPickClass} />);
    fireEvent.click(screen.getByRole("button", { name: /^Plain/ }));
    expect(onPickClass).toHaveBeenCalledWith("http://x/Plain", "Plain");
  });
});

describe("Questions for this example (query-page-rework 5.4, AC-8)", () => {
  const QUESTIONS = [
    { id: "q-mars", title: "Which missions went to Mars?", about: "A sub-property counts as its parent.", text: "SELECT 1 {}" },
    { id: "q-moons", title: "Which moons orbit Jupiter?", about: "Two conditions on one subject.", text: "SELECT 2 {}" },
  ];

  it("come first in Try one of these, under their heading, before the starters", () => {
    render(<QueryStart schema={SCHEMA} theme="light" onUseStarter={vi.fn()} onPickClass={vi.fn()} questions={QUESTIONS} />);
    const heading = screen.getByRole("heading", { name: "Questions for this example" });
    const tryHeading = screen.getByRole("heading", { name: "Try one of these" });
    const first = screen.getByRole("button", { name: "Which missions went to Mars?" });
    const starter = document.querySelector(".starter:not(.question)")!;
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(tryHeading, heading)).toBe(true);
    expect(follows(heading, first)).toBe(true);
    expect(follows(first, starter)).toBe(true);
  });

  it("each is a button named by its title and described by what it shows; a click asks it", () => {
    const onAskQuestion = vi.fn();
    render(
      <QueryStart schema={SCHEMA} theme="light" onUseStarter={vi.fn()} onPickClass={vi.fn()} questions={QUESTIONS} onAskQuestion={onAskQuestion} />,
    );
    const button = screen.getByRole("button", { name: "Which moons orbit Jupiter?" });
    const describedBy = button.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("Two conditions on one subject.");
    fireEvent.click(button);
    expect(onAskQuestion).toHaveBeenCalledWith(QUESTIONS[1]);
  });

  it("with none handed over there is no heading", () => {
    render(<QueryStart schema={SCHEMA} theme="light" onUseStarter={vi.fn()} onPickClass={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "Questions for this example" })).toBeNull();
  });
});
