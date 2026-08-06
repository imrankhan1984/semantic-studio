"""
================================================================================
FILE: backend/app/graph_builder.py
================================================================================

SUMMARY
    Turns an rdflib.Graph into the node/edge structure the frontend graph view
    draws, plus helpers for a single node's detail panel and for label/IRI
    search. Also provides the shared label-picking and prefix-shortening
    helpers reused by other backend modules, the node budget that keeps a
    large ontology from being shipped to the browser in one piece, and the
    neighbourhood of one entity, which is how the browser gets back the part
    of the graph that budget dropped.

BASIC IDEA
    An ontology is a bag of RDF triples. The graph view needs named entities
    as "nodes" (each tagged with a kind: class, property, SKOS concept,
    individual, ...) and the structural relations between them as typed
    "edges" (subClassOf, domain/range, broader, property assertions, ...).
    This module walks the triples in a few passes to derive those, choosing a
    human label and a "best" kind for each entity. Blank nodes are excluded
    from the visual graph (they clutter it) but still appear in a node's
    detail view.

INPUTS / INPUT SOURCES
    - An rdflib.Graph produced by store.parse_rdf (build_viz_graph, node_details).
    - The pre-built viz dict for label/IRI search (search_nodes), for the node
      budget (budget_viz) and for one entity's neighbourhood (neighborhood_viz).
    - A specific entity IRI for the detail panel (node_details) and for the
      centre of a neighbourhood (neighborhood_viz).

EXPECTED OUTPUT
    - build_viz_graph -> {"nodes": [...], "edges": [...], "stats": {...}} as
      JSON-ready dicts consumed by frontend/src/components/GraphView.tsx.
    - budget_viz -> the same shape reduced to the highest-degree nodes, with
      the true totals and a truncation flag added to stats.
    - build_card_sketch -> a twenty-node thumbnail of the same ranking, small
      enough to live in the metadata file so the home screen can draw an
      ontology without parsing it.
    - neighborhood_viz -> the same shape again, holding one entity and its
      highest-degree neighbours, so the browser can grow a budgeted graph
      outwards without refetching all of it.
    - node_details -> every outgoing/incoming statement for one IRI (or None).
    - search_nodes -> ranked node matches for the search box.
    - pick_label / prefixed are imported by query_schema.py and sparql_exec.py.
================================================================================
"""

from __future__ import annotations

from collections import defaultdict
from typing import Optional

from rdflib import Graph, Literal, URIRef, BNode
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS, XSD

# --- node kinds -------------------------------------------------------------
# String tags attached to each node. The frontend colours nodes by kind and
# the legend/filters key off these exact strings, so they are a shared contract.

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

# Maps an rdf:type object (an RDF/OWL/SKOS meta-class) to our node kind, so a
# resource typed as e.g. owl:ObjectProperty becomes a node of kind objectProperty.
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

# Predicates checked, in order of preference, when choosing a human label.
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

# The XSD namespace as a plain string, used to detect literal-typed ranges.
XSD_NS = str(XSD)


def _best_kind(kinds: set[str]) -> str:
    """Collapse a set of possible kinds to the single most specific one.

    An entity can be typed several ways (e.g. both owl:Class and skos:Concept);
    KIND_PRIORITY decides which wins, earliest = most specific.
    """
    for kind in KIND_PRIORITY:
        if kind in kinds:
            return kind
    return KIND_OTHER


def _local_name(iri: str) -> str:
    """The trailing name of an IRI (after the last # / or :), for a fallback label."""
    for sep in ("#", "/", ":"):
        if sep in iri:
            # rstrip drops a trailing separator so ".../Foo/" still yields "Foo".
            tail = iri.rstrip("#/").rsplit(sep, 1)[-1]
            if tail:
                return tail
    return iri


def pick_label(graph: Graph, node: URIRef) -> str:
    """Preferred human label: skos:prefLabel > rdfs:label > titles > local name.

    Prefers an English (or untagged) label, but remembers the first
    other-language value as a fallback so nothing is left unlabelled.
    """
    fallback: Optional[str] = None
    for predicate in LABEL_PREDICATES:
        for value in graph.objects(node, predicate):
            if isinstance(value, Literal):
                # Untagged or English label: use it immediately.
                if value.language in (None, "en") :
                    return str(value)
                # Otherwise keep the first foreign-language label as a backup.
                if fallback is None:
                    fallback = str(value)
        # A label at a higher-priority predicate wins over lower ones.
        if fallback is not None:
            return fallback
    # No label predicate matched; fall back to the IRI's local name.
    return _local_name(str(node))


