"""
================================================================================
FILE: backend/app/checks.py
================================================================================

SUMMARY
    The design checks (design-checks Stage A, D-124): a built-in set of
    SELECT queries in checks/, pinned by SHA-256 in checks/manifest.json, run
    on demand against one document's own terms, each finding a sentence a
    learner reads; the measures a review asks for (size, depth, breadth,
    documentation, reuse); and the level the document reaches on six steps.
    Also the one list of standard vocabularies that decides which terms are
    borrowed (5.5.1), and the SPARQL function the queries ask it through.
    Stage B adds the twelve hints of 5.6 (H1 to H12), patterns a person
    judges, each a question at the level Hint, after the other two.

BASIC IDEA
    Every check is a .rq file that prepare_select accepts, run through
    sparql_exec.execute_select with its wall-clock timeout and its row cap
    (1,000), counting past the cap for the true total. They run one after
    another on the caller's worker thread, never on the event loop, each
    taking the document's read lock itself. A check that times out says so
    in its group and the rest still run.

    A document above CHECKS_MAX_STATEMENTS (5.10, D-125) is too large for the
    3 s budget: the report runs no query and scans no statement, naming the
    count and the cap instead, while still listing every check so each can be
    opened as a query.

    Which terms are the document's own is asked inside the queries, by
    ss:own(?iri) (urn:semantic-studio:check:own), a function this module
    registers with rdflib. So the rows a query returns are its findings,
    the totals are true, and the queries carry no namespace list: the list
    is STANDARD_NAMESPACES, here and nowhere else (test_checks.py scans for
    another). A term is own unless its IRI is in a standard vocabulary --
    except the vocabulary whose own ontology the document is (FOAF in the
    library owns FOAF) -- and, for a project, unless it is outside the
    project's bases: its base IRI, and under the address pattern its shapes
    base and its data base, where its examples live. The function reads the rule a run set in a context
    variable, which execute_select carries into its worker; opened in
    Query, with no run, it works the rule out from the graph being queried,
    so the same query gives the same rows there (5.4, *Open as a query*).

    Most checks turn each row into one sentence from the manifest's
    templates, the names the document's own labels. A few read their rows
    further, in Python, where a sentence needs more than a row: the header
    (DC-08, one row per missing detail), loops (DC-12, one per loop),
    labels shared (DC-17, one per label), reference matches (DC-18, the
    bundled index of D-121, never the network), addresses (DC-26 and DC-28,
    naming.py's rule, the one New project builds with), and example
    addresses (DC-27, one per namespace). Depth (DC-13) is counted in Python
    from the hierarchy's edges, the longest path from a top, as the tree
    counts it; its query, which counts ancestors, is what *Open as a query*
    shows.

    The hints (5.6) are pinned queries too, each sentence a question. Their
    word lists (roles, quantities, units, singular words) are the
    manifest's; their shapes are axioms.py's (a rule H1 lists only when
    axioms.unused_by_reasoner says reasoning does not use it, D-129, a domain by domain_of for H2 and H9). H2 and H3
    read the project's current reasoning result, which the router hands in
    as (individual, class) pairs: without one H2 asks its question alone and
    H3 says in its group that there is no run to read. H3, H10 and H11 are
    computed in Python, their queries being what *Open as a query* shows.

    DC-30 (addresses used but defined nowhere) and DC-31 (terms defined in
    two files) are computed too (links-between-files 5.7): which file holds
    a statement is not in the merged graph, so they read the project's
    files one by one, with its imports and switched-on snapshots, from the
    router's `whole`; each finding names its file. Outside a project they
    have no files to ask and report nothing.

    prepare() warms what the first report used to pay for, the parsed
    queries and the reference index; main.py calls it in the lifespan.

    A shapes document has only DC-01, DC-03 and DC-08 run (5.11), and DC-26
    runs only with a namespace set. DC-24 is a Problem in a project made
    under the address pattern; DC-27 calls an example address Worth a look.

    A project's files are checked together (multi-file-projects 5.3 item
    6): the router hands in `whole`, their graph and the sum of their
    revisions, and the 10,000-statement cap counts it whole.

    Nothing here changes the document: the checks are SELECTs, and a
    finding only says where to go.

INPUTS / INPUT SOURCES
    - checks/*.rq and checks/manifest.json.
    - An Ontology from the store (its graph, its read lock, its revision).
    - The project manifest, for a project document; the namespace from
      settings.py; a project's current reasoning conclusions, for H2 and H3.

EXPECTED OUTPUT
    - catalogue(): [{id, level, heading, fix, query}] for GET /api/checks.
    - run(): {revision, generation, ran_ms, empty, measures, groups: [{id,
      level, heading, fix, total, findings: [{iri, sentence, block?,
      level?}], error?, note?}], skipped, notes} for GET
      /api/ontologies/{id}/checks; above the cap, measures is null and
      overCap is {statements, cap}.
    - prepare(), for the server's start.
    - is_own(), STANDARD_NAMESPACES.
================================================================================
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import re
import threading
import time
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD
from rdflib.plugins.sparql.operators import register_custom_function

from . import axioms, naming, references, sparql_exec, standard_terms
from .graph_builder import pick_label
from .sentences import a as with_article, verb

CHECKS_DIR = Path(__file__).parent / "checks"
MANIFEST_PATH = CHECKS_DIR / "manifest.json"

# design-checks 5.5.3 and Section 8: the report's limits.
MAX_ROWS = 1000
SHOWN = 100
TIMEOUT_SECONDS = 30.0

# design-checks 5.10 and Section 10 (D-125): above this many statements the
# report runs no query. Twenty-eight SELECTs over a document this large do not
# fit the 3 s budget on rdflib's evaluator -- DC-19 and DC-20 scan every
# statement -- and QUDT (132,166 statements, about 15 s) is the case that forced
# the decision. The value was measured, not a setting: a worst-case document of
# 9,966 statements (classes, properties and individuals carrying a date-time and
# a number-as-text each) runs every Stage A check in about 1.9 s, and the 3 s
# budget is crossed near 15,000. The cap sits below that, with room; the largest
# bundled document under it, dcat3 (1,695 statements), runs in about 0.6 s.
CHECKS_MAX_STATEMENTS = 10_000

# 5.5.1: the standard vocabularies. A term in one of these is borrowed, never
# the document's own, unless the document is that vocabulary's ontology. The
# one list (test_checks.py scans app/ for another copy of it).
STANDARD_NAMESPACES: tuple[str, ...] = (
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",    # RDF
    "http://www.w3.org/2000/01/rdf-schema#",          # RDFS
    "http://www.w3.org/2002/07/owl#",                 # OWL
    "http://www.w3.org/2001/XMLSchema#",              # XSD
    "http://www.w3.org/2004/02/skos/core#",           # SKOS
    "http://www.w3.org/2008/05/skos-xl#",             # SKOS-XL
    "http://purl.org/dc/elements/1.1/",               # Dublin Core elements
    "http://purl.org/dc/terms/",                      # Dublin Core terms
    "http://www.w3.org/ns/prov#",                     # PROV
    "http://xmlns.com/foaf/0.1/",                     # FOAF
    "http://schema.org/",                             # schema.org
    "https://schema.org/",
    "http://www.opengis.net/ont/geosparql#",          # GeoSPARQL
    "http://www.opengis.net/ont/sf#",                 # Simple Features
    "http://www.w3.org/2003/01/geo/wgs84_pos#",       # WGS84
    "http://qudt.org/schema/qudt/",                   # QUDT
    "http://qudt.org/vocab/",
    "http://www.w3.org/ns/dcat#",                     # DCAT
    "http://purl.org/vocab/vann/",                    # VANN
    "http://rdfs.org/ns/void#",                       # VOID
    "http://www.w3.org/ns/shacl#",                    # SHACL
    "http://www.w3.org/ns/org#",                      # ORG
    "http://www.w3.org/2006/time#",                   # TIME
    "http://www.w3.org/ns/sosa/",                     # SOSA
    "http://www.w3.org/ns/ssn/",                      # SSN
)

# The language the document's own terms are written in, never one of these:
# the reuse measure leaves the modelling language itself out.
_LANGUAGE_NAMESPACES = STANDARD_NAMESPACES[:4]

OWN_FUNCTION = URIRef("urn:semantic-studio:check:own")
TERM_FUNCTION = URIRef("urn:semantic-studio:check:term")

# A shapes document is checked for names, definitions and its header (5.11).
SHAPES_CHECKS = ("DC-01", "DC-03", "DC-08")

TERM_TYPES = (
    OWL.Class, RDFS.Class, OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty,
    RDF.Property, SKOS.Concept,
)
CLASS_TYPES = (OWL.Class, RDFS.Class)
PROPERTY_TYPES = (OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty, RDF.Property)
SH_NODE_SHAPE = URIRef("http://www.w3.org/ns/shacl#NodeShape")
_NOT_INDIVIDUAL = set(TERM_TYPES) | {SKOS.ConceptScheme, OWL.Ontology, SH_NODE_SHAPE, OWL.Restriction}
DEFINING = (SKOS.definition, RDFS.comment, URIRef("http://purl.org/dc/terms/description"))
LABELLING = (RDFS.label, SKOS.prefLabel)

# Worst first: a group's level is the worst of its findings'. Hints (5.6) are
# questions, never faults, and always come last.
LEVELS = ("Problem", "Worth a look", "Hint")

LANGUAGE_NAMES = {
    "": "no language", "en": "English", "fr": "French", "de": "German", "es": "Spanish",
    "it": "Italian", "nl": "Dutch", "pt": "Portuguese", "ja": "Japanese", "zh": "Chinese",
}
_COUNT_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}

STEPS = (
    ("Named terms", "Name your first class, property or concept."),
    ("Defined terms", "Write a definition for at least half of your terms."),
    ("Arranged in a hierarchy", "Put one term under another: a subclass or a broader concept."),
    ("Related terms", "Relate two concepts, or give a term a synonym (an alternative label)."),
    ("Formal model", "Add classes and the properties that join them."),
    ("Formal model with data", "Add an example: an individual of one of your classes."),
)

EMPTY = "Nothing to check yet: add a class or a concept."
TIMED_OUT = "This check did not finish in 30 seconds."
IMPORTS_NOTE = "Imported terms are not checked."
SHAPES_NOTE = "A shapes document is checked for names, definitions and its header; the other checks are skipped."
LOCAL_NOTE = "These checks run on this computer."


# --- the catalogue ---------------------------------------------------------------


class CheckFileChanged(RuntimeError):
    """A .rq file whose bytes are not the ones pinned (never served)."""


_catalogue_lock = threading.Lock()
_catalogue: Optional[list[dict]] = None


def manifest() -> list[dict]:
    """The checks in their order, each with its query read and its hash
    checked: a file that changed is refused, never run."""
    global _catalogue
    with _catalogue_lock:
        if _catalogue is None:
            entries = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["checks"]
            loaded = []
            for entry in entries:
                data = (CHECKS_DIR / entry["file"]).read_bytes()
                if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                    raise CheckFileChanged(f"{entry['file']} does not match its pinned hash.")
                loaded.append({**entry, "query": data.decode("utf-8")})
            _catalogue = loaded
        return _catalogue


def catalogue() -> list[dict]:
    """GET /api/checks: what *Open as a query* needs."""
    return [
        {"id": e["id"], "level": e["level"], "heading": e["heading"], "fix": e["fix"], "query": e["query"]}
        for e in manifest()
    ]


def prepare() -> None:
    """Warm what the first report pays for (design-checks Stage B follow-up):
    the manifest read and pinned, each query parsed and kept for reuse, and the
    reference index (DC-18) built. The first report after a server start parsed
    every query and built the index on the caller's thread, so the first run
    missed Section 10's budget; doing it at startup fixes that. Called once in
    the server's lifespan, never at import, and the caller swallows any failure
    as the examples' seeding does: a slow first report is not worth a dead
    server."""
    for entry in manifest():
        sparql_exec.prewarm(entry["query"])
    _reference_terms()


# --- which terms are the document's own (5.5.1) ------------------------------------


@dataclass(frozen=True)
class OwnRule:
    """The standard namespaces this document owns, and a project's bases:
    its model's, and under the address pattern its shapes' and its data's
    (design-checks 5.3), each its own."""

    owned: frozenset
    bases: tuple = ()


def owned_namespaces(graph: Graph) -> frozenset:
    """The standard namespaces whose ontology this document is: FOAF's
    header is <http://xmlns.com/foaf/0.1/>, so the FOAF file owns FOAF."""
    headers = [str(o) for o in graph.subjects(RDF.type, OWL.Ontology) if isinstance(o, URIRef)]
    return frozenset(
        ns for ns in STANDARD_NAMESPACES
        if any(h.rstrip("#/") == ns.rstrip("#/") or h.startswith(ns) for h in headers)
    )


