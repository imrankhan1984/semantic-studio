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

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a query-schema regression.
================================================================================
"""

from pathlib import Path

import pytest
from rdflib import Graph
from rdflib.namespace import OWL, RDF, SKOS

from app.query_schema import build_query_schema, describe_query_node

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
