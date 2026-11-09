/*
================================================================================
FILE: frontend/src/components/VocabularyRow.tsx
================================================================================

SUMMARY
    The Edit outline's last section, *Vocabularies* (vocabularies-and-
    ontologies 5.2, Section 6): every vocabulary the model uses, one row
    each -- its title and prefix, its status, its source and how many
    statements use it, all in words -- a row menu, and *Add a
    vocabulary…* at the foot. VocabulariesSection is the section;
    VocabularyRow one row.

BASIC IDEA
    The list is the server's, read from the document as applied, so what
    is typed in Turtle shows here too (5.7). It is fetched when the section
    is shown and again on each revision; while a fetch is on its way the
    last rows stay and the live region says *Reading vocabularies…*, never
    a blank section, and a failure says so with Try again, the rest of the
    panel untouched.

    The section head is a fold button with aria-expanded, as the outline's
    others, collapsed while the list is empty. The rows are the tree's
    pattern: role tree and treeitem, one tab stop, arrow keys, and
    Shift+F10 (or the context menu key) for the row menu; the `⋯` is for
    the pointer only, aria-hidden and out of the tab order (repository rule
    *row menu*). The menu's actions are vocabularies/words.ts's; Remove
    runs RemoveVocabulary, whose refusal names the statements in the way;
    Load resolves the imports, asking for a host as Resolve does; Show in
    Turtle opens the editor on the line.

    After Add, focus goes to the new row once the refreshed list holds it.

INPUTS / INPUT SOURCES (props)
    - projectId, revision: the open project, and when to read again.
    - readOnly: Add and Remove shown but aria-disabled, with the reason.

EXPECTED OUTPUT
    - The section; commands through the project store.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getVocabularies, resolveImports } from "../api";
import { editDocId, projectStore, useProjectSelector } from "../state/projectStore";
import type { VocabularyChoice, VocabularyList, VocabularyRow as Row } from "../types";
import {
  LIST_FAILED,
  READING_LIST,
  READ_ONLY,
  rowActions,
  rowName,
  sourceWord,
  statusWord,
  tabFor,
  turtleNeedle,
  usesWord,
  type SourceTab,
  type VocabularyAction,
} from "../vocabularies/words";
import AddVocabularyDialog from "./AddVocabularyDialog";
import { RowMenu } from "./HierarchyActions";

interface Props {
  projectId: string;
  revision: number;
  readOnly?: boolean;
}

const HEAD_ID = "hierarchy-vocabularies";

export function VocabulariesSection({ projectId, revision, readOnly = false }: Props) {
  const [list, setList] = useState<VocabularyList | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<boolean | null>(null);
  const [focusIri, setFocusIri] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: Row; anchor: { top: number; left: number } } | null>(null);
  const [dialog, setDialog] = useState<{ tab: SourceTab; preset: VocabularyChoice | null } | null>(null);
  const [error, setError] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // The file the Edit page shows (multi-file-projects 5.3 item 5): each file
  // keeps its own vocabularies on its own header.
  const doc = useProjectSelector((s) => s.editDoc);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getVocabularies(projectId, doc)
      .then((next) => {
        if (cancelled) return;
        setList(next);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, doc, revision, attempt]);

  // The canvas's *Add a term from…* footer asks for the dialog (5.8).
  const asked = useProjectSelector((s) => s.vocabularyDraft);
  useEffect(() => {
    if (!asked) return;
    projectStore.vocabularyDraftTaken();
    setDialog({ tab: "bundled", preset: null });
  }, [asked]);

  const rows = list?.rows ?? [];
  // Collapsed while empty, like the others (5.2), until the person folds it.
  const isOpen = open ?? rows.length > 0;
  const focusKey = focusIri !== null && rows.some((r) => r.iri === focusIri) ? focusIri : (rows[0]?.iri ?? null);

  const focusRow = useCallback((iri: string) => {
    setFocusIri(iri);
    window.setTimeout(() => {
      const target = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(
        (el) => el.dataset.iri === iri,
      );
      target?.focus();
    }, 0);
  }, []);

  // A new row takes focus once the refreshed list holds it (5.3).
  useEffect(() => {
    if (!reveal || !rows.some((r) => r.iri === reveal || r.namespaces.includes(reveal))) return;
    const row = rows.find((r) => r.iri === reveal) ?? rows.find((r) => r.namespaces.includes(reveal))!;
    setReveal(null);
    setOpen(true);
    focusRow(row.iri);
  }, [rows, reveal, focusRow]);

  const choose = async (row: Row, action: VocabularyAction) => {
    setMenu(null);
    setError("");
    if (action === "add") {
      const bundled = row.source?.kind === "bundled" ? list?.bundled.find((b) => b.iri === row.iri) : undefined;
      setDialog({ tab: tabFor(row), preset: bundled ? { bundled: bundled.id } : null });
    } else if (action === "addFrom") {
      setDialog({ tab: "file", preset: null });
    } else if (action === "turtle") {
      projectStore.showInEditor([`<${row.iri}>`, turtleNeedle(row)]);
    } else if (action === "load") {
      focusRow(row.iri);
      try {
        await resolveImports(`${projectId}-${editDocId()}`);
        setAttempt((a) => a + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      focusRow(row.iri);
      try {
        await projectStore.command("RemoveVocabulary", { iri: row.iri }, undefined, editDocId());
      } catch (e) {
        setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = rows.findIndex((r) => r.iri === focusKey);
    if (at < 0) return;
    const row = rows[at];
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = (e.target as Element).getBoundingClientRect();
      setMenu({ row, anchor: { top: rect.bottom, left: Math.max(0, rect.right - 240) } });
      return;
    }
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    if (next < 0) return;
    e.preventDefault();
    focusRow(rows[next].iri);
  };

  const count = rows.length;
  return (
    <section className={isOpen ? "hierarchy-section open vocabularies" : "hierarchy-section vocabularies"} aria-labelledby={HEAD_ID}>
      <div className="hierarchy-section-head">
        <h3>
          <button
            type="button"
            id={HEAD_ID}
            className="hierarchy-fold"
            aria-expanded={isOpen}
            aria-controls={isOpen ? `${HEAD_ID}-body` : undefined}
            aria-describedby={`${HEAD_ID}-sentence`}
            onClick={() => setOpen(!isOpen)}
            aria-label={`Vocabularies, ${count.toLocaleString()}`}
          >
            <span className="hierarchy-chevron" aria-hidden="true">
              {isOpen ? "▾" : "▸"}
            </span>
            <span className="hierarchy-section-title">Vocabularies</span>
            <span className="hierarchy-section-count">{count.toLocaleString()}</span>
          </button>
        </h3>
      </div>
      <p className="detail-note vocabularies-sentence" id={`${HEAD_ID}-sentence`}>
        {list?.sentence ?? ""}
      </p>
      <p className="visually-hidden" role="status">
        {loading ? READING_LIST : ""}
      </p>
      {isOpen && (
        <div className="hierarchy-section-body vocabularies-body" id={`${HEAD_ID}-body`}>
          {failed && (
            <div className="edit-error" role="alert">
              {LIST_FAILED}{" "}
              <button type="button" className="ghost" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </div>
          )}
          {rows.length > 0 && (
            <div className="vocabulary-rows" role="tree" aria-labelledby={HEAD_ID} ref={treeRef} onKeyDown={onKeyDown}>
              {rows.map((row) => (
                <VocabularyRow
                  key={row.iri}
                  row={row}
                  isFocus={row.iri === focusKey}
                  onFocus={() => setFocusIri(row.iri)}
                  onMenu={(element) => {
                    const rect = element.getBoundingClientRect();
                    setMenu({ row, anchor: { top: rect.bottom, left: Math.max(0, rect.right - 240) } });
                  }}
                />
              ))}
            </div>
          )}
          {error && (
            <p className="edit-error" role="alert">
              {error}
            </p>
          )}
          <button
            ref={addRef}
            type="button"
            className="ghost vocabularies-add"
            aria-disabled={readOnly}
            aria-describedby={readOnly ? `${HEAD_ID}-read-only` : undefined}
            onClick={() => !readOnly && setDialog({ tab: "bundled", preset: null })}
          >
            Add a vocabulary…
          </button>
          {readOnly && (
            <span className="detail-note" id={`${HEAD_ID}-read-only`}>
              {READ_ONLY}
            </span>
          )}
        </div>
      )}
      {menu && (
        <RowMenu<VocabularyAction>
          label={menu.row.title}
          items={rowActions(menu.row, readOnly)}
          anchor={menu.anchor}
          onChoose={(action) => void choose(menu.row, action)}
          onClose={() => {
            const iri = menu.row.iri;
            setMenu(null);
            focusRow(iri);
          }}
        />
      )}
      {dialog && (
        <AddVocabularyDialog
          projectId={projectId}
          bundled={list?.bundled ?? []}
          initialTab={dialog.tab}
          preset={dialog.preset}
          readOnly={readOnly}
          onAdded={(iri) => {
            setDialog(null);
            setReveal(iri);
          }}
          onShowRow={(iri) => {
            setDialog(null);
            setReveal(iri);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

interface RowProps {
  row: Row;
  isFocus: boolean;
  onFocus: () => void;
  onMenu: (element: Element) => void;
}

/** One row, every column in words (AC-2); the row is the tab stop. */
export default function VocabularyRow({ row, isFocus, onFocus, onMenu }: RowProps) {
  const source = sourceWord(row.source);
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={false}
      aria-label={rowName(row)}
      aria-keyshortcuts="Shift+F10"
      data-iri={row.iri}
      tabIndex={isFocus ? 0 : -1}
      className={`vocabulary-row status-${row.status}`}
      onFocus={(e) => e.target === e.currentTarget && onFocus()}
    >
      <span className="vocabulary-title">{row.title}</span>
      {row.prefix && <code className="vocabulary-prefix">{row.prefix}:</code>}
      <span className="vocabulary-status">{statusWord(row)}</span>
      {source && <span className="vocabulary-source">{source}</span>}
      <span className="vocabulary-uses">{usesWord(row.uses)}</span>
      <button
        type="button"
        className="hierarchy-menu-btn"
        tabIndex={-1}
        aria-hidden="true"
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e.currentTarget);
        }}
      >
        ⋯
      </button>
    </div>
  );
}
