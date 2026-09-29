"""
================================================================================
FILE: backend/app/canvas.py
================================================================================

SUMMARY
    What the modeling canvas draws for a project document (visual-modeling
    5.4): its classes and concepts as boxes, each class's attributes, the
    subclass, relationship and broader links between them, the imported
    entities those links reach, and the relationships that cannot be drawn
    for want of a domain or a range. Also the size rule of 5.6: past
    CANVAS_MAX_BOXES, only the boxes the user chose and their direct links.

BASIC IDEA
    A pure function of the document's graph and, when imports are resolved,
    of the merged view, so it can be cached by revision and language like
    every other derived view (D-081) and tested without a server.

    A box is a class or a concept this document types. A link to something
    the document does not type -- foaf:Agent as a parent -- draws that thing
    too, dashed and named by the import it comes from, because a subclass
    line to nowhere tells the learner nothing. Such a box is read-only: the
    canvas links to it and never changes it.

    Lines sharing two boxes carry their place among them (`pair`, `pairs`),
    so several relationships between Person and Organization, or loops on one
    box, are drawn apart (relationships 5.4); a relationship whose domain is
    its range is a loop, not something to refuse.

    A relationship is drawn only with both ends: an arrow needs a start and a
    finish, and inventing one would draw something the model does not say.
    The rest are listed in `undrawn`, so the canvas can say how many and the
    form can show them. An end written as an expression (`owl:unionOf` ...)
    is not missing: it is listed as `expression`, never offered for a line
    to complete, because setting it would change what the property means.
    An attribute of a class outside the model is listed too, as `outside`,
    rather than vanishing (both found in review).

    The shown-set filter runs per request on the cached view, not inside it:
    choosing what to show changes the layout file, not the model, and must
    not rebuild the view.

INPUTS / INPUT SOURCES
    - The document graph and its label languages (display, primary).
    - The merged imports view and its importedFrom map, or None.

EXPECTED OUTPUT
    - build_canvas(...) -> {nodes, edges, undrawn, total}; each edge with
      `pair` and `pairs`.
    - restrict(view, shown) -> the same shape, cut to the shown set.
================================================================================
"""

from __future__ import annotations

from typing import Optional, Sequence

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

from .graph_builder import labeler, lang_matches, pick_label_in, prefixed

# Past this many classes and concepts the canvas draws only a chosen set
# (5.6). Measured in the browser pass: see the constant's test and known-state.
CANVAS_MAX_BOXES = 300

_CLASS_TYPES = (OWL.Class, RDFS.Class)


def _typed(graph: Graph, types) -> set[URIRef]:
    found: set[URIRef] = set()
    for t in types:
        found |= {s for s in graph.subjects(RDF.type, t) if isinstance(s, URIRef)}
    return found


