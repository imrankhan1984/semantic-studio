/*
================================================================================
FILE: frontend/src/loadWords.ts
================================================================================

SUMMARY
    What the Load dialog says while a load runs (load-progress 5.2): the step
    sentence, the shorter words the live region announces, the expected time
    for a large file, the two endings of a Cancel, and the load's id.

BASIC IDEA
    Pure, so every sentence in the spec's table is tested without rendering.
    A step is one of three: a file being sent (real bytes from the browser),
    a file being read (seconds, since rdflib reports no progress), or a web
    address being downloaded and read (seconds; the browser sees neither
    half). The seconds count from the moment the load started, which is what
    "so far" means to the person who started it.

    The expected time is the file's size at 2.5 MB a second, rounded up to
    the next 5 seconds, and only for a file over 5 MB: under that it would
    promise a number for something that is over before it is read. Past it
    the sentence says *Still reading*, never that something is wrong; the
    60 s timeout is what decides that, with its own message.

    The live region gets `stepAnnouncement`, which changes only when the
    step does, so it speaks each step once and never the seconds.

INPUTS / INPUT SOURCES
    - A LoadStep from the dialog: the file's name and size, bytes sent,
      seconds so far.

EXPECTED OUTPUT
    - Sentences, and newLoadId(), a UUID for one load.
================================================================================
*/

/** A megabyte as the server's caps count one (1024 × 1024 bytes). */
export const MB = 1024 * 1024;
/** How fast a file is read, for the expected time: 2.5 MB a second. */
export const READ_BYTES_PER_SECOND = 2.5 * MB;
/** The expected time is shown only for a file over this. */
export const EXPECTED_TIME_FROM = 5 * MB;

export type LoadStep =
  | { kind: "sending"; name: string; sent: number; total: number }
  | { kind: "reading"; name: string; size: number; elapsed: number }
  | { kind: "downloading"; elapsed: number };

/** Seconds a file this size often takes, or null at 5 MB and under. */
export function expectedSeconds(bytes: number): number | null {
  if (bytes <= EXPECTED_TIME_FROM) return null;
  return Math.ceil(bytes / READ_BYTES_PER_SECOND / 5) * 5;
}

/** A size in the unit `total` is written in: "12 of 35 MB", "0 of 2 KB".
 *  MB from 1 MB, with one decimal under 10; KB below, rounded up, so a
 *  small file is never "0 of 0 MB" (seen in the Chrome rows). */
export function amount(bytes: number, total: number = bytes): string {
  if (total < MB) return `${Math.ceil(bytes / 1024)}`;
  const mb = bytes / MB;
  return mb >= 10 ? `${Math.round(mb)}` : `${Math.round(mb * 10) / 10}`;
}

function unit(total: number): string {
  return total < MB ? "KB" : "MB";
}

/** "35 MB", "2 KB". */
export function sizeWords(bytes: number): string {
  return `${amount(bytes)} ${unit(bytes)}`;
}

function soFar(elapsed: number): string {
  return `${elapsed} ${elapsed === 1 ? "second" : "seconds"} so far`;
}

/** Past the expected time: the step reads *Still reading*. */
export function stillReading(step: LoadStep): boolean {
  if (step.kind !== "reading") return false;
  const expected = expectedSeconds(step.size);
  return expected !== null && step.elapsed > expected;
}

/** The sentence under the control the load started from. */
export function stepSentence(step: LoadStep): string {
  switch (step.kind) {
    case "sending":
      return `Sending ${step.name}: ${amount(step.sent, step.total)} of ${sizeWords(step.total)}.`;
    case "downloading":
      return `Downloading and reading: ${soFar(step.elapsed)}.`;
    case "reading": {
      if (stillReading(step)) return `Still reading: ${soFar(step.elapsed)}.`;
      const reading = `Reading ${step.name} (${sizeWords(step.size)}): ${soFar(step.elapsed)}.`;
      const expected = expectedSeconds(step.size);
      return expected === null ? reading : `${reading} Files this size often take about ${expected} seconds.`;
    }
  }
}

/** What the live region says: the step alone, never the seconds. */
export function stepAnnouncement(step: LoadStep): string {
  switch (step.kind) {
    case "sending":
      return `Sending ${step.name}`;
    case "downloading":
      return "Downloading and reading";
    case "reading":
      return stillReading(step) ? `Still reading ${step.name}` : `Reading ${step.name}`;
  }
}

/** The two endings of a Cancel, from the server's answer (5.3). */
export const STOPPED = "Stopped. Nothing was added to your library.";
export const TOO_LATE = "It had already finished, so it is in your library.";

/** A UUID for one load. `crypto.randomUUID` needs a secure context, which
 *  localhost is; the fallback writes the same version-4 shape by hand. */
export function newLoadId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