def own_rule(graph: Graph, project: Optional[dict] = None) -> OwnRule:
    """The rule for one document: the standard namespaces it owns and, for a
    project, its bases. The report and the read-aloud tick read this one."""
    bases = tuple(b for b in ((project or {}).get(k) for k in ("baseIri", "shapesBaseIri", "dataBaseIri")) if b)
    return OwnRule(owned_namespaces(graph), bases)


def is_own(iri, rule: OwnRule) -> bool:
    if not isinstance(iri, URIRef):
        return False
    text = str(iri)
    if rule.bases and not text.startswith(rule.bases):
        return False
    # One C-level test for the common case, a term in no standard namespace.
    if not text.startswith(STANDARD_NAMESPACES):
        return True
    for ns in STANDARD_NAMESPACES:
        if text.startswith(ns):
            return ns in rule.owned
    return True


# The rule of the run in progress; execute_select runs its worker in a copy
# of the caller's context, which carries it there.
_rule: contextvars.ContextVar[Optional[OwnRule]] = contextvars.ContextVar("check_own_rule", default=None)
# A query opened in Query has no run: its rule is worked out from the graph,
# once per graph and size.
_rules_by_graph: "weakref.WeakKeyDictionary[Graph, tuple[int, OwnRule]]" = weakref.WeakKeyDictionary()


def _rule_for(graph: Graph) -> OwnRule:
    held = _rules_by_graph.get(graph)
    size = len(graph)
    if held is None or held[0] != size:
        held = (size, OwnRule(owned_namespaces(graph)))
        _rules_by_graph[graph] = held
    return held[1]


def _own(expr, ctx) -> Literal:
    """ss:own(?iri): true for a term the document owns, as a SPARQL boolean."""
    args = expr.expr
    term = args[0] if isinstance(args, list) else args
    rule = _rule.get()
    if rule is None:
        rule = _rule_for(ctx.ctx.graph)
    return Literal(is_own(term, rule))


register_custom_function(OWN_FUNCTION, _own, override=True, raw=True)


def is_term(graph: Graph, iri) -> bool:
    """Typed as a term (a class, a property, a concept, a scheme, a shape,
    an ontology or a restriction): what is never an individual."""
    return any(t in _NOT_INDIVIDUAL for t in graph.objects(iri, RDF.type))


def _term(expr, ctx) -> Literal:
    """ss:term(?iri): a direct look at the subject's types. A NOT EXISTS
    with the same meaning ran once per row as a sub-query: 6.8 s over
    QUDT's 10,145 individuals, against milliseconds for this."""
    args = expr.expr
    term = args[0] if isinstance(args, list) else args
    return Literal(isinstance(term, URIRef) and is_term(ctx.ctx.graph, term))


register_custom_function(TERM_FUNCTION, _term, override=True, raw=True)


# --- small words -----------------------------------------------------------------


def local_name(iri: str) -> str:
    return re.split(r"[#/]", str(iri).rstrip("#/"))[-1] or str(iri)


def _words(name: str) -> list[str]:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return [w for w in re.split(r"[\s_\-.]+", spaced) if w]


def upper_camel(name: str) -> str:
    return "".join(w[:1].upper() + w[1:].lower() for w in _words(name)) or name


def lower_camel(name: str) -> str:
    camel = upper_camel(name)
    return camel[:1].lower() + camel[1:]


def people_label(name: str) -> str:
    """RoboticMission -> Robotic mission."""
    words = _words(name)
    return " ".join([words[0][:1].upper() + words[0][1:].lower(), *(w.lower() for w in words[1:])]) if words else name


def count_word(n: int) -> str:
    return _COUNT_WORDS.get(n, f"{n:,}")


