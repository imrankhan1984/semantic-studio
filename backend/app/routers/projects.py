"""
================================================================================
FILE: backend/app/routers/projects.py
================================================================================

SUMMARY
    The HTTP surface for projects and editing (authoring-foundations): list,
    create, rename, duplicate, trash and export projects, and change their
    kind, ontology or taxonomy (relationships 5.1); a create may name the
    reference ontologies a template reuses (known keys, else 422) and a
    description (at most 2,000 characters; reference-ontologies 5.4);
    open and close them;
    run commands, apply Turtle, undo, redo, save and recover a document; and
    the modeling canvas's view and layout (visual-modeling Stage 2); the
    SHACL shapes in the form's structure, their suggestions, and validation
    on demand (shacl-authoring 5.1 to 5.7); reasoning on demand, its
    Stop, its pages and its reasons (axioms-and-reasoning Stage A); and a
    document's vocabularies and Add a vocabulary's inspect
    (vocabularies-and-ontologies 5.2, 5.3, D-128); and a project's files
    and folders (multi-file-projects 8.2, D-131): New file, a file's rename
    or move (PATCH) and removal (DELETE), and a folder's creation and
    removal.

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
    positions, not Turtle, and has no reason to be large. So is a read-aloud
    tick (design-checks 5.8), under 16 KB, after its project is matched:
    a manifest write, like the layout no revision, no dirty flag, no undo.
    Inspect matches its open project before it reads a body: a file is
    multipart under the upload cap, as Load's, and a choice is JSON under
    16 KB; a web address reaches the broker only through vocabularies.py,
    so an unapproved host is main.py's 409 before any request leaves.

    A route taking {doc} that reads a body (the apply, the layout, a file's
    rename or move) matches the project, then the id against the manifest,
    before it reads a byte (multi-file-projects 8.2): an id not issued is 404
    and no file is read. A refused name or folder is 422 with its sentence
    and the field it concerns (`{code: "path", field, message}`).

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend, every mutating one carrying the client
      header local_guard.py requires.
    - The editing and project singletons in editing.py; the library store for
      "Start a project from this".

EXPECTED OUTPUT
    - JSON project summaries, document states, command results; a zip for
      export and Turtle for a copy. A create naming a property of its kind
      that exists is 409 `{"code": "already_defined", "property",
      "message"}` (attribute-reuse 5.1); ShareDomain's dry run answers the
      reuse plan (5.2).
================================================================================
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from .. import reasoning, references, settings, vocabularies
from ..editing import (
    AlreadyDefined,
    CommandError,
    Dirty,
    NoSuchRule,
    NotOpen,
    ReasoningRefused,
    StandardTerm,
    StandardTermInText,
    TurtleSyntaxError,
    editing_service,
    project_store,
)
from ..projects import DESCRIPTION_MAX, LAYOUT_MAX_BYTES, PathRefused, ProjectError, UnknownDocument, UnknownProject
from ..store import ParseError, ParseTimeout, detect_format, store
from . import ontologies

router = APIRouter(prefix="/api/projects", tags=["projects"])


class AddressGroup(BaseModel):
    layer: Literal["core", "domain", "app"]
    area: str = Field(default="", max_length=64)
    subject: str = Field(max_length=64)
    type: Literal["ontology", "taxonomy", "vocabulary"]
    dataDomain: str = Field(max_length=64)


class CreateProject(BaseModel):
    name: str
    template: Optional[Literal["empty", "small", "taxonomy-empty", "taxonomy-small", "vocabulary"]] = None
    fromOntologyId: Optional[str] = None
    baseIri: Optional[str] = None
    prefix: Optional[str] = None
    primaryLanguage: str = "en"
    # The reference ontologies a template reuses (reference-ontologies 5.4):
    # known keys only, anything else 422 before a folder is made.
    references: list[str] = []
    # The header's rdfs:comment; empty writes none (5.4 item 3).
    description: Optional[str] = Field(default=None, max_length=DESCRIPTION_MAX)
    # New project's Address group (design-checks 5.2), sent only with a
    # namespace set; each part is held to naming.py's rule in projects.py.
    address: Optional[AddressGroup] = None

    @field_validator("references")
    @classmethod
    def _known(cls, keys: list[str]) -> list[str]:
        unknown = [k for k in keys if k not in references.keys()]
        if unknown:
            raise ValueError(f"Unknown reference ontology: {', '.join(unknown)}.")
        return keys


class PatchProject(BaseModel):
    name: Optional[str] = None
    languages: Optional[list[str]] = None
    # Ontology or taxonomy (D-089): the tools change, the model does not.
    kind: Optional[Literal["ontology", "taxonomy"]] = None


class CloseProject(BaseModel):
    discard: bool = False


class NewDocument(BaseModel):
    """A new file (multi-file-projects 8.2). `{role: "shapes"}` alone keeps
    its meaning, shapes.ttl at the root; with a name, any role, at a folder.
    Each name and folder is held to 8.3 in projects.py, where the sentence
    and the field it concerns come from."""
    role: Literal["ontology", "vocabulary", "shapes"]
    name: Optional[str] = Field(default=None, max_length=200)
    folder: str = Field(default="", max_length=400)


class MoveDocument(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    folder: Optional[str] = Field(default=None, max_length=400)


class FolderPath(BaseModel):
    path: str = Field(max_length=400)


# The body of a file's rename or move, and of a folder's create or remove:
# a few names, read capped, and only after the project and the id are known.
SMALL_BODY_MAX_BYTES = 16 * 1024
SMALL_BODY_TOO_LARGE = "This request is larger than a file or folder name can make it."


class RunCommand(BaseModel):
    command: str
    args: dict = {}
    dryRun: bool = False


class SaveDocument(BaseModel):
    confirmRewrite: bool = False


class Recover(BaseModel):
    action: Literal["recover", "discard"]


class Reason(BaseModel):
    includeData: bool = False
    # The imports switch the views are on (5.1): a request parameter there,
    # so the run is told it too.
    imports: bool = False


@contextmanager
def _errors():
    """The one mapping from the domain's refusals to status codes."""
    try:
        yield
    except (UnknownProject, UnknownDocument) as exc:
        raise HTTPException(status_code=404, detail="There is no such project or document.") from exc
    except PathRefused as exc:
        # A name or a folder outside 8.3, or a limit of 8.5 (multi-file-
        # projects 5.5 item 8): the sentence and the field it belongs beside.
        # Caught before ProjectError, which it subclasses.
        raise HTTPException(
            status_code=422, detail={"code": "path", "field": exc.field, "message": str(exc)},
        ) from exc
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
    except AlreadyDefined as exc:
        # A property of that name and kind is there already (attribute-reuse
        # 5.1): the form offers to use it, so the property goes with the words.
        raise HTTPException(
            status_code=409,
            detail={"code": "already_defined", "property": exc.property, "message": str(exc)},
        ) from exc
    except StandardTerm as exc:
        # A name copying a standard axiom (standard-terms 5.3): refused with no
        # way past; the standard term and its offer go with the sentence so a
        # door can offer the standard way. Caught before CommandError, which it
        # subclasses.
        raise HTTPException(
            status_code=409,
            detail={"code": "standard_term", "message": str(exc), "term": exc.term},
        ) from exc
    except StandardTermInText as exc:
        # Turtle Apply introducing an own copy (standard-terms 5.6): refused
        # before anything changes, each term with its line.
        raise HTTPException(
            status_code=422,
            detail={"code": "standard_term", "message": str(exc), "terms": exc.terms},
        ) from exc
    except NoSuchRule as exc:
        # A restriction named by its content that is not there (axioms 5.10).
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (CommandError, ProjectError, ReasoningRefused) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except reasoning.AlreadyRunning as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
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
                    source_name=source.name, reference_keys=body.references,
                    description=body.description,
                    address=body.address.model_dump() if body.address else None,
                )
            return project_store.create(
                name=body.name, base_iri=body.baseIri, prefix=body.prefix,
                primary_language=body.primaryLanguage, source_graph=source.ensure_loaded(),
                source_name=source.name, reference_keys=body.references,
                description=body.description,
                address=body.address.model_dump() if body.address else None,
            )
        return project_store.create(
            name=body.name, base_iri=body.baseIri, prefix=body.prefix,
            primary_language=body.primaryLanguage, template=body.template or "empty",
            reference_keys=body.references, description=body.description,
            address=body.address.model_dump() if body.address else None,
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
        if body.name is None:
            if body.role != "shapes" or body.folder:
                raise PathRefused("A new file needs a name.", "name")
            return editing_service.add_document(pid, body.role)
        return editing_service.add_file(pid, body.role, body.name, body.folder)


def _known(pid: str, doc: str) -> None:
    """The project, then the id against the manifest (8.2): an id not
    issued is 404 before any body is read and before any file is."""
    project_store.folder(pid)
    project_store.entry(pid, doc)


@router.patch("/{pid}/documents/{doc}")
async def move_document(pid: str, doc: str, request: Request) -> dict:
    """Rename or move a file (5.5 item 6): its path only."""
    with _errors():
        _known(pid, doc)
    payload = await ontologies.read_json_capped(request, SMALL_BODY_MAX_BYTES, SMALL_BODY_TOO_LARGE)
    try:
        body = MoveDocument.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="The body is {name?, folder?}.") from exc
    with _errors():
        return await run_in_threadpool(editing_service.move_file, pid, doc, body.name, body.folder)