def prefixed(graph: Graph, iri: URIRef) -> str:
    """Shorten an IRI to prefix:local using the graph's namespaces, else the full IRI."""
    try:
        qname = graph.namespace_manager.qname(iri)
        # rdflib can produce ugly generated prefixes like ns1:; keep them anyway
        return qname
    except Exception:
        # qname raises when no prefix matches; the full IRI is the safe fallback.
        return str(iri)


def build_viz_graph(graph: Graph) -> dict:
    """Extract nodes and edges for visualization from an rdflib graph.

    Walks the triples in three passes and returns JSON-ready nodes, edges and
    summary stats. Node "kind" is accumulated as a set during the passes and
    collapsed to the best single kind at the end.
    """
    # kinds: every kind we have seen for each entity (collapsed later).
    kinds: dict[URIRef, set[str]] = defaultdict(set)
    # edges: a set (dedupes) of (source, edge-kind, target, label) tuples.
    edges: set[tuple[URIRef, str, URIRef, str]] = set()  # (src, kind, dst, label)

    # Pass 1: explicit typing — read rdf:type to tag entities by their meta-class.
    object_properties: set[URIRef] = set()
    datatype_properties: set[URIRef] = set()
    for subject, obj in graph.subject_objects(RDF.type):
        # Ignore blank nodes and literal types; we only draw named entities.
        if not isinstance(subject, URIRef) or not isinstance(obj, URIRef):
            continue
        kind = TYPE_TO_KIND.get(obj)
        if kind:
            kinds[subject].add(kind)
            # Remember object properties so pass 3 can draw their assertions,
            # and datatype properties for completeness.
            if kind == KIND_OBJECT_PROPERTY:
                object_properties.add(subject)
            elif kind == KIND_DATATYPE_PROPERTY:
                datatype_properties.add(subject)

    # Pass 2: structural edges (subClassOf, domain/range, broader, ...) plus the
    # kinds those edges imply (e.g. both ends of subClassOf must be classes).
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
        # skos:narrower / skos:hasTopConcept are stored as their inverse edge so
        # the graph has a single, consistent direction (broader / inScheme).
        elif p in INVERTED_EDGE_PREDICATES and isinstance(o, URIRef):
            edges.add((o, INVERTED_EDGE_PREDICATES[p], s, ""))
            if p == SKOS.narrower:
                kinds[s].add(KIND_CONCEPT)
                kinds[o].add(KIND_CONCEPT)

    # Pass 3: instance-of edges and object-property assertions between individuals.
    # class_like = everything we now know to be a class.
    class_like = {n for n, ks in kinds.items() if KIND_CLASS in ks}
    for s, o in graph.subject_objects(RDF.type):
        # Draw "instanceOf" from a resource to any of its types that is a class.
        if isinstance(s, URIRef) and isinstance(o, URIRef) and o in class_like:
            edges.add((s, "instanceOf", o, ""))
            # If it is not itself a class/scheme/concept, it is an individual.
            if not kinds[s] & {KIND_CLASS, KIND_SCHEME, KIND_CONCEPT}:
                kinds[s].add(KIND_INDIVIDUAL)
    # For each object property, draw an "assertion" edge for every actual use,
    # labelled with the property's name (e.g. Earth --orbits--> Sun).
    for prop in object_properties:
        prop_label = _local_name(str(prop))
        for s, o in graph.subject_objects(prop):
            if isinstance(s, URIRef) and isinstance(o, URIRef):
                edges.add((s, "assertion", o, prop_label))

    # An edge might reference an entity we never typed; make sure both ends of
    # every edge exist as a node (kind OTHER if nothing more specific is known).
    for src, _, dst, _ in edges:
        kinds.setdefault(src, set()).add(KIND_OTHER)
        kinds.setdefault(dst, set()).add(KIND_OTHER)

    # Degree = number of edges touching a node; used by the frontend to size nodes.
    degree: dict[URIRef, int] = defaultdict(int)
    for src, _, dst, _ in edges:
        degree[src] += 1
        degree[dst] += 1

    # Build the JSON node list: id, human label, best single kind, and degree.
    nodes = [
        {
            "id": str(iri),
            "label": pick_label(graph, iri),
            "kind": _best_kind(ks),
            "degree": degree.get(iri, 0),
        }
        for iri, ks in kinds.items()
    ]
    # Build the JSON edge list from the deduped edge tuples.
    edge_list = [
        {"source": str(src), "target": str(dst), "kind": kind, "label": label}
        for src, kind, dst, label in edges
    ]

    # Tally how many nodes of each kind exist, for the legend counts.
    kind_counts: dict[str, int] = defaultdict(int)
    for node in nodes:
        kind_counts[node["kind"]] += 1

    # Count the object-property assertion edges between individuals. This is the
    # A-box edge count the documentation export's opt-in confirmation reports
    # (DOC-1 AC-16); computing it here means the Home screen can state it without
    # a request, the same reason kindCounts is computed at ingest (D-017). The
    # individual NODE count is already in kindCounts["individual"].
    assertion_count = sum(1 for e in edge_list if e["kind"] == "assertion")

    return {
        "nodes": nodes,
        "edges": edge_list,
        "stats": {
            "nodeCount": len(nodes),
            "edgeCount": len(edge_list),
            "kindCounts": dict(kind_counts),
            "assertionCount": assertion_count,
        },
    }


