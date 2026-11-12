/*
================================================================================
FILE: frontend/src/components/FolderBrowser.tsx
================================================================================

SUMMARY
    The app's own folder browser (projects-anywhere 5.3, D-135), one
    component in two modes: *Create* (New project's *Choose…*: the folder a
    new project is made inside) and *Open* (Open project folder… and
    Locate…: a folder holding a project.json). A path bar of buttons,
    Places, the current folder's subfolders, Up one level, a filter, and the
    mode's action.

BASIC IDEA
    A browser cannot give a page a folder's path, so the server lists
    folders (GET /api/folders) and this draws them. It never offers a typed
    path, and what the server leaves out (files, hidden folders, links,
    system and app folders) is never here to pick. The listing says whether
    the folder can be chosen in this mode and why not; the action is
    aria-disabled with that sentence under it, joined by aria-describedby,
    and the server checks again whatever this shows (5.4 item 2).

    The folders are a listbox with an active descendant: arrow keys, Home
    and End move, Enter opens a folder -- or, in Open mode, opens a project
    row straight away -- and Backspace or Alt+Up goes up one level. Places
    and the path bar are buttons in tab order. A change of folder is said
    in a polite live region (*D:\Work, 12 folders*), *Reading D:\Work…*
    while it loads, the list keeping its last content meanwhile. A *Project*
    row says so in words. Past 1,000 folders the true total is said and the
    filter, which narrows on the server, is the way on.

    Only the latest listing is applied: each request aborts the one before
    (the CF-4 rule for search). The last folder chosen is remembered for
    the session, module state, so the next browser opens there.

    The keys are useDialogTrap's: focus to the heading on open, Tab kept
    inside, Escape closes, focus back to the opener on close.

INPUTS / INPUT SOURCES (props)
    - mode: "create" or "open".
    - title: the heading, the mode's own by default.
    - preview: in Create mode, the sentence under the list for a folder
      (*The project will be made in …*).
    - onChoose: what the action does with the folder; a rejection's
      message is shown here and the dialog stays open (Section 6: a refused
      manifest keeps the dialog).
    - onCancel.

EXPECTED OUTPUT
    - The dialog; onChoose(path) or onCancel().
================================================================================
*/

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listFolders } from "../api";
import {
  NO_FOLDERS,
  NO_MATCH,
  actionLabel,
  browserTitle,
  folderAnnounced,
  readingFolder,
  showingSome,
} from "../projects/folderWords";
import type { FolderListing } from "../types";
import { useDialogTrap } from "./useDialogTrap";

// The last folder chosen in this session (5.3 item 1).
let lastChosen: string | null = null;

/** For tests: forget the session's last folder. */
export function resetFolderMemory(): void {
  lastChosen = null;
}

interface Props {
  mode: "create" | "open";
  title?: string;
  preview?: (path: string) => string | null;
  onChoose: (path: string) => Promise<void> | void;
  onCancel: () => void;
}

