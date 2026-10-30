"""
================================================================================
FILE: backend/app/references.py
================================================================================

SUMMARY
    Reference ontologies reused by prefix (reference-ontologies 5.4 to 5.7,
    D-121): FOAF and QUDT as New project offers them, which of them a
    document has in use, the index of their terms the Edit pickers search,
    and the Turtle editor's check of a prefixed name none of them defines.

BASIC IDEA
    A reference ontology is an entry of examples/manifest.json with
    `group: "reference"` and a `reuse` block (title, ontology IRI, prefixes,
    purpose, sentence). Nothing else lists them, so a third is an entry.

    **In use** means the document declares a prefix bound to one of its
    namespaces, however the line got there. `dcterms:requires` is never read:
    it records a dependency and switches nothing on. A document's
    declarations are read from its own text (declared_prefixes), not from
    its graph, because rdflib binds `foaf:` and some thirty others in every
    Graph it makes: the graph cannot tell a declared `foaf:` from rdflib's
    default. And because longturtle writes only the prefixes a statement
    uses, keep_prefixes writes back a reference prefix that was declared and
    is not used yet, or the first visual change of a new project would drop
    `foaf:` and switch FOAF off before the person had picked a term from it.
    It keeps the project's own prefix the same way, as nothing may use it
    yet either.

    **The index** is built from the bundled file alone, the first time a
    project needs it: every class, property and concept defined in the
    entry's namespaces, with its kind (term_kind, the graph's rule) and its
    names, plus every IRI the file types there, which is what "defines"
    means to Context.exists and the editor's check. It is held in memory for
    the process and written to <data dir>/references/<sha256>.json, keyed by
    the file's pinned hash, so a later start reads a small JSON file instead
    of parsing QUDT's 6.9 MB again; a changed file has another hash and is
    built afresh. Search answers a few dozen terms from it; the index itself
    never leaves the server. Nothing here opens a connection.

INPUTS / INPUT SOURCES
    - examples/manifest.json and the bundled files its references name.
    - A document's text (its declarations) and graph (its terms).
    - The data folder, from the ontology store, read at call time.

EXPECTED OUTPUT
    - entries(), public(), keys(): the references and the route's view of them.
    - declared_prefixes(text), in_use(declared), keep_prefixes(text, declared, own).
    - index(key), index_of(entry): the cached index; search(...), defines(...), unknown_terms(...).
================================================================================
"""

from __future__ import annotations

import difflib
import functools
import json
import logging
import re
import threading
from pathlib import Path
from typing import Iterable, Optional

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF

from .graph_builder import SEARCH_KINDS, all_names, pick_label, search_nodes, term_kind

log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = APP_DIR / "examples" / "manifest.json"
CACHE_DIR = "references"
# Written into every cache file; a file of another version is rebuilt, so a
# change to what the index holds never reads an old file as the new shape.
INDEX_VERSION = 1

# A prefix declaration, either form, at the start of a line or after the
# full stop, the space or the > that ends what came before: PREFIX (the
# SPARQL form, longturtle's) has no full stop, so two can share a line
# (code review). @prefix is case-sensitive in Turtle, PREFIX is not. A
# string literal holding such text would be read as one: the cost is a
# term offered by a picker, never a statement changed.
_PREFIX_LINE = re.compile(
    r"(?:^|(?<=[\s.>]))(?:@prefix|(?i:prefix))[ \t]+([A-Za-z][\w.-]*)?:[ \t]*<([^>\s]*)>",
    re.MULTILINE,
)

# A spelling this close is offered as the term meant (5.7): qudt:Powr has
# one, qudt:Banana has none. difflib's ratio, on local names.
_CLOSE = 0.75
# The check names this many and counts the rest, so a pasted file full of a
# namespace's own terms does not fill the result line.
UNKNOWN_SHOWN = 5


@functools.cache
def entries() -> tuple[dict, ...]:
    """The reference entries, in manifest order, each with its `reuse`."""
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["examples"]
    return tuple(e for e in manifest if e.get("group") == "reference" and e.get("reuse"))


def keys() -> list[str]:
    return [e["key"] for e in entries()]


def by_key(key: str) -> Optional[dict]:
    return next((e for e in entries() if e["key"] == key), None)


def public() -> list[dict]:
    """GET /api/references: what the New project form shows and writes."""
    return [
        {
            "key": e["key"],
            "title": e["reuse"]["title"],
            "prefixes": dict(e["reuse"]["prefixes"]),
            "purpose": e["reuse"]["purpose"],
            "sentence": e["reuse"]["sentence"],
        }
        for e in entries()
    ]


