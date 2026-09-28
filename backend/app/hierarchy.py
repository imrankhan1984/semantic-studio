"""
================================================================================
FILE: backend/app/hierarchy.py
================================================================================

SUMMARY
    Builds the hierarchy forests the Hierarchy view draws: a class forest over
    asserted rdfs:subClassOf, a concept forest over asserted skos:broader (with
    skos:narrower / skos:hasTopConcept normalized to their inverse) rooted at
    skos:ConceptScheme, and — added in v0.3 — one property forest per property
    kind (object, datatype, annotation) over asserted rdfs:subPropertyOf. Each
    forest is a flat node map plus a parent->children adjacency and a root list,
    so a class with two parents is stored once and rendered under each.

BASIC IDEA
    A tree is the natural shape for subClassOf and broader, and it is the cheap
    one: the whole hierarchy is returned unbudgeted because the frontend
    virtualizes it. The forest is O(nodes + hierarchy edges): the node map holds
    label/prefix/kind/hasChildren, the adjacency holds the parent->child edges,
    and a class that inherits from two parents appears in both parents' child
    lists rather than being copied.

    Every child edge carries an `origin`, "asserted" today. That one field is
    the seam for a future inferred hierarchy (D-046): adding inferred edges is
    appending refs with origin "inferred", not changing the payload. build_
    hierarchy stays a pure function of the graph with no reasoning baked in, so
    an inference layer can wrap it rather than fork it.

    Malformed data can state a subClassOf cycle. It is broken: a path-tracking
    walk marks a node that is its own ancestor and does not descend into it
    again, and any node left unreachable by a pure cycle is promoted to a root
    so nothing is lost. The walk is what makes the endpoint proof against a loop.

INPUTS / INPUT SOURCES
    - An rdflib.Graph (from store.Ontology.ensure_loaded), via build_hierarchy.

EXPECTED OUTPUT
    - build_hierarchy(graph) -> {
        "classes":  forest, "concepts": forest,
        # Each property key is present only when the ontology declares that kind
        # of property in a subPropertyOf relationship (v0.3):
        "objectProperties":     forest,   # optional
        "datatypeProperties":   forest,   # optional
        "annotationProperties": forest,   # optional
        "counts":   {"classes": int, "concepts": int, [<property key>: int, ...]},
        "truncated": bool,
      }
      where forest = {
        "nodes":    { id: {label, prefixed, kind, hasChildren, [cyclic]} },
        "children": { id: [{id, origin}, ...] },
        "roots":    [id, ...],
      }
      classes and concepts are always present (empty forests when the ontology
      has none); the three property keys and their counts appear only when that
      kind exists. Consumed by frontend/src/components/HierarchyView.tsx.
================================================================================
"""

from __future__ import annotations

from collections import defaultdict
from typing import Callable, Optional, Sequence

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

# Shared with the graph view and the query schema so labels, prefixes, the
# asserted subClassOf pass and the property-kind classification are read
# identically across the application.
from .graph_builder import (
    KIND_ANNOTATION_PROPERTY,
    KIND_CLASS,
    KIND_CONCEPT,
    KIND_DATATYPE_PROPERTY,
    KIND_OBJECT_PROPERTY,
    TYPE_TO_KIND,
    labeler,
    prefixed,
    subclass_parents,
)
from .graph_builder import KIND_SCHEME
from .query_schema import META_CLASSES

# The three property forests, in priority order, paired with the response key
# each is emitted under. A property typed several ways is sorted by the earliest
# of these it matches (an object property wins over a datatype one), the same
# earliest-wins collapse graph_builder uses for node kinds.
_PROPERTY_FORESTS: tuple[tuple[str, str], ...] = (
    (KIND_OBJECT_PROPERTY, "objectProperties"),
    (KIND_DATATYPE_PROPERTY, "datatypeProperties"),
    (KIND_ANNOTATION_PROPERTY, "annotationProperties"),
)
_PROPERTY_KINDS = tuple(kind for kind, _ in _PROPERTY_FORESTS)

