from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..store import saved_queries, store

router = APIRouter(prefix="/api/queries", tags=["queries"])


class SaveQueryRequest(BaseModel):
    name: str
    ontologyId: str
    state: dict
    sparql: str
    id: Optional[str] = None


@router.get("")
def list_queries(ontology: Optional[str] = Query(default=None)) -> list[dict]:
    return saved_queries.list(ontology_id=ontology)


@router.post("")
def save_query(request: SaveQueryRequest) -> dict:
    ontology = store.get(request.ontologyId)
    if ontology is None:
        raise HTTPException(
            status_code=404, detail=f"Unknown ontology id: {request.ontologyId}"
        )
    if not request.name.strip():
        raise HTTPException(status_code=400, detail="A query name is required.")
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
    if not saved_queries.delete(qid):
        raise HTTPException(status_code=404, detail=f"Unknown query id: {qid}")
    return {"deleted": qid}
