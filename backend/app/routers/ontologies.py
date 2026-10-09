"""
================================================================================
FILE: backend/app/routers/ontologies.py
================================================================================

SUMMARY
    The main REST API surface. Every endpoint for loading, listing, deleting,
    viewing, exploring (graph + node details + search) and querying (schema +
    SPARQL execution) an ontology lives here, under the /api/ontologies prefix,
    together with its owl:imports routes (list, resolve, refresh, cancel, map,
    chosen files) from external-access Stage 2.

BASIC IDEA
    The read endpoints take ?imports=true, which serves the same view built
    over the ontology plus its resolved imports (imports.py). Off is the
    default and answers exactly as before. A project model with switched-on
    data snapshots is served with their data joined either way
    (csv-data-import 5.6): data is part of the project, not an import. An
    individual from a snapshot says which file and row it came from, and
    has no example form: snapshot data is read-only.

    An open project document is served here too, under its prj-<hex>-<doc> id
    (D-081). The views that show names take ?lang=, the project's display
    language (D-085); a library ontology ignores it. Nothing here changes a
    document: that is routers/projects.py's command and apply routes only.

    This is the thin HTTP layer: it validates and shapes requests, delegates
    the real work to the store and the builder modules, and maps their
    exceptions to the right HTTP status codes. It also implements URL fetching
    (converting github.com "blob" links to raw ones and rejecting GitHub
    Enterprise hosts we cannot authenticate against) and the source-text view.

    The two paths that accept bytes from outside are bounded, and the bounding
    happens *while* reading rather than after. An upload is read in chunks here
    and refused the moment it passes the cap; a fetch is handed to the network
    broker, which judges every redirect hop before connecting and streams the
    body under the same kind of cap. Parsing is handed a wall-clock timeout.
    Doing any of these afterwards would report a number rather than prevent the
    harm.

INPUTS / INPUT SOURCES
    - HTTP requests from the frontend / API clients.
    - Uploaded files (multipart) and JSON fetch/sparql request bodies.
    - Remote RDF files fetched over HTTP for the /fetch endpoint.
    - The shared `store` and `saved_queries` singletons.
    - Environment: SEMANTIC_STUDIO_MAX_UPLOAD_BYTES, SEMANTIC_STUDIO_MAX_FETCH_BYTES,
      SEMANTIC_STUDIO_PARSE_TIMEOUT and SEMANTIC_STUDIO_GRAPH_NODE_BUDGET
      override the default caps.

EXPECTED OUTPUT
    - JSON responses (ontology summaries, graph, one entity's neighbourhood,
      node details -- for a project's example, its classes and fields
      (shacl-authoring 5.8) --, search results, query schema, the queries stored in the
      file, source text, SPARQL results)
      and appropriate HTTP errors:
      400 for a blocked address or refused query, 413 for a body over the cap,
      504 for a parse that ran out of time. The broker's policy decisions are
      mapped once, in main.py: 409 approval required, 403 blocked, 503 offline.
================================================================================
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections import deque
from typing import Literal, Optional
from urllib.parse import urlparse

# FastAPI request-shaping helpers: File/Form/UploadFile for uploads, Query for
# query params, HTTPException for error responses, APIRouter to group endpoints.
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field  # declares/validates JSON request bodies
from rdflib import URIRef
from starlette.concurrency import run_in_threadpool

# Delegate the real work to the domain modules.
from .. import provenance
from ..docs_export import DocsExportError, build_zip
from ..embedded_queries import MAX_TEXT_CHARS as MAX_QUERY_CHARS
from ..embedded_queries import list_embedded_queries
from ..graph_builder import (
    KIND_DATATYPE_PROPERTY,
    KIND_OBJECT_PROPERTY,
    budget_viz,
    labeler,
    neighborhood_viz,
    node_details,
    search_nodes,
)
from .. import examples, modeling_checks
from .. import imports as imports_mod
from ..imports import imports_service
from ..net_guard import BlockedAddress
from ..network_broker import FetchFailed, TooLarge, TooManyRedirects, broker
from ..editing import editing_service
from ..hierarchy import with_inferred
from ..projects import split_document_id
from ..query_schema import describe_query_node
from ..sparql_exec import QueryError, QueryTimeout, execute_select
from ..store import ParseError, ParseTimeout, detect_format, saved_queries, store

PROPERTY_KINDS = (KIND_OBJECT_PROPERTY, KIND_DATATYPE_PROPERTY)

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


# Both caps default to 50 MB. The number was chosen against the catalogue the
# application itself suggests, whose largest entry was then the JUHO thesaurus
# at about 26 MB: a default that refused content the interface recommends would
# be a bug rather than a control. That entry was replaced on 2026-07-31 and the
# catalogue's largest is now FIBO at about 5 MB, so the headroom is wider than
# the argument requires — deliberately left alone, because the cap protects the
# arbitrary public URL a user types, which the catalogue never bounded. An
# administrator with a known-good larger file raises them.
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

# Documentation export is a heavier action than a read — it parses (if needed),
# reserializes and zips a whole ontology — so the endpoint is rate-limited per
# process (D-042). On a single-user localhost box this bounds accidental hammering
# (a held-down key, a retry loop) rather than an attacker, which is the honest
# extent of what a limit without authentication can do here; the SaaS work adds
# per-workspace policy on top. The window is a sliding one over the recent
# request times.
DOCS_RATE_MAX = _env_int("SEMANTIC_STUDIO_DOCS_RATE_MAX", 30)
DOCS_RATE_WINDOW = _env_float("SEMANTIC_STUDIO_DOCS_RATE_WINDOW", 60.0)
_docs_request_times: "deque[float]" = deque()
_docs_rate_lock = threading.Lock()


def _check_docs_rate_limit() -> None:
    """Refuse (HTTP 429) once too many exports have run inside the window.

    Reads the module-level DOCS_RATE_MAX at call time so a test can monkeypatch
    it low without re-importing. Prunes expired timestamps on every call, so the
    deque never grows past the window's worth of requests.
    """
    now = time.monotonic()
    with _docs_rate_lock:
        while _docs_request_times and now - _docs_request_times[0] > DOCS_RATE_WINDOW:
            _docs_request_times.popleft()
        if len(_docs_request_times) >= DOCS_RATE_MAX:
            raise HTTPException(
                status_code=429,
                detail="Too many documentation exports in a short time. Try again in a moment.",
            )
        _docs_request_times.append(now)


def _reset_docs_rate_limit() -> None:
    """Clear the rate-limit window. For tests."""
    with _docs_rate_lock:
        _docs_request_times.clear()
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

# How many neighbours one /neighborhood response may carry. Deliberately not an
# environment variable: the node budget needed one because its default was
# chosen without measuring the browser ceiling, and being wrong there had to
# cost a configuration change. This number is per-click and an order of
# magnitude smaller, so the same argument does not apply.
DEFAULT_NEIGHBORHOOD_LIMIT = 200
MAX_NEIGHBORHOOD_LIMIT = 2000

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


# JSON body for POST /{oid}/sparql: the query text to run. Capped since queries
# can be typed, pasted and opened from files (sparql-text-and-query-files): the
# parser's cost grows with the text, and nothing a person writes by hand comes
# near 100 KB. Refused by validation (422) before rdflib sees a character.
class SparqlRequest(BaseModel):
    query: str = Field(max_length=MAX_QUERY_CHARS)


# The refusal for chosen import files over the closure's total. Here so the
# middleware in main.py and the endpoint say the same sentence.
IMPORT_FILES_TOO_LARGE = "These files together are larger than the 150 MB imports limit."


# JSON body for POST /{oid}/imports/mapping: use a library ontology for an import.
class ImportMapping(BaseModel):
    iri: str
    ontologyId: str


# The merged view is opt-in per request (external-access Stage 2). A parameter
# rather than a second set of routes, so every view the toggle covers takes it
# the same way and the file-only answer stays the default.
IMPORTS_PARAM = Query(default=False, description="Include resolved owl:imports")
# A project document's display language. Validated by the ontology, which
# falls back to the primary language for one it does not carry.
LANG_PARAM = Query(default=None, max_length=35, description="Display language (projects only)")
# The kinds search can be narrowed to; graph_builder.SEARCH_KINDS, spelled
# out so FastAPI refuses anything else with a 422 rather than an empty list.
SearchKind = Literal["class", "concept", "objectProperty", "datatypeProperty", "annotationProperty"]


def _viz(ontology, imports: bool, lang: Optional[str] = None) -> dict:
    return imports_mod.view_viz(ontology, imports, PARSE_TIMEOUT_SECONDS, lang)


def _graph(ontology, imports: bool):
    return imports_mod.view_graph(ontology, imports, PARSE_TIMEOUT_SECONDS)


def _from_data(ontology, iri: str) -> Optional[dict]:
    """The snapshot an individual came from, and its row, or None."""
    view = imports_service.reading(ontology, False)
    info = (view or {}).get("dataFrom", {}).get(iri)
    if info is None:
        return None
    split = split_document_id(ontology.id)
    origin = editing_service.snapshots.origins(split[0]).get(iri) if split else None
    return {**info, "row": origin[1] if origin else None}


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


FETCH_REASON = "You asked Semantic Studio to load an ontology from this address."


@router.post("/fetch")
async def fetch_ontology(request: FetchRequest) -> dict:
    """POST /api/ontologies/fetch -> download an RDF file by URL and store it.

    The download goes through the network broker as `ontology:fetch`, marked
    user-initiated: the typed URL is its own approval for the host typed, so no
    dialog appears for it, but offline, a remembered Block, the address rules
    and a redirect to another host all still apply (external-access Stage 1).
    The broker follows redirects by hand, judging every hop, pins each
    connection to the address it judged, and streams the body under the cap.
    """
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
        # The broker is synchronous (the rdflib chokepoint calls it from a
        # parse thread), so it runs on the threadpool here. The context, and
        # with it any just-once grant this request presented, travels along.
        response = await run_in_threadpool(
            broker.request,
            "ontology:fetch",
            url,
            reason=FETCH_REASON,
            headers=FETCH_HEADERS,
            max_bytes=MAX_FETCH_BYTES,
            timeout=60,
            user_initiated=True,
        )
    except BlockedAddress as exc:
        # Refused before any connection was made to the address in question.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except TooLarge as exc:
        raise HTTPException(
            status_code=413,
            detail=too_large_detail(MAX_FETCH_BYTES, "SEMANTIC_STUDIO_MAX_FETCH_BYTES"),
        ) from exc
    except TooManyRedirects as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except FetchFailed as exc:
        # Connection/timeout/DNS failure.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if response.status >= 400:
        # The remote server returned an error status (404, 403, ...).
        raise HTTPException(
            status_code=502,
            detail=f"Fetching {url} failed with HTTP {response.status}.",
        )
    final_url, data = response.url, response.body

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
    #
    # The count is of what was actually deleted, not of what was listed, so a
    # query that had already gone is not reported as removed. The interface
    # repeats this number back to the user, and a number that overstates the
    # damage is as misleading as the silence this replaced.
    removed = 0
    for entry in saved_queries.list(ontology_id=oid):
        if saved_queries.delete(entry["id"]):
            removed += 1
    return {"deleted": oid, "deletedQueries": removed}


@router.get("/{oid}/graph")
def get_graph(
    oid: str,
    limit: Optional[int] = Query(default=None, ge=1),
    imports: bool = IMPORTS_PARAM,
    lang: Optional[str] = LANG_PARAM,
) -> dict:
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
    return budget_viz(_viz(_get_or_404(oid), imports, lang), budget)


@router.get("/{oid}/neighborhood")
def get_neighborhood(
    oid: str,
    iri: str = Query(...),
    limit: Optional[int] = Query(default=None, ge=1),
    imports: bool = IMPORTS_PARAM,
    lang: Optional[str] = LANG_PARAM,
) -> dict:
    """GET /{oid}/neighborhood?iri=... -> one entity and its top neighbours.

    The other half of the node budget. /graph decides what is drawn on first
    load; this is how the browser grows that outwards, so an entity the budget
    dropped can be drawn rather than only found by search.

    The default is resolved here rather than in the signature for the same
    reason /graph resolves its own, and the clamp is a clamp rather than an
    `le=` for the same reason too: a caller asking for more neighbours than the
    view will draw has not made an error, and `budget` reports what was applied.
    """
    ontology = _get_or_404(oid)
    budget = min(
        DEFAULT_NEIGHBORHOOD_LIMIT if limit is None else limit,
        MAX_NEIGHBORHOOD_LIMIT,
    )
    result = neighborhood_viz(_viz(ontology, imports, lang), iri, budget)
    if result is None:
        # Blank nodes are excluded from the viz graph by build_viz_graph, so
        # this is also the expected answer for one, and for a predicate that
        # was never drawn as an entity.
        raise HTTPException(
            status_code=404,
            detail=f"No entity with that IRI is drawn in this ontology: {iri}",
        )
    return result


@router.get("/{oid}/node")
def get_node(
    oid: str, iri: str = Query(...), imports: bool = IMPORTS_PARAM, lang: Optional[str] = LANG_PARAM
) -> dict:
    """GET /{oid}/node?iri=... -> every statement about one entity (detail panel).

    With imports on, the statements come from the merged view, and an entity
    defined only in an import says which one, so the panel can mark it
    imported and read-only (AC-21).
    """
    ontology = _get_or_404(oid)
    # A project document's title is in the display language, and `names`
    # lists each project language with its value or None (5.4.2).
    graph = _graph(ontology, imports)
    with ontology.reading():
        details = node_details(
            graph,
            iri,
            langs=ontology.label_langs(lang),
            languages=ontology.languages,
        )
        # A project's relationship or attribute carries the 5.9 warnings,
        # read from the document itself: its Fix changes only what is there.
        if details is not None and ontology.editable and details.get("kind") in PROPERTY_KINDS:
            name = labeler(ontology.graph, ontology.label_langs(lang))
            details["warnings"] = modeling_checks.warnings(ontology.graph, URIRef(iri), name)
        # A snapshot's individual is read-only data (csv-data-import 5.6):
        # where it came from, never an example's form.
        from_data = _from_data(ontology, iri) if details is not None and ontology.editable else None
        if from_data is not None:
            details["fromData"] = from_data
        # An example's form (shacl-authoring 5.8): its classes, and a field
        # per attribute and relationship they have, from the same view the
        # panel reads, so a class from an import gives its fields too.
        if (details is not None and ontology.editable and from_data is None
                and details.get("kind") in ("individual", "other")):
            example = examples.example_view(
                graph, URIRef(iri), labeler(graph, ontology.label_langs(lang)),
                list(ontology.languages or ()), own=ontology.graph,
            )
            if example is not None:
                details["example"] = example
    if details is None:
        raise HTTPException(status_code=404, detail=f"No triples found for {iri}")
    if imports:
        source = imports_service.merged(ontology)["importedFrom"].get(iri)
        if source is not None:
            details["importedFrom"] = source
    return details


@router.get("/{oid}/search")
def search(
    oid: str,
    q: str = Query(...),
    limit: int = Query(default=25, le=100),
    imports: bool = IMPORTS_PARAM,
    lang: Optional[str] = LANG_PARAM,
    kind: Optional[SearchKind] = Query(default=None),
) -> list[dict]:
    """GET /{oid}/search?q=... -> ranked label/IRI matches for the search box.

    In a project every name matches, whatever the display language. `kind`
    keeps one kind of entity, before the limit (the editing form's pickers)."""
    ontology = _get_or_404(oid)
    return search_nodes(_viz(ontology, imports, lang), q, limit, kind)


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
        # "Original" view: the exact bytes as loaded, or for a project
        # document its current text.
        try:
            raw = ontology.source_bytes()
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


# Trailing RDF extensions stripped from a name before it becomes a zip filename,
# so "acme-core.ttl" downloads as "acme-core-docs.zip" rather than
# "acme-core.ttl-docs.zip".
_NAME_EXTENSIONS = re.compile(r"\.(ttl|turtle|rdf|rdfs|owl|xml|nt|n3|jsonld|json|trig|nq|nquads)$", re.I)


def _docs_filename(name: str) -> str:
    """A safe "<name>-docs.zip" download filename from an ontology name.

    The name is ontology-controlled, so it is slugged to characters that are
    legal in a filename and safe in a Content-Disposition header; the title
    inside the document is left unchanged. Falls back to "ontology" when nothing
    usable survives.
    """
    base = _NAME_EXTENSIONS.sub("", name).strip()
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-. ")
    return f"{slug or 'ontology'}-docs.zip"


@router.get("/{oid}/documentation")
def get_documentation(oid: str, include_individuals: str = Query("false")) -> Response:
    """GET /{oid}/documentation -> a zip of a self-contained documentation site.

    The zip is a complete static website the user drops into a repository and
    points GitHub Pages at. Generation is local and makes no outbound request.

    Instance data (named individuals and their assertions) is excluded by
    default (D-038); it is included only when the caller passes
    ?include_individuals=true. Any other value, or the parameter's absence, means
    excluded — the dangerous path is opt-in, not the easy default, and it is not
    a boolean pydantic would 422 on for an odd value.

    An ontology whose graph, source, HTML, term count or zip is over its limit is
    refused rather than truncated (a DocsExportError -> 400 with the offending
    size / count named), because a published document with a silently partial
    graph is a false claim about the vocabulary (D-040). The endpoint is
    rate-limited and the export is recorded as a provenance activity (D-042).
    """
    _check_docs_rate_limit()
    ontology = _get_or_404(oid)
    include = (include_individuals or "").lower() == "true"
    try:
        with ontology.reading():
            data = build_zip(ontology, include_individuals=include)
    except DocsExportError as exc:
        # A part of the export is over its limit; the message names the number.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ParseTimeout as exc:
        # Generation parses the ontology if it was not loaded yet.
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # Record the export as a typed provenance activity, after it succeeds, so a
    # refused export leaves no record of a file that was never produced (D-042).
    provenance.record("documentation-export", oid, include_individuals=include)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{_docs_filename(ontology.name)}"'},
    )


