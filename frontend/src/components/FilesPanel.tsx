/*
================================================================================
FILE: frontend/src/components/FilesPanel.tsx
================================================================================

SUMMARY
    The Files panel (multi-file-projects 5.5, Section 6, D-132): the open
    project's folders and files as a tree above the outline on the Edit and
    Shapes pages, with New file, New folder, and each row's Rename, Move to
    folder and Remove.

BASIC IDEA
    One tree, one tab stop (roving tabindex): Up and Down move, Right opens a
    folder or moves into it, Left closes it or moves to its parent, Home and
    End go to the ends, Enter chooses a file (or opens a folder), F2 renames,
    Shift+F10 or the context-menu key opens the row's menu. The row's ⋯ is
    aria-hidden and not a tab stop, as on the outline (the *row menu* rule).
    Each row's accessible name is its words (files/tree.ts), the active file
    is aria-current, and role and unsaved state are words on the row, never
    colour alone.

    Choosing a file is App's: an ontology or vocabulary file opens on the
    Edit page, a shapes file on the Shapes page. Everything that changes the
    project goes through the project store, whose answer replaces the list;
    focus then goes where Section 6 says -- the new file's row after Create,
    the renamed row after Rename, the next row (or the previous one, if it
    was last) after Remove -- and Cancel gives it back to the control that
    opened the dialog, useDialogTrap's rule. A refusal is its sentence in
    the dialog, beside the field it concerns.

    A folder's Rename (5.10 item 1) is the same shape: the name is held to
    8.3 here and again on the server, which moves the paths of every file
    under it in one write and keeps their ids, so nothing those files hold
    is touched. Focus goes to the renamed row.

    A file row shows its name on its own line, with its role and *unsaved*
    smaller under it (5.10 item 2), so the name has the column's whole
    width and a long one wraps rather than being cut.

INPUTS / INPUT SOURCES
    - The project store: documents, folders, the active file, the notice the
      open's folder index left.
    - props: onOpenFile, onError.

EXPECTED OUTPUT
    - The panel; store calls for each action.
================================================================================
*/

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { pathRefusal } from "../api";
import { fileName, folderError, segmentError } from "../files/names";
import {
  fileLabel,
  folderChoices,
  folderLabel,
  folderRemoveRefusal,
  fileRows,
  newFileRefusal,
  noticeLines,
  removeQuestion,
  removeRefusal,
  roleWord,
  type FileRowData,
  type FolderRowData,
  type TreeRow,
} from "../files/tree";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { FileRole, ProjectDocumentState } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import { RowMenu } from "./HierarchyActions";
import NewFileDialog from "./NewFileDialog";
import { useDialogTrap } from "./useDialogTrap";

interface Props {
  onOpenFile: (doc: string) => void;
  /** A file removed: its id, and the file the store moved to. */
  onRemoved?: (doc: string, next: ProjectDocumentState | null) => void;
  onError: (message: string) => void;
}

type Dialog =
  | { kind: "newFile"; folder: string }
  | { kind: "newFolder"; under: string }
  | { kind: "rename"; row: FileRowData }
  | { kind: "move"; row: FileRowData }
  | { kind: "remove"; row: FileRowData }
  | { kind: "renameFolder"; row: FolderRowData }
  | { kind: "removeFolder"; row: FolderRowData };

type FileAction = "rename" | "move" | "remove";
type FolderAction = "newFile" | "renameFolder" | "removeFolder";

