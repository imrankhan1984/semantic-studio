/*
================================================================================
FILE: frontend/src/removalPrompt.test.ts
================================================================================

SUMMARY
    Tests the confirmation sentence shown before an ontology is removed: the
    singular, the plural, the unchanged wording when nothing extra is at stake,
    and the cautious wording when the count could not be fetched.

BASIC IDEA
    removalPrompt is a pure function, which is the reason it is a module rather
    than a closure inside App. No rendering, no jsdom, no mocks — the wording
    that decides whether a user loses an afternoon of work is asserted directly.

    The assertion that matters most is that null and 0 produce different
    sentences. Both are falsy, so any check written as `if (!count)` would pass
    every other test in this file while turning a failed request into a
    reassurance.

INPUTS / INPUT SOURCES
    - Hand-written names and counts.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-6 to AC-10 of
      saved-query-deletion-warning.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { removalConfirmation, removalPrompt } from "./removalPrompt";

/** The exact sentence the dialog used before this feature existed. */
const UNCHANGED =
  "Remove “FIBO” and delete its stored copy? It will no longer appear after a restart.";

describe("removalPrompt", () => {
  it("names one saved query in the singular", () => {
    // AC-6. "1 saved queries" is the sort of thing a user reads as a bug in
    // the application, in a sentence that is asking them to trust it.
    const text = removalPrompt("FIBO", 1, ["Bonds by issuer"]);

    expect(text).toContain("1 saved query");
    expect(text).not.toContain("1 saved queries");
    expect(text).toContain("cannot be undone");
  });

  it("names several saved queries in the plural with a digit", () => {
    // AC-7. Seven is above the naming limit, so it states a count.
    const text = removalPrompt("FIBO", 7);

    expect(text).toContain("7 saved queries");
    expect(text).not.toContain("seven");
    expect(text).toContain("cannot be undone");
  });

  it("lists the names when there are no more than three", () => {
    // Section 15's second closed question: the number answers "how much", the
    // names answer the question the user actually has, which is "which ones".
    const text = removalPrompt("FIBO", 2, ["Bonds by issuer", "All jurisdictions"]);

    expect(text).toContain("2 saved queries");
    expect(text).toContain("“Bonds by issuer”");
    expect(text).toContain("“All jurisdictions”");
  });

  it("falls back to a bare count above three names", () => {
    // Four names in an unformatted native dialog is a paragraph, not a prompt.
    const names = ["One", "Two", "Three", "Four"];
    const text = removalPrompt("FIBO", 4, names);

    expect(text).toContain("4 saved queries");
    for (const name of names) expect(text).not.toContain(`“${name}”`);
  });

  it("keeps the original wording when there are none", () => {
    // AC-8. The case that decides whether the warning works at all: a warning
    // shown every time is a warning nobody reads.
    expect(removalPrompt("FIBO", 0)).toBe(UNCHANGED);
    expect(removalPrompt("FIBO", 0)).not.toContain("quer");
  });

  it("uses cautious wording when the count is null", () => {
    // AC-9. Unknown means warn about queries without inventing a number.
    const text = removalPrompt("FIBO", null);

    expect(text).toContain("any queries saved against it");
    expect(text).toContain("cannot be undone");
    expect(text).not.toMatch(/\d/);
  });

  it("does not treat null as zero", () => {
    // AC-9's real assertion. null and 0 are both falsy, so a `!count` check
    // would silently promise a user with unknown saved queries that they have
    // none. This is the single most likely way to get this feature wrong.
    expect(removalPrompt("FIBO", null)).not.toBe(removalPrompt("FIBO", 0));
    expect(removalPrompt("FIBO", null)).not.toBe(UNCHANGED);
  });

  it("includes the ontology name verbatim", () => {
    // AC-10. Names come from uploaded filenames, so they are arbitrary text
    // and must survive interpolation untouched in every branch.
    const odd = 'weird "name" <ont> & co';
    for (const count of [0, 1, 5, null]) {
      expect(removalPrompt(odd, count), `count ${count}`).toContain(odd);
    }
  });
});

describe("removalConfirmation", () => {
  it("reports the ontology and the number of queries taken with it", () => {
    expect(removalConfirmation("FIBO", 7)).toBe("Removed FIBO and 7 saved queries.");
    expect(removalConfirmation("FIBO", 1)).toBe("Removed FIBO and 1 saved query.");
  });

  it("says nothing when no queries were deleted", () => {
    // AC-16. The ontology visibly disappeared; announcing that it did is noise.
    expect(removalConfirmation("FIBO", 0)).toBeNull();
  });
});