def _joined(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


# --- a run ---------------------------------------------------------------------------


@dataclass
class Run:
    """What the sentences of one run read."""

    graph: Graph
    rule: OwnRule
    namespace: Optional[str]
    project: Optional[dict]
    names: dict
    # The hierarchy's depths (DC-13), and the types the project's current
    # reasoning result concluded, as (individual, class) IRIs (H2, H3): None
    # when there is no current result.
    depths: dict = field(default_factory=dict)
    inferred: Optional[list] = None
    # A project's files one by one, as (doc, file, graph), every ontology,
    # vocabulary and shapes file, and the graphs said beside them -- its
    # imports and switched-on data snapshots (links-between-files 5.7):
    # which file holds a statement is not in the merged graph. None outside
    # a project, which has no files to ask.
    files: Optional[list] = None
    outside: list = field(default_factory=list)
    _domains: Optional[dict] = None

    def domains(self) -> dict:
        """Every own property's domain, read once per run by axioms.domain_of,
        the one reader of a domain (D-116)."""
        if self._domains is None:
            self._domains = {p: r for p, r in axioms.domains(self.graph).items() if is_own(p, self.rule)}
        return self._domains

    def name(self, iri) -> str:
        """The document's own name for a term, its local name else."""
        key = str(iri)
        if key not in self.names:
            self.names[key] = pick_label(self.graph, URIRef(key)) if isinstance(iri, (str, URIRef)) else key
        return self.names[key]


def _cell(cell) -> Optional[str]:
    if cell is None:
        return None
    return cell.get("value")


def _rows(result: dict) -> list[dict]:
    names = result["vars"]
    return [{name: cell for name, cell in zip(names, row)} for row in result["rows"]]


def _finding(iri, sentence: str, block: Optional[str] = None, level: Optional[str] = None) -> dict:
    out: dict = {"iri": str(iri) if iri is not None else None, "sentence": sentence}
    if block:
        out["block"] = block
    if level:
        out["level"] = level
    return out


def _named(run: Run, row: dict, key: str = "iri") -> str:
    cell = row.get(key)
    if cell is None:
        return ""
    if cell.get("type") == "uri":
        return cell.get("label") or run.name(cell["value"])
    return cell.get("value", "")


# Each check's rows as findings. The default fills the manifest's one
# template with the row's names; these read their rows further.


def _default(entry: dict, run: Run, rows: list[dict]) -> list[dict]:
    template = entry["sentences"]["row"]
    out = []
    for row in rows:
        values = {key: _named(run, row, key) for key in row}
        values["name"] = _named(run, row)
        out.append(_finding(_cell(row["iri"]), template.format(**values), entry.get("block")))
    return out


def _variant(key: str) -> Callable:
    """A check whose row names its own variant in the column `key`."""
    def shape(entry: dict, run: Run, rows: list[dict]) -> list[dict]:
        out = []
        for row in rows:
            values = {k: _named(run, row, k) for k in row}
            values["name"] = _named(run, row)
            variant = _cell(row.get(key)) or "row"
            template = entry["sentences"].get(variant, entry["sentences"].get("row"))
            out.append(_finding(_cell(row["iri"]), template.format(**values), entry.get("block")))
        return out
    return shape


def _dc02(entry, run, rows):
    t = entry["sentences"]["row"]
    return [
        _finding(_cell(r["iri"]), t.format(
            name=_named(run, r), count=count_word(int(_cell(r["count"]))),
            language=LANGUAGE_NAMES.get(_cell(r["lang"]) or "", _cell(r["lang"]) or "no language"),
        ), entry.get("block"))
        for r in rows
    ]


def _dc03(entry, run, rows):
    s = entry["sentences"]
    return [
        _finding(_cell(r["iri"]), (s["note"] if r.get("note") else s["row"]).format(name=_named(run, r)), entry.get("block"))
        for r in rows
    ]


def _dc04(entry, run, rows):
    t = entry["sentences"]["row"]
    return [
        _finding(_cell(r["iri"]), t.format(local=_cell(r["name"]), suggested=upper_camel(_cell(r["name"]))))
        for r in rows
    ]


_PROPERTY_WORDS = {str(OWL.ObjectProperty): "relationship", str(OWL.DatatypeProperty): "attribute"}


def _dc05(entry, run, rows):
    t = entry["sentences"]["row"]
    seen: dict = {}
    for r in rows:
        iri = _cell(r["iri"])
        what = _PROPERTY_WORDS.get(_cell(r["type"]), "property")
        # A property typed twice (owl:ObjectProperty and rdf:Property) is one
        # finding, under the more telling word.
        if iri not in seen or seen[iri][0] == "property":
            seen[iri] = (what, _cell(r["name"]))
    return [
        _finding(iri, t.format(what=what, local=name, suggested=lower_camel(name)))
        for iri, (what, name) in seen.items()
    ]


_YEAR = re.compile(r"(?:^|[^0-9])(?:19|20)[0-9]{2}(?:[^0-9]|$)")


def _dc06(entry, run, rows):
    s = entry["sentences"]
    return [
        _finding(_cell(r["iri"]), (s["date"] if _YEAR.search(_cell(r["name"])) else s["version"]).format(local=_cell(r["name"])))
        for r in rows
    ]


def _dc07(entry, run, rows):
    out = []
    for r in rows:
        name = local_name(_cell(r["iri"]))
        sentence = entry["sentences"]["row"].format(local=name, label=_cell(r["label"]))
        out.append(_finding(_cell(r["iri"]), f"{sentence} Write it for people: {people_label(name)}.", entry.get("block")))
    return out


_SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def _dc08(entry, run, rows):
    s = entry["sentences"]
    block = entry.get("block")
    if not rows:
        return [_finding(None, s["none"], block)]
    out = []
    for r in rows:
        iri = _cell(r["iri"])
        for key in ("title", "description", "creator"):
            if r.get(key) is None:
                out.append(_finding(iri, s[key], block))
        version = _cell(r.get("version"))
        if version is None:
            out.append(_finding(iri, s["version"], block))
        elif not _SEMVER.fullmatch(version):
            out.append(_finding(iri, s["semver"].format(version=version), block))
        if r.get("versionIri") is None:
            out.append(_finding(iri, s["versionIri"], block))
    return out


def _dc09(entry, run, rows):
    t = entry["sentences"]["row"]
    return [
        _finding(_cell(r["iri"]), t.format(tail=local_name(_cell(r["versionIri"])), version=_cell(r["version"])), entry.get("block"))
        for r in rows
    ]


def _loops(graph: Graph, nodes: set, rule: OwnRule) -> list[list]:
    """The loops among `nodes`, each once, in its order round the loop."""
    edges: dict = {}
    for node in nodes:
        parents = [p for p in graph.objects(node, RDFS.subClassOf) if p in nodes]
        parents += [p for p in graph.objects(node, SKOS.broader) if p in nodes]
        parents += [c for c in graph.subjects(SKOS.narrower, node) if c in nodes]
        edges[node] = sorted(set(parents))
    loops, placed = [], set()
    for start in sorted(nodes):
        if start in placed:
            continue
        # The shortest way back to `start`, by breadth first.
        back = {start: None}
        queue = [start]
        found = None
        while queue and found is None:
            current = queue.pop(0)
            for parent in edges.get(current, []):
                if parent == start:
                    found = current
                    break
                if parent not in back:
                    back[parent] = current
                    queue.append(parent)
        if found is None:
            continue
        path = [found]
        while back[path[-1]] is not None:
            path.append(back[path[-1]])
        path = list(reversed(path))
        placed.update(path)
        loops.append(path)
    return loops


def _dc12(entry, run, rows):
    nodes = {URIRef(_cell(r["iri"])) for r in rows}
    out = []
    for loop in _loops(run.graph, nodes, run.rule):
        names = [run.name(n) for n in loop] + [run.name(loop[0])]
        out.append(_finding(str(loop[0]), entry["sentences"]["row"].format(names=_joined(names))))
    return out


def _dc14(entry, run, rows):
    t = entry["sentences"]["row"]
    return [_finding(_cell(r["iri"]), t.format(name=_named(run, r), count=count_word(int(_cell(r["count"]))))) for r in rows]


def _dc15(entry, run, rows):
    t = entry["sentences"]["row"]
    out, seen = [], set()
    for r in rows:
        pair = frozenset((_cell(r["iri"]), _cell(r["other"])))
        # A pair is one finding, said from the first by IRI, never by set order.
        if pair in seen:
            continue
        seen.add(pair)
        out.append(_finding(_cell(r["iri"]), t.format(name=_named(run, r), other=_named(run, r, "other"))))
    return out


def _dc17(entry, run, rows):
    t = entry["sentences"]["row"]
    out = []
    for r in rows:
        iris = sorted(_cell(r["terms"]).split(" "))
        names = [local_name(i) for i in iris]
        label = run.name(iris[0])
        out.append(_finding(iris[0], t.format(count=count_word(len(iris)).capitalize(), label=label, names=_joined(names)), entry.get("block")))
    return out


def _simple(text: str) -> str:
    return re.sub(r"[\s_\-]+", "", text).casefold()


_reference_lock = threading.Lock()
_reference_names: Optional[dict] = None


def _reference_terms() -> dict:
    """(kind, simple name) -> (iri, local, reference title), from the bundled
    reference indexes (D-121), built once: no network, no download."""
    global _reference_names
    with _reference_lock:
        if _reference_names is None:
            found: dict = {}
            for entry in references.entries():
                index = references.index(entry["key"])
                for term in index.terms:
                    kind = "class" if term["kind"] == "class" else "property"
                    for name in {term["label"], local_name(term["iri"])}:
                        found.setdefault((kind, _simple(name)), (term["iri"], term["label"], index.title))
            _reference_names = found
        return _reference_names


def _dc29(entry, run, rows):
    """Home-made copies of a standard axiom (standard-terms 5.7, D-126): each
    own class or property whose name matches a refuse entry of the catalogue,
    at Problem. The rows are DC-29's (classes and every kind of property);
    read against standard_terms, which is the only reader of the catalogue."""
    t = entry["sentences"]["row"]
    out, seen = [], set()
    for r in rows:
        iri = _cell(r["iri"])
        if iri in seen:
            continue
        group = "class" if _cell(r["type"]) in (str(OWL.Class), str(RDFS.Class)) else "property"
        hit = standard_terms.match([_cell(r.get("label")), local_name(iri)], group)
        if hit is not None and hit["level"] == "refuse":
            seen.add(iri)
            out.append(_finding(iri, t.format(name=_named(run, r), curie=hit["curie"]), entry.get("block")))
    return out


def _dc18(entry, run, rows):
    t = entry["sentences"]["row"]
    terms = _reference_terms()
    out, seen = [], set()
    for r in rows:
        iri = _cell(r["iri"])
        if iri in seen:
            continue
        kind = "class" if _cell(r["type"]) in (str(OWL.Class), str(RDFS.Class)) else "property"
        matched = False
        for name in (_cell(r.get("label")), local_name(iri)):
            if not name:
                continue
            match = terms.get((kind, _simple(name)))
            # The reference's own term is no copy of itself.
            if match and match[0] != iri:
                seen.add(iri)
                matched = True
                out.append(_finding(iri, t.format(name=_named(run, r), match=match[1], reference=match[2])))
                break
        if matched:
            continue
        # A name like a standard term at level warn (standard-terms 5.7): read
        # against the catalogue, in DC-18's own level and sentence. Its
        # reference is the standard vocabulary, its match the curie.
        std = standard_terms.match([_cell(r.get("label")), local_name(iri)], kind)
        if std is not None and std["level"] == "warn":
            seen.add(iri)
            out.append(_finding(iri, t.format(
                name=_named(run, r), match=std["curie"], reference=standard_terms.vocab_name(std["curie"]),
            )))
    return out


def _dc19_20(entry, run, rows):
    t = entry["sentences"]["row"]
    return [
        _finding(_cell(r["iri"]), t.format(
            name=_named(run, r), property=_named(run, r, "property"), value=_cell(r.get("value")) or "",
        ))
        for r in rows
    ]


def _dc21(entry, run, rows):
    t = entry["sentences"]["row"]
    out = []
    for r in rows:
        imported = _cell(r["imported"])
        name = run.name(imported)
        out.append(_finding(_cell(r["iri"]), t.format(imported=name if name != imported else local_name(imported) or imported), entry.get("block")))
    return out


def _dc24(entry, run, rows):
    level = "Problem" if run.project and run.project.get("dataBaseIri") else None
    t = entry["sentences"]["row"]
    return [_finding(_cell(r["iri"]), t.format(name=_named(run, r)), level=level) for r in rows]


def _ontology_iri(run: Run) -> Optional[str]:
    headers = sorted(str(o) for o in run.graph.subjects(RDF.type, OWL.Ontology) if isinstance(o, URIRef))
    return headers[0] if headers else None


def _general_class(run: Run, iri: str) -> Optional[str]:
    """The slug a data item's class segment should be: its most general own
    class's (5.3), the first by IRI of several."""
    graph = run.graph
    classes = sorted(c for c in graph.objects(URIRef(iri), RDF.type) if isinstance(c, URIRef) and any((c, RDF.type, t) in graph for t in CLASS_TYPES))
    if not classes:
        return None
    seen, frontier, tops = {classes[0]}, [classes[0]], set()
    while frontier:
        current = frontier.pop()
        parents = [p for p in graph.objects(current, RDFS.subClassOf) if isinstance(p, URIRef) and any((p, RDF.type, t) in graph for t in CLASS_TYPES)]
        if not parents:
            tops.add(current)
        for p in parents:
            if p not in seen:
                seen.add(p)
                frontier.append(p)
    top = sorted(tops)[0] if tops else classes[0]
    return naming.class_slug(str(top))


def _dc26(entry, run, rows):
    s = entry["sentences"]
    ontology = _ontology_iri(run)
    artifact = (run.project or {}).get("baseIri") or (ontology + "#" if ontology else None)
    out = []
    for r in rows:
        iri, role = _cell(r["iri"]), _cell(r["role"])
        reading = naming.read(
            iri, role, run.namespace,
            artifact=artifact if role == "term" else None,
            general_class=_general_class(run, iri) if role == "data" else None,
        )
        name = "The ontology" if role == "artifact" else _named(run, r)
        for code, detail in reading["departures"]:
            if code not in naming.PATTERN_DEPARTURES:
                continue
            if role == "artifact" and code == "outside":
                sentence = s["outside"].format(name=name, namespace=detail)
            elif code == "class":
                found = naming.read(iri, "data", run.namespace)["parts"].get("class", "")
                sentence = s["class"].format(name=name, found=found, expected=detail)
            else:
                sentence = s[code].format(name=name, namespace=detail)
            out.append(_finding(iri, sentence, "header" if role == "artifact" else None))
    return out


def _namespace_of(iri: str) -> str:
    if "#" in iri:
        return iri.split("#", 1)[0] + "#"
    return iri.rsplit("/", 1)[0] + "/"


def _dc27(entry, run, rows):
    s = entry["sentences"]
    headers = {str(o) for o in run.graph.subjects(RDF.type, OWL.Ontology)}
    out, seen = [], set()
    for r in rows:
        iri, kind = _cell(r["iri"]), _cell(r["kind"])
        host = re.sub(r"^https?://(www\.)?", "", iri).split("/")[0].split("#")[0]
        level = "Worth a look" if kind == "example" else "Problem"
        if iri in headers:
            key = ("header", iri)
            sentence = s[kind].format(host=host)
            block = "header"
        else:
            namespace = _namespace_of(iri)
            # A term under the ontology's own address is the ontology's
            # finding already; one namespace is one finding.
            if any(namespace.rstrip("#/") == h.rstrip("#/") for h in headers):
                continue
            key = ("terms", namespace)
            sentence = s["terms" + kind.capitalize()].format(namespace=namespace, host=host)
            block = None
        if key in seen:
            continue
        seen.add(key)
        out.append(_finding(iri, sentence, block, level))
    return out


def _dc28(entry, run, rows):
    s = entry["sentences"]
    out, seen = [], set()
    for r in rows:
        iri, role = _cell(r["iri"]), _cell(r["role"])
        path = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/#?]*", "", iri).split("#", 1)[0]
        if (role == "term" and "#" not in iri) or role == "data":
            path = path.rsplit("/", 1)[0] + "/"
        # A path is said once: every term after '#' shares its ontology's,
        # and every individual of a class its class's.
        if path in seen:
            continue
        seen.add(path)
        whose = "The ontology's" if role == "artifact" else f"{_named(run, r)}'s"
        # A term's own name after a slash is DC-04 and DC-05's, as the name
        # after '#' is, and a data item's last segment is its identifier
        # from the system of record (DC-26 holds it to the segment rule):
        # only the path above either is read here.
        address = iri if (role == "term" and "#" in iri) or role == "artifact" else iri.rsplit("/", 1)[0] + "/"
        for code, segment in naming.path_departures(address):
            out.append(_finding(iri, s[code].format(whose=whose, segment=segment), "header" if role == "artifact" else None))
    return out


def _dc01(entry, run, rows):
    """A term with no English label is named by its local name: its other
    label is in a language the sentence is not."""
    t = entry["sentences"]["row"]
    return [_finding(_cell(r["iri"]), t.format(name=local_name(_cell(r["iri"]))), entry.get("block")) for r in rows]


# --- hints (5.6, Stage B) ------------------------------------------------------------
#
# Each a question, never a fault: a pattern a person judges. Most read their
# query's rows further in Python, where a word list (the manifest's) or a
# shape (axioms.py's) decides; H3 and H11 are computed in Python alone, their
# query being what *Open as a query* shows, as DC-13's is.


def _word_list(entry: dict, key: str) -> frozenset:
    return frozenset(w.casefold() for w in entry.get(key, ()))


def _plain_words(text: str) -> list[str]:
    """A name or a sentence as lowercase words: camel case split, digits kept."""
    return [w.casefold() for w in _words(text) for w in re.findall(r"[A-Za-z0-9]+", w)]


_RULE_WORDS = {"some": "some", "only": "only", "exactly": "exactly", "atLeast": "at least", "atMost": "at most"}


# Where a rule's *open* leads (owl-rl-warnings 5.5): a class's Rules block,
# or the property's domain or range.
_H1_BLOCKS = {
    str(RDFS.subClassOf): "rules", str(OWL.equivalentClass): "rules", str(OWL.disjointUnionOf): "rules",
    str(RDFS.domain): "domain", str(RDFS.range): "range",
}


def _h1(entry, run, rows):
    """A rule the reasoner does not use. The query lists candidates; each is
    read again through axioms.unused_by_reasoner, the one decider (owl-rl-
    warnings 5.1, D-129), so a definition by *some*, which the engine uses,
    is never asked about. A rule the Edit form reads (parse_restriction,
    parse_defining) is said in its words; any other in its short label."""
    t = entry["sentences"]["row"]
    out, seen = [], set()
    for r in rows:
        iri, how = URIRef(_cell(r["iri"])), _cell(r["how"])
        node = BNode(_cell(r["rule"])) if r["rule"].get("type") == "bnode" else URIRef(_cell(r["rule"]))
        if (iri, node) in seen:
            continue
        seen.add((iri, node))
        reason = axioms.unused_by_reasoner(run.graph, node)
        if reason is None:
            continue
        parsed = None
        if how == str(RDFS.subClassOf):
            parsed = axioms.parse_restriction(run.graph, node)
        elif how == str(OWL.equivalentClass):
            defining = axioms.parse_defining(run.graph, node)
            parsed = defining[1] if defining is not None else None
        if parsed is not None:
            prop, kind, filler, n = parsed
            words = [run.name(prop), _RULE_WORDS.get(kind, kind)]
            if n is not None:
                words.append(f"{n:,}")
            if filler is not None and kind != "value":
                words.append(run.name(filler))
            said = " ".join(words)
        else:
            said = axioms.unused_words(run.graph, iri, node, reason, run.name)
        out.append(_finding(iri, t.format(name=run.name(iri), rule=said), _H1_BLOCKS.get(how)))
    return out


def _things(n: int) -> tuple[str, str]:
    return ("one", "thing") if n == 1 else (count_word(n), "things")


def _h2(entry, run, rows):
    """Every domain and range, one question each. A domain is read through
    axioms.domain_of (D-116), a union or two lines said as domain_names says
    them; a range only as a named class, a datatype range refusing nothing
    to type. With a current reasoning result, how many things it typed."""
    s = entry["sentences"]
    inferred = set(map(tuple, run.inferred)) if run.inferred is not None else None
    graph = run.graph
    # (property, 0 for its domain and 1 for a range, finding): one
    # property's questions together, its domain first.
    out = []
    for prop, reading in run.domains().items():
        named = axioms.domain_names(reading, run.name)
        if not named:
            continue
        sentence = s["domain"].format(verb=verb(run.name(prop)), a_class=with_article(named))
        if inferred is not None:
            typed = {
                str(x) for x in graph.subjects(prop, None)
                if any((str(x), str(c)) in inferred for c in reading.classes)
            }
            if typed:
                count, things = _things(len(typed))
                sentence += s["inferred"].format(count=count, things=things, a_class=with_article(named))
        out.append((str(prop), 0, _finding(str(prop), sentence)))
    for r in rows:
        if _cell(r["how"]) != str(RDFS.range) or r["class"].get("type") != "uri":
            continue
        prop, cls = _cell(r["iri"]), _cell(r["class"])
        if axioms.is_datatype(URIRef(cls)):
            continue
        a_class = with_article(run.name(cls))
        sentence = s["range"].format(verb=verb(run.name(prop)), a_class=a_class)
        if inferred is not None:
            typed = {str(o) for o in graph.objects(None, URIRef(prop)) if (str(o), cls) in inferred}
            if typed:
                count, things = _things(len(typed))
                sentence += s["inferred"].format(count=count, things=things, a_class=a_class)
        out.append((prop, 1, _finding(prop, sentence)))
    return [f for _, _, f in sorted(out, key=lambda x: (x[0], x[1], x[2]["sentence"]))]


def _h3(entry, run) -> list[dict]:
    """The types the current reasoning result concluded for an own
    individual that the document never states, leaving out those its stated
    types already give through rdfs:subClassOf: every Mission is a
    Mission's superclass, and saying so for each would bury the surprising
    ones (a domain's, a range's, a rule's)."""
    t = entry["sentences"]["row"]
    graph = run.graph
    out = []
    for s, c in sorted(set(map(tuple, run.inferred or ()))):
        subject, cls = URIRef(s), URIRef(c)
        if not (is_own(subject, run.rule) and is_own(cls, run.rule)) or is_term(graph, subject):
            continue
        if (subject, RDF.type, cls) in graph:
            continue
        stated = [o for o in graph.objects(subject, RDF.type) if isinstance(o, URIRef)]
        if any(cls in set(graph.transitive_objects(o, RDFS.subClassOf)) for o in stated):
            continue
        out.append(_finding(s, t.format(name=run.name(s), a_class=with_article(run.name(c)))))
    return out


_UNFINISHED = re.compile(r"\b(TODO|TBD)\b", re.IGNORECASE)
_EXAMPLE = re.compile(r"\bfor example\b|\be\.g\.", re.IGNORECASE)


def _h5(entry, run, rows):
    """One question per term, the first of its reasons in this order: not
    finished, an example, the name repeated, too short."""
    s = entry["sentences"]
    minimum = int(entry.get("minimumWords", 5))
    out, seen = [], set()
    for r in rows:
        iri, definition = _cell(r["iri"]), _cell(r["definition"]) or ""
        if iri in seen:
            continue
        name = _named(run, r)
        label = _cell(r.get("label"))
        words = re.findall(r"\w+", definition)
        found = _UNFINISHED.search(definition) or None
        sentence = None
        if found:
            sentence = s["unfinished"].format(name=name, word=found.group(0))
        elif (found := _EXAMPLE.search(definition)):
            sentence = s["example"].format(name=name, word=found.group(0))
        elif label and re.search(r"(?<!\w)" + re.escape(label.casefold()) + r"(?!\w)", definition.casefold()):
            sentence = s["repeats"].format(name=name, label=label)
        elif len(words) < minimum:
            count = len(words)
            sentence = s["short"].format(name=name, count="one" if count == 1 else count_word(count), words="word" if count == 1 else "words")
        if sentence is None:
            continue
        seen.add(iri)
        out.append(_finding(iri, sentence, entry.get("block")))
    return out


_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9]{1,5}\b")


