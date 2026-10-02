"""
================================================================================
FILE: backend/app/routers/projects.py
================================================================================

SUMMARY
    The HTTP surface for projects and editing (authoring-foundations): list,
    create, rename, duplicate, trash and export projects, and change their
    kind, ontology or taxonomy (relationships 5.1); open and close them;
    run commands, apply Turtle, undo, redo, save and recover a document; and
    the modeling canvas's view and layout (visual-modeling Stage 2); the
    SHACL shapes in the form's structure, their suggestions, and validation
    on demand (shacl-authoring 5.1 to 5.7).

BASIC IDEA
    Thin, like the other routers: shape the request, call projects.py or
    editing.py, and map their exceptions to status codes in one place. An id
    or document name the server did not issue is 404 whatever it looks like;
    a refused command is 422 with its sentence; a document whose project is not
    open, and closing with unsaved changes, are 409.

    Once open, a document is read through the existing /api/ontologies/{id}/…
    endpoints under its prj-<hex>-<doc> id (D-081). Only two routes here change
    a document's content: the command route and the Turtle apply route (5.4).

    The apply route reads its body in chunks under the upload cap, as the
    upload does, because typed Turtle is the same input as an uploaded file;
    main.py refuses a declared oversize before this runs (D-015 pattern).
    The layout PUT is read the same way under its own 1 MB cap: a layout is
    positions, not Turtle, and has no reason to be large.

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend, every mutating one carrying the client
      header local_guard.py requires.
    - The editing and project singletons in editing.py; the library store for
      "Start a project from this".

EXPECTED OUTPUT
    - JSON project summaries, document states, command results; a zip for
      export and Turtle for a copy.
================================================================================
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from ..editing import (
    CommandError,
    Dirty,
    NotOpen,
    TurtleSyntaxError,
    editing_service,
    project_store,
)
from ..projects import LAYOUT_MAX_BYTES, ProjectError, UnknownDocument, UnknownProject
from ..store import ParseError, ParseTimeout, store
from . import ontologies

router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProject(BaseModel):
    name: str
    template: Optional[Literal["empty", "small", "taxonomy-empty", "taxonomy-small", "vocabulary"]] = None
    fromOntologyId: Optional[str] = None
    baseIri: Optional[str] = None
    prefix: Optional[str] = None
    primaryLanguage: str = "en"


class PatchProject(BaseModel):
    name: Optional[str] = None
    languages: Optional[list[str]] = None
    # Ontology or taxonomy (D-089): the tools change, the model does not.
    kind: Optional[Literal["ontology", "taxonomy"]] = None


class CloseProject(BaseModel):
    discard: bool = False


class NewDocument(BaseModel):
    role: Literal["shapes"]


class RunCommand(BaseModel):
    command: str
    args: dict = {}
    dryRun: bool = False


class SaveDocument(BaseModel):
    confirmRewrite: bool = False


class Recover(BaseModel):
    action: Literal["recover", "discard"]


@contextmanager
def _errors():
    """The one mapping from the domain's refusals to status codes."""
    try:
        yield
    except (UnknownProject, UnknownDocument) as exc:
        raise HTTPException(status_code=404, detail="There is no such project or document.") from exc
    except NotOpen as exc:
        raise HTTPException(status_code=409, detail="Open the project first.") from exc
    except Dirty as exc:
        raise HTTPException(
            status_code=409,
            detail="This project has unsaved changes. Save them, or close with discard.",
        ) from exc
    except TurtleSyntaxError as exc:
        raise HTTPException(
            status_code=422,
            detail={"line": exc.line, "column": exc.column, "message": str(exc), "detail": exc.detail},
        ) from exc
    except (CommandError, ProjectError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ParseTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("")
def list_projects() -> list[dict]:
    """Every project, from manifests alone: no Turtle file is opened."""
    return project_store.list()


@router.post("")
def create_project(body: CreateProject) -> dict:
    with _errors():
        if body.fromOntologyId is not None:
            source = store.get(body.fromOntologyId)
            if source is None or source.editable:
                raise HTTPException(status_code=404, detail="There is no such ontology in the library.")
            # A Turtle file is copied as it is, comments and layout included;
            # any other format is written as clean Turtle. The library entry
            # itself is read and never changed.
            if source.format == "turtle":
                text = source.data_path.read_bytes().decode("utf-8", errors="replace")
                return project_store.create(
                    name=body.name, base_iri=body.baseIri, prefix=body.prefix,
                    primary_language=body.primaryLanguage, source_text=text,
                    source_name=source.name,
                )
            return project_store.create(
                name=body.name, base_iri=body.baseIri, prefix=body.prefix,
                primary_language=body.primaryLanguage, source_graph=source.ensure_loaded(),
                source_name=source.name,
            )
        return project_store.create(
            name=body.name, base_iri=body.baseIri, prefix=body.prefix,
            primary_language=body.primaryLanguage, template=body.template or "empty",
        )


@router.patch("/{pid}")
def patch_project(pid: str, body: PatchProject) -> dict:
    with _errors():
        summary = None
        if body.name is not None:
            summary = project_store.rename(pid, body.name)
        if body.languages is not None:
            summary = project_store.set_languages(pid, body.languages)
        if body.kind is not None:
            summary = project_store.set_kind(pid, body.kind)
        if summary is None:
            summary = project_store.summary(project_store.manifest(pid))
        editing_service.refresh_manifest(pid)
        return summary


@router.post("/{pid}/duplicate")
def duplicate_project(pid: str) -> dict:
    with _errors():
        return project_store.duplicate(pid)


@router.delete("/{pid}")
def delete_project(pid: str) -> dict:
    """Move the folder to projects/.trash/, and say where it went."""
    with _errors():
        project_store.folder(pid)
        editing_service.close(pid, discard=False)
        location = project_store.trash_project(pid)
        return {"trashed": pid, "location": location}


@router.get("/{pid}/export")
def export_project(pid: str) -> Response:
    with _errors():
        data = project_store.export_zip(pid)
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", project_store.manifest(pid)["name"]).strip("-.")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name or "project"}.zip"'},
    )


