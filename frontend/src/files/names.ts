/*
================================================================================
FILE: frontend/src/files/names.ts
================================================================================

SUMMARY
    The name rule of multi-file-projects 8.3, as the New file and Rename
    dialogs check it before they send: one file or folder name, a file name
    with .ttl added when left off, a folder path, and a file id.

BASIC IDEA
    The server is the rule (projects.py's segment_error, folder_parts and
    file_name) and checks every name again; this copy only lets a dialog say
    the sentence beside its field without a round trip. The two are held to
    one table, names.table.json, which backend/tests/test_multi_file.py and
    names.test.ts both read, so they cannot drift (as naming/address.ts and
    naming.py share theirs).

    The sentences are the server's, word for word: a refusal reads the same
    whichever side found it.

INPUTS / INPUT SOURCES
    - A name or path as typed.

EXPECTED OUTPUT
    - segmentError, fileName, folderError: a sentence, or null when it
      passes; fileName also gives the name with .ttl.
    - isDocId: whether a string is an id of the shape the server issues.
================================================================================
*/

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
// What the app keeps in a project folder for itself (5.1 item 1), compared
// without case.
const RESERVED = new Set(["project.json", "queries", "data", ".draft", ".trash"]);
const RESERVED_SUFFIXES = [".layout.json", ".original.ttl"];
const DEVICES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);
export const MAX_LEVELS = 3;
export const MAX_FILES = 100;
const DOC_ID = /^(model|shapes|f[0-9a-f]{8})$/;

/** Why one name breaks 8.3, or null. */
export function segmentError(name: string): string | null {
  if (!SEGMENT.test(name)) {
    return (
      "A name starts with a letter or a digit and uses only letters, digits, " +
      "spaces, dots, hyphens and underscores, up to 64 characters."
    );
  }
  if (name.endsWith(".") || name.endsWith(" ")) return "A name cannot end in a dot or a space.";
  const folded = name.toLowerCase();
  if (RESERVED.has(folded) || RESERVED_SUFFIXES.some((s) => folded.endsWith(s))) {
    return `${name} is a name Semantic Studio keeps for itself.`;
  }
  if (DEVICES.has(folded.split(".")[0])) return `${name} is a name Windows keeps for a device.`;
  return null;
}

/** A typed file name as New file takes it: trimmed, .ttl added when left
 *  off, then held to the rule. */
export function fileName(typed: string): { name: string } | { error: string } {
  let name = typed.trim();
  if (!name) return { error: "A file needs a name." };
  if (!name.toLowerCase().endsWith(".ttl")) name += ".ttl";
  const error = segmentError(name);
  return error ? { error } : { name };
}

/** Why a folder path breaks 8.3, or null; "" is the project folder. */
export function folderError(folder: string): string | null {
  if (folder === "") return null;
  if (folder.includes("\\") || folder.startsWith("/") || folder.endsWith("/")) {
    return "A folder is written with / between its names, inside the project.";
  }
  const parts = folder.split("/");
  for (const part of parts) {
    const error = segmentError(part);
    if (error) return error;
  }
  if (parts.length > MAX_LEVELS) return `A project's folders go at most ${MAX_LEVELS} levels deep.`;
  return null;
}

/** An id of the shape the server issues: model, shapes or f and eight hex. */
export function isDocId(value: string): boolean {
  return DOC_ID.test(value);
}
