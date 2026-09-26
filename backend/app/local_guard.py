"""
================================================================================
FILE: backend/app/local_guard.py
================================================================================

SUMMARY
    Makes the local API answer only the application's own pages. Binding to
    127.0.0.1 (S-5) keeps other machines out; it does nothing about other web
    pages open in the user's own browser, which can send requests to
    http://127.0.0.1:8000 as freely as the application can. This middleware is
    the control for that second route (external-access spec, Stage 0, backlog
    S-6, decision D-065).

BASIC IDEA
    Two attacks, two checks, both applied before any route runs.

      * DNS rebinding. An attacker's domain answers with 127.0.0.1, so the
        browser treats the attacker's page and this server as one origin and
        lets the page read every response. What it cannot change is the Host
        header, which still names the attacker's domain. So a request whose
        Host is not a loopback name is refused with 400. Measured before this
        file existed: a forged Host listed the library and deleted an ontology.

      * Cross-site request forgery. A foreign page cannot read our responses,
        but it can still *send* a "simple" request — a multipart form POST is
        one — and the server acts on it. Measured before this file existed: a
        cross-site upload was stored. Every state-changing request must now
        carry `X-Semantic-Studio: 1`. A browser will not attach a custom header
        to a cross-origin request without a CORS preflight, and main.py's CORS
        allowance refuses preflights from foreign origins, so a foreign page
        cannot produce the header. A present Origin header that is not this
        application's own is refused too, as a second, independent check.

    Written as plain ASGI rather than with BaseHTTPMiddleware so it never wraps
    or buffers a body: it looks at headers and either answers or passes the
    request through untouched, which keeps the upload size middleware's
    streaming behaviour intact.

    The allowed names are read on every request rather than once at import, so
    an administrator's SEMANTIC_STUDIO_ALLOWED_HOSTS and a test's monkeypatch
    both take effect without a restart, the same pattern the upload cap uses.

INPUTS / INPUT SOURCES
    - The Host, Origin and X-Semantic-Studio headers of every HTTP request.
    - SEMANTIC_STUDIO_ALLOWED_HOSTS: optional comma-separated extra host names,
      for someone who puts the application behind their own reverse proxy.

EXPECTED OUTPUT
    - The request passes through unchanged when it comes from the application.
    - HTTP 400 for a Host that is not an allowed name.
    - HTTP 403 for a state-changing request without the header, or with a
      foreign Origin.
================================================================================
"""

from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

# The header every state-changing request from our own frontend carries. Its
# value is not a secret and does not need to be: what protects the server is
# that a browser will not let a foreign page attach it without a preflight
# that CORS then refuses.
CLIENT_HEADER = "x-semantic-studio"
CLIENT_HEADER_VALUE = "1"

# Loopback names, and nothing else, by default. "[::1]" arrives in a Host
# header with its brackets; they are stripped before comparison.
DEFAULT_ALLOWED_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# The Vite development server's origins. In development the page is served
# from port 5173 and proxies /api here, so its Origin names 5173 while the Host
# the proxy forwards may name either port. These are the same two origins the
# CORS allowance in main.py names, and no others.
DEV_ORIGINS = frozenset({"http://localhost:5173", "http://127.0.0.1:5173"})

# Methods that read and change nothing. Everything else must prove it came from
# the application.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

BAD_HOST_DETAIL = (
    "This request was refused because it did not come from Semantic Studio "
    "itself. The application only answers pages it serves on this computer."
)
FORBIDDEN_DETAIL = (
    "This request was refused because it did not come from Semantic Studio "
    "itself. Another web page may have tried to change your library."
)


def allowed_hosts() -> frozenset[str]:
    """The host names this server answers to, read fresh on every call."""
    extra = os.environ.get("SEMANTIC_STUDIO_ALLOWED_HOSTS", "")
    names = {name.strip().lower() for name in extra.split(",") if name.strip()}
    return DEFAULT_ALLOWED_HOSTS | names


def host_name(host_header: str) -> str:
    """The name part of a Host header, lower-cased, without port or brackets.

    `localhost:8000` -> `localhost`; `[::1]:8000` -> `::1`. An IPv6 literal is
    only valid in brackets in a Host header, so a bare colon always introduces
    the port.
    """
    value = host_header.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end != -1 else value
    return value.split(":", 1)[0]


def origin_allowed(origin: str, host_header: str, scheme: str = "http") -> bool:
    """True if ``origin`` is this application's own page.

    Its own page means the origin whose scheme, host and port are exactly this
    request's — the page and the API on one origin, as in Docker and a plain
    uvicorn run — or one of the two development origins. "null", sent by
    sandboxed frames and file:// pages, is never ours.
    """
    if origin in DEV_ORIGINS:
        return True
    parts = urlsplit(origin)
    if parts.scheme != scheme or not parts.netloc:
        return False
    return parts.netloc.lower() == host_header.strip().lower()


class LocalOnlyMiddleware:
    """ASGI middleware applying the Host, header and Origin rules above."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        host = headers.get("host", "")

        # Host first, and for every method: a rebinding page can *read*, so a
        # GET is as dangerous as a DELETE here.
        if host_name(host) not in allowed_hosts():
            await _refuse(send, 400, BAD_HOST_DETAIL)
            return

        if scope["method"].upper() not in SAFE_METHODS:
            if headers.get(CLIENT_HEADER) != CLIENT_HEADER_VALUE:
                await _refuse(send, 403, FORBIDDEN_DETAIL)
                return
            origin = headers.get("origin")
            # Absent Origin is allowed: browsers omit it on some same-origin
            # requests, and non-browser clients (curl, the test client) have
            # none. The header check above already stops a foreign page.
            if origin is not None and not origin_allowed(origin, host, scope.get("scheme", "http")):
                await _refuse(send, 403, FORBIDDEN_DETAIL)
                return

        await self.app(scope, receive, send)


async def _refuse(send, status: int, detail: str) -> None:
    """Answer with FastAPI's usual `{"detail": ...}` shape and stop."""
    body = json.dumps({"detail": detail}).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
