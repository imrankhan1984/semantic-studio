"""
================================================================================
FILE: backend/app/store.py
================================================================================

SUMMARY
    Disk-backed store of loaded ontologies. Holds every ontology the user has
    loaded, parses RDF from bytes, persists each one to a per-user data
    directory so it survives restarts, and hands out cached derived views
    (visualization graph, query schema, pretty-printed Turtle).

BASIC IDEA
    Each ontology is kept as an rdflib.Graph so downstream features (graph
    view, query schema, SPARQL execution, source re-serialization) can build
    on it directly. The original file bytes plus a small JSON metadata summary
    are written to disk. Parsing is LAZY: on startup we only read the metadata
    files (instant), and the potentially large RDF is parsed the first time an
    ontology is actually used. Expensive derived products are cached on the
    Ontology object so they are computed once.

    The metadata file also carries a `card`: the twenty-entity sketch the home
    screen draws as a thumbnail, computed during the parse that already happens
    at ingest. It is there so that listing the library never needs a parse — a
    home screen that parsed six ontologies to draw six thumbnails would undo the
    lazy loading above. Anything stored before it existed simply has no `card`,
    and nothing backfills one.

    Every derived view is stored with the key it was built from -- the
    ontology's `revision`, and for a project document its label languages --
    and rebuilt when the key has moved (D-081). A library ontology never
    changes revision, so for it nothing is ever rebuilt. A project document
    (projects.py, editing.py) is an Ontology too, registered here under a
    `prj-<hex>-<doc>` id while its project is open, so every read endpoint
    serves it unchanged; it is kept out of `list()`, which is the library.

    A parse can be given a wall-clock timeout by the caller. It runs on a
    worker thread so the request can be released; the work itself cannot be
    killed, which is why the upload size cap matters (see D-013).

    A JSON-LD file may need a remote @context, which the network broker fetches
    only once the user has allowed it (D-066). The contexts fetched at ingest
    are kept beside the file as <id>.contexts.json and replayed when the file
    is re-parsed after a restart, so reading a stored ontology never connects
    and never asks twice.

INPUTS / INPUT SOURCES
    - Raw file bytes from uploads or URL fetches (passed to `add`).
    - A format hint from the file extension / caller, else content sniffing.
    - An optional parse timeout, supplied by the router from configuration.
    - Previously persisted <id>.rdf, <id>.meta.json and (for JSON-LD with a
      remote context) <id>.contexts.json files in the data dir.
    - Environment variable SEMANTIC_STUDIO_DATA_DIR (or the legacy
      SEMANTIC_VIEWER_DATA_DIR) to relocate the data directory.

EXPECTED OUTPUT
    - Ontology objects with a stable id, metadata summary, and lazily parsed
      graph, plus viz/schema/hierarchy/pretty views cached per revision. A second cache,
      `merged_cache`, holds the views over the file plus its resolved imports;
      imports.py fills it and it never mixes with the file-only one. A
      third, `data_cache`, holds a project model's views with its data
      snapshots joined (csv-data-import 5.6).
    - Raises ParseError for unparseable input and ParseTimeout when a bounded
      parse runs out of time; the router maps them to HTTP 422 and 504.
      The broker's decisions (ApprovalRequired, Offline, HostBlocked) pass
      through unchanged and main.py maps them to 409, 503 and 403.
    - Two module-level singletons imported across the app: `store` (the
      ontology store) and `saved_queries` (the saved-query library, kept in a
      sibling directory).
================================================================================
"""

from __future__ import annotations

# Standard library:
#   contextvars - carry the request's grants into the parse worker thread
#   json      - read/write the per-ontology metadata files
#   os        - read the data-directory environment override
#   re        - pull a file extension off a name for format detection
#   sys       - detect the operating system to pick the OS-standard data dir
#   threading - locks so concurrent requests do not double-parse or corrupt state
#   uuid      - generate stable, collision-free ontology ids
import contextlib
import contextvars
import json
import os
import re
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

# rdflib is the RDF engine: Graph holds triples; guess_format maps a filename
# to an rdflib parser name.
from rdflib import Graph
from rdflib.util import guess_format