# The origin every edge carries. "asserted" is the only value this version
# emits; the field exists so an inferred hierarchy is data, not a schema change.
# See the module docstring and D-046.
ASSERTED = "asserted"

# Soft cap on the total nodes across both forests. Deliberately generous — the
# hierarchy carries only subClassOf / broader structure, so it is a fraction of
# the graph, and the catalogue's largest (UNESCO, ~4,600 concepts) is an order
# of magnitude under this. Over the cap the least-connected nodes are dropped
# and `truncated` is set rather than the response refused; `counts` still
# reports the true totals, so the interface stays honest about what it dropped.
HIERARCHY_MAX_NODES = 50000

# owl:Thing is the implicit universal superclass. It is never invented as a
# synthetic root (that adds a level a newcomer expands past for nothing), and a
# class whose only named superclass is owl:Thing is therefore a root itself.
THING = OWL.Thing


def _forest(
    node_ids: set[URIRef],
    parents: dict[URIRef, set[URIRef]],
    labels: dict[URIRef, tuple[str, str]],
    kind: str,
    kind_of: Optional[dict[URIRef, str]] = None,
) -> tuple[dict, int]:
    """Assemble one forest from a node set and a child->parents map.

    `parents[c]` is the set of named parents of `c`, already stripped of owl:Thing
    and of anything not in `node_ids`. Returns the forest dict and its node count.

    Roots are nodes with no parent. A parent references each of its children once,
    so a multi-parent node is stored once and appears under each parent when the
    frontend renders. Cycles are broken by a path-tracking walk (see _mark_cycles).
    """
    # Invert parents into a parent -> [children] adjacency, sorted for a stable
    # payload (the frontend renders in this order).
    children: dict[URIRef, list[URIRef]] = defaultdict(list)
    for child, ps in parents.items():
        for parent in ps:
            children[parent].append(child)
    for kids in children.values():
        kids.sort(key=str)

    roots = sorted((n for n in node_ids if not parents.get(n)), key=str)

    # Break cycles and guarantee every node is reachable from some root.
    cyclic, roots = _mark_cycles(node_ids, children, roots)

    nodes_out: dict[str, dict] = {}
    for n in node_ids:
        label, pref = labels[n]
        entry = {
            "label": label,
            "prefixed": pref,
            "kind": kind_of[n] if kind_of else kind,
            "hasChildren": bool(children.get(n)),
        }
        # Only present when true, so the common node carries the fixed shape.
        if n in cyclic:
            entry["cyclic"] = True
        nodes_out[str(n)] = entry

    children_out = {
        str(parent): [{"id": str(c), "origin": ASSERTED} for c in kids]
        for parent, kids in children.items()
        if kids
    }

    forest = {
        "nodes": nodes_out,
        "children": children_out,
        "roots": [str(r) for r in roots],
    }
    return forest, len(node_ids)


def _mark_cycles(
    node_ids: set[URIRef],
    children: dict[URIRef, list[URIRef]],
    roots: list[URIRef],
) -> tuple[set[URIRef], list[URIRef]]:
    """Find nodes that are their own ancestor, and ensure all are reachable.

    An iterative depth-first walk from the roots, tracking the path. A child
    already on the path closes a cycle: it is marked and not descended into, so
    the walk terminates. A pure cycle has no acyclic root, so its nodes stay
    unvisited; each is then promoted to a root (breaking into the cycle there)
    and marked, so nothing is lost and the endpoint still cannot loop.
    """
    cyclic: set[URIRef] = set()
    visited: set[URIRef] = set()

    def walk(start: URIRef) -> None:
        # Stack of (node, index-into-its-children); path_set mirrors the stack.
        stack: list[list] = [[start, 0]]
        path_set = {start}
        visited.add(start)
        while stack:
            node, i = stack[-1]
            kids = children.get(node, ())
            if i >= len(kids):
                path_set.discard(node)
                stack.pop()
                continue
            stack[-1][1] = i + 1
            child = kids[i]
            if child in path_set:
                # Back edge: this occurrence of `child` is its own ancestor.
                cyclic.add(child)
                continue
            if child in visited:
                continue  # already fully explored from elsewhere in the DAG
            visited.add(child)
            path_set.add(child)
            stack.append([child, 0])

    for root in roots:
        if root not in visited:
            walk(root)
    # Anything still unvisited is locked inside a cycle; promote deterministically.
    promoted: list[URIRef] = []
    for node in sorted(node_ids, key=str):
        if node not in visited:
            cyclic.add(node)
            promoted.append(node)
            walk(node)
    return cyclic, roots + promoted


