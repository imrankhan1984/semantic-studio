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

import gc
import json
import re
import time
from collections import Counter
from pathlib import Path

import pytest
from rdflib import BNode, Graph
from rdflib.namespace import OWL, RDF, RDFS

from app import axioms
from app.canvas import build_canvas
from app.graph_builder import budget_viz, build_viz_graph, node_details, search_nodes
from app.store import detect_format, parse_rdf
from budget import limit_ms

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


def test_class_type_marks_rdfs_only_classes():
    """portal-foundations 5.3, AC-4: a class typed only rdfs:Class carries
    classType "rdfs", the rule canvas.py uses; owl:Class, both typings, or a
    class known only from subClassOf carry none. kind stays "class" for all,
    so filters and counts do not move."""
    g = Graph()
    g.parse(
        data="""
        @prefix ex: <http://example.org/t#> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        ex:Plain a rdfs:Class .
        ex:Owl a owl:Class .
        ex:Both a owl:Class, rdfs:Class .
        ex:Implied rdfs:subClassOf ex:Plain .
        """,
        format="turtle",
    )
    viz = build_viz_graph(g)
    ex = "http://example.org/t#"
    for name in ("Plain", "Owl", "Both", "Implied"):
        assert _node(viz, ex + name)["kind"] == "class"
    assert _node(viz, ex + "Plain")["classType"] == "rdfs"
    for name in ("Owl", "Both", "Implied"):
        assert "classType" not in _node(viz, ex + name)
    assert viz["stats"]["kindCounts"] == {"class": 4}
    # The legend's line under Class, whole-ontology like kindCounts (D-017),
    # so a budget that drops the class still counts it.
    assert viz["stats"]["rdfsClassCount"] == 1
    assert budget_viz(viz, 1)["stats"]["rdfsClassCount"] == 1


# --- rule lines (explore-rules 5.1, D-113) ------------------------------------------

RULES = """
@prefix ex: <http://example.org/r#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:Order a owl:Class ; rdfs:label "Order" ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:someValuesFrom ex:Line ] ,
        [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:maxQualifiedCardinality "3"^^xsd:nonNegativeInteger ; owl:onClass ex:Line ] ,
        [ a owl:Restriction ; owl:onProperty ex:paidBy ; owl:allValuesFrom ex:Party ] ,
        [ a owl:Restriction ; owl:onProperty ex:status ; owl:hasValue ex:Open ] ,
        [ a owl:Restriction ; owl:onProperty ex:note ; owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:string ] ,
        [ a owl:Restriction ; owl:onProperty ex:paidBy ; owl:someValuesFrom [ owl:unionOf ( ex:Party ex:Line ) ] ] ,
        [ a owl:Restriction ; owl:onProperty ex:paidBy ; owl:someValuesFrom ex:Party ; owl:allValuesFrom ex:Party ] ,
        [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:someValuesFrom owl:Thing ] .
ex:BigOrder a owl:Class ; rdfs:label "Big order" ;
    owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( ex:Order
        [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:minQualifiedCardinality "10"^^xsd:nonNegativeInteger ; owl:onClass ex:Line ] ) ] .
ex:Line a owl:Class ; rdfs:label "Line" .
# Not typed a class: the canvas draws no box for it, so no line either.
ex:Loose rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:someValuesFrom ex:Line ] .
ex:Party a owl:Class ; rdfs:label "Party" .
ex:hasLine a owl:ObjectProperty ; rdfs:label "has line" .
ex:paidBy a owl:ObjectProperty ; rdfs:label "paid by" .
"""
R = "http://example.org/r#"
BUNDLED = Path(__file__).parent.parent / "app" / "examples" / "space-exploration.ttl"


@pytest.fixture(scope="module")
def rules_graph() -> Graph:
    return Graph().parse(data=RULES, format="turtle")


def _rule_set(edges) -> set:
    return {(e["source"], e["target"], json.dumps(e["key"], sort_keys=True)) for e in edges if e["kind"] == "rule"}


