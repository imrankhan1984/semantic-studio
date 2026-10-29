"""
================================================================================
FILE: backend/app/settings.py
================================================================================

SUMMARY
    The three limits a person can change in Settings → Limits (home-and-settings
    5.4, D-120): the largest file to load, the longest time to read a file, and
    the items drawn when a graph opens. The one place every reader of those
    limits asks, at call time, and the one writer of settings.json in the data
    folder.

BASIC IDEA
    Each limit has a default, a fixed range and the environment variables that
    used to be its only control. A value is decided in this order, on every
    read:

      1. Its path's environment variable, when set. An administrator's choice
         is never overridden from the page, and an environment value is not
         held to the range: an install that needs 300 MB keeps it, as before.
      2. The saved value in settings.json, when it is inside the range.
      3. The default.

    *Largest file* is one limit over two variables, the upload's and the
    fetch's. Either being set makes the whole limit read-only, but each path
    still honours only its own: a set upload variable governs uploads, and
    URL loads take the page's value unless the fetch variable is set too.
    net_guard's JSON-LD context cap reads the fetch value, on purpose: two
    numbers for "bytes pulled from a URL" would drift.

    Nothing is read at import. The readers are functions, so a saved change
    applies to the next load or the next graph without a restart, and a test
    moves a limit by replacing the function. The saved values are held in
    memory once read; `update` writes the file and the memory together, under
    one lock.

    The range is the security control (Section 9): `update` refuses a value
    outside it, and a settings.json edited by hand gets the same check when
    read, a value outside the range falling back on its default. A damaged
    file reads as no file: the failure mode is the defaults, never no limit.

INPUTS / INPUT SOURCES
    - The environment: SEMANTIC_STUDIO_MAX_UPLOAD_BYTES,
      SEMANTIC_STUDIO_MAX_FETCH_BYTES, SEMANTIC_STUDIO_PARSE_TIMEOUT and
      SEMANTIC_STUDIO_GRAPH_NODE_BUDGET, read on every call.
    - settings.json in the data folder, named by `configure` (store.py).
    - A PUT body's values, through routers/settings.py.

EXPECTED OUTPUT
    - upload_bytes(), fetch_bytes(), parse_timeout(), graph_budget(): the
      limits in force now.
    - describe(): the three limits as Settings shows them, with value,
      default, range, unit and source ("default", "settings", "environment").
    - update(): the new values saved, or LimitOutOfRange (422) or
      SetByEnvironment (409) with nothing written.
    - too_large_detail(), too_slow_message() and raise_hint(): the refusal
      sentences of 5.5, which say where to raise a limit or that the
      administrator set it.
================================================================================
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

MB = 1024 * 1024

UPLOAD_VARIABLE = "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"
FETCH_VARIABLE = "SEMANTIC_STUDIO_MAX_FETCH_BYTES"
TIMEOUT_VARIABLE = "SEMANTIC_STUDIO_PARSE_TIMEOUT"
BUDGET_VARIABLE = "SEMANTIC_STUDIO_GRAPH_NODE_BUDGET"


@dataclass(frozen=True)
class Limit:
    key: str
    name: str
    unit: str
    default: int
    minimum: int
    maximum: int
    variables: tuple[str, ...]


# The defaults are the numbers routers/ontologies.py's constants held, for the
# reasons they carried there:
#
#   * 50 MB was chosen against the catalogue the application itself suggests,
#     whose largest entry was then the JUHO thesaurus at about 26 MB: a default
#     that refused content the interface recommends would be a bug rather than
#     a control. The catalogue's largest is now FIBO at about 5 MB, so the
#     headroom is wider than the argument requires -- deliberately left alone,
#     because the cap protects the arbitrary public URL a user types.
#   * 60 s is roughly ten times the 5.4 seconds measured for 400,000 triples,
#     which leaves room for slower machines and denser formats (RDF/XML).
#   * 2,000 nodes: 18,717 left the tab unresponsive for over 95 seconds and it
#     never recovered. 2,000 is a safety net rather than an optimum, roughly
#     nine times below the observed failure.
#
# The ceilings are the point of the ranges: 200 MB and 600 s bound the
# abandoned parse work D-013 accepted (the two limits hold each other up), and
# 20,000 is MAX_GRAPH_NODE_BUDGET, which stays a constant.
LIMITS: dict[str, Limit] = {
    "largestFile": Limit(
        "largestFile", "Largest file to load", "MB", 50, 1, 200,
        (UPLOAD_VARIABLE, FETCH_VARIABLE),
    ),
    "readTime": Limit(
        "readTime", "Longest time to read a file", "s", 60, 10, 600, (TIMEOUT_VARIABLE,),
    ),
    "firstDrawing": Limit(
        "firstDrawing", "Items drawn when a graph opens", "items", 2000, 100, 20000,
        (BUDGET_VARIABLE,),
    ),
}

# The body is three numbers; 16 KB is generous and still bounded (Section 9).
BODY_MAX_BYTES = 16 * 1024
BODY_TOO_LARGE = "A settings change is at most 16 KB."

FILE_NAME = "settings.json"

_lock = threading.Lock()
_path: Optional[Path] = None
_saved: Optional[dict[str, int]] = None  # None until first read


class LimitOutOfRange(ValueError):
    """A value outside its range, or not a whole number (maps to 422)."""

    def __init__(self, limit: Limit) -> None:
        super().__init__(
            f"{limit.name} must be a whole number from {limit.minimum:,} to "
            f"{limit.maximum:,} {limit.unit}."
        )
        self.limit = limit


class SetByEnvironment(Exception):
    """A change to a limit an environment variable owns (maps to 409)."""

    def __init__(self, limit: Limit, variables: list[str]) -> None:
        super().__init__(
            f"{limit.name} is set by the administrator ({', '.join(variables)}) "
            "and cannot be changed here."
        )
        self.limit = limit


class UnknownSetting(ValueError):
    """A key that is not one of the three limits (maps to 422)."""


def configure(data_dir: Optional[Path]) -> None:
    """Point at the data folder; the saved values are read again from it."""
    global _path, _saved
    with _lock:
        _path = Path(data_dir) / FILE_NAME if data_dir else None
        _saved = None


def data_dir() -> Optional[Path]:
    return _path.parent if _path else None


def reset() -> None:
    """Forget every saved value and remove the file. For tests."""
    global _saved
    with _lock:
        if _path is not None:
            try:
                _path.unlink()
            except FileNotFoundError:
                pass
        _saved = {}


# --- environment ------------------------------------------------------------


def _env(name: str) -> Optional[str]:
    """The variable's text when set. Empty counts as unset, as it always has."""
    raw = os.environ.get(name)
    return raw if raw else None


