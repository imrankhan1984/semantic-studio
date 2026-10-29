"""
================================================================================
FILE: backend/app/routers/references.py
================================================================================

SUMMARY
    GET /api/references (reference-ontologies 8): the reference ontologies a
    new project can reuse terms from, FOAF and QUDT, as the New project form
    shows them.

BASIC IDEA
    Static data, read from examples/manifest.json by references.py: each
    entry's key, title, prefixes, purpose and sentence. It takes no input,
    and never sends a reference's index, which stays on the server and is
    searched there (5.6 item 4).

INPUTS / INPUT SOURCES
    - references.public().

EXPECTED OUTPUT
    - JSON: a list of {key, title, prefixes, purpose, sentence}.
================================================================================
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import references

router = APIRouter(prefix="/api/references", tags=["references"])


@router.get("")
def list_references() -> list[dict]:
    return references.public()