# --- node budget ------------------------------------------------------------


def budget_viz(viz: dict, limit: int) -> dict:
    """The `limit` highest-degree nodes of a built viz graph, plus the edges
    among them. Ties broken by node id so the result is deterministic.
    Returns the same shape as build_viz_graph with four extra stats fields.

    This is a pure function over an already-built viz dict and never touches
    the rdflib graph. build_viz_graph keeps producing the *complete* graph,
    because search, the ontology summary and the cache all depend on it; the
    budget is applied on top, per request. Measured at 3 ms over 40,000 nodes,
    which is why there is no second cache to invalidate. See D-018.
    """
    nodes = viz["nodes"]
    edges = viz["edges"]
    node_total = len(nodes)
    edge_total = len(edges)
    truncated = node_total > limit

    if truncated:
        # Descending degree, then ascending id. The id tiebreak is not
        # cosmetic: without it two calls can return different node sets for
        # the same ontology, and the view would shuffle for no visible reason.
        ranked = sorted(nodes, key=lambda n: (-n["degree"], n["id"]))
        kept_nodes = ranked[:limit]
        kept_ids = {n["id"] for n in kept_nodes}
        # Both ends must survive. A retained node whose every neighbour was
        # dropped is drawn unconnected, which is correct: it is a real entity
        # that happens to have no retained neighbour.
        kept_edges = [
            e for e in edges if e["source"] in kept_ids and e["target"] in kept_ids
        ]
    else:
        # Copy the lists even when nothing is dropped. They are the cache's own
        # lists; handing them out would let any caller that mutates a response
        # corrupt the full graph every other feature reads.
        kept_nodes = list(nodes)
        kept_edges = list(edges)

    return {
        "nodes": kept_nodes,
        "edges": kept_edges,
        "stats": {
            "nodeCount": len(kept_nodes),
            "edgeCount": len(kept_edges),
            "nodeTotal": node_total,
            "edgeTotal": edge_total,
            "truncated": truncated,
            "budget": limit,
            # Deliberately the WHOLE ontology, not the drawn subset. The legend
            # is a statement about the ontology, not about the canvas: if it
            # counted only drawn nodes its numbers would change every time the
            # user expanded something, and a learner would never see the real
            # composition. This will read as a bug. It is not. See D-017.
            "kindCounts": dict(viz["stats"]["kindCounts"]),
        },
    }


# --- the home screen's thumbnail --------------------------------------------

# How many entities a card's miniature draws. Twenty is what fits legibly in
# 120x70 pixels: past that the dots merge and the picture stops distinguishing
# one ontology from another, which is the only thing it is for. It also bounds
# the metadata file, which is read on every startup for every stored ontology.
SKETCH_NODE_LIMIT = 20


def build_card_sketch(viz: dict, limit: int = SKETCH_NODE_LIMIT) -> dict:
    """A tiny thumbnail of an ontology: its `limit` highest-degree entities and
    the edges among them, carrying only what a miniature draws.

    **Why this is computed at ingest and stored, rather than derived on
    request.** The home screen shows one of these per saved ontology, and
    building it needs the viz graph, which needs a parse. Parsing every stored
    ontology to draw the home screen would undo `startup-chooser-screen`, whose
    whole point is that startup costs nothing. So it rides along with the parse
    that already happens when a file is added, and is served afterwards from
    metadata with no parse at all.

    The ranking is `budget_viz`'s at a much smaller limit, deliberately: the
    twenty entities on the card are the twenty the canvas would draw first, so
    the thumbnail is a true preview rather than a decoration.

    Labels are excluded. Nothing in the miniature renders text, and leaving
    ontology-controlled strings out of a file read at every startup is free.
    """
    small = budget_viz(viz, limit)
    return {
        "nodes": [
            {"id": n["id"], "kind": n["kind"], "degree": n["degree"]}
            for n in small["nodes"]
        ],
        # Kind and label dropped as well: at this size an edge is a hairline,
        # and the miniature colours it by neither.
        "edges": [
            {"source": e["source"], "target": e["target"]} for e in small["edges"]
        ],
    }


# --- one entity's neighbourhood ---------------------------------------------


