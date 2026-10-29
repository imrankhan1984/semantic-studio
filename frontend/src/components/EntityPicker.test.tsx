// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/EntityPicker.test.tsx
================================================================================

SUMMARY
    The picker's reference terms (reference-ontologies 5.6, AC-7): search
    is asked with references on, a reference match reads ", from FOAF" with
    a visually hidden "(not imported)", and an imported match keeps its own
    wording.

BASIC IDEA
    api.ts is mocked: the server decides what is in use and in what order,
    so this checks what the picker asks and how it says what comes back.
    The option's text content is what a screen reader reads, hidden span
    included.

INPUTS / INPUT SOURCES
    - A mocked searchNodes.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EntityPicker from "./EntityPicker";

const { searchNodes } = vi.hoisted(() => ({ searchNodes: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  searchNodes,
}));

const FOAF = "http://xmlns.com/foaf/0.1/";

beforeEach(() => {
  vi.clearAllMocks();
  searchNodes.mockResolvedValue([
    { id: "http://example.org/staff#OrganDonor", label: "Organ donor", kind: "class", degree: 0 },
    { id: FOAF + "Agent", label: "Agent", kind: "class", degree: 0, importedFrom: "FOAF" },
    { id: FOAF + "Organization", label: "Organization", kind: "class", degree: 0, fromReference: "FOAF" },
  ]);
});
afterEach(cleanup);

function pick() {
  const onPick = vi.fn();
  render(
    <EntityPicker ontologyId="prj-0123456789ab-model" kind="class" label="Parent class" onPick={onPick} onCancel={() => {}} />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Parent class" }), { target: { value: "org" } });
  return onPick;
}

it("asks search for reference terms, in the merged view, of the kind wanted", async () => {
  pick();
  await waitFor(() => expect(searchNodes).toHaveBeenCalled());
  expect(searchNodes).toHaveBeenCalledWith("prj-0123456789ab-model", "org", true, "class", undefined, undefined, true);
});

it("says a reference term's source, with (not imported) for screen readers only", async () => {
  pick();
  const option = await screen.findByRole("option", { name: /Organization/ });
  expect(option.textContent).toBe("Organization, from FOAF (not imported)");
  const hidden = option.querySelector(".visually-hidden");
  expect(hidden?.textContent).toBe(" (not imported)");
  // The visible words are the imported match's, exactly.
  const imported = screen.getByRole("option", { name: /Agent/ });
  expect(imported.textContent).toBe("Agent, from FOAF");
  expect(imported.querySelector(".visually-hidden")).toBeNull();
  expect(screen.getByRole("option", { name: "Organ donor" }).textContent).toBe("Organ donor");
});

it("picks a reference term by its IRI", async () => {
  const onPick = pick();
  fireEvent.mouseDown(await screen.findByRole("option", { name: /Organization/ }));
  expect(onPick).toHaveBeenCalledWith(FOAF + "Organization", "Organization");
});

it("a mapping's imported-only picker does not offer a reference term", async () => {
  render(
    <EntityPicker
      ontologyId="prj-0123456789ab-model"
      kind="class"
      label="Maps to"
      importedOnly
      onPick={() => {}}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Maps to" }), { target: { value: "org" } });
  await screen.findByRole("option", { name: /Agent/ });
  expect(screen.queryByRole("option", { name: /Organization/ })).toBeNull();
});