export default function FolderBrowser({ mode, title, preview, onChoose, onCancel }: Props) {
  const headingId = useId();
  const listId = useId();
  const reasonId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [path, setPath] = useState<string | null>(lastChosen);
  const [filter, setFilter] = useState("");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useDialogTrap(panelRef, headingRef, cancel);

  // The latest request only: a slower answer for a folder left behind
  // never replaces the one now asked for.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAnnouncement(readingFolder(path ?? "your home folder"));
    // A filter typed is sent once typing pauses; a folder change at once.
    const wait = filter ? 200 : 0;
    const timer = window.setTimeout(() => {
      listFolders(path, mode, filter, controller.signal)
        .then((answer) => {
          setListing(answer);
          setError(null);
          setActive(0);
          setAnnouncement(folderAnnounced(answer.path, answer.total));
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          const message = e instanceof Error ? e.message : String(e);
          setError(message);
          setAnnouncement(message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, wait);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [path, filter, mode]);

  const go = (next: string) => {
    setFilter("");
    setChooseError(null);
    setPath(next);
  };

  const choose = async (target: string) => {
    if (busy) return;
    setBusy(true);
    setChooseError(null);
    try {
      await onChoose(target);
      lastChosen = target;
    } catch (e: unknown) {
      setChooseError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const rows = listing?.folders ?? [];
  const onListKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const up = listing?.parent;
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
      event.preventDefault();
      if (up) go(up);
      return;
    }
    if (rows.length === 0) return;
    const move = (to: number) => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(rows.length - 1, to)));
    };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (!row) return;
      if (mode === "open" && row.project) void choose(row.path);
      else go(row.path);
    }
  };

  // The active row stays in view as the keys move it.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active, listing]);

  const choosable = !!listing && listing.choosable && !error;
  const reason = error ? null : listing && !listing.choosable ? listing.reason : null;
  // The action's reason: the listing's, or the refusal said above the list.
  const describedBy = error ? `${reasonId}-error` : reason ? reasonId : undefined;
  const unavailable = !choosable || busy || loading;
  const sentence = mode === "create" && listing && choosable && preview ? preview(listing.path) : null;

  return (
    <>
      <div className="modal-backdrop folder-browser-backdrop" aria-hidden="true" onClick={cancel} />
      <div
        ref={panelRef}
        className="confirm-dialog folder-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="confirm-title">
          {title ?? browserTitle(mode)}
        </h2>
        <div className="folder-browser-top">
          <nav className="folder-path" aria-label="Folder path">
            <span className="folder-path-root">This computer</span>
            {(listing?.parts ?? []).map((part) => (
              <span key={part.path} className="folder-path-part">
                <span aria-hidden="true"> › </span>
                <button
                  type="button"
                  className="link-btn"
                  aria-current={part.path === listing?.path ? "location" : undefined}
                  onClick={() => go(part.path)}
                >
                  {part.name}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="ghost"
            aria-disabled={!listing?.parent}
            onClick={() => listing?.parent && go(listing.parent)}
          >
            Up one level
          </button>
        </div>
        <div className="folder-browser-body">
          <div className="folder-places" role="group" aria-labelledby={`${headingId}-places`}>
            <h3 id={`${headingId}-places`} className="folder-browser-heading">
              Places
            </h3>
            {(listing?.places ?? []).map((place) => (
              <button key={place.path} type="button" className="ghost folder-place" onClick={() => go(place.path)}>
                {place.name}
              </button>
            ))}
          </div>
          <div className="folder-list-column">
            <div className="folder-list-head">
              <h3 id={`${listId}-heading`} className="folder-browser-heading">
                Folders{listing ? ` (${listing.total.toLocaleString()})` : ""}
              </h3>
              <label className="visually-hidden" htmlFor={`${listId}-filter`}>
                Show only folders whose name starts with
              </label>
              <input
                id={`${listId}-filter`}
                type="search"
                className="folder-filter"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                spellCheck={false}
              />
            </div>
            {error && (
              <p id={`${reasonId}-error`} className="form-error folder-error">
                {error}
              </p>
            )}
            {/* Always mounted, empty too: the list holds the focus, and an
                empty folder that took it away dropped focus to the page and
                Backspace with it (found in Chrome, not in jsdom). */}
            <ul
              ref={listRef}
              id={listId}
              className="folder-list"
              role="listbox"
              tabIndex={0}
              aria-labelledby={`${listId}-heading`}
              aria-describedby={rows.length === 0 && !loading && !error ? `${listId}-empty` : undefined}
              aria-activedescendant={rows[active] ? `${listId}-row-${active}` : undefined}
              aria-busy={loading}
              onKeyDown={onListKey}
            >
              {rows.map((row, i) => (
                <li
                  key={row.path}
                  id={`${listId}-row-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "folder-row active" : "folder-row"}
                  onClick={() => {
                    setActive(i);
                    go(row.path);
                  }}
                >
                  <span className="folder-row-name">{row.name}</span>
                  {row.project && <span className="folder-row-project"> Project</span>}
                </li>
              ))}
            </ul>
            {rows.length === 0 && !loading && !error && (
              <p className="folder-empty" id={`${listId}-empty`}>
                {filter ? NO_MATCH : NO_FOLDERS}
              </p>
            )}
            {listing?.truncated && <p className="form-hint">{showingSome(rows.length, listing.total)}</p>}
          </div>
        </div>
        <div className="folder-live visually-hidden" role="status" aria-live="polite">
          {announcement}
        </div>
        {sentence && <p className="form-hint folder-preview">{sentence}</p>}
        {chooseError && (
          <p className="form-error" role="alert">
            {chooseError}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={cancel} aria-disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            aria-disabled={unavailable}
            aria-describedby={describedBy}
            onClick={() => !unavailable && listing && void choose(listing.path)}
          >
            {busy ? "Working…" : actionLabel(mode)}
          </button>
        </div>
        {reason && (
          <p id={reasonId} className="form-hint folder-reason">
            {reason}
          </p>
        )}
      </div>
    </>
  );
}