@router.delete("/{pid}/documents/{doc}")
def remove_document(pid: str, doc: str) -> dict:
    """To the project's own trash (5.5 item 7)."""
    with _errors():
        _known(pid, doc)
        return editing_service.remove_file(pid, doc)


async def _folder_body(pid: str, request: Request) -> FolderPath:
    with _errors():
        project_store.folder(pid)
    payload = await ontologies.read_json_capped(request, SMALL_BODY_MAX_BYTES, SMALL_BODY_TOO_LARGE)
    try:
        return FolderPath.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="The body is {path}.") from exc


@router.post("/{pid}/folders")
async def create_folder(pid: str, request: Request) -> dict:
    body = await _folder_body(pid, request)
    with _errors():
        # Off the event loop: it waits on the project store's lock, which
        # an open's folder index holds while it reads found files.
        return await run_in_threadpool(editing_service.create_folder, pid, body.path)


@router.delete("/{pid}/folders")
async def remove_folder(pid: str, request: Request) -> dict:
    """An empty folder only (5.5 item 4)."""
    body = await _folder_body(pid, request)
    with _errors():
        # Off the event loop: it waits on the project store's lock, which
        # an open's folder index holds while it reads found files.
        return await run_in_threadpool(editing_service.remove_folder, pid, body.path)


