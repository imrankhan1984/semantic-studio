/*
================================================================================
FILE: frontend/src/projects/folderWords.ts
================================================================================

SUMMARY
    The words of projects anywhere (projects-anywhere 5.2 to 5.6, Section 6):
    the folder browser's sentences, New project's Location sentence, a card's
    folder line and its missing state, Remove from Home's question, and the
    notices after Open project folder, Locate… and Duplicate. Pure.

BASIC IDEA
    One module so every sentence reads the same wherever it is said, and so
    a component can be tested for what it shows without its sentences
    written twice. The subfolder New project makes from a project's name is
    the server's rule (folders.folder_name), copied here only so the form
    can say *The project will be made in D:\Work\Motor catalogue.* before
    Create; the two are held to one table, folderName.table.json, which
    backend/tests/test_project_locations.py reads too.

    A path is joined with the separator the folder itself uses (a Windows
    path has a backslash), never one guessed from the browser.

INPUTS / INPUT SOURCES
    - Paths and names as the server gave them.

EXPECTED OUTPUT
    - Sentences, and folderName (null when the name cannot make a folder).
================================================================================
*/

const DEVICES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "conin$",
  "conout$",
  "clock$",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
  ..."¹²³".split("").flatMap((c) => [`com${c}`, `lpt${c}`]),
]);

/** The subfolder New project makes from a project name (5.2 item 2), or
 *  null when the name cannot make one: any character a file name may not
 *  hold becomes a hyphen, cut to 64 characters, leading signs dropped, a
 *  trailing dot or space dropped, and a name Windows keeps for a device
 *  refused. folders.py's folder_name, held to the same table. */
export function folderName(name: string): string | null {
  // `u`: one hyphen per character, an emoji included, as Python counts.
  let text = name
    .trim()
    .replace(/[^A-Za-z0-9 _.-]/gu, "-")
    .slice(0, 64);
  text = text.replace(/[. ]+$/, "").replace(/^[^A-Za-z0-9]+/, "");
  if (!text) return null;
  if (DEVICES.has(text.split(".")[0].replace(/ +$/, "").toLowerCase())) return null;
  return text;
}

/** The separator a path uses: a backslash on Windows, else a slash. */
export function separator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

/** A folder and a name inside it. */
export function joinPath(parent: string, name: string): string {
  const sep = separator(parent);
  return parent.endsWith(sep) ? parent + name : parent + sep + name;
}

/** Under New project's Location group (5.2 item 2). */
export function willBeMadeIn(parent: string, name: string): string {
  const folder = folderName(name);
  if (!folder) return "Give the project a name with a letter or a digit in it, for its folder.";
  return `The project will be made in ${joinPath(parent, folder)}.`;
}

/** Create's reason while A folder you choose has no folder yet. */
export const CHOOSE_A_FOLDER = "Choose a folder for the project, or keep Semantic Studio's folder.";

/** The browser's live region (Section 6). */
export function readingFolder(path: string): string {
  return `Reading ${path}…`;
}

export function folderAnnounced(path: string, total: number): string {
  return `${path}, ${total.toLocaleString()} ${total === 1 ? "folder" : "folders"}`;
}

/** Past the listing cap (5.3 item 6, convention 6). */
export function showingSome(shown: number, total: number): string {
  return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} folders. Type the start of a name to narrow the list.`;
}

export const NO_FOLDERS = "No folders here.";
export const NO_MATCH = "No folder here starts with that.";

/** The card's second line for a project in a chosen folder (Section 6). */
export function folderLine(folder: string): string {
  return `In ${folder}`;
}

/** A registered project whose folder is gone (5.5 item 1). */
export function missingLine(folder: string): string {
  return `Folder not found: ${folder}`;
}

/** Remove from Home's question (5.6 item 1). */
export function removeQuestion(name: string, folder: string): string {
  return (
    `Remove ${name} from Home? Its folder ${folder} stays as it is. ` +
    "You can open it again with Open project folder."
  );
}

export function removedNotice(name: string, folder: string): string {
  return `Removed ${name} from Home. Its folder ${folder} is as it was.`;
}

/** After Open project folder (5.4 item 4). */
export function addedNotice(name: string): string {
  return `${name} is on Home now. Open it from its card.`;
}

/** After Locate… (5.5 item 2): the name it was known by, and the found one. */
export function foundNotice(was: string, found: string): string {
  return found === was ? `Found ${found}.` : `Found ${found} in that folder.`;
}

/** After Duplicate of a project in a chosen folder (5.6 item 4). */
export function copiedNotice(copy: string): string {
  return `Copied to Semantic Studio's folder as ${copy}.`;
}

/** A project's folder gone while it is open (5.5 item 4). */
export function goneWhileOpen(name: string): string {
  return `The folder of ${name} is no longer there. Your unsaved changes are kept in this window until it is found.`;
}

/** The folder browser's action, by mode (5.3 item 7). */
export function actionLabel(mode: "create" | "open"): string {
  return mode === "create" ? "Choose this folder" : "Open this project";
}

export function browserTitle(mode: "create" | "open"): string {
  return mode === "create" ? "Choose a folder" : "Open a project folder";
}
