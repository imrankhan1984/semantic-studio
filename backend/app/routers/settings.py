"""
================================================================================
FILE: backend/app/routers/settings.py
================================================================================

SUMMARY
    The HTTP face of Settings (home-and-settings 5.4, D-120): the three limits
    a person can change, and where the work is kept, for the Limits and
    Library tabs.

BASIC IDEA
    Thin, like every router here: settings.py owns the limits, their ranges and
    the file. The PUT is a changing request, so local_guard.py's header check
    covers it (test_local_guard.py reads the mutating routes from the OpenAPI
    document), and its body is refused past 16 KB while it is read, as /nodes
    and the layout are; main.py refuses a declared length past it first.

    A value outside its range is 422 with the range in the sentence and the
    numbers beside it, and a limit an environment variable owns is 409:
    neither writes anything, and neither is a near miss quietly clamped.

INPUTS / INPUT SOURCES
    - PUT bodies: {"limits": {"largestFile"?: int, "readTime"?: int,
      "firstDrawing"?: int}}.
    - settings.py for the limits; the store's data folder for the path.

EXPECTED OUTPUT
    - GET /api/settings  {limits: [...], dataDir: "<full path>"}
    - PUT /api/settings  the same, after saving; 422 out of range or not a
      limit, 409 set by an environment variable, 413 past 16 KB.
================================================================================
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .. import settings
from .ontologies import read_json_capped

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _answer() -> dict:
    folder = settings.data_dir()
    return {
        "limits": settings.describe(),
        "dataDir": str(folder.resolve()) if folder else "",
    }


@router.get("")
def get_settings() -> dict:
    return _answer()


@router.put("")
async def put_settings(request: Request) -> dict:
    payload = await read_json_capped(request, settings.BODY_MAX_BYTES, settings.BODY_TOO_LARGE)
    changes = payload.get("limits") if isinstance(payload, dict) else None
    if not isinstance(changes, dict):
        raise HTTPException(status_code=422, detail='The body must be JSON: {"limits": {...}}.')
    try:
        # Off the event loop: the write takes a lock and, on Windows, may
        # retry a refused replace (no async route does that work on the loop).
        await run_in_threadpool(settings.update, changes)
    except settings.SetByEnvironment as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "set_by_environment", "key": exc.limit.key, "message": str(exc)},
        ) from exc
    except settings.LimitOutOfRange as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "out_of_range",
                "key": exc.limit.key,
                "min": exc.limit.minimum,
                "max": exc.limit.maximum,
                "message": str(exc),
            },
        ) from exc
    except settings.UnknownSetting as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _answer()
