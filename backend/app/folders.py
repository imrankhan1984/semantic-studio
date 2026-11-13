"""
================================================================================
FILE: backend/app/folders.py
================================================================================

SUMMARY
    Which folders a person may put a project in, or open one from
    (projects-anywhere 5.3, D-135), and the folder browser's listing. The
    only module that lists directories for the browser, and the one place a
    folder path from the page is judged.

BASIC IDEA
    A browser cannot hand a page a folder's path, so the app draws its own
    folder browser and the server lists folders for it. Every path that
    arrives (the listing, New project's location, Open project folder,
    Locate) goes through the same three gates, in this order:

    1. `path_error`, on the string alone, before the disk is touched. A
       network path (\\\\server\\share, //server/share, \\\\?\\UNC\\...) or a device
       path (\\\\.\\pipe\\x) would make the server open an SMB connection, and
       Windows offers the user's credentials to it (NTLM), past the network
       broker (requirement 8), so it is refused here, where no filesystem
       call has been made yet; test_folders.py patches os.stat, os.lstat,
       os.scandir and Path.exists to prove it. So is a relative path, `.` or
       `..`, a reserved device name (CON, NUL, COM1...), a colon after the
       drive (an alternate data stream) and a name ending in a dot or a space,
       which Windows quietly strips, so `C:\\Windows.` would be `C:\\Windows`.
       Every `\\\\?\\` form is refused, a drive letter after it too: the folder
       browser never makes one and a person never types one (the spec allows
       `\\\\?\\C:\\`; refusing it is simpler and loses nothing).
    2. `canonical`, on the disk: the path must be a folder reached through
       no link and no junction (each level is lstat-ed), and on Windows its
       8.3 short names are expanded (GetLongPathNameW), so C:\\PROGRA~1 is
       compared as C:\\Program Files. os.path.realpath is not used: it turns
       a mapped drive into the \\\\server\\share it stands for, which gate 1
       would then refuse on the next request.
    3. `refusal`, against the refused-folder table (5.3 item 3), built at
       call time from the environment and the home folder, each root's
       short names expanded as gate 2 expands the path: the operating
       system's folders, AppData, other people's folders under C:\\Users,
       the app's data folder and the folder the app runs from, and anything
       under one of them. Names are compared with os.path.normcase, so case
       never matters on Windows.

    A drive root (C:\\, /) can be browsed through but never chosen; nor can a
    folder inside a project or one holding a project below it (5.3 item 5),
    since the folder index would read one project's files as the other's.

    The listing returns at most 1,000 folders and the true total
    (convention 6), filtered on the server by the start of the name. Files,
    names starting with ".", hidden and system folders, links, junctions
    and refused folders are never listed.

INPUTS / INPUT SOURCES
    - A folder path as text, from the page.
    - The environment (SystemRoot, ProgramFiles, ProgramData...), the home
      folder, the data folder, and the folders on disk.

EXPECTED OUTPUT
    - path_error(raw) -> a sentence or None, with no filesystem call.
    - check(raw, mode) -> the canonical Path, or FolderRefused (422) /
      FolderNotFound (404), each with one sentence.
    - listing(raw, filter, mode) -> the browser's answer (8.2).
    - folder_name(project name) -> the subfolder New project makes.
================================================================================
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from typing import Callable, Optional

# How many folders one listing returns (8.3); the true total always comes
# with it.
LISTING_MAX = 1000
# How deep "holds a project below it" looks: the folder index reads three
# levels (MAX_LEVELS in projects.py), and a project deeper than that would
# not be read as this one's files. Bounded too in folders visited, so a
# folder of a million subfolders cannot hold a request.
HOLDS_DEPTH = 4
HOLDS_VISIT_MAX = 5000
MANIFEST = "project.json"

WINDOWS = os.name == "nt"

DEVICES = {"con", "prn", "aux", "nul", "conin$", "conout$", "clock$",
           *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10)),
           *(f"com{c}" for c in "¹²³"), *(f"lpt{c}" for c in "¹²³")}
# Folder names refused wherever they appear (5.3 item 3).
REFUSED_NAMES = {"$recycle.bin", "system volume information"}
POSIX_REFUSED = ("/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32",
                 "/proc", "/sbin", "/sys", "/usr", "/var", "/System", "/Library")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
DRIVE = re.compile(r"[A-Za-z]:")

IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4

NOT_ABSOLUTE = "Choose a folder from the list: a path has to start at a drive or at /."
NETWORK = "Semantic Studio cannot use a network folder by its path. Map it to a drive letter first."
DEVICE = "That path names a device, not a folder."
BAD_NAME = "That path holds a name a folder cannot have."
NOT_FOUND = "That folder is not there any more."
NO_ACCESS = "Semantic Studio cannot read that folder."
LINK = "That folder is reached through a link, so Semantic Studio does not use it."
SYSTEM = "That is one of your computer's own folders. Choose a folder of your own."
APP_DATA = "That folder belongs to Semantic Studio itself. Choose a folder of your own."
OTHER_USER = "That folder belongs to another person on this computer."
DRIVE_ROOT = "Choose a folder on this drive, not the whole drive."
NO_PROJECT = "This folder holds no project.json. Open the folder of a project."


class FolderRefused(ValueError):
    """A path the rules refuse, with the sentence saying why (422)."""


class FolderNotFound(LookupError):
    """A path that is not a folder on this computer (404)."""


# --- what the table is built from, read at call time --------------------------
#
# Functions rather than constants so a test can move them: the tests' own
# temporary folders sit under AppData on Windows, which is refused.


def home() -> Path:
    return Path.home()


_data_dir: Optional[Path] = None


def set_data_dir(path: Path) -> None:
    """The data folder the project store was pointed at (ProjectStore.
    configure), so the table refuses the one in use, a test's included."""
    global _data_dir
    _data_dir = Path(path)


