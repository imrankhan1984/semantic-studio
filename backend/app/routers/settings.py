"""
================================================================================
FILE: backend/app/routers/settings.py
================================================================================

SUMMARY
    The HTTP face of Settings (home-and-settings 5.4, D-120): the three limits
    a person can change, where the work is kept, and the organization's
    namespace (design-checks 5.1, D-124), for the Limits, Library and Naming
    tabs.

BASIC IDEA
    Thin, like every router here: settings.py owns the limits, their ranges and
    the file. The PUT is a changing request, so local_guard.py's header check
    covers it (test_local_guard.py reads the mutating routes from the OpenAPI
    document), and its body is refused past 16 KB while it is read, as /nodes
    and the layout are; main.py refuses a declared length past it first.

    A value outside its range is 422 with the range in the sentence and the
    numbers beside it, and a limit an environment variable owns is 409:
    neither writes anything, and neither is a near miss quietly clamped.
    A namespace naming.py refuses is 422 with its sentence, nothing written.
    A body may carry either section or both; both are checked before either
    is kept.

INPUTS / INPUT SOURCES
    - PUT bodies: {"limits"?: {"largestFile"?: int, "readTime"?: int,
      "firstDrawing"?: int}, "naming"?: {"namespace": str | null}}, at least
      one of the two.
    - settings.py for the limits; the store's data folder for the path.

EXPECTED OUTPUT
    - GET /api/settings  {limits: [...], dataDir: "<full path>",
      naming: {namespace, prefix}}
    - PUT /api/settings  the same, after saving; 422 out of range, not a
      limit or a refused namespace, 409 set by an environment variable,
      413 past 16 KB.
================================================================================
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .. import naming, settings
from .ontologies import read_json_capped

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _answer() -> dict:
    folder = settings.data_dir()
    return {
        "limits": settings.describe(),
        "dataDir": str(folder.resolve()) if folder else "",
        "naming": settings.describe_naming(),
    }


@router.get("")
def get_settings() -> dict:
    return _answer()


@router.put("")
async def put_settings(request: Request) -> dict:
    payload = await read_json_capped(request, settings.BODY_MAX_BYTES, settings.BODY_TOO_LARGE)
    shape = 'The body must be JSON: {"limits": {...}} or {"naming": {"namespace": ...}}.'
    if not isinstance(payload, dict) or not ("limits" in payload or "naming" in payload):
        raise HTTPException(status_code=422, detail=shape)
    changes = payload.get("limits", {})
    section = payload.get("naming")
    if not isinstance(changes, dict) or ("naming" in payload and not isinstance(section, dict)):
        raise HTTPException(status_code=422, detail=shape)
    namespace = section.get("namespace") if section is not None else None
    if section is not None:
        if set(section) != {"namespace"} or not (namespace is None or isinstance(namespace, str)):
            raise HTTPException(status_code=422, detail=shape)
        refused = naming.namespace_error(namespace) if namespace else None
        if refused:
            # Before the limits are touched: one refused part keeps all out.
            raise HTTPException(
                status_code=422,
                detail={"code": "namespace", "key": "namespace", "message": refused},
            )
    try:
        # Off the event loop: the write takes a lock and, on Windows, may
        # retry a refused replace (no async route does that work on the loop).
        if changes:
            await run_in_threadpool(settings.update, changes)
        if section is not None:
            await run_in_threadpool(settings.update_naming, namespace)
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
