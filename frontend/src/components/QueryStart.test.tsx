// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/QueryStart.test.tsx
================================================================================

SUMMARY
    QueryStart's first test (explore-and-query-layout 5.6, AC-8): the start
    list draws a class the schema marks RDFS-only in the RDFS class colour,
    and an OWL class in the class colour, as the graph does.

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
