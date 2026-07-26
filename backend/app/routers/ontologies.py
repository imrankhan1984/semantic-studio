"""
================================================================================
FILE: backend/app/routers/ontologies.py
================================================================================

SUMMARY
    The main REST API surface. Every endpoint for loading, listing, deleting,
    viewing, exploring (graph + node details + search) and querying (schema +
    SPARQL execution) an ontology lives here, under the /api/ontologies prefix.

BASIC IDEA
    This is the thin HTTP layer: it validates and shapes requests, delegates
    the real work to the store and the builder modules, and maps their
    exceptions to the right HTTP status codes. It also implements URL fetching
    (converting github.com "blob" links to raw ones and rejecting GitHub
    Enterprise hosts we cannot authenticate against) and the source-text view.

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend / API clients.
    - Uploaded files (multipart) and JSON fetch/sparql request bodies.
    - Remote RDF files fetched over HTTP for the /fetch endpoint.
    - The shared `store` and `saved_queries` singletons.

EXPECTED OUTPUT
    - JSON responses (ontology summaries, graph, node details, search results,
      query schema, source text, SPARQL results) and appropriate HTTP errors.
================================================================================
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

# httpx is the async HTTP client used to fetch remote ontology files.
import httpx
# FastAPI request-shaping helpers: File/Form/UploadFile for uploads, Query for
# query params, HTTPException for error responses, APIRouter to group endpoints.
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel  # declares/validates JSON request bodies

# Delegate the real work to the domain modules.
from ..graph_builder import node_details, search_nodes
from ..query_schema import describe_query_node
from ..sparql_exec import QueryError, QueryTimeout, execute_select
from ..store import ParseError, detect_format, saved_queries, store

# All routes below hang off /api/ontologies; "tags" groups them in the docs.
router = APIRouter(prefix="/api/ontologies", tags=["ontologies"])

MAX_FETCH_BYTES = 200 * 1024 * 1024  # 200 MB safety cap

# How much source text the viewer receives in one request. The browser has
# to render this, so it is deliberately far below the parse limit.
SOURCE_MAX_BYTES = 2 * 1024 * 1024
SOURCE_HARD_MAX_BYTES = 16 * 1024 * 1024

# Matches a github.com "blob" (or "raw") web URL and captures owner/repo/rest,
# so we can rewrite it to the raw.githubusercontent.com download URL.
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
    """True for GitHub-like hosts that are not part of standard github.com.

    Used to reject GHE URLs with a helpful message rather than letting the
    fetch fail confusingly against an SSO login page.
    """
    if host in GITHUB_COM_HOSTS:
        return False
    # GitHub Pages / user content stay allowed (e.g. example.github.io).
    if host.endswith(".github.io") or host.endswith(".githubusercontent.com"):
        return False
    # A host mentioning "github" that is none of the above is almost certainly
    # a GitHub Enterprise deployment (e.g. github.mycompany.com).
    return "github" in host


# JSON body for POST /fetch: the URL to fetch, with optional format override
# and display name.
class FetchRequest(BaseModel):
    url: str
    format: Optional[str] = None
    name: Optional[str] = None


# JSON body for POST /{oid}/sparql: the query text to run.
class SparqlRequest(BaseModel):
    query: str


def _get_or_404(oid: str):
    """Fetch an ontology by id or raise a 404 — shared by every /{oid} route."""
    ontology = store.get(oid)
    if ontology is None:
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    return ontology


@router.get("")
def list_ontologies() -> list[dict]:
    """GET /api/ontologies -> the dropdown list (lightweight summaries)."""
    return [o.summary() for o in store.list()]


@router.post("/upload")
async def upload_ontology(
    file: UploadFile = File(...),
    format: Optional[str] = Form(default=None),
) -> dict:
    """POST /api/ontologies/upload -> parse and store an uploaded file."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    # Detect the RDF format from the filename (or the caller's override).
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
    """POST /api/ontologies/fetch -> download an RDF file by URL and store it."""
    raw_input = request.url.strip()
    parsed = urlparse(raw_input)
    # Only web URLs are fetchable.
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported.")
    host = (parsed.hostname or "").lower()
    # Reject GitHub Enterprise hosts up front with a helpful message.
    if is_github_enterprise_host(host):
        raise HTTPException(status_code=400, detail=GHE_NOT_SUPPORTED_DETAIL)
    # Turn a github.com "blob" page URL into the raw download URL.
    url = to_raw_url(raw_input)
    try:
        # follow_redirects handles the raw->CDN hop; Accept nudges content negotiation.
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
        # The remote server returned an error status (404, 403, ...).
        raise HTTPException(
            status_code=502,
            detail=f"Fetching {url} failed with HTTP {exc.response.status_code}.",
        ) from exc
    except httpx.HTTPError as exc:
        # Connection/timeout/DNS failure.
        raise HTTPException(status_code=502, detail=f"Fetching {url} failed: {exc}") from exc
    # Guard against a hostile or accidental multi-gigabyte download.
    if len(data) > MAX_FETCH_BYTES:
        raise HTTPException(status_code=413, detail="The fetched file is too large.")

    # Name defaults to the URL's last path segment; format from the extension.
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
    """DELETE /api/ontologies/{oid} -> remove the ontology and its saved queries."""
    if not store.remove(oid):
        raise HTTPException(status_code=404, detail=f"Unknown ontology id: {oid}")
    # Saved queries belong to an ontology; leaving them would orphan them
    # because a re-loaded file gets a fresh id.
    for entry in saved_queries.list(ontology_id=oid):
        saved_queries.delete(entry["id"])
    return {"deleted": oid}


