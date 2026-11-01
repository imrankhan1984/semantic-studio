"""
================================================================================
FILE: backend/app/routers/checks.py
================================================================================

SUMMARY
    The HTTP face of the design checks (design-checks 5.4, D-124): the
    report for one document, and the catalogue *Open as a query* reads.

BASIC IDEA
    Thin, like every router here: checks.py owns the queries, the own-term
    rule, the sentences and the measures. Both routes only read, so neither
    is a changing request; the report runs only when asked (View's Checks
    switch, Run again), never as a side effect of another view.

    The report is a plain `def` route, which FastAPI runs on its worker
    threads: the checks are many queries in a row and none may run on the
    event loop (the load-bearing rule test_load_cancel.py scans for). A
    project document is named by its ontology id (prj-<hex>-model), or by
    the project id with `doc`; either way the id is matched in full before
    it names anything, and one not issued is 404.

INPUTS / INPUT SOURCES
    - The ontology store and, for a project document, its manifest.
    - settings.namespace() for DC-26, read at each run.

EXPECTED OUTPUT
    - GET /api/ontologies/{id}/checks?doc=  checks.run's answer, 404 for an
      id not issued.
    - GET /api/checks  [{id, level, heading, fix, query}].
================================================================================
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException

from .. import checks, settings
from ..editing import project_store
from ..projects import PROJECT_ID, UnknownProject, split_document_id
from ..store import store

router = APIRouter(tags=["checks"])

NOT_FOUND = "There is no such ontology or document."


@router.get("/api/checks")
def list_checks() -> list[dict]:
    return checks.catalogue()


@router.get("/api/ontologies/{oid}/checks")
def run_checks(oid: str, doc: Optional[Literal["model", "shapes"]] = None) -> dict:
    if doc is not None:
        # The project id with its document: matched in full first.
        if not PROJECT_ID.fullmatch(oid):
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        oid = f"{oid}-{doc}"
    ontology = store.get(oid)
    if ontology is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    split = split_document_id(ontology.id)
    project = None
    if split is not None:
        try:
            project = project_store.manifest(split[0])
        except UnknownProject as exc:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from exc
    return checks.run(
        ontology,
        project=project,
        doc=split[1] if split else "model",
        namespace=settings.namespace(),
    )
