"""
================================================================================
FILE: backend/app/routers/data.py
================================================================================

SUMMARY
    The HTTP surface for data snapshots in a project (csv-data-import Section
    8): inspect a file, preview a mapping, import, list, refresh, switch,
    change or edit the mapping, and remove, under /api/projects/{pid}/data.

BASIC IDEA
    Thin, like the other routers: read the body under its cap, hand the work
    to snapshots.py through the editing service (which holds the open
    project's model and its snapshots), and map refusals to status codes in
    one place.

    A file is multipart, as an upload is -- a CSV file or an Excel workbook
    (5.8), told apart by tabular.py -- and is read in chunks and refused
    the moment it passes 5 MB, with the sentence the wizard shows (Section
    9); main.py refuses a declared oversize before FastAPI buffers it (D-015).
    The wizard's dialect, sample and mapping choices travel beside it as two
    JSON form fields. Inspect and preview may name a snapshot instead of
    sending a file: "Change the mapping" works on the copy kept in the
    project, which the browser does not have.

    Reading, previewing and importing run in a worker thread under the
    60-second parse limit, the worker started in a copy of the request's
    context; a run past it is answered 504 and its result dropped. Nothing
    here is a model change: no revision, no undo step (5.7).

INPUTS / INPUT SOURCES
    - HTTP requests from the data wizard and the snapshot list, each mutating
      one carrying the client header local_guard.py requires.
    - editing.editing_service: the open model, under its lock, and its
      SnapshotService.

EXPECTED OUTPUT
    - JSON: an inspection, a preview, a snapshot and its report, a listing,
      a refresh's outcome or mismatch, a removal.
    - 404 for a project or snapshot not issued, 409 for a project not open,
      413 past 5 MB, 422 with a sentence for anything refused, 504 past time.
================================================================================
"""

from __future__ import annotations

import contextvars
import json
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from contextlib import contextmanager
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from .. import tabular
from ..editing import NotOpen, editing_service
from ..projects import UnknownProject
from ..rml import UnsupportedMapping
from ..snapshots import SnapshotError, UnknownSnapshot
from . import ontologies

router = APIRouter(prefix="/api/projects", tags=["data"])

# An edited mapping, or a switch: JSON, never large.
PATCH_MAX_BYTES = 1024 * 1024
PATCH_TOO_LARGE = "A mapping is at most 1 MB."
FILE_TOO_LARGE = (
    f"This file is over {tabular.MAX_BYTES // (1024 * 1024)} MB. Semantic Studio imports files of at most "
    f"{tabular.MAX_BYTES // (1024 * 1024)} MB: {tabular.WHY}."
)


@contextmanager
def _errors():
    try:
        yield
    except (UnknownProject, UnknownSnapshot) as exc:
        raise HTTPException(status_code=404, detail="There is no such project or snapshot.") from exc
    except NotOpen as exc:
        raise HTTPException(status_code=409, detail="Open the project first.") from exc
    except tabular.TabularError as exc:
        status = 413 if exc.kind == "too-large" else 422
        raise HTTPException(status_code=status, detail={"message": str(exc), "kind": exc.kind}) from exc
    except (SnapshotError, UnsupportedMapping) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _known(pid: str, sid: Optional[str] = None) -> None:
    """A project (and snapshot) this server issued, or 404 -- before the body
    is looked at, so a refusal says the same whatever was sent with it."""
    with _errors():
        editing_service.snapshots.projects.folder(pid)
        if sid is not None:
            editing_service.snapshots.folder(pid, sid)


def _bounded(work, *args, **kwargs):
    """Run under the parse time limit (Section 9). Not interruptible, as
    neither the csv module nor rdflib is: the thread finishes on its own
    and its result is dropped."""
    limit = ontologies.PARSE_TIMEOUT_SECONDS
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(contextvars.copy_context().run, work, *args, **kwargs)
        try:
            return future.result(timeout=limit)
        except FuturesTimeout as exc:
            raise HTTPException(
                status_code=504, detail=f"Reading the data took longer than {limit:g} seconds and was stopped."
            ) from exc
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


async def _file_bytes(file: Optional[UploadFile]) -> Optional[bytes]:
    """The file, read in chunks and refused the moment it passes 5 MB."""
    if file is None:
        return None
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(ontologies.CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > tabular.MAX_BYTES:
            raise HTTPException(status_code=413, detail={"message": FILE_TOO_LARGE, "kind": "too-large"})
        chunks.append(chunk)
    return b"".join(chunks)


def _filename(file: Optional[UploadFile]) -> str:
    """The name the browser gave the file: it says CSV or workbook (5.8),
    never where anything is read from."""
    return (file.filename or "") if file is not None else ""


def _json_field(raw: Optional[str], what: str) -> Optional[dict]:
    if raw is None or raw == "":
        return None
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"The {what} must be JSON.") from exc
    if value is not None and not isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f"The {what} must be an object.")
    return value


def _table(
    pid: str, data: Optional[bytes], snapshot: Optional[str], options: Optional[dict], filename: str = "",
):
    """The file sent, or the copy a snapshot keeps; and that snapshot's meta."""
    service = editing_service.snapshots
    if data is not None:
        return service.read(data, options or {}, filename), None
    if snapshot:
        return service.stored_table(pid, snapshot)
    raise HTTPException(status_code=422, detail="Send a file, or name a snapshot.")


