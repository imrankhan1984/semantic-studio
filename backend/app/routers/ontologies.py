from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from ..graph_builder import node_details, search_nodes
from ..query_schema import describe_query_node
from ..sparql_exec import QueryError, QueryTimeout, execute_select
from ..store import ParseError, detect_format, saved_queries, store

router = APIRouter(prefix="/api/ontologies", tags=["ontologies"])

MAX_FETCH_BYTES = 200 * 1024 * 1024  # 200 MB safety cap

GITHUB_BLOB_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([^/]+)/([^/]+)/(?:blob|raw)/(.+)$"
)

# Any directly reachable http(s) URL can be fetched, including public
# github.com files. GitHub Enterprise instances are the one exception: they
# sit behind corporate SSO the backend cannot authenticate against, so
# GHE-looking hosts are rejected with an explicit explanation instead of a
# confusing parse error.
GITHUB_COM_HOSTS = {
    "github.com",
    "www.github.com",
    "raw.githubusercontent.com",
    "gist.github.com",
    "gist.githubusercontent.com",
    "objects.githubusercontent.com",
    "media.githubusercontent.com",
    "codeload.github.com",
}

GHE_NOT_SUPPORTED_DETAIL = (
    "This looks like a GitHub Enterprise URL. GitHub Enterprise instances are "
    "not currently supported — download the ontology file to your computer "
    "and load it via file upload instead. Public github.com files and any "
    "other directly reachable RDF URL can be fetched."
)


def is_github_enterprise_host(host: str) -> bool:
    """True for GitHub-like hosts that are not part of standard github.com."""
    if host in GITHUB_COM_HOSTS:
        return False
    # GitHub Pages / user content stay allowed (e.g. example.github.io).
    if host.endswith(".github.io") or host.endswith(".githubusercontent.com"):
        return False
    return "github" in host


class FetchRequest(BaseModel):
    url: str
    format: Optional[str] = None
    name: Optional[str] = None


class SparqlRequest(BaseModel):
    query: str


def _get_or_404(oid: str):
    ontology = store.get(oid)
    if ontology is None:
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    return ontology


@router.get("")
def list_ontologies() -> list[dict]:
    return [o.summary() for o in store.list()]


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
    return ontology.summary()


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
    if is_github_enterprise_host(host):
        raise HTTPException(status_code=400, detail=GHE_NOT_SUPPORTED_DETAIL)
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
    return ontology.summary()


@router.delete("/{oid}")
def delete_ontology(oid: str) -> dict:
    if not store.remove(oid):
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    # Saved queries belong to an ontology; leaving them would orphan them
    # because a re-loaded file gets a fresh id.
    for entry in saved_queries.list(ontology_id=oid):
        saved_queries.delete(entry["id"])
    return {"deleted": oid}


@router.get("/{oid}/graph")
def get_graph(oid: str) -> dict:
    return _get_or_404(oid).viz()


@router.get("/{oid}/node")
def get_node(oid: str, iri: str = Query(...)) -> dict:
    ontology = _get_or_404(oid)
    details = node_details(ontology.ensure_loaded(), iri)
    if details is None:
        raise HTTPException(status_code=404, detail=f"No triples found for {iri}")
    return details


@router.get("/{oid}/search")
def search(oid: str, q: str = Query(...), limit: int = Query(default=25, le=100)) -> list[dict]:
    ontology = _get_or_404(oid)
    return search_nodes(ontology.viz(), q, limit)


@router.get("/{oid}/query-schema")
def get_query_schema(oid: str) -> dict:
    """Class-level schema powering the visual query builder."""
    return _get_or_404(oid).query_schema()


@router.get("/{oid}/query-node")
def get_query_node(oid: str, iri: str = Query(...)) -> dict:
    """Map a clicked graph node to the class (and optional instance pin)."""
    ontology = _get_or_404(oid)
    described = describe_query_node(ontology.ensure_loaded(), iri, ontology.query_schema())
    if described is None:
        raise HTTPException(
            status_code=404,
            detail="This node is not a class and has no type that can be queried.",
        )
    return described


@router.post("/{oid}/sparql")
def run_sparql(oid: str, request: SparqlRequest) -> dict:
    ontology = _get_or_404(oid)
    try:
        return execute_select(ontology.ensure_loaded(), request.query)
    except QueryTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except QueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