def data_dir() -> Path:
    if _data_dir is not None:
        return _data_dir
    from .store import default_data_dir

    return Path(default_data_dir())


def app_dir() -> Path:
    """The folder the app runs from: the release's folder (it holds app/),
    or backend/ in development."""
    return Path(__file__).resolve().parent.parent


# --- gate 1: the string alone ---------------------------------------------------


def _segments(raw: str) -> tuple[str, list[str]]:
    """(anchor, names): the drive or "/" and the names after it."""
    if WINDOWS:
        anchor, rest = raw[:2], raw[2:]
        return anchor.upper() + "\\", [s for s in re.split(r"[\\/]", rest) if s != ""]
    return "/", [s for s in raw.split("/") if s != ""]


def path_error(raw: object) -> Optional[str]:
    """Why a folder path is refused before any filesystem call, or None.

    Pure string work: nothing here may stat, list or open, because the
    first touch of a network path is the SMB connection (5.3 item 4)."""
    if not isinstance(raw, str) or not raw or len(raw) > 1024:
        return NOT_ABSOLUTE
    if CONTROL.search(raw):
        return BAD_NAME
    # Both slashes on every platform: on Windows // is UNC, and on POSIX a
    # leading // is implementation-defined (and SMB on some systems).
    if raw[:2] in ("\\\\", "//", "\\/", "/\\"):
        if raw[:4] in ("\\\\.\\", "//./", "\\\\?\\", "//?/") and not raw[4:7].upper().startswith("UNC"):
            return DEVICE
        return NETWORK
    if WINDOWS:
        if not (DRIVE.fullmatch(raw[:2]) and raw[2:3] in ("\\", "/")):
            return NOT_ABSOLUTE
    elif not raw.startswith("/"):
        return NOT_ABSOLUTE
    _anchor, names = _segments(raw)
    for name in names:
        if name in (".", ".."):
            return BAD_NAME
        if WINDOWS:
            if ":" in name or any(c in name for c in '<>"|?*'):
                return BAD_NAME
            if name.endswith((".", " ")):
                return BAD_NAME
            if name.split(".")[0].rstrip(" ").casefold() in DEVICES:
                return DEVICE
    return None


