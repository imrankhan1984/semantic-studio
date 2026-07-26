"""Class-level schema extraction for the visual query builder.

The visualization graph (``graph_builder``) describes individual entities.
The query builder needs something different: how *types* relate to each
other — which predicates connect instances of class A to instances of
class B, and which literal-valued predicates a class carries.

Both are derived from two sources:

1. **Declared axioms** — ``rdfs:domain`` / ``rdfs:range`` on properties,
   propagated down the ``rdfs:subClassOf`` hierarchy.
2. **Observed instance data** — actual triples between typed resources.
   This is what makes real-world datasets (and SKOS taxonomies, where
   ``skos:Concept`` is the only "class") usable in the builder.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

from .graph_builder import pick_label, prefixed

# Meta-classes: never offered as steppable classes in the builder.
META_CLASSES = {
    OWL.Class,
    RDFS.Class,
    RDF.Property,
    RDF.List,
    OWL.ObjectProperty,
    OWL.DatatypeProperty,
    OWL.AnnotationProperty,
    OWL.FunctionalProperty,
    OWL.InverseFunctionalProperty,
    OWL.TransitiveProperty,
    OWL.SymmetricProperty,
    OWL.ReflexiveProperty,
    OWL.IrreflexiveProperty,
    OWL.AsymmetricProperty,
    OWL.Ontology,
    OWL.NamedIndividual,
    OWL.Restriction,
    OWL.Thing,
    RDFS.Datatype,
    RDFS.Resource,
    RDFS.Container,
    RDFS.ContainerMembershipProperty,
}

# Predicates that describe the schema itself rather than links between
# things — they must not become traversable hops.
SCHEMA_PREDICATES = {
    RDF.type,
    RDF.first,
    RDF.rest,
    RDFS.subClassOf,
    RDFS.subPropertyOf,
    RDFS.domain,
    RDFS.range,
    RDFS.isDefinedBy,
    OWL.equivalentClass,
    OWL.equivalentProperty,
    OWL.disjointWith,
    OWL.inverseOf,
    OWL.imports,
    OWL.onProperty,
    OWL.someValuesFrom,
    OWL.allValuesFrom,
    OWL.hasValue,
    OWL.unionOf,
    OWL.intersectionOf,
    OWL.complementOf,
    OWL.oneOf,
    OWL.versionInfo,
}

# SKOS types are treated as first-class steppable types so taxonomies work.
SKOS_PSEUDO_CLASSES = {
    SKOS.Concept,
    SKOS.ConceptScheme,
    SKOS.Collection,
    SKOS.OrderedCollection,
}

CLASS_KINDS = {
    SKOS.Concept: "concept",
    SKOS.ConceptScheme: "conceptScheme",
    SKOS.Collection: "collection",
    SKOS.OrderedCollection: "collection",
}

XSD_NS = str(XSD)

# Safety caps so pathological ontologies cannot blow up the response.
MAX_LINKS = 60000
MAX_DATA_PROPS_PER_CLASS = 200


def _is_literal_type(iri: URIRef) -> bool:
    return str(iri).startswith(XSD_NS) or iri == RDF.langString


def build_query_schema(graph: Graph) -> dict:
    """Extract the class-level schema used by the visual query builder."""
    truncated = False

    # --- 1. which types can instances have? ------------------------------
    type_counts: Counter[URIRef] = Counter()
    instance_types: dict[URIRef, list[URIRef]] = defaultdict(list)
    for subject, obj in graph.subject_objects(RDF.type):
        if not isinstance(subject, URIRef) or not isinstance(obj, URIRef):
            continue
        if obj in META_CLASSES:
            continue
        type_counts[obj] += 1
        instance_types[subject].append(obj)

    classes: set[URIRef] = set(type_counts)

    # Declared classes, even when they have no instances.
    for subject, obj in graph.subject_objects(RDF.type):
        if isinstance(subject, URIRef) and obj in (OWL.Class, RDFS.Class):
            if subject not in META_CLASSES:
                classes.add(subject)

    super_classes: dict[URIRef, set[URIRef]] = defaultdict(set)
    for subject, obj in graph.subject_objects(RDFS.subClassOf):
        if isinstance(subject, URIRef) and isinstance(obj, URIRef):
            if subject not in META_CLASSES:
                classes.add(subject)
            if obj not in META_CLASSES:
                classes.add(obj)
            if subject != obj:
                super_classes[subject].add(obj)

    for _, obj in graph.subject_objects(RDFS.domain):
        if isinstance(obj, URIRef) and obj not in META_CLASSES:
            classes.add(obj)
    for _, obj in graph.subject_objects(RDFS.range):
        if isinstance(obj, URIRef) and obj not in META_CLASSES:
            if not _is_literal_type(obj):
                classes.add(obj)

    # --- 2. links declared through domain / range ------------------------
    links: dict[tuple[URIRef, URIRef, URIRef], dict] = {}

    def add_link(src: URIRef, pred: URIRef, dst: URIRef, *, declared: bool, count: int = 0) -> None:
        nonlocal truncated
        if src not in classes or dst not in classes:
            return
        key = (src, pred, dst)
        entry = links.get(key)
        if entry is None:
            if len(links) >= MAX_LINKS:
                truncated = True
                return
            links[key] = {"declared": declared, "count": count}
        else:
            entry["declared"] = entry["declared"] or declared
            entry["count"] += count

    for prop in set(graph.subjects(RDFS.domain, None)) | set(graph.subjects(RDFS.range, None)):
        if not isinstance(prop, URIRef):
            continue
        domains = [d for d in graph.objects(prop, RDFS.domain) if isinstance(d, URIRef)]
        ranges = [
            r
            for r in graph.objects(prop, RDFS.range)
            if isinstance(r, URIRef) and not _is_literal_type(r)
        ]
        if not domains or not ranges:
            continue
        # Recorded once, at the level it is declared. Subclasses inherit it
        # through the subClassOf map below: materializing the cross-product
        # here explodes on real ontologies (one FIBO property with a broad
        # domain and range produced thousands of near-identical links).
        for domain in domains:
            for range_ in ranges:
                add_link(domain, prop, range_, declared=True)

    # --- 3. links and data properties observed in the instance data ------
    data_counts: dict[tuple[URIRef, URIRef], Counter] = defaultdict(Counter)
    observed: Counter[tuple[URIRef, URIRef, URIRef]] = Counter()

    for subject, predicate, obj in graph:
        if predicate in SCHEMA_PREDICATES or not isinstance(subject, URIRef):
            continue
        subject_types = instance_types.get(subject)
        if not subject_types:
            continue
        if isinstance(obj, URIRef):
            object_types = instance_types.get(obj)
            if not object_types:
                continue
            for src in subject_types:
                for dst in object_types:
                    observed[(src, predicate, dst)] += 1
        elif isinstance(obj, Literal):
            datatype = obj.datatype or (RDF.langString if obj.language else XSD.string)
            for src in subject_types:
                data_counts[(src, predicate)][datatype] += 1

    for (src, predicate, dst), count in observed.items():
        add_link(src, predicate, dst, declared=False, count=count)

    # Declared datatype properties, even without instance data.
    for prop in graph.subjects(RDF.type, OWL.DatatypeProperty):
        if not isinstance(prop, URIRef):
            continue
        ranges = [r for r in graph.objects(prop, RDFS.range) if isinstance(r, URIRef)]
        datatype = ranges[0] if ranges else XSD.string
        # Also recorded at the declared level only; subclasses inherit.
        for domain in graph.objects(prop, RDFS.domain):
            if not isinstance(domain, URIRef) or domain not in classes:
                continue
            if not data_counts[(domain, prop)]:
                data_counts[(domain, prop)][datatype] = 0

    # --- 4. serialize ----------------------------------------------------
    label_cache: dict[URIRef, str] = {}

    def label_of(iri: URIRef) -> str:
        cached = label_cache.get(iri)
        if cached is None:
            cached = pick_label(graph, iri)
            label_cache[iri] = cached
        return cached

    classes_out = [
        {
            "iri": str(iri),
            "label": label_of(iri),
            "prefixed": prefixed(graph, iri),
            "instances": type_counts.get(iri, 0),
            "kind": CLASS_KINDS.get(iri, "class"),
        }
        for iri in classes
    ]
    classes_out.sort(key=lambda c: (-c["instances"], c["label"].lower()))

    links_out = [
        {
            "source": str(src),
            "target": str(dst),
            "predicate": str(pred),
            "label": label_of(pred),
            "prefixed": prefixed(graph, pred),
            "declared": entry["declared"],
            "count": entry["count"],
        }
        for (src, pred, dst), entry in links.items()
    ]
    links_out.sort(key=lambda link: (link["source"], -link["count"], link["predicate"]))

    data_props: dict[str, list[dict]] = defaultdict(list)
    for (cls, predicate), datatypes in data_counts.items():
        if cls not in classes:
            continue
        bucket = data_props[str(cls)]
        if len(bucket) >= MAX_DATA_PROPS_PER_CLASS:
            truncated = True
            continue
        datatype, _ = datatypes.most_common(1)[0] if datatypes else (XSD.string, 0)
        bucket.append(
            {
                "predicate": str(predicate),
                "label": label_of(predicate),
                "prefixed": prefixed(graph, predicate),
                "datatype": str(datatype),
                "datatypePrefixed": prefixed(graph, datatype),
                "count": sum(datatypes.values()),
            }
        )
    for bucket in data_props.values():
        bucket.sort(key=lambda p: p["label"].lower())

    # Direct parents only — callers walk this to inherit declared links and
    # data properties, which keeps the payload small.
    super_out = {
        str(child): sorted(str(parent) for parent in parents if parent in classes)
        for child, parents in super_classes.items()
        if child in classes and parents
    }
    super_out = {k: v for k, v in super_out.items() if v}

    return {
        "classes": classes_out,
        "links": links_out,
        "superClasses": super_out,
        "dataProperties": dict(data_props),
        # The empty prefix is kept: many ontologies declare `@prefix : <...>`
        # for their own terms, and `PREFIX : <...>` / `:Term` is valid SPARQL.
        "namespaces": {prefix: str(ns) for prefix, ns in graph.namespaces()},
        "truncated": truncated,
    }


def describe_query_node(graph: Graph, iri: str, schema: dict) -> Optional[dict]:
    """Map a clicked graph node to the class the query builder should use.

    Returns the node itself when it *is* a class, otherwise the types it is
    an instance of (so clicking a SKOS concept steps on ``skos:Concept``
    while pinning that concept).
    """
    ref = URIRef(iri)
    known = {cls["iri"]: cls for cls in schema["classes"]}
    if iri in known:
        return {"iri": iri, "isClass": True, "label": known[iri]["label"], "types": []}

    types = []
    for obj in graph.objects(ref, RDF.type):
        if isinstance(obj, URIRef) and str(obj) in known:
            types.append(known[str(obj)])
    if not types:
        return None
    # Real ontologies type an individual many times over (a FIBO entity can
    # carry a dozen). Order them so the caller's default pick is the type
    # most of the data shares, rather than whatever the parser emitted first.
    types.sort(key=lambda t: (-t["instances"], t["label"].lower()))
    return {
        "iri": iri,
        "isClass": False,
        "label": pick_label(graph, ref),
        "types": types,
    }
