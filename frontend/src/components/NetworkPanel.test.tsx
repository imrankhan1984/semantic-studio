// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/NetworkPanel.test.tsx
================================================================================

SUMMARY
    Tests for Network settings (external-access Stage 1): the offline switch
    and its announced state (AC-10), the remembered decisions and Revoke
    (AC-9), the recent connections in words (AC-13) and the empty states.
    And its Connection section (Stage 4, 5.5): the proxy choice and Save,
    a refused field's sentence and focus (AC-44), the certificate file chosen,
    refused and removed (AC-45), and Test connection's live region, each
    reached from the keyboard and said in text (AC-47).
    The panel is Settings' Network tab since home-and-settings 5.4; the dialog
    around it, Section 6's behaviour (AC-35), is SettingsDialog.test.tsx's.

BASIC IDEA
    api.ts is mocked, following the component tests' pattern, so the panel is
    driven by fixed responses and every request it makes is a counted call.
    ApiError is the real class, so a refusal carries its detail as it would.

    jsdom has no sequential focus navigation, so "reached with Tab" is
    asserted as what makes it true: a native control, in document order,
    not removed from the tab order. The radio group's arrow keys are the
    browser's own behaviour for radios sharing a name, which is asserted.

INPUTS / INPUT SOURCES
    - NetworkPanel, with api.ts's network calls mocked.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkActivity, NetworkConnection, NetworkPolicy } from "../types";
import NetworkPanel from "./NetworkPanel";

const {
  getNetworkPolicy,
  getNetworkActivity,
  setNetworkOffline,
  revokeNetworkGrant,
  getNetworkConnection,
  saveNetworkConnection,
  uploadNetworkCertificate,
  removeNetworkCertificate,
  testNetworkConnection,
} = vi.hoisted(() => ({
  getNetworkPolicy: vi.fn(),
  getNetworkActivity: vi.fn(),
  setNetworkOffline: vi.fn(),
  revokeNetworkGrant: vi.fn(),
  getNetworkConnection: vi.fn(),
  saveNetworkConnection: vi.fn(),
  uploadNetworkCertificate: vi.fn(),
  removeNetworkCertificate: vi.fn(),
  testNetworkConnection: vi.fn(),
}));

vi.mock("../api", async () => ({
  ApiError: (await vi.importActual<typeof import("../api")>("../api")).ApiError,
  getNetworkPolicy,
  getNetworkActivity,
  setNetworkOffline,
  revokeNetworkGrant,
  getNetworkConnection,
  saveNetworkConnection,
  uploadNetworkCertificate,
  removeNetworkCertificate,
  testNetworkConnection,
}));

const { ApiError } = await vi.importActual<typeof import("../api")>("../api");

const CONNECTION: NetworkConnection = {
  mode: "system",
  https: { host: "", port: null },
  http: { host: "", port: null },
  noProxy: ["localhost", "127.0.0.1"],
  caFile: null,
  systemProxy: null,
  trust: "system",
};

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