# --- in use ------------------------------------------------------------------


def declared_prefixes(text: Optional[str]) -> dict[str, str]:
    """prefix -> namespace for every declaration the text makes; the last of
    two declarations of one prefix wins, as it does when Turtle is parsed."""
    if not text:
        return {}
    return {m.group(1) or "": m.group(2) for m in _PREFIX_LINE.finditer(text)}


def namespaces_of(entry: dict) -> set[str]:
    return set(entry["reuse"]["prefixes"].values())


def in_use(declared: dict[str, str]) -> list[dict]:
    """The references whose namespace one of the declarations binds."""
    bound = set(declared.values())
    return [e for e in entries() if namespaces_of(e) & bound]


def keep_prefixes(text: str, declared: dict[str, str], own: Optional[tuple] = None) -> str:
    """longturtle's text with every declared reference prefix it dropped,
    and the project's own prefix (`own`: the manifest's prefix and base IRI).

    Only those: the rule that an unused prefix goes is longturtle's and
    stays so for every other one. The project's own goes back whether or
    not the text declared it, or a new project's first Turtle line using it
    fails as unbound (PR #72 review). A prefix whose name the text now binds
    to something else is left out rather than written twice.
    """
    reference = set().union(*(namespaces_of(e) for e in entries()))
    present = declared_prefixes(text)
    wanted = {prefix: namespace for prefix, namespace in declared.items() if namespace in reference}
    if own and own[0] and own[1]:
        wanted.setdefault(own[0], own[1])
    missing = [
        (prefix, namespace)
        for prefix, namespace in sorted(wanted.items())
        if namespace not in present.values() and prefix not in present
    ]
    if not missing:
        return text
    lines = "".join(f"PREFIX {prefix}: <{namespace}>\n" for prefix, namespace in missing)
    return lines + text if text.strip() else lines


# --- the index -----------------------------------------------------------------


class Index:
    """One reference's terms: what the pickers offer and what it defines."""

    def __init__(self, entry: dict, terms: list[dict], defined: Iterable[str]) -> None:
        self.key = entry["key"]
        self.title = entry["reuse"]["title"]
        self.namespaces = namespaces_of(entry)
        self.terms = terms
        # Each term as search_nodes reads a node, made once: the ranking is
        # the document's own, never a second copy of it (code review).
        self.nodes = [
            {"id": t["iri"], "label": t["label"], "kind": t["kind"], "names": t["names"], "fromReference": self.title}
            for t in terms
        ]
        self.defined = frozenset(defined)
        # Local name -> IRI per namespace, for the closest match (5.7).
        self.locals: dict[str, dict[str, str]] = {}
        for iri in self.defined:
            for namespace in self.namespaces:
                if iri.startswith(namespace):
                    self.locals.setdefault(namespace, {})[iri[len(namespace):]] = iri

    def as_json(self, sha256: str) -> dict:
        return {
            "version": INDEX_VERSION,
            "sha256": sha256,
            "key": self.key,
            "terms": self.terms,
            "defined": sorted(self.defined),
        }


_indexes: dict[str, Index] = {}
_build_lock = threading.Lock()


def _cache_path(sha256: str) -> Path:
    # Read at call time: tests point the store at their own data folder.
    from .store import store

    return store.data_dir / CACHE_DIR / f"{sha256}.json"


class _Within(Graph):
    """A graph that keeps only statements about the reference's own
    namespaces as the parser hands them over: QUDT's 132,000 statements
    become about 3,000, which is what lets the first build fit 3 s (Section
    10). Every fact the index reads -- a term's types and names -- is a
    statement about the term, so nothing it needs is dropped."""

    def __init__(self, spaces: tuple[str, ...]) -> None:
        super().__init__()
        self._spaces = spaces

    def add(self, triple):
        subject = triple[0]
        if isinstance(subject, URIRef) and str(subject).startswith(self._spaces):
            return super().add(triple)
        return self


def build(entry: dict) -> Index:
    """The index of one reference, from its bundled file."""
    spaces = tuple(namespaces_of(entry))
    graph = _Within(spaces)
    graph.parse(APP_DIR / entry["file"], format=entry["format"])
    defined: set[str] = set()
    terms: list[dict] = []
    # _Within kept only the namespaces' own subjects, so every typed one counts.
    for subject in set(graph.subjects(RDF.type, None)):
        defined.add(str(subject))
        kind = term_kind(graph, subject)
        if kind not in SEARCH_KINDS:
            continue
        terms.append(
            {"iri": str(subject), "kind": kind, "label": pick_label(graph, subject), "names": all_names(graph, subject)}
        )
    terms.sort(key=lambda t: (t["label"].lower(), t["iri"]))
    return Index(entry, terms, defined)


