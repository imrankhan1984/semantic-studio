// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/AddVocabularyDialog.test.tsx
================================================================================

SUMMARY
    Add a vocabulary… (vocabularies-and-ontologies 5.3, AC-3, AC-17): the
    tabs by arrow keys, Tab kept inside, Escape that closes or asks, the
    sentence in a polite live region, Add as one command with the prefix
    typed, the refusals, offline, and an approval open over the dialog
    having every key.

BASIC IDEA
    api.ts is mocked (inspectVocabulary, getNetworkPolicy, listOntologies,
    openProject, runCommand), as every component test does, and the project
    store opened on a fake project so Add runs through it.

INPUTS / INPUT SOURCES
    - AddVocabularyDialog, the project store, a mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per behaviour.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddVocabularyDialog from "./AddVocabularyDialog";
import { projectStore } from "../state/projectStore";
import type { BundledVocabulary, VocabularyInspection } from "../types";

const { inspectVocabulary, getNetworkPolicy, listOntologies, openProject, runCommand } = vi.hoisted(() => ({
  inspectVocabulary: vi.fn(),
  getNetworkPolicy: vi.fn(),
  listOntologies: vi.fn(),
  openProject: vi.fn(),
  runCommand: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, inspectVocabulary, getNetworkPolicy, listOntologies, openProject, runCommand };
});

const PID = "prj-0123456789ab";
const STATE = {
  doc: "model" as const, ontologyId: `${PID}-model`, revision: 2, dirty: false, canUndo: false,
  undoLabel: null, canRedo: false, redoLabel: null, triples: 10,
};
const BUNDLED: BundledVocabulary[] = [
  { id: "prov-o", iri: "http://www.w3.org/ns/prov-o", title: "PROV-O", prefix: "prov", description: "Provenance." },
  { id: "dcelements", iri: "http://purl.org/dc/elements/1.1/", title: "Dublin Core Elements 1.1", prefix: "dc", description: "Fifteen elements." },
];
const PROV: VocabularyInspection = {
  iri: "http://www.w3.org/ns/prov-o", title: "PROV-O", prefix: "prov", namespace: "http://www.w3.org/ns/prov#",
  statements: 1146, rules: 198, how: "imported", large: false, hosts: [],
  source: { kind: "bundled", name: "Bundled", fetchedAt: null },
  sentence: "PROV-O holds rules: 198 statements about hierarchies, domains and ranges. It will be imported, so the reasoner and the checks use them.",
  alreadyAdded: false,
};

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [inspectVocabulary, getNetworkPolicy, listOntologies, openProject, runCommand]) mock.mockReset();
  getNetworkPolicy.mockResolvedValue({ offline: false, grants: [] });
  listOntologies.mockResolvedValue([]);
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: "http://example.org/shop#", prefix: "shop",
      primaryLanguage: "en", languages: [], documents: [{ file: "model.ttl", role: "model" }], counts: {},
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

function open(props: Partial<Parameters<typeof AddVocabularyDialog>[0]> = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const onShowRow = vi.fn();
  const opener = document.createElement("button");
  opener.textContent = "Add a vocabulary…";
  document.body.appendChild(opener);
  opener.focus();
  const view = render(
    <AddVocabularyDialog projectId={PID} bundled={BUNDLED} onAdded={onAdded} onClose={onClose} onShowRow={onShowRow} {...props} />,
  );
  return { onAdded, onClose, onShowRow, opener, view };
}