def _env_number(name: str, default: float, cast) -> float:
    """A set variable's positive value, or the default for nonsense.

    Nonsense keeps the default the constant always fell back on, not the
    page's value: the variable is still set, so the administrator owns it.
    """
    raw = _env(name)
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def variables_set(key: str) -> list[str]:
    return [name for name in LIMITS[key].variables if _env(name) is not None]


def settable(key: str) -> bool:
    """Whether the page may change this limit: none of its variables set."""
    return not variables_set(key)


# --- saved values -------------------------------------------------------------


def _in_range(limit: Limit, value: object) -> bool:
    # bool is an int in Python; true is not a number of megabytes.
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and limit.minimum <= value <= limit.maximum
    )


def _read_file() -> dict[str, int]:
    if _path is None or not _path.exists():
        return {}
    try:
        data = json.loads(_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # A damaged file is no file: the defaults, never no limit.
        return {}
    if not isinstance(data, dict):
        return {}
    limits = data.get("limits")
    if not isinstance(limits, dict):
        return {}
    # The same range the PUT holds to, so a hand edit cannot pass it either.
    return {
        key: value
        for key, value in limits.items()
        if key in LIMITS and _in_range(LIMITS[key], value)
    }


def _saved_values() -> dict[str, int]:
    global _saved
    with _lock:
        if _saved is None:
            _saved = _read_file()
        return dict(_saved)


def _page_value(key: str) -> int:
    return _saved_values().get(key, LIMITS[key].default)


def _write_file(values: dict[str, int]) -> None:
    if _path is None:
        return
    _path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"limits": values}, indent=2), encoding="utf-8")
    # Replace rather than rewrite, so a crash mid-write cannot leave half a
    # file; retried, as Windows briefly holds a just-written file (the
    # broker's policy file measured one save in thirty).
    for attempt in range(10):
        try:
            os.replace(tmp, _path)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.02)


def update(changes: dict) -> None:
    """Save `changes` ({key: value}); every value is checked before any is kept.

    A key whose environment variable is set is refused whatever its value:
    the page never writes over an administrator's choice, not even with the
    same number.
    """
    global _saved
    for key, value in changes.items():
        if key not in LIMITS:
            raise UnknownSetting(f"There is no setting called {key!r}.")
        limit = LIMITS[key]
        names = variables_set(key)
        if names:
            raise SetByEnvironment(limit, names)
        if not _in_range(limit, value):
            raise LimitOutOfRange(limit)
    with _lock:
        current = dict(_saved) if _saved is not None else _read_file()
        current.update(changes)
        # A value equal to its default is not kept: Reset to defaults then
        # means the default, and a default a later release moves applies.
        current = {key: value for key, value in current.items() if value != LIMITS[key].default}
        _write_file(current)
        _saved = current


