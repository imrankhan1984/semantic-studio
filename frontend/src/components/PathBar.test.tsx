// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/PathBar.test.tsx
================================================================================

SUMMARY
    PathBar's first test (CLAUDE.md lists it untested): a class step is
    coloured as the graph colours it (portal-foundations 5.3, AC-4 and AC-5).

BASIC IDEA
    PathBar is presentational, so it is rendered with a hand-built query
    state. The step's chip border and its number badge both carry the kind
    colour; jsdom writes a colour back as rgb(), so expected hex values pass
    through a probe element first.

INPUTS / INPUT SOURCES
    - A two-step QueryState, a classKinds map as the query schema gives it,
      and the RDFS-only classes App reads from the graph.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PathBar from "./PathBar";
import { emptyQueryState, type QueryState } from "../sparql/types";

const EX = "http://ex.org/";

const STATE: QueryState = {
  ...emptyQueryState(),
  steps: [
    { classIri: EX + "Plain", label: "Plain", props: [] },
    {
      classIri: EX + "Owl",
      label: "Owl",
      props: [],
      link: { anchor: 0, predicates: [{ iri: EX + "p", inverse: false }], modifier: "", optional: false },
    },
  ],
};

function css(colour: string): string {
  const probe = document.createElement("span");
  probe.style.background = colour;
  return probe.style.background;
}

function renderBar(classKinds: Record<string, string>, rdfsClasses?: Set<string>) {
  render(
    <PathBar
      state={STATE}
      stepVars={["plain", "owl"]}
      theme="light"
      classKinds={classKinds}
      rdfsClasses={rdfsClasses}
      labelFor={(iri) => iri}
      openMenu={null}
      onOpenMenu={vi.fn()}
      onRemoveStep={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  return [...document.querySelectorAll<HTMLElement>(".chip-index")];
}

describe("PathBar step colours", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("an RDFS-only class shows the RDFS class colour; an OWL class the class colour", () => {
    const [plain, owl] = renderBar({ [EX + "Plain"]: "class", [EX + "Owl"]: "class" }, new Set([EX + "Plain"]));
    expect(plain.style.background).toBe(css("#2f7f78"));
    expect(owl.style.background).toBe(css("#4a72a8"));
  });

  it("a class kind named constructor falls through to other (X-6)", () => {
    const [plain] = renderBar({ [EX + "Plain"]: "constructor" });
    expect(plain.style.background).toBe(css("#6b7588"));
  });

  it("a class the schema does not list is coloured as a class", () => {
    const [plain] = renderBar({});
    expect(plain.style.background).toBe(css("#4a72a8"));
  });
});
