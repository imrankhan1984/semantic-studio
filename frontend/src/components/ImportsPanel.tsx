/*
================================================================================
FILE: frontend/src/components/ImportsPanel.tsx
================================================================================

SUMMARY
    The imports panel (external-access Stage 2, Section 6): the ontologies this
    one imports, where each came from or why it did not load, the controls that
    resolve them, the choose-a-file fallback for any import the network could
    not supply, and the "Include imports" switch that turns the merged view on.

BASIC IDEA
    A collapsible bar above the main area in View and Hierarchy modes. It asks
    for the listing when it mounts -- a read of the server's own files, never a
    connection -- and renders nothing at all for an ontology with no imports.

    Every status is a sentence or a word, never a colour: "bundled", "from your
    library", "downloaded 27 Sept 2026", "not loaded", or the reason a row
    failed. A failed row offers the four ways out Section 5.3.1 names: Retry,
    open the link in the browser (which on a corporate network usually gets
    through where the app cannot), copy it, or choose the file. The panel also
    offers files or a whole folder for everything still unresolved at once.
    Only RDF files from a chosen folder are sent, so pointing at a Downloads
    folder does not upload its spreadsheets.

    A link is rendered only for an http(s) IRI. The IRIs come from the loaded
    file, which is untrusted, and a `javascript:` import would otherwise be a
    link the user is invited to press.

    Resolving is one request, so while it runs the panel polls the listing for
    "Resolving 2 of 3…", announced in a polite live region, and offers Cancel,
    which stops after the document in hand. Buttons are not disabled while
    busy: disabling the focused control drops focus to <body> (measured in
    Chrome, see saved-query-deletion-warning), so a second press is ignored
    instead. When the control that was pressed disappears -- Resolve, once
    everything resolved -- focus moves to the panel's heading.

INPUTS / INPUT SOURCES (props)
    - ontologyId: whose imports.
    - library: the other ontologies, for "Use one from your library".
    - includeImports / onIncludeImportsChange: the merged-view switch, owned by
      App because every view reads it.
    - onChanged: told the new listing whenever the closure changes, so App can
      refetch the views built over it.

EXPECTED OUTPUT
    - The panel, or null when the ontology imports nothing.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelImports,
  chooseImportFiles,
  listImports,
  mapImport,
  refreshImports,
  resolveImports,
} from "../api";
import type { ImportFilesResult, ImportRow, ImportsListing } from "../types";

interface Props {
  ontologyId: string;
  library: { id: string; name: string }[];
  includeImports: boolean;
  onIncludeImportsChange: (next: boolean) => void;
  onChanged?: (listing: ImportsListing) => void;
}

// What a chosen folder is filtered to. The server would refuse anything else
// as unparseable anyway; filtering here means it is never sent at all.
const RDF_EXTENSIONS = /\.(ttl|turtle|owl|rdf|rdfs|xml|jsonld|json|nt|n3|trig|nq)$/i;

// How often the listing is re-read while a resolution runs. Slow enough to be
// negligible next to a download, quick enough that the count visibly moves.
const PROGRESS_POLL_MS = 500;

function isWebLink(iri: string): boolean {
  return /^https?:\/\//i.test(iri);
}

function day(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The status of one row, in words. Colour adds nothing this does not say. */
export function statusText(row: ImportRow): string {
  switch (row.status) {
    case "builtin":
      return "built in";
    case "resolved":
      switch (row.source) {
        case "bundled":
          return "bundled";
        case "library":
          return `from your library (${row.sourceName})`;
        case "mapped":
          return `mapped to ${row.sourceName}`;
        case "file":
          return `chosen file ${row.sourceName}`;
        case "network":
          return `downloaded ${day(row.fetchedAt)}`;
        default:
          return "loaded";
      }
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return "not loaded";
  }
}

/** The one-sentence summary the collapsed bar shows. */
export function summaryText(listing: ImportsListing): string {
  const direct = listing.imports.filter((r) => r.importedBy === null);
  const pending = listing.imports.filter((r) =>
    ["unresolved", "failed", "blocked"].includes(r.status),
  ).length;
  const resolved = listing.imports.filter((r) => r.status === "resolved").length;
  const count = `This ontology imports ${direct.length} ${direct.length === 1 ? "other" : "others"}.`;
  if (resolved === 0) return count;
  const loaded = `${resolved} ${resolved === 1 ? "document" : "documents"} loaded`;
  return pending === 0 ? `${count} ${loaded}.` : `${count} ${loaded}, ${pending} not loaded.`;
}

