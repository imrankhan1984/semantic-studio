"""
================================================================================
FILE: backend/app/routers/network.py
================================================================================

SUMMARY
    The HTTP face of the network broker: read the policy, grant or block a
    site for one purpose, revoke a decision, switch offline on and off, and
    read the activity log. Everything the Network panel and the approval dialog
    need, and nothing that makes a connection.

BASIC IDEA
    Thin, like every router here. The broker (network_broker.py) owns the
    policy and the log; this file validates the shapes and hands over.

    These routes change who the application will connect to, so they are the
    reason Stage 0 (local_guard.py, D-065) had to come first: without it, any
    web page could post a grant for itself. The guard covers them because
    test_local_guard.py reads the mutating routes from the OpenAPI document.

INPUTS / INPUT SOURCES
    - JSON bodies from the frontend's approval dialog and Network panel.

EXPECTED OUTPUT
    - GET  /api/network/policy          {offline, grants:[...]} (remembered only)
    - POST /api/network/grants          the grant, with its id
    - DELETE /api/network/grants/{id}   {revoked: id}, or 404
    - PUT  /api/network/offline         {offline}
    - GET  /api/network/activity        the latest entries, newest first
================================================================================
"""

from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..network_broker import (
    ACTIVITY_DEFAULT_LIMIT,
    ACTIVITY_MAX_LIMIT,
    CAPABILITIES,
    broker,
    normalize_host,
)

router = APIRouter(prefix="/api/network", tags=["network"])

# A host name or an address literal, nothing else. The host is shown back to
# the user in the Network panel and compared against URLs, so a value that
# could not be a host is refused rather than stored.
_HOST_RE = re.compile(r"^[a-z0-9.\-:\[\]]{1,253}$")


class GrantRequest(BaseModel):
    capability: str
    host: str
    decision: Literal["allow", "block"]
    remember: bool = False


class OfflineRequest(BaseModel):
    offline: bool


@router.get("/policy")
def get_policy() -> dict:
    return broker.policy.snapshot()


@router.post("/grants")
def post_grant(body: GrantRequest) -> dict:
    if body.capability not in CAPABILITIES:
        raise HTTPException(status_code=422, detail=f"Unknown capability: {body.capability}")
    host = normalize_host(body.host)
    if not host or not _HOST_RE.match(host):
        raise HTTPException(status_code=422, detail="That is not a host name.")
    return broker.policy.grant(body.capability, host, body.decision, body.remember)


@router.delete("/grants/{grant_id}")
def delete_grant(grant_id: str) -> dict:
    if not broker.policy.revoke(grant_id):
        raise HTTPException(status_code=404, detail=f"Unknown grant: {grant_id}")
    return {"revoked": grant_id}


@router.put("/offline")
def put_offline(body: OfflineRequest) -> dict:
    broker.policy.set_offline(body.offline)
    return {"offline": body.offline}


@router.get("/activity")
def get_activity(
    limit: int = Query(default=ACTIVITY_DEFAULT_LIMIT, ge=1, le=ACTIVITY_MAX_LIMIT),
) -> list[dict]:
    return broker.activity.latest(limit)