@router.post("/{pid}/documents/{doc}/commands")
def run_command(pid: str, doc: str, body: RunCommand) -> dict:
    """One of the commands the canvas will use (5.4). A dry run is offered for
    DeleteEntity, returning the impact summary, and for ShareDomain, returning
    the reuse plan (attribute-reuse 5.2), with nothing changed either way."""
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
    cap while reading, not after, and only once the project and the id are
    known (multi-file-projects 8.2).
    """
    with _errors():
        _known(pid, doc)
    limit = settings.upload_bytes()
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=settings.too_large_detail(limit),
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
            editing_service.apply_text, pid, doc, text, settings.parse_timeout()
        )


LAYOUT_TOO_LARGE = f"A layout is at most {LAYOUT_MAX_BYTES // (1024 * 1024)} MB."


@router.get("/{pid}/documents/{doc}/canvas")
def get_canvas(
    pid: str,
    doc: str,
    lang: Optional[str] = ontologies.LANG_PARAM,
    inferred: bool = False,
    imports: bool = ontologies.IMPORTS_PARAM,
) -> dict:
    """What the modeling canvas draws, with the saved layout (5.4 to 5.6).
    With `inferred`, a current reasoning result's kinds and the classes
    that can never have members are added; a stale one adds nothing."""
    with _errors():
        return editing_service.canvas_view(pid, doc, lang, inferred=inferred, imports=imports)


@router.get("/{pid}/documents/{doc}/layout")
def get_layout(pid: str, doc: str) -> dict:
    with _errors():
        return editing_service.get_layout(pid, doc)


@router.put("/{pid}/documents/{doc}/layout")
async def put_layout(pid: str, doc: str, request: Request) -> dict:
    """Replace the canvas layout. Not a model change: no revision, no dirty
    flag, no undo step (D-087). Validated in projects.validate_layout."""
    with _errors():
        _known(pid, doc)
    payload = await ontologies.read_json_capped(request, LAYOUT_MAX_BYTES, LAYOUT_TOO_LARGE)
    with _errors():
        return editing_service.put_layout(pid, doc, payload)


@router.get("/{pid}/documents/{doc}/vocabularies")
def get_vocabularies(pid: str, doc: str) -> dict:
    """The Edit page's Vocabularies section (vocabularies-and-ontologies
    5.2): every vocabulary the document uses, with its status, source and
    use, and the head's sentence. Reads; never connects, never parses."""
    with _errors():
        return editing_service.vocabularies(pid, doc)


