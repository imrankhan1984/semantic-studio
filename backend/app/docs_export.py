"""
================================================================================
FILE: backend/app/docs_export.py
================================================================================

SUMMARY
    Turns a loaded ontology into a self-contained documentation website and
    packs it into a zip the user drops into a repository and points GitHub
    Pages at. The zip carries an HTML page (prose + a term index), a live
    embedded graph viewer, the complete SCHEMA graph, the exact original source
    bytes AND a canonical Turtle reserialization, a short README, and the two
    files GitHub Pages needs that nobody remembers (.nojekyll and relative paths
    only). Backlog DOC-1, reworked to v0.5 after an external review.

BASIC IDEA
    The page is generated here rather than by pyLODE (D-037): pyLODE's rdflib<7
    cap conflicts with this project's rdflib>=7.1, so its look and feel is
    reproduced instead, under our own licence and with no new dependency.
    Generating the HTML ourselves also makes the one security property that
    matters here provable rather than trusted: every piece of ontology-derived
    text is escaped with html.escape before it enters the document, and the
    graph data is written by a JSON serializer, never concatenated into markup.
    See AC-9.

    THREE properties of the artefact are load-bearing after the rework:

    1. Instance data is excluded by default (D-038). Named individuals and the
       two edge kinds that are pure A-box — instanceOf and assertion — are left
       out of both the term index and the embedded graph unless the caller opts
       in with include_individuals=True. The published page is a statement about
       the MODEL, not the DATA; the data is read-only and lives at its source
       (D-029). Excluding by default makes that boundary true, not merely stated.

    2. The original source bytes are preserved (D-041). source/original.<ext>
       carries the EXACT bytes the user loaded; exports/ontology.ttl carries the
       canonical Turtle reserialization. A reserialization silently discards the
       comments, prefixes and syntax an RDF/XML or JSON-LD author wrote, so it is
       not the source and is not offered as if it were.

    3. Every part of the export has its own refuse limit (D-040): source bytes,
       graph JSON, node count, generated HTML, total zip, and rendered term
       count. Each raises a typed DocsExportError the router maps to HTTP 400
       with the limit named. Nothing is ever truncated silently — a reader of a
       published page has no Show more and no way to know what is missing.

    Profile detection mirrors pyLODE's two profiles: a SKOS concept scheme is
    documented concept-first (VocPub), an OWL ontology class-first (OntPub), and
    one containing both is documented class-first with a note.

INPUTS / INPUT SOURCES
    - A store.Ontology (its parsed graph, its complete viz dict, its name,
      format, original bytes at data_path and pretty-printed Turtle).
    - The static viewer assets in docs_assets/ (graph.js, styles.css).

EXPECTED OUTPUT
    - build_zip(ontology, include_individuals=False) -> bytes of a .zip.
    - Raises a DocsExportError subclass when any part is over its limit; the
      router maps each to HTTP 400 with the offending size / count named.
    - abox_counts(viz) -> (individuals, assertions) for the confirmation UI.
================================================================================
"""

from __future__ import annotations

# hashlib   - stable per-term anchor ids derived from the IRI.
# html      - escape() is the security control for every ontology-derived string.
# io / zipfile - assemble the site in memory and return bytes; nothing touches disk.
# json      - serialize the graph data (never string-concatenate it into markup).
# os        - read the two graph ceilings from the environment (D-039/D-040).
# re        - slug a local name into a valid HTML id / URL fragment.
import hashlib
import html
import io
import json
import os
import re
import zipfile
from pathlib import Path
from typing import Optional

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS

from .graph_builder import (
    KIND_ANNOTATION_PROPERTY,
    KIND_CLASS,
    KIND_COLLECTION,
    KIND_CONCEPT,
    KIND_DATATYPE_PROPERTY,
    KIND_INDIVIDUAL,
    KIND_OBJECT_PROPERTY,
    KIND_PROPERTY,
    KIND_SCHEME,
    _local_name,
    pick_label,
    prefixed,
)

# The static viewer assets sit beside this module and are copied verbatim into
# every zip. Read once at build time, not per request or per ontology.
_ASSET_DIR = Path(__file__).parent / "docs_assets"


