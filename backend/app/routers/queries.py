"""
================================================================================
FILE: backend/app/routers/queries.py
================================================================================

SUMMARY
    REST endpoints for the saved-query library, under /api/queries: list, save
    (create or update), and delete.

BASIC IDEA
    A thin HTTP layer over the SavedQueryStore. It validates that the referenced
    ontology exists and that a name was given, then delegates persistence to the
    store. Saving stores the full builder state, so a saved query reopens
    visually, not just as SPARQL text.

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend's query panel.
    - JSON save bodies (name, ontologyId, builder state, sparql, optional id).
    - The shared `saved_queries` and `store` singletons.

EXPECTED OUTPUT
    - JSON: a list of saved queries, a single saved entry, or a delete
      acknowledgement; 404/400 on unknown ontology / missing name.
================================================================================
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

# The saved-query store, plus the ontology store to validate references.
from ..store import saved_queries, store

# All routes hang off /api/queries.
router = APIRouter(prefix="/api/queries", tags=["queries"])


# JSON body for POST /api/queries. `id` present -> update in place; absent -> create.
class SaveQueryRequest(BaseModel):
    name: str
    ontologyId: str
    state: dict     # the full visual builder state, so it reopens visually
    sparql: str     # the generated query text, stored for reference
    id: Optional[str] = None


@router.get("")
def list_queries(ontology: Optional[str] = Query(default=None)) -> list[dict]:
    """GET /api/queries[?ontology=id] -> saved queries, optionally for one ontology."""
    return saved_queries.list(ontology_id=ontology)


@router.post("")
def save_query(request: SaveQueryRequest) -> dict:
    """POST /api/queries -> create or update a saved query."""
    # The query must belong to a currently-loaded ontology.
    ontology = store.get(request.ontologyId)
    if ontology is None:
        raise HTTPException(
            status_code=404, detail=f"Unknown ontology id: {request.ontologyId}"
        )
    # A blank name would produce an unusable library entry.
    if not request.name.strip():
        raise HTTPException(status_code=400, detail="A query name is required.")
    # Persist; the store keeps createdAt when id refers to an existing query.
    return saved_queries.save(
        name=request.name,
        ontology_id=request.ontologyId,
        ontology_name=ontology.name,
        state=request.state,
        sparql=request.sparql,
        qid=request.id,
    )


@router.delete("/{qid}")
def delete_query(qid: str) -> dict:
    """DELETE /api/queries/{qid} -> remove one saved query."""
    if not saved_queries.delete(qid):
        raise HTTPException(status_code=404, detail=f"Unknown query id: {qid}")
    return {"deleted": qid}