describe("AddVocabularyDialog", () => {
  it("is a dialog that takes focus to its heading and gives it back on close", async () => {
    const { opener, view } = open();
    const dialog = screen.getByRole("dialog", { name: "Add a vocabulary" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Add a vocabulary" }));
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("moves between its tabs with the arrow keys, Home and End (ARIA tabs)", () => {
    open();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Bundled", "Your library", "File", "Web address"]);
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([tabs[0]]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Your library" }));
    expect(screen.getByRole("tab", { name: "Your library" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Web address" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Bundled" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Web address" }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(document.activeElement!.id);
  });

  it("keeps Tab inside", () => {
    open();
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close" });
    const last = within(dialog).getByRole("button", { name: /Dublin Core Elements 1.1/ });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("says what Add will write, in a polite live region, and Add runs one command (AC-3)", async () => {
    inspectVocabulary.mockResolvedValue(PROV);
    runCommand.mockResolvedValue({ revision: 3, label: "Added PROV-O", state: STATE });
    const { onAdded } = open();
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    expect(inspectVocabulary).toHaveBeenCalledWith(PID, { bundled: "prov-o" }, expect.any(AbortSignal));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(status.textContent).toBe(PROV.sentence));
    expect((screen.getByLabelText("Prefix") as HTMLInputElement).value).toBe("prov");
    fireEvent.click(screen.getByRole("button", { name: "Add PROV-O" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("http://www.w3.org/ns/prov-o"));
    expect(runCommand).toHaveBeenCalledWith(PID, "model", "AddVocabulary", { iri: "http://www.w3.org/ns/prov-o", prefix: "prov" });
    // The live region reads the sentence again with Added. in front.
    expect(projectStore.getSnapshot().announcement?.text ?? "").toContain(`Added. ${PROV.sentence}`);
  });

  it("sends a prefix typed in its field, and holds a bad one back", async () => {
    inspectVocabulary.mockResolvedValue(PROV);
    runCommand.mockResolvedValue({ revision: 3, label: "Added PROV-O", state: STATE });
    open();
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    const field = (await screen.findByLabelText("Prefix")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2bad" } });
    const add = screen.getByRole("button", { name: "Add PROV-O" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(add);
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "provo" } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith(PID, "model", "AddVocabulary", { iri: PROV.iri, prefix: "provo" }),
    );
  });

  it("shows the server's refusal of Add under the button", async () => {
    inspectVocabulary.mockResolvedValue(PROV);
    const { ApiError } = await import("../api");
    runCommand.mockRejectedValue(new ApiError("prov: already means http://example.org/p# in this model. Choose another prefix.", 422));
    open();
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add PROV-O" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already means http://example.org/p#");
  });

  it("offers Show in the list for a vocabulary already added", async () => {
    inspectVocabulary.mockResolvedValue({ ...PROV, alreadyAdded: true });
    const { onShowRow } = open();
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Show in the list" }));
    expect(onShowRow).toHaveBeenCalledWith(PROV.iri);
    expect(screen.queryByRole("button", { name: "Add PROV-O" })).toBeNull();
  });

  it("shows a file's parse sentence with its technical details folded, and no button (AC-11)", async () => {
    const { ApiError } = await import("../api");
    inspectVocabulary.mockRejectedValue(
      new ApiError("Line 2 of broken.ttl is not Turtle.", 422, { code: "parse_error", message: "Line 2 of broken.ttl is not Turtle.", technical: "raw rdflib text" }),
    );
    open({ initialTab: "file" });
    const input = screen.getByLabelText(/One RDF file/) as HTMLInputElement;
    const file = new File(["@prefix ex: <x> .\nex:A a ex:B"], "broken.ttl", { type: "text/turtle" });
    fireEvent.change(input, { target: { files: [file] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Line 2 of broken.ttl is not Turtle.");
    expect(within(alert).getByText("Technical details").closest("details")!.open).toBe(false);
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /^Add / })).toBeNull();
  });

  it("says it is offline on the Web address tab and reads nothing", async () => {
    getNetworkPolicy.mockResolvedValue({ offline: true, grants: [] });
    open({ initialTab: "web" });
    expect(
      await screen.findByText("Semantic Studio is offline. Turn it on in Settings → Network to add from an address."),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("https://example.org/vocabulary.ttl")).toBeNull();
    expect(inspectVocabulary).not.toHaveBeenCalled();
  });

  it("closes on Escape while nothing is read, and asks while a read is on its way", async () => {
    let finish: (v: VocabularyInspection) => void = () => {};
    inspectVocabulary.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    expect(screen.getByRole("status").textContent).toBe("Reading PROV-O…");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    const asked = screen.getByRole("group", { name: "Stop reading?" });
    fireEvent.click(within(asked).getByRole("button", { name: "Keep reading" }));
    await act(async () => finish(PROV));
    expect(screen.getByRole("status").textContent).toBe(PROV.sentence);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves every key to an approval open over it", () => {
    const { onClose } = open();
    const over = document.createElement("div");
    over.setAttribute("aria-modal", "true");
    document.body.appendChild(over);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    over.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("in a read-only document shows Add, aria-disabled, with the reason", async () => {
    inspectVocabulary.mockResolvedValue(PROV);
    open({ readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: /PROV-O/ }));
    const add = await screen.findByRole("button", { name: "Add PROV-O" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("This document is read-only.")).toBeTruthy();
    fireEvent.click(add);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