def _env_int(name: str, default: int) -> int:
    """A positive integer from the environment, or the default.

    Being wrong about a ceiling then costs a configuration change rather than a
    release — the same reasoning that made the application's node budget an
    environment variable. A non-numeric or non-positive value falls back rather
    than crashing an import.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
        return value if value > 0 else default
    except ValueError:
        return default


# --- refuse limits (D-040). Each part of the export is bounded independently ---
#
# Module constants, not environment variables (unlike the two graph ceilings
# below), because they are ceilings on what is safe to publish rather than knobs
# a deployer tunes; tests monkeypatch them to exercise the refusal branches with
# a realistically small fixture.
MAX_GRAPH_JSON_BYTES = 5 * 1024 * 1024   # the embedded graph JSON
MAX_SOURCE_BYTES = 10 * 1024 * 1024      # the original source file
MAX_HTML_BYTES = 10 * 1024 * 1024        # the generated index.html
MAX_ZIP_BYTES = 20 * 1024 * 1024         # the whole zip (the response-size cap)
MAX_TERMS = 10_000                       # documented terms in the index

# The embed ceiling: above this many nodes the graph is refused rather than
# embedded, so the refusal names an entity count ("40,000 entities") a reader can
# act on rather than only a byte size (D-039/D-040). An environment variable so a
# large-graph deployer can raise it without a release.
GRAPH_MAX_NODES = _env_int("SEMANTIC_STUDIO_GRAPH_MAX_NODES", 5000)

# The interactive-layout ceiling: at or below this many nodes the viewer runs its
# O(n^2) force simulation; above it the viewer draws a static deterministic
# layout instead, so a large graph cannot freeze the reader's tab (D-039). Read
# into the graph data so the browser-side viewer honours it without a server call.
GRAPH_INTERACTIVE_MAX_NODES = _env_int("SEMANTIC_STUDIO_GRAPH_INTERACTIVE_MAX_NODES", 800)

# rdflib parser name -> the extension source/original.<ext> should carry, so the
# preserved bytes announce their real format (AC-18). An unknown format falls
# back to a neutral extension rather than mislabelling the bytes.
_FORMAT_EXTENSIONS = {
    "turtle": "ttl",
    "n3": "n3",
    "xml": "rdf",
    "json-ld": "jsonld",
    "nt": "nt",
    "ntriples": "nt",
    "trig": "trig",
    "nquads": "nq",
}


def _source_extension(fmt: str) -> str:
    """The file extension for the preserved original bytes of format ``fmt``."""
    return _FORMAT_EXTENSIONS.get(fmt, "txt")


# The two edge kinds that are pure A-box: instanceOf is an individual's rdf:type
# to a class, assertion is an object-property fact between individuals. Both are
# dropped from the embedded graph unless the caller opts in (D-038).
_ABOX_EDGE_KINDS = {"instanceOf", "assertion"}

# The schema kinds that get their own documented section. KIND_INDIVIDUAL is NOT
# here by default — it is added only under the opt-in (see _documentable_kinds).
# "other" and "ontology" never get a section: "other" is an entity we could not
# classify, and the ontology itself is the page's header rather than one term.
_SCHEMA_KINDS = {
    KIND_CLASS,
    KIND_OBJECT_PROPERTY,
    KIND_DATATYPE_PROPERTY,
    KIND_ANNOTATION_PROPERTY,
    KIND_PROPERTY,
    KIND_SCHEME,
    KIND_CONCEPT,
    KIND_COLLECTION,
}


def _documentable_kinds(include_individuals: bool) -> set[str]:
    """The kinds that get a documented section, given the opt-in state.

    The schema always; named individuals only when the caller opted in. This is
    the term-index half of D-038 — the graph half is in build_graph_data.
    """
    if include_individuals:
        return _SCHEMA_KINDS | {KIND_INDIVIDUAL}
    return set(_SCHEMA_KINDS)


# Section heading per kind. Order here is the OntPub (OWL-first) reading order;
# VocPub reorders SKOS ahead of it (see _section_order).
_SECTION_TITLES = [
    (KIND_CLASS, "Classes"),
    (KIND_OBJECT_PROPERTY, "Object Properties"),
    (KIND_DATATYPE_PROPERTY, "Datatype Properties"),
    (KIND_ANNOTATION_PROPERTY, "Annotation Properties"),
    (KIND_PROPERTY, "Properties"),
    (KIND_SCHEME, "Concept Schemes"),
    (KIND_CONCEPT, "Concepts"),
    (KIND_COLLECTION, "Collections"),
    (KIND_INDIVIDUAL, "Named Individuals"),
]

_SKOS_KINDS = {KIND_SCHEME, KIND_CONCEPT, KIND_COLLECTION}

# Human labels for the per-term kind badge.
_KIND_BADGE = {
    KIND_CLASS: "Class",
    KIND_OBJECT_PROPERTY: "Object property",
    KIND_DATATYPE_PROPERTY: "Datatype property",
    KIND_ANNOTATION_PROPERTY: "Annotation property",
    KIND_PROPERTY: "Property",
    KIND_SCHEME: "Concept scheme",
    KIND_CONCEPT: "Concept",
    KIND_COLLECTION: "Collection",
    KIND_INDIVIDUAL: "Named individual",
}

# Edge kind -> (human label, swatch colour). The colour is a fixed constant, not
# ontology-derived, so writing it into an inline style attribute is safe. graph.js
# colours each edge by the same map; this list is the accessible TEXT key beside
# the canvas, so the legend reads without relying on colour (AC-17/AC-24).
_EDGE_KIND_LEGEND = {
    "subClassOf": ("Sub-class of", "#4f9cf9"),
    "subPropertyOf": ("Sub-property of", "#6366f1"),
    "domain": ("Domain", "#37b98a"),
    "range": ("Range", "#0ea5e9"),
    "equivalentClass": ("Equivalent class", "#8b5cf6"),
    "equivalentProperty": ("Equivalent property", "#8b5cf6"),
    "disjointWith": ("Disjoint with", "#ef4444"),
    "inverseOf": ("Inverse of", "#f59e42"),
    "sameAs": ("Same as", "#14b8a6"),
    "broader": ("Broader", "#a78bfa"),
    "related": ("Related", "#f472b6"),
    "inScheme": ("In scheme", "#94a3b8"),
    "member": ("Member", "#eab308"),
    "seeAlso": ("See also", "#64748b"),
    "instanceOf": ("Instance of", "#cbd5e1"),
    "assertion": ("Assertion", "#f6c453"),
}
_EDGE_KIND_FALLBACK = ("#8892a0",)

# Predicates searched, in order, for a term's human description.
_DESCRIPTION_PREDICATES = [RDFS.comment, SKOS.definition, DCTERMS.description, DC.description]

# OWL constructs the exporter summarizes or omits. Their mere presence triggers
# the "simplified documentation" statement (AC-21); their absence keeps it away,
# so a plain vocabulary shows no warning about axioms it does not have.
_OMITTED_CONSTRUCT_TYPES = [
    OWL.Restriction,
    OWL.FunctionalProperty,
    OWL.InverseFunctionalProperty,
    OWL.TransitiveProperty,
    OWL.SymmetricProperty,
    OWL.AllDisjointClasses,
    OWL.AllDisjointProperties,
]
_OMITTED_CONSTRUCT_PREDICATES = [
    OWL.disjointWith,
    OWL.unionOf,
    OWL.intersectionOf,
    OWL.propertyChainAxiom,
    OWL.hasKey,
]

_MIXED_NOTE = (
    "This ontology contains both OWL and SKOS constructs. It is documented "
    "OWL-first; its SKOS concepts are listed rather than expanded."
)

_ABOX_EXCLUDED_NOTE = "Instance data (individuals) is not included in this documentation."

_SIMPLIFIED_NOTE = (
    "This is simplified documentation. Some OWL constructs (for example "
    "restrictions, property characteristics and disjointness axioms) are "
    "summarized or omitted; the source ontology in source/ is authoritative."
)

_INDEX_EQUIVALENT_NOTE = (
    "The term index below lists every documented term and is the accessible, "
    "complete equivalent of this graph."
)


class DocsExportError(Exception):
    """Base class for a refusal the router turns into an HTTP 400."""


class OversizeGraphError(DocsExportError):
    """The graph JSON is past its guard, so export is refused.

    Carries the actual size so the message can name it (AC-5/AC-20): a refusal
    that says "too large" without a number tells the user nothing.
    """

    def __init__(self, size_bytes: int) -> None:
        self.size_bytes = size_bytes
        mb = size_bytes / (1024 * 1024)
        super().__init__(
            f"This ontology's graph is {mb:.1f} MB, too large to embed in a "
            "documentation page. Ontologies this size are usually already "
            "published with their own documentation."
        )


class OversizeNodeCountError(DocsExportError):
    """The embedded graph has more nodes than the embed ceiling (AC-19)."""

    def __init__(self, count: int) -> None:
        self.count = count
        super().__init__(
            f"This ontology's graph has {count:,} entities, more than the "
            f"{GRAPH_MAX_NODES:,} an embedded documentation graph can show. "
            "Ontologies this size are usually already published with their own "
            "documentation."
        )


class OversizeSourceError(DocsExportError):
    """The original source file is past its byte limit (AC-20)."""

    def __init__(self, size_bytes: int) -> None:
        self.size_bytes = size_bytes
        mb = size_bytes / (1024 * 1024)
        limit_mb = MAX_SOURCE_BYTES / (1024 * 1024)
        super().__init__(
            f"This ontology's source file is {mb:.1f} MB, over the "
            f"{limit_mb:.0f} MB documentation limit."
        )


class OversizeHtmlError(DocsExportError):
    """The generated HTML is past its byte limit (AC-20)."""

    def __init__(self, size_bytes: int) -> None:
        self.size_bytes = size_bytes
        mb = size_bytes / (1024 * 1024)
        limit_mb = MAX_HTML_BYTES / (1024 * 1024)
        super().__init__(
            f"The generated documentation page is {mb:.1f} MB, over the "
            f"{limit_mb:.0f} MB limit."
        )


class OversizeZipError(DocsExportError):
    """The assembled zip is past its byte limit (AC-20)."""

    def __init__(self, size_bytes: int) -> None:
        self.size_bytes = size_bytes
        mb = size_bytes / (1024 * 1024)
        limit_mb = MAX_ZIP_BYTES / (1024 * 1024)
        super().__init__(
            f"The documentation zip is {mb:.1f} MB, over the "
            f"{limit_mb:.0f} MB limit."
        )


class TermCountError(DocsExportError):
    """The term index would list more terms than the cap allows (AC-20)."""

    def __init__(self, count: int) -> None:
        self.count = count
        super().__init__(
            f"This ontology has {count:,} documentable terms, more than the "
            f"{MAX_TERMS:,} a documentation page can list."
        )


def esc(text: str) -> str:
    """Escape a string for safe insertion into HTML text or an attribute.

    This is the security control of the whole module. Ontology labels, comments
    and IRIs are attacker-influenced text, and here they are written into an
    HTML file the user then publishes under their own name — a path React's
    escaping never touches. quote=True so it is safe inside attributes too.
    """
    return html.escape(text, quote=True)


def make_anchor(iri: str) -> str:
    """A stable, unique, readable HTML id / URL fragment for a term's section.

    Readable from the local name so a hash link is not opaque, disambiguated by
    a short digest of the full IRI so two terms with the same local name in
    different namespaces do not collide. Deterministic, so the graph viewer can
    scroll to the same anchor the section carries.
    """
    slug = re.sub(r"[^A-Za-z0-9_-]", "-", _local_name(iri)).strip("-") or "term"
    digest = hashlib.sha1(iri.encode("utf-8")).hexdigest()[:8]
    return f"term-{slug}-{digest}"


def confirmation_host(source: str) -> Optional[str]:
    """The host a fetch-source confirmation should name, or None for an upload.

    Encodes AC-14's rule in one tested place: an uploaded ontology is the user's
    own file, so this returns None; a URL-sourced one probably has a publisher
    who already documents it, so the interface confirms first, naming the host
    this returns. The frontend mirrors this rule; keeping the canonical
    definition here makes it testable without a browser.
    """
    if source == "upload":
        return None
    from urllib.parse import urlparse

    host = (urlparse(source).hostname or "").lower()
    return host or None


def abox_counts(viz: dict) -> tuple[int, int]:
    """(individuals, assertion edges) in ``viz`` — what the opt-in would add.

    The confirmation states these before anything is generated (AC-16), so the
    user knows the opt-in publishes data, not only the model. Individuals are
    nodes whose best kind is "individual"; assertions are object-property facts
    between them (the "assertion" edge kind). instanceOf edges are excluded too
    but not counted separately — the two headline numbers are what the user asked
    to add.
    """
    individuals = sum(1 for n in viz["nodes"] if n["kind"] == KIND_INDIVIDUAL)
    assertions = sum(1 for e in viz["edges"] if e["kind"] == "assertion")
    return individuals, assertions


def detect_profile(graph: Graph) -> str:
    """"vocpub", "ontpub" or "mixed", mirroring pyLODE's two profiles.

    A concept scheme with at least one concept is a SKOS vocabulary; OWL classes
    or properties make it an OWL ontology; an ontology with both is "mixed" and
    documented OWL-first with a note. Detection is on the source graph, not on a
    guess, so the choice is explainable.
    """
    has_scheme = any(True for _ in graph.subjects(RDF.type, SKOS.ConceptScheme))
    has_concept = any(True for _ in graph.subjects(RDF.type, SKOS.Concept))
    skos = has_scheme and has_concept

    owl = (
        any(True for _ in graph.subjects(RDF.type, OWL.Class))
        or any(True for _ in graph.subjects(RDF.type, RDFS.Class))
        or any(True for _ in graph.subjects(RDF.type, OWL.ObjectProperty))
        or any(True for _ in graph.subjects(RDF.type, OWL.DatatypeProperty))
    )

    if skos and owl:
        return "mixed"
    if skos:
        return "vocpub"
    return "ontpub"


def has_omitted_constructs(graph: Graph) -> bool:
    """Whether the source graph carries OWL constructs the exporter does not render.

    Restrictions, property characteristics, disjointness, unions / intersections,
    property chains and keys are summarized or omitted; if any are present the
    page states it is simplified documentation (AC-21). Derived from the graph,
    never hard-coded, so a plain vocabulary shows no warning about axioms it does
    not have.
    """
    for construct in _OMITTED_CONSTRUCT_TYPES:
        if (None, RDF.type, construct) in graph:
            return True
    for predicate in _OMITTED_CONSTRUCT_PREDICATES:
        if (None, predicate, None) in graph:
            return True
    return False


def unresolved_imports(graph: Graph) -> list[str]:
    """The IRIs of owl:imports this file does not itself describe.

    An import is "resolved" only if the graph already carries statements about
    the imported ontology. This application does not follow imports (backlog
    X-5), so an import to a file that was never fetched is unresolved, and the
    published page must say so: a reader cannot otherwise know part of the
    vocabulary is missing.
    """
    out: set[str] = set()
    for _s, obj in graph.subject_objects(OWL.imports):
        if isinstance(obj, URIRef):
            described = any(True for _ in graph.predicate_objects(obj))
            if not described:
                out.add(str(obj))
    return sorted(out)


def _first_literal(graph: Graph, subj, predicates) -> Optional[str]:
    """First English/untagged literal among ``predicates``, else any literal."""
    fallback: Optional[str] = None
    for predicate in predicates:
        for value in graph.objects(subj, predicate):
            if isinstance(value, Literal):
                if value.language in (None, "en"):
                    return str(value)
                if fallback is None:
                    fallback = str(value)
    return fallback


def _collect_terms(graph: Graph, viz: dict, include_individuals: bool) -> dict[str, list[dict]]:
    """Documentable viz nodes grouped by kind and sorted by label.

    Only entities described in *this* graph are documented: a node is kept only
    if it is the subject of at least one triple. That excludes a foreign
    superclass or range that appears in the viz merely because it was referenced.
    Named individuals are documented only under the opt-in (D-038); by default
    their kind is not in _documentable_kinds and they get no section.
    """
    kinds = _documentable_kinds(include_individuals)
    subjects = {str(s) for s in graph.subjects() if isinstance(s, URIRef)}
    groups: dict[str, list[dict]] = {}
    for node in viz["nodes"]:
        if node["kind"] in kinds and node["id"] in subjects:
            groups.setdefault(node["kind"], []).append(node)
    for kind in groups:
        groups[kind].sort(key=lambda n: (n["label"].lower(), n["id"]))
    return groups


def _section_order(profile: str) -> list[tuple[str, str]]:
    """Section (kind, title) list, SKOS-first for a VocPub vocabulary."""
    if profile == "vocpub":
        skos = [(k, t) for k, t in _SECTION_TITLES if k in _SKOS_KINDS]
        rest = [(k, t) for k, t in _SECTION_TITLES if k not in _SKOS_KINDS]
        return skos + rest
    return list(_SECTION_TITLES)


def _term_value(graph: Graph, obj, anchors: dict[str, str]) -> str:
    """Render one object of a fact as escaped HTML.

    A term this ontology documents becomes an in-page link to its section; a
    foreign term becomes its prefixed form as plain text, with the full IRI in a
    title (never an outgoing href, so the page stays self-contained and no
    absolute URL enters an href — AC-3/AC-6). A blank node — an OWL restriction,
    typically — renders inline as a readable axiom without an anchor.
    """
    if isinstance(obj, URIRef):
        key = str(obj)
        label = pick_label(graph, obj)
        anchor = anchors.get(key)
        if anchor:
            return f'<a href="#{esc(anchor)}">{esc(label)}</a>'
        return f'<span class="iri" title="{esc(key)}">{esc(prefixed(graph, obj))}</span>'
    if isinstance(obj, Literal):
        return esc(str(obj))
    if isinstance(obj, BNode):
        parts = []
        for pred, val in graph.predicate_objects(obj):
            if isinstance(val, BNode):
                shown = "…"
            elif isinstance(val, URIRef):
                shown = prefixed(graph, val)
            else:
                shown = str(val)
            parts.append(f"{prefixed(graph, pred)} {shown}")
        return esc("[" + "; ".join(sorted(parts)) + "]")
    return esc(str(obj))


def _fact_row(graph: Graph, label: str, objects: list, anchors: dict[str, str]) -> str:
    """A <tr> for one fact whose value is a list of objects, or "" if empty."""
    if not objects:
        return ""
    items = "".join(f"<li>{_term_value(graph, o, anchors)}</li>" for o in objects)
    return f"<tr><th>{esc(label)}</th><td><ul>{items}</ul></td></tr>"


def _named_objects(graph: Graph, subj: URIRef, predicate) -> list:
    """Objects of (subj, predicate, *), URIRefs and blank nodes, deduped by id."""
    seen: set[str] = set()
    out: list = []
    for obj in graph.objects(subj, predicate):
        key = str(obj)
        if key in seen:
            continue
        seen.add(key)
        out.append(obj)
    return out


def _subjects_of(graph: Graph, predicate, obj: URIRef) -> list:
    """Subjects of (*, predicate, obj) — the inverse direction, URIRefs only."""
    seen: set[str] = set()
    out: list = []
    for subj in graph.subjects(predicate, obj):
        if isinstance(subj, URIRef) and str(subj) not in seen:
            seen.add(str(subj))
            out.append(subj)
    return out


def _render_term(graph: Graph, node: dict, anchors: dict[str, str]) -> str:
    """One documented term as a bordered card with a fact table."""
    ref = URIRef(node["id"])
    kind = node["kind"]
    anchor = anchors[node["id"]]
    badge = _KIND_BADGE.get(kind, "Term")

    head = (
        f'<div class="term-head">'
        f"<h3>{esc(node['label'])}</h3>"
        f'<span class="term-kind">{esc(badge)}</span>'
        f"</div>"
    )
    desc_text = _first_literal(graph, ref, _DESCRIPTION_PREDICATES)
    desc = f'<p class="term-desc">{esc(desc_text)}</p>' if desc_text else ""

    rows = [f'<tr><th>IRI</th><td><span class="iri">{esc(node["id"])}</span></td></tr>']

    # Facts vary by kind, mirroring pyLODE's per-term tables.
    if kind == KIND_CLASS:
        rows.append(_fact_row(graph, "Sub-class of", _named_objects(graph, ref, RDFS.subClassOf), anchors))
        rows.append(_fact_row(graph, "Super-class of", _subjects_of(graph, RDFS.subClassOf, ref), anchors))
        rows.append(_fact_row(graph, "Equivalent to", _named_objects(graph, ref, OWL.equivalentClass), anchors))
    elif kind in (KIND_OBJECT_PROPERTY, KIND_DATATYPE_PROPERTY, KIND_ANNOTATION_PROPERTY, KIND_PROPERTY):
        rows.append(_fact_row(graph, "Domain", _named_objects(graph, ref, RDFS.domain), anchors))
        rows.append(_fact_row(graph, "Range", _named_objects(graph, ref, RDFS.range), anchors))
        rows.append(_fact_row(graph, "Sub-property of", _named_objects(graph, ref, RDFS.subPropertyOf), anchors))
        rows.append(_fact_row(graph, "Inverse of", _named_objects(graph, ref, OWL.inverseOf), anchors))
    elif kind == KIND_CONCEPT:
        rows.append(_fact_row(graph, "Broader", _named_objects(graph, ref, SKOS.broader), anchors))
        # Narrower is skos:narrower plus the inverse of any broader pointing here.
        narrower = _named_objects(graph, ref, SKOS.narrower) + _subjects_of(graph, SKOS.broader, ref)
        rows.append(_fact_row(graph, "Narrower", narrower, anchors))
        rows.append(_fact_row(graph, "Related", _named_objects(graph, ref, SKOS.related), anchors))
        rows.append(_fact_row(graph, "In scheme", _named_objects(graph, ref, SKOS.inScheme), anchors))
    elif kind == KIND_SCHEME:
        rows.append(_fact_row(graph, "Top concepts", _named_objects(graph, ref, SKOS.hasTopConcept), anchors))
    elif kind == KIND_INDIVIDUAL:
        types = [t for t in _named_objects(graph, ref, RDF.type) if t != OWL.NamedIndividual]
        rows.append(_fact_row(graph, "Type", types, anchors))

    rows.append(_fact_row(graph, "See also", _named_objects(graph, ref, RDFS.seeAlso), anchors))

    table = f'<table class="facts">{"".join(r for r in rows if r)}</table>'
    return f'<section class="term" id="{esc(anchor)}">{head}{desc}{table}</section>'


def _render_ontology_header(graph: Graph, name: str, profile: str) -> tuple[str, str]:
    """The page title and the metadata table, from the owl:Ontology (or scheme).

    Returns (title, header_html). Title falls back to the display name when the
    ontology declares no label.
    """
    subj = None
    for candidate in graph.subjects(RDF.type, OWL.Ontology):
        subj = candidate
        break
    if subj is None and profile == "vocpub":
        for candidate in graph.subjects(RDF.type, SKOS.ConceptScheme):
            subj = candidate
            break

    title = name
    rows = []
    if subj is not None:
        if isinstance(subj, URIRef):
            label = pick_label(graph, subj)
            if label:
                title = label
            rows.append(f'<tr><th>IRI</th><td><span class="iri">{esc(str(subj))}</span></td></tr>')
        for th, preds in (
            ("Description", _DESCRIPTION_PREDICATES),
            ("Version", [OWL.versionInfo]),
            ("Creator", [DCTERMS.creator, DC.creator]),
            ("Created", [DCTERMS.created, DC.date]),
            ("Modified", [DCTERMS.modified]),
        ):
            value = _first_literal(graph, subj, preds)
            if value is None:
                # creator etc. may be a URIRef rather than a literal
                for pred in preds:
                    for obj in graph.objects(subj, pred):
                        if isinstance(obj, URIRef):
                            value = prefixed(graph, obj)
                            break
                    if value:
                        break
            if value:
                rows.append(f"<tr><th>{esc(th)}</th><td>{esc(value)}</td></tr>")

    header = f'<table class="metadata">{"".join(rows)}</table>' if rows else ""
    return title, header


def _render_legend(graph_data: dict) -> str:
    """A text legend mapping each edge kind PRESENT to a label and a swatch.

    Only kinds that actually appear are shown, so the key matches the picture
    (AC-17). The label is the accessible part — a reader who cannot tell the
    colours apart still reads the relationship name — which is why the legend is
    HTML text beside the canvas rather than colour drawn onto it (AC-24).
    """
    seen: set[str] = set()
    for edge in graph_data["edges"]:
        kind = edge.get("kind") or ""
        if kind:
            seen.add(kind)
    if not seen:
        return ""
    # Stable, readable order: the legend map's order, then anything unmapped.
    ordered = [k for k in _EDGE_KIND_LEGEND if k in seen]
    ordered += sorted(k for k in seen if k not in _EDGE_KIND_LEGEND)
    items = []
    for kind in ordered:
        label, colour = _EDGE_KIND_LEGEND.get(kind, (kind, _EDGE_KIND_FALLBACK[0]))
        items.append(
            f'<li><span class="legend-swatch" style="background:{esc(colour)}" '
            f'aria-hidden="true"></span>{esc(label)}</li>'
        )
    return (
        '<ul class="graph-legend" aria-label="Relationship types in the graph">'
        f'{"".join(items)}</ul>'
    )


def _inline_graph_json(graph_data: dict) -> str:
    """Serialize the graph data for a safe inline <script> block.

    json.dumps does the serialization (AC-9: never string-concatenated). The <,
    > and & are then escaped to \\uXXXX — still valid JSON — so a hostile label
    containing "</script>" cannot break out of the inline data block.
    """
    raw = json.dumps(graph_data, ensure_ascii=False)
    return raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def build_graph_data(viz: dict, anchors: dict[str, str], include_individuals: bool = False) -> dict:
    """The graph for the embedded viewer, with A-box excluded by default (D-038).

    Individual nodes and the instanceOf / assertion edges that connect them are
    dropped unless the caller opts in — the reader of a published page has no
    Show more, so an accidentally-embedded instance graph publishes data the user
    was only exploring with. Every emitted edge keeps its `kind` and `label`
    (graph edges keep their meaning), which the built exporter dropped, so a
    reader can tell a subClassOf from a domain from an assertion. Each node
    carries the anchor of its documented section, or null when it has none.

    `interactiveMaxNodes` rides along so the browser-side viewer knows the
    force-simulation ceiling without a server call (D-039).
    """
    if include_individuals:
        excluded_ids: set[str] = set()
    else:
        excluded_ids = {n["id"] for n in viz["nodes"] if n["kind"] == KIND_INDIVIDUAL}

    edges = []
    for e in viz["edges"]:
        if not include_individuals:
            if e["kind"] in _ABOX_EDGE_KINDS:
                continue
            # An individual could, in principle, be an endpoint of a structural
            # edge; drop any edge touching an excluded node so a removed node is
            # never referenced by a surviving edge.
            if e["source"] in excluded_ids or e["target"] in excluded_ids:
                continue
        edges.append(
            {
                "source": e["source"],
                "target": e["target"],
                "kind": e["kind"],
                "label": e["label"],
            }
        )

    # Degree is recomputed over the kept edges, not carried from the full graph,
    # so a class that had many now-excluded individuals is not drawn oversized and
    # the label-priority pass picks the right nodes.
    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    nodes = [
        {
            "id": n["id"],
            "label": n["label"],
            "kind": n["kind"],
            "degree": degree.get(n["id"], 0),
            "anchor": anchors.get(n["id"]),
        }
        for n in viz["nodes"]
        if n["id"] not in excluded_ids
    ]
    return {
        "nodes": nodes,
        "edges": edges,
        "interactiveMaxNodes": GRAPH_INTERACTIVE_MAX_NODES,
    }


def render_html(
    graph: Graph,
    name: str,
    viz: dict,
    profile: str,
    imports: list[str],
    graph_data: dict,
    include_individuals: bool = False,
) -> str:
    """Assemble the full index.html: header, notices, graph, and the term index.

    All paths are relative (assets/…), never root-absolute, because a GitHub
    Pages project site serves from a subpath and a leading "/" 404s for every
    reader while passing the author's local check (AC-6). The stylesheet and the
    viewer are the only two referenced files and both are same-directory assets.
    """
    groups = _collect_terms(graph, viz, include_individuals)
    anchors = {node["id"]: make_anchor(node["id"]) for nodes in groups.values() for node in nodes}
    # graph_data was built against these anchors by the caller.

    title, header = _render_ontology_header(graph, name, profile)

    notices = []
    if profile == "mixed":
        notices.append(f'<div class="notice">{esc(_MIXED_NOTE)}</div>')
    if has_omitted_constructs(graph):
        # AC-21: derived from the graph, so a plain vocabulary shows nothing.
        notices.append(f'<div class="notice">{esc(_SIMPLIFIED_NOTE)}</div>')
    if imports:
        items = "".join(f'<li><span class="iri">{esc(i)}</span></li>' for i in imports)
        notices.append(
            '<div class="notice">These <code>owl:imports</code> were not '
            "resolved and their terms are not documented here:"
            f"<ul>{items}</ul></div>"
        )
    notices_html = "".join(notices)

    # Table of contents + sections, in profile order, skipping empty kinds.
    toc_parts = []
    section_parts = []
    mixed_concept_kinds = _SKOS_KINDS if profile == "mixed" else set()
    for kind, heading in _section_order(profile):
        nodes = groups.get(kind)
        if not nodes:
            continue
        section_id = f"section-{kind}"
        toc_parts.append(f'<li><a href="#{section_id}">{esc(heading)}</a> ({len(nodes)})</li>')
        if kind in mixed_concept_kinds:
            # Mixed profile: list SKOS terms by name, not expanded, per AC-4.
            items = "".join(
                f'<li><a href="#{esc(anchors[n["id"]])}">{esc(n["label"])}</a></li>' for n in nodes
            )
            section_parts.append(
                f'<h2 id="{section_id}">{esc(heading)}</h2>'
                f'<ul class="concept-list">{items}</ul>'
            )
            # Still give them an anchor target so the graph link lands somewhere.
            for n in nodes:
                section_parts.append(
                    f'<section class="term" id="{esc(anchors[n["id"]])}">'
                    f'<div class="term-head"><h3>{esc(n["label"])}</h3></div>'
                    f'<table class="facts"><tr><th>IRI</th><td>'
                    f'<span class="iri">{esc(n["id"])}</span></td></tr></table></section>'
                )
        else:
            section_parts.append(f'<h2 id="{section_id}">{esc(heading)}</h2>')
            for n in nodes:
                section_parts.append(_render_term(graph, n, anchors))

    toc = f'<nav class="toc"><strong>Contents</strong><ul>{"".join(toc_parts)}</ul></nav>' if toc_parts else ""

    node_count = len(graph_data["nodes"])
    over_interactive = node_count > GRAPH_INTERACTIVE_MAX_NODES
    if over_interactive:
        # AC-19: above the interactive ceiling the caption tells the reader why
        # the graph is not settling — the viewer draws it statically instead.
        caption_lead = (
            f"The ontology schema: {node_count} entities. Large graph: "
            "interactive layout disabled — nodes are placed automatically. "
            "Drag to move, scroll to zoom, and click a node to jump to its "
            "definition."
        )
    else:
        caption_lead = (
            f"The ontology schema: {node_count} entities. Drag a node to move "
            "it, scroll to zoom, and click a node to jump to its definition."
        )
    caption = f"{caption_lead} {_INDEX_EQUIVALENT_NOTE}"

    legend = _render_legend(graph_data)
    abox_note = (
        f'<p class="graph-abox-note">{esc(_ABOX_EXCLUDED_NOTE)}</p>'
        if not include_individuals
        else ""
    )
    graph_figure = (
        '<figure id="graph-figure">'
        '<div id="graph-canvas-wrap">'
        # role="img" + a label naming the counts: a reader who cannot use the
        # canvas is told what it shows and pointed at the index (AC-24).
        f'<canvas id="graph-canvas" role="img" '
        f'aria-label="Graph of {node_count} schema entities. {esc(_INDEX_EQUIVALENT_NOTE)}">'
        "</canvas>"
        "</div>"
        f'<figcaption class="graph-caption">{esc(caption)}</figcaption>'
        f"{legend}{abox_note}"
        "</figure>"
    )

    inline_data = _inline_graph_json(graph_data)

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{esc(title)}</title>\n"
        '<link rel="stylesheet" href="assets/styles.css">\n'
        "</head>\n<body>\n"
        '<div class="container">\n'
        f"<h1>{esc(title)}</h1>\n"
        '<p class="subtitle">Ontology documentation generated by Semantic Studio.</p>\n'
        f"{header}\n{notices_html}\n{graph_figure}\n{toc}\n"
        f'{"".join(section_parts)}\n'
        "<footer>Generated by Semantic Studio. "
        "The ontology source accompanies this page in <code>source/</code>, with "
        "a canonical Turtle form in <code>exports/ontology.ttl</code>.</footer>\n"
        "</div>\n"
        f'<script id="graph-data" type="application/json">{inline_data}</script>\n'
        '<script src="assets/graph.js"></script>\n'
        "</body>\n</html>\n"
    )


def render_readme(name: str, include_individuals: bool = False) -> str:
    """The README that tells a future reader what the zip is and what it holds.

    It states plainly whether instance data was included, so someone opening the
    zip six months later knows whether individuals were published (D-038), and it
    explains the two source files (D-041): the exact original and the canonical
    Turtle reserialization.
    """
    abox_line = (
        "This documentation **includes** named individuals and their assertions "
        "(instance data), because the export was generated with that option on."
        if include_individuals
        else "This documentation covers the **schema only**. Named individuals "
        "and their assertions (instance data) are not included."
    )
    return (
        f"# Documentation for {name}\n\n"
        f"This is a self-contained documentation website for the **{name}** "
        "ontology, generated by Semantic Studio.\n\n"
        f"{abox_line}\n\n"
        "## Source files\n\n"
        "- `source/original.<ext>` is the exact file you loaded, byte for byte.\n"
        "- `exports/ontology.ttl` is a canonical Turtle reserialization, which "
        "may differ from the original in formatting, prefixes and comments.\n\n"
        "## To publish it\n\n"
        "1. Put these files in a GitHub repository, keeping the folder layout.\n"
        "2. Turn on GitHub Pages for that repository (Settings -> Pages).\n\n"
        "Nothing else is needed. It also works offline: open `index.html` in a "
        "browser.\n"
    )


def build_zip(ontology, include_individuals: bool = False) -> bytes:
    """Generate the documentation site for ``ontology`` and return the zip bytes.

    Every part is measured against its own limit before the zip is returned, and
    a part over its limit refuses (a DocsExportError the router maps to HTTP 400
    with the size / count named) rather than being truncated (D-040). The refusal
    branches run before the zip is handed back, so no partial zip ever exists.
    """
    graph = ontology.ensure_loaded()
    viz = ontology.viz()
    profile = detect_profile(graph)
    imports = unresolved_imports(graph)

    # Anchors are the single source of truth shared by the sections and the
    # graph nodes, so a node click lands on the exact id its section carries.
    groups = _collect_terms(graph, viz, include_individuals)
    anchors = {node["id"]: make_anchor(node["id"]) for nodes in groups.values() for node in nodes}

    # Term-count guard (AC-20): the index would be unreadable and enormous past
    # this, and the count is actionable.
    term_total = sum(len(nodes) for nodes in groups.values())
    if term_total > MAX_TERMS:
        raise TermCountError(term_total)

    graph_data = build_graph_data(viz, anchors, include_individuals)

    # Node-count guard (AC-19), before the byte guard, so the refusal can name an
    # entity count a reader can act on rather than only a byte size.
    node_count = len(graph_data["nodes"])
    if node_count > GRAPH_MAX_NODES:
        raise OversizeNodeCountError(node_count)

    graph_json = json.dumps(graph_data, ensure_ascii=False)
    size = len(graph_json.encode("utf-8"))
    if size > MAX_GRAPH_JSON_BYTES:
        raise OversizeGraphError(size)

    # The exact original bytes are preserved (D-041/AC-18), guarded independently.
    source_bytes = ontology.data_path.read_bytes()
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise OversizeSourceError(len(source_bytes))
    source_ext = _source_extension(ontology.format)

    html_doc = render_html(graph, ontology.name, viz, profile, imports, graph_data, include_individuals)
    html_bytes = html_doc.encode("utf-8")
    if len(html_bytes) > MAX_HTML_BYTES:
        raise OversizeHtmlError(len(html_bytes))

    readme = render_readme(ontology.name, include_individuals)
    graph_js = (_ASSET_DIR / "graph.js").read_text(encoding="utf-8")
    styles = (_ASSET_DIR / "styles.css").read_text(encoding="utf-8")
    turtle = ontology.pretty_turtle()

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", html_doc)
        # .nojekyll is not optional: GitHub Pages runs Jekyll, which silently
        # skips any file or directory whose name starts with an underscore, so
        # without it a bundler-named asset can vanish with no error anywhere.
        zf.writestr(".nojekyll", "")
        # The exact original bytes, with an extension announcing their real
        # format, beside the canonical reserialization (D-041/AC-18).
        zf.writestr(f"source/original.{source_ext}", source_bytes)
        zf.writestr("exports/ontology.ttl", turtle)
        zf.writestr("README.md", readme)
        zf.writestr("assets/graph.js", graph_js)
        zf.writestr("assets/styles.css", styles)
        # The canonical data file (AC-1). The page reads the inline copy in
        # index.html rather than fetching this, because a file:// reader cannot
        # fetch and a published page must make no request; this file is here so
        # the data is available as data, not only embedded in markup.
        zf.writestr("assets/graph-data.json", graph_json)
    data = buffer.getvalue()

    # Total-zip guard (AC-20), the response-size cap: the last line of defence,
    # because the parts can each be under their limit and still sum past this.
    if len(data) > MAX_ZIP_BYTES:
        raise OversizeZipError(len(data))
    return data
