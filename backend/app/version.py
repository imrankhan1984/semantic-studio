"""
================================================================================
FILE: backend/app/version.py
================================================================================

SUMMARY
    Which version of Semantic Studio this copy is (launcher-version-check
    5.1, X-15, D-130): the one reader of the release's VERSION.txt, asked by
    `/api/health` in main.py and by the launcher, so the two say the same
    thing without one importing the other.

BASIC IDEA
    release/build.py writes VERSION.txt at the top of the unzipped folder,
    beside `app`: "Semantic Studio 1.1.0" on its first line, then the
    commit. What follows "Semantic Studio " on that first line is the
    version. A copy run from source, or from the Docker image, has no such
    file and is "development".

    The file is read once and kept: the release never changes under a
    running server, and the launcher compares its own answer with the
    running one's, so the two must not be read at different moments of an
    unzip. Nothing here may raise: a start must never fail over a label,
    so an unreadable file is "development" like a missing one.

INPUTS / INPUT SOURCES
    - VERSION.txt in the folder above `app`.

EXPECTED OUTPUT
    - version(): "1.1.0", or "development".
================================================================================
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION.txt"
PREFIX = "Semantic Studio "
DEVELOPMENT = "development"


def read_version(path: Path) -> str:
    """The version a VERSION.txt at `path` names, or "development"."""
    try:
        with open(path, encoding="utf-8") as file:
            first = file.readline()
    except (OSError, ValueError):
        # ValueError covers a file that is not UTF-8 (UnicodeDecodeError).
        return DEVELOPMENT
    first = first.strip()
    if not first.startswith(PREFIX):
        return DEVELOPMENT
    return first[len(PREFIX):].strip() or DEVELOPMENT


@lru_cache(maxsize=1)
def version() -> str:
    return read_version(VERSION_FILE)