@router.post("/{pid}/data/inspect")
async def inspect(
    pid: str,
    file: Optional[UploadFile] = File(default=None),
    options: Optional[str] = Form(default=None),
    snapshot: Optional[str] = Form(default=None),
) -> dict:
    """Step 1 (5.2): the detections, the first rows and the row count of a
    file, or of a snapshot's copy with its choices. Nothing is kept."""
    _known(pid)
    data = await _file_bytes(file)
    opts = _json_field(options, "options")

    def work() -> dict:
        with _errors():
            table, meta = _table(pid, data, snapshot, opts, _filename(file))
            result = tabular.inspect(table)
            if meta is not None:
                result["choices"] = meta.get("choices")
                result["snapshot"] = meta["id"]
            return result

    return await run_in_threadpool(_bounded, work)


@router.post("/{pid}/data/preview")
async def preview(
    pid: str,
    file: Optional[UploadFile] = File(default=None),
    options: Optional[str] = Form(default=None),
    choices: Optional[str] = Form(default=None),
    snapshot: Optional[str] = Form(default=None),
) -> dict:
    """Steps 2 to 4 (5.3 to 5.5): the identifier checked, what each column
    can become, and the first rows as sentences with the report to expect."""
    _known(pid)
    data = await _file_bytes(file)
    opts = _json_field(options, "options")
    chosen = _json_field(choices, "choices") or {}

    def work() -> dict:
        with _errors():
            table, _ = _table(pid, data, snapshot, opts, _filename(file))
            with editing_service.model_reader(pid) as (model, manifest, names):
                return editing_service.snapshots.preview(
                    model=model, manifest=manifest, names=names, table=table, choices=chosen, pid=pid,
                )

    return await run_in_threadpool(_bounded, work)


@router.post("/{pid}/data")
async def import_data(
    pid: str,
    file: Optional[UploadFile] = File(default=None),
    options: Optional[str] = Form(default=None),
    choices: Optional[str] = Form(default=None),
) -> dict:
    """Import: a new snapshot, switched on, with its report (5.5)."""
    _known(pid)
    if file is None:
        raise HTTPException(status_code=422, detail="Send the file to import.")
    data = await _file_bytes(file)
    opts = _json_field(options, "options") or {}
    chosen = _json_field(choices, "choices") or {}

    def work() -> dict:
        with _errors():
            with editing_service.model_reader(pid) as (model, manifest, names):
                made = editing_service.snapshots.create(
                    pid, model=model, manifest=manifest, names=names, data=data,
                    filename=file.filename or "data.csv", options=opts, choices=chosen,
                )
            return {"snapshot": made, "generation": editing_service.snapshots.generation(pid)}

    return await run_in_threadpool(_bounded, work)


@router.get("/{pid}/data")
def list_data(pid: str) -> dict:
    """The project's snapshots, each with its mapping's text for Edit as RML."""
    with _errors():
        listing = editing_service.snapshots.listing(pid)
        for entry in listing["snapshots"]:
            try:
                entry["mappingText"] = editing_service.snapshots.mapping_text(pid, entry["id"])
            except (OSError, UnknownSnapshot):
                entry["mappingText"] = None
        return listing


@router.post("/{pid}/data/{sid}/refresh")
async def refresh(
    pid: str,
    sid: str,
    file: Optional[UploadFile] = File(default=None),
    options: Optional[str] = Form(default=None),
    choices: Optional[str] = Form(default=None),
) -> dict:
    """Refresh (5.7): the mapping run on a new version of the file, at once
    when its headers still match, or the mismatches named; with `choices`,
    the wizard's new mapping for it."""
    _known(pid, sid)
    if file is None:
        raise HTTPException(status_code=422, detail="Send the new version of the file.")
    data = await _file_bytes(file)
    opts = _json_field(options, "options") or {}
    chosen = _json_field(choices, "choices")

    def work() -> dict:
        with _errors():
            service = editing_service.snapshots
            if chosen is None:
                result = service.refresh(pid, sid, data=data, filename=file.filename or "data.csv", options=opts)
            else:
                with editing_service.model_reader(pid) as (model, manifest, names):
                    result = service.refresh(
                        pid, sid, data=data, filename=file.filename or "data.csv", options=opts,
                        choices=chosen, model=model, manifest=manifest, names=names,
                    )
            return {**result, "generation": service.generation(pid)}

    return await run_in_threadpool(_bounded, work)


@router.patch("/{pid}/data/{sid}")
async def patch_data(pid: str, sid: str, request: Request) -> dict:
    """{enabled}: switch on or off. {choices}: change the mapping on the copy
    kept. {mapping}: the mapping edited as RML."""
    _known(pid, sid)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > PATCH_MAX_BYTES:
            raise HTTPException(status_code=413, detail=PATCH_TOO_LARGE)
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks) or b"{}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="The body must be JSON.") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="The body must be an object.")

    def work() -> dict:
        with _errors():
            service = editing_service.snapshots
            if isinstance(body.get("enabled"), bool):
                made = service.set_enabled(pid, sid, body["enabled"])
            elif isinstance(body.get("mapping"), str):
                made = service.edit_mapping(pid, sid, body["mapping"])
            elif isinstance(body.get("choices"), dict):
                with editing_service.model_reader(pid) as (model, manifest, names):
                    made = service.remap(
                        pid, sid, model=model, manifest=manifest, names=names, choices=body["choices"],
                    )
            else:
                raise HTTPException(status_code=422, detail="Send enabled, choices or mapping.")
            return {"snapshot": made, "generation": service.generation(pid)}

    return await run_in_threadpool(_bounded, work)


@router.delete("/{pid}/data/{sid}")
def remove_data(pid: str, sid: str) -> dict:
    """Move the snapshot's folder to the project's .trash/ (5.7)."""
    _known(pid, sid)
    with _errors():
        service = editing_service.snapshots
        return {**service.remove(pid, sid), "generation": service.generation(pid)}