@router.get("/{oid}/graph")
def get_graph(oid: str) -> dict:
    """GET /{oid}/graph -> the visualization nodes/edges for the graph view."""
    return _get_or_404(oid).viz()


@router.get("/{oid}/node")
def get_node(oid: str, iri: str = Query(...)) -> dict:
    """GET /{oid}/node?iri=... -> every statement about one entity (detail panel)."""
    ontology = _get_or_404(oid)
    details = node_details(ontology.ensure_loaded(), iri)
    if details is None:
        raise HTTPException(status_code=404, detail=f"No triples found for {iri}")
    return details


@router.get("/{oid}/search")
def search(oid: str, q: str = Query(...), limit: int = Query(default=25, le=100)) -> list[dict]:
    """GET /{oid}/search?q=... -> ranked label/IRI matches for the search box."""
    ontology = _get_or_404(oid)
    return search_nodes(ontology.viz(), q, limit)


@router.get("/{oid}/source")
def get_source(
    oid: str,
    pretty: bool = Query(default=False),
    max_bytes: int = Query(default=SOURCE_MAX_BYTES, le=SOURCE_HARD_MAX_BYTES),
) -> dict:
    """The ontology as text: the original file, or re-serialized Turtle.

    Large files are truncated at a line boundary so the browser is never
    asked to render tens of megabytes at once.
    """
    ontology = _get_or_404(oid)
    if pretty:
        # "Formatted" view: the graph re-serialized as tidy prefixed Turtle.
        text = ontology.pretty_turtle()
        fmt = "turtle"
    else:
        # "Original" view: the exact bytes as loaded.
        try:
            raw = ontology.data_path.read_bytes()
        except OSError as exc:
            raise HTTPException(
                status_code=404, detail="The stored source file is no longer available."
            ) from exc
        # Normalized so a file written on Windows does not render with a
        # stray carriage return at the end of every line.
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        fmt = ontology.format

    # Report the true size, then truncate for delivery at a line boundary so
    # the browser never has to render tens of megabytes at once.
    total_bytes = len(text.encode("utf-8", errors="replace"))
    truncated = len(text) > max_bytes
    if truncated:
        # Cut on the last newline before the cap so no half-line is shown.
        cut = text.rfind("\n", 0, max_bytes)
        text = text[: cut if cut > 0 else max_bytes]
    return {
        "text": text,
        "format": fmt,
        "pretty": pretty,
        "truncated": truncated,
        "bytes": total_bytes,
        "lines": text.count("\n") + 1,
        "name": ontology.name,
    }


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
    """POST /{oid}/sparql -> run a SELECT query and return the result rows.

    Maps the executor's exceptions to HTTP: timeout -> 504, bad/forbidden
    query -> 400.
    """
    ontology = _get_or_404(oid)
    try:
        return execute_select(ontology.ensure_loaded(), request.query)
    except QueryTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except QueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
