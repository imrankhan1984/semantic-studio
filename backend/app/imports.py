"""
================================================================================
FILE: backend/app/imports.py
================================================================================

SUMMARY
    owl:imports, resolved local first (external-access Stage 2, backlog X-5,
    decision D-068). Finds the imports an ontology declares, resolves each one
    and the imports of those, keeps what was downloaded or chosen in a read-only
    cache with its provenance, and serves the ontology together with its
    resolved imports as one read-only merged view.

BASIC IDEA
    Nothing here runs when an ontology is opened. The imports an ontology
    declares are read from its graph for the panel, and resolution happens only
    when the user presses Resolve. Each import is looked for in this order, and
    the first place that has it wins:

      1. Built in. rdf:, rdfs:, owl: and xsd: are understood already and never
         loaded.
      2. The library. A loaded ontology whose owl:Ontology IRI or owl:versionIRI
         is the imported IRI.
      3. The bundled vocabularies in vocab/, each pinned by SHA-256 in
         manifest.json and checked before it is parsed.
      4. The user's mapping: an ontology in the library, or a file the user
         chose, recorded in imports-catalog.json. A chosen file is remembered
         for its IRI, so FOAF chosen once serves every ontology importing it.
      5. A copy downloaded earlier, from the imports/ cache.
      6. The network, through the broker as `ontology:import`. With no grant
         the broker raises ApprovalRequired and the router answers 409; what
         had resolved by then is saved first, so an approved retry picks up
         where the question was asked rather than starting again.

    The closure follows imports of imports breadth first, with a visited set so
    a cycle stops, and stops growing at depth 10, 100 documents or 150 MB. What
    fits is kept and the limit is named. A failure -- refused, offline, 404, a
    file that will not parse -- is recorded against that one import and never
    stops the ontology itself from opening.

    The merged view is MergedView, a ReadOnlyGraphAggregate over the file and
    its resolved imports, so it refuses writes by construction. It differs from
    rdflib's in one way that matters: rdflib's yields a triple once per graph
    that holds it, so a class declared both in the file and in FOAF came back
    twice and a SPARQL SELECT over it returned duplicate rows. The RDF merge of
    two graphs is a set, and MergedView yields each triple once.

INPUTS / INPUT SOURCES
    - The ontology's graph and the store (library lookups, parsing).
    - vocab/manifest.json and the files beside it.
    - imports-catalog.json and imports/ in the data directory.
    - The network broker, for anything not found locally.

EXPECTED OUTPUT
    - Per ontology, <id>.imports.json beside its file: one row per import with
      status (builtin / unresolved / resolved / failed / blocked), source,
      provenance and any reason, plus the limit reached if one was.
    - MergedView instances and the derived views built over them, cached on the
      Ontology beside the file-only ones and never mixed with them.
    - Entities defined only in an import, named by the import that defines
      them, so the interface can say "Imported from FOAF".
================================================================================
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit

from rdflib import Graph, Literal, URIRef
from rdflib.graph import ReadOnlyGraphAggregate
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS
from rdflib.paths import Path as SparqlPath

from . import network_broker
from .graph_builder import build_viz_graph, ontology_iris
from .hierarchy import build_hierarchy
from .query_schema import build_query_schema
from .net_guard import BlockedAddress
from .network_broker import (
    ApprovalRequired,
    FetchFailed,
    HostBlocked,
    Offline,
    TooLarge,
    broker,
)
from .store import (
    Ontology,
    OntologyStore,
    ParseError,
    ParseTimeout,
    detect_format,
    parse_rdf,
    store,
)

# The closure limits (Section 5.3). Each document also keeps the upload path's
# own 50 MB and 60 s, which the callers pass in, so one hostile import cannot
# spend the whole 150 MB alone without the per-document cap refusing it first.
MAX_DEPTH = 10
MAX_DOCUMENTS = 100
MAX_TOTAL_BYTES = 150 * 1024 * 1024

# The Accept header the spec names. Turtle first because it is what most
# vocabulary hosts serve best; the q-values let a host that only has RDF/XML
# still answer with it.
IMPORT_ACCEPT = "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8"

VOCAB_DIR = Path(__file__).parent / "vocab"
MANIFEST_PATH = VOCAB_DIR / "manifest.json"

# The four namespaces rdflib and every view already understand. Importing one
# adds nothing, so it is recorded as built in and never looked for.
BUILTIN_IRIS = {
    "http://www.w3.org/1999/02/22-rdf-syntax-ns": "RDF",
    "http://www.w3.org/2000/01/rdf-schema": "RDFS",
    "http://www.w3.org/2002/07/owl": "OWL",
    "http://www.w3.org/2001/XMLSchema": "XML Schema datatypes",
}

# Row statuses, exactly the five the endpoint table names.
BUILTIN = "builtin"
UNRESOLVED = "unresolved"
RESOLVED = "resolved"
FAILED = "failed"
BLOCKED = "blocked"

# Where a resolved import came from. The interface words each one; these are
# the values it switches on.
SOURCE_BUILTIN = "builtin"
SOURCE_LIBRARY = "library"
SOURCE_BUNDLED = "bundled"
SOURCE_MAPPED = "mapped"      # a library ontology the user chose for this IRI
SOURCE_FILE = "file"          # a file the user chose in the browser
SOURCE_NETWORK = "network"


def normalize_iri(iri: str) -> str:
    """The form two import IRIs are compared in.

    One trailing `#` or `/` is dropped, because the same ontology is routinely
    imported both ways -- `http://xmlns.com/foaf/0.1/` and `.../0.1`, SKOS's
    `core` and `core#` -- and treating those as different would send the user
    to the network, or to the choose-a-file fallback, for a vocabulary that is
    already on the machine. Nothing else is folded: a different version path is
    a different document, and the mismatch confirmation exists for that.
    """
    text = iri.strip()
    if text.endswith(("#", "/")):
        text = text[:-1]
    return text


def declared_imports(graph: Graph) -> list[str]:
    """Every owl:imports target in the graph, sorted, each once.

    From any subject rather than only the owl:Ontology node: a file that states
    its imports on a node it never typed still means them.
    """
    return sorted({str(o) for o in graph.objects(None, OWL.imports) if isinstance(o, URIRef)})


def document_title(graph: Graph, fallback: str) -> str:
    """A short human name for an imported document, for "Imported from X".

    The ontology node's own title or label if it has one, otherwise the last
    segment of the IRI. Never interpolated into markup: the frontend renders it
    as text, like every other string that comes out of a loaded file.
    """
    for node in graph.subjects(RDF.type, OWL.Ontology):
        for predicate in (DCTERMS.title, DC.title, RDFS.label):
            for value in graph.objects(node, predicate):
                if isinstance(value, Literal) and value.language in (None, "en"):
                    return str(value)[:120]
    tail = normalize_iri(fallback).rsplit("/", 1)[-1].rsplit("#", 1)[-1]
    return tail or fallback


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# The merged view.
# ---------------------------------------------------------------------------


class MergedView(ReadOnlyGraphAggregate):
    """The file and its resolved imports, read-only, each triple once.

    The file's graph is always first. Two things beyond rdflib's aggregate:

    * **Set semantics.** A triple held by two documents is yielded once, so
      SPARQL over the view answers as it would over the RDF merge.
    * **Subject pruning.** Most of what the builders ask names a subject (a
      label, a type, a superclass), and a subject usually lives in one
      document. Asking only the documents that hold it is what keeps building
      the graph view over eleven documents at 1.30x a single graph holding the
      same triples, against 2.1x for the plain aggregate -- measured, and held
      by test_merged_view_overhead against the spec's 1.5x.

    Prefixes come from the file first and then from each import, into a
    namespace manager of the view's own. Borrowing the file's manager instead
    would let a qname call for an imported IRI bind a generated `ns1:` into the
    file's graph, which the merged view promises never to change.
    """

    def __init__(self, graphs: list[Graph]) -> None:
        super().__init__(graphs)
        self._subjects = [frozenset(g.subjects(unique=True)) for g in graphs]
        # subject -> the documents that hold it, so a subject lookup costs one
        # dictionary probe rather than a membership test per document.
        where: dict = {}
        for graph, held in zip(graphs, self._subjects):
            for subject in held:
                where.setdefault(subject, []).append(graph)
        self._where = where
        scratch = Graph(bind_namespaces="none")
        for graph in graphs:
            for prefix, namespace in graph.namespaces():
                scratch.namespace_manager.bind(prefix, namespace, override=False)
        self.namespace_manager = scratch.namespace_manager

    def triples(self, triple, context=None):  # noqa: D401 - rdflib's signature
        subject, predicate, obj = triple
        if isinstance(predicate, SparqlPath):
            for s, o in predicate.eval(self, subject, obj):
                yield s, predicate, o
            return
        graphs = self.graphs if subject is None else self._where.get(subject, ())
        if not graphs:
            return
        if len(graphs) == 1:
            yield from graphs[0].triples((subject, predicate, obj))
            return
        seen: set = set()
        for graph in graphs:
            for found in graph.triples((subject, predicate, obj)):
                if found not in seen:
                    seen.add(found)
                    yield found

    def triples_choices(self, triple, context=None):
        # rdflib's version loops the graphs itself and would reintroduce the
        # duplicates; one pattern per choice through triples() does not.
        subject, predicate, obj = triple
        for choices_at, build in (
            (subject, lambda c: (c, predicate, obj)),
            (predicate, lambda c: (subject, c, obj)),
            (obj, lambda c: (subject, predicate, c)),
        ):
            if isinstance(choices_at, list):
                seen: set = set()
                for choice in choices_at:
                    for found in self.triples(build(choice)):
                        if found not in seen:
                            seen.add(found)
                            yield found
                return
        yield from self.triples(triple)

    def __contains__(self, triple) -> bool:
        for _ in self.triples(triple):
            return True
        return False

    def __len__(self) -> int:
        return sum(1 for _ in self.triples((None, None, None)))

    def subjects_by_document(self) -> list[frozenset]:
        """Each document's subjects, in the order the graphs were given."""
        return self._subjects