@router.get("/{oid}/hierarchy")
def get_hierarchy(
    oid: str, imports: bool = IMPORTS_PARAM, lang: Optional[str] = LANG_PARAM, inferred: bool = False
) -> dict:
    """GET /{oid}/hierarchy -> the subClassOf, broader and subPropertyOf forests.

    A class hierarchy over rdfs:subClassOf, a concept hierarchy over skos:broader
    rooted at concept schemes, and one property hierarchy per property kind
    (object / datatype / annotation) over rdfs:subPropertyOf — each a flat node
    map plus a parent->children adjacency and a root list. classes and concepts
    are always present; a property key appears only when that kind exists. It is
    read every time the Hierarchy tab opens, so it is cached on the ontology like
    the query schema.

    Unbudgeted, unlike /graph: the tree is a fraction of the graph's size and the
    frontend virtualizes it, so the whole asserted structure is returned. A soft
    node cap sets `truncated` rather than refusing the response.

    Every child edge carries `origin`. `?inferred=true` adds an open
    project's current reasoning result as edges with the origin "inferred"
    (D-046, axioms-and-reasoning 5.7); a stale result, or none, adds nothing,
    and absent means asserted only.
    """
    ontology = _get_or_404(oid)
    # Imported rows carry `importedFrom`, and the edge to each one the
    # origin "imported" -- D-046's seam with a new value (AC-21); a
    # snapshot's individuals carry `fromData` (csv-data-import 5.6).
    tree = imports_mod.view_hierarchy(ontology, imports, PARSE_TIMEOUT_SECONDS, lang)
    if inferred:
        pid = editing_service.project_of(oid)
        outcome = editing_service.current_inferred(pid, imports) if pid is not None else None
        if outcome is not None:
            tree = with_inferred(tree, outcome.inferred_kinds(), outcome.inferred_members())
    return tree