@router.post("/{pid}/open")
def open_project(pid: str) -> dict:
    with _errors():
        return editing_service.open(pid)


@router.post("/{pid}/close")
def close_project(pid: str, body: Optional[CloseProject] = None) -> dict:
    with _errors():
        return editing_service.close(pid, discard=bool(body and body.discard))


@router.post("/{pid}/documents")
def add_document(pid: str, body: NewDocument) -> dict:
    with _errors():
        return editing_service.add_document(pid, body.role)


@router.post("/{pid}/documents/{doc}/commands")
def run_command(pid: str, doc: str, body: RunCommand) -> dict:
    """One of the commands the canvas will use (5.4). A dry run is offered for
    DeleteEntity only, and returns the impact summary with nothing changed."""
    with _errors():
        return editing_service.command(pid, doc, body.command, body.args, dry_run=body.dryRun)


@router.get("/{pid}/documents/{doc}/source")
def get_source(pid: str, doc: str) -> dict:
    """The editor's text: the text last applied, or clean Turtle."""
    with _errors():
        return editing_service.source(pid, doc)


@router.put("/{pid}/documents/{doc}/source")
async def put_source(pid: str, doc: str, request: Request) -> dict:
    """Parse the text as Turtle and replace the document, as one undo step.

    Invalid Turtle changes nothing and comes back 422 with line, column and
    rdflib's message. The body is read in chunks and refused past the upload
    cap while reading, not after.
    """
    limit = ontologies.MAX_UPLOAD_BYTES
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=ontologies.too_large_detail(limit, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"),
            )
        chunks.append(chunk)
    try:
        payload = json.loads(b"".join(chunks) or b"{}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="The body must be JSON: {\"text\": ...}.") from exc
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str):
        raise HTTPException(status_code=422, detail="The body must be JSON: {\"text\": ...}.")
    with _errors():
        return await run_in_threadpool(
            editing_service.apply_text, pid, doc, text, ontologies.PARSE_TIMEOUT_SECONDS
        )