# ---------------------------------------------------------------------------
# The bundled vocabularies.
# ---------------------------------------------------------------------------


class VocabIntegrityError(Exception):
    """A bundled file's bytes do not match its pinned SHA-256."""


def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


_manifest_index: Optional[dict[str, dict]] = None
_bundled_graphs: dict[str, Graph] = {}
_bundled_lock = threading.Lock()


def _bundled_index() -> dict[str, dict]:
    global _manifest_index
    if _manifest_index is None:
        index: dict[str, dict] = {}
        for entry in load_manifest()["vocabularies"]:
            for iri in entry["iris"]:
                index[normalize_iri(iri)] = entry
        _manifest_index = index
    return _manifest_index


def bundled_for(iri: str) -> Optional[dict]:
    """The manifest entry that satisfies this import IRI, if one does."""
    return _bundled_index().get(normalize_iri(iri))


def bundled_bytes(entry: dict) -> bytes:
    """The file's bytes, refused if they are not the ones the manifest pins.

    Checked on every read, not once at build time: a file edited in place on
    an installed copy would otherwise be parsed and shown as the vocabulary.
    """
    data = (VOCAB_DIR / entry["file"]).read_bytes()
    if _sha256(data) != entry["sha256"]:
        raise VocabIntegrityError(
            f"The bundled copy of {entry['title']} does not match its recorded "
            "checksum, so it was not used."
        )
    return data


