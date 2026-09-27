/*
================================================================================
FILE: frontend/src/networkWords.ts
================================================================================

SUMMARY
    The plain-language words for the network broker's capabilities and log
    outcomes, shared by the approval dialog and the Network panel.

BASIC IDEA
    Capability names such as `jsonld:context` are the server's vocabulary and
    are never shown to the user (external-access Section 7). Each has a phrase
    that completes "Always, for ... from this site" and a short purpose for the
    panel's list. Kept out of the components, like removalPrompt.ts, so the
    rule "every capability has words" is testable without rendering, and so
    the dialog and the panel cannot describe one capability two ways.

    An unknown capability or outcome falls back to a generic phrase rather than
    being printed, because the value came from the server's JSON and the rule
    is that capability names are not shown. The lookup is an own-property check
    rather than `in` or a bare index, so a key such as `constructor` falls through to the fallback
    instead of returning an inherited function (backlog X-6).

INPUTS / INPUT SOURCES
    - Capability and outcome strings from the API.

EXPECTED OUTPUT
    - Strings for the interface.
================================================================================
*/

const PHRASES: Record<string, { always: string; purpose: string }> = {
  "ontology:fetch": { always: "downloading ontologies", purpose: "Downloads" },
  "ontology:import": { always: "importing ontologies", purpose: "Imports" },
  "jsonld:context": { always: "loading JSON-LD contexts", purpose: "JSON-LD contexts" },
  "sparql:service": { always: "running SPARQL queries", purpose: "SPARQL queries" },
};

const OUTCOMES: Record<string, string> = {
  ok: "Downloaded",
  "http-error": "Server error",
  redirect: "Redirected",
  failed: "Could not connect",
  refused: "Refused: not a public address",
  blocked: "Blocked by you",
  asked: "Asked you first",
  offline: "Offline: not sent",
  "too-large": "Too large: stopped",
};

function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Completes "Always, for ___ from this site". */
export function alwaysPhrase(capability: string): string {
  return lookup(PHRASES, capability)?.always ?? "this kind of connection";
}

/** A short name for what a remembered decision covers. */
export function purposeLabel(capability: string): string {
  return lookup(PHRASES, capability)?.purpose ?? "Other";
}

/** What happened to one logged request, in words. */
export function outcomeLabel(outcome: string): string {
  return lookup(OUTCOMES, outcome) ?? "Other";
}

/** True only for a request that reached the site and came back. */
export function reachedTheSite(outcome: string): boolean {
  return outcome === "ok" || outcome === "http-error" || outcome === "redirect" || outcome === "too-large";
}