def _build_class_forest(graph: Graph, label: Callable[[URIRef], str]) -> tuple[dict, int]:
    """The forest over asserted rdfs:subClassOf.

    A node is any named class: a resource typed owl:Class / rdfs:Class, or either
    end of a subClassOf statement. owl:Thing and the other RDF/OWL meta-classes
    are excluded from the node set — except owl:Thing, which is included only when
    the ontology declares it a class explicitly (never invented). A parent that is
    owl:Thing is dropped so a class under only owl:Thing is a root, not its child.
    """
    raw_parents = subclass_parents(graph)  # child -> {named superclasses}

    node_ids: set[URIRef] = set()
    # Declared classes (including owl:Thing when the file states it explicitly).
    for subject, obj in graph.subject_objects(RDF.type):
        if not isinstance(subject, URIRef):
            continue
        if obj in (OWL.Class, RDFS.Class):
            if subject not in META_CLASSES or subject == THING:
                node_ids.add(subject)
    # Both ends of every subClassOf edge, minus the meta-classes (owl:Thing among
    # them, so it is added above only when independently declared).
    for child, parents in raw_parents.items():
        if child not in META_CLASSES:
            node_ids.add(child)
        for parent in parents:
            if parent not in META_CLASSES:
                node_ids.add(parent)

    # Parents restricted to nodes we keep, with owl:Thing stripped: a class whose
    # only superclass is owl:Thing has no effective parent and is a root.
    parents: dict[URIRef, set[URIRef]] = {}
    for child in node_ids:
        effective = {p for p in raw_parents.get(child, ()) if p in node_ids and p != THING}
        if effective:
            parents[child] = effective

    labels = {n: (label(n), prefixed(graph, n)) for n in node_ids}
    return _forest(node_ids, parents, labels, KIND_CLASS)


def _build_concept_forest(graph: Graph, label: Callable[[URIRef], str]) -> tuple[dict, int]:
    """The forest over asserted skos:broader, rooted at concept schemes.

    A scheme holds its top concepts (skos:hasTopConcept, or the inverse of
    skos:topConceptOf); a concept holds the concepts broader-linked to it
    (skos:broader, or the inverse of skos:narrower). A concept with neither a
    broader parent nor a topping scheme is a root on its own, so nothing is lost.
    A concept that both tops a scheme and has a broader parent appears under each,
    the same multi-parent handling the class forest uses.
    """
    node_ids: set[URIRef] = set()
    schemes: set[URIRef] = set()
    for subject in graph.subjects(RDF.type, SKOS.Concept):
        if isinstance(subject, URIRef):
            node_ids.add(subject)
    for subject in graph.subjects(RDF.type, SKOS.ConceptScheme):
        if isinstance(subject, URIRef):
            node_ids.add(subject)
            schemes.add(subject)

    # child -> {parents}. A parent is a broader concept or a topping scheme.
    parents: dict[URIRef, set[URIRef]] = defaultdict(set)

    def link(child, parent, *, parent_is_scheme: bool = False) -> None:
        if isinstance(child, URIRef) and isinstance(parent, URIRef) and child != parent:
            node_ids.add(child)
            node_ids.add(parent)
            if parent_is_scheme:
                schemes.add(parent)
            parents[child].add(parent)

    # broader: child skos:broader parent. narrower is its inverse.
    for child, parent in graph.subject_objects(SKOS.broader):
        link(child, parent)
    for parent, child in graph.subject_objects(SKOS.narrower):
        link(child, parent)
    # A scheme tops a concept: the concept is a child of the scheme. topConceptOf
    # is the inverse. The scheme is recorded even if the file never typed it, so
    # it is drawn as a scheme rather than an untyped root.
    for scheme, concept in graph.subject_objects(SKOS.hasTopConcept):
        link(concept, scheme, parent_is_scheme=True)
    for concept, scheme in graph.subject_objects(SKOS.topConceptOf):
        link(concept, scheme, parent_is_scheme=True)

    # A scheme is always a root, never a child, so drop any stray parent edge
    # into one (e.g. a malformed `scheme skos:broader scheme`).
    for child in list(parents):
        if child in schemes:
            del parents[child]

    labels = {n: (label(n), prefixed(graph, n)) for n in node_ids}
    kind_of = {n: (KIND_SCHEME if n in schemes else KIND_CONCEPT) for n in node_ids}
    parents_plain = {c: ps for c, ps in parents.items() if ps}
    return _forest(node_ids, parents_plain, labels, KIND_CONCEPT, kind_of=kind_of)


