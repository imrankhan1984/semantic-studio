"""
================================================================================
FILE: backend/app/query_schema.py
================================================================================

SUMMARY
    Extracts the CLASS-LEVEL schema the visual query builder needs: which
    classes exist, which predicates connect one class to another (in either
    direction), the subclass hierarchy, and which literal-valued (data)
    properties each class carries.

BASIC IDEA
    graph_builder describes individual ENTITIES; the query builder instead
    needs to know how *types* relate — e.g. "instances of Corporation are
    incorporatedIn a Jurisdiction". Those relationships come from three
    sources, combined here:
      1. Declared axioms: rdfs:domain / rdfs:range on properties.
      2. OWL restrictions: `Class subClassOf [ onProperty p ; someValuesFrom T ]`,
         often nested in intersections — the style FIBO uses for most relations.
      3. Observed instance data: actual triples between typed resources, which
         is what makes real datasets and SKOS taxonomies usable.
    Declared/restriction links are recorded once at the level they are stated;
    the frontend inherits them down the subclass hierarchy at lookup time
    (materializing every subclass pair here explodes combinatorially on FIBO).

INPUTS / INPUT SOURCES
    - An rdflib.Graph (from store.Ontology.ensure_loaded), via build_query_schema.
    - A clicked node's IRI plus the already-built schema, via describe_query_node.

EXPECTED OUTPUT
    - build_query_schema -> a JSON-ready dict with keys: classes, links,
      superClasses, dataProperties, namespaces, truncated. Consumed by
      frontend/src/sparql/useQueryBuilder.ts.
    - describe_query_node -> how a clicked node maps to a steppable class (the
      class itself, or the types of an individual, best-shared type first).

SAFETY
    Bounded by MAX_LINKS / MAX_DATA_PROPS_PER_CLASS / MAX_EXPRESSION_DEPTH so a
    pathological ontology cannot blow up memory or the response.
================================================================================
"""

from __future__ import annotations

# Counter    - tally instance counts and observed-link frequencies
# defaultdict - accumulate multi-valued maps (types per subject, parents per class)
from collections import Counter, defaultdict
from typing import Optional

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

# Shared label/prefix helpers keep class and predicate labels consistent with
# the graph view; subclass_parents is the one asserted subClassOf pass, shared
# with the hierarchy view so both read the class hierarchy identically.
from .graph_builder import pick_label, prefixed, subclass_parents

# Meta-classes: the RDF/OWL vocabulary terms themselves. These describe the
# schema language, so they are never offered as steppable classes to query.
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

# SKOS taxonomies declare no owl:Class, so their concepts are the only thing
# worth querying. These SKOS types are therefore treated as steppable "classes".
SKOS_PSEUDO_CLASSES = {
    SKOS.Concept,
    SKOS.ConceptScheme,
    SKOS.Collection,
    SKOS.OrderedCollection,
}

# Maps a steppable SKOS type to the node "kind" the frontend colours it with;
# anything not listed defaults to "class".
CLASS_KINDS = {
    SKOS.Concept: "concept",
    SKOS.ConceptScheme: "conceptScheme",
    SKOS.Collection: "collection",
    SKOS.OrderedCollection: "collection",
}

# XSD namespace prefix, used to recognise literal (data) ranges.
XSD_NS = str(XSD)

# Safety caps so pathological ontologies cannot blow up the response.
MAX_LINKS = 60000
MAX_DATA_PROPS_PER_CLASS = 200
# Class expressions nest (intersections of restrictions of unions...), so
# the walker is depth-limited as well as cycle-guarded.
MAX_EXPRESSION_DEPTH = 8

# Restriction fillers that name the class on the other end of the relation.
RESTRICTION_FILLERS = (
    OWL.someValuesFrom,
    OWL.allValuesFrom,
    OWL.onClass,
)

# Where a class expression can hang off a class.
CLASS_EXPRESSION_PREDICATES = (RDFS.subClassOf, OWL.equivalentClass)

# Set operators whose members are themselves class expressions.
SET_OPERATORS = (OWL.intersectionOf, OWL.unionOf)


def _is_literal_type(iri: URIRef) -> bool:
    """True for a datatype (xsd:* or rdf:langString) — i.e. a data range, not a class."""
    return str(iri).startswith(XSD_NS) or iri == RDF.langString


def _list_items(graph: Graph, head) -> list:
    """Members of an RDF collection (the rdf:first/rdf:rest linked list).

    OWL set operators (intersectionOf/unionOf) point at such lists.
    Cycle-guarded via `seen` in case of a malformed self-referential list.
    """
    items: list = []
    seen: set = set()
    current = head
    while current is not None and current != RDF.nil and current not in seen:
        seen.add(current)
        # rdf:first holds this cell's value; rdf:rest points to the next cell.
        items.extend(graph.objects(current, RDF.first))
        current = next(iter(graph.objects(current, RDF.rest)), None)
    return items


