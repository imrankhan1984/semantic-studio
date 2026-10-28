// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/icons.test.tsx
================================================================================

SUMMARY
    The first test of icons.tsx (CLAUDE.md: a change to an untested file
    adds its first one), written when shacl-authoring added IconShapes.

BASIC IDEA
    Every exported icon renders one stroked svg in the current colour and
    no text: an icon beside a word adds nothing a screen reader should read.

INPUTS / INPUT SOURCES
    - The icons module.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as icons from "./icons";

afterEach(cleanup);

describe("icons", () => {
  const entries = Object.entries(icons).filter(([name]) => name.startsWith("Icon"));

  it("exports the Shapes icon beside the other mode icons", () => {
    expect(entries.map(([name]) => name)).toEqual(expect.arrayContaining(["IconHierarchy", "IconShapes", "IconEdit"]));
  });

  // home-and-settings 5.1: Settings took Network's place in the header, with
  // a gear, hidden from assistive technology beside its word.
  it("exports the Settings gear", () => {
    expect(entries.map(([name]) => name)).toContain("IconSettings");
    const { container } = render(<icons.IconSettings />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(entries)("%s is one stroked svg in the current colour, with no text", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(container.textContent).toBe("");
  });
});
