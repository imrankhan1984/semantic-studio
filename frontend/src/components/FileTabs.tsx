/*
================================================================================
FILE: frontend/src/components/FileTabs.tsx
================================================================================

SUMMARY
    The tab strip above the main panel of the Edit and Shapes pages
    (multi-file-projects 5.9, Section 6, D-132): one tab per open file, in
    the order opened, each with its unsaved state in words and its own close
    button.

BASIC IDEA
    A tablist with manual activation (Section 6): the arrow keys move focus
    between tabs, Enter or Space chooses, Home and End go to the ends. One
    roving tab stop for the tabs themselves, and each close button is its
    own control right after its tab, reached with Tab once its tab has
    focus -- so a close button is never a tab stop for a file the keyboard
    has not arrived at.

    Closing is the store's: nothing is discarded, and the store answers with
    the file the page should show when the tab closed was the one it was
    showing. The last tab has no close button while a file is shown (5.9
    item 3), because closing it would leave the page with nothing.

    Two open files of the same name show their folders, and only then
    (files/tabs.ts). The strip is for a project only; a library ontology is
    one file and has none.

    No aria-controls: what a tab shows is the whole page under it -- the
    outline, the canvas and the side panel, three elements with regions of
    their own -- not one panel this strip could name. Pointing at an id
    that is not a tabpanel would say something untrue, so each tab says the
    file instead and the strip says what it is (SideTabs, which does own
    its panel, keeps aria-controls).

INPUTS / INPUT SOURCES
    - The project store: documents, the open tabs, the active file.
    - props: onOpenFile, which switches the file and the page by its role.

EXPECTED OUTPUT
    - The strip; store calls for a choice and a close.
================================================================================
*/

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { tabRows } from "../files/tabs";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ProjectDocName, ProjectDocumentState } from "../types";

interface Props {
  onOpenFile: (doc: ProjectDocName) => void;
  /** Where to go when the tab being closed is the one shown. */
  onClosed?: (next: ProjectDocumentState | null) => void;
}

export default function FileTabs({ onOpenFile, onClosed }: Props) {
  const documents = useProjectSelector((s) => s.documents);
  const openDocs = useProjectSelector((s) => s.openDocs);
  const activeDoc = useProjectSelector((s) => s.activeDoc);
  const [focused, setFocused] = useState<ProjectDocName | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // A tab to focus once the strip has re-rendered after a close.
  const pendingFocus = useRef<ProjectDocName | null>(null);

  const rows = tabRows(documents, openDocs);
  const here = rows.find((r) => r.doc === focused) ?? rows.find((r) => r.doc === activeDoc) ?? rows[0];

  const focusTab = useCallback((doc: ProjectDocName) => {
    setFocused(doc);
    pendingFocus.current = doc;
  }, []);

  useEffect(() => {
    const doc = pendingFocus.current;
    if (!doc) return;
    const target = stripRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(doc)}"]`);
    if (target) {
      pendingFocus.current = null;
      target.focus();
    }
  });

  if (rows.length === 0) return null;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) focusTab(next.doc);
    };
    if (e.key === "ArrowRight") move(at + 1);
    else if (e.key === "ArrowLeft") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "Enter" || e.key === " ") onOpenFile(rows[at].doc);
    else return;
    e.preventDefault();
  };

  const close = (doc: ProjectDocName, at: number) => {
    const next = projectStore.closeTab(doc);
    // Focus stays in the strip: the tab that stood where this one did.
    const left = rows.filter((r) => r.doc !== doc);
    const to = left[Math.min(at, left.length - 1)];
    if (to) focusTab(to.doc);
    if (next) onClosed?.(next);
  };

  return (
    <div ref={stripRef} className="file-tabs">
      <div role="tablist" aria-label="Open files" className="file-tablist">
        {rows.map((row, at) => (
          <span key={row.doc} className="file-tab-wrap" role="presentation">
            <button
              type="button"
              role="tab"
              data-tab={row.doc}
              id={`file-tab-${row.doc}`}
              aria-selected={row.doc === activeDoc}
              aria-label={row.label}
              tabIndex={row.doc === here?.doc ? 0 : -1}
              className={`file-tab${row.doc === activeDoc ? " current" : ""}`}
              title={row.path}
              onFocus={() => setFocused(row.doc)}
              onClick={() => {
                setFocused(row.doc);
                onOpenFile(row.doc);
              }}
              onKeyDown={(e) => onKey(e, at)}
            >
              <span className="file-tab-name">{row.name}</span>
              {row.showFolder && <span className="file-tab-folder">in {row.folder}</span>}
              {row.dirty && (
                <span className="file-tab-unsaved">
                  <span className="file-tab-dot" aria-hidden="true">●</span> unsaved
                </span>
              )}
            </button>
            {/* The last tab keeps the page's file, so it has no close
                button (5.9 item 3). */}
            {rows.length > 1 && (
              <button
                type="button"
                className="file-tab-close"
                aria-label={`Close ${row.name}`}
                title={`Close ${row.name}. Nothing is discarded.`}
                tabIndex={row.doc === here?.doc ? 0 : -1}
                onClick={() => close(row.doc, at)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
