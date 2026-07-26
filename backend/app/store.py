"""Disk-backed store of loaded ontologies.

Each ontology is kept as an rdflib.Graph so that future features (SPARQL
querying, editing, serialization) can build directly on it. The original
file bytes plus a metadata summary are persisted to a per-user data
directory, so ontologies loaded in previous sessions reappear after a
restart. RDF is re-parsed lazily: listing only reads the stored metadata,
and the graph is parsed from disk the first time it is actually used.
"""

from __future__ import annotations

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

from rdflib import Graph
from rdflib.util import guess_format

from .graph_builder import build_viz_graph
from .queries_store import SavedQueryStore
from .query_schema import build_query_schema

# Formats accepted for parsing, keyed by common file extensions.
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

# Fallback order when the format cannot be determined from the name.
SNIFF_ORDER = ["turtle", "xml", "json-ld", "nt", "trig"]


class ParseError(Exception):
    """Raised when the payload cannot be parsed as RDF in any known format."""


def default_data_dir() -> Path:
    """Per-user data directory, overridable with SEMANTIC_STUDIO_DATA_DIR."""
    env = os.environ.get("SEMANTIC_STUDIO_DATA_DIR") or os.environ.get(
        "SEMANTIC_VIEWER_DATA_DIR"  # pre-rename variable
    )
    if env:
        return Path(env)
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
    """Best-effort format detection from an explicit hint or a file name."""
    if explicit:
        return explicit
    if filename:
        match = re.search(r"(\.[A-Za-z0-9]+)$", filename)
        if match and match.group(1).lower() in EXTENSION_FORMATS:
            return EXTENSION_FORMATS[match.group(1).lower()]
        guessed = guess_format(filename)
        if guessed:
            return guessed
    return None


def parse_rdf(data: bytes, fmt: Optional[str]) -> tuple[Graph, str]:
    """Parse RDF bytes, trying the given format first, then sniffing."""
    attempts = [fmt] if fmt else []
    attempts += [f for f in SNIFF_ORDER if f not in attempts]
    errors: list[str] = []
    for candidate in attempts:
        graph = Graph()
        try:
            graph.parse(data=data, format=candidate)
            return graph, candidate
        except Exception as exc:  # rdflib raises many parser-specific errors
            errors.append(f"{candidate}: {exc}")
    raise ParseError(
        "Could not parse the file as RDF. Attempts:\n" + "\n".join(errors)
    )


@dataclass
class Ontology:
    id: str
    name: str
    source: str  # "upload" or the URL it was fetched from
    format: str
    meta: dict  # persisted summary: triples, stats, namespaces, addedAt
    data_path: Path
    graph: Optional[Graph] = field(default=None, repr=False)
    viz_cache: Optional[dict] = field(default=None, repr=False)
    schema_cache: Optional[dict] = field(default=None, repr=False)
    _load_lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def ensure_loaded(self) -> Graph:
        """Parse the persisted RDF on first use (lazy restore)."""
        if self.graph is None:
            with self._load_lock:
                if self.graph is None:
                    graph, _ = parse_rdf(self.data_path.read_bytes(), self.format)
                    self.graph = graph
        return self.graph

    def viz(self) -> dict:
        if self.viz_cache is None:
            self.viz_cache = build_viz_graph(self.ensure_loaded())
        return self.viz_cache

    def query_schema(self) -> dict:
        """Class-level schema for the visual query builder (cached)."""
        if self.schema_cache is None:
            self.schema_cache = build_query_schema(self.ensure_loaded())
        return self.schema_cache

    def summary(self) -> dict:
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
    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.onto_dir = self.data_dir / "ontologies"
        self.onto_dir.mkdir(parents=True, exist_ok=True)
        self._items: dict[str, Ontology] = {}
        self._lock = threading.Lock()
        self._scan()

    def _meta_path(self, oid: str) -> Path:
        return self.onto_dir / f"{oid}.meta.json"

    def _data_path(self, oid: str) -> Path:
        return self.onto_dir / f"{oid}.rdf"

    def _scan(self) -> None:
        """Register ontologies persisted by previous sessions (unparsed)."""
        entries: list[Ontology] = []
        for meta_path in self.onto_dir.glob("*.meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                oid = meta["id"]
                data_path = self._data_path(oid)
                if not data_path.exists():
                    continue
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
        entries.sort(key=lambda o: o.meta.get("addedAt", ""))
        for ontology in entries:
            self._items[ontology.id] = ontology

    def add(self, name: str, source: str, data: bytes, fmt: Optional[str]) -> Ontology:
        graph, used_format = parse_rdf(data, fmt)
        viz = build_viz_graph(graph)
        oid = "ont-" + uuid.uuid4().hex[:12]
        meta = {
            "id": oid,
            "name": name,
            "source": source,
            "format": used_format,
            "addedAt": datetime.now(timezone.utc).isoformat(),
            "triples": len(graph),
            "stats": viz["stats"],
            "namespaces": {
                prefix: str(ns) for prefix, ns in graph.namespaces() if prefix
            },
        }
        data_path = self._data_path(oid)
        data_path.write_bytes(data)
        self._meta_path(oid).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
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
        return self._items.get(oid)

    def remove(self, oid: str) -> bool:
        """Unload the ontology and delete its persisted files."""
        with self._lock:
            ontology = self._items.pop(oid, None)
        if ontology is None:
            return False
        for path in (self._meta_path(oid), self._data_path(oid)):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass  # the entry is gone from the session either way
        return True

    def list(self) -> list[Ontology]:
        return list(self._items.values())


store = OntologyStore()
saved_queries = SavedQueryStore(store.data_dir)
