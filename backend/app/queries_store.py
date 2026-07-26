"""
================================================================================
FILE: backend/app/queries_store.py
================================================================================

SUMMARY
    A small persistent library of saved visual queries, stored one JSON file
    per query in a "queries" subfolder of the per-user data directory.

BASIC IDEA
    Users can save a query they built visually and reopen it later. We store
    the FULL builder state (the path, filters, modifiers, ...) alongside the
    generated SPARQL text, so a saved query can be reopened and edited
    visually — not just re-run as opaque SPARQL. Each query is its own file so
    saves/deletes are independent and crash-safe.

INPUTS / INPUT SOURCES
    - The data directory (shared with the ontology store).
    - Save requests carrying: name, ontology id/name, builder state, SPARQL.
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
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


class SavedQueryStore:
    """CRUD over saved-query JSON files in <data_dir>/queries."""

    def __init__(self, data_dir: Path) -> None:
        # Queries live beside the ontologies, in their own subfolder.
        self.dir = Path(data_dir) / "queries"
        self.dir.mkdir(parents=True, exist_ok=True)
        # Serializes writes so concurrent saves cannot interleave.
        self._lock = threading.Lock()

    def _path(self, qid: str) -> Path:
        # On-disk path for a query id.
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
            entries.append(entry)
        # Most recently updated first, matching the UI's expectation.
        entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
        return entries

    def get(self, qid: str) -> Optional[dict]:
        """One saved query by id, or None if missing/corrupt."""
        path = self._path(qid)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def save(
        self,
        *,
        name: str,
        ontology_id: str,
        ontology_name: str,
        state: dict,
        sparql: str,
        qid: Optional[str] = None,
    ) -> dict:
        """Create a new saved query, or update an existing one when qid is given.

        Returns the stored entry. When updating, the original createdAt stamp
        is preserved and only updatedAt moves.
        """
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            # If updating, load the prior version so we can keep its createdAt.
            existing = self.get(qid) if qid else None
            entry = {
                # Reuse the id when updating; otherwise mint a new one.
                "id": qid or ("q-" + uuid.uuid4().hex[:12]),
                "name": name.strip() or "Untitled query",
                "ontologyId": ontology_id,
                "ontologyName": ontology_name,
                "state": state,   # full builder state, so it reopens visually
                "sparql": sparql,  # the generated query text, for reference
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
        path = self._path(qid)
        if not path.exists():
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True