def _spelled_out(acronym: str, texts: list[str], small: frozenset) -> bool:
    """Whether some text holds words whose first letters spell the acronym,
    small words (of, and, the) left out: *International Space Station*."""
    letters = acronym.casefold()
    if not letters.isalpha():
        letters = "".join(ch for ch in letters if ch.isalpha())
    for text in texts:
        words = [w for w in re.findall(r"[A-Za-z]+", text) if w.casefold() not in small]
        initials = "".join(w[0].casefold() for w in words)
        if letters and letters in initials:
            return True
    return False


def _h6(entry, run, rows):
    t = entry["sentences"]["row"]
    small = _word_list(entry, "smallWords")
    texts: dict = {}
    labels: dict = {}
    for r in rows:
        iri = _cell(r["iri"])
        labels.setdefault(iri, set()).add(_cell(r["label"]))
        if r.get("text"):
            texts.setdefault(iri, []).append(_cell(r["text"]))
    out = []
    for iri in sorted(labels):
        said = set()
        for label in sorted(labels[iri]):
            # The other labels count as said too: "ISS" beside "International
            # Space Station".
            others = [x for x in labels[iri] if x != label] + texts.get(iri, [])
            for acronym in _ACRONYM.findall(label):
                if acronym in said or _spelled_out(acronym, others, small):
                    continue
                said.add(acronym)
                out.append(_finding(iri, t.format(acronym=acronym, name=run.name(iri)), entry.get("block")))
    return out


