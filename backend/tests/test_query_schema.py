"""
================================================================================
FILE: backend/tests/test_query_schema.py
================================================================================

SUMMARY
    Tests the class-level schema extraction: that classes (including SKOS
    concepts) are found, meta-classes excluded, links derived from observed
    data / domain+range / owl:Restriction axioms, the subclass hierarchy is
    exposed, data properties are found, and a clicked node maps to the right
    class(es).

BASIC IDEA
    The demo ontology deliberately contains OWL classes, SKOS concepts, and a
    restriction-based class (CrewedMission), so one fixed file exercises every
    schema-extraction path. Tests assert exact IRIs against the known example.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl.
    - The library's three bundled examples, for `prefixes`
      (query-page-rework 5.3), and a generated 100,000-statement file for
      its cache and its Section 10 limit.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a query-schema regression.
================================================================================
"""

import gc
import time
from pathlib import Path

import pytest
from rdflib import Graph
from rdflib.namespace import OWL, RDF, SKOS

from app.query_schema import build_query_schema, describe_query_node, used_prefixes

from budget import limit_ms

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"
SPACE = "http://example.org/space#"


@pytest.fixture(scope="module")
def graph() -> Graph:
    g = Graph()
    g.parse(EXAMPLE, format="turtle")
    return g


@pytest.fixture(scope="module")
def schema(graph) -> dict:
    return build_query_schema(graph)


def _class_iris(schema) -> set[str]:
    return {c["iri"] for c in schema["classes"]}


def _links(schema, source, predicate, target):
    return [
        link
        for link in schema["links"]
        if link["source"] == source and link["predicate"] == predicate and link["target"] == target
    ]


def test_classes_include_owl_classes(schema):
    iris = _class_iris(schema)
    assert SPACE + "Planet" in iris
    assert SPACE + "Star" in iris
    assert SPACE + "Spacecraft" in iris


def test_skos_types_are_steppable(schema):
    """SKOS taxonomies must be usable even though they declare no owl:Class."""
    iris = _class_iris(schema)
    assert str(SKOS.Concept) in iris
    assert str(SKOS.ConceptScheme) in iris
    concept = next(c for c in schema["classes"] if c["iri"] == str(SKOS.Concept))
    assert concept["instances"] == 4
    assert concept["kind"] == "concept"


def test_meta_classes_excluded(schema):
    iris = _class_iris(schema)
    assert str(OWL.Class) not in iris
    assert str(OWL.NamedIndividual) not in iris
    assert str(OWL.ObjectProperty) not in iris


def test_links_observed_from_instance_data(schema):
    # Earth (a Planet) orbits Sun (a Star)
    observed = _links(schema, SPACE + "Planet", SPACE + "orbits", SPACE + "Star")
    assert observed and observed[0]["count"] >= 1
    # TheMoon (a Moon) orbits Earth (a Planet)
    assert _links(schema, SPACE + "Moon", SPACE + "orbits", SPACE + "Planet")


def test_declared_links_are_recorded_once_not_expanded(schema):
    """Declared links stay at their declared level.

    Materializing them across every subclass pair explodes combinatorially
    on real ontologies, so subclasses inherit through superClasses instead.
    """
    assert _links(schema, SPACE + "CelestialBody", SPACE + "orbits", SPACE + "CelestialBody")
    # ...and is NOT duplicated onto each subclass pairing.
    assert not _links(schema, SPACE + "Planet", SPACE + "orbits", SPACE + "DwarfPlanet")
    assert _links(schema, SPACE + "Spacecraft", SPACE + "operatedBy", SPACE + "SpaceAgency")


def test_super_classes_exposed_for_inheritance(schema):
    supers = schema["superClasses"]
    assert supers[SPACE + "Planet"] == [SPACE + "CelestialBody"]
    assert supers[SPACE + "DwarfPlanet"] == [SPACE + "Planet"]
    # Classes without a parent are simply absent.
    assert SPACE + "CelestialBody" not in supers