async def _read_json_capped(request: Request, limit: int, detail: str):
    """The body as JSON, refused while reading once past `limit`."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail=detail)
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks) or b"null")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="The body must be JSON.") from exc


LAYOUT_TOO_LARGE = f"A layout is at most {LAYOUT_MAX_BYTES // (1024 * 1024)} MB."


@router.get("/{pid}/documents/{doc}/canvas")
def get_canvas(pid: str, doc: str, lang: Optional[str] = ontologies.LANG_PARAM) -> dict:
    """What the modeling canvas draws, with the saved layout (5.4 to 5.6)."""
    with _errors():
        return editing_service.canvas_view(pid, doc, lang)


@router.get("/{pid}/documents/{doc}/layout")
def get_layout(pid: str, doc: str) -> dict:
    with _errors():
        return editing_service.get_layout(pid, doc)


@router.put("/{pid}/documents/{doc}/layout")
async def put_layout(pid: str, doc: str, request: Request) -> dict:
    """Replace the canvas layout. Not a model change: no revision, no dirty
    flag, no undo step (D-087). Validated in projects.validate_layout."""
    payload = await _read_json_capped(request, LAYOUT_MAX_BYTES, LAYOUT_TOO_LARGE)
    with _errors():
        return editing_service.put_layout(pid, doc, payload)


@router.post("/{pid}/documents/{doc}/undo")
def undo(pid: str, doc: str) -> dict:
    with _errors():
        return editing_service.undo(pid, doc)


@router.post("/{pid}/documents/{doc}/redo")
def redo(pid: str, doc: str) -> dict:
    with _errors():
        return editing_service.redo(pid, doc)


@router.post("/{pid}/documents/{doc}/save")
def save(pid: str, doc: str, body: Optional[SaveDocument] = None) -> dict:
    """Write the document to its file. Answers needsCommentsWarning, and writes
    nothing, until a commented file's rewrite is confirmed (5.6)."""
    with _errors():
        return editing_service.save(pid, doc, confirm_rewrite=bool(body and body.confirmRewrite))


@router.get("/{pid}/documents/{doc}/download")
def download(pid: str, doc: str) -> Response:
    """Save a copy as Turtle: the save format rule, the project untouched."""
    with _errors():
        text = editing_service.copy_text(pid, doc)
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", project_store.manifest(pid)["name"]).strip("-.")
    return Response(
        content=text.encode("utf-8"),
        media_type="text/turtle",
        headers={"Content-Disposition": f'attachment; filename="{name or "project"}-{doc}.ttl"'},
    )


@router.post("/{pid}/recover")
def recover(pid: str, body: Recover) -> dict:
    with _errors():
        return editing_service.recover(pid, body.action, ontologies.PARSE_TIMEOUT_SECONDS)


@router.get("/{pid}/shapes")
def get_shapes(pid: str) -> dict:
    """Every shape in shapes.ttl in the form's structure, those the form
    cannot edit marked read-only with why (shacl-authoring 5.1, 5.5)."""
    with _errors():
        return editing_service.shapes_view(pid)


@router.get("/{pid}/shapes/suggestions")
def get_shape_suggestions(pid: str, target: Optional[str] = None, shape: Optional[str] = None) -> dict:
    """What a rule can be about for a target class, and the rules the model
    suggests that `shape` does not already have (5.4). `target` is checked
    after the project, so an id not issued is 404 like everywhere else."""
    with _errors():
        return editing_service.shape_suggestions(pid, target, shape)


@router.post("/{pid}/validate")
def validate(pid: str) -> dict:
    """Check the model with its unsaved changes and resolved imports against
    every shape, on demand only (5.6, D-094). Reads; changes nothing."""
    with _errors():
        return editing_service.validate(pid)


@router.get("/{pid}/documents/{doc}/annotation-properties")
def annotation_properties(pid: str, doc: str) -> list[dict]:
    """The suggested annotation properties and those the document or its
    imports declare, each with a default value type (5.4.1)."""
    with _errors():
        return editing_service.annotation_properties(pid, doc)


@router.get("/{pid}/documents/{doc}/languages")
def languages(pid: str, doc: str) -> dict:
    """How many entities have no name in each project language (5.4.2)."""
    with _errors():
        return editing_service.missing_names(pid, doc)