def load_bundled(entry: dict) -> Graph:
    """Parse a bundled vocabulary once per process and share the graph.

    Sharing is safe because nothing writes to it: it reaches the views only
    inside a MergedView, which refuses writes.
    """
    with _bundled_lock:
        graph = _bundled_graphs.get(entry["id"])
        if graph is None:
            graph = Graph()
            graph.parse(data=bundled_bytes(entry), format=entry["format"])
            _bundled_graphs[entry["id"]] = graph
        return graph


def clear_bundled_cache() -> None:
    """Forget the parsed bundled graphs. For the budget test, which must time
    the parse the spec's budget includes, not a warm dictionary lookup."""
    with _bundled_lock:
        _bundled_graphs.clear()


# ---------------------------------------------------------------------------
# The imports cache and the user's catalog.
# ---------------------------------------------------------------------------


def _cache_key(iri: str) -> str:
    return hashlib.sha256(normalize_iri(iri).encode("utf-8")).hexdigest()[:24]


class ImportsCache:
    """Downloaded and chosen documents, one per import IRI, with provenance.

    Kept in imports/ beside ontologies/. A document here is a schema document,
    never edited, and never listed as a library card -- which is what keeps
    this consistent with D-029, a decision about instance data.
    """

    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir / "imports"
        self.catalog_path = data_dir / "imports-catalog.json"
        self._lock = threading.Lock()
        self._graphs: dict[str, Graph] = {}

    # --- documents --------------------------------------------------------

    def _paths(self, key: str) -> tuple[Path, Path]:
        return self.dir / f"{key}.rdf", self.dir / f"{key}.meta.json"

    def get(self, iri: str) -> Optional[dict]:
        _, meta_path = self._paths(_cache_key(iri))
        if not meta_path.exists():
            return None
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def put(
        self,
        iri: str,
        data: bytes,
        graph: Graph,
        fmt: str,
        *,
        source: str,
        source_url: Optional[str] = None,
        file_name: Optional[str] = None,
    ) -> dict:
        key = _cache_key(iri)
        data_path, meta_path = self._paths(key)
        meta = {
            "key": key,
            "iri": iri,
            "source": source,
            "sourceUrl": source_url,
            "fileName": file_name,
            "fetchedAt": _now(),
            "sha256": _sha256(data),
            "format": fmt,
            "bytes": len(data),
            "declares": ontology_iris(graph),
            "title": document_title(graph, iri),
        }
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            data_path.write_bytes(data)
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            self._graphs[key] = graph
        return meta

    def graph(self, meta: dict, parse_timeout: Optional[float]) -> Graph:
        key = meta["key"]
        with self._lock:
            cached = self._graphs.get(key)
        if cached is not None:
            return cached
        data_path, _ = self._paths(key)
        data = data_path.read_bytes()
        if _sha256(data) != meta["sha256"]:
            # The provenance says what was fetched; a file that no longer
            # matches it is not that document any more.
            raise ParseError("The cached copy of this import has changed on disk.")
        graph, _ = parse_rdf(data, meta.get("format"), timeout=parse_timeout)
        with self._lock:
            self._graphs[key] = graph
        return graph

    def exists(self, key: str) -> bool:
        return self._paths(key)[0].exists()

    # --- the catalog ------------------------------------------------------

    def catalog(self) -> dict:
        if not self.catalog_path.exists():
            return {}
        try:
            return json.loads(self.catalog_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def set_mapping(self, iri: str, entry: dict) -> None:
        with self._lock:
            catalog = self.catalog()
            catalog[normalize_iri(iri)] = {"iri": iri, **entry}
            self.catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")

    def mapping(self, iri: str) -> Optional[dict]:
        return self.catalog().get(normalize_iri(iri))

    def clear(self) -> None:
        """Drop the in-memory graphs. For tests that swap data directories."""
        with self._lock:
            self._graphs.clear()


# ---------------------------------------------------------------------------
# Per-ontology state.
# ---------------------------------------------------------------------------


def state_path(ontology: Ontology) -> Path:
    return ontology.data_path.with_suffix(".imports.json")


def load_state(ontology: Ontology) -> Optional[dict]:
    path = state_path(ontology)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_state(ontology: Ontology, state: dict) -> None:
    state_path(ontology).write_text(json.dumps(state, indent=2), encoding="utf-8")
    # The merged views were built from the previous closure. Keyed apart from
    # the file-only caches, and dropped whole here, so the two never mix.
    ontology.merged_cache = None


@dataclass
class _Progress:
    done: int = 0
    total: int = 0
    cancel: threading.Event = None  # type: ignore[assignment]


class ImportsService:
    """Resolution, the cache and the merged views, for one store."""

    def __init__(self, store: OntologyStore) -> None:
        self.store = store
        self.cache = ImportsCache(store.data_dir)
        self._progress: dict[str, _Progress] = {}
        self._progress_lock = threading.Lock()
        # One resolution per ontology at a time. A second press waits for the
        # first rather than interleaving two closures into one state file.
        self._locks: dict[str, threading.Lock] = {}

    def configure(self, store: OntologyStore) -> None:
        """Point at another store. For tests that build their own."""
        self.store = store
        self.cache = ImportsCache(store.data_dir)

    def _lock_for(self, oid: str) -> threading.Lock:
        with self._progress_lock:
            return self._locks.setdefault(oid, threading.Lock())

    # --- the panel's listing ----------------------------------------------

    def listing(self, ontology: Ontology) -> dict:
        """What the imports panel shows. Reads files and metadata only: it never
        parses an import and never connects, so opening an ontology costs
        nothing beyond reading which IRIs it declares (AC-16)."""
        state = load_state(ontology)
        if state is None:
            rows = [self._initial_row(iri) for iri in declared_imports(ontology.ensure_loaded())]
            limit = None
        else:
            rows = [self._still_available(dict(row)) for row in state["rows"]]
            limit = state.get("limit")
        with self._progress_lock:
            progress = self._progress.get(ontology.id)
            running = (
                {"done": progress.done, "total": progress.total} if progress else None
            )
        return {
            "imports": rows,
            "limit": limit,
            "resolving": running,
            "offline": broker.policy.offline,
        }

    def _initial_row(self, iri: str, depth: int = 1, parent: Optional[str] = None) -> dict:
        builtin = BUILTIN_IRIS.get(normalize_iri(iri))
        return {
            "iri": iri,
            "status": BUILTIN if builtin else UNRESOLVED,
            "source": SOURCE_BUILTIN if builtin else None,
            "sourceName": builtin,
            "fetchedAt": None,
            "error": None,
            "documentCount": 0,
            "depth": depth,
            "importedBy": parent,
            "ref": None,
        }

    def _still_available(self, row: dict) -> dict:
        """A resolved row whose source has since gone says so, cheaply."""
        ref = row.get("ref")
        if row["status"] != RESOLVED or not ref:
            return row
        gone = (ref["kind"] == "library" and self.store.get(ref["id"]) is None) or (
            ref["kind"] == "cache" and not self.cache.exists(ref["key"])
        )
        if gone:
            row.update(
                status=FAILED,
                error="What this import was resolved from is no longer available. "
                "Resolve imports again.",
            )
        return row

    def progress_start(self, oid: str) -> _Progress:
        progress = _Progress(cancel=threading.Event())
        with self._progress_lock:
            self._progress[oid] = progress
        return progress

    def progress_end(self, oid: str) -> None:
        with self._progress_lock:
            self._progress.pop(oid, None)

    def cancel(self, oid: str) -> bool:
        with self._progress_lock:
            progress = self._progress.get(oid)
        if progress is None:
            return False
        progress.cancel.set()
        return True

    # --- resolution -------------------------------------------------------

    def resolve(
        self,
        ontology: Ontology,
        *,
        allow_network: bool = True,
        refresh: bool = False,
        parse_timeout: Optional[float] = None,
        max_bytes: int,
    ) -> dict:
        """Run the chain over the whole closure and save the result.

        `allow_network=False` is the local-only pass that follows a chosen file
        or a new mapping: those actions must not turn into a connection the user
        did not ask for, so anything that would need the network keeps the
        status it had. `refresh=True` re-downloads what came from the network
        rather than reusing the cached copy.
        """
        with self._lock_for(ontology.id):
            progress = self.progress_start(ontology.id)
            try:
                return self._resolve(
                    ontology, progress, allow_network, refresh, parse_timeout, max_bytes
                )
            finally:
                self.progress_end(ontology.id)

    def _resolve(self, ontology, progress, allow_network, refresh, parse_timeout, max_bytes):
        root = ontology.ensure_loaded()
        previous = {normalize_iri(r["iri"]): r for r in (load_state(ontology) or {}).get("rows", [])}
        own_name = ontology.name
        # The file's own IRIs count as visited: an import chain that leads back
        # to the file is a cycle, not a second copy of it.
        visited: set[str] = {normalize_iri(i) for i in ontology_iris(root)}
        queue: list[tuple[str, int, Optional[str]]] = [
            (iri, 1, None) for iri in declared_imports(root)
        ]
        rows: list[dict] = []
        total_bytes = 0
        documents = 0
        limit: Optional[str] = None
        # Approval requests met along the way, asked all at once after the
        # closure has resolved everything it can locally.
        questions: list[dict] = []
        progress.total = len(queue)

        def save():
            state = {"resolvedAt": _now(), "rows": rows, "limit": limit}
            save_state(ontology, state)
            return state

        while queue:
            iri, depth, parent = queue.pop(0)
            key = normalize_iri(iri)
            if key in visited:
                progress.total = max(progress.done, progress.total - 1)
                continue
            visited.add(key)
            row = self._initial_row(iri, depth, parent)
            rows.append(row)
            if row["status"] == BUILTIN:
                progress.done += 1
                continue
            if progress.cancel.is_set():
                row["error"] = "Stopped before this import was resolved."
                progress.done += 1
                continue
            if depth > MAX_DEPTH:
                row["error"] = f"Not loaded: imports deeper than {MAX_DEPTH} levels are not followed."
                limit = limit or f"Imports deeper than {MAX_DEPTH} levels were not followed."
                progress.done += 1
                continue
            if documents >= MAX_DOCUMENTS:
                row["error"] = f"Not loaded: the {MAX_DOCUMENTS}-document limit was reached."
                limit = limit or f"Only the first {MAX_DOCUMENTS} imported documents were loaded."
                progress.done += 1
                continue

            try:
                found = self._find(
                    iri,
                    ontology,
                    allow_network=allow_network,
                    refresh=refresh,
                    parse_timeout=parse_timeout,
                    max_bytes=max_bytes,
                    reason=self._reason(own_name, iri, [q[0] for q in queue]),
                )
            except ApprovalRequired as question:
                # Not raised here. Everything that can resolve without the
                # network -- the rest of this closure included -- is resolved
                # first, and the questions are asked once, together, at the
                # end. Raising on the first one used to leave every later
                # import unresolved, bundled FOAF included, and a Don't allow
                # then left the merged view as the file alone.
                #
                # Worded to stay true whichever way the user answers: after a
                # Don't allow this row is what the panel shows, with its ways out.
                host = urlsplit(iri).hostname or iri
                row["error"] = f"Not loaded: this needs your permission to connect to {host}."
                questions.extend(question.requests)
                progress.done += 1
                continue
            progress.done += 1
            if found is None:
                # Needed the network and this pass may not use it: keep what the
                # row said before, so a failure reason is not wiped by a
                # local-only pass.
                before = previous.get(key)
                if before and before["status"] in (FAILED, BLOCKED):
                    row.update(status=before["status"], error=before["error"])
                continue
            if "failure" in found:
                row.update(status=found["status"], error=found["failure"])
                continue

            size = found["bytes"]
            if total_bytes + size > MAX_TOTAL_BYTES:
                row["error"] = "Not loaded: the imports together would pass 150 MB."
                limit = limit or "Imports were loaded up to the 150 MB total limit."
                continue
            total_bytes += size
            documents += 1
            graph: Graph = found.pop("graph")
            row.update(status=RESOLVED, error=None, documentCount=1, **found)
            # Every IRI the document says it is counts as visited, so an import
            # of its versionIRI elsewhere in the closure is not loaded twice.
            for alias in ontology_iris(graph):
                visited.add(normalize_iri(alias))
            children = [c for c in declared_imports(graph) if normalize_iri(c) not in visited]
            queue.extend((child, depth + 1, iri) for child in children)
            progress.total += len(children)

        self._count_subtrees(rows)
        state = save()
        if questions:
            # One 409 naming every host. The dialog records a grant per
            # request, and the retry presents them all, so a closure spread
            # over several sites is one question rather than one per site.
            # Saved first: the listing, and the merged view, keep everything
            # local whichever way the user answers.
            raise ApprovalRequired(_one_per_host(questions))
        return state

    @staticmethod
    def _count_subtrees(rows: list[dict]) -> None:
        """documentCount: the documents this import brought in, its own imports
        included, so "FIBO Foundations" can say it brought twelve."""
        by_parent: dict[Optional[str], list[dict]] = {}
        for row in rows:
            by_parent.setdefault(row["importedBy"], []).append(row)

        def count(row: dict) -> int:
            own = 1 if row["status"] == RESOLVED else 0
            return own + sum(count(child) for child in by_parent.get(row["iri"], []))

        for row in rows:
            row["documentCount"] = count(row)

    @staticmethod
    def _reason(own_name: str, iri: str, pending: list[str]) -> str:
        host = (urlsplit(iri).hostname or "").lower()
        same = 1 + sum(1 for p in pending if (urlsplit(p).hostname or "").lower() == host)
        if same == 1:
            return f'"{own_name}" imports an ontology from this site.'
        return f'"{own_name}" imports {same} ontologies from this site.'

    def _find(self, iri, ontology, *, allow_network, refresh, parse_timeout, max_bytes, reason):
        """One import through the chain. Returns the found document, a failure,
        or None when only the network could answer and it may not be used."""
        key = normalize_iri(iri)

        # 2. The library, by ontology IRI or versionIRI.
        for other in self.store.list():
            if other.id == ontology.id:
                continue
            if key in {normalize_iri(i) for i in self._library_iris(other)}:
                return self._from_library(other, SOURCE_LIBRARY)

        # 3. Bundled.
        entry = bundled_for(iri)
        if entry is not None:
            try:
                graph = load_bundled(entry)
            except VocabIntegrityError as exc:
                return {"status": FAILED, "failure": str(exc)}
            return {
                "graph": graph,
                "source": SOURCE_BUNDLED,
                "sourceName": entry["title"],
                "fetchedAt": None,
                "bytes": (VOCAB_DIR / entry["file"]).stat().st_size,
                "ref": {"kind": "bundled", "id": entry["id"]},
            }

        # 4. The user's mapping: a library ontology, or a chosen file.
        mapping = self.cache.mapping(iri)
        if mapping is not None:
            if mapping.get("kind") == "library":
                other = self.store.get(mapping["ontologyId"])
                if other is not None:
                    return self._from_library(other, SOURCE_MAPPED)
            elif mapping.get("kind") == "file":
                meta = self.cache.get(iri)
                if meta is not None:
                    return self._from_cache(meta, parse_timeout)

        # 5. A copy downloaded before, unless the user asked to refresh it.
        meta = self.cache.get(iri)
        if meta is not None and (meta["source"] == SOURCE_FILE or not refresh):
            return self._from_cache(meta, parse_timeout)

        # 6. The network.
        if not allow_network:
            return None
        return self._download(iri, parse_timeout, max_bytes, reason)

    def _library_iris(self, other: Ontology) -> list[str]:
        """A library ontology's IRIs, from its metadata when recorded at ingest.

        One stored before the field existed is parsed once here and the answer
        written back. That puts a parse on the resolve path for old entries
        only, and only when the user pressed Resolve -- never on startup.
        """
        iris = other.meta.get("ontologyIris")
        if iris is None:
            iris = ontology_iris(other.ensure_loaded())
            self.store.update_meta(other, ontologyIris=iris)
        return iris

    def _from_library(self, other: Ontology, source: str) -> dict:
        graph = other.ensure_loaded()
        try:
            size = other.data_path.stat().st_size
        except OSError:
            size = 0
        return {
            "graph": graph,
            "source": source,
            "sourceName": other.name,
            "fetchedAt": None,
            "bytes": size,
            "ref": {"kind": "library", "id": other.id},
        }

    def _from_cache(self, meta: dict, parse_timeout) -> dict:
        try:
            graph = self.cache.graph(meta, parse_timeout)
        except (ParseError, ParseTimeout, OSError) as exc:
            return {"status": FAILED, "failure": str(exc)}
        return {
            "graph": graph,
            "source": meta["source"],
            "sourceName": meta.get("fileName") if meta["source"] == SOURCE_FILE else meta.get("title"),
            "fetchedAt": meta["fetchedAt"],
            "bytes": meta["bytes"],
            "ref": {"kind": "cache", "key": meta["key"]},
            "sourceUrl": meta.get("sourceUrl"),
            "sha256": meta["sha256"],
        }

    def _download(self, iri, parse_timeout, max_bytes, reason) -> dict:
        try:
            response = broker.request(
                "ontology:import",
                iri,
                reason=reason,
                headers={"Accept": IMPORT_ACCEPT},
                max_bytes=max_bytes,
                timeout=60,
            )
        except ApprovalRequired:
            raise
        except Offline as exc:
            return {"status": FAILED, "failure": str(exc)}
        except HostBlocked as exc:
            return {"status": BLOCKED, "failure": str(exc)}
        except (BlockedAddress, TooLarge, FetchFailed) as exc:
            return {"status": FAILED, "failure": str(exc)}
        if response.status >= 400:
            return {
                "status": FAILED,
                "failure": f"The site answered HTTP {response.status} for this import.",
            }
        fmt = _format_from_response(response)
        try:
            graph, used = parse_rdf(response.body, fmt, timeout=parse_timeout)
        except network_broker.NetworkDecision as exc:
            # A downloaded JSON-LD import naming a remote context asks too; this
            # import fails with the reason, and the rest carry on.
            return {"status": FAILED, "failure": str(exc)}
        except (ParseError, ParseTimeout) as exc:
            return {"status": FAILED, "failure": _first_line(str(exc))}
        meta = self.cache.put(
            iri, response.body, graph, used, source=SOURCE_NETWORK, source_url=response.url
        )
        return {
            "graph": graph,
            "source": SOURCE_NETWORK,
            "sourceName": meta["title"],
            "fetchedAt": meta["fetchedAt"],
            "bytes": meta["bytes"],
            "ref": {"kind": "cache", "key": meta["key"]},
            "sourceUrl": response.url,
            "sha256": meta["sha256"],
        }

    # --- chosen files and mappings ----------------------------------------

    def accept_files(
        self,
        ontology: Ontology,
        files: list[tuple[str, bytes]],
        *,
        for_iri: Optional[str],
        accept_mismatch: bool,
        parse_timeout: Optional[float],
    ) -> dict:
        """Match chosen files to unresolved imports by the IRI they declare.

        A file matching nothing is reported and not kept. A file chosen for one
        import that declares a different IRI is kept only once the user has
        confirmed it (AC-42) -- `accept_mismatch` is that confirmation, and the
        browser re-sends the file it still holds to give it.
        """
        state = load_state(ontology)
        rows = state["rows"] if state else [
            self._initial_row(i) for i in declared_imports(ontology.ensure_loaded())
        ]
        wanted = {
            normalize_iri(r["iri"]): r["iri"]
            for r in rows
            if r["status"] in (UNRESOLVED, FAILED, BLOCKED)
        }
        matched: list[dict] = []
        unmatched: list[str] = []
        mismatch: list[dict] = []
        invalid: list[dict] = []
        for name, data in files:
            try:
                graph, used = parse_rdf(data, detect_format(name), timeout=parse_timeout)
            except network_broker.NetworkDecision as exc:
                invalid.append({"file": name, "error": str(exc)})
                continue
            except (ParseError, ParseTimeout) as exc:
                invalid.append({"file": name, "error": _first_line(str(exc))})
                continue
            declares = ontology_iris(graph)
            hits = [wanted[n] for n in {normalize_iri(d) for d in declares} if n in wanted]
            if for_iri and normalize_iri(for_iri) in {normalize_iri(d) for d in declares}:
                hits = sorted(set(hits) | {for_iri})
            if hits:
                for iri in hits:
                    self._keep_file(iri, name, data, graph, used)
                    matched.append({"iri": iri, "file": name})
            elif for_iri and accept_mismatch:
                self._keep_file(for_iri, name, data, graph, used)
                matched.append({"iri": for_iri, "file": name})
            elif for_iri:
                mismatch.append(
                    {"file": name, "declares": declares[0] if declares else None, "forIri": for_iri}
                )
            else:
                unmatched.append(name)
        if matched:
            self.resolve(ontology, allow_network=False, parse_timeout=parse_timeout,
                         max_bytes=MAX_TOTAL_BYTES)
        return {"matched": matched, "unmatched": unmatched, "mismatch": mismatch, "invalid": invalid}

    def _keep_file(self, iri, name, data, graph, used) -> None:
        self.cache.put(iri, data, graph, used, source=SOURCE_FILE, file_name=name)
        self.cache.set_mapping(iri, {"kind": "file"})

    def map_to_library(self, ontology: Ontology, iri: str, target: Ontology, *, parse_timeout) -> dict:
        self.cache.set_mapping(iri, {"kind": "library", "ontologyId": target.id})
        return self.resolve(ontology, allow_network=False, parse_timeout=parse_timeout,
                            max_bytes=MAX_TOTAL_BYTES)

    # --- the merged view --------------------------------------------------

    def merged(self, ontology: Ontology, parse_timeout: Optional[float] = None) -> dict:
        """The merged graph and what came from where, built once per closure.

        Returns {"graph", "importedFrom", "documents"}. With nothing resolved
        the graph is the file's own and nothing is marked, so turning the
        toggle on before resolving shows exactly the file.
        """
        cache = ontology.merged_cache
        if cache is not None and "view" in cache:
            return cache["view"]
        own = ontology.ensure_loaded()
        state = load_state(ontology)
        docs: list[tuple[Graph, str]] = []
        for row in (state or {}).get("rows", []):
            if row["status"] != RESOLVED or not row.get("ref"):
                continue
            graph = self._graph_for(row["ref"], parse_timeout)
            if graph is not None:
                docs.append((graph, row.get("sourceName") or row["iri"]))
        view = MergedView([own] + [g for g, _ in docs])
        imported: dict[str, str] = {}
        subjects = view.subjects_by_document()
        own_subjects = subjects[0]
        for (_, name), held in zip(docs, subjects[1:]):
            for subject in held:
                if isinstance(subject, URIRef) and subject not in own_subjects:
                    imported.setdefault(str(subject), name)
        built = {"graph": view, "importedFrom": imported, "documents": len(docs)}
        ontology.merged_cache = {"view": built}
        return built

    def _graph_for(self, ref: dict, parse_timeout) -> Optional[Graph]:
        try:
            if ref["kind"] == "library":
                other = self.store.get(ref["id"])
                return other.ensure_loaded() if other else None
            if ref["kind"] == "bundled":
                for entry in load_manifest()["vocabularies"]:
                    if entry["id"] == ref["id"]:
                        return load_bundled(entry)
                return None
            if ref["kind"] == "cache":
                meta_path = self.cache.dir / f"{ref['key']}.meta.json"
                if meta_path.exists():
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    return self.cache.graph(meta, parse_timeout)
        except (ParseError, ParseTimeout, VocabIntegrityError, OSError, ValueError):
            return None
        return None

    def derived(self, ontology: Ontology, name: str, build: Callable[[Graph], dict]) -> dict:
        """A view built over the merged graph, cached beside it (never beside the
        file-only caches, which is the second key the spec asks for)."""
        view = self.merged(ontology)
        cache = ontology.merged_cache
        if name not in cache:
            cache[name] = build(view["graph"])
        return cache[name]


def merged_viz(ontology: Ontology, parse_timeout: Optional[float] = None) -> dict:
    """The graph view's nodes and edges over the merged view, imported marked."""
    view = imports_service.merged(ontology, parse_timeout)
    return imports_service.derived(
        ontology, "viz", lambda g: mark_imported_viz(build_viz_graph(g), view["importedFrom"])
    )


def merged_hierarchy(ontology: Ontology, parse_timeout: Optional[float] = None) -> dict:
    view = imports_service.merged(ontology, parse_timeout)
    return imports_service.derived(
        ontology,
        "hierarchy",
        lambda g: mark_imported_hierarchy(build_hierarchy(g), view["importedFrom"]),
    )


def merged_query_schema(ontology: Ontology, parse_timeout: Optional[float] = None) -> dict:
    imports_service.merged(ontology, parse_timeout)
    return imports_service.derived(ontology, "schema", build_query_schema)


def _one_per_host(requests: list[dict]) -> list[dict]:
    """The first request for each capability and host, in the order met.

    Every import from one site gets the same answer, so asking about the site
    once is the question; the count of imports is already in its reason.
    """
    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for request in requests:
        key = (request["capability"], request["host"])
        if key not in seen:
            seen.add(key)
            unique.append(request)
    return unique


def _format_from_response(response) -> Optional[str]:
    """The parser a response's Content-Type names, else the URL's extension."""
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    by_type = {
        "text/turtle": "turtle",
        "application/x-turtle": "turtle",
        "application/rdf+xml": "xml",
        "application/ld+json": "json-ld",
        "application/n-triples": "nt",
        "text/n3": "n3",
    }
    if content_type in by_type:
        return by_type[content_type]
    return detect_format(urlsplit(response.url).path.rsplit("/", 1)[-1] or None)


def _first_line(message: str) -> str:
    return message.splitlines()[0] if message else message


def mark_imported_viz(viz: dict, imported: dict[str, str]) -> dict:
    """Stamp `importedFrom` on each viz node defined only in an import.

    The viz was just built over the merged view, so its dicts are this cache's
    own and are annotated in place.
    """
    for node in viz["nodes"]:
        source = imported.get(node["id"])
        if source is not None:
            node["importedFrom"] = source
    return viz


IMPORTED = "imported"


def mark_imported_hierarchy(tree: dict, imported: dict[str, str]) -> dict:
    """Name the source of each imported row, and give the edge that leads to it
    the `imported` origin -- D-046's seam, with a value the tree already had a
    place for."""
    for key, forest in tree.items():
        if not isinstance(forest, dict) or "nodes" not in forest:
            continue
        for node_id, node in forest["nodes"].items():
            source = imported.get(node_id)
            if source is not None:
                node["importedFrom"] = source
        for refs in forest["children"].values():
            for ref in refs:
                if ref["id"] in imported:
                    ref["origin"] = IMPORTED
    return tree


# The one service, over the one store. Routers import this; tests that build
# their own store call configure().
imports_service = ImportsService(store)