def _singular(name: str) -> str:
    if name.endswith("ies"):
        return name[:-3] + "y"
    if name.endswith(("sses", "xes", "ches", "shes", "zes")):
        return name[:-2]
    return name[:-1]


def _h7(entry, run, rows):
    t = entry["sentences"]["row"]
    singular_words = _word_list(entry, "singularWords")
    out = []
    for r in rows:
        iri, local = _cell(r["iri"]), _cell(r["name"])
        words = _words(local)
        if not words or words[-1].casefold() in singular_words:
            continue
        out.append(_finding(iri, t.format(name=run.name(iri), singular=_singular(local))))
    return out


def _h8(entry, run, rows):
    t = entry["sentences"]["row"]
    roles = _word_list(entry, "roleWords")
    out, seen = [], set()
    for r in rows:
        iri = _cell(r["iri"])
        if iri in seen:
            continue
        words = set(_plain_words(local_name(iri))) | set(_plain_words(run.name(iri)))
        # A plural is the same role: Employees.
        words |= {w[:-1] for w in words if w.endswith("s")}
        if not words & roles:
            continue
        seen.add(iri)
        parent = run.name(_cell(r["parent"]))
        out.append(_finding(iri, t.format(name=run.name(iri), parent=parent, a_parent=with_article(parent))))
    return out