def _read_cache(entry: dict) -> Optional[Index]:
    path = _cache_path(entry["sha256"])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not (
        isinstance(data, dict)
        and data.get("version") == INDEX_VERSION
        and data.get("sha256") == entry["sha256"]
        and isinstance(data.get("terms"), list)
        and isinstance(data.get("defined"), list)
    ):
        return None
    return Index(entry, data["terms"], data["defined"])


def _write_cache(entry: dict, built: Index) -> None:
    path = _cache_path(entry["sha256"])
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(built.as_json(entry["sha256"]), ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        # A folder that cannot be written costs the next start a parse, no more.
        log.warning("The reference index for %s could not be written to %s", entry["key"], path)


def index(key: str) -> Index:
    """The index of a reference: from memory, else the disk cache, else built."""
    entry = by_key(key)
    if entry is None:
        raise KeyError(key)
    return index_of(entry)


def index_of(entry: dict) -> Index:
    """index() for an entry: the budget tests' QUDT-sized stand-in is one."""
    held = _indexes.get(entry["sha256"])
    if held is not None:
        return held
    # One build at a time: two pickers opening together must not parse
    # QUDT twice.
    with _build_lock:
        held = _indexes.get(entry["sha256"])
        if held is None:
            held = _read_cache(entry)
            if held is None:
                held = build(entry)
                _write_cache(entry, held)
            _indexes[entry["sha256"]] = held
    return held


def forget() -> None:
    """Drop the in-memory indexes. For tests of the disk cache."""
    _indexes.clear()


# --- what the views ask --------------------------------------------------------


def search(
    declared: dict[str, str], query: str, kind: Optional[str], limit: int, skip: set[str]
) -> list[dict]:
    """Reference terms of the references in use, ranked as search_nodes ranks:
    a name starting with the query first, then one containing it. `skip` is
    what the document and its imports already answered, so a term both
    imported and declared shows once, as imported (5.6 item 2)."""
    if not query.strip() or limit <= 0:
        return []
    bound = set(declared.values())
    candidates = [
        node
        for entry in in_use(declared)
        for node in index(entry["key"]).nodes
        if node["id"].startswith(tuple(namespaces_of(entry) & bound)) and node["id"] not in skip
    ]
    return [dict(n) for n in search_nodes({"nodes": candidates}, query, limit, kind)]


def warm(declared: dict[str, str]) -> None:
    """Build the indexes of the references in use, if they are not yet."""
    for entry in in_use(declared):
        index(entry["key"])


def defines(declared: dict[str, str], iri: str) -> bool:
    """A term of a reference in use, in a namespace the document declares."""
    iri = str(iri)
    bound = set(declared.values())
    for entry in in_use(declared):
        spaces = tuple(namespaces_of(entry) & bound)
        if iri.startswith(spaces) and iri in index(entry["key"]).defined:
            return True
    return False


def unknown_terms(graph: Graph, declared: dict[str, str]) -> dict:
    """The Turtle editor's check on Apply (5.7): every IRI the text uses in a
    declared reference namespace that the reference does not define, by its
    prefixed name, with the closest term when there is one. Information, not
    a refusal: the text has already been applied."""
    using = in_use(declared)
    if not using:
        return {"terms": [], "more": 0}
    by_namespace = {
        namespace: (entry, prefix)
        for entry in using
        for prefix, namespace in declared.items()
        if namespace in namespaces_of(entry)
    }
    seen: set[str] = set()
    for triple in graph:
        for term in triple:
            if isinstance(term, URIRef):
                seen.add(str(term))
            elif isinstance(term, Literal) and term.datatype is not None:
                seen.add(str(term.datatype))
    found: list[dict] = []
    for iri in sorted(seen):
        for namespace, (entry, prefix) in by_namespace.items():
            if not iri.startswith(namespace):
                continue
            ref = index(entry["key"])
            if iri in ref.defined:
                break
            local = iri[len(namespace):]
            names = ref.locals.get(namespace, {})
            close = difflib.get_close_matches(local, list(names), n=1, cutoff=_CLOSE)
            found.append(
                {
                    "term": f"{prefix}:{local}" if prefix else f":{local}",
                    "reference": ref.title,
                    "suggestion": (f"{prefix}:{close[0]}" if prefix else f":{close[0]}") if close else None,
                }
            )
            break
    return {"terms": found[:UNKNOWN_SHOWN], "more": max(0, len(found) - UNKNOWN_SHOWN)}
