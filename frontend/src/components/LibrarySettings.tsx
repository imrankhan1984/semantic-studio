/*
================================================================================
FILE: frontend/src/components/LibrarySettings.tsx
================================================================================

SUMMARY
    Settings → Library (home-and-settings 5.4): adding a reference ontology
    from the catalogue (schema.org, FIBO, UNESCO, QUDT's SHACL form),
    *Bundled with Semantic Studio* while a bundled entry is missing
    (reference-ontologies 5.3), and where the work is kept, with Copy path.
    The Load dialog's Suggested tab until it moved here (5.3).

BASIC IDEA
    Both are about the library itself rather than a file in hand, which is
    why they left the Load dialog. They load exactly as that tab did: the
    catalogue list is CatalogueList, unchanged, and the load is useLoadRun,
    the Load dialog's own, so the steps, the bar, Cancel, the failed-load
    sentence and the network approval are the same code. A finished load
    opens the ontology, as it did from the dialog, and Settings closes.

    *Add them back* opens nothing and downloads nothing: the server adds its
    own bundled files again, examples and reference ontologies alike, the
    tab stays open, and focus goes to the Library tab, since the pressed
    button goes with the section that named what was missing.

    Where the work is kept is the data folder's full path, from GET
    /api/settings (Stage B), as selectable text: Copy path is a convenience,
    and a browser that refuses the clipboard leaves the text to select.
    *Path copied* is said in a polite live region (5.7).

    It stays mounted while Network is showing (SettingsDialog keeps both
    panels and hides one), so a load started here is not cancelled by a
    look at the other tab; closing Settings unmounts it, which cancels.

INPUTS / INPUT SOURCES (props)
    - onLoaded / onLibraryChanged: as the Load dialog's.
    - bundledMissing / onExamplesRestored: the names of the bundled entries
      not in the library, in their order, and what to do with the library
      the restore answers.
    - focusTab: give focus to the Library tab.
    - dataDir: the data folder's path; null while Settings reads it, or
      when the read failed (dataDirFailed).
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
  bundledMissing: string[];
  onExamplesRestored?: (result: ExamplesRestored) => void;
  focusTab: () => void;
  dataDir?: string | null;
  dataDirFailed?: boolean;
  onOpenLimits?: () => void;
}

export default function LibrarySettings({
  onLoaded,
  onLibraryChanged,
  bundledMissing,
  onExamplesRestored,
  focusTab,
  dataDir = null,
  dataDirFailed = false,
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
      // In the order restored, which is the manifest's, as *Missing:* says
      // them; the library list is in the server's own order.
      const names = result.restored
        .map((id) => result.ontologies.find((o) => o.id === id)?.name)
        .filter((name): name is string => !!name);
      onExamplesRestored(result);
      setRestoredNote(
        names.length ? `Added back: ${names.join(", ")}.` : "Everything bundled is already in your library.",
      );
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

      {/* Only while a bundled entry is missing: the only way one comes back
          (home-and-examples 5.1, 5.8; reference-ontologies 5.3). It names
          them, since an example and a reference ontology are now two
          different things to miss. Nothing is downloaded. */}
      {bundledMissing.length > 0 && onExamplesRestored && (
        <section className="settings-section" aria-labelledby="settings-bundled-heading">
          <h3 id="settings-bundled-heading">Bundled with Semantic Studio</h3>
          <p className="hint" id="settings-bundled-missing">
            Missing: {bundledMissing.join(", ")}.
          </p>
          {/* aria-disabled, never disabled, while it works: a disabled button
              drops focus, and a failure would leave it on the page
              (load-and-shapes 5.6). The sentence above is its description:
              *Add them back* says what only with it. */}
          <button
            type="button"
            aria-disabled={busy}
            aria-describedby="settings-bundled-missing"
            onClick={() => !busy && void addExamplesBack()}
          >
            Add them back
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
          <code className="settings-path">
            {dataDir ?? (dataDirFailed ? "Could not be read. Close Settings and open it again." : "Reading…")}
          </code>
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
