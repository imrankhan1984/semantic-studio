from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from ..graph_builder import build_viz_graph, node_details, search_nodes
from ..store import ParseError, detect_format, store

router = APIRouter(prefix="/api/ontologies", tags=["ontologies"])

MAX_FETCH_BYTES = 200 * 1024 * 1024  # 200 MB safety cap

GITHUB_BLOB_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([^/]+)/([^/]+)/(?:blob|raw)/(.+)$"
)

# URL fetching is deliberately restricted to files hosted on standard
# github.com. GitHub Enterprise instances (and arbitrary web servers) are NOT
# supported: their files must be downloaded locally and loaded via file upload.
ALLOWED_GITHUB_HOSTS = {
    "github.com",
    "www.github.com",
    "raw.githubusercontent.com",
    "gist.github.com",
    "gist.githubusercontent.com",
}

URL_NOT_SUPPORTED_DETAIL = (
    "Only files hosted on standard github.com (public repositories) can be "
    "fetched by URL. GitHub Enterprise instances and other servers are not "
    "currently supported — download the ontology file to your computer and "
    "load it via file upload instead."
)


class FetchRequest(BaseModel):
    url: str
    format: Optional[str] = None
    name: Optional[str] = None


def _summary(ontology) -> dict:
    viz = _viz(ontology)
    return {
        "id": ontology.id,
        "name": ontology.name,
        "source": ontology.source,
        "format": ontology.format,
        "triples": ontology.triple_count,
        "nodes": viz["stats"]["nodeCount"],
        "edges": viz["stats"]["edgeCount"],
        "kindCounts": viz["stats"]["kindCounts"],
        "namespaces": ontology.namespaces(),
    }


def _viz(ontology) -> dict:
    if ontology.viz_cache is None:
        ontology.viz_cache = build_viz_graph(ontology.graph)
    return ontology.viz_cache


def _get_or_404(oid: str):
    ontology = store.get(oid)
    if ontology is None:
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    return ontology


@router.get("")
def list_ontologies() -> list[dict]:
    return [_summary(o) for o in store.list()]


@router.post("/upload")
async def upload_ontology(
    file: UploadFile = File(...),
    format: Optional[str] = Form(default=None),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    fmt = detect_format(file.filename, format)
    try:
        ontology = store.add(
            name=file.filename or "uploaded ontology",
            source="upload",
            data=data,
            fmt=fmt,
        )
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _summary(ontology)


def to_raw_url(url: str) -> str:
    """Convert a github.com blob URL to its raw.githubusercontent.com form."""
    match = GITHUB_BLOB_RE.match(url)
    if match:
        owner, repo, rest = match.groups()
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{rest}"
    return url


@router.post("/fetch")
async def fetch_ontology(request: FetchRequest) -> dict:
    raw_input = request.url.strip()
    parsed = urlparse(raw_input)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported.")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_GITHUB_HOSTS:
        raise HTTPException(status_code=400, detail=URL_NOT_SUPPORTED_DETAIL)
    url = to_raw_url(raw_input)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
            response = await client.get(
                url,
                headers={
                    "Accept": "text/turtle, application/rdf+xml, application/ld+json, "
                    "application/n-triples, */*"
                },
            )
            response.raise_for_status()
            data = response.content
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Fetching {url} failed with HTTP {exc.response.status_code}.",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Fetching {url} failed: {exc}") from exc
    if len(data) > MAX_FETCH_BYTES:
        raise HTTPException(status_code=413, detail="The fetched file is too large.")

    filename = url.rsplit("/", 1)[-1] or url
    fmt = detect_format(filename, request.format)
    try:
        ontology = store.add(
            name=request.name or filename,
            source=url,
            data=data,
            fmt=fmt,
        )
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _summary(ontology)


@router.delete("/{oid}")
def delete_ontology(oid: str) -> dict:
    if not store.remove(oid):
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    return {"deleted": oid}


@router.get("/{oid}/graph")
def get_graph(oid: str) -> dict:
    return _viz(_get_or_404(oid))


@router.get("/{oid}/node")
def get_node(oid: str, iri: str = Query(...)) -> dict:
    ontology = _get_or_404(oid)
    details = node_details(ontology.graph, iri)
    if details is None:
        raise HTTPException(status_code=404, detail=f"No triples found for {iri}")
    return details


@router.get("/{oid}/search")
def search(oid: str, q: str = Query(...), limit: int = Query(default=25, le=100)) -> list[dict]:
    ontology = _get_or_404(oid)
    return search_nodes(_viz(ontology), q, limit)