# A choice of bundled vocabulary, library ontology or address: a few names.
INSPECT_JSON_MAX_BYTES = 16 * 1024
INSPECT_JSON_TOO_LARGE = "A vocabulary to inspect is named in at most 16 KB."


class InspectChoice(BaseModel):
    bundled: Optional[str] = Field(default=None, max_length=64)
    ontologyId: Optional[str] = Field(default=None, max_length=128)
    url: Optional[str] = Field(default=None, max_length=4096)


def _with_added(pid: str, found: dict) -> dict:
    """`alreadyAdded`, from the list as it stands (5.9)."""
    rows = editing_service.vocabularies(pid, editing_service.primary(pid).doc)["rows"]
    source = vocabularies.source_for(found["iri"])
    found["alreadyAdded"] = any(
        r["status"] == "added" and (source.answers_to(r["iri"]) if source else r["iri"] == found["iri"])
        for r in rows
    )
    return found


@router.post("/{pid}/vocabularies/inspect")
async def inspect_vocabulary(pid: str, request: Request) -> dict:
    """Add a vocabulary's reading (5.3): a bundled vocabulary, a library
    ontology, a web address (JSON) or a file (multipart `file`), answered
    with its summary and the one sentence; nothing is written to the
    document. The project is matched, and must be open, before the body is
    read. A file is read in chunks under the upload cap and parsed under
    the parse timeout, as Load does; an address goes through the broker as
    `ontology:import`, so an unapproved host is 409 before any request."""
    with _errors():
        model = editing_service.model_graph(pid)
    kind = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if kind == "multipart/form-data":
        form = await request.form()
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise HTTPException(status_code=422, detail="Choose a file to add.")
        data = await ontologies._read_capped(upload, settings.upload_bytes())
        if not data:
            raise HTTPException(status_code=400, detail="The chosen file is empty.")
        name = upload.filename or "chosen file"

        def read_file() -> dict:
            with _vocabulary_errors(data, name):
                return _with_added(pid, vocabularies.inspect_file(
                    model, name, data, detect_format(name), settings.parse_timeout()
                ))

        return await run_in_threadpool(read_file)
    payload = await ontologies.read_json_capped(request, INSPECT_JSON_MAX_BYTES, INSPECT_JSON_TOO_LARGE)
    try:
        choice = InspectChoice.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Choose a bundled vocabulary, a library ontology or an address.") from exc

    def read_choice() -> dict:
        with _vocabulary_errors(None, None):
            if choice.bundled:
                found = vocabularies.inspect_bundled(model, choice.bundled)
            elif choice.ontologyId:
                other = store.get(choice.ontologyId)
                if other is None:
                    raise HTTPException(status_code=404, detail="There is no such ontology in the library.")
                if other.editable:
                    raise vocabularies.Refused("This is the model itself." if other.id.startswith(pid) else
                                               "Choose an ontology from your library.")
                found = vocabularies.inspect_library(model, other)
            elif choice.url:
                found = vocabularies.inspect_url(model, choice.url, settings.parse_timeout(), settings.fetch_bytes())
            else:
                raise vocabularies.Refused("Choose a bundled vocabulary, a library ontology or an address.")
            return _with_added(pid, found)

    return await run_in_threadpool(read_choice)


