"""
================================================================================
FILE: backend/app/routers/network.py
================================================================================

SUMMARY
    The HTTP face of the network broker: read the policy, grant or block a
    site for one purpose, revoke a decision, switch offline on and off, and
    read the activity log; and the connection settings for corporate networks
    (Stage 4): the proxy, the certificate file and Test connection. Everything
    the Network panel and the approval dialog need. Only Test connection makes
    a connection, and only through the broker.

BASIC IDEA
    Thin, like every router here. The broker (network_broker.py) owns the
    policy and the log; this file validates the shapes and hands over.

    These routes change who the application will connect to, so they are the
    reason Stage 0 (local_guard.py, D-065) had to come first: without it, any
    web page could post a grant for itself, or set its own proxy and
    certificate and read every connection. The guard covers them because
    test_local_guard.py reads the mutating routes from the OpenAPI document.

    The certificate upload is read in chunks against its 1 MB, as main.py's
    middleware refuses a larger declared body first (enforced twice), and is
    checked off the event loop.

INPUTS / INPUT SOURCES
    - JSON bodies from the frontend's approval dialog and Network panel.
    - A certificate file, multipart, from the Connection section.

EXPECTED OUTPUT
    - GET  /api/network/policy          {offline, grants:[...]} (remembered only)
    - POST /api/network/grants          the grant, with its id
    - DELETE /api/network/grants/{id}   {revoked: id}, or 404
    - PUT  /api/network/offline         {offline}
    - GET  /api/network/activity        the latest entries, newest first
    - GET  /api/network/connection      the connection settings, the system
                                        proxy found now, and the trust in use
    - PUT  /api/network/connection      the same, saved; 422 names each field
    - PUT  /api/network/connection/ca   a certificate file added; 413 or 422
    - DELETE /api/network/connection/ca the file removed
    - POST /api/network/test            {ok, stage, message}
================================================================================
"""

from __future__ import annotations

import re
from typing import Literal, Optional, Union

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from ..network_broker import (
    ACTIVITY_DEFAULT_LIMIT,
    ACTIVITY_MAX_LIMIT,
    CA_MAX_BYTES,
    CA_TOO_LARGE,
    CAPABILITIES,
    CertificateRefused,
    ConnectionInvalid,
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


class ProxyPair(BaseModel):
    host: str = ""
    # A number, or the text as typed: the broker judges it and says why.
    port: Optional[Union[int, str]] = None


class ConnectionRequest(BaseModel):
    mode: str
    https: ProxyPair = ProxyPair()
    http: ProxyPair = ProxyPair()
    noProxy: list[str] = []


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


@router.get("/connection")
def get_connection() -> dict:
    return broker.connection_view()


@router.put("/connection")
def put_connection(body: ConnectionRequest) -> dict:
    try:
        return broker.save_connection(body.model_dump())
    except ConnectionInvalid as exc:
        raise HTTPException(status_code=422, detail=exc.body()) from None


@router.put("/connection/ca")
async def put_connection_ca(file: UploadFile = File(...)) -> dict:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > CA_MAX_BYTES:
            # Refused while reading: the rest never enters this process.
            raise HTTPException(status_code=413, detail=CA_TOO_LARGE)
        chunks.append(chunk)
    try:
        return await run_in_threadpool(broker.set_ca_file, b"".join(chunks), file.filename or "")
    except CertificateRefused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.delete("/connection/ca")
def delete_connection_ca() -> dict:
    return broker.remove_ca_file()


@router.post("/test")
def post_test() -> dict:
    return broker.test_connection()