export default function FilesPanel({ onOpenFile, onRemoved, onError }: Props) {
  const documents = useProjectSelector((s) => s.documents);
  const folders = useProjectSelector((s) => s.folders);
  const activeDoc = useProjectSelector((s) => s.activeDoc);
  const notice = useProjectSelector((s) => s.fileNotice);
  const kind = useProjectSelector((s) => s.project?.kind ?? null);
  const [open, setOpen] = useState(true);
  // Every folder starts expanded, so a file is never hidden on first sight.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: TreeRow; anchor: { top: number; left: number } } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // A row to focus once the list has re-rendered after an action.
  const pendingFocus = useRef<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const headingId = useId();
  const bodyId = useId();

  const expanded = useMemo(() => {
    const all = new Set<string>();
    for (const f of folders) {
      const parts = f.split("/");
      for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
    }
    for (const d of documents) {
      const parts = (d.file ?? "").split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
    }
    return new Set([...all].filter((f) => !collapsed.has(f)));
  }, [folders, documents, collapsed]);
  const rows = useMemo(() => fileRows(documents, folders, expanded), [documents, folders, expanded]);
  const current = rows.find((r) => r.key === focusKey) ?? rows.find((r) => r.kind === "file" && r.doc === activeDoc) ?? rows[0];

  const focusRow = useCallback((key: string) => {
    setFocusKey(key);
    pendingFocus.current = key;
  }, []);

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const target = treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (target) {
      pendingFocus.current = null;
      target.focus();
    }
  });

  const toggle = (row: FolderRowData, to?: boolean) => {
    const next = new Set(collapsed);
    const opening = to ?? !row.expanded;
    if (opening) next.delete(row.path);
    else next.add(row.path);
    setCollapsed(next);
  };

  const choose = (row: TreeRow) => {
    if (row.kind === "folder") toggle(row);
    else onOpenFile(row.doc);
  };

  const openMenu = (row: TreeRow, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    setMenu({ row, anchor: { top: box.bottom, left: box.left + 16 } });
  };

  const onKey = (e: KeyboardEvent<HTMLLIElement>, row: TreeRow, index: number) => {
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) focusRow(next.key);
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "ArrowRight" && row.kind === "folder") {
      if (!row.expanded) toggle(row, true);
      else if (rows[index + 1]?.level === row.level + 1) move(index + 1);
    } else if (e.key === "ArrowLeft") {
      if (row.kind === "folder" && row.expanded) toggle(row, false);
      else {
        // To the parent folder's row.
        for (let i = index - 1; i >= 0; i--) {
          if (rows[i].kind === "folder" && rows[i].level === row.level - 1) {
            move(i);
            break;
          }
        }
      }
    } else if (e.key === "Enter") choose(row);
    else if (e.key === "F2") setDialog(row.kind === "file" ? { kind: "rename", row } : { kind: "renameFolder", row });
    else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") openMenu(row, e.currentTarget);
    else return;
    e.preventDefault();
  };

  const closeMenu = useCallback(() => {
    const key = menu?.row.key;
    setMenu(null);
    if (key) focusRow(key);
  }, [menu, focusRow]);

  const fileItems = (row: FileRowData) => {
    const refusal = removeRefusal(row, documents);
    return [
      { action: "rename" as FileAction, label: "Rename…" },
      { action: "move" as FileAction, label: "Move to folder…" },
      { action: "remove" as FileAction, label: "Remove…", ...(refusal ? { disabled: refusal } : {}) },
    ];
  };
  const folderItems = (row: FolderRowData) => {
    const refusal = folderRemoveRefusal(row);
    return [
      { action: "newFile" as FolderAction, label: "New file here…" },
      { action: "renameFolder" as FolderAction, label: "Rename…" },
      { action: "removeFolder" as FolderAction, label: "Remove…", ...(refusal ? { disabled: refusal } : {}) },
    ];
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const limit = newFileRefusal(documents.length);
  const lines = notice ? noticeLines(notice) : [];

  return (
    <section className="files-panel" aria-labelledby={headingId}>
      <div className="files-head">
        <button
          type="button"
          className="files-fold"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <h2 id={headingId} className="files-heading">Files</h2>
        </button>
        {open && (
          <div className="files-toolbar">
            <button
              type="button"
              className="small"
              aria-disabled={limit ? true : undefined}
              aria-description={limit ?? undefined}
              title={limit ?? "A new ontology, vocabulary or shapes file"}
              onClick={() => !limit && setDialog({ kind: "newFile", folder: "" })}
            >
              New file
            </button>
            <button
              type="button"
              className="small"
              title="A new folder in the project"
              onClick={() => setDialog({ kind: "newFolder", under: "" })}
            >
              New folder
            </button>
          </div>
        )}
      </div>
      <div id={bodyId} className="files-body" hidden={!open}>
        {lines.length > 0 && (
          <div className="files-notice" role="status">
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <button type="button" className="link-btn" onClick={() => projectStore.dismissFileNotice()}>
              Dismiss
            </button>
          </div>
        )}
        {documents.length === 0 ? (
          <p className="files-loading" role="status">Reading files…</p>
        ) : (
          <ul ref={treeRef} role="tree" aria-labelledby={headingId} className="files-tree">
            {rows.map((row, index) => {
              const isCurrent = row.kind === "file" && row.doc === activeDoc;
              const label = row.kind === "file" ? fileLabel(row) : folderLabel(row);
              return (
                <li
                  key={row.key}
                  data-key={row.key}
                  role="treeitem"
                  aria-level={row.level}
                  aria-label={label}
                  aria-expanded={row.kind === "folder" ? row.expanded : undefined}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-selected={isCurrent}
                  tabIndex={row.key === current?.key ? 0 : -1}
                  className={`files-row files-${row.kind}${isCurrent ? " current" : ""}`}
                  style={{ paddingLeft: `${(row.level - 1) * 14 + 6}px` }}
                  onClick={() => {
                    setFocusKey(row.key);
                    choose(row);
                  }}
                  onFocus={() => setFocusKey(row.key)}
                  onKeyDown={(e) => onKey(e, row, index)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(row, e.currentTarget);
                  }}
                >
                  {row.kind === "folder" ? (
                    <>
                      <span className="files-caret" aria-hidden="true">{row.expanded ? "▾" : "▸"}</span>
                      <span className="files-name">{row.name}/</span>
                      {row.empty && <span className="files-meta">Empty folder</span>}
                    </>
                  ) : (
                    <span className="files-text">
                      {/* The name on its own line, in full (5.10 item 2);
                          its role and unsaved state smaller, under it. */}
                      <span className="files-name">{row.name}</span>
                      <span className="files-second">
                        <span className="files-meta">{roleWord(row.role)}</span>
                        {row.dirty && (
                          <span className="files-unsaved">
                            <span className="files-dot" aria-hidden="true">●</span> unsaved
                          </span>
                        )}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="files-more"
                    aria-hidden="true"
                    tabIndex={-1}
                    title={`More actions for ${row.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusKey(row.key);
                      openMenu(row, e.currentTarget);
                    }}
                  >
                    ⋯
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {menu && menu.row.kind === "file" && (
        <RowMenu<FileAction>
          label={menu.row.name}
          items={fileItems(menu.row)}
          anchor={menu.anchor}
          onClose={closeMenu}
          onChoose={(action) => {
            const row = menu.row as FileRowData;
            setMenu(null);
            setDialog({ kind: action, row });
          }}
        />
      )}
      {menu && menu.row.kind === "folder" && (
        <RowMenu<FolderAction>
          label={menu.row.name}
          items={folderItems(menu.row)}
          anchor={menu.anchor}
          onClose={closeMenu}
          onChoose={(action) => {
            const row = menu.row as FolderRowData;
            setMenu(null);
            setDialog(action === "newFile" ? { kind: "newFile", folder: row.path } : { kind: action, row });
          }}
        />
      )}

      {dialog?.kind === "newFile" && (
        <NewFileDialog
          kind={kind}
          folders={folders}
          folder={dialog.folder}
          onCancel={() => setDialog(null)}
          onCreate={async (role: FileRole, name: string, folder: string) => {
            const made = await projectStore.addFile(role, name, folder);
            setDialog(null);
            focusRow(`f:${made.doc}`);
            onOpenFile(made.doc);
          }}
        />
      )}
      {dialog?.kind === "newFolder" && (
        <NameDialog
          title="New folder"
          label="Name"
          folders={folders}
          folder={dialog.under}
          check={(name) => segmentError(name.trim())}
          onCancel={() => setDialog(null)}
          onSave={async (name, under) => {
            const path = under ? `${under}/${name.trim()}` : name.trim();
            const problem = folderError(path);
            if (problem) throw new FieldError(problem, "folder");
            await projectStore.createFolder(path);
            setDialog(null);
            focusRow(`d:${path}`);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`Rename ${dialog.row.name}`}
          label="New name"
          initial={dialog.row.name}
          check={(name) => {
            const named = fileName(name);
            return "error" in named ? named.error : null;
          }}
          onCancel={() => setDialog(null)}
          onSave={async (name) => {
            const row = dialog.row;
            await projectStore.moveFile(row.doc, { name });
            setDialog(null);
            focusRow(row.key);
          }}
        />
      )}
      {dialog?.kind === "renameFolder" && (
        <NameDialog
          title={`Rename the folder ${dialog.row.name}`}
          label="New name"
          initial={dialog.row.name}
          check={(name) => segmentError(name.trim())}
          onCancel={() => setDialog(null)}
          onSave={async (name) => {
            const row = dialog.row;
            const under = row.path.slice(0, Math.max(0, row.path.lastIndexOf("/")));
            await projectStore.renameFolder(row.path, name.trim());
            setDialog(null);
            // The row's key is its path, which the rename has moved.
            focusRow(`d:${under ? `${under}/${name.trim()}` : name.trim()}`);
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <NameDialog
          title={`Move ${dialog.row.name}`}
          folders={folders}
          folder={dialog.row.folder}
          onCancel={() => setDialog(null)}
          onSave={async (_name, folder) => {
            const row = dialog.row;
            await projectStore.moveFile(row.doc, { folder });
            setDialog(null);
            focusRow(row.key);
          }}
        />
      )}
      {dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${dialog.row.name}?`}
          escape="cancel"
          actions={[
            { id: "remove", label: "Remove", danger: true },
            { id: "cancel", label: "Cancel", primary: true },
          ]}
          onAnswer={(id) => {
            const row = dialog.row;
            setDialog(null);
            if (id !== "remove") return;
            const at = rows.findIndex((r) => r.key === row.key);
            const after = rows[at + 1] ?? rows[at - 1];
            void run(async () => {
              const next = await projectStore.removeFile(row.doc);
              onRemoved?.(row.doc, next);
              if (after) focusRow(after.key);
            });
          }}
        >
          <p>
            {removeQuestion(
              documents.find((d) => d.doc === dialog.row.doc)?.triples ?? 0,
              // Text not yet applied in the editor goes too: said with the
              // unsaved changes, read once as the question opens.
              dialog.row.dirty ||
                (projectStore.getSnapshot().activeDoc === dialog.row.doc && projectStore.getSnapshot().editorDraft !== null),
            )}
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "removeFolder" && (
        <ConfirmDialog
          title={`Remove the folder ${dialog.row.name}?`}
          escape="cancel"
          actions={[
            { id: "remove", label: "Remove", danger: true },
            { id: "cancel", label: "Cancel", primary: true },
          ]}
          onAnswer={(id) => {
            const row = dialog.row;
            setDialog(null);
            if (id !== "remove") return;
            const at = rows.findIndex((r) => r.key === row.key);
            const after = rows[at + 1] ?? rows[at - 1];
            void run(async () => {
              await projectStore.removeFolder(row.path);
              if (after) focusRow(after.key);
            });
          }}
        >
          <p>It is empty, so nothing goes with it.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** A refusal the dialog found itself, for one of its fields. */
class FieldError extends Error {
  constructor(message: string, readonly field: "name" | "folder") {
    super(message);
  }
}

/** One name, one folder, or both (New folder, Rename, Move to folder): a
 *  small modal with the sentence of a refusal under its field. */
function NameDialog({
  title,
  label,
  initial = "",
  folders,
  folder = "",
  check,
  onSave,
  onCancel,
}: {
  title: string;
  label?: string;
  initial?: string;
  folders?: string[];
  folder?: string;
  check?: (name: string) => string | null;
  onSave: (name: string, folder: string) => Promise<void>;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState(initial);
  const [where, setWhere] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; folder?: string; form?: string }>({});
  const id = useId();
  const escape = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useDialogTrap(panelRef, headingRef, escape);

  const save = async () => {
    if (busy) return;
    const problem = label ? check?.(name) ?? null : null;
    if (problem) {
      setErrors({ name: problem });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await onSave(name, where);
    } catch (e: unknown) {
      const refusal = pathRefusal(e);
      const field = e instanceof FieldError ? e.field : refusal?.field === "folder" ? "folder" : refusal?.field === "name" ? "name" : "form";
      const message = refusal?.message ?? (e instanceof Error ? e.message : String(e));
      // A folder refusal with no folder field shown belongs to the name.
      setErrors({ [field === "folder" && !folders ? "name" : field]: message });
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={escape} />
      <div ref={panelRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy}>
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="confirm-title">
          {title}
        </h2>
        <form
          className="confirm-body new-file-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {label && (
            <>
              <label htmlFor={`${id}-name`}>{label}</label>
              <input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${id}-name-error` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              {errors.name && <p id={`${id}-name-error`} className="form-error" role="alert">{errors.name}</p>}
            </>
          )}
          {folders && (
            <>
              <label htmlFor={`${id}-folder`}>{label ? "In folder" : "Folder"}</label>
              <select
                id={`${id}-folder`}
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                aria-invalid={errors.folder ? true : undefined}
                aria-describedby={errors.folder ? `${id}-folder-error` : undefined}
              >
                {folderChoices(folders).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {errors.folder && <p id={`${id}-folder-error`} className="form-error" role="alert">{errors.folder}</p>}
            </>
          )}
          {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          <div className="modal-actions">
            <button type="submit" className="primary" aria-disabled={busy}>
              {busy ? "Saving…" : label ? (title.startsWith("Rename") ? "Rename" : "Create") : "Move"}
            </button>
            <button type="button" className="ghost" aria-disabled={busy} onClick={escape}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
