/*
================================================================================
FILE: frontend/src/components/LibrarySettings.tsx
================================================================================

SUMMARY
    Settings → Library (home-and-settings 5.4): adding a reference ontology
    from the catalogue (schema.org, FIBO, UNESCO), *Add the examples back*
    while a bundled example is missing, and where the work is kept, with
    Copy path. The Load dialog's Suggested tab until it moved here (5.3).

BASIC IDEA
    Both are about the library itself rather than a file in hand, which is
    why they left the Load dialog. They load exactly as that tab did: the
    catalogue list is CatalogueList, unchanged, and the load is useLoadRun,
    the Load dialog's own, so the steps, the bar, Cancel, the failed-load
    sentence and the network approval are the same code. A finished load
    opens the ontology, as it did from the dialog, and Settings closes.

    *Add the examples back* opens nothing and downloads nothing: the server
    adds its own bundled files again, the tab stays open, and focus goes to
    the Library tab, since the pressed button goes with the examples it
    named.

    Where the work is kept is the data folder's full path, from GET
    /api/settings (Stage B), as selectable text: Copy path is a convenience,
    and a browser that refuses the clipboard leaves the text to select.
    *Path copied* is said in a polite live region (5.7).

    It stays mounted while Network is showing (SettingsDialog keeps both
    panels and hides one), so a load started here is not cancelled by a
    look at the other tab; closing Settings unmounts it, which cancels.

INPUTS / INPUT SOURCES (props)
    - onLoaded / onLibraryChanged: as the Load dialog's.
    - examplesMissing / onExamplesRestored: how many bundled examples are not
      in the library, and what to do with the library the restore answers.
    - focusTab: give focus to the Library tab.
    - dataDir: the data folder's path; null while Settings reads it.
    - onOpenLimits: a catalogue entry refused for its size offers Settings →
      Limits, which this switches to.
    Plus CATALOGUE (through CatalogueList), fetchOntology and restoreExamples.

EXPECTED OUTPUT
    - The tab's body.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { fetchOntology, restoreExamples, type ExamplesRestored } from "../api";
import type { CatalogueEntry } from "../catalogue";
import type { OntologySummary } from "../types";
import CatalogueList from "./CatalogueList";
import { LoadErrorView, loadError, useLoadRun, type LoadOrigin } from "./useLoadRun";

interface Props {
  onLoaded: (summary: OntologySummary) => void;
  onLibraryChanged?: () => void;
  examplesMissing: number;
  onExamplesRestored?: (result: ExamplesRestored) => void;
  focusTab: () => void;
  dataDir?: string | null;
  onOpenLimits?: () => void;
}

export default function LibrarySettings({
  onLoaded,
  onLibraryChanged,
  examplesMissing,
  onExamplesRestored,
  focusTab,
  dataDir = null,
  onOpenLimits,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoredNote, setRestoredNote] = useState("");

  // A Cancel gives focus back to the entry's own row.
  const focusOrigin = (origin: LoadOrigin) => {
    const row =
      origin.tab === "suggested"
        ? [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])].find(
            (r) => r.dataset.entry === origin.entryId,
          )
        : null;
    if (row) row.focus();
    else focusTab();
  };
  const { run, ended, error, setError, startLoad, statusAt, announcement } = useLoadRun({
    onLoaded,
    onLibraryChanged,
    focusOrigin,
  });
  const busy = run !== null || restoring;

  const [copied, setCopied] = useState("");
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const copyPath = async () => {
    if (!dataDir) return;
    try {
      await navigator.clipboard.writeText(dataDir);
      setCopied("Path copied");
    } catch {
      setCopied("Could not copy. Select the path to copy it.");
    }
    // Cleared after a while, so pressing it again is announced again.
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(""), 4000);
  };
  const origin =
    run?.origin.tab === "suggested" ? run.origin : ended?.origin.tab === "suggested" ? ended.origin : null;

  // A new load starts clean: what the examples' restore said is not about it.
  const add = (entry: CatalogueEntry) => {
    setRestoredNote("");
    return startLoad({ tab: "suggested", entryId: entry.id }, entry.name, null, (options) =>
      fetchOntology(entry.url, options),
    );
  };

  const addExamplesBack = async () => {
    if (!onExamplesRestored) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreExamples();
      const names = result.ontologies.filter((o) => result.restored.includes(o.id)).map((o) => o.name);
      onExamplesRestored(result);
      setRestoredNote(names.length ? `Added back: ${names.join(", ")}.` : "The examples are all in your library.");
      focusTab();
    } catch (e: unknown) {
      setError(loadError(e));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div ref={bodyRef} className="settings-library">
      <section className="settings-section" aria-labelledby="settings-catalogue-heading">
        <h3 id="settings-catalogue-heading">Add a reference ontology</h3>
        <p className="hint">Well-known public ontologies — nothing is downloaded until you pick one.</p>
        <CatalogueList
          fetchingId={run?.origin.tab === "suggested" ? run.origin.entryId : null}
          busy={busy}
          onPick={(entry) => void add(entry)}
          status={origin && statusAt(origin)}
          statusId={origin?.entryId ?? null}
        />
      </section>

      {/* Only while an example is missing: the only way one comes back
          (home-and-examples 5.1, 5.8). Nothing is downloaded. */}
      {examplesMissing > 0 && onExamplesRestored && (
        <section className="settings-section" aria-labelledby="settings-examples-heading">
          <h3 id="settings-examples-heading">The examples</h3>
          {/* aria-disabled, never disabled, while it works: a disabled button
              drops focus, and a failure would leave it on the page
              (load-and-shapes 5.6). */}
          <button type="button" aria-disabled={busy} onClick={() => !busy && void addExamplesBack()}>
            Add the examples back
          </button>
        </section>
      )}

      {/* Both rendered whether or not they have anything to say: a live
          region added with its text is unreliably announced. */}
      <p className="hint examples-restored" role="status">
        {restoredNote}
      </p>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      <LoadErrorView error={error} onOpenLimits={onOpenLimits} />
      <section className="settings-section settings-folder-section" aria-labelledby="settings-folder-heading">
        <h3 id="settings-folder-heading">Where your work is kept</h3>
        <p className="hint">Projects, the library and saved queries are kept here, on this computer.</p>
        <div className="settings-folder">
          <code className="settings-path">{dataDir ?? "Reading…"}</code>
          <button type="button" aria-disabled={!dataDir} onClick={() => void copyPath()}>
            Copy path
          </button>
        </div>
        <p className="hint settings-copied" role="status">
          {copied}
        </p>
      </section>

    </div>
  );
}