@router.get("/{oid}/query-schema")
def get_query_schema(oid: str, imports: bool = IMPORTS_PARAM) -> dict:
    """Class-level schema powering the visual query builder."""
    ontology = _get_or_404(oid)
    return imports_mod.view_query_schema(ontology, imports, PARSE_TIMEOUT_SECONDS)


@router.get("/{oid}/embedded-queries")
def get_embedded_queries(oid: str, imports: bool = IMPORTS_PARAM) -> dict:
    """SPARQL stored in the ontology itself (sh:select, sh:ask, sp:text, ...).

    Read-only: listing a query never runs it. At most 200 rows with the true
    total beside them, each text at most 100 KB and flagged when cut.
    """
    ontology = _get_or_404(oid)
    graph = _graph(ontology, imports)
    with ontology.reading():
        return list_embedded_queries(graph)


@router.get("/{oid}/query-node")
def get_query_node(oid: str, iri: str = Query(...), imports: bool = IMPORTS_PARAM) -> dict:
    """Map a clicked graph node to the class (and optional instance pin).

    Takes the imports flag although the spec's list of changed endpoints does
    not name it: with the merged view on, the builder's steps are imported
    classes too, and describing one against the file alone would refuse it.
    """
    ontology = _get_or_404(oid)
    schema = imports_mod.view_query_schema(ontology, imports, PARSE_TIMEOUT_SECONDS)
    graph = _graph(ontology, imports)
    with ontology.reading():
        described = describe_query_node(graph, iri, schema)
    if described is None:
        raise HTTPException(
            status_code=404,
            detail="This node is not a class and has no type that can be queried.",
        )
    return described