def test_each_drawn_restriction_is_one_rule_edge(rules_graph):
    """AC-1: some, only, a qualified count and a definition each give one
    edge from the class to its filler, carrying `rule` and `key`; a value,
    a datatype filler, an unnamed filler, an unreadable shape and owl:Thing
    give none. Two rules on the same two classes are two edges, two keys."""
    rules = _edges(build_viz_graph(rules_graph), "rule")
    by = sorted((e["source"][len(R):], e["target"][len(R):], e["rule"]["kind"], e["rule"]["form"]) for e in rules)
    assert by == [
        ("BigOrder", "Line", "atLeast", "defines"),
        ("Order", "Line", "atMost", "every"),
        ("Order", "Line", "some", "every"),
        ("Order", "Party", "only", "every"),
    ]
    some = next(e for e in rules if e["rule"]["kind"] == "some")
    assert some["rule"] == {
        "form": "every", "kind": "some", "n": None, "property": R + "hasLine",
        "propertyLabel": "has line", "fillerLabel": "Line", "withLabel": None,
    }
    assert some["key"] == {"form": "every", "property": R + "hasLine", "kind": "some", "filler": R + "Line", "n": None}
    defines = next(e for e in rules if e["rule"]["form"] == "defines")
    assert defines["rule"]["n"] == 10 and defines["rule"]["withLabel"] == "Order"
    assert defines["key"]["with"] == R + "Order"
    order_line = [e for e in rules if e["source"] == R + "Order" and e["target"] == R + "Line"]
    assert len(order_line) == 2 and order_line[0]["key"] != order_line[1]["key"]


def test_a_rule_written_twice_is_one_edge():
    """The same content in two blank nodes would give two edges with one key,
    which GraphView could not tell apart."""
    g = Graph().parse(data="""
        @prefix ex: <http://example.org/r#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        ex:A a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:B ] ,
            [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:B ] .
        ex:B a owl:Class .
        """, format="turtle")
    assert len(_edges(build_viz_graph(g), "rule")) == 1


def test_rule_edges_count_in_degree_and_stats(rules_graph):
    """5.1, What else changes: the edge count and a class's degree include its rules."""
    viz = build_viz_graph(rules_graph)
    assert viz["stats"]["edgeCount"] == len(viz["edges"])
    no_rules = Graph()
    for t in rules_graph:
        if not (str(t[0]) == R + "Order" and str(t[1]).endswith("subClassOf")):
            no_rules.add(t)
    assert _node(viz, R + "Order")["degree"] == _node(build_viz_graph(no_rules), R + "Order")["degree"] + 3


def test_the_space_example_draws_its_restrictions():
    """The bundled Space Exploration example: four restrictions reach a named
    class; the crewed definition's *has value* is no line."""
    rules = _edges(build_viz_graph(Graph().parse(BUNDLED, format="turtle")), "rule")
    pairs = sorted((e["source"][len(SPACE):], e["target"][len(SPACE):]) for e in rules)
    assert pairs == [
        ("CrewedMission", "Astronaut"), ("Mission", "Organization"),
        ("Moon", "CelestialBody"), ("Planet", "Star"),
    ]
    crewed = next(e for e in rules if e["source"] == SPACE + "CrewedMission")
    assert (crewed["rule"]["kind"], crewed["rule"]["n"], crewed["rule"]["propertyLabel"]) == ("atLeast", 1, "crew member")


@pytest.mark.parametrize("fixture", ["rules", "space"])
def test_rule_edges_equal_the_canvas_rules(fixture, rules_graph):
    """AC-1: Explore draws exactly the canvas's rule lines, compared as
    source, target and key."""
    g = rules_graph if fixture == "rules" else Graph().parse(BUNDLED, format="turtle")
    canvas_rules = _rule_set(build_canvas(g, None)["edges"])
    assert canvas_rules  # the comparison compares something
    assert _rule_set(build_viz_graph(g)["edges"]) == canvas_rules


def test_graph_builder_reads_no_restriction_shape_itself():
    """AC-1, one reader (D-113): graph_builder.py names no restriction
    predicate; axioms.py's parsers are the only reader."""
    source = (Path(__file__).parent.parent / "app" / "graph_builder.py").read_text(encoding="utf-8")
    assert "def build_viz_graph" in source  # the file loaded
    assert "axioms.parse_restriction" in source and "axioms.parse_defining" in source
    # Whole words: "annotationProperty" ends in "onProperty" and is no reading.
    for word in ("onProperty", "someValuesFrom", "allValuesFrom", "hasValue", "onClass", "onDataRange",
                 r"\w*Cardinality", "intersectionOf", "Restriction"):
        assert not re.search(rf"\b{word}\b", source), word


# --- the budget (explore-rules Section 10) -------------------------------------------


