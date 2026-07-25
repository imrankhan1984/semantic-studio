"""Turn an rdflib.Graph into a visualization-friendly node/edge structure.

Nodes are the named entities of the ontology (classes, properties, SKOS
concepts, individuals). Edges are the structural relations between them
(subclass, domain/range, broader/narrower, assertions, ...). Blank nodes
are excluded from the visual graph but still appear in the detail view.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Optional

from rdflib import Graph, Literal, URIRef, BNode
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS, XSD

# --- node kinds -------------------------------------------------------------

KIND_CLASS = "class"
KIND_OBJECT_PROPERTY = "objectProperty"
KIND_DATATYPE_PROPERTY = "datatypeProperty"
KIND_ANNOTATION_PROPERTY = "annotationProperty"
KIND_PROPERTY = "property"  # plain rdf:Property
KIND_CONCEPT = "concept"
KIND_SCHEME = "conceptScheme"
KIND_COLLECTION = "collection"
KIND_INDIVIDUAL = "individual"
KIND_ONTOLOGY = "ontology"
KIND_OTHER = "other"

# Priority used when an entity has several types (lower index wins).
KIND_PRIORITY = [
    KIND_ONTOLOGY,
    KIND_CLASS,
    KIND_OBJECT_PROPERTY,
    KIND_DATATYPE_PROPERTY,
    KIND_ANNOTATION_PROPERTY,
    KIND_PROPERTY,
    KIND_SCHEME,
    KIND_COLLECTION,
    KIND_CONCEPT,
    KIND_INDIVIDUAL,
    KIND_OTHER,
]

TYPE_TO_KIND = {
    OWL.Ontology: KIND_ONTOLOGY,
    OWL.Class: KIND_CLASS,
    RDFS.Class: KIND_CLASS,
    RDFS.Datatype: KIND_CLASS,
    OWL.ObjectProperty: KIND_OBJECT_PROPERTY,
    OWL.DatatypeProperty: KIND_DATATYPE_PROPERTY,
    OWL.AnnotationProperty: KIND_ANNOTATION_PROPERTY,
    OWL.TransitiveProperty: KIND_OBJECT_PROPERTY,
    OWL.SymmetricProperty: KIND_OBJECT_PROPERTY,
    OWL.FunctionalProperty: KIND_PROPERTY,
    OWL.InverseFunctionalProperty: KIND_OBJECT_PROPERTY,
    RDF.Property: KIND_PROPERTY,
    SKOS.Concept: KIND_CONCEPT,
    SKOS.ConceptScheme: KIND_SCHEME,
    SKOS.Collection: KIND_COLLECTION,
    SKOS.OrderedCollection: KIND_COLLECTION,
    OWL.NamedIndividual: KIND_INDIVIDUAL,
}

LABEL_PREDICATES = [
    SKOS.prefLabel,
    RDFS.label,
    DCTERMS.title,
    DC.title,
]

# Structural predicates rendered as typed edges.
EDGE_PREDICATES = {
    RDFS.subClassOf: "subClassOf",
    RDFS.subPropertyOf: "subPropertyOf",
    RDFS.domain: "domain",
    RDFS.range: "range",
    OWL.equivalentClass: "equivalentClass",
    OWL.equivalentProperty: "equivalentProperty",
    OWL.disjointWith: "disjointWith",
    OWL.inverseOf: "inverseOf",
    OWL.sameAs: "sameAs",
    SKOS.broader: "broader",
    SKOS.related: "related",
    SKOS.inScheme: "inScheme",
    SKOS.topConceptOf: "inScheme",
    SKOS.member: "member",
    RDFS.seeAlso: "seeAlso",
}

# skos:narrower / skos:hasTopConcept are normalized to their inverse
INVERTED_EDGE_PREDICATES = {
    SKOS.narrower: "broader",
    SKOS.hasTopConcept: "inScheme",
}

XSD_NS = str(XSD)


def _best_kind(kinds: set[str]) -> str:
    for kind in KIND_PRIORITY:
        if kind in kinds:
            return kind
    return KIND_OTHER


def _local_name(iri: str) -> str:
    for sep in ("#", "/", ":"):
        if sep in iri:
            tail = iri.rstrip("#/").rsplit(sep, 1)[-1]
            if tail:
                return tail
    return iri


def pick_label(graph: Graph, node: URIRef) -> str:
    """Preferred human label: skos:prefLabel > rdfs:label > titles > local name."""
    fallback: Optional[str] = None
    for predicate in LABEL_PREDICATES:
        for value in graph.objects(node, predicate):
            if isinstance(value, Literal):
                if value.language in (None, "en") :
                    return str(value)
                if fallback is None:
                    fallback = str(value)
        if fallback is not None:
            return fallback
    return _local_name(str(node))


def prefixed(graph: Graph, iri: URIRef) -> str:
    try:
        qname = graph.namespace_manager.qname(iri)
        # rdflib can produce ugly generated prefixes like ns1:; keep them anyway
        return qname
    except Exception:
        return str(iri)


def build_viz_graph(graph: Graph) -> dict:
    """Extract nodes and edges for visualization from an rdflib graph."""
    kinds: dict[URIRef, set[str]] = defaultdict(set)
    edges: set[tuple[URIRef, str, URIRef, str]] = set()  # (src, kind, dst, label)

    # Pass 1: explicit typing
    object_properties: set[URIRef] = set()
    datatype_properties: set[URIRef] = set()
    for subject, obj in graph.subject_objects(RDF.type):
        if not isinstance(subject, URIRef) or not isinstance(obj, URIRef):
            continue
        kind = TYPE_TO_KIND.get(obj)
        if kind:
            kinds[subject].add(kind)
            if kind == KIND_OBJECT_PROPERTY:
                object_properties.add(subject)
            elif kind == KIND_DATATYPE_PROPERTY:
                datatype_properties.add(subject)

    # Pass 2: structural edges + implied kinds
    for s, p, o in graph:
        if not isinstance(s, URIRef):
            continue
        if p in EDGE_PREDICATES and isinstance(o, URIRef):
            if p == RDFS.range and str(o).startswith(XSD_NS):
                continue  # literal ranges are shown in the detail panel instead
            edges.add((s, EDGE_PREDICATES[p], o, ""))
            if p == RDFS.subClassOf:
                kinds[s].add(KIND_CLASS)
                kinds[o].add(KIND_CLASS)
            elif p == RDFS.subPropertyOf:
                kinds[s].add(KIND_PROPERTY)
                kinds[o].add(KIND_PROPERTY)
            elif p in (SKOS.broader, SKOS.related):
                kinds[s].add(KIND_CONCEPT)
                kinds[o].add(KIND_CONCEPT)
        elif p in INVERTED_EDGE_PREDICATES and isinstance(o, URIRef):
            edges.add((o, INVERTED_EDGE_PREDICATES[p], s, ""))
            if p == SKOS.narrower:
                kinds[s].add(KIND_CONCEPT)
                kinds[o].add(KIND_CONCEPT)

    # Pass 3: instance-of edges and object property assertions
    class_like = {n for n, ks in kinds.items() if KIND_CLASS in ks}
    for s, o in graph.subject_objects(RDF.type):
        if isinstance(s, URIRef) and isinstance(o, URIRef) and o in class_like:
            edges.add((s, "instanceOf", o, ""))
            if not kinds[s] & {KIND_CLASS, KIND_SCHEME, KIND_CONCEPT}:
                kinds[s].add(KIND_INDIVIDUAL)
    for prop in object_properties:
        prop_label = _local_name(str(prop))
        for s, o in graph.subject_objects(prop):
            if isinstance(s, URIRef) and isinstance(o, URIRef):
                edges.add((s, "assertion", o, prop_label))

    # Make sure every edge endpoint is a node
    for src, _, dst, _ in edges:
        kinds.setdefault(src, set()).add(KIND_OTHER)
        kinds.setdefault(dst, set()).add(KIND_OTHER)

    degree: dict[URIRef, int] = defaultdict(int)
    for src, _, dst, _ in edges:
        degree[src] += 1
        degree[dst] += 1

    nodes = [
        {
            "id": str(iri),
            "label": pick_label(graph, iri),
            "kind": _best_kind(ks),
            "degree": degree.get(iri, 0),
        }
        for iri, ks in kinds.items()
    ]
    edge_list = [
        {"source": str(src), "target": str(dst), "kind": kind, "label": label}
        for src, kind, dst, label in edges
    ]

    kind_counts: dict[str, int] = defaultdict(int)
    for node in nodes:
        kind_counts[node["kind"]] += 1

    return {
        "nodes": nodes,
        "edges": edge_list,
        "stats": {
            "nodeCount": len(nodes),
            "edgeCount": len(edge_list),
            "kindCounts": dict(kind_counts),
        },
    }


# --- node details -----------------------------------------------------------

def _term_json(graph: Graph, term) -> dict:
    if isinstance(term, URIRef):
        return {
            "type": "uri",
            "value": str(term),
            "prefixed": prefixed(graph, term),
            "label": pick_label(graph, term),
        }
    if isinstance(term, Literal):
        return {
            "type": "literal",
            "value": str(term),
            "lang": term.language,
            "datatype": prefixed(graph, term.datatype) if term.datatype else None,
        }
    if isinstance(term, BNode):
        # Render blank nodes inline as their own mini description.
        parts = []
        for p, o in graph.predicate_objects(term):
            if isinstance(o, BNode):
                value = "…"
            elif isinstance(o, URIRef):
                value = prefixed(graph, o)
            else:
                value = str(o)
            parts.append(f"{prefixed(graph, p)} {value}")
        return {"type": "bnode", "value": "[" + "; ".join(sorted(parts)) + "]"}
    return {"type": "unknown", "value": str(term)}


def node_details(graph: Graph, iri: str, limit: int = 500) -> Optional[dict]:
    ref = URIRef(iri)
    outgoing = []
    incoming = []
    out_total = 0
    in_total = 0
    for p, o in graph.predicate_objects(ref):
        out_total += 1
        if len(outgoing) < limit:
            outgoing.append({
                "predicate": _term_json(graph, p),
                "object": _term_json(graph, o),
            })
    for s, p in graph.subject_predicates(ref):
        in_total += 1
        if len(incoming) < limit and isinstance(s, URIRef):
            incoming.append({
                "subject": _term_json(graph, s),
                "predicate": _term_json(graph, p),
            })
    if out_total == 0 and in_total == 0:
        return None
    return {
        "iri": iri,
        "prefixed": prefixed(graph, ref),
        "label": pick_label(graph, ref),
        "outgoing": outgoing,
        "incoming": incoming,
        "outgoingTotal": out_total,
        "incomingTotal": in_total,
    }


def search_nodes(viz: dict, query: str, limit: int = 25) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    starts: list[dict] = []
    contains: list[dict] = []
    for node in viz["nodes"]:
        label = node["label"].lower()
        iri = node["id"].lower()
        if label.startswith(q):
            starts.append(node)
        elif q in label or q in iri:
            contains.append(node)
        if len(starts) >= limit:
            break
    return (starts + contains)[:limit]
