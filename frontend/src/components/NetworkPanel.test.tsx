// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NetworkPanel.test.tsx
================================================================================

SUMMARY
    Tests for Network settings (external-access Stage 1): the offline switch
    and its announced state (AC-10), the remembered decisions and Revoke
    (AC-9), the recent connections in words (AC-13), the empty states, and
    Section 6's dialog behaviour (AC-35).

BASIC IDEA
    api.ts is mocked, following the component tests' pattern, so the panel is
    driven by fixed responses and every request it makes is a counted call.

INPUTS / INPUT SOURCES
    - NetworkPanel, with api.ts's network calls mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkActivity, NetworkPolicy } from "../types";
import NetworkPanel from "./NetworkPanel";

const { getNetworkPolicy, getNetworkActivity, setNetworkOffline, revokeNetworkGrant } =
  vi.hoisted(() => ({
    getNetworkPolicy: vi.fn(),
    getNetworkActivity: vi.fn(),
    setNetworkOffline: vi.fn(),
    revokeNetworkGrant: vi.fn(),
  }));

vi.mock("../api", () => ({
  getNetworkPolicy,
  getNetworkActivity,
  setNetworkOffline,
  revokeNetworkGrant,
}));

const POLICY: NetworkPolicy = {
  offline: false,
  grants: [
    {
      id: "grant-1",
      capability: "jsonld:context",
      host: "json-ld.org",
      decision: "allow",
      remember: true,
      grantedAt: "2026-09-27T10:00:00+00:00",
    },
    {
      id: "grant-2",
      capability: "ontology:fetch",
      host: "bad.example",
      decision: "block",
      remember: true,
      grantedAt: "2026-09-27T10:01:00+00:00",
    },
  ],
};

const ACTIVITY: NetworkActivity[] = [
  {
    time: "2026-09-27T10:02:00+00:00",
    capability: "jsonld:context",
    url: "https://json-ld.org/contexts/person.jsonld",
    host: "json-ld.org",
    outcome: "ok",
    status: 200,
    bytes: 1234,
    encrypted: true,
  },
  {
    time: "2026-09-27T10:01:00+00:00",
    capability: "ontology:fetch",
    url: "http://bad.example/x.ttl",
    host: "bad.example",
    outcome: "blocked",
    status: 0,
    bytes: 0,
    encrypted: false,
  },
];

// No auto-cleanup is configured (see AboutPanel.test.tsx), and every test
// here renders the same dialog.
afterEach(() => {
  cleanup();
});

async function renderPanel(policy = POLICY, activity = ACTIVITY) {
  getNetworkPolicy.mockResolvedValue(structuredClone(policy));
  getNetworkActivity.mockResolvedValue(structuredClone(activity));
  const onClose = vi.fn();
  await act(async () => {
    render(<NetworkPanel onClose={onClose} />);
  });
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NetworkPanel", () => {
  it("is a modal dialog named Network settings, focused on its heading", async () => {
    await renderPanel();
    expect(screen.getByRole("dialog", { name: "Network settings" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Network settings" }),
    );
    expect(getNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(getNetworkActivity).toHaveBeenCalledTimes(1);
  });

  it("the offline control is a switch that announces its state", async () => {
    setNetworkOffline.mockResolvedValue({ offline: true });
    await renderPanel();
    const toggle = screen.getByRole("switch", { name: "Work offline" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/^Online\./)).toBeTruthy();

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setNetworkOffline).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/^Offline\./)).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Working offline");
    // Never disabled while saving: a disabled focused control drops focus.
    expect(toggle.hasAttribute("disabled")).toBe(false);
  });

  it("lists remembered decisions in words, as a list", async () => {
    await renderPanel();
    const list = screen.getByRole("heading", { name: "Allowed and blocked sites" })
      .nextElementSibling as HTMLElement;
    expect(list.tagName).toBe("UL");
    expect(list.textContent).toContain("json-ld.org");
    expect(list.textContent).toContain("JSON-LD contexts");
    expect(list.textContent).toContain("Always allowed");
    expect(list.textContent).toContain("Blocked");
    expect(list.textContent).not.toContain("jsonld:context");
  });

  it("Revoke removes the decision, says so, and moves focus to the section", async () => {
    revokeNetworkGrant.mockResolvedValue({ revoked: "grant-2" });
    await renderPanel();
    const revoke = screen.getByRole("button", {
      name: "Revoke your decision for bad.example, Downloads",
    });
    await act(async () => {
      fireEvent.click(revoke);
    });
    expect(revokeNetworkGrant).toHaveBeenCalledWith("grant-2");
    expect(screen.queryByRole("button", { name: /bad\.example/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("bad.example");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Allowed and blocked sites" }),
    );
  });

  it("shows recent connections newest first, each outcome in words", async () => {
    await renderPanel();
    const list = screen.getByRole("heading", { name: "Recent connections" })
      .nextElementSibling as HTMLElement;
    expect(list.tagName).toBe("OL");
    const rows = [...list.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Downloaded");
    expect(rows[0].textContent).toContain("1,234 bytes");
    expect(rows[1].textContent).toContain("Blocked by you");
    expect(rows[1].textContent).toContain("not encrypted");
  });

  it("states the empty cases", async () => {
    await renderPanel({ offline: false, grants: [] }, []);
    expect(screen.getByText("No sites allowed yet.")).toBeTruthy();
    expect(screen.getByText("No connections yet.")).toBeTruthy();
  });

  it("Escape and the close control close it", async () => {
    const { onClose } = await renderPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close Network settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says nothing about proxies or certificates, which are a later stage", async () => {
    await renderPanel();
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toMatch(/proxy|certificate/i);
  });
});