def build_canvas(
    graph: Graph,
    langs: Optional[Sequence[str]],
    imported: Optional[Graph] = None,
    imported_from: Optional[dict] = None,
) -> dict:
    """Boxes, lines and the undrawn relationships of one document."""
    label = labeler(graph, langs)
    display, primary = (langs[0], langs[-1]) if langs else (None, None)
    imported_from = imported_from or {}
    # Imported boxes are named from the merged view, where their labels are.
    outside_label = labeler(imported, langs) if imported is not None else label

    classes = _typed(graph, _CLASS_TYPES)
    concepts = _typed(graph, (SKOS.Concept,)) - classes

    def fallback(node: URIRef) -> bool:
        if not display or display == primary:
            return False
        _, tag = pick_label_in(graph, node, langs)
        return bool(tag) and not lang_matches(tag, display)

    def ends(prop: URIRef) -> tuple:
        """(domain, range, written as an expression): the first named end of
        each, and whether either is an anonymous expression instead."""
        domains = list(graph.objects(prop, RDFS.domain))
        ranges = list(graph.objects(prop, RDFS.range))
        named = lambda values: next((v for v in values if isinstance(v, URIRef)), None)  # noqa: E731
        expression = any(not isinstance(v, URIRef) for v in domains + ranges)
        return named(domains), named(ranges), expression

    # Attributes: datatype properties, listed inside the box of their domain.
    attributes: dict[URIRef, list] = {}
    undrawn: list[dict] = []
    for prop in sorted(_typed(graph, (OWL.DatatypeProperty,))):
        domain, rng, expression = ends(prop)
        entry = {
            "iri": str(prop),
            "label": label(prop),
            "datatype": prefixed(graph, rng) if rng is not None else None,
        }
        if expression or domain is None:
            undrawn.append({
                "iri": str(prop), "label": entry["label"], "kind": "datatypeProperty",
                "missing": "expression" if expression else "domain",
                "domain": None, "range": str(rng) if rng is not None else None,
            })
        else:
            attributes.setdefault(domain, []).append(entry)

    edges: list[dict] = []
    outside: dict[URIRef, str] = {}  # an imported or undeclared box, and its kind

    def end(node, kind: str) -> bool:
        """Draw a line to `node`: a box of this document, or an outside one."""
        if not isinstance(node, URIRef):
            return False  # a restriction or other anonymous expression: V-7
        if node in classes or node in concepts:
            return True
        if str(node).startswith(str(XSD)) or node in (OWL.Thing, RDFS.Resource):
            return False
        outside.setdefault(node, kind)
        return True

    for child in sorted(classes):
        for parent in graph.objects(child, RDFS.subClassOf):
            if end(parent, "class"):
                edges.append({"kind": "subClassOf", "source": str(child), "target": str(parent)})

    broader_pairs = set()
    for concept in concepts:
        for b in graph.objects(concept, SKOS.broader):
            broader_pairs.add((concept, b))
        for n in graph.objects(concept, SKOS.narrower):
            if isinstance(n, URIRef):
                broader_pairs.add((n, concept))
    for narrow, broad in sorted(broader_pairs):
        if (narrow in concepts or end(narrow, "concept")) and end(broad, "concept"):
            edges.append({"kind": "broader", "source": str(narrow), "target": str(broad)})

    for prop in sorted(_typed(graph, (OWL.ObjectProperty,))):
        domain, rng, expression = ends(prop)
        missing = (
            "expression" if expression
            else "both" if domain is None and rng is None
            else "domain" if domain is None
            else "range" if rng is None
            else None
        )
        if missing:
            # The end it has, so drawing a line can offer to complete it
            # rather than bend it to a new meaning (5.4, Relating).
            undrawn.append({
                "iri": str(prop), "label": label(prop), "kind": "objectProperty", "missing": missing,
                "domain": str(domain) if domain is not None else None,
                "range": str(rng) if rng is not None else None,
            })
            continue
        if end(domain, "class") and end(rng, "class"):
            edges.append({
                "kind": "relationship",
                "source": str(domain),
                "target": str(rng),
                "property": str(prop),
                "label": label(prop),
            })

    _spread(edges)

    # An attribute is drawn in its class's box; a class outside the model is
    # drawn only when a line reaches it, and otherwise the attribute is
    # listed, not lost.
    for domain, entries in attributes.items():
        if domain in classes or domain in outside:
            continue
        for entry in entries:
            undrawn.append({
                "iri": entry["iri"], "label": entry["label"], "kind": "datatypeProperty",
                "missing": "outside", "domain": str(domain), "range": None,
            })

    nodes = [
        {
            "iri": str(iri),
            "kind": "class" if iri in classes else "concept",
            "label": label(iri),
            "fallback": fallback(iri),
            "attributes": attributes.get(iri, []),
        }
        for iri in sorted(classes | concepts)
    ]
    for iri, kind in sorted(outside.items()):
        nodes.append({
            "iri": str(iri),
            "kind": kind,
            "label": outside_label(iri),
            "fallback": False,
            # The import it comes from, or "outside" for a name no resolved
            # import defines: either way, not this document's to change.
            "imported": imported_from.get(str(iri), "outside"),
            "attributes": attributes.get(iri, []),
        })
    return {"nodes": nodes, "edges": edges, "undrawn": undrawn, "total": len(classes | concepts)}


def _spread(edges: list[dict]) -> None:
    """Number the lines that share two boxes (relationships 5.4).

    Each line gets `pair`, its place among the lines joining the same two
    boxes in either direction, and `pairs`, how many there are, so the
    frontend can curve them apart and keep their labels off each other. The
    places are counted in one order for both directions: *works for* and
    *employs* on the same two boxes are two places, not two first lines laid
    on top of each other. A line from a box to itself is counted with the
    other loops on that box.
    """
    groups: dict[tuple, list[dict]] = {}
    for edge in edges:
        key = tuple(sorted((edge["source"], edge["target"])))
        groups.setdefault(key, []).append(edge)
    for group in groups.values():
        for i, edge in enumerate(group):
            edge["pair"] = i
            edge["pairs"] = len(group)


def restrict(view: dict, shown: Optional[list]) -> dict:
    """The shown set and everything one link away (5.6), or the whole view
    when the model is small enough to draw at once."""
    limited = view["total"] > CANVAS_MAX_BOXES
    if not limited:
        return {**view, "limited": False}
    chosen = set(shown or [])
    keep = set(chosen)
    for edge in view["edges"]:
        if edge["source"] in chosen:
            keep.add(edge["target"])
        if edge["target"] in chosen:
            keep.add(edge["source"])
    return {
        **view,
        "nodes": [n for n in view["nodes"] if n["iri"] in keep],
        "edges": [e for e in view["edges"] if e["source"] in keep and e["target"] in keep],
        "limited": True,
    }
