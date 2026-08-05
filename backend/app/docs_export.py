"""
================================================================================
FILE: backend/app/docs_export.py
================================================================================

SUMMARY
    Turns a loaded ontology into a self-contained documentation website and
    packs it into a zip the user drops into a repository and points GitHub
    Pages at. The zip carries an HTML page (prose + a term index), a live
    embedded graph viewer, the complete graph data, the source ontology, a
    short README, and the two files GitHub Pages needs that nobody remembers
    (.nojekyll and relative paths only). Backlog DOC-1.

BASIC IDEA
    The page is generated here rather than by pyLODE. pyLODE's rdflib<7 cap
    conflicts with this project's rdflib>=7.1, so it cannot be installed
    alongside the app; its look and feel is reproduced instead, under our own
    licence and with no new dependency. Generating the HTML ourselves also
    makes the one security property that matters here provable rather than
    trusted: every piece of ontology-derived text is escaped with the standard
    library's html.escape before it enters the document, and the graph data is
    written by a JSON serializer, never concatenated into markup. See AC-9.

    Profile detection mirrors pyLODE's two profiles: a SKOS concept scheme is
    documented concept-first (VocPub), an OWL ontology class-first (OntPub), and
    one containing both is documented class-first with a note that its concepts
    are listed rather than expanded — guessing wrong silently would be worse.

    The embedded graph is the WHOLE graph, never budgeted: silent truncation is
    tolerable in the application, where Show more exists, and a false claim in a
    published document, where the reader has no control. A graph whose JSON
    exceeds 5 MB refuses export rather than truncating, because an ontology that
    large is in practice one already published with its own documentation.

INPUTS / INPUT SOURCES
    - A store.Ontology (its parsed graph, its complete viz dict, its name and
      pretty-printed Turtle).
    - The static viewer assets in docs_assets/ (graph.js, styles.css).

EXPECTED OUTPUT
    - build_zip(ontology) -> bytes of a .zip containing the site.
    - Raises OversizeGraphError when the graph JSON exceeds the 5 MB guard; the
      router maps it to HTTP 400 with the size named.
================================================================================
"""

from __future__ import annotations

# hashlib   - stable per-term anchor ids derived from the IRI.
# html      - escape() is the security control for every ontology-derived string.
# io / zipfile - assemble the site in memory and return bytes; nothing touches disk.
# json      - serialize the graph data (never string-concatenate it into markup).
# re        - slug a local name into a valid HTML id / URL fragment.
import hashlib
import html
import io
import json
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

# The graph is embedded whole, but a graph JSON past this refuses rather than
# truncates. 5 MB is large enough for any in-house ontology (the demo is 9 KB)
# and small enough that the refusal only ever meets a vocabulary big enough to
# be published elsewhere already. Spec section 5 and AC-5.
MAX_GRAPH_JSON_BYTES = 5 * 1024 * 1024

# Kinds that get their own documented section. "other" and "ontology" do not:
# "other" is an entity we could not classify, and the ontology itself is the
# page's header rather than one term among many.
_DOCUMENTABLE_KINDS = {
    KIND_CLASS,
    KIND_OBJECT_PROPERTY,
    KIND_DATATYPE_PROPERTY,
    KIND_ANNOTATION_PROPERTY,
    KIND_PROPERTY,
    KIND_SCHEME,
    KIND_CONCEPT,
    KIND_COLLECTION,
    KIND_INDIVIDUAL,
}

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

# Predicates searched, in order, for a term's human description.
_DESCRIPTION_PREDICATES = [RDFS.comment, SKOS.definition, DCTERMS.description, DC.description]

_MIXED_NOTE = (
    "This ontology contains both OWL and SKOS constructs. It is documented "
    "OWL-first; its SKOS concepts are listed rather than expanded."
)


class DocsExportError(Exception):
    """Base class for a refusal the router turns into an HTTP error."""


