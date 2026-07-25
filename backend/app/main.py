from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routers import ontologies

app = FastAPI(title="Semantic Viewer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ontologies.router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# In production (Docker) the built frontend is served from STATIC_DIR.
static_dir = Path(os.environ.get("STATIC_DIR", Path(__file__).parent.parent.parent / "frontend" / "dist"))
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