@router.post("/{oid}/sparql")
def run_sparql(oid: str, request: SparqlRequest, imports: bool = IMPORTS_PARAM) -> dict:
    """POST /{oid}/sparql -> run a SELECT query and return the result rows.

    Maps the executor's exceptions to HTTP: timeout -> 504, bad/forbidden
    query -> 400. With imports on it runs over the merged view, which is
    read-only by construction, and says how many imported documents it
    covered, so the results can state what was queried.
    """
    ontology = _get_or_404(oid)
    graph = _graph(ontology, imports)
    try:
        with ontology.reading():
            result = execute_select(graph, request.query)
        if imports:
            result["importDocuments"] = imports_service.merged(ontology)["documents"]
        # What the results covered: the switched-on data snapshots, which
        # the results header names (csv-data-import 5.6).
        view = imports_service.reading(ontology, imports)
        if view is not None and view.get("snapshots"):
            result["dataSources"] = view["snapshots"]
        return result
    except QueryTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except QueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# owl:imports (external-access Stage 2). The logic is in imports.py; these are
# the HTTP shapes around it.
# ---------------------------------------------------------------------------


@router.get("/{oid}/imports")
def list_imports(oid: str) -> dict:
    """The imports panel: each import and its status. Never connects and never
    parses an import (AC-16)."""
    return imports_service.listing(_get_or_404(oid))