class OversizeGraphError(DocsExportError):
    """The graph JSON is past the 5 MB guard, so export is refused (HTTP 400).

    Carries the actual size so the message can name it, which AC-5 requires:
    a refusal that says "too large" without a number tells the user nothing
    about whether raising anything could help (it cannot — this is a ceiling,
    not a configurable cap).
    """

    def __init__(self, size_bytes: int) -> None:
        self.size_bytes = size_bytes
        mb = size_bytes / (1024 * 1024)
        super().__init__(
            f"This ontology's graph is {mb:.1f} MB, too large to embed in a "
            "documentation page. Ontologies this size are usually already "
            "published with their own documentation."
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
    own file and exports without a confirmation, so this returns None; a
    URL-sourced one probably has a publisher who already documents it, so the
    interface confirms first, naming the host this returns. The frontend mirrors
    this rule (it holds the `source` from the ontology summary); keeping the
    canonical definition here makes it testable without a browser.
    """
    if source == "upload":
        return None
    from urllib.parse import urlparse

    host = (urlparse(source).hostname or "").lower()
    return host or None


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


def unresolved_imports(graph: Graph) -> list[str]:
    """The IRIs of owl:imports this file does not itself describe.

    An import is "resolved" only if the graph already carries statements about
    the imported ontology — which happens when it was fetched and inlined. This
    application does not follow imports (that is backlog X-5), so an import to a
    file that was never fetched is unresolved, and the published page must say
    so: a reader cannot otherwise know a third of the vocabulary is missing.
    """
    out: set[str] = set()
    for _s, obj in graph.subject_objects(OWL.imports):
        if isinstance(obj, URIRef):
            # predicate_objects(obj) yields nothing unless obj is a subject, i.e.
            # unless the imported ontology's own statements are present.
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


def _collect_terms(graph: Graph, viz: dict) -> dict[str, list[dict]]:
    """Documentable viz nodes grouped by kind and sorted by label.

    Only entities described in *this* graph are documented: a node is kept only
    if it is the subject of at least one triple. That excludes a foreign
    superclass or range that appears in the viz merely because it was referenced
    — it stays a node in the graph the reader can see, but it gets no section
    and no anchor here, because this ontology does not define it.
    """
    subjects = {str(s) for s in graph.subjects() if isinstance(s, URIRef)}
    groups: dict[str, list[dict]] = {}
    for node in viz["nodes"]:
        if node["kind"] in _DOCUMENTABLE_KINDS and node["id"] in subjects:
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
    foreign term becomes its prefixed form as plain text, with the full IRI in
    a title (never an outgoing href, so the page stays fully self-contained and
    no absolute URL enters an href — AC-3/AC-6). A blank node — an OWL
    restriction, typically — renders inline as a readable axiom without an
    anchor, because a blank node has no stable identity to link to.
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


def _inline_graph_json(graph_data: dict) -> str:
    """Serialize the graph data for a safe inline <script> block.

    json.dumps does the serialization (AC-9: never string-concatenated). The <,
    > and & are then escaped to \\uXXXX — still valid JSON — so a hostile label
    containing "</script>" cannot break out of the inline data block.
    """
    raw = json.dumps(graph_data, ensure_ascii=False)
    return raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def build_graph_data(viz: dict, anchors: dict[str, str]) -> dict:
    """The complete graph for the embedded viewer: every node and edge.

    Never budgeted — the reader of a published page has no Show more, so a
    truncated graph would be a false statement about the vocabulary. Each node
    carries the anchor of its documented section, or null when it has none (a
    referenced-but-not-defined term), so the viewer knows which clicks navigate.
    """
    nodes = [
        {
            "id": n["id"],
            "label": n["label"],
            "kind": n["kind"],
            "degree": n["degree"],
            "anchor": anchors.get(n["id"]),
        }
        for n in viz["nodes"]
    ]
    edges = [{"source": e["source"], "target": e["target"]} for e in viz["edges"]]
    return {"nodes": nodes, "edges": edges}


def render_html(
    graph: Graph,
    name: str,
    viz: dict,
    profile: str,
    imports: list[str],
    graph_data: dict,
) -> str:
    """Assemble the full index.html: header, notices, graph, and the term index.

    All paths are relative (assets/…), never root-absolute, because a GitHub
    Pages project site serves from a subpath and a leading "/" 404s for every
    reader while passing the author's local check (AC-6). The stylesheet and the
    viewer are the only two referenced files and both are same-directory assets.
    """
    groups = _collect_terms(graph, viz)
    anchors = {node["id"]: make_anchor(node["id"]) for nodes in groups.values() for node in nodes}
    # graph_data was built against these anchors by the caller.

    title, header = _render_ontology_header(graph, name, profile)

    notices = []
    if profile == "mixed":
        notices.append(f'<div class="notice">{esc(_MIXED_NOTE)}</div>')
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
    graph_figure = (
        '<figure id="graph-figure">'
        '<div id="graph-canvas-wrap"><canvas id="graph-canvas"></canvas></div>'
        f'<figcaption class="graph-caption">The whole ontology: {node_count} '
        "entities. Drag a node to move it, scroll to zoom, and click a node to "
        "jump to its definition.</figcaption>"
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
        "The ontology source accompanies this page as <code>ontology.ttl</code>.</footer>\n"
        "</div>\n"
        f'<script id="graph-data" type="application/json">{inline_data}</script>\n'
        '<script src="assets/graph.js"></script>\n'
        "</body>\n</html>\n"
    )


def render_readme(name: str) -> str:
    """The three-line README that tells a future reader what the zip is."""
    return (
        f"# Documentation for {name}\n\n"
        f"This is a self-contained documentation website for the **{name}** "
        "ontology, generated by Semantic Studio.\n\n"
        "To publish it:\n\n"
        "1. Put these files in a GitHub repository, keeping the folder layout.\n"
        "2. Turn on GitHub Pages for that repository (Settings -> Pages).\n\n"
        "Nothing else is needed. It also works offline: open `index.html` in a "
        "browser.\n"
    )


def build_zip(ontology) -> bytes:
    """Generate the documentation site for ``ontology`` and return the zip bytes.

    Raises OversizeGraphError before assembling anything if the graph JSON is
    over the guard, so the refusal costs nothing and no partial zip exists.
    """
    graph = ontology.ensure_loaded()
    viz = ontology.viz()
    profile = detect_profile(graph)
    imports = unresolved_imports(graph)

    # Anchors are the single source of truth shared by the sections and the
    # graph nodes, so a node click lands on the exact id its section carries.
    groups = _collect_terms(graph, viz)
    anchors = {node["id"]: make_anchor(node["id"]) for nodes in groups.values() for node in nodes}

    graph_data = build_graph_data(viz, anchors)

    # The guard is measured on the exact bytes that would be embedded, and it
    # refuses rather than truncates. Checked before any HTML is built.
    graph_json = json.dumps(graph_data, ensure_ascii=False)
    size = len(graph_json.encode("utf-8"))
    if size > MAX_GRAPH_JSON_BYTES:
        raise OversizeGraphError(size)

    html_doc = render_html(graph, ontology.name, viz, profile, imports, graph_data)
    readme = render_readme(ontology.name)
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
        zf.writestr("ontology.ttl", turtle)
        zf.writestr("README.md", readme)
        zf.writestr("assets/graph.js", graph_js)
        zf.writestr("assets/styles.css", styles)
        # The canonical data file (AC-1). The page reads the inline copy in
        # index.html rather than fetching this, because a file:// reader cannot
        # fetch and a published page must make no request; this file is here so
        # the data is available as data, not only embedded in markup.
        zf.writestr("assets/graph-data.json", graph_json)
    return buffer.getvalue()