# Derived-view builders and the saved-query store live in sibling modules.
from .graph_builder import build_card_sketch, build_viz_graph, ontology_iris
from .hierarchy import build_hierarchy
from . import network_broker
from .net_guard import (
    BlockedAddress,
    install_rdflib_guard,
    recording_contexts,
    replaying_contexts,
)
from .queries_store import SavedQueryStore
from .query_schema import build_query_schema

# Installed once, at import, because it is a property of the process rather
# than of any one parse: a document may ask rdflib to fetch a remote JSON-LD
# @context, and that request must be judged wherever it originates. See D-016.
install_rdflib_guard()

# Map common file extensions to the rdflib parser name. Detection prefers this
# table (it is more reliable than rdflib's own guesser for our formats).
EXTENSION_FORMATS = {
    ".ttl": "turtle",
    ".turtle": "turtle",
    ".n3": "n3",
    ".nt": "nt",
    ".ntriples": "nt",
    ".rdf": "xml",
    ".rdfs": "xml",
    ".owl": "xml",
    ".xml": "xml",
    ".jsonld": "json-ld",
    ".json": "json-ld",
    ".trig": "trig",
    ".nq": "nquads",
    ".nquads": "nquads",
}

# When the format cannot be inferred from the name, try these parsers in order
# and keep whichever one succeeds. Turtle is first because it is the most common.
SNIFF_ORDER = ["turtle", "xml", "json-ld", "nt", "trig"]


def contexts_path_for(data_path: Path) -> Path:
    """Where the JSON-LD contexts an ontology needed at ingest are kept."""
    return data_path.with_suffix(".contexts.json")


class ParseError(Exception):
    """Raised when the payload cannot be parsed as RDF in any known format."""


class ParseTimeout(Exception):
    """Raised when a parse outlasts its wall-clock budget (maps to HTTP 504)."""


def default_data_dir() -> Path:
    """Return the per-user data directory (overridable via env var).

    Chooses the OS-standard per-user location so each user of a machine keeps
    their own library, and migrates a pre-rename folder if one exists.
    """
    # An explicit override wins. The legacy variable is still honoured so users
    # who set it before the rename are not broken.
    env = os.environ.get("SEMANTIC_STUDIO_DATA_DIR") or os.environ.get(
        "SEMANTIC_VIEWER_DATA_DIR"  # pre-rename variable
    )
    if env:
        return Path(env)

    # Otherwise pick the conventional per-user data location for the OS.
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))

    current = base / "semantic-studio"
    legacy = base / "semantic-viewer"
    # The app was renamed from Semantic Viewer; move an existing library over
    # once so previously loaded ontologies and saved queries are not orphaned.
    if not current.exists() and legacy.is_dir():
        try:
            legacy.rename(current)
        except OSError:
            return legacy  # keep using it in place if the move is not possible
    return current


def detect_format(filename: Optional[str], explicit: Optional[str] = None) -> Optional[str]:
    """Best-effort RDF format detection from an explicit hint or a file name.

    Returns an rdflib parser name, or None when nothing can be inferred (in
    which case the caller falls back to content sniffing in `parse_rdf`).
    """
    # A caller-supplied format always wins.
    if explicit:
        return explicit
    if filename:
        # Take the trailing ".ext" and look it up in our table first.
        match = re.search(r"(\.[A-Za-z0-9]+)$", filename)
        if match and match.group(1).lower() in EXTENSION_FORMATS:
            return EXTENSION_FORMATS[match.group(1).lower()]
        # Fall back to rdflib's own filename-based guesser.
        guessed = guess_format(filename)
        if guessed:
            return guessed
    return None


