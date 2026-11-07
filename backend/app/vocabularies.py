"""
================================================================================
FILE: backend/app/vocabularies.py
================================================================================

SUMMARY
    The vocabularies a project document uses, and the one way one is added
    (vocabularies-and-ontologies, D-128): the Edit page's list (5.1), the
    rule that decides between owl:imports and a prefix declaration (5.4),
    Add a vocabulary's inspect (5.3), the plans AddVocabulary and
    RemoveVocabulary carry out (5.3, 5.6), and add_lines, the only code in
    the application that writes owl:imports.

BASIC IDEA
    A **known source** is a bundled vocabulary (vocab/manifest.json, whose
    `prefixes` name its namespaces), a copy inspect kept (a chosen file in
    imports-catalog.json, a download in the imports/ cache, or a library
    ontology), recorded in <data dir>/vocabularies.json with what inspect
    read from it, or a library ontology never inspected, matched by its
    ontology IRI. One source is one row, however many namespaces it has.

    **The list** is worked out from the document as applied, never from
    rdflib's default bindings (D-121): an owl:imports is *Added · imported*;
    a declared prefix bound to a known source's namespace is *Added · terms
    reused*; a term of the document's own statements in any other
    namespace -- not its own, not rdf:, rdfs:, owl: or xsd: -- is *Used,
    not added* when a known source defines that namespace and *Not found*
    when none does. The lines that add a vocabulary (owl:imports and
    dcterms:requires) are not counted as using it. One pass over the
    statements counts them all.

    **The rule** reads the vocabulary itself: a file whose terms carry any
    of 5.4's rule statements is imported, whatever its size, so the
    reasoner and the checks see them; one with none is a term list, reused
    by its prefix. Above LARGE_STATEMENTS the sentence adds that reasoning
    with imports on will probably stop at its limit; the number changes the
    words only, never what is written. For a bundled file the manifest's
    counts are used, so New project decides without parsing QUDT; the
    files are pinned by hash and test_vocabularies.py recounts them.

    **Inspect** reads a source and writes nothing to the document. A web
    address goes through the broker as `ontology:import`, as Resolve does:
    an unapproved host raises ApprovalRequired, which main.py answers 409,
    before any request leaves. What was read is kept as the imports
    machinery keeps it, so Add then resolves it locally, and the registry
    records its title, prefix, namespaces, counts and source.

INPUTS / INPUT SOURCES
    - vocab/manifest.json; the library store; the imports cache and catalogue.
    - <data dir>/vocabularies.json, read at call time.
    - A document's graph, its declared prefixes and its project's bases.
    - The network broker, for a web address only.

EXPECTED OUTPUT
    - listing(...) -> {sentence, rows}; inspect_*(...) -> a summary.
    - add_plan / remove_plan -> what the two commands write; add_lines.
    - Refused (a ValueError carrying the sentence) for anything refused.
================================================================================
"""

from __future__ import annotations

import functools
import hashlib
import json
import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS, XSD

from . import sentences
from .graph_builder import ontology_iris, pick_label
from .imports import (
    BUILTIN_IRIS,
    IMPORT_ACCEPT,
    RESOLVED,
    BUILTIN,
    SOURCE_FILE,
    SOURCE_NETWORK,
    VOCAB_DIR,
    bundled_for,
    declared_imports,
    document_title,
    imports_service,
    load_bundled,
    load_manifest,
    normalize_iri,
)
from .network_broker import broker
from .store import parse_rdf

# Above this many statements the Add sentence warns that reasoning with
# imports on will probably stop at its limit (5.4, Imran 2026-11-07). The
# outcome is the rule's either way; a constant, not a setting.
LARGE_STATEMENTS = 20_000

REGISTRY = "vocabularies.json"
REGISTRY_VERSION = 1

# What a rule is (5.4): one statement of any of these about the
# vocabulary's terms makes it a vocabulary that holds rules.
RULE_PREDICATES = frozenset({
    RDFS.subClassOf, RDFS.subPropertyOf, RDFS.domain, RDFS.range,
    OWL.equivalentClass, OWL.equivalentProperty, OWL.disjointWith, OWL.inverseOf,
    OWL.propertyChainAxiom, OWL.unionOf, OWL.intersectionOf, OWL.disjointUnionOf,
})
RULE_TYPES = frozenset({
    OWL.AllDisjointClasses, OWL.Restriction,
    OWL.FunctionalProperty, OWL.InverseFunctionalProperty, OWL.TransitiveProperty,
    OWL.SymmetricProperty, OWL.AsymmetricProperty, OWL.ReflexiveProperty, OWL.IrreflexiveProperty,
})

# The four a model never adds (5.1): understood already, never a row.
BUILTIN_NAMESPACES = (str(RDF), str(RDFS), str(OWL), str(XSD))