def _h9(entry, run, rows):
    """Siblings whose properties (those with the class in their domain, read
    through axioms.domain_of) and rules (axioms.contents) are the same and
    not none: one question per such set, under its parent."""
    t = entry["sentences"]["row"]
    graph = run.graph
    by_class: dict = {}
    for prop, reading in run.domains().items():
        for cls in reading.classes:
            by_class.setdefault(cls, set()).add(("property", prop))
    signatures: dict = {}

    def signature(cls: URIRef) -> frozenset:
        if cls not in signatures:
            rules = {("rule", c.kind, c.property, c.filler, c.n) for _, _, c in axioms.contents(graph, cls)}
            signatures[cls] = frozenset(by_class.get(cls, set()) | rules)
        return signatures[cls]

    groups: dict = {}
    for r in rows:
        parent = _cell(r["parent"])
        for key in ("iri", "other"):
            cls = URIRef(_cell(r[key]))
            sig = signature(cls)
            if sig:
                groups.setdefault((parent, sig), set()).add(str(cls))
    out = []
    for (parent, _), members in sorted(groups.items(), key=lambda kv: (kv[0][0], sorted(kv[1]))):
        if len(members) < 2:
            continue
        ordered = sorted(members)
        out.append(_finding(ordered[0], t.format(names=_joined([run.name(m) for m in ordered]), parent=run.name(parent))))
    return out


_NUMBER_TYPES = frozenset(
    XSD[n] for n in ("decimal", "double", "float", "integer", "int", "long", "short", "nonNegativeInteger", "positiveInteger")
)


def _h10(entry, run) -> list[dict]:
    """An own attribute named for a quantity that holds numbers (by its
    range, or a value) and says no unit: in its name, its definition, or an
    annotation whose property says unit. The name is asked first, so values
    are read only for the few attributes it leaves: the query's scan of
    every value of every attribute was a tenth of the 3 s budget."""
    t = entry["sentences"]["row"]
    quantities = _word_list(entry, "quantityWords")
    units = _word_list(entry, "unitWords")
    graph = run.graph
    out = []
    for prop in sorted((p for p in graph.subjects(RDF.type, OWL.DatatypeProperty) if is_own(p, run.rule)), key=str):
        named = set(_plain_words(local_name(prop))) | set(_plain_words(run.name(prop)))
        if not named & quantities:
            continue
        numeric = any(r in _NUMBER_TYPES for r in graph.objects(prop, RDFS.range)) or any(
            isinstance(o, Literal) and o.datatype in _NUMBER_TYPES for o in graph.objects(None, prop)
        )
        if not numeric or any("unit" in str(p).casefold() for p in graph.predicates(prop, None)):
            continue
        said = set(named)
        for p in DEFINING:
            for o in graph.objects(prop, p):
                said |= set(_plain_words(str(o)))
        if said & units:
            continue
        out.append(_finding(str(prop), t.format(name=run.name(prop))))
    return out


_TEXT_PROPERTIES = (OWL.DatatypeProperty, OWL.AnnotationProperty, RDF.Property)


def _h11(entry, run) -> list[dict]:
    """A text value that is, word for word, another own individual's name:
    one question per property, from its first such value. Computed here in
    one scan, never by the query's join of every value with every label."""
    t = entry["sentences"]["row"]
    graph = run.graph
    names: dict = {}
    for p in LABELLING:
        for s, o in graph.subject_objects(p):
            if isinstance(o, Literal) and is_own(s, run.rule) and not is_term(graph, s) and any(True for _ in graph.objects(s, RDF.type)):
                names.setdefault(str(o).casefold(), set()).add(s)
    if not names:
        return []
    properties = sorted({p for kind in _TEXT_PROPERTIES for p in graph.subjects(RDF.type, kind) if is_own(p, run.rule)}, key=str)
    out = []
    for prop in properties:
        hits = sorted(
            (str(s), str(o), str(ind)) for s, o in graph.subject_objects(prop)
            if isinstance(o, Literal) for ind in names.get(str(o).casefold(), ()) if ind != s
        )
        if not hits:
            continue
        subject, value, individual = hits[0]
        out.append(_finding(str(prop), t.format(
            property=run.name(prop), subject=run.name(subject), value=value, individual=run.name(individual),
        )))
    return out


SHAPERS: dict[str, Callable] = {
    "DC-01": _dc01, "DC-02": _dc02, "DC-03": _dc03, "DC-04": _dc04, "DC-05": _dc05, "DC-06": _dc06,
    "DC-07": _dc07, "DC-08": _dc08, "DC-09": _dc09, "DC-11": _variant("how"), "DC-12": _dc12,
    "DC-14": _dc14, "DC-15": _dc15, "DC-16": _variant("what"), "DC-17": _dc17, "DC-18": _dc18,
    "DC-19": _dc19_20, "DC-20": _dc19_20, "DC-21": _dc21, "DC-22": _default, "DC-24": _dc24,
    "DC-25": _variant("what"), "DC-26": _dc26, "DC-27": _dc27, "DC-28": _dc28, "DC-29": _dc29,
    "H1": _h1, "H2": _h2, "H4": _default, "H5": _h5, "H6": _h6, "H7": _h7, "H8": _h8, "H9": _h9,
    "H12": _default,
}
# The checks whose findings are not one per row: their total is the
# findings', counted from the rows read (at most MAX_ROWS of them).
_REREAD = {
    "DC-05", "DC-08", "DC-12", "DC-15", "DC-17", "DC-18", "DC-26", "DC-27", "DC-28", "DC-29",
    "H1", "H2", "H5", "H6", "H7", "H8", "H9",
}


def _dc13_computed(entry, run):
    return _dc13(entry, run, run.depths)


# DC-30's words for the links a statement most often makes; any other
# property is said by its name (*drives has range Pump*).
_LINK_WORDS = {
    RDFS.subClassOf: "is a kind of",
    SKOS.broader: "is narrower than",
    SKOS.narrower: "is broader than",
    RDF.type: "is typed as",
}

