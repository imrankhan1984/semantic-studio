"""In-memory store of loaded ontologies.

Each ontology is kept as an rdflib.Graph so that future features
(SPARQL querying, editing, serialization) can build directly on it.
"""

from __future__ import annotations

import itertools
import re
import threading
from dataclasses import dataclass, field
from typing import Optional

from rdflib import Graph
from rdflib.util import guess_format

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


@dataclass
class Ontology:
    id: str
    name: str
    source: str  # "upload" or the URL it was fetched from
    format: str
    graph: Graph
    # Populated lazily by graph_builder and cached here.
    viz_cache: Optional[dict] = field(default=None, repr=False)

    @property
    def triple_count(self) -> int:
        return len(self.graph)

    def namespaces(self) -> dict[str, str]:
        return {prefix: str(ns) for prefix, ns in self.graph.namespaces() if prefix}


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


class OntologyStore:
    def __init__(self) -> None:
        self._items: dict[str, Ontology] = {}
        self._counter = itertools.count(1)
        self._lock = threading.Lock()

    def add(self, name: str, source: str, data: bytes, fmt: Optional[str]) -> Ontology:
        graph, used_format = parse_rdf(data, fmt)
        with self._lock:
            oid = f"ont-{next(self._counter)}"
            ontology = Ontology(id=oid, name=name, source=source, format=used_format, graph=graph)
            self._items[oid] = ontology
        return ontology

    def get(self, oid: str) -> Optional[Ontology]:
        return self._items.get(oid)

    def remove(self, oid: str) -> bool:
        with self._lock:
            return self._items.pop(oid, None) is not None

    def list(self) -> list[Ontology]:
        return list(self._items.values())


store = OntologyStore()