@router.post("/{oid}/imports/resolve")
def resolve_imports(oid: str) -> dict:
    """Run the resolution chain over the closure. May answer 409 for a host the
    user has not approved; what resolved before the question is kept."""
    ontology = _get_or_404(oid)
    imports_service.resolve(
        ontology, parse_timeout=PARSE_TIMEOUT_SECONDS, max_bytes=MAX_FETCH_BYTES
    )
    return imports_service.listing(ontology)


@router.post("/{oid}/imports/refresh")
def refresh_imports(oid: str) -> dict:
    """Re-download every import that came from the network, through the broker."""
    ontology = _get_or_404(oid)
    imports_service.resolve(
        ontology, refresh=True, parse_timeout=PARSE_TIMEOUT_SECONDS, max_bytes=MAX_FETCH_BYTES
    )
    return imports_service.listing(ontology)


@router.post("/{oid}/imports/cancel")
def cancel_imports(oid: str) -> dict:
    """Stop a resolution after the document it is on (Section 6's Cancel).

    Not in the spec's endpoint table, which names the Cancel control but no
    route for it. A resolution is one request, so stopping it takes a second.
    """
    _get_or_404(oid)
    return {"cancelled": imports_service.cancel(oid)}


@router.post("/{oid}/imports/mapping")
def map_import(oid: str, body: ImportMapping) -> dict:
    """Use an ontology already in the library for one import IRI, remembered in
    imports-catalog.json. Resolves locally afterwards and never connects."""
    ontology = _get_or_404(oid)
    target = store.get(body.ontologyId)
    if target is None or target.id == ontology.id:
        raise HTTPException(status_code=400, detail="Choose another ontology from your library.")
    imports_service.map_to_library(ontology, body.iri, target, parse_timeout=PARSE_TIMEOUT_SECONDS)
    return imports_service.listing(ontology)


