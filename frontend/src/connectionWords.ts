/*
================================================================================
FILE: frontend/src/connectionWords.ts
================================================================================

SUMMARY
    The Connection section's words and its two small rules (external-access
    5.5, Stage 4): what the section says about the system proxy, the
    certificates trusted and the certificate file; the proxy residual
    sentence; and how the fields' text becomes what a Save sends.

BASIC IDEA
    The same split as limitWords.ts: the component renders, this file says.
    The server is the one judge of a proxy host or port (network_broker.py's
    validate_connection), so nothing here refuses a value: a port's text is
    sent as a number when it is one and as typed when it is not, so the
    server can name the field. The bypass list is typed as one line of
    comma-separated names and stored as a list.

    The order of the fields is here too, so the first refused one takes focus
    on Save the same way every time.

INPUTS / INPUT SOURCES
    - The connection settings from GET /api/network/connection.
    - The text in the section's fields.

EXPECTED OUTPUT
    - Strings for the interface, and Save's payload.
================================================================================
*/

import type { NetworkConnection, ProxyMode, ProxyPair } from "./types";

/** The residual of D-070, said under the proxy choice (5.5 item 4). */
export const PROXY_RESIDUAL =
  "Through a proxy, Semantic Studio cannot see where a site really is; it still asks you before connecting to any new site.";

export const MODE_LABELS: Record<ProxyMode, string> = {
  system: "Use my system's proxy settings",
  none: "No proxy",
  manual: "Manual",
};

/** The three choices in the order shown, the default first. */
export const MODES: ProxyMode[] = ["system", "none", "manual"];

/** The fields a Save can refuse, in the order they are shown. */
export const FIELD_ORDER = ["httpsHost", "httpsPort", "httpHost", "httpPort", "noProxy"] as const;
export type ConnectionField = (typeof FIELD_ORDER)[number];

/** What *Use my system's proxy settings* finds, right now. */
export function systemProxyLine(systemProxy: string | null): string {
  return systemProxy
    ? `Your system's proxy is ${systemProxy}.`
    : "No system proxy found; connecting directly.";
}

/** Whose certificates are trusted (5.5 item 3). */
export function trustLine(trust: NetworkConnection["trust"]): string {
  return trust === "system"
    ? "Semantic Studio trusts the certificates your operating system trusts."
    : "Using Python's own certificate list.";
}

/** The certificate file, named with the first 12 characters of its SHA-256. */
export function certificateLine(caFile: NetworkConnection["caFile"]): string {
  return caFile
    ? `Also trusted: ${caFile.name} (SHA-256 ${caFile.sha256.slice(0, 12)}).`
    : "No certificate file added.";
}

/** A saved port, as the field shows it. */
export function portText(port: ProxyPair["port"]): string {
  return port === null || port === undefined ? "" : String(port);
}

/** A port field's text as a Save sends it: a number when it is one. */
export function portValue(text: string): number | string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** The bypass list as one line, and back. Empty entries are dropped. */
export function noProxyText(list: string[]): string {
  return list.join(", ");
}

export function noProxyList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The first refused field in the order shown, for focus. */
export function firstRefused(fields: Partial<Record<string, string>>): ConnectionField | null {
  return FIELD_ORDER.find((name) => fields[name]) ?? null;
}

/** The refused fields from a 422's detail, or null if it is not that shape. */
export function refusedFields(detail: unknown): Partial<Record<ConnectionField, string>> | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { code, fields } = detail as { code?: unknown; fields?: unknown };
  if (code !== "invalid_connection" || typeof fields !== "object" || fields === null) return null;
  const result: Partial<Record<ConnectionField, string>> = {};
  for (const name of FIELD_ORDER) {
    const sentence = (fields as Record<string, unknown>)[name];
    if (Object.prototype.hasOwnProperty.call(fields, name) && typeof sentence === "string") {
      result[name] = sentence;
    }
  }
  return result;
}
