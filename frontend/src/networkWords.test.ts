/*
================================================================================
FILE: frontend/src/networkWords.test.ts
================================================================================

SUMMARY
    Every capability the broker knows has words, and an unknown one never
    reaches the screen by name (external-access Section 7), including the
    inherited keys backlog X-6 is about.

BASIC IDEA
    Pure functions, so no rendering. The list of capabilities is the one the
    backend's network_broker.CAPABILITIES carries; if a fifth is added there,
    this list and networkWords.ts change together.

INPUTS / INPUT SOURCES
    - networkWords.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { alwaysPhrase, outcomeLabel, purposeLabel, reachedTheSite } from "./networkWords";

const CAPABILITIES = ["ontology:fetch", "ontology:import", "jsonld:context", "sparql:service"];

describe("networkWords", () => {
  it("has words for every capability, none of them the capability's name", () => {
    for (const capability of CAPABILITIES) {
      expect(alwaysPhrase(capability)).not.toBe("this kind of connection");
      expect(purposeLabel(capability)).not.toBe("Other");
      expect(alwaysPhrase(capability)).not.toContain(":");
    }
  });

  it("falls back for unknown and inherited keys", () => {
    for (const key of ["shell:exec", "constructor", "toString", "__proto__"]) {
      expect(alwaysPhrase(key)).toBe("this kind of connection");
      expect(purposeLabel(key)).toBe("Other");
      expect(outcomeLabel(key)).toBe("Other");
    }
  });

  it("tells a request that reached the site from one that did not", () => {
    expect(reachedTheSite("ok")).toBe(true);
    expect(reachedTheSite("http-error")).toBe(true);
    for (const outcome of ["asked", "blocked", "offline", "refused", "failed"]) {
      expect(reachedTheSite(outcome)).toBe(false);
    }
  });
});