async function renderPanel(policy = POLICY, activity = ACTIVITY, connection = CONNECTION) {
  getNetworkPolicy.mockResolvedValue(structuredClone(policy));
  getNetworkActivity.mockResolvedValue(structuredClone(activity));
  getNetworkConnection.mockResolvedValue(structuredClone(connection));
  let container!: HTMLElement;
  await act(async () => {
    container = render(<NetworkPanel />).container;
  });
  return { container };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The panel's own announcements; the Connection section has two more live
// regions of its own.
function panelStatus(container: HTMLElement): HTMLElement {
  return container.querySelector(".network-settings > [role=status]") as HTMLElement;
}

function connectionStatus(): HTMLElement {
  return document.querySelector(".network-section > .visually-hidden[role=status]") as HTMLElement;
}

describe("NetworkPanel", () => {
  it("is the tab's body, not a dialog of its own, and asks once for each list", async () => {
    await renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Connections" })).toBeTruthy();
    expect(getNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(getNetworkActivity).toHaveBeenCalledTimes(1);
    expect(getNetworkConnection).toHaveBeenCalledTimes(1);
  });

  it("the offline control is a switch that announces its state", async () => {
    setNetworkOffline.mockResolvedValue({ offline: true });
    const { container } = await renderPanel();
    const toggle = screen.getByRole("switch", { name: "Work offline" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/^Online\./)).toBeTruthy();

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setNetworkOffline).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/^Offline\./)).toBeTruthy();
    const status = panelStatus(container);
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
    const { container } = await renderPanel();
    const revoke = screen.getByRole("button", {
      name: "Revoke your decision for bad.example, Downloads",
    });
    await act(async () => {
      fireEvent.click(revoke);
    });
    expect(revokeNetworkGrant).toHaveBeenCalledWith("grant-2");
    expect(screen.queryByRole("button", { name: /bad\.example/ })).toBeNull();
    expect(panelStatus(container).textContent).toContain("bad.example");
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

});

describe("NetworkPanel, Connection (Stage 4)", () => {
  function section(): HTMLElement {
    return screen.getByRole("heading", { level: 3, name: "Connection" }).closest("section") as HTMLElement;
  }

  it("stands between Work offline and the sites, the system proxy chosen by default", async () => {
    await renderPanel();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Connections", "Connection", "Allowed and blocked sites", "Recent connections"]);
    const group = screen.getByRole("group", { name: "Proxy" });
    const radios = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      "Use my system's proxy settings",
      "No proxy",
      "Manual",
    ]);
    expect(radios[0].checked).toBe(true);
    // One name: the browser moves between them with the arrow keys.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.every((r) => r.tabIndex !== -1)).toBe(true);
    expect(section().textContent).toContain("No system proxy found; connecting directly.");
    expect(section().textContent).toContain("cannot see where a site really is");
    expect(section().textContent).toContain("trusts the certificates your operating system trusts");
  });

  it("names the system proxy it found, and says when Python's own list is used", async () => {
    await renderPanel(POLICY, ACTIVITY, { ...CONNECTION, systemProxy: "proxy.corp:9400", trust: "python" });
    expect(section().textContent).toContain("Your system's proxy is proxy.corp:9400.");
    expect(section().textContent).toContain("Using Python's own certificate list.");
  });

  it("Manual shows labelled fields, and Save sends what was typed", async () => {
    saveNetworkConnection.mockResolvedValue({
      ...CONNECTION,
      mode: "manual",
      https: { host: "proxy.corp", port: 9400 },
      noProxy: ["localhost", "intranet.corp"],
    });
    await renderPanel();
    expect(screen.queryByLabelText("HTTPS proxy host")).toBeNull();
    fireEvent.click(screen.getByLabelText("Manual"));
    fireEvent.change(screen.getByLabelText("HTTPS proxy host"), { target: { value: " proxy.corp " } });
    // Each port names its proxy for a screen reader; the eye reads the row.
    expect(screen.getByLabelText("HTTP proxy Port")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("HTTPS proxy Port"), { target: { value: "9400" } });
    fireEvent.change(screen.getByLabelText("Don't use the proxy for"), {
      target: { value: "localhost, intranet.corp," },
    });
    // Nothing is sent until Save.
    expect(saveNetworkConnection).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save proxy settings" }));
    });
    expect(saveNetworkConnection).toHaveBeenCalledWith({
      mode: "manual",
      https: { host: "proxy.corp", port: 9400 },
      http: { host: "", port: null },
      noProxy: ["localhost", "intranet.corp"],
    });
    expect(connectionStatus().textContent).toBe("Saved. Manual.");
    expect(connectionStatus().getAttribute("aria-live")).toBe("polite");
  });

  it("a refused field says why beside it, is described by it, and takes focus (AC-44)", async () => {
    saveNetworkConnection.mockRejectedValue(
      new ApiError("The connection settings were not saved.", 422, {
        code: "invalid_connection",
        message: "The connection settings were not saved.",
        fields: {
          httpsPort: "Enter a port from 1 to 65535.",
          noProxy: "\u201cnot a host\u201d is not a host name. Separate host names with commas.",
        },
      }),
    );
    await renderPanel();
    fireEvent.click(screen.getByLabelText("Manual"));
    fireEvent.change(screen.getByLabelText("HTTPS proxy host"), { target: { value: "proxy.corp" } });
    fireEvent.change(screen.getByLabelText("HTTPS proxy Port"), { target: { value: "70000" } });
    const save = screen.getByRole("button", { name: "Save proxy settings" });
    save.focus();
    await act(async () => {
      fireEvent.click(save);
    });
    const port = screen.getByLabelText("HTTPS proxy Port");
    expect(port.getAttribute("aria-invalid")).toBe("true");
    const described = (port.getAttribute("aria-describedby") ?? "").split(" ");
    const sentence = described.map((id) => document.getElementById(id)?.textContent);
    expect(sentence).toContain("Enter a port from 1 to 65535.");
    // The first refused field in the order shown, not the last.
    expect(document.activeElement).toBe(port);
    expect(screen.getByLabelText("Don't use the proxy for").getAttribute("aria-invalid")).toBe("true");
    expect(connectionStatus().textContent).toContain("Not saved");
    // The value typed is kept for correcting, as typed.
    expect((port as HTMLInputElement).value).toBe("70000");
    expect(saveNetworkConnection).toHaveBeenCalledWith(
      expect.objectContaining({ https: { host: "proxy.corp", port: 70000 } }),
    );
  });

  it("Choose a file opens the browser's picker, and a chosen file is named (AC-45)", async () => {
    uploadNetworkCertificate.mockResolvedValue({
      ...CONNECTION,
      caFile: { name: "ZscalerRootCA.pem", sha256: "0123456789abcdef".repeat(4) },
    });
    await renderPanel();
    const picker = screen.getByTestId("network-ca-file") as HTMLInputElement;
    expect(picker.hidden).toBe(true);
    expect(picker.accept).toBe(".pem,.crt,.cer");
    const click = vi.spyOn(picker, "click");
    const choose = screen.getByRole("button", { name: "Choose a file…" });
    expect(choose.tagName).toBe("BUTTON");
    fireEvent.click(choose);
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(["-----BEGIN CERTIFICATE-----"], "ZscalerRootCA.pem");
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file] } });
    });
    expect(uploadNetworkCertificate).toHaveBeenCalledWith(file);
    expect(section().textContent).toContain("Also trusted: ZscalerRootCA.pem (SHA-256 0123456789ab).");
    expect(connectionStatus().textContent).toContain("Added ZscalerRootCA.pem");
  });

  it("a refused file says why under the button and is described by it", async () => {
    uploadNetworkCertificate.mockRejectedValue(
      new ApiError("That file contains a private key, which has no place among trusted certificates.", 422),
    );
    await renderPanel();
    await act(async () => {
      fireEvent.change(screen.getByTestId("network-ca-file"), {
        target: { files: [new File(["x"], "bundle.pem")] },
      });
    });
    const choose = screen.getByRole("button", { name: "Choose a file…" });
    const ids = (choose.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain("private key");
    expect(section().textContent).toContain("No certificate file added.");
  });

  it("Remove forgets the file and gives focus back to Choose a file", async () => {
    removeNetworkCertificate.mockResolvedValue(CONNECTION);
    await renderPanel(POLICY, ACTIVITY, {
      ...CONNECTION,
      caFile: { name: "ZscalerRootCA.pem", sha256: "f".repeat(64) },
    });
    const remove = screen.getByRole("button", { name: "Remove the certificate file ZscalerRootCA.pem" });
    remove.focus();
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(removeNetworkCertificate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Remove the certificate file/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose a file…" }));
    expect(connectionStatus().textContent).toContain("Only your system's certificates are trusted.");
  });

  it("Test connection says its answer in a polite live region", async () => {
    testNetworkConnection.mockResolvedValue({
      ok: false,
      stage: "tls",
      message: "The site's certificate was not trusted. Ask IT for the company's root certificate file and add it here.",
    });
    await renderPanel();
    const test = screen.getByRole("button", { name: "Test connection" });
    await act(async () => {
      fireEvent.click(test);
    });
    const region = section().querySelector(".network-test-result") as HTMLElement;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toContain("certificate was not trusted");
    // aria-disabled while it runs, never disabled: focus stays on the button.
    expect(test.hasAttribute("disabled")).toBe(false);
  });

  it("No proxy says so, and drops the residual sentence", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("No proxy"));
    expect(section().textContent).toContain("connects to each site directly");
    expect(section().textContent).not.toContain("cannot see where a site really is");
  });
});