def _property_kind(graph: Graph, node: URIRef) -> str:
    """The property forest a property belongs in, from its asserted rdf:type.

    Restricted to the three property kinds graph_builder distinguishes and
    collapsed by the same earliest-wins priority. A property that names none of
    them — a plain rdf:Property, or one that participates in subPropertyOf while
    left untyped — falls back to the object-property forest, so its subtree stays
    with any typed relatives rather than being dropped. There is no fourth,
    "plain property" forest: the view offers exactly the three the spec names.
    """
    found = set()
    for obj in graph.objects(node, RDF.type):
        kind = TYPE_TO_KIND.get(obj) if isinstance(obj, URIRef) else None
        if kind in _PROPERTY_KINDS:
            found.add(kind)
    for kind in _PROPERTY_KINDS:
        if kind in found:
            return kind
    return KIND_OBJECT_PROPERTY


def _build_property_forests(graph: Graph, label: Callable[[URIRef], str]) -> dict[str, tuple[dict, int]]:
    """One forest per property kind over asserted rdfs:subPropertyOf (v0.3).

    `P subPropertyOf Q` makes `P` a child of `Q`, exactly as subClassOf builds
    the class forest — the same generic _forest, so multiple inheritance, cycle
    breaking and the origin marker all come for free. A property with no named
    super-property is a root.

    Only properties that PARTICIPATE in a subPropertyOf statement are included,
    which is where this deliberately differs from the class and concept forests
    (which carry lone declared nodes too). A large ontology declares thousands of
    properties with no sub-property structure; listing them all as flat roots
    would be the wall the whole view exists to avoid, and a flat property list is
    the detail panel's job, not the hierarchy's. So the property section shows
    what the ontology states ABOUT sub-property structure, and nothing when it
    states none.

    Returns a map from response key to (forest, node count) for each of the three
    kinds that has at least one member, so a caller emits only the forests that
    exist.
    """
    # child -> {named super-properties}, both ends named and not self-referential
    # (a self subPropertyOf is a one-node cycle with no useful parent, dropped the
    # same way subclass_parents drops a self subClassOf).
    raw_parents: dict[URIRef, set[URIRef]] = defaultdict(set)
    members: set[URIRef] = set()
    for subject, obj in graph.subject_objects(RDFS.subPropertyOf):
        if isinstance(subject, URIRef) and isinstance(obj, URIRef) and subject != obj:
            raw_parents[subject].add(obj)
            members.add(subject)
            members.add(obj)

    if not members:
        return {}

    kind_of = {n: _property_kind(graph, n) for n in members}
    labels = {n: (label(n), prefixed(graph, n)) for n in members}

    result: dict[str, tuple[dict, int]] = {}
    for kind, key in _PROPERTY_FORESTS:
        kind_nodes = {n for n in members if kind_of[n] == kind}
        if not kind_nodes:
            continue
        # Parents restricted to this forest: a parent of a different kind is not a
        # node here, so the child becomes a root — the same rule the class forest
        # uses to strip owl:Thing and off-set parents.
        parents = {}
        for child in kind_nodes:
            effective = {p for p in raw_parents.get(child, ()) if p in kind_nodes}
            if effective:
                parents[child] = effective
        kind_labels = {n: labels[n] for n in kind_nodes}
        result[key] = _forest(kind_nodes, parents, kind_labels, kind)
    return result