VANN_PREFIX = URIRef("http://purl.org/vocab/vann/preferredNamespacePrefix")
# Turtle's PN_PREFIX in ASCII, as projects.PREFIX holds it: the rule a
# prefix typed into the dialog is held to.
_PREFIX = re.compile(r"[A-Za-z]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?")

IMPORTED = "imported"
REUSED = "reused"

# The lines that add a vocabulary: never counted as using it.
_ADDING = (OWL.imports, DCTERMS.requires)

INSPECT_REASON = "You asked Semantic Studio to add a vocabulary from this address."


class Refused(ValueError):
    """Something the list, inspect or a command will not do, with the sentence."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Turtle's IRIREF: none of these, nor a space or control character. rdflib's
# RDF/XML and JSON-LD parsers hand over an IRI holding `>` and a newline with
# no more than a logged warning, and a namespace is written into a PREFIX
# line: such a namespace closed the line and wrote statements of its own into
# the model (security review). Checked where a namespace enters, from a file,
# and again where one is written (references.keep_prefixes, add_plan).
_NOT_IN_IRI = re.compile(r'[<>"{}|^`\\\x00-\x20\x7f]')


def iri_ok(iri: str) -> bool:
    """An IRI that can be written between < and > in Turtle as it is."""
    return bool(iri) and _NOT_IN_IRI.search(iri) is None


def namespace_of(iri: str) -> Optional[str]:
    """The namespace an IRI is a term of: up to its last # or /, for an
    http(s) IRI only. A urn: or a mailto: names no vocabulary."""
    if not iri.startswith(("http://", "https://")):
        return None
    cut = max(iri.rfind("#"), iri.rfind("/"))
    if cut <= iri.find("//") + 1:
        return None
    return iri[: cut + 1]


# ---------------------------------------------------------------------------
# Known sources
# ---------------------------------------------------------------------------


@dataclass
class Source:
    """A vocabulary that can be added: one row of the list, however many
    namespaces it has."""

    iri: str
    title: str
    prefixes: dict  # prefix -> namespace, the first the preferred one
    kind: str  # bundled / library / file / web
    name: str  # what the source column says
    fetched_at: Optional[str] = None
    statements: Optional[int] = None
    rules: Optional[int] = None
    description: Optional[str] = None
    # Other IRIs the same document answers to (a versionIRI, core#).
    aliases: tuple = ()
    imports: tuple = ()
    ref: dict = field(default_factory=dict)
    # Where the kept copy is, for the reused index (references.py).
    path: Optional[Path] = None
    format: Optional[str] = None
    sha256: Optional[str] = None

    @property
    def namespaces(self) -> frozenset:
        return frozenset(self.prefixes.values())

    @property
    def namespace(self) -> str:
        return next(iter(self.prefixes.values()))

    @property
    def prefix(self) -> str:
        return next(iter(self.prefixes))

    @property
    def how(self) -> Optional[str]:
        if self.rules is None:
            return None
        return IMPORTED if self.rules > 0 else REUSED

    def answers_to(self, iri: str) -> bool:
        key = normalize_iri(iri)
        return key == normalize_iri(self.iri) or key in {normalize_iri(a) for a in self.aliases}


@functools.cache
def bundled_sources() -> tuple[Source, ...]:
    """The twelve bundled vocabularies, in manifest order."""
    found = []
    for entry in load_manifest()["vocabularies"]:
        found.append(Source(
            iri=entry["iris"][0],
            title=entry["title"],
            prefixes=dict(entry["prefixes"]),
            kind="bundled",
            name="Bundled",
            statements=entry["statements"],
            rules=entry["rules"],
            description=entry.get("description"),
            aliases=tuple(entry["iris"][1:]),
            ref={"kind": "bundled", "id": entry["id"]},
            path=VOCAB_DIR / entry["file"],
            format=entry["format"],
            sha256=entry["sha256"],
        ))
    return tuple(found)


def bundled(vocab_id: str) -> Optional[Source]:
    return next((s for s in bundled_sources() if s.ref["id"] == vocab_id), None)


def bundled_of(entry: dict) -> Source:
    """A reference entry of examples/manifest.json (FOAF, QUDT) as the
    bundled vocabulary it is: the same file, matched by its pinned hash."""
    return next(s for s in bundled_sources() if s.sha256 == entry["sha256"])


_registry_lock = threading.Lock()
_registry_held: dict = {}


def _registry_path() -> Path:
    # Read at call time: tests point the store at their own data folder.
    from .store import store

    return store.data_dir / REGISTRY


def registry() -> dict:
    """normalised IRI -> what inspect recorded, read again only when the
    file changes: a picker search asks on every keystroke."""
    path = _registry_path()
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return {}
    held = _registry_held.get(path)
    if held is not None and held[0] == stamp:
        return held[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = data.get("entries", {}) if isinstance(data, dict) and data.get("version") == REGISTRY_VERSION else {}
    _registry_held[path] = (stamp, entries)
    return entries


def _record(source: Source) -> None:
    """Remember what inspect read, under the vocabulary's IRI."""
    path = _registry_path()
    with _registry_lock:
        entries = dict(registry())
        entries[normalize_iri(source.iri)] = {
            "iri": source.iri,
            "title": source.title,
            "prefixes": source.prefixes,
            "kind": source.kind,
            "name": source.name,
            "fetchedAt": source.fetched_at,
            "statements": source.statements,
            "rules": source.rules,
            "imports": list(source.imports),
            "ref": source.ref,
            "format": source.format,
            "sha256": source.sha256,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"version": REGISTRY_VERSION, "entries": entries}, indent=2), encoding="utf-8")
        tmp.replace(path)