# --- the readers --------------------------------------------------------------


def upload_bytes() -> int:
    """The upload cap: uploads, the Turtle editor's apply, the size middleware."""
    if _env(UPLOAD_VARIABLE) is not None:
        return int(_env_number(UPLOAD_VARIABLE, LIMITS["largestFile"].default * MB, int))
    return _page_value("largestFile") * MB


def fetch_bytes() -> int:
    """The download cap: URL loads, imports and JSON-LD contexts."""
    if _env(FETCH_VARIABLE) is not None:
        return int(_env_number(FETCH_VARIABLE, LIMITS["largestFile"].default * MB, int))
    return _page_value("largestFile") * MB


def parse_timeout() -> float:
    """Seconds a parse may run before the request stops waiting (D-013)."""
    if _env(TIMEOUT_VARIABLE) is not None:
        return float(_env_number(TIMEOUT_VARIABLE, float(LIMITS["readTime"].default), float))
    return float(_page_value("readTime"))


def graph_budget() -> int:
    """How many nodes a graph's first drawing carries; Show more climbs on."""
    if _env(BUDGET_VARIABLE) is not None:
        return int(_env_number(BUDGET_VARIABLE, LIMITS["firstDrawing"].default, int))
    return _page_value("firstDrawing")


def _megabytes(size: int) -> float:
    """Whole megabytes as a whole number; an administrator's odd byte count
    to two places, or two significant figures under 1 MB, never 0 MB."""
    mb = size / MB
    if mb == int(mb):
        return int(mb)
    return round(mb, 2) if mb >= 1 else float(f"{mb:.2g}")


def _shown(key: str) -> float:
    """The value Settings shows, in the limit's unit."""
    if key == "largestFile":
        # The upload's value when its variable is set, else the fetch's: the
        # read-only line names whichever variables are set, and `byPath`
        # gives both when they differ.
        size = upload_bytes() if _env(UPLOAD_VARIABLE) is not None else fetch_bytes()
        return _megabytes(size)
    if key == "readTime":
        seconds = parse_timeout()
        return int(seconds) if seconds == int(seconds) else seconds
    return graph_budget()


def describe() -> list[dict]:
    """The three limits as Settings → Limits shows them."""
    saved = _saved_values()
    out = []
    for key, limit in LIMITS.items():
        names = variables_set(key)
        source = "environment" if names else ("settings" if key in saved else "default")
        item = {
            "key": key,
            "name": limit.name,
            "unit": limit.unit,
            "value": _shown(key),
            "default": limit.default,
            "min": limit.minimum,
            "max": limit.maximum,
            "source": source,
            "variables": names,
        }
        # One size variable set and the other path on the page's value:
        # the two caps differ, and a read-only line showing one would hide
        # the other (code review).
        if key == "largestFile" and upload_bytes() != fetch_bytes():
            item["byPath"] = {"upload": _megabytes(upload_bytes()), "fetch": _megabytes(fetch_bytes())}
        out.append(item)
    return out


# --- the refusals of 5.5 -------------------------------------------------------


def raise_hint(key: str) -> str:
    """Where a limit is raised, or that the administrator set it (5.5)."""
    if settable(key):
        return "You can raise the limit in Settings → Limits."
    return "The administrator set this limit."


def too_large_detail(limit_bytes: int, path: str = "upload") -> dict:
    """The 413 detail for a file over the size cap, for every path that has one.

    `path` is "upload" or "fetch", whose variable the sentence asks about.
    `settable` tells the Load dialog whether to offer its Settings button: it
    is false when either variable is set, as the field would be read-only.
    The administrator is named as setting the number only when this path's
    own variable is set; with only the other path's set, the number is the
    page's or the default, and the sentence says no more than that it cannot
    be changed here (code review).
    """
    mb = _megabytes(limit_bytes)
    own = UPLOAD_VARIABLE if path == "upload" else FETCH_VARIABLE
    if settable("largestFile"):
        message = f"This file is larger than the {mb} MB limit. You can raise it in Settings → Limits."
    elif _env(own) is not None:
        message = f"This file is larger than the {mb} MB limit, which the administrator set."
    else:
        message = f"This file is larger than the {mb} MB limit. Only the administrator can change it."
    return {
        "message": message,
        "code": "limit",
        "limit": "largestFile",
        "settable": settable("largestFile"),
    }


def too_slow_message(seconds: float) -> str:
    """The sentence for a file whose parse ran out of time (store.py)."""
    return f"This file took longer than {seconds:g} seconds to read and was stopped. {raise_hint('readTime')}"


def too_slow_detail(message: str) -> dict:
    """The 504 detail for a load that ran out of time, its sentence as made."""
    return {
        "message": message,
        "code": "limit",
        "limit": "readTime",
        "settable": settable("readTime"),
    }