def _generated(classes: int = 5_000, properties: int = 60, restrictions: int = 10_000) -> Graph:
    """5,000 classes, 60 properties and 10,000 restrictions, generated as
    N-Triples (rdf-fixture: never a committed file). In turn: some, only, a
    qualified count, a value, and a definition (a class and a restriction)."""
    ex = "http://example.org/gen#"
    owl = "http://www.w3.org/2002/07/owl#"
    rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    rdfs = "http://www.w3.org/2000/01/rdf-schema#"
    xsd = "http://www.w3.org/2001/XMLSchema#"
    lines = []
    for i in range(classes):
        lines.append(f"<{ex}C{i}> <{rdf}type> <{owl}Class> .")
        lines.append(f'<{ex}C{i}> <{rdfs}label> "Class {i}" .')
        if i:
            lines.append(f"<{ex}C{i}> <{rdfs}subClassOf> <{ex}C{(i - 1) // 3}> .")
    for p in range(properties):
        lines.append(f"<{ex}p{p}> <{rdf}type> <{owl}ObjectProperty> .")
        lines.append(f'<{ex}p{p}> <{rdfs}label> "property {p}" .')
    for r in range(restrictions):
        cls, filler, prop = r % classes, (r * 7 + 1) % classes, r % properties
        node = f"_:r{r}"
        lines.append(f"{node} <{rdf}type> <{owl}Restriction> .")
        lines.append(f"{node} <{owl}onProperty> <{ex}p{prop}> .")
        shape = r % 5
        if shape in (0, 4):
            lines.append(f"{node} <{owl}someValuesFrom> <{ex}C{filler}> .")
        elif shape == 1:
            lines.append(f"{node} <{owl}allValuesFrom> <{ex}C{filler}> .")
        elif shape == 2:
            lines.append(f'{node} <{owl}minQualifiedCardinality> "2"^^<{xsd}nonNegativeInteger> .')
            lines.append(f"{node} <{owl}onClass> <{ex}C{filler}> .")
        else:
            lines.append(f"{node} <{owl}hasValue> <{ex}i{filler}> .")
        if shape == 4:
            d, first, rest = f"_:d{r}", f"_:l{r}a", f"_:l{r}b"
            lines += [
                f"<{ex}C{cls}> <{owl}equivalentClass> {d} .",
                f"{d} <{rdf}type> <{owl}Class> .",
                f"{d} <{owl}intersectionOf> {first} .",
                f"{first} <{rdf}first> <{ex}C{(cls + 1) % classes}> .",
                f"{first} <{rdf}rest> {rest} .",
                f"{rest} <{rdf}first> {node} .",
                f"{rest} <{rdf}rest> <{rdf}nil> .",
            ]
        else:
            lines.append(f"<{ex}C{cls}> <{rdfs}subClassOf> {node} .")
    return Graph().parse(data="\n".join(lines), format="nt")


@pytest.fixture(scope="module")
def generated() -> Graph:
    return _generated()


def test_the_generated_file_is_the_one_measured(generated):
    """Section 10's file: 10,000 restrictions in about 58,000 statements;
    every one but the values becomes a line."""
    assert len(set(generated.subjects(RDF.type, OWL.Restriction))) == 10_000
    assert 50_000 <= len(generated) <= 70_000
    assert len(_edges(build_viz_graph(generated), "rule")) == 8_000


def test_each_restriction_is_parsed_once(generated, monkeypatch):
    """AC-5: parse_restriction and parse_defining are asked at most once per
    blank node under rdfs:subClassOf or owl:equivalentClass, and never through
    axioms.contents per class (about 50 % dearer, Section 10)."""
    restriction, defining = Counter(), Counter()
    parse_restriction, parse_defining = axioms.parse_restriction, axioms.parse_defining

    def counted_restriction(g, node):
        restriction[node] += 1
        return parse_restriction(g, node)

    def counted_defining(g, node):
        defining[node] += 1
        return parse_defining(g, node)

    def no_contents(*_):
        raise AssertionError("axioms.contents asked per class")

    monkeypatch.setattr(axioms, "parse_restriction", counted_restriction)
    monkeypatch.setattr(axioms, "parse_defining", counted_defining)
    monkeypatch.setattr(axioms, "contents", no_contents)
    build_viz_graph(generated)

    under_sub = {o for o in generated.objects(None, RDFS.subClassOf) if isinstance(o, BNode)}
    under_eq = {o for o in generated.objects(None, OWL.equivalentClass) if isinstance(o, BNode)}
    assert set(defining) == under_eq and len(under_eq) == 2_000
    assert max(defining.values()) == 1 and max(restriction.values()) == 1
    # Each subClassOf blank node once; a definition asks for itself and, inside
    # parse_defining, its one inner restriction: nothing else is parsed.
    assert under_sub <= set(restriction)
    assert len(restriction) == len(under_sub) + 2 * len(under_eq)


@pytest.mark.perf
def test_rule_lines_build_budget(generated):
    """AC-5: build_viz_graph with rule lines on the 10,000-restriction file,
    at most 1,000 ms, median of five with the collector off (D-024)."""
    build_viz_graph(generated)  # warm-up
    times = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            build_viz_graph(generated)
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = sorted(times)[2]
    assert median <= limit_ms(1000), f"build_viz_graph took {median:.0f} ms (median of 5)"
