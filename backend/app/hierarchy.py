"""
================================================================================
FILE: backend/app/hierarchy.py
================================================================================

SUMMARY
    Builds the two hierarchy forests the Hierarchy view draws: a class forest
    over asserted rdfs:subClassOf, and a concept forest over asserted
    skos:broader (with skos:narrower / skos:hasTopConcept normalized to their
    inverse) rooted at skos:ConceptScheme. Each forest is a flat node map plus a
    parent->children adjacency and a root list, so a class with two parents is
    stored once and rendered under each.

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
        "counts":   {"classes": int, "concepts": int},
        "truncated": bool,
      }
      where forest = {
        "nodes":    { id: {label, prefixed, kind, hasChildren, [cyclic]} },
        "children": { id: [{id, origin}, ...] },
        "roots":    [id, ...],
      }
      Consumed by frontend/src/components/HierarchyView.tsx.
================================================================================
"""

from __future__ import annotations

from collections import defaultdict
from typing import Optional

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

# Shared with the graph view and the query schema so labels, prefixes and the
# asserted subClassOf pass are read identically across the application.
from .graph_builder import (
    KIND_CLASS,
    KIND_CONCEPT,
    KIND_SCHEME,
    pick_label,
    prefixed,
    subclass_parents,
)
from .query_schema import META_CLASSES

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


def _build_class_forest(graph: Graph) -> tuple[dict, int]:
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

    labels = {n: (pick_label(graph, n), prefixed(graph, n)) for n in node_ids}
    return _forest(node_ids, parents, labels, KIND_CLASS)


def _build_concept_forest(graph: Graph) -> tuple[dict, int]:
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

    labels = {n: (pick_label(graph, n), prefixed(graph, n)) for n in node_ids}
    kind_of = {n: (KIND_SCHEME if n in schemes else KIND_CONCEPT) for n in node_ids}
    parents_plain = {c: ps for c, ps in parents.items() if ps}
    return _forest(node_ids, parents_plain, labels, KIND_CONCEPT, kind_of=kind_of)


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


def build_hierarchy(graph: Graph, *, max_nodes: int = HIERARCHY_MAX_NODES) -> dict:
    """Build both hierarchy forests from an rdflib graph.

    A pure function of the graph: it reads and never mutates it, and makes no
    reasoning assumptions, so a future build_hierarchy(graph, reasoner=…) can add
    inferred edges on top of this output rather than forking it (D-046). A future
    ?include_inferred=true on the endpoint would select asserted-plus-inferred,
    mirroring the documentation export's include_individuals; absent, the default
    is this asserted-only forest. That parameter is reserved and not implemented.

    `max_nodes` caps the combined node count; over it the least-connected nodes
    are dropped and `truncated` is set. `counts` reports the true totals so the
    interface can say how much was dropped.
    """
    classes, class_total = _build_class_forest(graph)
    concepts, concept_total = _build_concept_forest(graph)

    truncated = class_total + concept_total > max_nodes
    if truncated:
        # Share the budget in proportion to each forest's size so a huge concept
        # scheme does not crowd out a small class tree entirely.
        total = class_total + concept_total
        class_keep = max(1, round(max_nodes * class_total / total)) if class_total else 0
        classes = _truncate(classes, class_keep)
        concepts = _truncate(concepts, max_nodes - class_keep)

    return {
        "classes": classes,
        "concepts": concepts,
        "counts": {"classes": class_total, "concepts": concept_total},
        "truncated": truncated,
    }