def _truncate(forest: dict, keep: int) -> dict:
    """Keep the `keep` most-connected nodes of a forest, dropping the rest.

    The soft cap's fallback, reached only by a hierarchy past HIERARCHY_MAX_NODES.
    "Most-connected" is by child count, so the least-connected (typically leaves)
    go first. A node whose parents were all dropped becomes a root, so the kept
    set stays reachable. This is approximate on purpose: the cap is a safety net,
    not an interaction, and `counts` reports the true totals either way.
    """
    nodes = forest["nodes"]
    if len(nodes) <= keep:
        return forest
    degree = {nid: len(kids) for nid, kids in forest["children"].items()}
    kept = set(sorted(nodes, key=lambda nid: (-degree.get(nid, 0), nid))[:keep])

    nodes_out = {nid: n for nid, n in nodes.items() if nid in kept}
    children_out = {
        nid: [ref for ref in kids if ref["id"] in kept]
        for nid, kids in forest["children"].items()
        if nid in kept
    }
    children_out = {nid: kids for nid, kids in children_out.items() if kids}
    referenced = {ref["id"] for kids in children_out.values() for ref in kids}
    roots_out = sorted(nid for nid in kept if nid not in referenced)
    return {"nodes": nodes_out, "children": children_out, "roots": roots_out}


def build_hierarchy(
    graph: Graph, *, max_nodes: int = HIERARCHY_MAX_NODES, langs: Optional[Sequence[str]] = None
) -> dict:
    """Build the hierarchy forests from an rdflib graph.

    The class forest, the concept forest, and one property forest per property
    kind (object / datatype / annotation) the ontology declares in a
    subPropertyOf relationship.

    A pure function of the graph: it reads and never mutates it, and makes no
    reasoning assumptions, so a future build_hierarchy(graph, reasoner=…) can add
    inferred edges on top of this output rather than forking it (D-046). A future
    ?include_inferred=true on the endpoint would select asserted-plus-inferred,
    mirroring the documentation export's include_individuals; absent, the default
    is this asserted-only forest. That parameter is reserved and not implemented.

    `max_nodes` caps the combined node count; over it the least-connected nodes
    are dropped and `truncated` is set. `counts` reports the true totals so the
    interface can say how much was dropped.

    `langs` names a project document's rows in its display language (D-085);
    None keeps the library's label rule.
    """
    label = labeler(graph, langs)
    classes, class_total = _build_class_forest(graph, label)
    concepts, concept_total = _build_concept_forest(graph, label)
    # Property forests (v0.3): one per property kind the ontology declares in a
    # subPropertyOf relationship, so most ontologies add nothing here.
    properties = _build_property_forests(graph, label)

    # Every forest present, in emission order, as key -> (forest, node count).
    # classes and concepts are always present (empty when the ontology has none);
    # the property keys appear only when their kind exists.
    forests: dict[str, tuple[dict, int]] = {
        "classes": (classes, class_total),
        "concepts": (concepts, concept_total),
        **properties,
    }

    grand_total = sum(total for _, total in forests.values())
    truncated = grand_total > max_nodes
    if truncated:
        # Share the budget across every forest in proportion to its size, so a
        # huge concept scheme does not crowd out a small class or property tree.
        for key, (forest, total) in list(forests.items()):
            keep = max(1, round(max_nodes * total / grand_total)) if total else 0
            forests[key] = (_truncate(forest, keep), total)

    result: dict = {
        "classes": forests["classes"][0],
        "concepts": forests["concepts"][0],
        # counts always names classes and concepts; a property count is added only
        # for a kind that exists, so an ontology with no properties keeps the exact
        # {"classes": N, "concepts": M} shape the first build established.
        "counts": {key: total for key, (_, total) in forests.items()},
        "truncated": truncated,
    }
    for _, key in _PROPERTY_FORESTS:
        if key in properties:
            result[key] = forests[key][0]
    return result