def _parse_rdf_blocking(data: bytes, fmt: Optional[str]) -> tuple[Graph, str]:
    """The actual parse loop: hinted format first, then the sniff order."""
    # Try the hinted format first (if any), then the remaining sniff formats.
    attempts = [fmt] if fmt else []
    attempts += [f for f in SNIFF_ORDER if f not in attempts]
    errors: list[str] = []
    for candidate in attempts:
        graph = Graph()
        try:
            graph.parse(data=data, format=candidate)
            return graph, candidate
        except network_broker.NetworkDecision:
            # Offline, a Block, or a question for the user. Like the refusal
            # below it is about the document, not the format, and the router
            # needs the exception itself to answer 503, 403 or 409.
            raise
        except BlockedAddress as exc:
            # Not "this format did not match". The format matched well enough
            # for the parser to act on the document and ask for a resource we
            # refused, so trying the remaining formats would only bury the one
            # message that explains what happened. Stop and lead with it.
            raise ParseError(str(exc)) from exc
        except Exception as exc:  # rdflib raises many parser-specific errors
            # Record why this candidate failed and keep trying the next one.
            errors.append(f"{candidate}: {exc}")
    # Every candidate failed; surface all the reasons so the user can tell why.
    raise ParseError(
        "Could not parse the file as RDF. Attempts:\n" + "\n".join(errors)
    )


def parse_rdf(
    data: bytes, fmt: Optional[str], *, timeout: Optional[float] = None
) -> tuple[Graph, str]:
    """Parse RDF bytes, optionally bounded by a wall-clock timeout.

    Returns the parsed Graph and the format that actually worked. Raises
    ParseError (with every attempt's error) if nothing parses, or ParseTimeout
    if ``timeout`` elapses first.

    **What the timeout does and does not do.** It bounds how long the caller
    waits, not how long the work runs. A Python thread cannot be killed from
    outside, so an abandoned parse keeps going until it finishes. That is a real
    improvement over waiting forever, and it is not full protection. It is
    acceptable here only because the upload size cap bounds the abandoned work
    too: the two limits are designed to hold each other up. See decision D-013.
    """
    if timeout is None:
        return _parse_rdf_blocking(data, fmt)
    # Same pattern as sparql_exec: a single-worker pool so the request thread
    # can stop waiting, since rdflib offers no way to interrupt a parse.
    with ThreadPoolExecutor(max_workers=1) as pool:
        # Run in a copy of the caller's context: the just-once grants the
        # request presented, and the context recorder, are contextvars, and a
        # bare submit would start the worker without them -- so an approved
        # retry would be asked again, for ever.
        context = contextvars.copy_context()
        future = pool.submit(context.run, _parse_rdf_blocking, data, fmt)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeout as exc:
            # Do not block shutting the pool down on the abandoned worker.
            pool.shutdown(wait=False, cancel_futures=True)
            raise ParseTimeout(
                f"This file took longer than {timeout:g} seconds to parse and "
                "was stopped. You can raise the limit with "
                "SEMANTIC_STUDIO_PARSE_TIMEOUT."
            ) from exc


