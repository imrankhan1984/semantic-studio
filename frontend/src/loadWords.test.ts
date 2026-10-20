/*
================================================================================
FILE: frontend/src/loadWords.test.ts
================================================================================

SUMMARY
    The Load dialog's step words (load-progress 5.2): each row of the spec's
    table, the expected time and its rounding, *Still reading* past it, and
    the live region's words, which never carry the seconds.

BASIC IDEA
    Pure functions, called with the steps the dialog builds. The sizes are
    written in MB so each case reads as the spec's table does.

INPUTS / INPUT SOURCES
    - loadWords.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import {
  MB,
  expectedSeconds,
  amount,
  newLoadId,
  stepAnnouncement,
  stepSentence,
  type LoadStep,
} from "./loadWords";

const reading = (size: number, elapsed: number): LoadStep => ({
  kind: "reading",
  name: "big-file.ttl",
  size: size * MB,
  elapsed,
});

describe("the expected time", () => {
  it("is the size at 2.5 MB a second, rounded up to the next 5 seconds", () => {
    expect(expectedSeconds(35 * MB)).toBe(15); // 14 s
    expect(expectedSeconds(25 * MB)).toBe(10); // exactly 10 s
    expect(expectedSeconds(25 * MB + 1)).toBe(15);
    expect(expectedSeconds(50 * MB)).toBe(20);
  });

  it("is shown only for a file over 5 MB", () => {
    expect(expectedSeconds(5 * MB)).toBeNull();
    expect(expectedSeconds(1 * MB)).toBeNull();
    expect(expectedSeconds(5 * MB + 1)).toBe(5);
  });
});

describe("the step sentences (the spec's table)", () => {
  it("sending a file", () => {
    const step: LoadStep = { kind: "sending", name: "big-file.ttl", sent: 12 * MB, total: 35 * MB };
    expect(stepSentence(step)).toBe("Sending big-file.ttl: 12 of 35 MB.");
  });

  it("reading a file over 5 MB says the expected time", () => {
    expect(stepSentence(reading(35, 6))).toBe(
      "Reading big-file.ttl (35 MB): 6 seconds so far. Files this size often take about 15 seconds.",
    );
  });

  it("reading a small file says no expected time", () => {
    expect(stepSentence(reading(1.4, 1))).toBe("Reading big-file.ttl (1.4 MB): 1 second so far.");
  });

  it("a web address or a suggested entry", () => {
    expect(stepSentence({ kind: "downloading", elapsed: 6 })).toBe("Downloading and reading: 6 seconds so far.");
  });

  it("past the expected time: Still reading, never a claim that something is wrong", () => {
    expect(stepSentence(reading(35, 15))).toContain("Files this size often take about 15 seconds.");
    expect(stepSentence(reading(35, 16))).toBe("Still reading: 16 seconds so far.");
    expect(stepSentence(reading(35, 22))).toBe("Still reading: 22 seconds so far.");
  });

  it("writes a small size with one decimal and a large one whole", () => {
    expect(amount(1.44 * MB)).toBe("1.4");
    expect(amount(35.5 * MB)).toBe("36");
  });

  it("writes a file under 1 MB in KB, never 0 of 0 MB (found in the Chrome rows)", () => {
    expect(stepSentence({ kind: "sending", name: "small.ttl", sent: 0, total: 55 })).toBe(
      "Sending small.ttl: 0 of 1 KB.",
    );
    expect(stepSentence({ kind: "sending", name: "a.ttl", sent: 300 * 1024, total: 600 * 1024 })).toBe(
      "Sending a.ttl: 300 of 600 KB.",
    );
    expect(stepSentence({ kind: "reading", name: "small.ttl", size: 55, elapsed: 0 })).toBe(
      "Reading small.ttl (1 KB): 0 seconds so far.",
    );
  });
});

describe("what the live region says", () => {
  it("names the step and never the seconds", () => {
    const steps: LoadStep[] = [
      { kind: "sending", name: "big-file.ttl", sent: 1, total: 2 },
      reading(35, 3),
      reading(35, 22),
      { kind: "downloading", elapsed: 9 },
    ];
    expect(steps.map(stepAnnouncement)).toEqual([
      "Sending big-file.ttl",
      "Reading big-file.ttl",
      "Still reading big-file.ttl",
      "Downloading and reading",
    ]);
    for (const step of steps) expect(stepAnnouncement(step)).not.toMatch(/\d/);
  });

  it("is the same word for word from one second to the next", () => {
    expect(stepAnnouncement(reading(35, 3))).toBe(stepAnnouncement(reading(35, 4)));
    expect(stepAnnouncement({ kind: "downloading", elapsed: 1 })).toBe(
      stepAnnouncement({ kind: "downloading", elapsed: 2 }),
    );
  });
});

describe("the load id", () => {
  it("is a version-4 UUID, a new one each time", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = newLoadId();
    expect(a).toMatch(uuid);
    expect(newLoadId()).not.toBe(a);
  });

  it("has the same shape without crypto.randomUUID (no secure context)", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      for (let i = 0; i < 20; i++) expect(newLoadId()).toMatch(uuid);
    } finally {
      if (own) Object.defineProperty(crypto, "randomUUID", own);
      else delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
    expect(typeof crypto.randomUUID).toBe("function");
  });
});