def test_links_from_owl_restrictions(schema):
    """FIBO-style ontologies state relationships as restrictions."""
    # subClassOf [ onProperty :carries ; someValuesFrom :Astronaut ]
    carries = _links(schema, SPACE + "CrewedMission", SPACE + "carries", SPACE + "Astronaut")
    assert carries, "someValuesFrom restriction should produce a link"
    assert carries[0]["restriction"] is True
    assert carries[0]["declared"] is False

    # Nested inside an owl:intersectionOf, via allValuesFrom...
    assert _links(schema, SPACE + "CrewedMission", SPACE + "uses", SPACE + "Spacecraft")
    # ...and via a qualified cardinality restriction's owl:onClass.
    assert _links(
        SPACE and schema, SPACE + "CrewedMission", SPACE + "commandedBy", SPACE + "Astronaut"
    )


def test_restriction_only_classes_are_registered(schema):
    """A class reachable only through a restriction is still steppable."""
    assert SPACE + "Astronaut" in _class_iris(schema)


def test_domain_range_links_are_not_marked_as_restrictions(schema):
    orbits = _links(schema, SPACE + "CelestialBody", SPACE + "orbits", SPACE + "CelestialBody")
    assert orbits[0]["declared"] is True
    assert orbits[0]["restriction"] is False


def test_skos_hierarchy_links(schema):
    concept = str(SKOS.Concept)
    assert _links(schema, concept, str(SKOS.broader), concept)
    assert _links(schema, concept, str(SKOS.related), concept)
    assert _links(schema, concept, str(SKOS.inScheme), str(SKOS.ConceptScheme))


def test_schema_predicates_are_not_traversable(schema):
    predicates = {link["predicate"] for link in schema["links"]}
    assert str(RDF.type) not in predicates
    assert "http://www.w3.org/2000/01/rdf-schema#subClassOf" not in predicates


def test_data_properties(schema):
    # Observed on Planet instances (Earth/Mars carry :diameterKm directly).
    planet_props = schema["dataProperties"][SPACE + "Planet"]
    by_iri = {p["predicate"]: p for p in planet_props}
    assert SPACE + "diameterKm" in by_iri
    # The datatype reported is the one actually observed in the data, which
    # can be narrower than the declared range (values are written as bare
    # integers here even though rdfs:range says xsd:decimal). Filter inputs
    # should follow the real data.
    assert by_iri[SPACE + "diameterKm"]["datatypePrefixed"] in {"xsd:integer", "xsd:decimal"}
    assert by_iri[SPACE + "diameterKm"]["count"] >= 2

    craft_props = {p["predicate"] for p in schema["dataProperties"][SPACE + "Spacecraft"]}
    assert SPACE + "launchYear" in craft_props


def test_describe_query_node(graph, schema):
    # A class maps to itself
    planet = describe_query_node(graph, SPACE + "Planet", schema)
    assert planet["isClass"] is True

    # An individual maps to its type, so clicking it pins an instance
    earth = describe_query_node(graph, SPACE + "Earth", schema)
    assert earth["isClass"] is False
    assert SPACE + "Planet" in {t["iri"] for t in earth["types"]}
    assert earth["label"] == "Earth"

    # Multi-typed individuals put the most widely used type first, so the
    # caller's default pick is deterministic rather than parser order.
    sun = describe_query_node(graph, SPACE + "Sun", schema)
    counts = [t["instances"] for t in sun["types"]]
    assert counts == sorted(counts, reverse=True)

    # A SKOS concept maps to skos:Concept
    flyby = describe_query_node(graph, SPACE + "Flyby", schema)
    assert flyby["isClass"] is False
    assert str(SKOS.Concept) in {t["iri"] for t in flyby["types"]}

    assert describe_query_node(graph, SPACE + "NotThere", schema) is None


def test_namespaces_present(schema):
    assert schema["namespaces"]["skos"] == str(SKOS)
    assert schema["truncated"] is False


