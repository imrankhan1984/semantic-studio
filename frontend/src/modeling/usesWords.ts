/*
================================================================================
FILE: frontend/src/modeling/usesWords.ts
================================================================================

SUMMARY
    The words for an address other project files use (links-between-files
    5.2, 5.3): the edit section's rename line, and the delete dialog's
    sentence and list. Pure, so the counts and their grammar are tested
    without rendering.

BASIC IDEA
    The server counts, by file, the statements naming the address
    (RenameIri's and DeleteEntity's dry runs, `uses`); these functions say
    them. A file is named by its file name, as every sentence about files
    names it (*equipment.ttl*), never its folder. The noun is said once:
    *3 statements in equipment.ttl and 1 in shapes.ttl*, the same phrase
    editing.py's uses_phrase gives the Turtle editor's warning.

    Nothing from the ontology is interpolated but names, which React
    escapes where they are rendered (requirement 5).

INPUTS / INPUT SOURCES
    - FileUses rows and RenameUses answers (types.ts), and the term's name.

EXPECTED OUTPUT
    - renameLine(answer, name) -> the line under *New identifier*, or null.
    - deleteUses(uses, name) -> the dialog's lead sentence, list and ending.
================================================================================
*/

import type { FileUses, RenameUses } from "../types";

/** A path's last segment: the file's name. */
export function fileName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function joined(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** *3 statements in equipment.ttl and 1 in shapes.ttl*. */
export function usesPhrase(uses: FileUses[]): string {
  return joined(
    uses.map((u, i) =>
      i === 0 ? `${u.count} ${u.count === 1 ? "statement" : "statements"} in ${fileName(u.file)}` : `${u.count} in ${fileName(u.file)}`,
    ),
  );
}

export function totalUses(uses: FileUses[]): number {
  return uses.reduce((sum, u) => sum + u.count, 0);
}

/** The rename line (5.2 items 1, 8, 9): what else the rename changes, the
 *  snapshots that use the old address and do not follow, and the saved
 *  queries that mention it. null when nothing else holds the address. */
export function renameLine(answer: RenameUses, name: string): string | null {
  const sentences: string[] = [];
  if (answer.uses.length > 0) sentences.push(`Also changes ${usesPhrase(answer.uses)}`);
  const n = answer.snapshots.length;
  if (n > 0) {
    sentences.push(
      n === 1
        ? `1 data snapshot uses ${name}; edit its mapping to follow`
        : `${n} data snapshots use ${name}; edit their mappings to follow`,
    );
  }
  const q = answer.queries;
  if (q > 0) {
    const mention = q === 1 ? "1 saved query mentions" : `${q} saved queries mention`;
    if (sentences.length === 0) return `${mention} ${name}; ${q === 1 ? "it is" : "they are"} not changed.`;
    const last = sentences.pop()!;
    sentences.push(`${last}, and ${mention} it`);
  }
  return sentences.length ? sentences.map((s) => `${s}.`).join(" ") : null;
}

/** The delete dialog with uses (5.3 item 3): the lead, one row per file
 *  with its named statements, and the ending. */
export function deleteUses(uses: FileUses[], name: string): { lead: string; rows: string[]; ending: string } {
  const total = totalUses(uses);
  const lead =
    total === 1 ? `1 statement in another file uses ${name}:` : `${total} statements in other files use ${name}:`;
  const rows = uses.map((u) => {
    const named = (u.sample ?? []).map((s) => s.label);
    return `${u.count} in ${fileName(u.file)}${named.length ? ` (${named.join(", ")})` : ""}`;
  });
  const ending = `Deleting ${name} leaves ${total === 1 ? "it" : "them"} pointing at nothing.`;
  return { lead, rows, ending };
}