def normal(raw: str) -> Path:
    """The path as the rules compare it: separators made one, nothing on
    disk asked. Call only after path_error said None."""
    anchor, names = _segments(raw)
    return Path(anchor, *names)


def key(path: Path) -> str:
    """The comparison form: os.path.normcase, so case never matters on
    Windows and always does on Linux."""
    return os.path.normcase(str(path))


def is_under(path: Path, root: Path) -> bool:
    """path is root or inside it, compared by key."""
    p, r = key(path), key(root).rstrip("\\/")
    sep = "\\" if WINDOWS else "/"
    return p == r or p.startswith(r + sep)


# --- gate 2: the disk ---------------------------------------------------------------


def _is_link(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    # A junction (a mount point). Only these two: OneDrive's own folders
    # carry other reparse tags and are folders like any other.
    return getattr(st, "st_reparse_tag", 0) == IO_REPARSE_TAG_MOUNT_POINT


def _long_name(path: Path) -> Path:
    """On Windows, every 8.3 short name in the path expanded. The path is
    unchanged where Windows cannot say (it is gone)."""
    if not WINDOWS:
        return path
    import ctypes

    text = str(path)
    size = ctypes.windll.kernel32.GetLongPathNameW(text, None, 0)
    if not size:
        return path
    buffer = ctypes.create_unicode_buffer(size)
    if not ctypes.windll.kernel32.GetLongPathNameW(text, buffer, size):
        return path
    return Path(buffer.value)


def canonical(raw: str) -> Path:
    """The folder a checked path names, on disk: a folder, reached through
    no link and no junction, its short names expanded. FolderRefused or
    FolderNotFound otherwise."""
    reason = path_error(raw)
    if reason is not None:
        raise FolderRefused(reason)
    path = normal(raw)
    try:
        if not path.is_dir():
            raise FolderNotFound(NOT_FOUND)
    except OSError as exc:
        raise FolderNotFound(NOT_FOUND) from exc
    path = _long_name(path)
    for level in [path, *path.parents]:
        if _is_link(level):
            raise FolderRefused(LINK)
    return path


# --- gate 3: the refused-folder table ---------------------------------------------


def refused_roots() -> list[tuple[Path, str]]:
    """Every refused folder and the sentence for it (5.3 item 3), built now
    from the environment: one table, tested entry by entry.

    Every root is expanded as canonical() expands the chosen path. The
    environment may name a folder by its 8.3 short name (GitHub's Windows
    runner has TEMP under C:\\Users\\RUNNER~1), and a short root never
    prefixes a long path: the data folder under it went unrefused."""
    roots: list[tuple[Path, str]] = []
    if WINDOWS:
        for variable in ("SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)",
                         "ProgramW6432", "ProgramData"):
            value = os.environ.get(variable)
            if value and path_error(value) is None:
                roots.append((normal(value), SYSTEM))
        roots.append((home() / "AppData", SYSTEM))
    else:
        roots += [(Path(p), SYSTEM) for p in POSIX_REFUSED]
    roots.append((data_dir(), APP_DATA))
    roots.append((app_dir(), APP_DATA))
    return [(_long_name(root), sentence) for root, sentence in roots]


def users_dir() -> Optional[Path]:
    """C:\\Users, whose folders other than the person's own are refused,
    expanded as the refused roots are."""
    if not WINDOWS:
        return None
    return _long_name(home().parent)


def refusal(path: Path) -> Optional[str]:
    """Why a folder may be neither listed nor chosen, or None."""
    _anchor, names = _segments(str(path))
    if any(n.casefold() in REFUSED_NAMES for n in names):
        return SYSTEM
    for root, sentence in refused_roots():
        if is_under(path, root):
            return sentence
    users = users_dir()
    if users is not None and is_under(path, users) and key(path) != key(users):
        if not is_under(path, _long_name(home())):
            return OTHER_USER
    return None


def child_refusal(folder: Path) -> Callable[[Path], bool]:
    """A test for the children of one folder that is not itself refused,
    the table read once: a child is refused only if it is a refused folder
    itself, has a refused name, or is another person's folder. Asking
    refusal() of each child built the table 5,000 times (1.4 s, Section 10's
    budget is 300 ms)."""
    roots = {key(root) for root, _sentence in refused_roots()}
    users = users_dir()
    in_users = users is not None and key(folder) == key(users)
    mine = key(_long_name(home())) if in_users else None

    def refused(child: Path) -> bool:
        if child.name.casefold() in REFUSED_NAMES or key(child) in roots:
            return True
        return in_users and key(child) != mine

    return refused


def is_root(path: Path) -> bool:
    return path.parent == path


def _hidden(entry: os.DirEntry) -> bool:
    if not WINDOWS:
        return False
    try:
        attributes = entry.stat(follow_symlinks=False).st_file_attributes
    except (OSError, AttributeError):
        return True
    return bool(attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM))


