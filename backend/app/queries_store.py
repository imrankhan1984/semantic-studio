"""Persistent library of saved visual queries.

Saved queries live next to the persisted ontologies in the per-user data
directory, one JSON file each. The full builder state is stored (not just
the generated SPARQL) so a saved query can be reopened and edited
visually.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


class SavedQueryStore:
    def __init__(self, data_dir: Path) -> None:
        self.dir = Path(data_dir) / "queries"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, qid: str) -> Path:
        return self.dir / f"{qid}.json"

    def list(self, ontology_id: Optional[str] = None) -> list[dict]:
        entries: list[dict] = []
        for path in self.dir.glob("*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue  # skip corrupt files rather than failing the request
            if ontology_id and entry.get("ontologyId") != ontology_id:
                continue
            entries.append(entry)
        entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
        return entries

    def get(self, qid: str) -> Optional[dict]:
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
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            existing = self.get(qid) if qid else None
            entry = {
                "id": qid or ("q-" + uuid.uuid4().hex[:12]),
                "name": name.strip() or "Untitled query",
                "ontologyId": ontology_id,
                "ontologyName": ontology_name,
                "state": state,
                "sparql": sparql,
                "createdAt": existing["createdAt"] if existing else now,
                "updatedAt": now,
            }
            self._path(entry["id"]).write_text(
                json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        return entry

    def delete(self, qid: str) -> bool:
        path = self._path(qid)
        if not path.exists():
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True
