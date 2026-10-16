"""
================================================================================
FILE: backend/app/library_examples.py
================================================================================

SUMMARY
    The library's three bundled examples (home-and-examples 5.1, D-111):
    Space Exploration, The Lord of the Rings and FOAF, added to the person's
    library once, on first start, with no download, under fixed ids; replaced
    in place when a release ships a changed file; and added back, when the
    person asks, after a removal. (examples.py is a project's example data,
    a different thing that had the name first.)

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

INPUTS / INPUT SOURCES
    - backend/app/examples/manifest.json and the files it names (FOAF is
      vocab/foaf.rdf, the file owl:imports uses).
    - The OntologyStore to add to, and examples.json in its data directory.

EXPECTED OUTPUT
    - seed(store): the examples not yet recorded added; returns their ids.
    - restore(store): the examples missing from the library added back;
      returns their ids.
    - example_id(key): an example's fixed id.
================================================================================
"""

from __future__ import annotations

import hashlib
import json
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
        for entry in load_manifest():
            if _in_library(store, example_id(entry["key"])):
                continue
            restored.append(_add(store, entry))
            seeded[entry["key"]] = entry["sha256"]
            _write_state(store, seeded)
        return restored
