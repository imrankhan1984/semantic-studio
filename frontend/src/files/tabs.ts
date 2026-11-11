/*
================================================================================
FILE: frontend/src/files/tabs.ts
================================================================================

SUMMARY
    The tab strip's rows (multi-file-projects 5.9, D-132) as data: one row
    per open file, in the order opened, each with the name shown, the folder
    where two open files share a name, its unsaved state, and the words a
    screen reader hears; and the two pure halves of remembering the open
    tabs per project.

BASIC IDEA
    A tab is a file the person opened, not a file the project holds, so the
    order is the order of opening and an id the project no longer has simply
    drops out (a file removed while its tab was open). Two files of the same
    name in different folders show their folders, and only then: a strip of
    "model.ttl (at the project folder)" would say nothing to the one file
    that needs no telling.

    An accessible name carries the folder whenever there is one, as a Files
    row does, and the word *unsaved* where the dot is, so unsaved state is
    never colour alone.

    The browser's memory is a convenience: `tabsKey` names it per project
    and `keptTabs` reads whatever came back, keeping only ids the project
    still holds, in the order stored. The store does the storage itself, in
    try/catch; without it the project opens on its first file (5.9 item 5).

INPUTS / INPUT SOURCES
    - The open project's documents and the store's list of open ids.

EXPECTED OUTPUT
    - tabRows(): the strip, in order; tabLabel(): one row's words;
      tabsKey(), keptTabs(): the remembered tabs.
================================================================================
*/

import type { FileRole, ProjectDocumentState } from "../types";
import { fileBase, fileFolder, filePath } from "./tree";

export interface TabRowData {
  doc: string;
  path: string;
  name: string;
  folder: string;
  role: FileRole;
  dirty: boolean;
  /** Another open tab holds a file of this name, so the folder shows. */
  showFolder: boolean;
  label: string;
}

/** *equipment.ttl, in vocab, unsaved*: the folder whenever there is one,
 *  as a Files row says it, and the word beside the dot. */
export function tabLabel(row: Pick<TabRowData, "name" | "folder" | "dirty">): string {
  return [row.name, ...(row.folder ? [`in ${row.folder}`] : []), ...(row.dirty ? ["unsaved"] : [])].join(", ");
}

/** One tab per open file, in the order opened; an id the project no longer
 *  holds is left out (5.9 item 1). */
export function tabRows(
  documents: (Pick<ProjectDocumentState, "doc" | "file" | "dirty"> & { role?: FileRole })[],
  openDocs: readonly string[],
): TabRowData[] {
  const rows = openDocs
    .map((doc) => documents.find((d) => d.doc === doc))
    .filter((d): d is (typeof documents)[number] => d !== undefined)
    .map((d) => {
      const path = filePath(d);
      return {
        doc: d.doc,
        path,
        name: fileBase(path),
        folder: fileFolder(path),
        role: d.role ?? (d.doc === "shapes" ? "shapes" : "ontology") as FileRole,
        dirty: d.dirty,
      };
    });
  const shared = new Set(
    rows.filter((row, at) => rows.some((other, i) => i !== at && other.name === row.name)).map((row) => row.name),
  );
  return rows.map((row) => ({
    ...row,
    showFolder: shared.has(row.name) && row.folder !== "",
    label: tabLabel(row),
  }));
}

/** Where one project's open tabs are remembered. A browser convenience: it
 *  changes nothing stored, and losing it opens the project on its first
 *  file. */
export function tabsKey(pid: string): string {
  return `semantic-studio-tabs-${pid}`;
}

/** The remembered ids worth opening: whatever parsed, in the order stored,
 *  keeping only ids the project still holds and no id twice. */
export function keptTabs(stored: unknown, documents: { doc: string }[]): string[] {
  if (!Array.isArray(stored)) return [];
  const held = new Set(documents.map((d) => d.doc));
  const kept: string[] = [];
  for (const doc of stored) {
    if (typeof doc === "string" && held.has(doc) && !kept.includes(doc)) kept.push(doc);
  }
  return kept;
}
