/*
================================================================================
FILE: frontend/src/removalPrompt.ts
================================================================================

SUMMARY
    Builds the sentence shown in the confirmation dialog before an ontology is
    removed. It is a pure function of the ontology's name, the number of queries
    saved against it, and their names. And the removal dialog's other words
    (wording-and-query-export 5.11): its heading, the Download button in its
    three states, what the live region says once the file is saved, and the
    sentence for a download that failed.

BASIC IDEA
    Removing an ontology also deletes every query saved against it, and the
    sentence the user used to agree to described only a file. This module is the
    whole of that fix: the three-way wording choice, in one testable place.

    The count is `number | null`, and the distinction is the point. `null` means
    "we could not find out", and must produce the cautious wording — a `null`
    quietly treated as `0` turns a failed request into a reassurance, which is
    the most damaging thing this file could do. So the branch is written as an
    explicit `=== null` test rather than as a falsy check, which would collapse
    the two.

    Up to three queries are named. Beyond that the sentence outgrows an
    unformatted native dialog, so it falls back to a bare count. The names are
    what answers the question the user actually has, which is whether the ones
    going are the ones they cared about.

    It lives in its own module rather than inside App.tsx so that it can be
    tested without rendering the whole application.

    The dialog's Download is offered only for a known count above zero
    (`offersDownload`): with `null` there is nothing honest to put on the
    button, and with zero there is nothing to keep. The sentence above stays
    removalPrompt's, unchanged, in every case.

INPUTS / INPUT SOURCES
    - The active ontology's name, from the ontology list.
    - The length of GET /api/queries?ontology=... , or null if that call failed.
    - The names of those saved queries, in the order the server listed them.

EXPECTED OUTPUT
    - One plain-text sentence for RemoveDialog, shown as React text. Plain
      text is deliberate: the ontology name comes from an uploaded filename
      and is therefore attacker-influenced, and nothing here is markup.
    - The dialog's heading, button words, file name and announcements.
================================================================================
*/

/** Above this many, the dialog states a count instead of listing names. */
const MAX_NAMED = 3;

/**
 * The confirmation sentence for removing an ontology.
 *
 * @param name         the ontology's name, interpolated verbatim
 * @param savedQueries how many queries will go with it, or null if unknown
 * @param names        their names, used only when all of them fit
 */
export function removalPrompt(
  name: string,
  savedQueries: number | null,
  names: string[] = [],
): string {
  // Unknown, not zero. Warn without naming a number we do not have.
  if (savedQueries === null) {
    return (
      `Remove “${name}”? This deletes its stored copy and any queries saved ` +
      `against it, which cannot be undone.`
    );
  }

  // Nothing extra to lose, so nothing extra to say. A warning shown every time
  // is a warning nobody reads, and this is the case that keeps it rare.
  if (savedQueries === 0) {
    return `Remove “${name}” and delete its stored copy? It will no longer appear after a restart.`;
  }

  const plural = savedQueries === 1 ? "1 saved query" : `${savedQueries} saved queries`;
  // Only list names when every one of them is listed: "2 saved queries
  // (“Bonds by issuer”)" would read as though the second were unnamed.
  const listed =
    savedQueries <= MAX_NAMED && names.length === savedQueries
      ? ` (${names.map((n) => `“${n}”`).join(", ")})`
      : "";
  return `Remove “${name}”? This deletes its stored copy and ${plural}${listed}, which cannot be undone.`;
}

/**
 * The message shown after the removal has happened. Returns null when there is
 * nothing extra to report, because a confirmation of the ordinary case is
 * noise: the ontology visibly disappeared.
 */
export function removalConfirmation(name: string, deletedQueries: number): string | null {
  if (deletedQueries <= 0) return null;
  const plural = deletedQueries === 1 ? "1 saved query" : `${deletedQueries} saved queries`;
  return `Removed ${name} and ${plural}.`;
}

/** The removal dialog's heading: what is being decided, named once. */
export const REMOVE_HEADING = "Remove from your library";

/** Whether the dialog offers to download the queries first (5.11 item 2):
 *  only for a count that is known and above zero. */
export function offersDownload(savedQueries: number | null): savedQueries is number {
  return savedQueries !== null && savedQueries > 0;
}

/** "the saved query" for one, "the 3 saved queries" for more. */
function theQueries(count: number): string {
  return count === 1 ? "the saved query" : `the ${count} saved queries`;
}

/** The Download button's words: before, while the file is prepared, and
 *  once it has been saved (5.11 item 3). */
export function downloadLabel(count: number, state: "idle" | "preparing" | "done"): string {
  if (state === "preparing") return "Preparing…";
  if (state === "done") return "Download again";
  return `Download ${theQueries(count)}`;
}

/** The file the browser saves: the ontology's own name (5.12). */
export function exportFilename(name: string): string {
  return `${name} saved queries.zip`;
}

/** What the live region says once the file has been handed to the browser. */
export function downloadedSentence(count: number, filename: string): string {
  const what = count === 1 ? "1 saved query" : `${count} saved queries`;
  return `Downloaded ${what} as ${filename}.`;
}

/** Said in the dialog when the download failed; Remove stays available. */
export function downloadFailed(count: number): string {
  return count === 1
    ? "The query could not be downloaded. It is still saved; nothing was removed."
    : "The queries could not be downloaded. They are still saved; nothing was removed.";
}