export default function ImportsPanel({
  ontologyId,
  library,
  includeImports,
  onIncludeImportsChange,
  onChanged,
}: Props) {
  const [listing, setListing] = useState<ImportsListing | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"resolve" | "refresh" | "files" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const rowFileRef = useRef<HTMLInputElement>(null);
  // The import a row's "Choose a file…" was pressed for, read when the
  // browser's picker returns.
  const rowFileFor = useRef<string | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    let live = true;
    setListing(null);
    setMessage("");
    setError(null);
    listImports(ontologyId)
      .then((l) => live && setListing(l))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [ontologyId]);

  // Poll for progress while a resolution request is in flight.
  useEffect(() => {
    if (busy !== "resolve" && busy !== "refresh") {
      setProgress(null);
      return;
    }
    const timer = window.setInterval(() => {
      listImports(ontologyId)
        .then((l) => l.resolving && setProgress(l.resolving))
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, ontologyId]);

  const settle = useCallback((next: ImportsListing, said: string) => {
    setListing(next);
    setMessage(said);
    onChangedRef.current?.(next);
    // The control pressed may be gone now (Resolve, once nothing is left to
    // resolve). Wherever focus fell, the heading is where it is picked up.
    window.setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        headingRef.current?.focus();
      }
    }, 0);
  }, []);

  const fail = useCallback(
    async (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      // A declined approval or a failure still leaves the server's record of
      // what did resolve, which is worth showing.
      try {
        const next = await listImports(ontologyId);
        setListing(next);
        onChangedRef.current?.(next);
      } catch {
        /* keep the last listing */
      }
    },
    [ontologyId],
  );

  const resolve = useCallback(
    async (kind: "resolve" | "refresh") => {
      if (busy) return;
      setBusy(kind);
      setError(null);
      setMessage("");
      try {
        const next = kind === "resolve" ? await resolveImports(ontologyId) : await refreshImports(ontologyId);
        const resolved = next.imports.filter((r) => r.status === "resolved").length;
        settle(next, `Imports resolved: ${resolved} ${resolved === 1 ? "document" : "documents"} loaded.`);
      } catch (e) {
        await fail(e);
      } finally {
        setBusy(null);
      }
    },
    [busy, ontologyId, settle, fail],
  );

  const reportFiles = (result: ImportFilesResult): string => {
    const parts: string[] = [];
    if (result.matched.length > 0) {
      parts.push(
        `Used ${result.matched.map((m) => m.file).join(", ")} for ${result.matched.length} ${
          result.matched.length === 1 ? "import" : "imports"
        }.`,
      );
    }
    if (result.unmatched.length > 0) {
      parts.push(`Not needed by this ontology, so not kept: ${result.unmatched.join(", ")}.`);
    }
    for (const bad of result.invalid) parts.push(`${bad.file} could not be read as RDF.`);
    if (parts.length === 0) parts.push("None of the chosen files matched an import.");
    return parts.join(" ");
  };

  const sendFiles = useCallback(
    async (files: File[], forIri?: string) => {
      if (busy || files.length === 0) return;
      setBusy("files");
      setError(null);
      try {
        let result = await chooseImportFiles(ontologyId, files, { forIri });
        // AC-42: a file chosen for one import that says it is another is used
        // only when the user says so. Asked once per file; the browser still
        // holds the file, so confirming re-sends it with the confirmation.
        for (const m of result.mismatch) {
          const declared = m.declares ?? "no ontology IRI";
          const yes = window.confirm(
            `This file declares ${declared}, not ${m.forIri}. Use it for ${m.forIri} anyway?`,
          );
          const file = files.find((f) => f.name === m.file);
          if (yes && file) {
            const confirmed = await chooseImportFiles(ontologyId, [file], {
              forIri: m.forIri,
              acceptMismatch: true,
            });
            result = {
              ...confirmed,
              matched: [...result.matched, ...confirmed.matched],
              unmatched: result.unmatched,
              invalid: result.invalid,
            };
          }
        }
        settle(result.imports, reportFiles(result));
      } catch (e) {
        await fail(e);
      } finally {
        setBusy(null);
      }
    },
    [busy, ontologyId, settle, fail],
  );

  const onPicked = (input: HTMLInputElement | null, forIri?: string) => {
    if (!input?.files) return;
    const files = Array.from(input.files).filter((f) => RDF_EXTENSIONS.test(f.name));
    input.value = "";
    void sendFiles(files, forIri);
  };

  const chooseForRow = (iri: string) => {
    rowFileFor.current = iri;
    rowFileRef.current?.click();
  };

  const useLibrary = useCallback(
    async (iri: string, targetId: string) => {
      if (!targetId) return;
      setError(null);
      try {
        const next = await mapImport(ontologyId, iri, targetId);
        const name = library.find((o) => o.id === targetId)?.name ?? "that ontology";
        settle(next, `Using ${name} for ${iri}.`);
      } catch (e) {
        await fail(e);
      }
    },
    [ontologyId, library, settle, fail],
  );

  const cancel = useCallback(() => {
    void cancelImports(ontologyId).catch(() => undefined);
  }, [ontologyId]);

  if (listing === null) {
    return error ? <p className="imports-error">{error}</p> : null;
  }
  if (listing.imports.length === 0) return null;

  const rows = listing.imports;
  const pending = rows.filter((r) => ["unresolved", "failed", "blocked"].includes(r.status));
  const anyResolved = rows.some((r) => r.status === "resolved");
  const anyDownloaded = rows.some((r) => r.status === "resolved" && r.source === "network");
  const resolving = busy === "resolve" || busy === "refresh";

  return (
    <section className="imports-panel" aria-labelledby="imports-heading">
      <h2 className="imports-title">
        <button
          id="imports-heading"
          ref={headingRef}
          className="imports-toggle"
          aria-expanded={expanded}
          aria-controls="imports-body"
          onClick={() => setExpanded((v) => !v)}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Imports
        </button>
        <span className="imports-summary">{summaryText(listing)}</span>
      </h2>

      {/* Rendered even when idle, so the first announcement is not lost to a
          region that arrived in the same render as its text. */}
      <p className="imports-live" role="status" aria-live="polite">
        {resolving
          ? progress
            ? `Resolving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : "Resolving imports…"
          : message}
      </p>

      <div id="imports-body" hidden={!expanded}>
        {listing.offline && (
          <p className="imports-note">Working offline. Only bundled and library imports can resolve.</p>
        )}
        {listing.limit && <p className="imports-note">{listing.limit}</p>}
        {error && <p className="imports-error">{error}</p>}

        <div className="imports-actions">
          {pending.length > 0 && (
            <button onClick={() => void resolve("resolve")}>Resolve imports</button>
          )}
          {resolving && (
            <button className="ghost" onClick={cancel}>
              Cancel
            </button>
          )}
          {anyDownloaded && !resolving && (
            <button className="ghost" onClick={() => void resolve("refresh")}>
              Refresh downloads
            </button>
          )}
          {pending.length > 0 && (
            <span className="imports-choose" role="group" aria-label="Choose files or a folder">
              <button className="ghost" onClick={() => filesRef.current?.click()}>
                Choose files…
              </button>
              <button className="ghost" onClick={() => folderRef.current?.click()}>
                Choose a folder…
              </button>
            </span>
          )}
          {anyResolved && (
            <button
              type="button"
              role="switch"
              aria-checked={includeImports}
              className={includeImports ? "network-switch on" : "network-switch"}
              onClick={() => onIncludeImportsChange(!includeImports)}
            >
              <span className="network-switch-track" aria-hidden="true">
                <span className="network-switch-thumb" />
              </span>
              Include imports
            </button>
          )}
        </div>
        {anyResolved && (
          <p className="imports-note">
            {includeImports
              ? "Showing this ontology together with its imports. Imported entities are read-only."
              : "Showing this ontology on its own."}
          </p>
        )}

        <ul className="imports-list">
          {rows.map((row) => {
            // A row with a reason is one the user may need a way out of: a
            // failure, a Block, and also an unresolved row the user declined to
            // connect for, or one a limit or Cancel left behind.
            const failed =
              row.status === "failed" ||
              row.status === "blocked" ||
              (row.status === "unresolved" && row.error !== null);
            return (
              <li key={row.iri} className={`imports-row ${row.status}`}>
                <span className="imports-iri" style={{ paddingLeft: `${(row.depth - 1) * 14}px` }}>
                  {row.iri}
                </span>
                <span className="imports-status">{statusText(row)}</span>
                {row.error && <span className="imports-reason">{row.error}</span>}
                {failed && (
                  <span className="imports-row-actions">
                    <button className="ghost" onClick={() => void resolve("resolve")}>
                      Retry
                    </button>
                    {isWebLink(row.iri) && (
                      <a href={row.iri} target="_blank" rel="noopener noreferrer">
                        Open the link in my browser
                      </a>
                    )}
                    <button
                      className="ghost"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(row.iri)
                          .then(() => setMessage(`Copied ${row.iri}.`))
                          .catch(() => setMessage("The link could not be copied."))
                      }
                    >
                      Copy the link
                    </button>
                    <button className="ghost" onClick={() => chooseForRow(row.iri)}>
                      Choose a file…
                    </button>
                    {library.length > 0 && (
                      <select
                        aria-label={`Use an ontology from your library for ${row.iri}`}
                        value=""
                        onChange={(e) => void useLibrary(row.iri, e.target.value)}
                      >
                        <option value="">Use one from your library…</option>
                        {library.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {/* The browser's own pickers, reached through the buttons above. The
            server receives the bytes of what is chosen and never a path. */}
        <input
          ref={filesRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          data-testid="imports-files"
          onChange={(e) => onPicked(e.currentTarget)}
        />
        {/* The folder picker. `webkitdirectory` is not in React's attribute
            types, and every current browser supports it under that name. */}
        <input
          ref={(el) => {
            folderRef.current = el;
            el?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          data-testid="imports-folder"
          onChange={(e) => onPicked(e.currentTarget)}
        />
        <input
          ref={rowFileRef}
          type="file"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          data-testid="imports-row-file"
          onChange={(e) => onPicked(e.currentTarget, rowFileFor.current ?? undefined)}
        />
      </div>
    </section>
  );
}