@dataclass
class Ontology:
    """One loaded ontology: its identity, metadata, and lazily built views.

    The heavy fields (graph and the caches) are excluded from repr and
    equality so debugging output stays small.
    """

    id: str                    # stable "ont-<hex>" id used in URLs and filenames
    name: str                  # display name (file name or user-supplied)
    source: str                # "upload" or the URL it was fetched from
    format: str                # rdflib parser name that parsed it
    meta: dict                 # persisted summary: triples, stats, namespaces, addedAt
    data_path: Path            # where the original bytes are stored on disk
    # --- lazily populated, cached derived products (None until first use) ---
    # Each cache holds (key, value), the key being what the value was built
    # from: the revision, and the label languages where names are shown.
    # Nothing used to invalidate these, because nothing changed an ontology
    # after loading it; editing does, and a view keyed on the revision cannot
    # go stale.
    graph: Optional[Graph] = field(default=None, repr=False)          # parsed triples
    viz_cache: Optional[tuple] = field(default=None, repr=False)      # graph-view nodes/edges
    schema_cache: Optional[tuple] = field(default=None, repr=False)   # query-builder schema
    hierarchy_cache: Optional[tuple] = field(default=None, repr=False)  # subClassOf/broader forests
    pretty_cache: Optional[tuple] = field(default=None, repr=False)   # re-serialized Turtle
    # The same views over the file plus its resolved imports, built by
    # imports.py. A cache of its own rather than a second key inside the ones
    # above, so the file-only views cannot be served from a merged build or the
    # other way round; dropped whole whenever the resolved closure changes, and
    # carrying the revision it was built at.
    merged_cache: Optional[dict] = field(default=None, repr=False)
    # The views over the model with its switched-on data snapshots
    # (csv-data-import 5.6), with imports or without: one entry per value of
    # the imports switch, each keyed on the revision, the snapshots'
    # generation and the imports view it was built on.
    data_cache: Optional[dict] = field(default=None, repr=False)
    # A project model's snapshots, supplied by editing.py on open:
    # () -> (generation, [(graph, info)]). None everywhere else.
    snapshots: Optional[Callable[[], tuple]] = field(default=None, repr=False, compare=False)
    # Moved by editing.py on every change to a project document. A library
    # ontology stays at 0 for ever, which is what keeps its caches built once.
    revision: int = 0
    # True only for a project document.
    editable: bool = False
    # A project document's languages, primary first (D-085). None for the
    # library, whose label choice stays as it was.
    languages: Optional[tuple] = None
    # A project document's current text, supplied by editing.py: the text last
    # applied in the editor, or clean Turtle. The library reads its file.
    source_provider: Optional[Callable[[], bytes]] = field(default=None, repr=False, compare=False)
    # A project document's lock, which editing.py holds while it changes the
    # graph. Views take it while they read, so none iterates a graph mid-edit.
    # None for the library, which never changes.
    lock: Optional[threading.RLock] = field(default=None, repr=False, compare=False)
    # Guards the one-time parse so two concurrent requests cannot both parse.
    _load_lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def label_langs(self, display: Optional[str] = None) -> Optional[tuple]:
        """The ordered label languages for a view: display, then primary.

        None for the library, which keeps English-then-untagged. A display
        language the project does not carry falls back to the primary rather
        than being refused, so a stale switch in the browser cannot break a view.
        """
        if not self.languages:
            return None
        primary = self.languages[0]
        chosen = display if display in self.languages else primary
        return (chosen, primary)

    def reading(self):
        """Hold while reading the graph: the edit lock for a project document,
        nothing for the library."""
        return self.lock if self.lock is not None else contextlib.nullcontext()

    def _cached(self, slot: str, key, build: Callable[[], object]):
        held = getattr(self, slot)
        if held is not None and held[0] == key:
            return held[1]
        with self.reading():
            value = build()
        setattr(self, slot, (key, value))
        return value

    def ensure_loaded(self) -> Graph:
        """Parse the persisted RDF on first use (lazy restore).

        Uses double-checked locking: the fast path avoids the lock once the
        graph exists; the slow path holds the lock so only one thread parses.
        """
        if self.graph is None:
            with self._load_lock:
                if self.graph is None:
                    # Contexts the file needed when it was loaded are served
                    # from the copy kept then, so a restart re-reads the file
                    # without connecting. One stored before that copy existed
                    # asks the broker like any other parse.
                    with replaying_contexts(self._stored_contexts()):
                        graph, _ = parse_rdf(self.data_path.read_bytes(), self.format)
                    self.graph = graph
        return self.graph

    def _stored_contexts(self) -> Optional[dict]:
        path = contexts_path_for(self.data_path)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def viz(self, lang: Optional[str] = None) -> dict:
        """Visualization nodes/edges for the graph view (cached per revision)."""
        langs = self.label_langs(lang)
        return self._cached(
            "viz_cache",
            (self.revision, langs),
            lambda: build_viz_graph(self.ensure_loaded(), langs=langs),
        )

    def pretty_turtle(self) -> str:
        """The graph re-serialized as tidy, prefixed Turtle (cached).

        Re-serializing a large graph is expensive, and the viewer asks for
        it every time the format toggle is flipped.
        """
        return self._cached(
            "pretty_cache", self.revision, lambda: self.ensure_loaded().serialize(format="turtle")
        )

    def source_bytes(self) -> bytes:
        """The document as text: the stored file, or a project document's
        current text. Documentation export and the source view read this."""
        if self.source_provider is not None:
            with self.reading():
                return self.source_provider()
        return self.data_path.read_bytes()

    def query_schema(self) -> dict:
        """Class-level schema for the visual query builder (cached)."""
        return self._cached(
            "schema_cache", self.revision, lambda: build_query_schema(self.ensure_loaded())
        )

    def hierarchy(self, lang: Optional[str] = None) -> dict:
        """The subClassOf / broader forests for the Hierarchy view (cached).

        Cached like query_schema for the same reason: the forest is a pure
        function of the graph and is read every time the Hierarchy tab opens.
        """
        langs = self.label_langs(lang)
        return self._cached(
            "hierarchy_cache",
            (self.revision, langs),
            lambda: build_hierarchy(
                self.ensure_loaded(), langs=langs, own=self.graph if self.editable else None
            ),
        )

    def summary(self) -> dict:
        """The lightweight JSON the frontend lists in the dropdown.

        Built entirely from stored metadata, so it works before the graph is
        parsed. `loaded` tells the UI whether the RDF is in memory yet.
        """
        stats = self.meta["stats"]
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "format": self.format,
            "triples": self.meta["triples"],
            # Whole-ontology counts, not budgeted ones: `stats` here is
            # build_viz_graph's, taken before any budget is applied. A card is a
            # statement about the file, not about the current canvas — the same
            # distinction D-017 drew for kindCounts.
            "nodes": stats["nodeCount"],
            "edges": stats["edgeCount"],
            "kindCounts": stats["kindCounts"],
            # The A-box assertion-edge count, for the documentation export opt-in
            # (DOC-1 AC-16). `.get` because an ontology ingested before this
            # existed has no such stat and serves 0 rather than raising — the
            # same migration shape as `card` below.
            "assertionCount": stats.get("assertionCount", 0),
            "namespaces": self.meta["namespaces"],
            "addedAt": self.meta["addedAt"],
            "loaded": self.graph is not None,
            # The home screen's thumbnail, absent for anything stored before it
            # existed. `.get` rather than `[...]` is the whole migration: an
            # older ontology serves None, its card renders without a miniature,
            # and nothing parses to backfill one — backfilling here would put a
            # parse per stored ontology back on the startup path.
            "card": self.meta.get("card"),
        }


