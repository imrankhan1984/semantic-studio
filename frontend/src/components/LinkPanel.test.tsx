/*
================================================================================
FILE: frontend/src/components/LinkPanel.test.tsx
================================================================================

SUMMARY
    The link panel (relationships 5.2, AC-3, R14): a subclass or broader
    line read as its sentence, Remove this link as one command, the busy
    state, a refusal said in place, and both ends selectable.

BASIC IDEA
    Rendered alone over an open project store, with api.ts mocked, as the
    other form tests do.

INPUTS / INPUT SOURCES
    - A mocked api.ts (openProject, runCommand).

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import LinkPanel from "./LinkPanel";

const { openProject, runCommand } = vi.hoisted(() => ({ openProject: vi.fn(), runCommand: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, runCommand };
});

const EX = "http://example.org/shop#";
const PID = "prj-0123456789ab";
const STATE = {
  doc: "model" as const,
  ontologyId: `${PID}-model`,
  revision: 2,
  dirty: true,
  canUndo: true,
  undoLabel: "x",
  canRedo: false,
  redoLabel: null,
  triples: 10,
};

const SUBCLASS = {
  kind: "subClassOf" as const,
  source: EX + "Employee",
  target: EX + "Person",
  sourceLabel: "Employee",
  targetLabel: "Person",
};

beforeEach(async () => {
  projectStore._reset();
  openProject.mockReset();
  runCommand.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "shop",
      primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {}, kind: "ontology",
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
});

afterEach(() => {
  cleanup();
  projectStore._reset();
});

describe("LinkPanel", () => {
  it("reads a subclass line as its sentence, named by it", () => {
    render(<LinkPanel link={SUBCLASS} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "Employee is a kind of Person" })).toBeTruthy();
  });

  it("reads a broader line the same way", () => {
    render(
      <LinkPanel
        link={{ kind: "broader", source: EX + "Apple", target: EX + "Fruit", sourceLabel: "Apple", targetLabel: "Fruit" }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Apple is narrower than Fruit" })).toBeTruthy();
  });

  it("removes the link with one command, then closes", async () => {
    runCommand.mockResolvedValue({ revision: 3, label: "Removed", state: STATE });
    const onClose = vi.fn();
    render(<LinkPanel link={SUBCLASS} onSelect={vi.fn()} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove this link" }));
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0].slice(2)).toEqual(["RemoveSubClassOf", { child: EX + "Employee", parent: EX + "Person" }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("says Removing… while the command runs, and a refusal in place", async () => {
    let fail!: (e: Error) => void;
    runCommand.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const onClose = vi.fn();
    render(<LinkPanel link={SUBCLASS} onSelect={vi.fn()} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove this link" }));
    });
    const busy = screen.getByRole("button", { name: "Removing…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    await act(async () => fail(new Error("Employee is not a subclass of Person.")));
    expect(screen.getByRole("alert").textContent).toBe("Employee is not a subclass of Person.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("selects either end", () => {
    const onSelect = vi.fn();
    render(<LinkPanel link={SUBCLASS} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Employee" }));
    fireEvent.click(screen.getByRole("button", { name: "Person" }));
    expect(onSelect.mock.calls).toEqual([[EX + "Employee"], [EX + "Person"]]);
  });

  it("a link with an end of the project's other kind says why, and offers no Remove (review)", () => {
    const reason = "Apple is a SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.";
    render(
      <LinkPanel
        link={{ kind: "broader", source: EX + "Apple", target: EX + "Fruit", sourceLabel: "Apple", targetLabel: "Fruit", readOnly: reason }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove this link" })).toBeNull();
  });
});
