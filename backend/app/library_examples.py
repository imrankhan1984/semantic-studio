"""
================================================================================
FILE: backend/app/library_examples.py
================================================================================

SUMMARY
    The library's four bundled entries (home-and-examples 5.1, D-111;
    reference-ontologies 5.2): two examples, Space Exploration and The Lord
    of the Rings, and two reference ontologies, FOAF and QUDT, added to the
    person's library once, on first start, with no download, under fixed
    ids; replaced in place when a release ships a changed file; and added
    back, when the person asks, after a removal. Code names keep *example*
    for all four. (examples.py is a project's example data, a different
    thing that had the name first.)

BASIC IDEA
    `<data dir>/examples.json` records which examples have been seeded and the
    hash of the file each was seeded from. At start-up an example whose key is
    not recorded is added through the store's own `add`, the path an upload
    takes, so it gets its card sketch and summary the same way; one whose key
    is recorded is left alone. That record is what makes a removal stick: the
    key stays after the entry goes, so the next start does not bring it back.
    Only `restore` does, and only for the ones missing.

    The comparison is against the manifest's SHA-256, never the file's own
    bytes, so a later start reads two small JSON files and parses nothing --
    the lazy start-up store.py is built around. A changed hash on an example
    still in the library replaces it under the same id: examples are
    read-only, so nothing the person made is lost, and saved queries, which
    hang off the id, stay attached.

    The id is `ont-` and the first 12 hex characters of SHA-256 of
    `example:<key>`, the shape of every other library id, so links, saved
    queries and a card survive a restart and a reinstall. Nothing here opens
    a connection: every file is the application's own.

    Each entry's `group`, *example* or *reference*, is the manifest's and is
    attached when the library is listed, never stored with the entry, as the
    questions are: a library seeded before groups existed gains them with no
    new seed. Both groups are seeded, removed and restored alike; the group
    decides only the chip and the order on Home.

    QUDT is the one large entry, about 6.9 MB and 132,000 statements: its
    parse is most of a first start's cost (3.9 s added, measured 2026-10-29),
    paid once, since a later start parses nothing.

INPUTS / INPUT SOURCES
    - backend/app/examples/manifest.json and the files it names (FOAF and
      QUDT are vocab/foaf.rdf and vocab/qudt-3.5.2.ttl, the files owl:imports
      uses), the questions' .rq files among them.
    - The OntologyStore to add to, and examples.json in its data directory.

EXPECTED OUTPUT
    - seed(store): the examples not yet recorded added; returns their ids.
    - restore(store): the entries missing from the library added back;
      returns their ids. One that fails is logged and the rest go on; it
      raises only when none came back.
    - example_id(key): an example's fixed id.
    - as_listed(summary): a listed entry's record with its group and its
      ready-made questions, {id, title, about, text} each, from
      examples/questions/ (query-page-rework 5.4).
================================================================================
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import threading
from pathlib import Path

from .store import OntologyStore

APP_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = APP_DIR / "examples" / "manifest.json"
STATE_FILE = "examples.json"

# Seeding at start-up and a restore from the Load dialog both add under the
# same fixed ids; one at a time, or two could write the same entry at once.
_lock = threading.Lock()


def load_manifest() -> list[dict]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["examples"]


def example_id(key: str) -> str:
    return "ont-" + hashlib.sha256(f"example:{key}".encode("utf-8")).hexdigest()[:12]


def _state_path(store: OntologyStore) -> Path:
    return store.data_dir / STATE_FILE


def _read_state(store: OntologyStore) -> dict:
    try:
        state = json.loads(_state_path(store).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    seeded = state.get("seeded") if isinstance(state, dict) else None
    return dict(seeded) if isinstance(seeded, dict) else {}


def _write_state(store: OntologyStore, seeded: dict) -> None:
    _state_path(store).write_text(
        json.dumps({"seeded": seeded}, indent=2), encoding="utf-8"
    )


def _in_library(store: OntologyStore, oid: str) -> bool:
    return any(o.id == oid for o in store.list())


def _add(store: OntologyStore, entry: dict) -> str:
    data = (APP_DIR / entry["file"]).read_bytes()
    ontology = store.add(
        entry["name"], "example", data, entry["format"], oid=example_id(entry["key"])
    )
    # What the card shows in place of the counted sentence and the date, kept
    # with the entry so listing the library still needs nothing but metadata.
    store.update_meta(ontology, example={"key": entry["key"], "purpose": entry["purpose"]})
    return ontology.id


@functools.cache
def _groups() -> dict[str, str]:
    """Each entry's group by key, read once per process. An entry without
    one is an example: home-and-examples' manifest had no groups."""
    return {entry["key"]: entry.get("group", "example") for entry in load_manifest()}


@functools.cache
def _questions() -> dict[str, list[dict]]:
    """Each example's ready-made questions by key (query-page-rework 5.4),
    read once per process: the files are the application's own and change
    only with a release."""
    out: dict[str, list[dict]] = {}
    for entry in load_manifest():
        questions = []
        for question in entry.get("questions", []):
            # A question that cannot be read is left out, never a failed
            # listing: Home lists the library on every start (as a failed
            # seed never stops the server).
            try:
                text = (APP_DIR / question["file"]).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            # The file's first line is its one-line comment, what it shows.
            first = text.split("\n", 1)[0]
            about = first[1:].strip() if first.startswith("#") else ""
            questions.append(
                {"id": question["id"], "title": question["title"], "about": about, "text": text}
            )
        out[entry["key"]] = questions
    return out


def as_listed(summary: dict) -> dict:
    """A library summary, a bundled entry's record carrying its group and its
    questions.

    Attached when the library is listed, never stored with the entry: an
    entry seeded before the questions or the groups shipped gains them
    without being seeded again, and an update to a question needs no new
    hash on the entry. Told by the entry's `example` record, never by its
    name.
    """
    record = summary.get("example")
    if summary.get("source") != "example" or not isinstance(record, dict):
        return summary
    key = record.get("key")
    return {
        **summary,
        "example": {
            **record,
            "group": _groups().get(key, "example"),
            "questions": _questions().get(key, []),
        },
    }


def seed(store: OntologyStore) -> list[str]:
    """Add every example not yet recorded, and replace one whose file changed."""
    with _lock:
        seeded = _read_state(store)
        added: list[str] = []
        for entry in load_manifest():
            key, sha = entry["key"], entry["sha256"]
            recorded = seeded.get(key)
            if recorded == sha:
                continue
            # Recorded with another hash and since removed: the removal wins,
            # and the record moves on so the next start does not ask again.
            if recorded is None or _in_library(store, example_id(key)):
                added.append(_add(store, entry))
            seeded[key] = sha
            _write_state(store, seeded)
        return added


def restore(store: OntologyStore) -> list[str]:
    """Add back every example missing from the library; nothing else."""
    with _lock:
        seeded = _read_state(store)
        restored: list[str] = []
        failed: list[Exception] = []
        for entry in load_manifest():
            if _in_library(store, example_id(entry["key"])):
                continue
            # One entry that will not come back (QUDT is large, and last)
            # must not hide the ones that did: they are on disk, and the
            # person is told of them; the failed one stays named as missing.
            try:
                restored.append(_add(store, entry))
            except Exception as exc:  # noqa: BLE001 -- said in the log, the rest go on
                logging.getLogger("uvicorn.error").exception("%s was not added back", entry["name"])
                failed.append(exc)
                continue
            seeded[entry["key"]] = entry["sha256"]
            _write_state(store, seeded)
        # Nothing came back at all: a failure, said as one.
        if failed and not restored:
            raise failed[0]
        return restored
