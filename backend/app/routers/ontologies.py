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

    The two paths that accept bytes from outside are bounded here, and the
    bounding happens *while* reading rather than after. An upload is read in
    chunks and refused the moment it passes the cap; a fetch follows its own
    redirects so `net_guard` can judge every hop before the connection is made,
    then streams the body under the same kind of cap. Parsing is handed a
    wall-clock timeout. Doing any of these afterwards would report a number
    rather than prevent the harm.

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend / API clients.
    - Uploaded files (multipart) and JSON fetch/sparql request bodies.
    - Remote RDF files fetched over HTTP for the /fetch endpoint.
    - The shared `store` and `saved_queries` singletons.
    - Environment: SEMANTIC_STUDIO_MAX_UPLOAD_BYTES, SEMANTIC_STUDIO_MAX_FETCH_BYTES,
      SEMANTIC_STUDIO_PARSE_TIMEOUT and SEMANTIC_STUDIO_GRAPH_NODE_BUDGET
      override the default caps.

EXPECTED OUTPUT
    - JSON responses (ontology summaries, graph, node details, search results,
      query schema, source text, SPARQL results) and appropriate HTTP errors:
      400 for a blocked address or refused query, 413 for a body over the cap,
      504 for a parse that ran out of time.
================================================================================
"""

from __future__ import annotations

import os
import re
from typing import Optional
from urllib.parse import urljoin, urlparse

# httpx is the async HTTP client used to fetch remote ontology files.
import httpx
# FastAPI request-shaping helpers: File/Form/UploadFile for uploads, Query for
# query params, HTTPException for error responses, APIRouter to group endpoints.
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel  # declares/validates JSON request bodies

# Delegate the real work to the domain modules.
from ..graph_builder import budget_viz, node_details, search_nodes
from ..net_guard import MAX_REDIRECTS, BlockedAddress, assert_url_fetchable
from ..query_schema import describe_query_node
from ..sparql_exec import QueryError, QueryTimeout, execute_select
from ..store import ParseError, ParseTimeout, detect_format, saved_queries, store

# All routes below hang off /api/ontologies; "tags" groups them in the docs.
router = APIRouter(prefix="/api/ontologies", tags=["ontologies"])


def _env_int(name: str, default: int) -> int:
    """Read a positive integer from the environment, falling back on nonsense."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_float(name: str, default: float) -> float:
    """Read a positive float from the environment, falling back on nonsense."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


# Both caps default to 50 MB, chosen against the catalogue the application
# itself suggests: the largest entry, the JUHO thesaurus, is about 26 MB. A
# default that refused content the interface recommends would be a bug rather
# than a control. An administrator with a known-good larger file raises them.
MAX_UPLOAD_BYTES = _env_int("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", 50 * 1024 * 1024)
MAX_FETCH_BYTES = _env_int("SEMANTIC_STUDIO_MAX_FETCH_BYTES", 50 * 1024 * 1024)
# Roughly ten times the 5.4 seconds measured for 400,000 triples, which leaves
# room for slower machines and denser formats such as RDF/XML.
PARSE_TIMEOUT_SECONDS = _env_float("SEMANTIC_STUDIO_PARSE_TIMEOUT", 60.0)

# Read size for the streaming upload and download paths. Small enough that the
# overshoot past a limit is negligible, large enough not to dominate the cost.
CHUNK_BYTES = 64 * 1024

# How much source text the viewer receives in one request. The browser has
# to render this, so it is deliberately far below the parse limit.
SOURCE_MAX_BYTES = 2 * 1024 * 1024
SOURCE_HARD_MAX_BYTES = 16 * 1024 * 1024

# How many graph nodes one /graph response may carry. The failure this bounds
# is in the browser, not here: 18,717 nodes left the tab unresponsive for over
# 95 seconds and it never recovered. 2,000 is a safety net rather than an
# optimum — it is roughly nine times below the observed failure, and being
# wrong costs a change to the environment variable rather than a release.
DEFAULT_GRAPH_NODE_BUDGET = _env_int("SEMANTIC_STUDIO_GRAPH_NODE_BUDGET", 2000)
# The ceiling "Show more" climbs towards. A request above it is clamped and the
# clamped value is reported back, so the interface can say the maximum was
# reached, rather than being refused as if the caller had made an error.
MAX_GRAPH_NODE_BUDGET = 20000

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


def too_large_detail(limit: int, variable: str) -> str:
    """The message for a refused oversized body: the limit, and how to raise it."""
    return (
        f"This file is larger than the {limit // (1024 * 1024)} MB limit. "
        f"You can raise the limit with the {variable} environment variable."
    )


async def _read_capped(file: UploadFile, limit: int, variable: str) -> bytes:
    """Read an upload in chunks, refusing the moment it passes ``limit``.

    The point is the refusal happening *during* the read. `await file.read()`
    with no argument pulls the whole body into memory first, which means a size
    check afterwards reports a number after the harm rather than preventing it.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            # Stop here. The rest of the body is never read into this process.
            raise HTTPException(status_code=413, detail=too_large_detail(limit, variable))
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/upload")
async def upload_ontology(
    request: Request,
    file: UploadFile = File(...),
    format: Optional[str] = Form(default=None),
) -> dict:
    """POST /api/ontologies/upload -> parse and store an uploaded file."""
    # Refuse an obviously oversized body before reading a single byte of it.
    # Content-Length covers the whole multipart envelope, not just the file, so
    # a generous allowance for the framing keeps a file that is legitimately
    # just under the limit from being refused on its boundary text alone. The
    # chunked read below is what enforces the limit exactly.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit():
        if int(declared) > MAX_UPLOAD_BYTES + CHUNK_BYTES:
            raise HTTPException(
                status_code=413,
                detail=too_large_detail(MAX_UPLOAD_BYTES, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"),
            )
    data = await _read_capped(file, MAX_UPLOAD_BYTES, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES")
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
            parse_timeout=PARSE_TIMEOUT_SECONDS,
        )
    except ParseTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
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


FETCH_HEADERS = {
    "Accept": "text/turtle, application/rdf+xml, application/ld+json, "
    "application/n-triples, */*"
}


async def _download_capped(client: httpx.AsyncClient, url: str) -> tuple[str, bytes]:
    """Follow redirects by hand, checking each hop, and stream the body under a cap.

    Returns the final URL and its bytes. Redirects are followed here rather than
    by httpx because `follow_redirects=True` would take the hop before anything
    could judge it: a permitted public host that redirects to 127.0.0.1 defeats
    a check applied only to the URL the user typed.
    """
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        # Judge every URL, including the first, immediately before connecting.
        assert_url_fetchable(current, after_redirect=current != url)
        async with client.stream("GET", current, headers=FETCH_HEADERS) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Fetching {current} failed: redirect without a location.",
                    )
                # A Location header may be relative to the URL that sent it.
                current = urljoin(str(response.url), location)
                continue
            response.raise_for_status()
            too_large = HTTPException(
                status_code=413,
                detail=too_large_detail(MAX_FETCH_BYTES, "SEMANTIC_STUDIO_MAX_FETCH_BYTES"),
            )
            # A declared length over the cap means there is no point starting.
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_FETCH_BYTES:
                raise too_large
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes(CHUNK_BYTES):
                total += len(chunk)
                if total > MAX_FETCH_BYTES:
                    # Abandon the response; the connection closes on exit and
                    # the remainder is never pulled into this process.
                    raise too_large
                chunks.append(chunk)
            return current, b"".join(chunks)
    raise HTTPException(
        status_code=502,
        detail=f"That URL redirected more than {MAX_REDIRECTS} times and was not followed.",
    )


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
        # trust_env=False is part of the guard, not a preference. With a proxy
        # set in the environment httpx would hand the hostname to the proxy and
        # let *it* resolve and connect, so the address check here would decide
        # nothing at all. Ontology fetches go direct or not at all.
        # Redirects are handled in _download_capped so each hop can be judged.
        async with httpx.AsyncClient(
            follow_redirects=False, timeout=60, trust_env=False
        ) as client:
            final_url, data = await _download_capped(client, url)
    except BlockedAddress as exc:
        # Refused before any connection was made to the address in question.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        # The remote server returned an error status (404, 403, ...).
        raise HTTPException(
            status_code=502,
            detail=f"Fetching {url} failed with HTTP {exc.response.status_code}.",
        ) from exc
    except httpx.HTTPError as exc:
        # Connection/timeout/DNS failure.
        raise HTTPException(status_code=502, detail=f"Fetching {url} failed: {exc}") from exc

    # Name defaults to the URL's last path segment; format from the extension.
    filename = final_url.rsplit("/", 1)[-1] or final_url
    fmt = detect_format(filename, request.format)
    try:
        ontology = store.add(
            name=request.name or filename,
            source=final_url,
            data=data,
            fmt=fmt,
            parse_timeout=PARSE_TIMEOUT_SECONDS,
        )
    except ParseTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
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
def get_graph(oid: str, limit: Optional[int] = Query(default=None, ge=1)) -> dict:
    """GET /{oid}/graph?limit=N -> the highest-degree N nodes and their edges.

    `ge=1` gives the 422 for zero and negatives through FastAPI's own
    validation. The default is resolved here rather than being written into
    the signature so that it is read at call time: as a `Query(...)` default it
    would be bound at import, and the environment variable could then only be
    moved by reloading the module.

    Over the maximum the request is clamped rather than refused, because a
    caller asking for more than the view can draw has not made an error — the
    response reports the clamped `budget` so the interface can say so.
    """
    budget = min(DEFAULT_GRAPH_NODE_BUDGET if limit is None else limit, MAX_GRAPH_NODE_BUDGET)
    return budget_viz(_get_or_404(oid).viz(), budget)


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
