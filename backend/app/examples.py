"""
================================================================================
FILE: backend/app/examples.py
================================================================================

SUMMARY
    Example data in a project (shacl-authoring 5.8): which individuals are a
    project's examples, the classes each belongs to, and what an example's
    form shows -- one field per attribute and relationship its classes have,
    their own and inherited, with the values it holds and, for a
    relationship, the examples it may point to. Reads only; the commands
    that create and fill examples are editing.py's.

BASIC IDEA
    A shape checks individuals, and before Stage B a learner could not make
    one without Turtle. An example is an individual of a class of the model:
    a named node with an rdf:type that is a class (owl:Class or rdfs:Class,
    in the document or an import), or one typed owl:NamedIndividual, and
    that is not itself a class, a property, a concept, a scheme, an ontology
    or a shape. CreateExample writes both types, so the graph view colours
    it as an individual; one written in Turtle with only its class still
    counts, because that is what a shape's sh:targetClass finds.

    The fields are worked out exactly as the rule editor's paths are
    (shapes_form.paths_for), so an example offers what its class's shape can
    check, and the two never disagree about what Person has. A relationship
    field's choices are the examples of its end class or a subclass of it,
    all of them when it has no end class; a project is written by hand, so
    the list is small, and it is capped with the true total all the same.

INPUTS / INPUT SOURCES
    - The model's graph, merged with its resolved imports where they are
      (classes and properties may be an import's); a naming function.

EXPECTED OUTPUT
    - example_classes(graph, node) -> the classes an example belongs to.
    - is_example(graph, node), examples(graph, own) -> the examples.
    - example_view(graph, node, names, languages) -> {classes, fields} for
      the node route, or None for anything that is not an example.
================================================================================
"""

from __future__ import annotations

from typing import Callable, Optional

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

from . import shapes_form

Names = Callable[[URIRef], str]

CLASS_TYPES = (OWL.Class, RDFS.Class)

# Whatever is one of these is part of the model, never an example of it.
_NOT_EXAMPLES = {
    OWL.Class, RDFS.Class, RDFS.Datatype, OWL.Ontology, OWL.ObjectProperty,
    OWL.DatatypeProperty, OWL.AnnotationProperty, RDF.Property, OWL.FunctionalProperty,
    OWL.InverseFunctionalProperty, OWL.TransitiveProperty, OWL.SymmetricProperty,
    OWL.AsymmetricProperty, OWL.ReflexiveProperty, OWL.IrreflexiveProperty,
    OWL.Restriction, SKOS.Concept, SKOS.ConceptScheme, SKOS.Collection,
    SKOS.OrderedCollection, shapes_form.SH.NodeShape, shapes_form.SH.PropertyShape,
}

# The choices a relationship field offers at most; the total is reported.
OPTIONS_CAP = 200


def is_class(graph: Graph, node) -> bool:
    return isinstance(node, URIRef) and any((node, RDF.type, t) in graph for t in CLASS_TYPES)


def example_classes(graph: Graph, node) -> list:
    """The classes an example belongs to, sorted; empty for anything else."""
    if not isinstance(node, URIRef):
        return []
    types = set(graph.objects(node, RDF.type))
    if types & _NOT_EXAMPLES:
        return []
    classes = sorted(t for t in types if is_class(graph, t))
    if classes or OWL.NamedIndividual in types:
        return classes
    return []


def is_example(graph: Graph, node) -> bool:
    if not isinstance(node, URIRef):
        return False
    types = set(graph.objects(node, RDF.type))
    if types & _NOT_EXAMPLES:
        return False
    return OWL.NamedIndividual in types or any(is_class(graph, t) for t in types)


def examples(graph: Graph, own: Optional[Graph] = None) -> list:
    """Every example the document `own` types (the graph itself when None),
    judged against `graph`, which may carry the imports' classes. An
    import's individuals are not this project's examples."""
    own = graph if own is None else own
    found = {s for s, t in own.subject_objects(RDF.type) if isinstance(s, URIRef)}
    return sorted(s for s in found if is_example(graph, s))


def subclasses(graph: Graph, cls) -> set:
    """The class and every class below it, a loop cut."""
    seen = {cls}
    queue = [cls]
    while queue:
        current = queue.pop()
        for child in graph.subjects(RDFS.subClassOf, current):
            if isinstance(child, URIRef) and child not in seen:
                seen.add(child)
                queue.append(child)
    return seen


def _options(graph: Graph, rng, every: list, names: Names) -> tuple[list, int]:
    """The examples a relationship may point to: of its end class or below,
    every example when it has none. The example itself is a choice too: a
    relationship to oneself is legal, and a shape may be about it."""
    if rng is None:
        chosen = every
    else:
        allowed = subclasses(graph, rng)
        chosen = [e for e in every if set(graph.objects(e, RDF.type)) & allowed]
    ordered = sorted(chosen, key=lambda e: (names(e).casefold(), str(e)))
    return [{"iri": str(e), "label": names(e)} for e in ordered[:OPTIONS_CAP]], len(ordered)


def _values(graph: Graph, node, prop, names: Names) -> list:
    out = []
    for value in sorted(graph.objects(node, prop), key=str):
        if isinstance(value, Literal):
            out.append(shapes_form.value_json(value, names))
        elif isinstance(value, URIRef):
            out.append({"kind": "link", "value": str(value), "label": names(value)})
    return out


def example_view(
    graph: Graph, node, names: Names, languages: list, own: Optional[Graph] = None
) -> Optional[dict]:
    """What an example's form shows (5.8), or None when `node` is not one.

    `graph` is the model with its imports where they are resolved; `own`,
    the document, is where the choices of a relationship come from."""
    if not is_example(graph, node):
        return None
    classes = example_classes(graph, node)
    every = examples(graph, own)
    fields: list[dict] = []
    seen: set = set()
    for cls in classes:
        for entry in shapes_form.paths_for(graph, cls, names, languages):
            if entry["kind"] not in ("attribute", "relationship"):
                continue
            prop = URIRef(entry["path"][0])
            if prop in seen:
                continue
            seen.add(prop)
            field = {
                "property": str(prop),
                "label": entry["label"],
                "kind": entry["kind"],
                "functional": entry["functional"],
                "values": _values(graph, node, prop, names),
            }
            if entry["kind"] == "attribute":
                field["datatype"] = entry.get("datatype")
            else:
                rng = URIRef(entry["range"]) if entry.get("range") else None
                field["range"] = entry.get("range")
                field["rangeLabel"] = entry.get("rangeLabel")
                field["options"], field["optionsTotal"] = _options(graph, rng, every, names)
            fields.append(field)
    fields.sort(key=lambda f: (f["kind"] != "attribute", f["label"].casefold(), f["property"]))
    return {
        "classes": [{"iri": str(c), "label": names(c)} for c in classes],
        "fields": fields,
    }


def by_class(graph: Graph, own: Optional[Graph] = None) -> dict:
    """class -> its examples, for the tree's Examples section (5.8). An
    example of two classes is listed under each, as a class with two
    parents is in the class tree."""
    out: dict = {}
    for example in examples(graph, own):
        for cls in example_classes(graph, example) or [OWL.NamedIndividual]:
            out.setdefault(cls, []).append(example)
    return out
