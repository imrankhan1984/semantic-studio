// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/WhyDisclosure.test.tsx
================================================================================

SUMMARY
    Why? (axioms-and-reasoning 5.6, AC-5): a disclosure that asks for the
    reason only when opened, lists its premises each marked stated or
    inferred in words, offers an inferred premise its own Why?, shows a
    class's rule as a sentence with no link, and says when there is no
    plain reason.

BASIC IDEA
    api.ts is mocked; each test hands getWhy the reasons a server would
    give, and walks the disclosure open, then a nested one.

INPUTS / INPUT SOURCES
    - A mocked getWhy.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhyReason } from "../types";
import WhyDisclosure from "./WhyDisclosure";

const { getWhy } = vi.hoisted(() => ({ getWhy: vi.fn() }));
vi.mock("../api", () => ({ getWhy }));

const X = "http://example.org/shop#";
const T = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const MANAGER: WhyReason = {
  family: "defining",
  sentence: "Alice is a Person and Alice manages bob ..., and a Manager is exactly a Person that manages at least one Employee",
  premises: [
    { s: `${X}alice`, p: T, o: `${X}Person`, sentence: "Alice is a Person", inferred: true },
    { s: `${X}alice`, p: `${X}manages`, o: `${X}bob`, sentence: "Alice manages bob", inferred: false },
    {
      s: `${X}Manager`,
      p: "http://www.w3.org/2002/07/owl#equivalentClass",
      o: null,
      sentence: "a Manager is exactly a Person that manages at least one Employee",
      inferred: false,
    },
  ],
};

const PERSON: WhyReason = {
  family: "domainRange",
  sentence: "Alice works for Acme, and whoever works for something is a Person",
  premises: [
    { s: `${X}alice`, p: `${X}worksFor`, o: `${X}acme`, sentence: "Alice works for Acme", inferred: false },
    {
      s: `${X}worksFor`,
      p: "http://www.w3.org/2000/01/rdf-schema#domain",
      o: `${X}Person`,
      sentence: "whoever works for something is a Person",
      inferred: false,
    },
  ],
};

// Braced: a function returned from beforeEach is run as its cleanup.
beforeEach(() => {
  getWhy.mockReset();
});
afterEach(cleanup);

async function open(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("Why? (5.6)", () => {
  it("is a disclosure that asks for its reason only when first opened", async () => {
    getWhy.mockResolvedValue(MANAGER);
    const onSelect = vi.fn();
    render(
      <WhyDisclosure
        projectId="prj-1"
        fact={{ s: `${X}alice`, p: T, o: `${X}Manager` }}
        label="Alice is a Manager"
        onSelect={onSelect}
      />,
    );
    const button = screen.getByRole("button", { name: "Why? Alice is a Manager" });
    expect(button.textContent).toBe("Why?");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(getWhy).not.toHaveBeenCalled();
    await open(button);
    expect(getWhy).toHaveBeenCalledWith("prj-1", { s: `${X}alice`, p: T, o: `${X}Manager` });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(region).toBeTruthy();
    expect(within(region).getByText("Because:")).toBeTruthy();
    // Each premise marked in words; a rule is a sentence, stated, no Why?.
    const lines = within(region).getAllByRole("listitem");
    expect(lines.map((li) => li.querySelector(".why-mark")!.textContent)).toEqual(["inferred", "stated", "stated"]);
    expect(within(lines[1]).queryByRole("button", { name: /^Why\?/ })).toBeNull();
    expect(within(lines[2]).queryByRole("button", { name: /^Why\?/ })).toBeNull();
    // A premise's sentence selects its entity.
    fireEvent.click(within(lines[1]).getByRole("button", { name: "Alice manages bob" }));
    expect(onSelect).toHaveBeenCalledWith(`${X}alice`);
    // Closed and opened again: no second request.
    await open(button);
    await open(button);
    expect(getWhy).toHaveBeenCalledTimes(1);
  });

  it("gives an inferred premise its own Why?, walking back one step at a time", async () => {
    getWhy.mockImplementation(async (_pid: string, fact: { o: string }) => (fact.o === `${X}Manager` ? MANAGER : PERSON));
    render(<WhyDisclosure projectId="prj-1" fact={{ s: `${X}alice`, p: T, o: `${X}Manager` }} label="Alice is a Manager" />);
    await open(screen.getByRole("button", { name: "Why? Alice is a Manager" }));
    const nested = screen.getByRole("button", { name: "Why? Alice is a Person" });
    expect(nested.getAttribute("aria-expanded")).toBe("false");
    await open(nested);
    expect(getWhy).toHaveBeenLastCalledWith("prj-1", { s: `${X}alice`, p: T, o: `${X}Person` });
    const region = document.getElementById(nested.getAttribute("aria-controls")!)!;
    expect(within(region).getByText("Alice works for Acme")).toBeTruthy();
    expect(within(region).getByText("whoever works for something is a Person")).toBeTruthy();
  });

  it("says when there is no plain reason, and when a fact was stated", async () => {
    getWhy.mockResolvedValue({
      family: null,
      sentence: "Concluded by the reasoner (OWL 2 RL); Semantic Studio has no plain-words reason for this one.",
      premises: [],
    });
    render(<WhyDisclosure projectId="prj-1" fact={{ s: "a", p: "p", o: "b" }} label="a p b" />);
    await open(screen.getByRole("button", { name: "Why? a p b" }));
    expect(screen.getByText(/has no plain-words reason for this one/)).toBeTruthy();
    cleanup();
    getWhy.mockResolvedValue({ family: "stated", sentence: "Alice manages bob (stated).", premises: [] });
    render(<WhyDisclosure projectId="prj-1" fact={{ s: "a", p: "p", o: "b" }} label="a p b" />);
    await open(screen.getByRole("button", { name: "Why? a p b" }));
    expect(screen.getByText("Alice manages bob (stated).")).toBeTruthy();
  });

  it("says what went wrong when the reason cannot be read", async () => {
    getWhy.mockRejectedValue(new Error("That fact is not in the last result."));
    render(<WhyDisclosure projectId="prj-1" fact={{ s: "a", p: "p", o: "b" }} label="a p b" />);
    await open(screen.getByRole("button", { name: "Why? a p b" }));
    expect(screen.getByRole("alert").textContent).toBe("That fact is not in the last result.");
  });
});
