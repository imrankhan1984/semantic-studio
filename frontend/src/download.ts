/*
================================================================================
FILE: frontend/src/download.ts
================================================================================

SUMMARY
    One shared helper for handing a Blob to the browser as a file download. It is
    the object-URL-create, synthetic-anchor-click, object-URL-revoke dance that
    two features need: the documentation export (HomeScreen) and the query-result
    export (ResultsTable, Q-2).

BASIC IDEA
    Lifted out of HomeScreen so both callers share one tested copy rather than
    duplicating it, which is how a subtle difference (a missing revoke, a leaked
    object URL) creeps between two copies of the same dance. The object URL is
    revoked immediately after the synthetic click, so the blob is not held in
    memory once the download has been handed to the browser.

INPUTS / INPUT SOURCES
    - A Blob (the file bytes) and a filename.

EXPECTED OUTPUT
    - The browser's own download of the blob under the given name.
================================================================================
*/

/** Trigger the browser's own download of a blob under `filename`. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