def _named_classes(graph: Graph, expression, depth: int) -> list[URIRef]:
    """Named classes buried inside a nested set expression (union/intersection)."""
    # Depth guard: class expressions can nest arbitrarily.
    if depth > MAX_EXPRESSION_DEPTH:
        return []
    found: list[URIRef] = []
    for operator in SET_OPERATORS:
        for collection in graph.objects(expression, operator):
            for member in _list_items(graph, collection):
                if isinstance(member, URIRef):
                    found.append(member)
                elif isinstance(member, BNode):
                    found.extend(_named_classes(graph, member, depth + 1))
    return found


def _restriction_targets(
    graph: Graph,
    expression,
    instance_types: dict,
    depth: int = 0,
    visited: Optional[set] = None,
):
    """Yield (property, target class) pairs stated by a class expression.

    Ontologies like FIBO express most of their relationships as OWL
    restrictions rather than rdfs:domain / rdfs:range — typically
    ``Class subClassOf [ onProperty p ; someValuesFrom T ]``, often nested
    inside an intersection — so those axioms are read here too.
    """
    # Depth and cycle guards: expressions nest and can (in bad data) loop.
    if depth > MAX_EXPRESSION_DEPTH:
        return
    if visited is None:
        visited = set()
    if expression in visited:
        return
    visited.add(expression)

    # A restriction pins one property via owl:onProperty; find it.
    prop = next(
        (p for p in graph.objects(expression, OWL.onProperty) if isinstance(p, URIRef)),
        None,
    )
    if prop is not None:
        # The filler (someValuesFrom / allValuesFrom / onClass) names the class
        # on the other end of the relationship.
        for filler_predicate in RESTRICTION_FILLERS:
            for filler in graph.objects(expression, filler_predicate):
                if isinstance(filler, URIRef):
                    yield prop, filler
                elif isinstance(filler, BNode):
                    for named in _named_classes(graph, filler, depth + 1):
                        yield prop, named
        # owl:hasValue names an individual; its types stand in for the class.
        for value in graph.objects(expression, OWL.hasValue):
            if isinstance(value, URIRef):
                for value_type in instance_types.get(value, ()):
                    yield prop, value_type

    # A restriction can be nested inside an intersection/union; recurse in.
    for operator in SET_OPERATORS:
        for collection in graph.objects(expression, operator):
            for member in _list_items(graph, collection):
                if isinstance(member, (BNode, URIRef)):
                    yield from _restriction_targets(
                        graph, member, instance_types, depth + 1, visited
                    )