def _kept_path(ref: dict) -> Optional[Path]:
    """Where a recorded source's copy is now, or None if it has gone."""
    from .store import store

    if ref.get("kind") == "cache":
        path = imports_service.cache.dir / f"{ref['key']}.rdf"
        return path if path.exists() else None
    if ref.get("kind") == "library":
        other = store.get(ref["id"])
        return other.data_path if other is not None else None
    return None


def _index_key(entry: dict) -> Optional[str]:
    """The hash a recorded copy's term index is kept under. A cached copy is
    never changed in place (the cache checks its hash); a library file can
    be, so its key moves with the file's size and time (code review)."""
    sha = entry.get("sha256")
    path = _kept_path(entry.get("ref") or {})
    if sha is None or path is None or (entry.get("ref") or {}).get("kind") != "library":
        return sha
    try:
        stat = path.stat()
    except OSError:
        return None
    return hashlib.sha256(f"{sha}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()


def recorded_sources() -> list[Source]:
    """What inspect kept, with its copy's whereabouts."""
    found = []
    for entry in registry().values():
        try:
            found.append(Source(
                iri=entry["iri"],
                title=entry["title"],
                prefixes=dict(entry["prefixes"]),
                kind=entry["kind"],
                name=entry["name"],
                fetched_at=entry.get("fetchedAt"),
                statements=entry.get("statements"),
                rules=entry.get("rules"),
                imports=tuple(entry.get("imports", ())),
                ref=dict(entry.get("ref") or {}),
                path=_kept_path(entry.get("ref") or {}),
                format=entry.get("format"),
                sha256=_index_key(entry),
            ))
        except (KeyError, TypeError, StopIteration):
            continue
    return [s for s in found if s.prefixes]


def _library_sources(skip: set) -> list[Source]:
    """Library ontologies never inspected, by their ontology IRI: what they
    define is guessed from it (`http://ex.org/pumps` defines `pumps#` and
    `pumps/`) and from the prefixes they declare under it."""
    from .store import store

    found = []
    for other in store.list():
        if other.editable:
            continue
        iris = other.meta.get("ontologyIris") or []
        if not iris or normalize_iri(iris[0]) in skip:
            continue
        base = normalize_iri(iris[0])
        spaces = [ns for ns in (other.meta.get("namespaces") or {}).values() if normalize_iri(ns) == base]
        prefixes = {f"ns{i}": ns for i, ns in enumerate(spaces or [base + "#", base + "/"])}
        found.append(Source(
            iri=iris[0], title=other.name, prefixes=prefixes, kind="library",
            name=f"Your library: {other.name}", aliases=tuple(iris[1:]),
            ref={"kind": "library", "id": other.id},
        ))
    return found


def known_sources() -> list[Source]:
    """Bundled, then recorded, then the rest of the library."""
    found = list(bundled_sources())
    seen = {normalize_iri(s.iri) for s in found}
    for source in recorded_sources():
        if normalize_iri(source.iri) not in seen:
            found.append(source)
            seen.add(normalize_iri(source.iri))
    found.extend(_library_sources(seen))
    return found


def source_for(iri: str, sources: Optional[list[Source]] = None) -> Optional[Source]:
    return next((s for s in (sources or known_sources()) if s.answers_to(iri)), None)


def guessed_namespaces(iri: str, declared: dict) -> set[str]:
    """What an import no known source names defines, as a library ontology
    never inspected is guessed (code review): its IRI with # or /, and any
    prefix the document binds under it. Without it Remove counted no use."""
    base = normalize_iri(iri)
    spaces = {base + "#", base + "/"}
    spaces |= {ns for ns in declared.values() if normalize_iri(ns) == base}
    return {ns for ns in spaces if iri_ok(ns)}


def _by_namespace(sources: list[Source]) -> dict[str, Source]:
    spaces: dict[str, Source] = {}
    for source in sources:
        for namespace in source.namespaces:
            spaces.setdefault(namespace, source)
    return spaces


def namespaces_known() -> frozenset:
    """Every namespace a known source defines: what keep_prefixes keeps."""
    return frozenset().union(*(s.namespaces for s in known_sources()))


# ---------------------------------------------------------------------------
# The rule (5.4) and the sentence (5.3)
# ---------------------------------------------------------------------------


def count_rules(graph: Graph) -> int:
    """The rule statements of 5.4's list in a vocabulary."""
    return sum(1 for _, p, o in graph if p in RULE_PREDICATES or (p == RDF.type and o in RULE_TYPES))


def how_for(rules: int) -> str:
    return IMPORTED if rules > 0 else REUSED


def sentence(title: str, how: str, statements: int, rules: int, prefix: str,
             hosts: Optional[dict] = None, headerless: Optional[str] = None) -> str:
    """The one sentence the Add dialog and New project show (5.3)."""
    from .reasoning import TIME_LIMIT_SECONDS

    words = []
    if headerless:
        words.append(f"This file has no ontology header; it is identified by its namespace {headerless}.")
    if how == IMPORTED:
        statement_word = "statement" if rules == 1 else "statements"
        said = (
            f"{title} holds rules: {rules:,} {statement_word} about hierarchies, domains and ranges. "
            "It will be imported"
        )
        if statements > LARGE_STATEMENTS:
            words.append(
                f"{said}. It is large ({statements:,} statements), so reasoning with imports on "
                f"will probably stop at its {int(TIME_LIMIT_SECONDS)}-second limit."
            )
        else:
            words.append(f"{said}, so the reasoner and the checks use them.")
    else:
        words.append(
            f"{title} is a list of terms with no rules. Its terms will be reused by prefix {prefix}:; "
            "nothing is imported."
        )
    if hosts:
        count = sum(hosts.values())
        files = "1 file" if count == 1 else f"{count} files"
        sites = sorted(hosts)
        where = sites[0] if len(sites) == 1 else ", ".join(sites[:-1]) + " and " + sites[-1]
        words.append(f"It also imports {files} from {where}, which you will be asked to allow.")
    return " ".join(words)


def _hosts_to_ask(imports: tuple) -> dict:
    """host -> how many of a vocabulary's own imports only the web has."""
    from .store import store

    library = set()
    for other in store.list():
        library |= {normalize_iri(i) for i in other.meta.get("ontologyIris") or []}
    hosts: Counter = Counter()
    for iri in imports:
        key = normalize_iri(iri)
        if key in BUILTIN_IRIS or bundled_for(iri) or key in library:
            continue
        if imports_service.cache.get(iri) is not None or imports_service.cache.mapping(iri) is not None:
            continue
        host = urlsplit(iri).hostname
        if host:
            hosts[host] += 1
    return dict(hosts)


def bundled_sentence(source: Source) -> str:
    """The sentence for a bundled vocabulary, from the manifest's counts:
    New project shows it without parsing a file (AC-19)."""
    return sentence(
        source.title, source.how, source.statements, source.rules, source.prefix,
        _hosts_to_ask(_bundled_imports(source)),
    )


# The own imports of the bundled files, written out so a sentence never
# parses QUDT; test_vocabularies.py reads each file and holds this to it.
BUNDLED_IMPORTS = {
    "dcat3": ("http://purl.org/dc/terms/", "http://www.w3.org/2004/02/skos/core", "http://www.w3.org/ns/prov-o#"),
    "qudt": ("http://www.linkedmodel.org/schema/vaem", "http://www.w3.org/2004/02/skos/core"),
}


def _bundled_imports(source: Source) -> tuple:
    return BUNDLED_IMPORTS.get(source.ref["id"], ())


def _manifest_entry(vocab_id: str) -> dict:
    return next(e for e in load_manifest()["vocabularies"] if e["id"] == vocab_id)


# ---------------------------------------------------------------------------
# Inspect (5.3): read a source, write nothing to the document
# ---------------------------------------------------------------------------


def _preferred_prefix(graph: Graph, namespace: str) -> str:
    for value in graph.objects(None, VANN_PREFIX):
        if isinstance(value, Literal) and _PREFIX.fullmatch(str(value)):
            return str(value)
    tail = re.sub(r"[^A-Za-z0-9]", "", namespace.rstrip("#/").rsplit("/", 1)[-1]).lower()
    if not tail or not tail[0].isalpha():
        tail = "v" + tail
    return tail[:16]


def describe(graph: Graph, fallback_title: str) -> dict:
    """What inspect reads from a parsed file: its IRI (or main namespace),
    title, namespaces, preferred prefix, counts and own imports."""
    typed = Counter()
    for subject in set(graph.subjects(RDF.type, None)):
        if isinstance(subject, URIRef):
            namespace = namespace_of(str(subject))
            # A namespace Turtle cannot hold is never one the model declares.
            if namespace and iri_ok(namespace) and not namespace.startswith(BUILTIN_NAMESPACES):
                typed[namespace] += 1
    headers = [i for i in ontology_iris(graph) if iri_ok(i)]
    header = next(
        (str(s) for s in sorted(graph.subjects(RDF.type, OWL.Ontology)) if isinstance(s, URIRef) and iri_ok(str(s))),
        None,
    )
    if not typed and header is None:
        raise Refused("This file defines no terms to reuse.")
    main = typed.most_common(1)[0][0] if typed else normalize_iri(header) + "#"
    total = sum(typed.values())
    spaces = [main] + [ns for ns, n in typed.most_common() if ns != main and n >= max(3, total // 10)]
    iri = header or main
    title = document_title(graph, fallback_title) if header else fallback_title
    prefix = _preferred_prefix(graph, main)
    prefixes = {prefix: main}
    for i, namespace in enumerate(spaces[1:], 1):
        prefixes[f"{prefix}{i}"] = namespace
    rules = count_rules(graph)
    return {
        "iri": iri,
        "aliases": tuple(i for i in headers if i != iri),
        "title": title,
        "header": header is not None,
        "prefixes": prefixes,
        "statements": len(graph),
        "rules": rules,
        "imports": tuple(declared_imports(graph)),
    }


def _refuse_self(model: Graph, iri: str, aliases: tuple, imports: tuple) -> None:
    """5.9: the model itself, or an ontology importing it, is refused."""
    own = {normalize_iri(i) for i in ontology_iris(model)}
    if {normalize_iri(i) for i in (iri, *aliases)} & own:
        raise Refused("This is the model itself.")
    if {normalize_iri(i) for i in imports} & own:
        raise Refused("That ontology already imports this model; adding it would make a loop.")


def summary(source: Source, header: bool = True) -> dict:
    """The dialog's answer for a source."""
    how = source.how
    hosts = _hosts_to_ask(source.imports)
    return {
        "iri": source.iri,
        "title": source.title,
        "prefix": source.prefix,
        "namespace": source.namespace,
        "statements": source.statements,
        "rules": source.rules,
        "how": how,
        "large": bool(source.statements and source.statements > LARGE_STATEMENTS),
        "hosts": sorted(hosts),
        "source": {"kind": source.kind, "name": source.name, "fetchedAt": source.fetched_at},
        "sentence": sentence(
            source.title, how, source.statements or 0, source.rules or 0, source.prefix, hosts,
            None if header else source.namespace,
        ),
    }


def inspect_bundled(model: Graph, vocab_id: str) -> dict:
    """A bundled vocabulary, counted from its file: one parse, shared with
    the imports machinery, so Add resolves it with no second (Section 10)."""
    source = bundled(vocab_id)
    if source is None:
        raise Refused("There is no bundled vocabulary by that name.")
    graph = load_bundled(_manifest_entry(vocab_id))
    _refuse_self(model, source.iri, source.aliases, tuple(declared_imports(graph)))
    counted = Source(**{**source.__dict__, "statements": len(graph), "rules": count_rules(graph),
                        "imports": tuple(declared_imports(graph))})
    return summary(counted)


def inspect_library(model: Graph, ontology) -> dict:
    """A library ontology, by reference: the copy stays the library's."""
    graph = ontology.ensure_loaded()
    read = describe(graph, ontology.name)
    _refuse_self(model, read["iri"], read["aliases"], read["imports"])
    data = ontology.data_path.read_bytes() if ontology.data_path and ontology.data_path.exists() else b""
    source = Source(
        iri=read["iri"], title=read["title"] if read["header"] else ontology.name, prefixes=read["prefixes"],
        kind="library", name=f"Your library: {ontology.name}", statements=read["statements"],
        rules=read["rules"], aliases=read["aliases"], imports=read["imports"],
        ref={"kind": "library", "id": ontology.id}, path=ontology.data_path, format=ontology.format,
        sha256=hashlib.sha256(data).hexdigest(),
    )
    imports_service.cache.set_mapping(source.iri, {"kind": "library", "ontologyId": ontology.id})
    _record(source)
    return summary(source, read["header"])


def inspect_file(model: Graph, name: str, data: bytes, fmt: Optional[str], timeout: Optional[float]) -> dict:
    """A chosen file, kept as a chosen import is (imports-catalog.json).
    ParseError and ParseTimeout reach the router, which words them as Load
    does (D-112)."""
    graph, used = parse_rdf(data, fmt, timeout=timeout)
    read = describe(graph, name)
    _refuse_self(model, read["iri"], read["aliases"], read["imports"])
    meta = imports_service.cache.put(read["iri"], data, graph, used, source=SOURCE_FILE, file_name=name)
    imports_service.cache.set_mapping(read["iri"], {"kind": "file"})
    source = Source(
        iri=read["iri"], title=read["title"], prefixes=read["prefixes"], kind="file", name=f"File: {name}",
        statements=read["statements"], rules=read["rules"], aliases=read["aliases"], imports=read["imports"],
        ref={"kind": "cache", "key": meta["key"]}, format=used, sha256=meta["sha256"],
    )
    _record(source)
    return summary(source, read["header"])


def inspect_url(model: Graph, url: str, timeout: Optional[float], max_bytes: int) -> dict:
    """A web address, through the broker as `ontology:import` (Section 9).
    ApprovalRequired, Offline and HostBlocked are raised before any request
    leaves, and main.py answers them; anything else is a Refused sentence."""
    from .net_guard import BlockedAddress
    from .network_broker import FetchFailed, TooLarge
    from .store import ParseError, detect_format

    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Refused("Give a web address starting with http:// or https://.")
    try:
        response = broker.request(
            "ontology:import", url.strip(), reason=INSPECT_REASON,
            headers={"Accept": IMPORT_ACCEPT}, max_bytes=max_bytes, timeout=60,
        )
    except (BlockedAddress, TooLarge, FetchFailed) as exc:
        raise Refused(str(exc)) from exc
    if response.status >= 400:
        raise Refused(f"The site answered HTTP {response.status} for this address.")
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    fmt = {
        "text/turtle": "turtle", "application/x-turtle": "turtle", "application/rdf+xml": "xml",
        "application/ld+json": "json-ld", "application/n-triples": "nt", "text/n3": "n3",
    }.get(content_type) or detect_format(urlsplit(response.url).path.rsplit("/", 1)[-1] or None)
    try:
        graph, used = parse_rdf(response.body, fmt, timeout=timeout)
    except ParseError as exc:
        exc.body = response.body  # the router words it as Load does
        exc.name = urlsplit(response.url).path.rsplit("/", 1)[-1] or None
        raise
    host = urlsplit(response.url).hostname or parts.hostname
    read = describe(graph, host)
    _refuse_self(model, read["iri"], read["aliases"], read["imports"])
    meta = imports_service.cache.put(
        read["iri"], response.body, graph, used, source=SOURCE_NETWORK, source_url=response.url
    )
    source = Source(
        iri=read["iri"], title=read["title"], prefixes=read["prefixes"], kind="web", name=f"Web: {host}",
        fetched_at=meta["fetchedAt"], statements=read["statements"], rules=read["rules"],
        aliases=read["aliases"], imports=read["imports"], ref={"kind": "cache", "key": meta["key"]},
        format=used, sha256=meta["sha256"],
    )
    _record(source)
    return summary(source, read["header"])


# ---------------------------------------------------------------------------
# The list (5.1, 5.2)
# ---------------------------------------------------------------------------


def _own(manifest: dict) -> tuple:
    return tuple(b for b in (manifest.get(k) for k in ("baseIri", "shapesBaseIri", "dataBaseIri")) if b)


def _usage(graph: Graph, skip: tuple, own_iris: set) -> tuple[Counter, dict]:
    """namespace -> how many of the document's statements use a term of it,
    and the statements themselves, a few per namespace, for Remove's
    sentence. One pass; the lines that add a vocabulary are not use."""
    counts: Counter = Counter()
    samples: dict[str, list] = {}
    for triple in graph:
        if triple[1] in _ADDING:
            continue
        spaces = set()
        for term in triple:
            iri = str(term.datatype) if isinstance(term, Literal) and term.datatype is not None else (
                str(term) if isinstance(term, URIRef) else None
            )
            if iri is None or iri in own_iris or iri.startswith(skip):
                continue
            namespace = namespace_of(iri)
            if namespace:
                spaces.add(namespace)
        for namespace in spaces:
            counts[namespace] += 1
            held = samples.setdefault(namespace, [])
            if len(held) < 3:
                held.append(triple)
    return counts, samples


def _source_json(source: Optional[Source], state_row: Optional[dict]) -> dict:
    if source is not None:
        return {"kind": source.kind, "name": source.name, "fetchedAt": source.fetched_at}
    if state_row and state_row.get("status") == RESOLVED:
        kind = {"library": "library", "mapped": "library", "file": "file", "bundled": "bundled"}.get(
            state_row.get("source"), "web"
        )
        return {"kind": kind, "name": state_row.get("sourceName") or "", "fetchedAt": state_row.get("fetchedAt")}
    return {"kind": "web", "name": "", "fetchedAt": None}


def _pending(rows: list[dict], iri: str) -> int:
    """How many files under this import still need loading: its imports and
    theirs, neither resolved nor built in."""
    below = {normalize_iri(iri)}
    count = 0
    for row in rows:
        parent = row.get("importedBy")
        if parent is not None and normalize_iri(parent) in below:
            below.add(normalize_iri(row["iri"]))
            if row["status"] not in (RESOLVED, BUILTIN):
                count += 1
    return count


def listing(graph: Graph, declared: dict, manifest: dict, state: Optional[dict]) -> dict:
    """The Vocabularies section (5.2): one row per vocabulary, and the head's
    sentence. Read from the document as it is, never rewritten (5.7)."""
    sources = known_sources()
    spaces = _by_namespace(sources)
    own = _own(manifest)
    own_iris = {str(i) for i in ontology_iris(graph)}
    skip = BUILTIN_NAMESPACES + own
    state_rows = (state or {}).get("rows", [])
    by_import = {normalize_iri(r["iri"]): r for r in state_rows}
    rows: dict[str, dict] = {}  # by the source's normalised IRI, or the namespace

    for iri in declared_imports(graph):
        if normalize_iri(iri) in BUILTIN_IRIS:
            continue
        source = source_for(iri, sources)
        state_row = by_import.get(normalize_iri(iri))
        loaded = bool(state_row and state_row["status"] == RESOLVED)
        rows[normalize_iri(source.iri if source else iri)] = {
            "iri": iri,
            "title": source.title if source else (state_row or {}).get("sourceName") or document_title(Graph(), iri),
            "prefix": None,
            "namespaces": sorted(source.namespaces if source else guessed_namespaces(iri, declared)),
            "status": "added",
            "how": IMPORTED,
            "loaded": loaded,
            "pending": _pending(state_rows, iri) if loaded else 0,
            "source": _source_json(source, state_row),
            "uses": 0,
        }

    for prefix, namespace in sorted(declared.items()):
        source = spaces.get(namespace)
        if source is None or namespace.startswith(skip):
            continue
        key = normalize_iri(source.iri)
        row = rows.get(key)
        if row is None:
            row = rows[key] = {
                "iri": source.iri,
                "title": source.title,
                "prefix": None,
                "namespaces": sorted(source.namespaces),
                "status": "added",
                "how": REUSED,
                "loaded": True,
                "pending": 0,
                "source": _source_json(source, None),
                "uses": 0,
            }
        # The prefix the document binds to the source's preferred namespace
        # wins over one bound to another of its namespaces.
        if row["prefix"] is None or namespace == source.namespace:
            row["prefix"] = prefix

    counts, _ = _usage(graph, skip, own_iris)
    for namespace, n in sorted(counts.items()):
        holder = next((r for r in rows.values() if namespace in r["namespaces"]), None)
        if holder is not None:
            holder["uses"] += n
            continue
        source = spaces.get(namespace)
        if source is not None:
            key = normalize_iri(source.iri)
            row = rows.setdefault(key, {
                "iri": source.iri,
                "title": source.title,
                "prefix": source.prefix,
                "namespaces": sorted(source.namespaces),
                "status": "used",
                "how": None,
                "loaded": False,
                "pending": 0,
                "source": _source_json(source, None),
                "uses": 0,
            })
            row["uses"] += n
            continue
        bound = next((p for p, ns in declared.items() if ns == namespace), None)
        rows[namespace] = {
            "iri": namespace,
            "title": namespace,
            "prefix": bound,
            "namespaces": [namespace],
            "status": "notFound",
            "how": None,
            "loaded": False,
            "pending": 0,
            "source": None,
            "uses": n,
        }

    for row in rows.values():
        if row["prefix"] is None:
            source = source_for(row["iri"], sources)
            bound = [p for p, ns in declared.items() if ns in row["namespaces"]]
            row["prefix"] = bound[0] if bound else (source.prefix if source else None)
    order = {"added": 0, "used": 1, "notFound": 2}
    listed = sorted(rows.values(), key=lambda r: (order[r["status"]], r["title"].lower()))
    return {"sentence": head_sentence(listed), "rows": listed, "bundled": bundled_choices()}


def bundled_choices() -> list[dict]:
    """The dialog's Bundled tab (5.3): each vocabulary's title and one line
    on what it is for, from the manifest. Static, and small."""
    return [
        {"id": s.ref["id"], "iri": s.iri, "title": s.title, "prefix": s.prefix, "description": s.description}
        for s in bundled_sources()
    ]


def head_sentence(rows: list[dict]) -> str:
    """*Uses 4 vocabularies; 1 is used but not added, 1 is not found.*"""
    if not rows:
        return "Uses no other vocabulary."
    total = len(rows)
    said = f"Uses {total} {'vocabulary' if total == 1 else 'vocabularies'}"
    used = sum(1 for r in rows if r["status"] == "used")
    missing = sum(1 for r in rows if r["status"] == "notFound")
    parts = []
    if used:
        parts.append(f"{used} {'is' if used == 1 else 'are'} used but not added")
    if missing:
        parts.append(f"{missing} {'is' if missing == 1 else 'are'} not found")
    return said + ("; " + ", ".join(parts) if parts else "") + "."


# ---------------------------------------------------------------------------
# What the commands write (5.3, 5.6)
# ---------------------------------------------------------------------------


def add_lines(header: URIRef, iri: str, prefix: str, namespace: str, how: str) -> tuple[list, dict]:
    """The lines that add a vocabulary, and the prefix they declare (D-128).

    The only code in the application that writes owl:imports: AddVocabulary
    and New project's *Reuse terms from* both call it, and
    test_projects.py's scan fails for any other writer. Imported: the
    import itself. Reused: D-121's dcterms:requires, a record of the
    dependency that switches nothing on. Either way the prefix."""
    if how == IMPORTED:
        lines = [(header, OWL.imports, URIRef(iri))]
    else:
        lines = [(header, DCTERMS.requires, URIRef(iri))]
    return lines, {prefix: namespace}


def add_plan(graph: Graph, declared: dict, manifest: dict, state: Optional[dict], iri, prefix) -> tuple[Source, str]:
    """AddVocabulary's checks (5.3, 5.9), before anything is written: the
    source and the prefix it will be declared under. The server decides
    imported or reused from the inspected copy; the browser never says."""
    if not isinstance(iri, str) or not iri.strip():
        raise Refused("Choose a vocabulary to add.")
    source = source_for(iri.strip())
    if source is None or source.how is None:
        raise Refused("Choose the vocabulary in Add a vocabulary… first, so it can be read.")
    if not iri_ok(source.iri) or not all(iri_ok(ns) for ns in source.namespaces):
        # A registry written before the check, or a library ontology's
        # declared namespace: never written into the model's text.
        raise Refused(f"{source.title} names an address Turtle cannot hold, so it cannot be added.")
    _refuse_self(graph, source.iri, source.aliases, source.imports)
    prefix = (prefix if isinstance(prefix, str) and prefix.strip() else source.prefix).strip()
    if not _PREFIX.fullmatch(prefix):
        raise Refused("A prefix starts with a letter and uses only letters, digits, hyphens and underscores.")
    if prefix == manifest.get("prefix") and source.namespace != manifest.get("baseIri"):
        raise Refused(f"{prefix}: is this model's own prefix. Choose another prefix.")
    bound = declared.get(prefix)
    if bound is not None and bound != source.namespace:
        raise Refused(f"{prefix}: already means {bound} in this model. Choose another prefix.")
    rows = listing(graph, declared, manifest, state)["rows"]
    if any(r["status"] == "added" and source.answers_to(r["iri"]) for r in rows):
        raise Refused(f"{source.title} is already added.")
    return source, prefix


def remove_plan(graph: Graph, declared: dict, manifest: dict, iri, names) -> tuple[str, list, list]:
    """RemoveVocabulary (5.6): (title, the lines to remove, the prefixes to
    undeclare), or Refused while the document's own statements use its terms,
    naming up to three in the app's sentences. One predicate scan."""
    if not isinstance(iri, str) or not iri.strip():
        raise Refused("Choose a vocabulary to remove.")
    iri = iri.strip()
    source = source_for(iri)
    spaces = set(source.namespaces) if source else guessed_namespaces(iri, declared)
    title = source.title if source else iri
    lines = [
        t for predicate in _ADDING for t in graph.triples((None, predicate, None))
        if isinstance(t[2], URIRef) and (
            (source is not None and source.answers_to(str(t[2]))) or normalize_iri(str(t[2])) == normalize_iri(iri)
        )
    ]
    undeclare = sorted(p for p, ns in declared.items() if ns in spaces)
    if not lines and not undeclare:
        raise Refused(f"{title} is not added to this model.")
    if spaces:
        own_iris = {str(i) for i in ontology_iris(graph)}
        counts, samples = _usage(graph, BUILTIN_NAMESPACES + _own(manifest), own_iris)
        used = sum(counts[ns] for ns in spaces)
        if used:
            shown = [statement_words(t, names) for ns in sorted(spaces) for t in samples.get(ns, [])][:3]
            statement_word = "1 statement uses" if used == 1 else f"{used:,} statements use"
            raise Refused(f"{statement_word} {title} terms, such as {_and(shown)}. Change them first.")
    return title, lines, undeclare


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


_PHRASES = {
    RDFS.subClassOf: "is a kind of",
    RDFS.subPropertyOf: "is a kind of",
    RDFS.domain: "is used on",
    RDFS.range: "points to",
}


def statement_words(triple: tuple, names) -> str:
    """One statement as the app says it (sentences.py): *Operator is a kind
    of Agent*, *Ann is a Person*."""
    s, p, o = triple
    subject = names(s) if not isinstance(s, BNode) else "a rule"
    if p == RDF.type and isinstance(o, URIRef):
        return f"{subject} is {sentences.a(names(o))}"
    target = names(o) if isinstance(o, URIRef) else (str(o) if isinstance(o, Literal) else "a rule")
    phrase = _PHRASES.get(p)
    if phrase is None:
        phrase = sentences.verb(names(p))
    return f"{subject} {phrase} {target}"


def names_in(graph: Graph):
    """A namer for statement_words: the label, else the local name."""
    def name(iri) -> str:
        label = pick_label(graph, iri)
        return label or str(iri).rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    return name