@router.post("/{oid}/imports/files")
async def import_files(
    oid: str,
    request: Request,
    files: list[UploadFile] = File(...),
    forIri: Optional[str] = Form(default=None),  # noqa: N803 - the wire name
    acceptMismatch: bool = Form(default=False),  # noqa: N803
) -> dict:
    """Files the user chose in the browser, matched to imports by the IRI they
    declare (Section 5.3.1).

    The server never reads a path from the client: bytes arrive only through
    the browser's picker, which is why this works the same inside Docker and
    adds no new trust (AC-43). Each file keeps the upload path's 50 MB cap,
    enforced while reading, and the request as a whole the closure's 150 MB.
    """
    ontology = _get_or_404(oid)
    too_big = IMPORT_FILES_TOO_LARGE
    # A declared oversize never reaches here: main.py's middleware refuses it
    # before FastAPI parses the body (D-015). What is left is the real size.
    received: list[tuple[str, bytes]] = []
    total = 0
    for upload in files:
        data = await _read_capped(upload, MAX_UPLOAD_BYTES, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES")
        total += len(data)
        if total > imports_mod.MAX_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail=too_big)
        if data:
            received.append((upload.filename or "chosen file", data))
    result = await run_in_threadpool(
        imports_service.accept_files,
        ontology,
        received,
        for_iri=forIri,
        accept_mismatch=acceptMismatch,
        parse_timeout=PARSE_TIMEOUT_SECONDS,
    )
    result["imports"] = imports_service.listing(ontology)
    return result
