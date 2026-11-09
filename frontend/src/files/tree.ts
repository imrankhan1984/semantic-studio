/*
================================================================================
FILE: frontend/src/files/tree.ts
================================================================================

SUMMARY
    The Files panel's tree (multi-file-projects 5.5, Section 6) as data: the
    rows in order, folders first then files, each with the words a screen
    reader hears, and what may be done with it.

BASIC IDEA
    The project's files and folders arrive as two flat lists of paths. The
    tree is built from both, so an empty folder still has its row, and
    flattened in the order the panel shows: each level's folders by name,
    then its files by name, without case, a folder's children after it only
    while it is expanded. A row's accessible name is its words in one
    sentence -- *equipment.ttl, vocabulary file, unsaved, in vocab* for a
    file, *vocab, folder, 1 file, expanded* for a folder -- so role and
    unsaved state are never colour alone.

    Remove is refused, aria-disabled with its reason, for the project's last
    ontology or vocabulary file and for a folder that is not empty
    (Section 6, Disabled); New file at 100 files the same.

    Pure, so the order and the words are tested without rendering.

INPUTS / INPUT SOURCES
    - The open project's documents and folders, from the project store.

EXPECTED OUTPUT
    - fileRows(): the visible rows, in order.
    - fileLabel(), folderLabel(), removeRefusal(), newFileRefusal(), and
      fileBase / fileFolder for a path's two halves.
================================================================================
*/

import type { FileRole, ProjectDocumentState } from "../types";
import { MAX_FILES } from "./names";

export interface FileRowData {
  kind: "file";
  key: string;
  doc: string;
  path: string;
  name: string;
  folder: string;
  role: FileRole;
  dirty: boolean;
  level: number;
}

export interface FolderRowData {
  kind: "folder";
  key: string;
  path: string;
  name: string;
  /** Files directly in it, and whether anything at all is in it. */
  files: number;
  empty: boolean;
  level: number;
  expanded: boolean;
}

export type TreeRow = FileRowData | FolderRowData;

/** A document's file, from a server before E-16 its id's file. */
export function filePath(d: Pick<ProjectDocumentState, "doc" | "file">): string {
  return d.file ?? (d.doc === "shapes" ? "shapes.ttl" : "model.ttl");
}

export function fileBase(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function fileFolder(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

const ROLE_WORDS: Record<FileRole, string> = {
  ontology: "ontology",
  vocabulary: "vocabulary",
  shapes: "shapes",
};

export function roleWord(role: FileRole): string {
  return ROLE_WORDS[role];
}

/** *equipment.ttl, vocabulary file, unsaved, in vocab*. */
export function fileLabel(row: Pick<FileRowData, "name" | "role" | "dirty" | "folder">): string {
  return [
    row.name,
    `${ROLE_WORDS[row.role]} file`,
    ...(row.dirty ? ["unsaved"] : []),
    ...(row.folder ? [`in ${row.folder}`] : []),
  ].join(", ");
}

/** *vocab, folder, 1 file, expanded*. */
export function folderLabel(row: Pick<FolderRowData, "name" | "files" | "expanded" | "empty">): string {
  const count = row.empty ? "empty" : `${row.files} ${row.files === 1 ? "file" : "files"}`;
  return [row.name, "folder", count, row.expanded ? "expanded" : "collapsed"].join(", ");
}

/** The visible rows: folders first then files at each level, by name;
 *  a folder's rows after it only while it is expanded. */
export function fileRows(
  documents: (Pick<ProjectDocumentState, "doc" | "file" | "dirty"> & { role?: FileRole })[],
  folders: string[],
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const allFolders = new Set<string>();
  for (const folder of folders) {
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) allFolders.add(parts.slice(0, i).join("/"));
  }
  const files = documents.map((d) => {
    const path = filePath(d);
    return {
      doc: d.doc, path, name: fileBase(path), folder: fileFolder(path),
      role: d.role ?? (d.doc === "shapes" ? "shapes" : "ontology") as FileRole, dirty: d.dirty,
    };
  });
  for (const f of files) {
    const parts = f.folder ? f.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) allFolders.add(parts.slice(0, i).join("/"));
  }
  const rows: TreeRow[] = [];
  const visit = (under: string, level: number) => {
    const childFolders = [...allFolders].filter((p) => fileFolder(p) === under && p !== "").sort(byName);
    for (const path of childFolders) {
      const direct = files.filter((f) => f.folder === path).length;
      const empty = !files.some((f) => f.folder === path || f.folder.startsWith(`${path}/`))
        && ![...allFolders].some((p) => p.startsWith(`${path}/`));
      const open = expanded.has(path);
      rows.push({ kind: "folder", key: `d:${path}`, path, name: fileBase(path), files: direct, empty, level, expanded: open });
      if (open) visit(path, level + 1);
    }
    for (const f of files.filter((x) => x.folder === under).sort((a, b) => byName(a.name, b.name))) {
      rows.push({ kind: "file", key: `f:${f.doc}`, level, ...f });
    }
  };
  visit("", 1);
  return rows;
}

/** Why a file cannot be removed, or null (5.5 item 7): the project's last
 *  ontology or vocabulary file stays. */
export function removeRefusal(
  row: FileRowData,
  documents: { doc: string; role?: FileRole }[],
): string | null {
  if (row.role === "shapes") return null;
  const models = documents.filter((d) => (d.role ?? (d.doc === "shapes" ? "shapes" : "ontology")) !== "shapes");
  return models.length <= 1
    ? `${row.name} is the project's last ontology or vocabulary file, so it cannot be removed.`
    : null;
}

export function folderRemoveRefusal(row: FolderRowData): string | null {
  return row.empty ? null : "Only an empty folder can be removed.";
}

/** New file at the limit (Section 6, Disabled). */
export function newFileRefusal(count: number): string | null {
  return count >= MAX_FILES ? `This project has ${MAX_FILES} files, the most it can hold.` : null;
}

/** What the open's folder index said, one sentence each (5.2 items 2 to 4,
 *  Section 6's Error row): files found, entries gone, paths skipped. */
export function noticeLines(notice: {
  found: string[];
  missing: string[];
  skipped: { path: string; reason: string }[];
  wroteModel: boolean;
}): string[] {
  const lines: string[] = [];
  const n = notice.found.length;
  if (n) {
    lines.push(`Found ${n === 1 ? "1 file that was" : `${n} files that were`} added outside Semantic Studio.`);
  }
  for (const file of notice.missing) lines.push(`${file} is no longer in the project folder.`);
  for (const skipped of notice.skipped) lines.push(skipped.reason);
  if (notice.wroteModel) {
    lines.push("No ontology or vocabulary file was left, so an empty model.ttl was written.");
  }
  return lines;
}

/** Remove's question (5.5 item 7), its unsaved changes said too. */
export function removeQuestion(statements: number, dirty: boolean): string {
  const count = `${statements.toLocaleString("en-US")} ${statements === 1 ? "statement leaves" : "statements leave"}`;
  return (
    `It moves to the project's trash; its ${count} the project's views.` +
    (dirty ? " Its unsaved changes go with it." : "")
  );
}

/** The folders a file can go to, the project folder first (5.5 item 5). */
export function folderChoices(folders: string[]): { value: string; label: string }[] {
  return [{ value: "", label: "The project folder" }, ...[...folders].sort(byName).map((f) => ({ value: f, label: f }))];
}