def build_query_schema(graph: Graph) -> dict:
    """Extract the class-level schema used by the visual query builder.

    Runs in five phases (typing -> restrictions -> domain/range -> observed
    instance data -> serialize) and returns the JSON dict the frontend uses.
    `truncated` is set if any safety cap was hit.
    """
    truncated = False

    # --- 1. which types can instances have? ------------------------------
    # type_counts: how many instances each class has (drives ranking/starters).
    # instance_types: for each resource, the list of classes it is an instance of.
    type_counts: Counter[URIRef] = Counter()
    instance_types: dict[URIRef, list[URIRef]] = defaultdict(list)
    for subject, obj in graph.subject_objects(RDF.type):
        if not isinstance(subject, URIRef) or not isinstance(obj, URIRef):
            continue
        # Ignore the vocabulary meta-classes; they are not queryable types.
        if obj in META_CLASSES:
            continue
        type_counts[obj] += 1
        instance_types[subject].append(obj)

    # Start the class set with every type that has at least one instance.
    classes: set[URIRef] = set(type_counts)

    # Also include classes that are DECLARED but have no instances, so an empty
    # ontology schema still lists them.
    for subject, obj in graph.subject_objects(RDF.type):
        if isinstance(subject, URIRef) and obj in (OWL.Class, RDFS.Class):
            if subject not in META_CLASSES:
                classes.add(subject)

    # Record direct parents (child -> {parents}) via the shared asserted
    # subClassOf pass; the frontend walks this to inherit links/properties down
    # the hierarchy at lookup time. Both ends of every subClassOf are classes
    # worth listing, so they join the class set here regardless of whether the
    # helper kept the edge (it drops a class that is a subclass of itself).
    super_classes = subclass_parents(graph)
    for subject, obj in graph.subject_objects(RDFS.subClassOf):
        if isinstance(subject, URIRef) and subject not in META_CLASSES:
            classes.add(subject)
        if isinstance(obj, URIRef) and obj not in META_CLASSES:
            classes.add(obj)

    # Any class used as a property's domain or (non-literal) range is a class
    # worth listing, even if nothing is typed as it directly.
    for _, obj in graph.subject_objects(RDFS.domain):
        if isinstance(obj, URIRef) and obj not in META_CLASSES:
            classes.add(obj)
    for _, obj in graph.subject_objects(RDFS.range):
        if isinstance(obj, URIRef) and obj not in META_CLASSES:
            if not _is_literal_type(obj):  # literal ranges are data props, not classes
                classes.add(obj)

    # --- 2. relationships stated as OWL restrictions ---------------------
    # Collected before links are built so restriction fillers can join the
    # class set; otherwise the links would be dropped as unknown classes.
    restriction_links: list[tuple[URIRef, URIRef, URIRef]] = []
    for cls in list(classes):
        for expression_predicate in CLASS_EXPRESSION_PREDICATES:
            for expression in graph.objects(cls, expression_predicate):
                if not isinstance(expression, BNode):
                    continue
                for prop, target in _restriction_targets(graph, expression, instance_types):
                    if target in META_CLASSES or _is_literal_type(target):
                        continue
                    classes.add(target)
                    restriction_links.append((cls, prop, target))

    # --- 3. links declared through domain / range ------------------------
    # links: keyed by (source class, predicate, target class) -> provenance dict
    # {declared, restriction, count}. add_link merges duplicates and enforces
    # the MAX_LINKS cap.
    links: dict[tuple[URIRef, URIRef, URIRef], dict] = {}

    def add_link(
        src: URIRef,
        pred: URIRef,
        dst: URIRef,
        *,
        declared: bool,
        count: int = 0,
        restriction: bool = False,
    ) -> None:
        nonlocal truncated
        # Both endpoints must be known classes, or there is nothing to step to.
        if src not in classes or dst not in classes:
            return
        key = (src, pred, dst)
        entry = links.get(key)
        if entry is None:
            # New link: respect the cap (flag truncation and drop it if over).
            if len(links) >= MAX_LINKS:
                truncated = True
                return
            links[key] = {"declared": declared, "count": count, "restriction": restriction}
        else:
            # Existing link: merge provenance flags and add to the observed count.
            entry["declared"] = entry["declared"] or declared
            entry["restriction"] = entry["restriction"] or restriction
            entry["count"] += count

    # Feed in the restriction-derived links gathered in phase 2.
    for src, prop, target in restriction_links:
        add_link(src, prop, target, declared=False, restriction=True)

    # Every property that declares a domain and/or a range becomes a link from
    # each declared domain class to each declared (non-literal) range class.
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

    # --- 4. links and data properties observed in the instance data ------
    # data_counts: (class, predicate) -> Counter of datatypes seen (literal props).
    # observed:    (srcClass, predicate, dstClass) -> how often it actually occurs.
    data_counts: dict[tuple[URIRef, URIRef], Counter] = defaultdict(Counter)
    observed: Counter[tuple[URIRef, URIRef, URIRef]] = Counter()

    # Scan every triple once, attributing it to the subject's (and object's) types.
    for subject, predicate, obj in graph:
        # Skip schema-defining predicates and unnamed subjects.
        if predicate in SCHEMA_PREDICATES or not isinstance(subject, URIRef):
            continue
        subject_types = instance_types.get(subject)
        if not subject_types:
            continue
        if isinstance(obj, URIRef):
            # Object is a resource: this is a class-to-class link, per its types.
            object_types = instance_types.get(obj)
            if not object_types:
                continue
            for src in subject_types:
                for dst in object_types:
                    observed[(src, predicate, dst)] += 1
        elif isinstance(obj, Literal):
            # Object is a literal: this is a data property; record its datatype.
            datatype = obj.datatype or (RDF.langString if obj.language else XSD.string)
            for src in subject_types:
                data_counts[(src, predicate)][datatype] += 1

    # Turn observed class-to-class occurrences into links (with their counts).
    for (src, predicate, dst), count in observed.items():
        add_link(src, predicate, dst, declared=False, count=count)

    # Include declared datatype properties even when no instance uses them yet.
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

    # --- 5. serialize ----------------------------------------------------
    # Label lookups are repeated across classes/links; cache them.
    label_cache: dict[URIRef, str] = {}

    def label_of(iri: URIRef) -> str:
        cached = label_cache.get(iri)
        if cached is None:
            cached = pick_label(graph, iri)
            label_cache[iri] = cached
        return cached

    # Classes, richest first (most instances, then alphabetical) so the UI's
    # "start from" list and starters surface the useful ones.
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
            "restriction": entry["restriction"],
            "count": entry["count"],
        }
        for (src, pred, dst), entry in links.items()
    ]
    links_out.sort(key=lambda link: (link["source"], -link["count"], link["predicate"]))

    # Data (literal-valued) properties, grouped per class.
    data_props: dict[str, list[dict]] = defaultdict(list)
    for (cls, predicate), datatypes in data_counts.items():
        if cls not in classes:
            continue
        bucket = data_props[str(cls)]
        # Cap how many data props one class can carry, to bound the payload.
        if len(bucket) >= MAX_DATA_PROPS_PER_CLASS:
            truncated = True
            continue
        # Report the most commonly observed datatype for filter-input typing.
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
    # Index the schema's classes by IRI for O(1) membership checks.
    known = {cls["iri"]: cls for cls in schema["classes"]}
    # If the clicked node IS a class, step directly on it.
    if iri in known:
        return {"iri": iri, "isClass": True, "label": known[iri]["label"], "types": []}

    # Otherwise it is (presumably) an individual: collect its known types.
    types = []
    for obj in graph.objects(ref, RDF.type):
        if isinstance(obj, URIRef) and str(obj) in known:
            types.append(known[str(obj)])
    if not types:
        return None  # not a class and untyped -> nothing to query on
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