def _file_name(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def _dc30(entry, run) -> list[dict]:
    """An own address a statement uses as its property or its value that no
    project file, import or switched-on snapshot says anything about
    (links-between-files 5.7 item 1): one finding per statement, naming its
    file, opening its subject there. One scan of each file, every address
    judged once."""
    if not run.files:
        return []
    graphs = [g for _, _, g in run.files] + list(run.outside)
    judged: dict = {}

    def missing(term) -> bool:
        if not isinstance(term, URIRef):
            return False
        if term not in judged:
            judged[term] = is_own(term, run.rule) and not any((term, None, None) in g for g in graphs)
        return judged[term]

    sentences = entry["sentences"]
    out = []
    for doc, file, graph in run.files:
        found = []
        for s, p, o in graph:
            for term, as_property in ((p, True), (o, False)):
                if not missing(term):
                    continue
                # A statement about a blank node is named by the term it
                # belongs to (a restriction's class, a property shape's
                # shape), the delete dialog's rule.
                owner = axioms.named_owner(graph, s)
                subject = run.name(owner) if owner is not None else "A statement"
                values = {"file": _file_name(file), "subject": subject, "target": run.name(term)}
                if as_property:
                    sentence = sentences["property"].format(**values)
                else:
                    link = _LINK_WORDS.get(p) or f"has {run.name(p)}"
                    sentence = sentences["row"].format(link=link, **values)
                found.append((str(owner) if owner is not None else "", sentence, owner))
        for _, sentence, owner in sorted(found, key=lambda row: (row[0], row[1])):
            finding = _finding(owner, sentence)
            finding["doc"], finding["file"] = doc, file
            out.append(finding)
    return out


def _dc31(entry, run) -> list[dict]:
    """An own term typed in two or more project files (links-between-files
    5.7 item 2), the files named in the manifest's order; its opener goes to
    the first."""
    if not run.files:
        return []
    typed: dict = {}
    for doc, file, graph in run.files:
        for subject in set(graph.subjects(RDF.type, None)):
            if isinstance(subject, URIRef) and is_own(subject, run.rule):
                typed.setdefault(subject, []).append((doc, file))
    template = entry["sentences"]["row"]
    out = []
    for term in sorted((t for t, where in typed.items() if len(where) > 1), key=str):
        where = typed[term]
        finding = _finding(term, template.format(
            name=run.name(term), files=_joined([_file_name(file) for _, file in where]),
        ))
        finding["doc"], finding["file"] = where[0]
        finding["files"] = [file for _, file in where]
        out.append(finding)
    return out


# The checks computed in Python alone, their query never run by the report:
# it is what *Open as a query* shows. DC-13 counts the longest path, which a
# query cannot; H3 reads the reasoning result, which no query sees; H10 asks
# a name before it reads a value, and H11's query joins every value with
# every label: in Python each is one short scan, within Section 10's budget.
# DC-30 and DC-31 ask which file holds a statement, which the merged graph
# the queries run on cannot say (links-between-files 5.7 item 3).
_COMPUTED: dict[str, Callable] = {
    "DC-13": _dc13_computed, "H3": _h3, "H10": _h10, "H11": _h11, "DC-30": _dc30, "DC-31": _dc31,
}


def _worst(levels) -> str:
    return min(levels, key=LEVELS.index)


# --- review aids (5.8, Stage B) ------------------------------------------------------
#
# What a person reads and judges, beside the findings: the hierarchy read
# aloud with a tick per link, every definition with the four questions (the
# questions are the page's words), and a project's saved queries as its
# competency questions, each run.

READ_ALOUD_MAX = 1000
DEFINITIONS_SHOWN = 100
# A tick names its link: the narrower term, the link's kind and the broader
# one. An IRI never holds "|" (RFC 3987 leaves it out), so the key splits back.
_LINK_KINDS = {"subClassOf": RDFS.subClassOf, "broader": SKOS.broader}
QUESTION_SERVICE = "Not run here: it asks another service, and these checks run on this computer."
QUESTION_TIMEOUT = "This question did not finish in 30 seconds."


def link_key(child, kind: str, parent) -> str:
    return f"{child}|{kind}|{parent}"


def hierarchy_links(graph: Graph, rule: OwnRule) -> list[tuple]:
    """Every own subClassOf and broader link between named terms, as (child,
    kind, parent), a narrower written the other way round read as its
    broader; the parent may be borrowed (Every Customer is a Person). In
    IRI order, so the list reads the same at every run."""
    found = set()
    for child, parent in graph.subject_objects(RDFS.subClassOf):
        if isinstance(child, URIRef) and isinstance(parent, URIRef) and child != parent and is_own(child, rule):
            found.add((child, "subClassOf", parent))
    for child, parent in graph.subject_objects(SKOS.broader):
        if isinstance(child, URIRef) and isinstance(parent, URIRef) and child != parent and is_own(child, rule):
            found.add((child, "broader", parent))
    for parent, child in graph.subject_objects(SKOS.narrower):
        if isinstance(child, URIRef) and isinstance(parent, URIRef) and child != parent and is_own(child, rule):
            found.add((child, "broader", parent))
    return sorted(found, key=lambda t: (str(t[0]), t[1], str(t[2])))


def _link_sentence(run: Run, child, kind: str, parent) -> str:
    if kind == "subClassOf":
        return f"Every {run.name(child)} is {with_article(run.name(parent))}."
    return f"{run.name(child)} comes under {run.name(parent)}."


def read_aloud(run: Run, agreed: Optional[list]) -> dict:
    """Each link as a sentence, with whether the person ticked it; the count
    is of the links the model holds now, a tick for a link since removed
    counting for nothing. `editable` is a project's: only its manifest keeps
    ticks."""
    links = hierarchy_links(run.graph, run.rule)
    ticked = set(agreed or ())
    items = [
        {"key": link_key(c, k, p), "iri": str(c), "sentence": _link_sentence(run, c, k, p),
         "agreed": link_key(c, k, p) in ticked}
        for c, k, p in links[:READ_ALOUD_MAX]
    ]
    return {
        "links": items,
        "total": len(links),
        "agreed": sum(1 for c, k, p in links if link_key(c, k, p) in ticked),
        "editable": agreed is not None,
    }


def definitions(run: Run) -> dict:
    """Every own term's definition, its English one first, for the four
    questions a definition is tested by (5.8)."""
    graph = run.graph
    found = []
    terms = {s for t in TERM_TYPES for s in graph.subjects(RDF.type, t) if is_own(s, run.rule)}
    for term in sorted(terms, key=str):
        texts = [o for p in DEFINING for o in graph.objects(term, p) if isinstance(o, Literal)]
        if not texts:
            continue
        text = next((o for o in texts if _english(o)), texts[0])
        found.append({"iri": str(term), "name": run.name(term), "text": str(text)})
    return {"items": found[:DEFINITIONS_SHOWN], "total": len(found)}


def competency_questions(graph: Graph, saved: list, key: str, timeout: float, reading=None) -> list[dict]:
    """A project's saved queries, each run on the document as its question
    (5.8): the true row count, counted past one row kept. Every one passes
    prepare_select inside execute_select, with the row cap and the timeout;
    one asking another service is not run, as the report promises to run on
    this computer alone and a SERVICE call would send the model's text out."""
    out = []
    for entry in saved:
        item = {"id": entry.get("id"), "name": entry.get("name") or "Untitled query"}
        text = entry.get("sparql") or ""
        try:
            if sparql_exec.asks_a_service(text):
                item["error"] = QUESTION_SERVICE
            else:
                result = sparql_exec.execute_select(
                    graph, text, max_rows=1, timeout=timeout, key=key, reading=reading, count_all=True,
                )
                item["total"] = result["total"]
        except sparql_exec.QueryTimeout:
            item["error"] = QUESTION_TIMEOUT
        except (sparql_exec.QueryError, sparql_exec.QueryBusy) as exc:
            item["error"] = f"This question could not run: {exc}"
        out.append(item)
    return out


# --- measures (5.7) ------------------------------------------------------------------


def _english(literal) -> bool:
    return isinstance(literal, Literal) and (not literal.language or literal.language.lower().split("-")[0] == "en")


def measures(graph: Graph, rule: OwnRule) -> dict:
    """Counts by kind, hierarchy, documentation, reuse and the level, from
    the document's own terms; the caller holds the read lock."""
    def own_of(*types) -> set:
        found = set()
        for t in types:
            found.update(s for s in graph.subjects(RDF.type, t) if is_own(s, rule))
        return found

    classes = own_of(*CLASS_TYPES)
    properties = own_of(*PROPERTY_TYPES)
    concepts = own_of(SKOS.Concept)
    individuals = set()
    for cls in classes:
        for s in graph.subjects(RDF.type, cls):
            if is_own(s, rule) and not set(graph.objects(s, RDF.type)) & _NOT_INDIVIDUAL:
                individuals.add(s)
    terms = classes | properties | concepts

    # Hierarchy: own links between own nodes, the longest path from a top.
    nodes = classes | concepts
    parents: dict = {n: set() for n in nodes}
    for n in nodes:
        for p in graph.objects(n, RDFS.subClassOf):
            if p in nodes and p != n:
                parents[n].add(p)
        for p in graph.objects(n, SKOS.broader):
            if p in nodes and p != n:
                parents[n].add(p)
        for c in graph.subjects(SKOS.narrower, n):
            if c in nodes and c != n:
                parents[c].add(n)
    children: dict = {n: 0 for n in nodes}
    for n, ps in parents.items():
        for p in ps:
            children[p] += 1
    depth_of: dict = {}

    def depth(node, trail=()) -> int:
        if node in depth_of:
            return depth_of[node]
        if node in trail:
            return 0  # a loop is cut; DC-12 says it
        above = [depth(p, trail + (node,)) for p in parents[node]]
        value = (max(above) + 1) if above else 0
        depth_of[node] = value
        return value

    # Iteratively from the tops down would avoid recursion; the depth of a
    # real hierarchy is small, and the trail cuts a loop.
    for n in sorted(nodes):
        depth(n)
    deepest = max(depth_of.values(), default=-1) + 1 if nodes else 0
    tops = sorted(n for n in nodes if not parents[n])

    documented = sum(
        1 for t in terms
        if any(_english(o) for p in LABELLING for o in graph.objects(t, p))
        and any(True for p in DEFINING for _ in graph.objects(t, p))
    )

    used = set()
    for s, p, o in graph:
        used.add(p)
        if p == RDF.type and isinstance(o, URIRef):
            used.add(o)
    used = {u for u in used if isinstance(u, URIRef) and not str(u).startswith(_LANGUAGE_NAMESPACES)}
    reused = {u for u in used if not is_own(u, rule)}
    namespaces = {_namespace_of(str(u)) for u in reused}

    related = any(True for _ in graph.subject_objects(SKOS.related)) or any(
        True for t in terms for _ in graph.objects(t, SKOS.altLabel)
    )
    met = [
        bool(terms),
        bool(terms) and documented * 2 >= len(terms) if terms else False,
        any(parents[n] for n in nodes),
        related,
        bool(classes) and bool(properties),
        bool(individuals),
    ]
    reached = 0
    for ok in met:
        if not ok:
            break
        reached += 1
    level = {
        "step": reached,
        "of": len(STEPS),
        "name": STEPS[reached - 1][0] if reached else "Not started",
        "next": STEPS[reached][1] if reached < len(STEPS) else None,
    }
    return {
        "counts": {
            "classes": len(classes), "properties": len(properties),
            "concepts": len(concepts), "individuals": len(individuals),
        },
        "hierarchy": {
            "depth": deepest,
            "widest": max(children.values(), default=0),
            "tops": len(tops),
        },
        "documentation": {"documented": documented, "terms": len(terms)},
        "reuse": {"namespaces": len(namespaces), "reused": len(reused), "used": len(used)},
        "level": level,
        "depths": depth_of,
    }


def _dc13(entry: dict, run: Run, depths: dict) -> list[dict]:
    t = entry["sentences"]["row"]
    deep = sorted(((d, str(n)) for n, d in depths.items() if d > 4), key=lambda x: (-x[0], x[1]))
    return [_finding(iri, t.format(name=run.name(iri), depth=d)) for d, iri in deep]


# --- the run -----------------------------------------------------------------------


def _generation(ontology) -> int:
    provider = getattr(ontology, "snapshots", None)
    if provider is None:
        return 0
    try:
        return int(provider()[0])
    except Exception:
        return 0


def run(
    ontology,
    *,
    project: Optional[dict] = None,
    doc: str = "model",
    namespace: Optional[str] = None,
    timeout: Optional[float] = None,
    inferred: Optional[list] = None,
    questions: Optional[list] = None,
    whole: Optional[dict] = None,
) -> dict:
    """Every check on one document, in the manifest's order; the caller is a
    worker thread (run_in_threadpool), never the event loop. `inferred` is
    the project's current reasoning result's conclusions, (individual,
    class) IRIs, for H2 and H3; None when there is none. `questions` is a
    project's saved queries, run as its competency questions (5.8).

    `whole` is a project's files read together (multi-file-projects 5.3
    item 6): {graph, revision}, the graph every ontology and vocabulary file
    or every shapes file, the revision the sum of theirs. The cap of 5.10
    counts it whole. Reading it holds the asked file's lock, which every
    change to any of the files takes too."""
    started = time.perf_counter()
    graph = whole["graph"] if whole is not None else ontology.ensure_loaded()
    revision = whole["revision"] if whole is not None else ontology.revision
    generation = _generation(ontology)
    # 5.10 (D-125): too large to check. No query runs; the report names the
    # count and the cap, and still lists every check that would be listed, so
    # each can be opened as a query. The measures scan the whole graph too, so
    # they are left out: this answer touches no statement.
    size = len(graph)
    if size > CHECKS_MAX_STATEMENTS:
        groups = [
            {"id": e["id"], "level": e["level"], "heading": e["heading"], "fix": e["fix"],
             "total": 0, "findings": []}
            for e in manifest()
            if not (doc == "shapes" and e["id"] not in SHAPES_CHECKS)
            and not (e["id"] == "DC-26" and namespace is None)
        ]
        notes = [LOCAL_NOTE] + ([SHAPES_NOTE] if doc == "shapes" else [])
        return {
            "revision": revision,
            "generation": generation,
            "ran_ms": round((time.perf_counter() - started) * 1000),
            "empty": False,
            "emptySentence": None,
            "overCap": {"statements": size, "cap": CHECKS_MAX_STATEMENTS},
            "measures": None,
            "aids": None,
            "groups": groups,
            "skipped": [],
            "notes": notes,
            "namespace": namespace,
        }
    rule = own_rule(graph, project)
    token = _rule.set(rule)
    try:
        with ontology.reading():
            measured = measures(graph, rule)
            has_imports = any(True for _ in graph.objects(None, OWL.imports))
            shapes_named = any(True for s in graph.subjects(RDF.type, SH_NODE_SHAPE) if is_own(s, rule))
        depths = measured.pop("depths")
        run_ctx = Run(
            graph, rule, namespace, project, {}, depths=depths, inferred=inferred,
            files=whole.get("files") if whole is not None else None,
            outside=whole.get("outside", []) if whole is not None else [],
        )
        empty = not (measured["documentation"]["terms"] or shapes_named)
        groups: list[dict] = []
        skipped: list[str] = []
        for entry in manifest():
            cid = entry["id"]
            if doc == "shapes" and cid not in SHAPES_CHECKS:
                skipped.append(cid)
                continue
            if cid == "DC-26" and namespace is None:
                # 5.5.2: only with a namespace set; not listed without one.
                continue
            group = {
                "id": cid, "level": entry["level"], "heading": entry["heading"], "fix": entry["fix"],
                "total": 0, "findings": [],
            }
            if cid == "H3" and inferred is None:
                # Nothing to read: no current reasoning result, said in the
                # group so a passing tick is never mistaken for one.
                group["note"] = entry["sentences"]["noRun" if project is not None else "noProject"]
            try:
                if cid in _COMPUTED:
                    with ontology.reading():
                        findings = _COMPUTED[cid](entry, run_ctx)
                    total = len(findings)
                else:
                    result = sparql_exec.execute_select(
                        graph, entry["query"], max_rows=MAX_ROWS,
                        timeout=timeout if timeout is not None else TIMEOUT_SECONDS,
                        key=f"checks:{ontology.id}", reading=ontology.reading, count_all=True,
                        reuse_prepared=True,
                    )
                    with ontology.reading():
                        findings = SHAPERS.get(cid, _default)(entry, run_ctx, _rows(result))
                    total = len(findings) if cid in _REREAD else result["total"]
                    if cid == "DC-08":
                        total = len(findings)
            except sparql_exec.QueryTimeout:
                group["error"] = TIMED_OUT
                groups.append(group)
                continue
            except (sparql_exec.QueryError, sparql_exec.QueryBusy) as exc:
                group["error"] = f"This check could not run: {exc}"
                groups.append(group)
                continue
            # A group's level is the worst of its findings' (DC-24 in a
            # pattern project, DC-27's example addresses); a hint stays one.
            if findings:
                group["level"] = _worst({f.get("level", entry["level"]) for f in findings})
            group["total"] = total
            group["findings"] = findings[:SHOWN]
            groups.append(group)
        # The review aids (5.8), for a model: a shapes document has no
        # hierarchy to read aloud and no questions of its own.
        aids = None
        if doc == "model":
            with ontology.reading():
                aids = {
                    "readAloud": read_aloud(run_ctx, (project or {}).get("readAloud", []) if project is not None else None),
                    "definitions": definitions(run_ctx),
                }
            aids["questions"] = (
                competency_questions(
                    graph, questions, f"checks:{ontology.id}", timeout if timeout is not None else TIMEOUT_SECONDS,
                    reading=ontology.reading,
                )
                if questions is not None else None
            )
    finally:
        _rule.reset(token)
    notes = [LOCAL_NOTE]
    if has_imports:
        notes.append(IMPORTS_NOTE)
    if doc == "shapes":
        notes.append(SHAPES_NOTE)
    # The model changed while the checks ran: the answer says which revision
    # it began on, and the page calls it stale at once.
    return {
        "revision": revision,
        "generation": generation,
        "ran_ms": round((time.perf_counter() - started) * 1000),
        "empty": empty,
        "emptySentence": EMPTY if empty else None,
        "measures": measured,
        "groups": groups,
        "skipped": skipped,
        "notes": notes,
        "namespace": namespace,
        "aids": aids,
    }
