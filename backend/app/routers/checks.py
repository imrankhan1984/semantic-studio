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
    it names anything, and one not issued is 404. A project's report reads
    the whole project (multi-file-projects 5.3 item 6): every ontology and
    vocabulary file for any of them, every shapes file for a shapes file,
    the same answer whichever is asked; its saved queries, the competency
    questions, are kept on its first ontology file.

INPUTS / INPUT SOURCES
    - The ontology store and, for a project document, its manifest.
    - settings.namespace() for DC-26, read at each run.
    - For a project's model, its current reasoning result, if any, for the
      hints H2 and H3 (design-checks 5.6), and its saved queries on the
      model, run as its competency questions (5.8). The read-aloud ticks
      are in the manifest, and set by PUT /api/projects/{pid}/read-aloud.

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
from ..editing import NotOpen, editing_service, project_store
from ..projects import DOC_ID, PROJECT_ID, UnknownProject, split_document_id
from ..store import store

router = APIRouter(tags=["checks"])

NOT_FOUND = "There is no such ontology or document."


@router.get("/api/checks")
def list_checks() -> list[dict]:
    return checks.catalogue()


@router.get("/api/ontologies/{oid}/checks")
def run_checks(oid: str, doc: Optional[str] = None) -> dict:
    if doc is not None:
        # The project id with its document: both matched in full first.
        if not PROJECT_ID.fullmatch(oid) or not DOC_ID.fullmatch(doc):
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        oid = f"{oid}-{doc}"
    ontology = store.get(oid)
    if ontology is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    split = split_document_id(ontology.id)
    project = None
    inferred = None
    questions = None
    kind = "model"
    whole = None
    if split is not None:
        try:
            project = project_store.manifest(split[0])
        except UnknownProject as exc:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from exc
        try:
            # The report reads the whole project (multi-file-projects 5.3
            # item 6): every ontology and vocabulary file, or every shapes
            # file, whichever file was asked for; the same answer for any.
            whole = editing_service.whole_for_checks(split[0], split[1])
        except NotOpen:
            whole = None
        kind = whole["kind"] if whole is not None else ("shapes" if split[1] == "shapes" else "model")
        if kind == "model":
            # The project's saved queries are its competency questions
            # (5.8), each run by the report: they are saved on the project's
            # first ontology file, as they always were on model.ttl.
            primary = whole["primary"] if whole is not None else ontology.id
            questions = [q for q in project_store.queries(split[0]).list() if q.get("ontologyId") == primary]
            inferred = _current_inferred(split[0])
    return checks.run(
        ontology,
        project=project,
        doc=kind,
        namespace=settings.namespace(),
        inferred=inferred,
        questions=questions,
        whole=whole,
    )


def _current_inferred(pid: str) -> Optional[list]:
    """The types the project's last reasoning run concluded, while that run
    is current for the model as it stands (with the imports view it ran on),
    for hints H2 and H3; None when there is no such run. Reasoning keeps its
    last result per open project (reasoning.service), never on disk."""
    for imports in (False, True):
        try:
            outcome = editing_service.current_inferred(pid, imports)
        except NotOpen:
            # A result outlives no project: a closed one has none to read.
            return None
        if outcome is not None:
            return [(str(s), str(o)) for s, _, o in outcome.inferred_members()]
    return None