@contextmanager
def _vocabulary_errors(data: Optional[bytes], name: Optional[str]):
    """A refusal is 422 with its sentence; a file that does not parse, the
    sentence Load gives (parse_errors.py, D-112), the raw text apart."""
    try:
        yield
    except vocabularies.Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ParseTimeout as exc:
        raise HTTPException(status_code=504, detail=settings.too_slow_detail(str(exc))) from exc
    except ParseError as exc:
        body = data if data is not None else getattr(exc, "body", b"")
        raise HTTPException(
            status_code=422, detail=ontologies._load_failure(exc, body, name or getattr(exc, "name", None))
        ) from exc


class ReadAloudTick(BaseModel):
    # A link's key: two IRIs and the link's kind (checks.link_key).
    key: str = Field(min_length=1, max_length=8192)
    agreed: bool


# Two IRIs and a word, with room: the body is read under this cap.
READ_ALOUD_MAX_BYTES = 16 * 1024
READ_ALOUD_TOO_LARGE = "A read-aloud tick is at most 16 KB."


@router.put("/{pid}/read-aloud")
async def put_read_aloud(pid: str, request: Request) -> dict:
    """Tick or untick one link the Checks report reads aloud (design-checks
    5.8). The manifest only: no revision, no dirty flag, no undo step
    (AC-14). The project is matched before the body is read, so an id not
    issued is 404 whatever is sent; a tick for a link the model does not
    hold is 422."""
    with _errors():
        project_store.folder(pid)
    payload = await ontologies.read_json_capped(request, READ_ALOUD_MAX_BYTES, READ_ALOUD_TOO_LARGE)
    try:
        tick = ReadAloudTick.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="A tick names a link and whether it is agreed.") from exc
    with _errors():
        return await run_in_threadpool(editing_service.agree_link, pid, tick.key, tick.agreed)


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
        return editing_service.recover(pid, body.action, settings.parse_timeout())


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


@router.post("/{pid}/reasoning")
def reason(pid: str, body: Optional[Reason] = None) -> dict:
    """One run of the reasoner (axioms-and-reasoning 5.2). Blocks until the
    run ends, as Validate does; 409 while another runs for the project.
    Reads; changes nothing in the model, its revision or its history."""
    body = body or Reason()
    with _errors():
        return editing_service.reason(pid, body.includeData, body.imports)


@router.delete("/{pid}/reasoning")
def stop_reasoning(pid: str) -> dict:
    """Stop: the run's process is killed, not asked (5.2)."""
    with _errors():
        return {"stopped": editing_service.stop_reasoning(pid)}


NOT_REASONED = "Nothing has been reasoned in this project yet."


def _last(pid: str) -> "reasoning.Outcome":
    outcome = editing_service.reasoning_result(pid)
    if outcome is None:
        raise HTTPException(status_code=404, detail=NOT_REASONED)
    return outcome


@router.get("/{pid}/reasoning")
def get_reasoning(
    pid: str,
    group: Optional[str] = None,
    offset: int = 0,
    about: Optional[str] = None,
    imports: bool = ontologies.IMPORTS_PARAM,
) -> dict:
    """The last result: whole, a page of one group, or the facts about one
    entity; each says whether it is stale for the view asking (5.3)."""
    with _errors():
        outcome = _last(pid)
        current = editing_service.reasoning_key(pid, imports)
        if about is not None:
            return outcome.about(about, current)
        if group is not None:
            try:
                return outcome.page(group, offset, current)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="There is no such group.") from exc
        return outcome.summary(current)


@router.get("/{pid}/reasoning/why")
def why(pid: str, s: Optional[str] = None, p: Optional[str] = None, o: Optional[str] = None) -> dict:
    """One fact's one-step reason (5.6); 404 for a fact the result does not
    hold. The fact is optional to FastAPI so that an id the server never
    issued is 404 before anything about the query is said."""
    with _errors():
        outcome = _last(pid)
        if s is None or p is None or o is None:
            raise HTTPException(status_code=422, detail="Name the fact: s, p and o.")
        reason_ = outcome.why(s, p, o)
        if reason_ is None:
            raise HTTPException(status_code=404, detail="That fact is not in the last result.")
        return reason_


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
