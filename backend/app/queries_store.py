"""
================================================================================
FILE: backend/app/queries_store.py
================================================================================

SUMMARY
    A small persistent library of saved queries, visual or text, stored one
    JSON file per query in a "queries" subfolder of the per-user data
    directory.

BASIC IDEA
    Users can save a query they built visually and reopen it later. We store
    the FULL builder state (the path, filters, modifiers, ...) alongside the
    generated SPARQL text, so a saved query can be reopened and edited
    visually — not just re-run as opaque SPARQL. Each query is its own file so
    saves/deletes are independent and crash-safe.

    A text query (sparql-text-and-query-files) stores `mode: "text"`, and then
    its SPARQL is the source of truth; `state` is the builder state it forked
    from, or None when it was written from nothing. An entry without `mode` is
    visual, so nothing saved before text queries existed is rewritten.

    The id is a file name, so it is checked against QUERY_ID before any path
    is built from it. An id of `../escaped` once wrote a file outside
    `queries/` (backlog CF-5). The router refuses it first with a 422; the
    check here is the second line, and it covers get and delete as well,
    which take the id from the URL.

INPUTS / INPUT SOURCES
    - The data directory (shared with the ontology store).
    - Save requests carrying: name, ontology id/name, mode, builder state (or
      None for a text query written from nothing), SPARQL.
    - Query ids for get/delete; an optional ontology id to filter the list.

EXPECTED OUTPUT
    - JSON-ready dicts describing saved queries (with created/updated stamps).
    - Files named <query-id>.json on disk; list/get/save/delete operations.
================================================================================
"""

from __future__ import annotations

# json      - read/write each query file
# threading - a lock so a save cannot race another save/list
# uuid      - generate stable query ids
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# What save() mints: "q-" and twelve hex digits. Nothing else is a query id.
QUERY_ID = re.compile(r"^q-[0-9a-f]{12}$")


class InvalidQueryId(ValueError):
    """A query id that is not one this store could have minted."""


def _with_mode(entry: dict) -> dict:
    # An entry saved before text queries existed is visual. Answered on read
    # rather than by a migration, so no file on disk is rewritten.
    entry.setdefault("mode", "visual")
    return entry


class SavedQueryStore:
    """CRUD over saved-query JSON files in <data_dir>/queries."""

    def __init__(self, data_dir: Path) -> None:
        # Queries live beside the ontologies, in their own subfolder.
        self.dir = Path(data_dir) / "queries"
        self.dir.mkdir(parents=True, exist_ok=True)
        # Serializes writes so concurrent saves cannot interleave.
        self._lock = threading.Lock()

    def _path(self, qid: str) -> Path:
        # fullmatch, not match: `$` in a Python pattern also matches before a
        # trailing newline, so an id ending in a newline would otherwise pass.
        if not isinstance(qid, str) or not QUERY_ID.fullmatch(qid):
            raise InvalidQueryId(qid)
        return self.dir / f"{qid}.json"

    def list(self, ontology_id: Optional[str] = None) -> list[dict]:
        """All saved queries, newest first; optionally filtered to one ontology."""
        entries: list[dict] = []
        for path in self.dir.glob("*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue  # skip corrupt files rather than failing the request
            # When an ontology id is given, only return that ontology's queries.
            if ontology_id and entry.get("ontologyId") != ontology_id:
                continue
            entries.append(_with_mode(entry))
        # Most recently updated first, matching the UI's expectation.
        entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
        return entries

    def get(self, qid: str) -> Optional[dict]:
        """One saved query by id, or None if missing/corrupt/not an id."""
        try:
            path = self._path(qid)
        except InvalidQueryId:
            return None
        if not path.exists():
            return None
        try:
            return _with_mode(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return None

    def save(
        self,
        *,
        name: str,
        ontology_id: str,
        ontology_name: str,
        state: Optional[dict],
        sparql: str,
        qid: Optional[str] = None,
        mode: str = "visual",
    ) -> dict:
        """Create a new saved query, or update an existing one when qid is given.

        Returns the stored entry. When updating, the original createdAt stamp
        is preserved and only updatedAt moves.
        """
        now = datetime.now(timezone.utc).isoformat()
        if qid is not None:
            self._path(qid)  # raises before anything is read or written
        with self._lock:
            # If updating, load the prior version so we can keep its createdAt.
            existing = self.get(qid) if qid else None
            entry = {
                # Reuse the id when updating; otherwise mint a new one.
                "id": qid or ("q-" + uuid.uuid4().hex[:12]),
                "name": name.strip() or "Untitled query",
                "ontologyId": ontology_id,
                "ontologyName": ontology_name,
                "mode": mode,
                # Visual: the builder state it reopens in. Text: the state it
                # forked from, for "Back to the visual version", or None.
                "state": state,
                # Visual: the generated text, for reference. Text: the query.
                "sparql": sparql,
                "createdAt": existing["createdAt"] if existing else now,
                "updatedAt": now,
            }
            # Write atomically enough for our purposes: one file per query.
            self._path(entry["id"]).write_text(
                json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        return entry

    def delete(self, qid: str) -> bool:
        """Delete a saved query by id; return True if it existed."""
        try:
            path = self._path(qid)
        except InvalidQueryId:
            return False
        if not path.exists():
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True