def neighborhood_viz(viz: dict, iri: str, limit: int) -> Optional[dict]:
    """One entity, its highest-degree neighbours up to `limit`, and the edges
    among the returned set. None when `iri` is not a node in this viz graph.

    This is the other half of the node budget. `budget_viz` decides what is
    drawn on first load; this decides what can be drawn afterwards, so an
    entity the budget dropped is reachable rather than merely findable.

    Computed from the cached viz dict rather than from the rdflib graph, for
    the same reason `budget_viz` is: one definition of what a node and an edge
    are. Asking rdflib again would let the two drift, and a neighbour that
    exists in the detail panel but not on the canvas is the confusion this
    whole feature exists to remove.

    Neighbours are ranked the way the budget ranks, descending degree with the
    id breaking ties, so a partial expansion returns the connections most
    likely to matter and returns the same ones twice.
    """
    by_id = {n["id"]: n for n in viz["nodes"]}
    center = by_id.get(iri)
    if center is None:
        return None

    edges = viz["edges"]
    # Pass 1: who is directly connected. Both directions count — an entity's
    # neighbourhood is not a statement about which way the arrows point.
    neighbor_ids: set[str] = set()
    for edge in edges:
        if edge["source"] == iri:
            neighbor_ids.add(edge["target"])
        elif edge["target"] == iri:
            neighbor_ids.add(edge["source"])
    # A self-loop makes the centre its own neighbour, which would report one
    # connection too many and hand the same node back twice.
    neighbor_ids.discard(iri)

    neighbor_total = len(neighbor_ids)
    truncated = neighbor_total > limit
    ranked = sorted(
        (by_id[nid] for nid in neighbor_ids if nid in by_id),
        key=lambda n: (-n["degree"], n["id"]),
    )
    kept_nodes = [center] + ranked[:limit]
    kept_ids = {n["id"] for n in kept_nodes}

    # Pass 2: every edge among the returned set, not only those touching the
    # centre. Two neighbours joined to each other are part of what the user is
    # being shown, and omitting that edge would draw a star where the ontology
    # has a structure.
    kept_edges = [
        e for e in edges if e["source"] in kept_ids and e["target"] in kept_ids
    ]

    return {
        "nodes": kept_nodes,
        "edges": kept_edges,
        "stats": {
            "nodeCount": len(kept_nodes),
            "edgeCount": len(kept_edges),
            # The ontology's totals, so the interface can keep saying how much
            # of it is drawn as the drawn part grows.
            "nodeTotal": len(viz["nodes"]),
            "edgeTotal": len(edges),
            # About the neighbours, not about the ontology: true when this
            # entity has more connections than were returned.
            "truncated": truncated,
            "budget": limit,
            "neighborTotal": neighbor_total,
            "center": iri,
            # Whole-ontology, exactly as in budget_viz and for the same reason:
            # the legend describes the ontology, not the canvas. See D-017.
            "kindCounts": dict(viz["stats"]["kindCounts"]),
        },
    }


# --- node details -----------------------------------------------------------
# Everything below powers the right-hand detail panel and the search box.

def _term_json(graph: Graph, term) -> dict:
    """Serialize one RDF term (URI, literal or blank node) for the detail panel."""
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
    """Every statement about one entity, for the detail panel.

    Returns outgoing statements (iri as subject) and incoming ones (iri as
    object), each capped at `limit` rows but with the true totals reported so
    the UI can say "showing 500 of N". Returns None if the IRI has no triples.
    """
    ref = URIRef(iri)
    outgoing = []
    incoming = []
    out_total = 0
    in_total = 0
    # Outgoing: predicate -> object triples where this entity is the subject.
    for p, o in graph.predicate_objects(ref):
        out_total += 1
        if len(outgoing) < limit:
            outgoing.append({
                "predicate": _term_json(graph, p),
                "object": _term_json(graph, o),
            })
    # Incoming: subject -> predicate triples where this entity is the object.
    for s, p in graph.subject_predicates(ref):
        in_total += 1
        if len(incoming) < limit and isinstance(s, URIRef):
            incoming.append({
                "subject": _term_json(graph, s),
                "predicate": _term_json(graph, p),
            })
    # Nothing references or is stated about this IRI -> not a real entity.
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
    """Rank nodes for the search box: label-prefix matches first, then substrings.

    Searches the already-built viz dict (not the raw graph), matching on both
    the label and the IRI, case-insensitively.
    """
    q = query.strip().lower()
    if not q:
        return []
    # Two buckets so prefix matches ("mar" -> "Mars") rank above mere substrings.
    starts: list[dict] = []
    contains: list[dict] = []
    for node in viz["nodes"]:
        label = node["label"].lower()
        iri = node["id"].lower()
        if label.startswith(q):
            starts.append(node)
        elif q in label or q in iri:
            contains.append(node)
        # Stop early once we have enough strong (prefix) matches.
        if len(starts) >= limit:
            break
    # Prefix matches first, then substring matches, capped at limit.
    return (starts + contains)[:limit]
