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

    A relationship is drawn only with both ends: an arrow needs a start and a
    finish, and inventing one would draw something the model does not say.
    The rest are listed in `undrawn`, so the canvas can say how many and the
    form can show them.

    The shown-set filter runs per request on the cached view, not inside it:
    choosing what to show changes the layout file, not the model, and must
    not rebuild the view.

INPUTS / INPUT SOURCES
    - The document graph and its label languages (display, primary).
    - The merged imports view and its importedFrom map, or None.

EXPECTED OUTPUT
    - build_canvas(...) -> {nodes, edges, undrawn, total}
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

    # Attributes: datatype properties, listed inside the box of their domain.
    attributes: dict[URIRef, list] = {}
    undrawn: list[dict] = []
    for prop in sorted(_typed(graph, (OWL.DatatypeProperty,))):
        domain = next((d for d in graph.objects(prop, RDFS.domain) if isinstance(d, URIRef)), None)
        rng = next((r for r in graph.objects(prop, RDFS.range) if isinstance(r, URIRef)), None)
        entry = {
            "iri": str(prop),
            "label": label(prop),
            "datatype": prefixed(graph, rng) if rng is not None else None,
        }
        if domain is None:
            undrawn.append({
                "iri": str(prop), "label": entry["label"], "kind": "datatypeProperty", "missing": "domain",
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
        domain = next((d for d in graph.objects(prop, RDFS.domain) if isinstance(d, URIRef)), None)
        rng = next((r for r in graph.objects(prop, RDFS.range) if isinstance(r, URIRef)), None)
        missing = "both" if domain is None and rng is None else "domain" if domain is None else "range" if rng is None else None
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
            "attributes": [],
        })
    return {"nodes": nodes, "edges": edges, "undrawn": undrawn, "total": len(classes | concepts)}


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
