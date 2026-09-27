// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NetworkApprovalDialog.test.tsx
================================================================================

SUMMARY
    Tests for the approval dialog (external-access Stage 1): that it states
    what, where, why and what is sent in words; that it never shows a
    capability's own name; the two answers and two scopes; and Section 6's
    keyboard and screen-reader behaviour -- a dialog named by its heading,
    focus on the heading, a trapped Tab, Escape as Don't allow, and focus back
    where it was. Covers AC-7, AC-8 and AC-35 as the dialog sees them.

BASIC IDEA
    Rendered alone with a fixed request. jsdom has no sequential focus
    navigation, so the trap is tested the way AboutPanel.test.tsx tests its
    own: by dispatching Tab on the document with focus placed at an edge and
    asserting where the handler moved it.

INPUTS / INPUT SOURCES
    - NetworkApprovalDialog with a hand-built ApprovalRequest.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../types";
import NetworkApprovalDialog, { SERVICE_NOTHING_ELSE, WHY_EXPLAINED } from "./NetworkApprovalDialog";

const REQUEST: ApprovalRequest = {
  capability: "jsonld:context",
  host: "json-ld.org",
  url: "https://json-ld.org/contexts/person.jsonld",
  reason: "The file you are opening defines its terms in a JSON-LD context published on this site.",
  sends: "A download request for the context. Nothing from your file or library.",
  encrypted: true,
};

// No auto-cleanup is configured (see AboutPanel.test.tsx), and every test
// here renders the same dialog.
afterEach(() => {
  cleanup();
});

function renderDialog(request: ApprovalRequest = REQUEST) {
  const onAnswer = vi.fn();
  const view = render(<NetworkApprovalDialog requests={[request]} onAnswer={onAnswer} />);
  return { onAnswer, ...view };
}

describe("NetworkApprovalDialog", () => {
  it("is a modal dialog named by its heading, which takes focus", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Allow a connection to json-ld.org?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
  });

  it("says why, what is sent and what the site sees, in words", () => {
    renderDialog();
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain(REQUEST.reason);
    expect(text).toContain(REQUEST.sends);
    expect(text).toContain("Your internet address");
    expect(text).toContain(REQUEST.url);
    // Section 7: capability names are the server's words, never the user's.
    expect(text).not.toContain("jsonld:context");
    expect(screen.getByLabelText("Always, for loading JSON-LD contexts from this site")).toBeTruthy();
  });

  it("explains itself behind a disclosure", () => {
    renderDialog();
    expect(screen.getByText("Why am I seeing this?").tagName).toBe("SUMMARY");
    for (const sentence of WHY_EXPLAINED) expect(screen.getByText(sentence)).toBeTruthy();
  });

  it("labels an unencrypted address, and only then", () => {
    const { unmount } = renderDialog();
    expect(screen.queryByText("Encryption")).toBeNull();
    unmount();
    renderDialog({ ...REQUEST, url: "http://xmlns.com/foaf/0.1/", encrypted: false });
    expect(screen.getByText("Encryption")).toBeTruthy();
    expect(screen.getByText(/starts with http:\/\//)).toBeTruthy();
  });

  it("offers the scope as a named radio group with Always preselected", () => {
    renderDialog();
    const group = screen.getByRole("group", { name: "How long should this answer last?" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(group.contains(radio)).toBe(true);
    expect((screen.getByLabelText("Just this time") as HTMLInputElement).checked).toBe(false);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    // Native radios share a name, which is what gives them arrow-key movement.
    expect(new Set(radios.map((r) => r.getAttribute("name"))).size).toBe(1);
  });

  it("reports each answer with its scope", () => {
    const { onAnswer } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true, true);
    fireEvent.click(screen.getByLabelText("Just this time"));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true, false);
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith(false, false);
  });

  it("says that Always applies to a refusal too", () => {
    renderDialog();
    expect(screen.getByText(/Always applies to Don't allow too/)).toBeTruthy();
  });

  it("Escape and the backdrop mean Don't allow, just this time", () => {
    const { onAnswer } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onAnswer).toHaveBeenLastCalledWith(false, false);
    const backdrop = document.querySelector(".approval-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith(false, false);
  });

  it("keeps the backdrop beside the dialog, hidden from assistive technology", () => {
    renderDialog();
    const backdrop = document.querySelector(".approval-backdrop") as HTMLElement;
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.contains(screen.getByRole("dialog"))).toBe(false);
  });

  it("traps Tab inside the dialog at both edges", () => {
    renderDialog();
    const summary = screen.getByText("Why am I seeing this?");
    const allow = screen.getByRole("button", { name: "Allow" });
    allow.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(summary);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(allow);
    // From outside the dialog, Tab is pulled back in.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(summary);
  });

  it("gives focus back to what held it when the question appeared", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderDialog();
    expect(document.activeElement).not.toBe(trigger);
    act(() => unmount());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("falls back to generic words for a capability it does not know", () => {
    renderDialog({ ...REQUEST, capability: "constructor" as never });
    expect(screen.getByLabelText("Always, for this kind of connection from this site")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toContain("constructor");
  });

  describe("SPARQL SERVICE (external-access Stage 3, AC-27)", () => {
    const TEXT = "PREFIX ex: <http://example.org/>\nSELECT * WHERE {\n  ?s ex:name ?n\n}";
    const SERVICE: ApprovalRequest = {
      capability: "sparql:service",
      host: "query.wikidata.org",
      url: "https://query.wikidata.org/sparql",
      reason: "Your query asks this site to answer part of it.",
      sends: "The query text shown. Nothing else from your ontology.",
      encrypted: true,
      text: TEXT,
    };

    it("shows the exact text that will be sent, read-only, and says nothing else goes", () => {
      renderDialog(SERVICE);
      const box = screen.getByRole("textbox", { name: "Query text sent" }) as HTMLTextAreaElement;
      expect(box.value).toBe(TEXT);
      expect(box.readOnly).toBe(true);
      expect(screen.getByText(SERVICE_NOTHING_ELSE)).toBeTruthy();
      expect(screen.getByLabelText("Always, for running SPARQL queries from this site")).toBeTruthy();
      expect(screen.getByRole("dialog").textContent).not.toContain("sparql:service");
    });

    it("gives each block its own box, named by its endpoint, and asks about each host once", () => {
      const second = { ...SERVICE, url: "https://dbpedia.org/sparql", host: "dbpedia.org", text: "SELECT * WHERE {\n  ?a ?b ?c\n}" };
      render(<NetworkApprovalDialog requests={[SERVICE, second]} onAnswer={vi.fn()} />);
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
        "Allow connections to query.wikidata.org, dbpedia.org?",
      );
      const boxes = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
      expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Query text sent to https://query.wikidata.org/sparql",
        "Query text sent to https://dbpedia.org/sparql",
      ]);
      expect(boxes.map((b) => b.value)).toEqual([TEXT, second.text]);
    });

    it("a download question keeps its plain sentence and has no text box", () => {
      renderDialog();
      expect(screen.queryByRole("textbox")).toBeNull();
    });
  });
});