def test_rdfs_only_class_carries_class_type():
    """explore-and-query-layout 5.6 (AC-8): the start list colours an RDFS-only
    class as the graph does, so the schema says which classes are; graph_builder's
    rule, and nothing on any other entry."""
    g = Graph()
    g.parse(
        data="""
        @prefix ex: <http://example.org/> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        ex:Plain a rdfs:Class .
        ex:Owl a owl:Class .
        ex:Both a owl:Class, rdfs:Class .
        ex:Child rdfs:subClassOf ex:Plain .
        ex:thing a ex:Plain .
        """,
        format="turtle",
    )
    schema = build_query_schema(g)
    by_iri = {c["iri"]: c for c in schema["classes"]}
    ex = "http://example.org/"
    assert by_iri[ex + "Plain"]["classType"] == "rdfs"
    assert by_iri[ex + "Plain"]["kind"] == "class"
    # Typed owl:Class, or both, or not typed at all: no field.
    for name in ("Owl", "Both", "Child"):
        assert "classType" not in by_iri[ex + name], name


# --- a union domain read by every view (attribute-reuse 5.3, D-116) ---------------------

UNION_TTL = """
@prefix u: <http://example.org/u#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
u:Employee a owl:Class ; rdfs:label "Employee" .
u:Manager a owl:Class ; rdfs:label "Manager" ; rdfs:subClassOf u:Employee .
u:Contractor a owl:Class ; rdfs:label "Contractor" .
u:Team a owl:Class ; rdfs:label "Team" .
u:hasName a owl:DatatypeProperty ; rdfs:label "hasName" ; rdfs:range xsd:string ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( u:Employee u:Contractor ) ] .
u:leads a owl:ObjectProperty ; rdfs:label "leads" ; rdfs:range u:Team ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( u:Employee u:Contractor ) ] .
u:badge a owl:DatatypeProperty ; rdfs:label "badge" ; rdfs:range xsd:string ;
    rdfs:domain u:Manager , u:Team .
"""
UNI = "http://example.org/u#"


def _union_graph():
    from rdflib import Graph

    return Graph().parse(data=UNION_TTL, format="turtle")


def test_a_union_domain_gives_one_link_from_each_member():
    """AC-8: the visual query builder steps from either member."""
    schema = build_query_schema(_union_graph())
    for member in ("Employee", "Contractor"):
        assert _links(schema, UNI + member, UNI + "leads", UNI + "Team"), member
    assert {UNI + "Employee", UNI + "Contractor"} <= _class_iris(schema)


# --- prefixes: what a new text query starts with (query-page-rework 5.3) ---

APP = Path(__file__).parent.parent / "app"


def _parsed(relative: str, fmt: str) -> Graph:
    g = Graph()
    g.parse(APP / relative, format=fmt)
    return g


COMMON = {
    "dcterms": "http://purl.org/dc/terms/",
    "owl": "http://www.w3.org/2002/07/owl#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
}


def test_prefixes_for_the_three_examples_are_exactly_5_3s():
    """AC-5. The bundled examples, as the library holds them."""
    space = build_query_schema(_parsed("examples/space-exploration.ttl", "turtle"))["prefixes"]
    assert space == {**COMMON, "space": "http://example.org/space#"}
    assert list(space) == sorted(space), "sorted by prefix"
    earth = build_query_schema(_parsed("examples/middle-earth.ttl", "turtle"))["prefixes"]
    assert set(earth) == set(COMMON) | {"me"}
    foaf = build_query_schema(_parsed("vocab/foaf.rdf", "xml"))["prefixes"]
    assert sorted(foaf) == ["dc", "dcterms", "foaf", "owl", "rdf", "rdfs", "skos", "vs", "wot"]


def test_an_rdflib_default_the_file_never_uses_is_absent():
    """rdflib binds brick: into every graph; the namespaces carry it, the
    prefixes never, until a statement uses it."""
    g = Graph()
    g.parse(data='@prefix ex: <http://example.org/p#> . ex:a ex:b "c" .', format="turtle")
    schema = build_query_schema(g)
    assert "brick" in schema["namespaces"]
    assert schema["prefixes"] == {"ex": "http://example.org/p#"}
    g.parse(data="<http://example.org/p#a> <http://example.org/p#b> <https://brickschema.org/schema/Brick#Site> .", format="turtle")
    assert "brick" in build_query_schema(g)["prefixes"]


