"""
================================================================================
FILE: backend/app/provenance.py
================================================================================

SUMMARY
    A minimal, append-only record of activities the server performed on an
    ontology — for now, only a documentation export. It exists so that an action
    which crosses a trust boundary (turning ontology-derived content into a
    public file) leaves a trace, and so the future provenance layer (D-034) has a
    seam to grow from rather than a greenfield.

BASIC IDEA
    Each activity is a small typed dict: a `@type`, the subject it acted on, an
    ISO-8601 UTC timestamp, and any activity-specific attributes. Records are
    held in an in-memory list and, when a data directory is configured, also
    appended to `provenance.jsonl` beside the ontology library, one JSON object
    per line — append-only, never rewritten.

    This is deliberately small. Whether provenance ultimately lives beside the
    ontology metadata or in a dedicated store, and whether it grows PROV-O terms
    and signing, is a question for when D-034's specification is written
    (documentation-export.md Section 15). The shape here is the smallest thing
    that records the fact without pre-committing that decision. It is who-less on
    a single-user localhost box; a workspace/actor field is added with the SaaS
    work (D-042).

INPUTS / INPUT SOURCES
    - record(activity_type, subject, **attributes) calls from the routers.
    - SEMANTIC_STUDIO_DATA_DIR for the optional on-disk log location.

EXPECTED OUTPUT
    - An in-memory list readable with activities(), and a best-effort
      append-only provenance.jsonl on disk.
================================================================================
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# The in-memory log. A lock guards it because FastAPI serves requests from a
# thread pool and two exports can land at once.
_lock = threading.Lock()
_activities: list[dict[str, Any]] = []


def _log_path() -> Path | None:
    """The on-disk log path, or None when no data directory is configured."""
    data_dir = os.environ.get("SEMANTIC_STUDIO_DATA_DIR")
    if not data_dir:
        return None
    return Path(data_dir) / "provenance.jsonl"


def record(activity_type: str, subject: str, **attributes: Any) -> dict[str, Any]:
    """Append one typed activity and return it.

    `activity_type` names what happened (e.g. "documentation-export"), `subject`
    the ontology id it happened to, and the keyword attributes carry anything
    specific to the activity (e.g. include_individuals). The timestamp is UTC and
    ISO-8601 so a later provenance graph can order records without ambiguity.
    """
    entry: dict[str, Any] = {
        "@type": activity_type,
        "subject": subject,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    entry.update(attributes)
    with _lock:
        _activities.append(entry)
        path = _log_path()
        if path is not None:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError:
                # A provenance record must never fail the action it records; the
                # in-memory copy still holds it.
                pass
    return entry


def activities() -> list[dict[str, Any]]:
    """A copy of the recorded activities, newest last."""
    with _lock:
        return list(_activities)


def reset() -> None:
    """Clear the in-memory log. For tests; does not touch the on-disk log."""
    with _lock:
        _activities.clear()
