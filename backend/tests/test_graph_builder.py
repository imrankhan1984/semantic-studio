"""
================================================================================
FILE: backend/tests/test_graph_builder.py
================================================================================

SUMMARY
    Unit tests for graph_builder: verifies that the demo ontology is turned
    into the right nodes (with correct kinds), the right structural/assertion
    edges, correct node-detail output, working search, and correct format
    detection/sniffing.

BASIC IDEA
    Parse the shipped example ontology once (fixtures), build the viz graph
    from it, then assert specific nodes/edges/details exist and are shaped as
    the frontend expects. Because the example is fixed and known, exact IRIs
    can be asserted.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl (a small, known ontology).

EXPECTED OUTPUT
    - Pass/fail per assertion; failures pinpoint a regression in graph_builder.
================================================================================
"""

from pathlib import Path

import pytest
from rdflib import Graph

from app.graph_builder import budget_viz, build_viz_graph, node_details, search_nodes
from app.store import detect_format, parse_rdf

# The shipped demo ontology and its namespace, reused across assertions.
EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"
SPACE = "http://example.org/space#"


@pytest.fixture(scope="module")
def graph() -> Graph:
    g = Graph()
    g.parse(EXAMPLE, format="turtle")
    return g


@pytest.fixture(scope="module")
def viz(graph) -> dict:
    return build_viz_graph(graph)


def _node(viz, iri):
    return next(n for n in viz["nodes"] if n["id"] == iri)


def _edges(viz, kind):
    return [e for e in viz["edges"] if e["kind"] == kind]


def test_kinds(viz):
    assert _node(viz, SPACE + "Planet")["kind"] == "class"
    assert _node(viz, SPACE + "orbits")["kind"] == "objectProperty"
    assert _node(viz, SPACE + "launchYear")["kind"] == "datatypeProperty"
    assert _node(viz, SPACE + "Earth")["kind"] == "individual"
    assert _node(viz, SPACE + "Flyby")["kind"] == "concept"
    assert _node(viz, SPACE + "MissionTypeScheme")["kind"] == "conceptScheme"


def test_structural_edges(viz):
    subclass = {(e["source"], e["target"]) for e in _edges(viz, "subClassOf")}
    assert (SPACE + "Planet", SPACE + "CelestialBody") in subclass
    assert (SPACE + "DwarfPlanet", SPACE + "Planet") in subclass

    domains = {(e["source"], e["target"]) for e in _edges(viz, "domain")}
    assert (SPACE + "orbits", SPACE + "CelestialBody") in domains

    # xsd ranges must not become graph edges
    ranges = {e["target"] for e in _edges(viz, "range")}
    assert all(not t.startswith("http://www.w3.org/2001/XMLSchema#") for t in ranges)


def test_skos_edges_normalized(viz):
    broader = {(e["source"], e["target"]) for e in _edges(viz, "broader")}
    assert (SPACE + "Flyby", SPACE + "Exploration") in broader
    # hasTopConcept inverted into inScheme
    in_scheme = {(e["source"], e["target"]) for e in _edges(viz, "inScheme")}
    assert (SPACE + "Exploration", SPACE + "MissionTypeScheme") in in_scheme


def test_assertions(viz):
    assertions = {
        (e["source"], e["label"], e["target"]) for e in _edges(viz, "assertion")
    }
    assert (SPACE + "Earth", "orbits", SPACE + "Sun") in assertions
    assert (SPACE + "Voyager1", "operatedBy", SPACE + "NASA") in assertions


def test_instance_of(viz):
    instance_of = {(e["source"], e["target"]) for e in _edges(viz, "instanceOf")}
    assert (SPACE + "Earth", SPACE + "Planet") in instance_of


def test_node_details(graph):
    details = node_details(graph, SPACE + "Earth")
    assert details["label"] == "Earth"
    predicates = {o["predicate"]["value"] for o in details["outgoing"]}
    assert SPACE + "orbits" in predicates
    incoming_subjects = {i["subject"]["value"] for i in details["incoming"]}
    assert SPACE + "TheMoon" in incoming_subjects
    assert node_details(graph, SPACE + "DoesNotExist") is None


def test_search(viz):
    results = search_nodes(viz, "mars")
    ids = [r["id"] for r in results]
    assert SPACE + "Mars" in ids
    assert search_nodes(viz, "") == []


def test_search_still_finds_undrawn_entities(viz):
    """AC-14. Search reads the full viz dict, never the budgeted response.

    This is the property that makes the node budget survivable: an entity the
    budget dropped is still reachable by name. If search ever starts reading
    the budgeted graph instead, a large ontology loses entities entirely and
    the interface gives no sign of it.
    """
    # A budget of 1 keeps only the single highest-degree node.
    budgeted = budget_viz(viz, 1)
    assert budgeted["stats"]["truncated"] is True
    drawn = {n["id"] for n in budgeted["nodes"]}
    assert SPACE + "Mars" not in drawn

    results = search_nodes(viz, "mars")
    assert SPACE + "Mars" in [r["id"] for r in results]


def test_format_detection_and_sniffing():
    assert detect_format("foo.ttl") == "turtle"
    assert detect_format("foo.owl") == "xml"
    assert detect_format(None, "json-ld") == "json-ld"
    # sniffing without a hint
    data = EXAMPLE.read_bytes()
    g, fmt = parse_rdf(data, None)
    assert fmt == "turtle"
    assert len(g) > 50
