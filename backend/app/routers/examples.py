"""
================================================================================
FILE: backend/app/routers/examples.py
================================================================================

SUMMARY
    POST /api/examples/restore (home-and-examples 5.1): add back the bundled
    examples missing from the library, and answer with the library as it now
    stands.

BASIC IDEA
    The only way a removed example comes back. Seeding at start-up respects a
    removal for good; this is the person asking, from the Load dialog's
    Suggested tab. It takes no body, and like every write it reaches here only
    through local_guard. The work is library_examples.restore's.

INPUTS / INPUT SOURCES
    - The shared `store` singleton.

EXPECTED OUTPUT
    - JSON: `restored`, the ids added back (none when nothing was missing),
      and `ontologies`, the library's summaries as GET /api/ontologies lists
      them.
================================================================================
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import library_examples
from ..store import store

router = APIRouter(prefix="/api/examples", tags=["examples"])


@router.post("/restore")
def restore_examples() -> dict:
    restored = library_examples.restore(store)
    ontologies = [library_examples.with_questions(o.summary()) for o in store.list()]
    return {"restored": restored, "ontologies": ontologies}