def test_a_datatype_counts_as_use_and_a_binding_without_a_separator_matches():
    g = Graph()
    g.bind("ex", "http://example.org/q#")
    g.bind("u", "urn:example:")
    g.parse(data='<urn:example:a> <http://example.org/q#n> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .', format="turtle")
    prefixes = used_prefixes(g)
    assert prefixes["xsd"] == "http://www.w3.org/2001/XMLSchema#"
    assert prefixes["u"] == "urn:example:"
    assert prefixes["ex"] == "http://example.org/q#"


def test_a_prefix_rdflib_generated_is_never_listed():
    """Asking for a qname binds `ns1` into the graph (graph_builder.prefixed);
    the views that ran first must not change what a query starts with."""
    g = Graph()
    g.parse(data="<http://example.org/unbound#a> <http://example.org/unbound#b> <http://example.org/unbound#c> .", format="turtle")
    g.namespace_manager.qname("http://example.org/unbound#a")
    assert "ns1" in dict(g.namespaces())
    assert "ns1" not in used_prefixes(g)


def _hundred_thousand() -> bytes:
    """100,000 statements: 25,000 labelled individuals of four classes, each
    with a value and a link, under one example.org namespace."""
    ex = "http://example.org/scale#"
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    xsd_int = "http://www.w3.org/2001/XMLSchema#integer"
    out = []
    for i in range(25000):
        out.append(f"<{ex}i{i}> <{type_}> <{ex}C{i % 4}> .")
        out.append(f'<{ex}i{i}> <{label}> "Item {i}" .')
        out.append(f'<{ex}i{i}> <{ex}value> "{i}"^^<{xsd_int}> .')
        out.append(f"<{ex}i{i}> <{ex}next> <{ex}i{(i + 1) % 25000}> .")
    return ("\n".join(out) + "\n").encode("utf-8")


@pytest.fixture(scope="module")
def scale_client():
    from fastapi.testclient import TestClient

    from app import main

    client = TestClient(main.app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})
    response = client.post(
        "/api/ontologies/upload", files={"file": ("scale-100k.nt", _hundred_thousand(), "application/n-triples")}
    )
    assert response.status_code == 200, response.text
    return client, response.json()["id"]


def test_prefixes_are_cached_with_the_schema_per_revision(scale_client, monkeypatch):
    """Computed once per revision (D-081): a second request reads the cache."""
    from app import query_schema
    from app.store import store

    client, oid = scale_client
    calls = []
    real = query_schema.used_prefixes
    monkeypatch.setattr(query_schema, "used_prefixes", lambda g: calls.append(1) or real(g))
    ontology = store.get(oid)
    ontology.schema_cache = None
    first = client.get(f"/api/ontologies/{oid}/query-schema").json()["prefixes"]
    second = client.get(f"/api/ontologies/{oid}/query-schema").json()["prefixes"]
    assert first == second
    # N-Triples binds nothing, so only what rdflib binds and the file uses.
    assert set(first) == {"rdf", "rdfs", "xsd"}
    assert len(calls) == 1
    # A new revision is a new schema, and so new prefixes.
    ontology.revision += 1
    try:
        client.get(f"/api/ontologies/{oid}/query-schema")
        assert len(calls) == 2
    finally:
        ontology.revision -= 1
        ontology.schema_cache = None


def _median(call, runs: int = 5) -> float:
    samples = []
    gc.disable()
    try:
        for _ in range(runs):
            start = time.perf_counter()
            call()
            samples.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return sorted(samples)[len(samples) // 2]


@pytest.mark.perf
def test_prefixes_cost_on_100000_statements(scale_client):
    """Section 10: the uses scan at most 400 ms on 100,000 statements, the
    first request for a revision's share of it; a second request at most
    5 ms, from the cache. Medians of five, the collector paused (D-024)."""
    from app.store import store

    client, oid = scale_client
    graph = store.get(oid).ensure_loaded()
    assert len(graph) == 100000
    used_prefixes(graph)  # warm-up
    first = _median(lambda: used_prefixes(graph))
    assert first <= limit_ms(400), f"the scan took {first:.1f} ms"
    client.get(f"/api/ontologies/{oid}/query-schema")  # fills the cache
    second = _median(lambda: client.get(f"/api/ontologies/{oid}/query-schema"))
    assert second <= limit_ms(5), f"a cached request took {second:.1f} ms"
