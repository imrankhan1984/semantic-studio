"""
================================================================================
FILE: backend/app/main.py
================================================================================

SUMMARY
    This is the entry point of the Semantic Studio backend. It constructs the
    FastAPI application object, wires in the HTTP routers that expose the REST
    API, enables cross-origin requests from the dev frontend, exposes a health
    check, and — in a production/Docker build — serves the compiled frontend
    as static files from the same server.

BASIC IDEA
    A single FastAPI "app" object is the thing an ASGI server (uvicorn) runs.
    Everything the backend can do is attached to this object: middleware for
    CORS and for refusing oversized upload bodies, the ontology and saved-query
    routers, a health endpoint, and an optional static-file mount so one process
    can serve both the JSON API and the built web UI.

    The upload size middleware lives here rather than in the router because it
    has to run before FastAPI parses the request body. Resolving
    `UploadFile = File(...)` reads and buffers the whole multipart body, so a
    limit checked inside the endpoint reports a number after the fact instead of
    preventing anything.

INPUTS / INPUT SOURCES
    - HTTP requests arriving from the browser (the React frontend) or any API
      client, routed to the included routers.
    - Environment variable STATIC_DIR: optional override for where the built
      frontend lives. In Docker this is set to /app/static.
    - The upload cap, read from the ontologies router at request time.
    - The three router modules (ontologies, queries, network) which define
      the actual endpoints.

EXPECTED OUTPUT
    - A configured `app` object that uvicorn imports and runs (see the Docker
      CMD / local uvicorn command).
    - HTTP/JSON responses for API calls; static HTML/JS/CSS when the frontend
      build directory exists.
    - HTTP 413 for an upload whose declared size exceeds the cap, returned
      before the body is read.
    - HTTP 400 or 403 for a request that did not come from the application's
      own page (local_guard.py), before any other middleware or route runs.
    - HTTP 409, 403 or 503 when the network broker needs the user's approval,
      finds the host blocked, or is offline (network_broker.py, D-066).
================================================================================
"""

# `from __future__ import annotations` makes all type hints lazy (stored as
# strings). It lets us reference types without import-order worries and is
# harmless on modern Python.
from __future__ import annotations

# `os` is used to read the optional STATIC_DIR environment variable.
import os
import re
# `Path` gives us cross-platform filesystem path handling for locating the
# built frontend directory.
from pathlib import Path
from typing import Optional

# FastAPI is the web framework; CORSMiddleware allows the browser dev server
# on a different port to call this API; StaticFiles serves the built frontend.
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# Import the two routers that hold every API endpoint. Splitting them by topic
# (ontologies vs saved queries) keeps this file small.
from .local_guard import LocalOnlyMiddleware
from .network_broker import ApprovalRequired, GrantScopeMiddleware, HostBlocked, Offline
from .routers import network, ontologies, queries

# Create the application. The title/version surface in the auto-generated
# OpenAPI docs at /docs.
app = FastAPI(title="Semantic Studio", version="0.2.0")

# During local development the frontend runs on Vite's port 5173 while this API
# runs on 8000, so the browser makes cross-origin requests. This middleware
# tells the browser those origins are allowed. In the Docker build the frontend
# is served from this same origin, so CORS is not needed there but is harmless.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],  # permit GET/POST/DELETE/etc. from the dev frontend
    allow_headers=["*"],  # permit any request header (e.g. Content-Type)
)

@app.middleware("http")
async def refuse_oversized_bodies(request: Request, call_next):
    """Refuse a body that declares itself too large, before anything reads it.

    This has to be middleware rather than a check inside the endpoint. FastAPI
    resolves `UploadFile = File(...)` by parsing the whole multipart body
    *before* the endpoint function is entered, so by the time handler code could
    look at Content-Length the body has already been received and buffered.
    Measured: rejecting a 30 MB upload against a 1 MB limit from inside the
    handler peaked at 124 MB. Refusing here keeps it flat.

    The cap is read from the router module at call time rather than imported
    once, so it stays a single source of truth and tests can adjust it.

    Two routes take a multipart body: the upload, and the files chosen for
    unresolved imports (external-access Stage 2), whose request as a whole is
    held to the imports closure's 150 MB. Both endpoints still enforce the real
    size while reading; this is the half that runs before FastAPI buffers the
    body (D-015).
    """
    if request.method != "POST":
        return await call_next(request)
    path = request.url.path
    limit: Optional[int] = None
    detail = ""
    if path == "/api/ontologies/upload":
        limit = ontologies.MAX_UPLOAD_BYTES
        detail = ontologies.too_large_detail(limit, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES")
    elif _IMPORT_FILES_PATH.match(path):
        limit = ontologies.imports_mod.MAX_TOTAL_BYTES
        detail = ontologies.IMPORT_FILES_TOO_LARGE
    if limit is not None:
        declared = request.headers.get("content-length")
        # Content-Length covers the whole multipart envelope, not just the
        # files, so allow for the framing; the endpoint enforces the exact
        # limit while reading.
        if declared and declared.isdigit() and int(declared) > limit + ontologies.CHUNK_BYTES:
            return JSONResponse(status_code=413, content={"detail": detail})
    return await call_next(request)


# The one parameterised multipart route. Matched rather than compared, because
# the ontology id is in the path.
_IMPORT_FILES_PATH = re.compile(r"^/api/ontologies/[^/]+/imports/files$")


# Carries a just-once grant from the X-Semantic-Studio-Grant header to the
# broker, and spends it when the request ends. Inside local_guard, so a request
# the guard refuses never reaches it.
app.add_middleware(GrantScopeMiddleware)

# Added last so it runs first: Starlette makes the most recently added
# middleware the outermost. A request from a foreign page (DNS rebinding, or a
# cross-site form post) is refused here before CORS, the upload cap or any route
# sees it. See local_guard.py and decision D-065.
app.add_middleware(LocalOnlyMiddleware)


# Attach every endpoint. `ontologies` handles loading, viewing, the graph, the
# query schema and SPARQL execution; `queries` handles the saved-query library.
app.include_router(ontologies.router)
app.include_router(queries.router)
app.include_router(network.router)


# The broker's three policy decisions, mapped once for every route. They can
# surface from anywhere that parses -- an upload, a fetch, or the lazy restore
# behind a GET -- so mapping them per route would miss one. 409 carries the
# structured body the approval dialog is built from (external-access Section
# 8); the other two carry the sentence the user sees.
@app.exception_handler(ApprovalRequired)
async def _approval_required(_request: Request, exc: ApprovalRequired) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": exc.body()})


@app.exception_handler(HostBlocked)
async def _host_blocked(_request: Request, exc: HostBlocked) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": str(exc)})


@app.exception_handler(Offline)
async def _offline(_request: Request, exc: Offline) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


# A trivial liveness probe. Deployment tooling (and our own scripts) hit this
# to confirm the server is up before doing anything else.
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# --- serve the built frontend in production ---------------------------------
# In a Docker image the compiled React app is copied to /app/static and
# STATIC_DIR points there; locally this falls back to frontend/dist (which only
# exists after `npm run build`). When the directory is present we mount it at
# the site root so the same server delivers both the API and the web UI. When
# it is absent (typical during backend-only development) we simply skip it and
# the Vite dev server serves the frontend instead.
static_dir = Path(os.environ.get("STATIC_DIR", Path(__file__).parent.parent.parent / "frontend" / "dist"))
if static_dir.is_dir():
    # html=True makes StaticFiles serve index.html for the root path, which is
    # what a single-page app needs.
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