# --- projects near a folder -----------------------------------------------------


def project_name(folder: Path) -> str:
    """A project's name for a sentence: its manifest's, read capped, else
    the folder's own name. Text only; never trusted for anything else."""
    try:
        with open(folder / MANIFEST, "rb") as handle:
            data = json.loads(handle.read(64 * 1024).decode("utf-8"))
        name = data.get("name") if isinstance(data, dict) else None
        if isinstance(name, str) and name.strip() and not CONTROL.search(name):
            return name.strip()[:120]
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    return folder.name


def has_manifest(folder: Path) -> bool:
    try:
        return (folder / MANIFEST).is_file()
    except OSError:
        return False


def enclosing(path: Path, include_self: bool = True) -> Optional[Path]:
    """The project folder this one is, or is inside, if any."""
    levels = [path, *path.parents] if include_self else list(path.parents)
    for level in levels:
        if has_manifest(level):
            return level
    return None


def held_below(path: Path) -> Optional[Path]:
    """A project folder under this one, within HOLDS_DEPTH levels, if any.
    Links, dot names and refused folders are not followed."""
    visited = 0
    frontier = [path]
    for _depth in range(HOLDS_DEPTH):
        following = []
        for folder in frontier:
            try:
                children = list(os.scandir(folder))
            except OSError:
                continue
            for entry in children:
                visited += 1
                if visited > HOLDS_VISIT_MAX:
                    return None
                if entry.name.startswith(".") or entry.is_symlink():
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                child = Path(entry.path)
                if _is_link(child):
                    continue
                if has_manifest(child):
                    return child
                following.append(child)
        frontier = following
    return None


# --- the checks each door asks --------------------------------------------------


def choose_reason(path: Path, mode: str) -> Optional[str]:
    """Why an already canonical, listable folder cannot be chosen in this
    mode, or None: create (New project's parent) or open (a project)."""
    reason = refusal(path)
    if reason is not None:
        return reason
    if mode == "open":
        if not has_manifest(path):
            return NO_PROJECT
        outer = enclosing(path, include_self=False)
        if outer is not None:
            return f"That folder is inside the project {project_name(outer)}."
        inner = held_below(path)
        if inner is not None:
            return f"That folder holds the project {project_name(inner)}."
        return None
    if is_root(path):
        return DRIVE_ROOT
    users = users_dir()
    if users is not None and key(path) == key(users):
        return OTHER_USER
    outer = enclosing(path)
    if outer is not None:
        return f"That folder is inside the project {project_name(outer)}."
    return None


