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

INPUTS / INPUT SOURCES
    - Raw file bytes from uploads or URL fetches (passed to `add`).
    - A format hint from the file extension / caller, else content sniffing.
    - Previously persisted <id>.rdf and <id>.meta.json files in the data dir.
    - Environment variable SEMANTIC_STUDIO_DATA_DIR (or the legacy
      SEMANTIC_VIEWER_DATA_DIR) to relocate the data directory.

EXPECTED OUTPUT
    - Ontology objects with a stable id, metadata summary, and lazily parsed
      graph, plus cached viz/schema/pretty views.
    - Two module-level singletons imported across the app: `store` (the
      ontology store) and `saved_queries` (the saved-query library, kept in a
      sibling directory).
================================================================================
"""

from __future__ import annotations

# Standard library:
#   json      - read/write the per-ontology metadata files
#   os        - read the data-directory environment override
#   re        - pull a file extension off a name for format detection
#   sys       - detect the operating system to pick the OS-standard data dir
#   threading - locks so concurrent requests do not double-parse or corrupt state
#   uuid      - generate stable, collision-free ontology ids
import json
import os
import re
import sys
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# rdflib is the RDF engine: Graph holds triples; guess_format maps a filename
# to an rdflib parser name.
from rdflib import Graph
from rdflib.util import guess_format

# Derived-view builders and the saved-query store live in sibling modules.
from .graph_builder import build_viz_graph
from .queries_store import SavedQueryStore
from .query_schema import build_query_schema

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


class ParseError(Exception):
    """Raised when the payload cannot be parsed as RDF in any known format."""


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


def parse_rdf(data: bytes, fmt: Optional[str]) -> tuple[Graph, str]:
    """Parse RDF bytes, trying the given format first, then sniffing others.

    Returns the parsed Graph and the format that actually worked. Raises
    ParseError (with every attempt's error) if nothing parses.
    """
    # Try the hinted format first (if any), then the remaining sniff formats.
    attempts = [fmt] if fmt else []
    attempts += [f for f in SNIFF_ORDER if f not in attempts]
    errors: list[str] = []
    for candidate in attempts:
        graph = Graph()
        try:
            graph.parse(data=data, format=candidate)
            return graph, candidate
        except Exception as exc:  # rdflib raises many parser-specific errors
            # Record why this candidate failed and keep trying the next one.
            errors.append(f"{candidate}: {exc}")
    # Every candidate failed; surface all the reasons so the user can tell why.
    raise ParseError(
        "Could not parse the file as RDF. Attempts:\n" + "\n".join(errors)
    )


@dataclass
class Ontology:
    """One loaded ontology: its identity, metadata, and lazily built views.

    The heavy fields (graph and the three caches) are excluded from repr and
    equality so debugging output stays small.
    """

    id: str                    # stable "ont-<hex>" id used in URLs and filenames
    name: str                  # display name (file name or user-supplied)
    source: str                # "upload" or the URL it was fetched from
    format: str                # rdflib parser name that parsed it
    meta: dict                 # persisted summary: triples, stats, namespaces, addedAt
    data_path: Path            # where the original bytes are stored on disk
    # --- lazily populated, cached derived products (None until first use) ---
    graph: Optional[Graph] = field(default=None, repr=False)          # parsed triples
    viz_cache: Optional[dict] = field(default=None, repr=False)       # graph-view nodes/edges
    schema_cache: Optional[dict] = field(default=None, repr=False)    # query-builder schema
    pretty_cache: Optional[str] = field(default=None, repr=False)     # re-serialized Turtle
    # Guards the one-time parse so two concurrent requests cannot both parse.
    _load_lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def ensure_loaded(self) -> Graph:
        """Parse the persisted RDF on first use (lazy restore).

        Uses double-checked locking: the fast path avoids the lock once the
        graph exists; the slow path holds the lock so only one thread parses.
        """
        if self.graph is None:
            with self._load_lock:
                if self.graph is None:
                    graph, _ = parse_rdf(self.data_path.read_bytes(), self.format)
                    self.graph = graph
        return self.graph

    def viz(self) -> dict:
        """Visualization nodes/edges for the graph view (built once, cached)."""
        if self.viz_cache is None:
            self.viz_cache = build_viz_graph(self.ensure_loaded())
        return self.viz_cache

    def pretty_turtle(self) -> str:
        """The graph re-serialized as tidy, prefixed Turtle (cached).

        Re-serializing a large graph is expensive, and the viewer asks for
        it every time the format toggle is flipped.
        """
        if self.pretty_cache is None:
            self.pretty_cache = self.ensure_loaded().serialize(format="turtle")
        return self.pretty_cache

    def query_schema(self) -> dict:
        """Class-level schema for the visual query builder (cached)."""
        if self.schema_cache is None:
            self.schema_cache = build_query_schema(self.ensure_loaded())
        return self.schema_cache

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
            "nodes": stats["nodeCount"],
            "edges": stats["edgeCount"],
            "kindCounts": stats["kindCounts"],
            "namespaces": self.meta["namespaces"],
            "addedAt": self.meta["addedAt"],
            "loaded": self.graph is not None,
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

    def add(self, name: str, source: str, data: bytes, fmt: Optional[str]) -> Ontology:
        """Parse, persist and register a new ontology; return it (graph loaded)."""
        # Parse now so we can fail fast on bad input and compute the summary.
        graph, used_format = parse_rdf(data, fmt)
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
            # Only named prefixes are stored (the empty prefix is filtered here;
            # the query schema keeps it because SPARQL needs it — see query_schema).
            "namespaces": {
                prefix: str(ns) for prefix, ns in graph.namespaces() if prefix
            },
        }
        # Persist the raw bytes and the metadata side by side.
        data_path = self._data_path(oid)
        data_path.write_bytes(data)
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
            viz_cache=viz,
        )
        with self._lock:
            self._items[oid] = ontology
        return ontology

    def get(self, oid: str) -> Optional[Ontology]:
        # Look up a loaded ontology by id, or None if unknown.
        return self._items.get(oid)

    def remove(self, oid: str) -> bool:
        """Unload the ontology and delete its persisted files.

        Returns True if it existed, False otherwise.
        """
        with self._lock:
            ontology = self._items.pop(oid, None)
        if ontology is None:
            return False
        # Delete both on-disk files; missing_ok tolerates a partial state.
        for path in (self._meta_path(oid), self._data_path(oid)):
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
