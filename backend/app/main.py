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
    CORS, the ontology and saved-query routers, a health endpoint, and an
    optional static-file mount so one process can serve both the JSON API and
    the built web UI.

INPUTS / INPUT SOURCES
    - HTTP requests arriving from the browser (the React frontend) or any API
      client, routed to the included routers.
    - Environment variable STATIC_DIR: optional override for where the built
      frontend lives. In Docker this is set to /app/static.
    - The two router modules (ontologies, queries) which define the actual
      endpoints.

EXPECTED OUTPUT
    - A configured `app` object that uvicorn imports and runs (see the Docker
      CMD / local uvicorn command).
    - HTTP/JSON responses for API calls; static HTML/JS/CSS when the frontend
      build directory exists.
================================================================================
"""

# `from __future__ import annotations` makes all type hints lazy (stored as
# strings). It lets us reference types without import-order worries and is
# harmless on modern Python.
from __future__ import annotations

# `os` is used to read the optional STATIC_DIR environment variable.
import os
# `Path` gives us cross-platform filesystem path handling for locating the
# built frontend directory.
from pathlib import Path

# FastAPI is the web framework; CORSMiddleware allows the browser dev server
# on a different port to call this API; StaticFiles serves the built frontend.
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Import the two routers that hold every API endpoint. Splitting them by topic
# (ontologies vs saved queries) keeps this file small.
from .routers import ontologies, queries

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

# Attach every endpoint. `ontologies` handles loading, viewing, the graph, the
# query schema and SPARQL execution; `queries` handles the saved-query library.
app.include_router(ontologies.router)
app.include_router(queries.router)


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