def check(raw: str, mode: str) -> Path:
    """The folder a door may use, or FolderRefused / FolderNotFound: every
    check of 5.3 items 3 to 5, repeated on the server whatever the listing
    said (5.4 item 2)."""
    path = canonical(raw)
    reason = choose_reason(path, mode)
    if reason is not None:
        raise FolderRefused(reason)
    return path


# --- the listing (8.2) --------------------------------------------------------------


def _parts(path: Path) -> list[dict]:
    out = []
    for level in reversed([path, *path.parents]):
        name = level.name or str(level).rstrip("\\/") or "/"
        out.append({"name": name, "path": str(level)})
    return out


def places() -> list[dict]:
    """Home folder, Desktop and Documents when they exist, and each drive
    on Windows (/ elsewhere)."""
    out = []
    here = home()
    for name, folder in (("Home folder", here), ("Desktop", here / "Desktop"), ("Documents", here / "Documents")):
        try:
            if folder.is_dir() and not _is_link(folder) and refusal(folder) is None:
                out.append({"name": name, "path": str(folder)})
        except OSError:
            continue
    if WINDOWS:
        import ctypes

        mask = ctypes.windll.kernel32.GetLogicalDrives()
        for i in range(26):
            if mask & (1 << i):
                letter = chr(ord("A") + i)
                out.append({"name": f"{letter}:", "path": f"{letter}:\\"})
    else:
        out.append({"name": "This computer (/)", "path": "/"})
    return out


def listing(raw: Optional[str], filter_text: str = "", mode: str = "create") -> dict:
    """The folder browser's answer for one folder (8.2): its path bar, its
    parent, the places, at most LISTING_MAX subfolders sorted by name with
    the true total, and whether it can be chosen in this mode."""
    path = canonical(raw) if raw else canonical(str(home()))
    reason = refusal(path)
    if reason is not None:
        raise FolderRefused(reason)
    needle = (filter_text or "").casefold()
    found: list[tuple[str, Path]] = []
    try:
        entries = list(os.scandir(path))
    except PermissionError as exc:
        raise FolderRefused(NO_ACCESS) from exc
    except OSError as exc:
        raise FolderNotFound(NOT_FOUND) from exc
    refused = child_refusal(path)
    for entry in entries:
        name = entry.name
        if name.startswith(".") or CONTROL.search(name):
            continue
        if needle and not name.casefold().startswith(needle):
            continue
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            junction = getattr(entry, "is_junction", None)
            if junction is not None and junction():
                continue
        except OSError:
            continue
        if _hidden(entry):
            continue
        child = Path(entry.path)
        if refused(child):
            continue
        found.append((name.casefold(), child))
    found.sort(key=lambda item: (item[0], str(item[1])))
    shown = found[:LISTING_MAX]
    reason = choose_reason(path, mode)
    return {
        "path": str(path),
        "parts": _parts(path),
        "parent": None if is_root(path) else str(path.parent),
        "places": places(),
        "folders": [{"name": child.name, "path": str(child), "project": has_manifest(child)} for _k, child in shown],
        "total": len(found),
        "truncated": len(found) > len(shown),
        "project": has_manifest(path),
        "choosable": reason is None,
        "reason": reason,
    }


# --- New project's subfolder name (5.2 item 2) ------------------------------------

_FOLDER_CHAR = re.compile(r"[^A-Za-z0-9 _.-]")


def folder_name(name: str) -> str:
    """The subfolder New project makes from the project's name: any
    character segment_error does not allow becomes a hyphen, cut to 64
    characters; a name Windows keeps for a device is FolderRefused."""
    text = _FOLDER_CHAR.sub("-", (name or "").strip())[:64]
    text = text.rstrip(". ")
    text = re.sub(r"^[^A-Za-z0-9]+", "", text)
    if not text:
        raise FolderRefused("Give the project a name with a letter or a digit in it, for its folder.")
    if text.split(".")[0].rstrip(" ").casefold() in DEVICES:
        raise FolderRefused(f"{text} is a name Windows keeps for a device. Choose another name.")
    return text