class OntologyStore:
    """The collection of all loaded ontologies, backed by a directory on disk."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        # Resolve where to store data (tests pass an explicit temp dir).
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        # Ontology files live in a subfolder; saved queries live in a sibling.
        self.onto_dir = self.data_dir / "ontologies"
        self.onto_dir.mkdir(parents=True, exist_ok=True)
        # In-memory index of id -> Ontology.
        self._items: dict[str, Ontology] = {}
        # Open project documents, by their prj-<hex>-<doc> id. Apart from
        # _items so the library list never shows one and removing a library
        # entry can never reach a project.
        self._documents: dict[str, Ontology] = {}
        # Guards mutations of _items against concurrent add/remove.
        self._lock = threading.Lock()
        # Register anything a previous session left on disk (without parsing).
        self._scan()

    def _meta_path(self, oid: str) -> Path:
        # Path of the small JSON metadata file for an ontology id.
        return self.onto_dir / f"{oid}.meta.json"

    def _data_path(self, oid: str) -> Path:
        # Path of the original raw RDF bytes for an ontology id.
        return self.onto_dir / f"{oid}.rdf"

    def _scan(self) -> None:
        """Register ontologies persisted by previous sessions (unparsed).

        Only reads metadata files, so startup is instant regardless of how
        large the stored ontologies are.
        """
        entries: list[Ontology] = []
        for meta_path in self.onto_dir.glob("*.meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                oid = meta["id"]
                data_path = self._data_path(oid)
                # Skip an orphaned metadata file whose data file is gone.
                if not data_path.exists():
                    continue
                # Build the Ontology WITHOUT a graph — it parses on first use.
                entries.append(
                    Ontology(
                        id=oid,
                        name=meta["name"],
                        source=meta["source"],
                        format=meta["format"],
                        meta=meta,
                        data_path=data_path,
                    )
                )
            except Exception:
                continue  # skip corrupt metadata rather than failing startup
        # Present them in the order they were originally added.
        entries.sort(key=lambda o: o.meta.get("addedAt", ""))
        for ontology in entries:
            self._items[ontology.id] = ontology

    def add(
        self,
        name: str,
        source: str,
        data: bytes,
        fmt: Optional[str],
        *,
        parse_timeout: Optional[float] = None,
    ) -> Ontology:
        """Parse, persist and register a new ontology; return it (graph loaded).

        ``parse_timeout`` bounds the parse only. Nothing is written to disk
        until it succeeds, so a timed-out upload leaves no trace in the library.
        """
        # Parse now so we can fail fast on bad input and compute the summary.
        # Any remote JSON-LD context the parse fetches is recorded, so the lazy
        # restore after a restart can re-read the file without a connection.
        with recording_contexts() as contexts:
            graph, used_format = parse_rdf(data, fmt, timeout=parse_timeout)
        viz = build_viz_graph(graph)
        # A short random id keeps URLs and filenames stable across restarts.
        oid = "ont-" + uuid.uuid4().hex[:12]
        # The metadata summary is everything the dropdown needs without a parse.
        meta = {
            "id": oid,
            "name": name,
            "source": source,
            "format": used_format,
            "addedAt": datetime.now(timezone.utc).isoformat(),
            "triples": len(graph),
            "stats": viz["stats"],
            # Computed inside the parse that has already happened, which is the
            # only reason the home screen can draw a thumbnail per ontology
            # without costing a request. Measured over the whole viz dict, so
            # it is a pass over an in-memory list rather than over the triples.
            "card": {"sketch": build_card_sketch(viz)},
            # What an owl:imports elsewhere in the library is matched against
            # (external-access Stage 2). Recorded here because this parse has
            # already happened; an entry stored before it existed is read once,
            # when some other ontology's imports are resolved.
            "ontologyIris": ontology_iris(graph),
            # Only named prefixes are stored (the empty prefix is filtered here;
            # the query schema keeps it because SPARQL needs it — see query_schema).
            "namespaces": {
                prefix: str(ns) for prefix, ns in graph.namespaces() if prefix
            },
        }
        # Persist the raw bytes and the metadata side by side.
        data_path = self._data_path(oid)
        data_path.write_bytes(data)
        if contexts:
            contexts_path_for(data_path).write_text(json.dumps(contexts), encoding="utf-8")
        self._meta_path(oid).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        # Build the in-memory entry with the graph and viz already populated
        # (we just computed them, so there is no reason to make it lazy here).
        ontology = Ontology(
            id=oid,
            name=name,
            source=source,
            format=used_format,
            meta=meta,
            data_path=data_path,
            graph=graph,
            # Keyed as viz() keys it, so the first read does not rebuild.
            viz_cache=((0, None), viz),
        )
        with self._lock:
            self._items[oid] = ontology
        return ontology

    def update_meta(self, ontology: Ontology, **fields) -> None:
        """Add fields to an ontology's stored metadata and write it back."""
        ontology.meta.update(fields)
        self._meta_path(ontology.id).write_text(
            json.dumps(ontology.meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def get(self, oid: str) -> Optional[Ontology]:
        # A loaded ontology, or an open project document, by id.
        return self._items.get(oid) or self._documents.get(oid)

    def register_document(self, ontology: Ontology) -> None:
        """Serve an open project document through the ontology endpoints."""
        with self._lock:
            self._documents[ontology.id] = ontology

    def unregister_document(self, oid: str) -> None:
        with self._lock:
            self._documents.pop(oid, None)

    def remove(self, oid: str) -> bool:
        """Unload the ontology and delete its persisted files.

        Returns True if it existed, False otherwise.
        """
        with self._lock:
            ontology = self._items.pop(oid, None)
        if ontology is None:
            return False
        # Delete both on-disk files; missing_ok tolerates a partial state.
        data_path = self._data_path(oid)
        # The imports state goes with it. The imports cache does not: a
        # downloaded or chosen vocabulary serves every ontology that imports it.
        imports_state = data_path.with_suffix(".imports.json")
        for path in (self._meta_path(oid), data_path, contexts_path_for(data_path), imports_state):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass  # the entry is gone from the session either way
        return True

    def list(self) -> list[Ontology]:
        # Every currently loaded ontology (insertion order preserved).
        return list(self._items.values())


# Module-level singletons shared across the app. Creating the store scans the
# data directory once at import time; the saved-query store lives beside it.
store = OntologyStore()
saved_queries = SavedQueryStore(store.data_dir)
# The broker keeps its policy and activity log beside the library, and this is
# the one module that knows where that is.
network_broker.broker.configure(store.data_dir)
