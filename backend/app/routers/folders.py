"""
================================================================================
FILE: backend/app/routers/folders.py
================================================================================

SUMMARY
    GET /api/folders, the folder browser's listing (projects-anywhere 5.3,
    8.2, D-135): one folder's subfolders, its path bar, the places, and
    whether it can be chosen for New project (mode=create) or opened as a
    project (mode=open).

BASIC IDEA
    Thin: folders.py judges and lists. A GET, but it reveals folder names,
    so local_guard.py requires the client header and a same-origin Origin
    for it as for a write (requirement 7); a cross-site page cannot send the
    header. A refused path is 422 with its sentence, one not found 404; the
    path is refused before any filesystem call when its shape is wrong
    (a network or device path above all).

INPUTS / INPUT SOURCES
    - `path` (absolute; omitted for the home folder), `filter` (the start of
      a name), `mode` (create or open).

EXPECTED OUTPUT
    - {path, parts, parent, places, folders, total, truncated, project,
      choosable, reason}.
================================================================================
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from .. import folders
from ..local_guard import CLIENT_HEADER, CLIENT_HEADER_VALUE, FORBIDDEN_DETAIL, origin_allowed

router = APIRouter(prefix="/api/folders", tags=["folders"])


@router.get("")
def list_folder(
    request: Request,
    path: Optional[str] = Query(default=None, max_length=1024),
    filter: str = Query(default="", max_length=64),
    mode: Literal["create", "open"] = "create",
) -> dict:
    # Asked again here, past local_guard.py: a listing reached without the
    # header or from a foreign page (a route mounted elsewhere, a guard
    # reordered) still answers 403. The removal check found the Origin
    # missing here while the guard was out.
    if request.headers.get(CLIENT_HEADER) != CLIENT_HEADER_VALUE:
        raise HTTPException(status_code=403, detail=FORBIDDEN_DETAIL)
    origin = request.headers.get("origin")
    if origin is not None and not origin_allowed(origin, request.headers.get("host", ""), request.url.scheme):
        raise HTTPException(status_code=403, detail=FORBIDDEN_DETAIL)
    try:
        return folders.listing(path, filter, mode)
    except folders.FolderRefused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except folders.FolderNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
