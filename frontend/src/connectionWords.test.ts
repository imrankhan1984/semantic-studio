/*
================================================================================
FILE: frontend/src/connectionWords.test.ts
================================================================================

SUMMARY
    Tests for connectionWords.ts (external-access 5.5, Stage 4): the
    sentences the Connection section says, the fields' text as a Save sends
    it, and which refused field takes focus.

BASIC IDEA
    Pure functions, so plain unit tests with no rendering.

INPUTS / INPUT SOURCES
    - connectionWords.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import {
  FIELD_ORDER,
  MODES,
  MODE_LABELS,
  certificateLine,
  firstRefused,
  noProxyList,
  noProxyText,
  portText,
  portValue,
  refusedFields,
  systemProxyLine,
  trustLine,
} from "./connectionWords";

describe("connectionWords", () => {
  it("offers the system proxy first, as the default", () => {
    expect(MODES[0]).toBe("system");
    expect(MODES.map((m) => MODE_LABELS[m])).toEqual([
      "Use my system's proxy settings",
      "No proxy",
      "Manual",
    ]);
  });

  it("says what the system offers, or that it connects directly", () => {
    expect(systemProxyLine(null)).toBe("No system proxy found; connecting directly.");
    expect(systemProxyLine("proxy.corp:9400")).toBe("Your system's proxy is proxy.corp:9400.");
  });

  it("says whose certificates are trusted", () => {
    expect(trustLine("system")).toContain("your operating system trusts");
    expect(trustLine("python")).toBe("Using Python's own certificate list.");
  });

  it("names the file with the first 12 characters of its SHA-256", () => {
    expect(certificateLine(null)).toBe("No certificate file added.");
    expect(certificateLine({ name: "Root.pem", sha256: "abcdef0123456789".repeat(4) })).toBe(
      "Also trusted: Root.pem (SHA-256 abcdef012345).",
    );
  });

  it("sends a port as a number when it is one, and as typed when it is not", () => {
    expect(portValue("9400")).toBe(9400);
    expect(portValue(" 80 ")).toBe(80);
    expect(portValue("")).toBeNull();
    expect(portValue("80a")).toBe("80a");
    expect(portValue("-1")).toBe("-1");
    expect(portText(null)).toBe("");
    expect(portText(9400)).toBe("9400");
  });

  it("reads the bypass list from one line and writes it back", () => {
    expect(noProxyList(" localhost, intranet.corp ,, ")).toEqual(["localhost", "intranet.corp"]);
    expect(noProxyList("")).toEqual([]);
    expect(noProxyText(["localhost", "127.0.0.1"])).toBe("localhost, 127.0.0.1");
  });

  it("focuses the first refused field in the order shown", () => {
    expect(firstRefused({ noProxy: "x", httpsPort: "y" })).toBe("httpsPort");
    expect(firstRefused({})).toBeNull();
    expect(FIELD_ORDER[0]).toBe("httpsHost");
  });

  it("reads a refusal's fields, and nothing else", () => {
    expect(refusedFields({ code: "invalid_connection", fields: { httpsHost: "a", other: "b" } })).toEqual({
      httpsHost: "a",
    });
    expect(refusedFields({ code: "something_else", fields: { httpsHost: "a" } })).toBeNull();
    expect(refusedFields("a sentence")).toBeNull();
    expect(refusedFields(null)).toBeNull();
    // An inherited key is not a field (X-6).
    expect(refusedFields({ code: "invalid_connection", fields: Object.create({ httpsHost: "x" }) })).toEqual({});
  });
});
