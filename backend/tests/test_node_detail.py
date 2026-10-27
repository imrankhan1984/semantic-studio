"""
================================================================================
FILE: backend/tests/test_node_detail.py
================================================================================

SUMMARY
    GET /{id}/node for a library ontology's class: its rules as the Edit
    page reads them, every one read-only (explore-rules 5.3, AC-3). And
    every entity's `explain`, the structure the In plain words block is
    written from (explain-panel 5.2, AC-1, AC-2, AC-4). attribute-reuse
    Stage B (5.8, AC-13): an RDFS class's rule choices are None.

BASIC IDEA
    Upload a small library ontology with one rule of each reading -- a
    restriction, a definition, disjointness, and a shape outside the
    sentences -- and read the class back through the route. A library
    document is no one's to change here, so nothing may come back editable,
    and a property carries no rules at all.

    `explain` is read for one entity of each kind on Space Exploration, and
    for a project's class. Its member count is bounded on a generated class
    of 10,050, by counting the triples read. Its kind is checked against
    the graph's on every bundled example, and the list of standard terms
    those examples show, which the glossary's test reads, is measured here.

INPUTS / INPUT SOURCES
    - An inline Turtle string, uploaded through the API.
    - The bundled examples (app/examples, app/vocab/foaf.rdf).
    - frontend/src/explain/exampleTerms.json, checked against the measure.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS, XSD

from app.graph_builder import _description, build_viz_graph, explain, labeler, node_details, node_kind
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
SHOP = """
@prefix ex: <http://example.org/shop#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:Order a owl:Class ; rdfs:label "Order" ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasLine ;
        owl:minQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onClass ex:Line ] ,
        [ a owl:Restriction ; owl:onProperty ex:paidBy ; owl:someValuesFrom [ owl:unionOf ( ex:Party ex:Line ) ] ] ;
    owl:disjointWith ex:Party .
ex:BigOrder a owl:Class ; rdfs:label "Big order" ;
    owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( ex:Order
        [ a owl:Restriction ; owl:onProperty ex:hasLine ; owl:minQualifiedCardinality "10"^^xsd:nonNegativeInteger ; owl:onClass ex:Line ] ) ] .
ex:Line a owl:Class ; rdfs:label "Line" .
ex:Party a owl:Class ; rdfs:label "Party" .
ex:hasLine a owl:ObjectProperty ; rdfs:label "has line" .
ex:paidBy a owl:ObjectProperty ; rdfs:label "paid by" .
"""


@pytest.fixture(scope="module")
def oid() -> str:
    response = client.post("/api/ontologies/upload", files={"file": ("shop.ttl", SHOP.encode())})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _node(oid: str, iri: str) -> dict:
    response = client.get(f"/api/ontologies/{oid}/node", params={"iri": iri})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_library_class_carries_its_rules_read_only(oid):
    items = _node(oid, EX + "Order")["rules"]["items"]
    assert [i["type"] for i in items] == ["restriction", "disjoint", "turtle"]
    restriction = items[0]
    assert (restriction["form"], restriction["kind"], restriction["n"]) == ("every", "atLeast", 1)
    assert restriction["property"]["label"] == "has line"
    assert restriction["filler"] == {"iri": EX + "Line", "label": "Line"}
    assert items[1]["other"] == {"iri": EX + "Party", "label": "Party"}
    # A shape outside the sentences is its Turtle.
    assert "owl:unionOf" in items[2]["turtle"]
    assert all(item["editable"] is False for item in items)


def test_a_definition_reads_as_its_sentence_data(oid):
    rules = _node(oid, EX + "BigOrder")["rules"]
    (definition,) = rules["items"]
    assert (definition["form"], definition["kind"], definition["n"]) == ("defines", "atLeast", 10)
    assert definition["with"] == {"iri": EX + "Order", "label": "Order"}
    assert definition["editable"] is False
    # The library has no warnings and no sentence builder.
    assert rules["warnings"] == [] and rules["choices"] is None


def test_a_class_without_rules_has_an_empty_list(oid):
    assert _node(oid, EX + "Line")["rules"]["items"] == []


def test_a_property_carries_no_rules(oid):
    assert "rules" not in _node(oid, EX + "hasLine")


# --- explain (explain-panel 5.2, D-114) --------------------------------------

SPACE = "http://example.org/space#"
APP = Path(__file__).resolve().parents[1] / "app"
ROOT = Path(__file__).resolve().parents[2]
# The standard terms the bundled examples put in a panel, which the glossary
# test reads (glossary.test.ts): measured here so the list cannot go stale.
EXAMPLE_TERMS = ROOT / "frontend" / "src" / "explain" / "exampleTerms.json"
BUNDLED = (
    ("examples/space-exploration.ttl", "turtle"),
    ("examples/middle-earth.ttl", "turtle"),
    ("vocab/foaf.rdf", "xml"),
)
STANDARD = tuple(str(ns) for ns in (RDF, RDFS, OWL, SKOS, DCTERMS, DC, XSD))


def _bundled(path: str, fmt: str) -> Graph:
    graph = Graph()
    graph.parse(APP / path, format=fmt)
    return graph


@pytest.fixture(scope="module")
def space() -> str:
    text = (APP / "examples" / "space-exploration.ttl").read_bytes()
    response = client.post("/api/ontologies/upload", files={"file": ("space-exploration.ttl", text)})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _explain(oid: str, iri: str) -> dict:
    return _node(oid, iri)["explain"]


def _ref(local: str, label: str) -> dict:
    return {"iri": SPACE + local, "label": label}


def test_a_class_explains_its_parents_children_and_individuals(space):
    crewed = _explain(space, SPACE + "CrewedMission")
    assert crewed == {
        "kind": "class",
        "description": {"text": "A mission that carries people into space.", "lang": "en"},
        "parents": [_ref("Mission", "Mission")],
        "children": {"count": 0, "capped": False, "names": []},
        "members": {"count": 1, "capped": False, "names": [_ref("Apollo11", "Apollo 11")]},
    }
    mission = _explain(space, SPACE + "Mission")
    assert mission["parents"] == []
    assert mission["children"]["count"] == 2
    assert mission["children"]["names"] == [
        _ref("CrewedMission", "Crewed mission"),
        _ref("RoboticMission", "Robotic mission"),
    ]
    # Members are those typed with the class itself: Mission's subclasses
    # hold thirteen more, and counting them would say 14.
    assert mission["members"] == {"count": 1, "capped": False, "names": [_ref("Vostok1", "Vostok 1")]}


def test_an_object_property_explains_its_ends_and_inverse(space):
    crew = _explain(space, SPACE + "crewMember")
    assert crew["kind"] == "objectProperty"
    assert crew["domains"] == [_ref("CrewedMission", "Crewed mission")]
    assert crew["ranges"] == [_ref("Astronaut", "Astronaut")]
    assert crew["inverse"] is None
    orbits = _explain(space, SPACE + "orbits")
    # No domain: the sentence says "a thing" there, the server says nothing.
    assert orbits["domains"] == [] and orbits["ranges"] == [_ref("CelestialBody", "Celestial body")]
    assert orbits["inverse"] == _ref("isOrbitedBy", "is orbited by")


def test_an_inverse_stated_on_one_side_is_read_from_both():
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/i#> .\n"
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        "ex:hasPart a owl:ObjectProperty ; owl:inverseOf ex:partOf .\n"
        "ex:partOf a owl:ObjectProperty .\n"
    ), format="turtle")
    part_of = explain(graph, URIRef("http://example.org/i#partOf"), labeler(graph, None))
    assert part_of["inverse"] == {"iri": "http://example.org/i#hasPart", "label": "hasPart"}


def test_a_datatype_property_gives_its_type_of_value_prefixed(space):
    launch = _explain(space, SPACE + "launchDate")
    assert launch["kind"] == "datatypeProperty"
    assert launch["domains"] == [_ref("Mission", "Mission")]
    assert launch["datatype"] == "xsd:date"


def test_an_individual_is_one_as_the_graph_draws_it(space):
    # Typed only as a Crewed mission: rdf:type alone (term_kind) says
    # "other", the graph draws an individual, and the panel says what the
    # graph shows.
    apollo = _explain(space, SPACE + "Apollo11")
    assert apollo["kind"] == "individual"
    assert apollo["types"] == [_ref("CrewedMission", "Crewed mission")]
    assert apollo["description"]["text"] == "The first mission to land people on the Moon."


def test_owl_named_individual_is_left_out_of_the_types():
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/n#> .\n"
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        "ex:C a owl:Class .\n"
        "ex:i a owl:NamedIndividual, ex:C .\n"
    ), format="turtle")
    result = explain(graph, URIRef("http://example.org/n#i"), labeler(graph, None))
    assert result["kind"] == "individual"
    assert result["types"] == [{"iri": "http://example.org/n#C", "label": "C"}]


def test_a_concept_scheme_and_collection_explain_their_skos(space):
    crewed = _explain(space, SPACE + "mt-crewed")
    assert crewed["kind"] == "concept"
    assert crewed["broader"] == [_ref("mt-mission", "Space mission")]
    assert crewed["schemes"] == [_ref("MissionTypes", "Mission types")]
    # A count only: the sentence names no narrower concept.
    assert crewed["narrower"] == {"count": 2, "capped": False}
    scheme = _explain(space, SPACE + "MissionTypes")
    assert scheme["kind"] == "conceptScheme"
    assert scheme["topConcepts"] == {"count": 1, "capped": False}
    collection = _explain(space, SPACE + "SurfaceMissions")
    assert collection["kind"] == "collection"
    assert collection["members"]["count"] == 3
    assert collection["description"] is None


def test_a_concept_reads_broader_and_narrower_from_either_side():
    # Space Exploration states its hierarchy both ways; a file stating it
    # one way only must give the same facts from both ends.
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/c#> .\n"
        "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n"
        "ex:top a skos:Concept .\n"
        "ex:a a skos:Concept ; skos:broader ex:top .\n"
        "ex:b a skos:Concept ; skos:broader ex:top .\n"
        "ex:top skos:narrower ex:c .\n"
        "ex:c a skos:Concept .\n"
    ), format="turtle")
    name = labeler(graph, None)
    assert explain(graph, URIRef("http://example.org/c#top"), name)["narrower"] == {"count": 3, "capped": False}
    assert explain(graph, URIRef("http://example.org/c#c"), name)["broader"] == [
        {"iri": "http://example.org/c#top", "label": "top"}
    ]


def test_the_ontology_an_annotation_property_and_an_other_say_only_their_kind(space):
    ontology = _explain(space, "http://example.org/space")
    assert ontology["kind"] == "ontology"
    assert ontology["description"]["text"].startswith("A teaching ontology")
    assert set(ontology) == {"kind", "description"}
    named_after = _explain(space, SPACE + "namedAfter")
    assert named_after["kind"] == "annotationProperty" and set(named_after) == {"kind", "description"}
    # Only named as a licence: the file does not say what it is.
    other = _explain(space, "https://creativecommons.org/licenses/by/4.0/")
    assert other == {"kind": "other", "description": None}


EVERY_FIELD = {
    "parents", "children", "members", "domains", "ranges", "datatype", "inverse",
    "types", "broader", "schemes", "narrower", "topConcepts",
}


@pytest.mark.parametrize(
    "local, present",
    [
        ("CrewedMission", {"parents", "children", "members"}),
        ("crewMember", {"domains", "ranges", "inverse"}),
        ("launchDate", {"domains", "datatype"}),
        ("Apollo11", {"types"}),
        ("mt-crewed", {"broader", "schemes", "narrower"}),
        ("MissionTypes", {"topConcepts"}),
        ("SurfaceMissions", {"members"}),
    ],
)
def test_fields_that_do_not_apply_are_absent(space, local, present):
    assert set(_explain(space, SPACE + local)) & EVERY_FIELD == present


def test_an_end_given_as_a_blank_node_is_said_to_be_there():
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/u#> .\n"
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        "ex:hasPart a owl:ObjectProperty ; rdfs:domain [ owl:intersectionOf ( ex:Car ex:Boat ) ] ; rdfs:range ex:Part .\n"
    ), format="turtle")
    result = explain(graph, URIRef("http://example.org/u#hasPart"), labeler(graph, None))
    assert result["domains"] == [] and result["unnamedDomain"] is True
    assert "unnamedRange" not in result


def test_a_type_of_value_is_named_by_its_standard_prefix():
    # xs:date is XML Schema's date whatever the file calls it, so typeWord
    # can say "a date"; a literal carries its full type for the glossary.
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/t#> .\n"
        "@prefix xs: <http://www.w3.org/2001/XMLSchema#> .\n"
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        "ex:when a owl:DatatypeProperty ; rdfs:range xs:date .\n"
        "ex:x ex:when \"1969-07-16\"^^xs:date .\n"
    ), format="turtle")
    assert explain(graph, URIRef("http://example.org/t#when"), labeler(graph, None))["datatype"] == "xsd:date"
    (row,) = node_details(graph, "http://example.org/t#x")["outgoing"]
    assert row["object"]["datatypeIri"] == "http://www.w3.org/2001/XMLSchema#date"


def test_a_plain_property_with_no_ends_has_empty_lists():
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/p#> .\n"
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        "ex:near a rdf:Property ; rdfs:label \"near\" .\n"
    ), format="turtle")
    result = explain(graph, URIRef("http://example.org/p#near"), labeler(graph, None))
    assert result == {"kind": "property", "description": None, "domains": [], "ranges": [], "inverse": None}


def test_a_description_prefers_the_predicate_then_the_display_language():
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/d#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n"
        "@prefix dcterms: <http://purl.org/dc/terms/> .\n"
        "ex:A rdfs:comment \"Une chose\"@fr, \"A thing\"@en ; dcterms:description \"Ignored\" .\n"
        "ex:B dcterms:description \"Described\" ; skos:definition \"Defined\" .\n"
        "ex:C skos:definition \"  \" ; rdfs:comment \"Commented\" .\n"
        "ex:D rdfs:comment \"Zwei\"@de, \"Deux\"@fr .\n"
    ), format="turtle")
    a, b = URIRef("http://example.org/d#A"), URIRef("http://example.org/d#B")
    assert _description(graph, a, None) == {"text": "A thing", "lang": "en"}
    assert _description(graph, a, ("fr", "en")) == {"text": "Une chose", "lang": "fr"}
    assert _description(graph, b, None) == {"text": "Defined", "lang": None}
    # Empty text hides nothing; with no match the first by tag is chosen.
    assert _description(graph, URIRef("http://example.org/d#C"), None)["text"] == "Commented"
    assert _description(graph, URIRef("http://example.org/d#D"), None) == {"text": "Zwei", "lang": "de"}


def test_a_definition_wins_over_a_comment_on_the_same_entity():
    # Both untagged, so only the predicate order can choose between them.
    graph = Graph()
    graph.parse(data=(
        "@prefix ex: <http://example.org/d#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n"
        "ex:E rdfs:comment \"Commented\" ; skos:definition \"Defined\" .\n"
    ), format="turtle")
    assert _description(graph, URIRef("http://example.org/d#E"), None) == {"text": "Defined", "lang": None}


def test_a_project_document_carries_explain_too():
    from app.editing import editing_service

    project = client.post(
        "/api/projects", json={"name": "Explain", "template": "small", "baseIri": EX, "prefix": "shop"}
    )
    assert project.status_code == 200, project.text
    pid = project.json()["id"]
    try:
        assert client.post(f"/api/projects/{pid}/open").status_code == 200
        model = SHOP.replace('ex:Line a owl:Class ; rdfs:label "Line"', 'ex:Line a owl:Class ; rdfs:label "Line" ; rdfs:subClassOf ex:Party')
        assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": model}).status_code == 200
        line = _explain(f"{pid}-model", EX + "Line")
        assert line["kind"] == "class"
        assert line["parents"] == [{"iri": EX + "Party", "label": "Party"}]
    finally:
        editing_service.close_all()


# --- the bounds (AC-4) --------------------------------------------------------

BIG = URIRef("http://example.org/big#Thing")


class CountingGraph(Graph):
    """Counts the triples read for (?, rdf:type, BIG): what the member count
    costs, whatever rdflib's helpers do above `triples`."""

    reads = 0

    def triples(self, pattern):
        for triple in super().triples(pattern):
            if pattern[1] == RDF.type and pattern[2] == BIG:
                self.reads += 1
            yield triple


def _members(n: int) -> CountingGraph:
    graph = CountingGraph()
    graph.add((BIG, RDF.type, OWL.Class))
    for i in range(n):
        member = URIRef(f"http://example.org/big#m{i}")
        graph.add((member, RDF.type, BIG))
        # Labels in the reverse of insertion order, so label order is a sort.
        graph.add((member, RDFS.label, Literal(f"Member {n - i:05d}")))
    return graph


def test_a_class_with_10050_members_reads_10001_and_names_none():
    graph = _members(10_050)
    members = explain(graph, BIG, labeler(graph, None))["members"]
    assert members == {"count": 10_000, "capped": True, "names": []}
    assert 0 < graph.reads <= 10_001


def test_a_class_with_51_members_is_counted_but_not_named():
    graph = _members(51)
    assert explain(graph, BIG, labeler(graph, None))["members"] == {"count": 51, "capped": False, "names": []}


def test_a_class_with_three_members_names_them_in_label_order():
    graph = _members(3)
    names = explain(graph, BIG, labeler(graph, None))["members"]["names"]
    assert [n["label"] for n in names] == ["Member 00001", "Member 00002", "Member 00003"]


# --- node_kind and the glossary's measure -----------------------------------------


@pytest.mark.parametrize("path, fmt", BUNDLED)
def test_node_kind_is_the_kind_the_graph_draws(path, fmt):
    graph = _bundled(path, fmt)
    nodes = build_viz_graph(graph)["nodes"]
    assert nodes
    for node in nodes:
        assert node_kind(graph, URIRef(node["id"])) == node["kind"], node["id"]


def _standard(term) -> bool:
    return isinstance(term, URIRef) and str(term).startswith(STANDARD)


def test_the_glossary_list_is_every_standard_term_an_example_panel_shows():
    # A panel lists the statements of a named entity: their predicates and
    # values, a literal's datatype, and a standard term named as a subject.
    # A blank node's own statements show only inside its Turtle-like text.
    measured: set[str] = set()
    for path, fmt in BUNDLED:
        for s, p, o in _bundled(path, fmt):
            if not isinstance(s, URIRef):
                continue
            for term in (s, p, o, getattr(o, "datatype", None)):
                if _standard(term):
                    measured.add(str(term))
    listed = json.loads(EXAMPLE_TERMS.read_text(encoding="utf-8"))["terms"]
    assert len(listed) >= 45
    assert sorted(measured) == listed


# --- a class's properties, and how it has each (attribute-reuse 5.3) --------------------

HR = "http://example.org/hr#"
HR_MODEL = f"""@prefix hr: <{HR}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
hr:Employee a owl:Class ; rdfs:label "Employee"@en .
hr:Manager a owl:Class ; rdfs:label "Manager"@en ; rdfs:subClassOf hr:Employee .
hr:Contractor a owl:Class ; rdfs:label "Contractor"@en .
hr:Team a owl:Class ; rdfs:label "Team"@en .
hr:title a owl:DatatypeProperty ; rdfs:label "title"@en ; rdfs:domain hr:Manager ; rdfs:range xsd:string .
hr:hasJobCode a owl:DatatypeProperty ; rdfs:label "hasJobCode"@en ; rdfs:domain hr:Employee ; rdfs:range xsd:string .
hr:hasName a owl:DatatypeProperty ; rdfs:label "hasName"@en ; rdfs:range xsd:string ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( hr:Manager hr:Contractor ) ] .
hr:leads a owl:ObjectProperty ; rdfs:label "leads"@en ; rdfs:range hr:Team ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( hr:Employee hr:Contractor ) ] .
hr:badge a owl:DatatypeProperty ; rdfs:label "badge"@en ; rdfs:domain hr:Manager , hr:Team .
"""


def _open_project(text: str) -> str:
    response = client.post(
        "/api/projects", json={"name": "HR", "template": "small", "baseIri": HR, "prefix": "hr"}
    )
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    return pid


@pytest.fixture
def hr():
    from app.editing import editing_service

    yield _open_project(HR_MODEL)
    editing_service.close_all()


def _project_node(pid: str, iri: str) -> dict:
    response = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": iri})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_class_lists_its_own_shared_both_and_through_properties(hr):
    """AC-8: *own*, *shared* in a union, *both* (two domain lines) and
    *through* a parent, named in `via`."""
    props = {p["label"]: p for p in _project_node(hr, HR + "Manager")["properties"]}
    assert props["title"]["how"] == "own" and props["title"]["datatype"] == "xsd:string"
    assert props["hasName"]["how"] == "shared"
    assert props["hasName"]["with"] == [{"iri": HR + "Contractor", "label": "Contractor"}]
    assert props["badge"]["how"] == "both"
    assert props["hasJobCode"]["how"] == "through"
    assert props["hasJobCode"]["via"] == {"iri": HR + "Employee", "label": "Employee"}
    # Through Employee, a member of leads's union.
    assert props["leads"]["how"] == "through" and props["leads"]["via"]["label"] == "Employee"
    assert props["leads"]["kind"] == "relationship" and props["leads"]["range"]["label"] == "Team"
    assert [p["how"] for p in _project_node(hr, HR + "Manager")["properties"]] == sorted(
        (p["how"] for p in props.values()), key=lambda h: {"own": 0, "shared": 1, "both": 1, "through": 2}[h]
    )


def test_a_class_has_nothing_it_is_not_under(hr):
    props = {p["label"] for p in _project_node(hr, HR + "Team")["properties"]}
    assert props == {"badge"}, "badge lists Team; nothing else reaches it"
    assert {p["label"] for p in _project_node(hr, HR + "Contractor")["properties"]} == {"hasName", "leads"}


def test_a_property_carries_its_domain_as_the_reader_reads_it(hr):
    domain = _project_node(hr, HR + "hasName")["domain"]
    # Each with its kind (attribute-reuse 5.8), for the pointer to a rule.
    assert domain == {"form": "union", "classes": [
        {"iri": HR + "Manager", "label": "Manager", "type": "owl", "own": True},
        {"iri": HR + "Contractor", "label": "Contractor", "type": "owl", "own": True},
    ]}
    assert _project_node(hr, HR + "badge")["domain"]["form"] == "separate"


@pytest.mark.perf
def test_node_details_with_200_properties_budget():
    """Section 10: a class with 200 properties, a third shared and a third
    through parents, <= 50 ms, median of five with gc off."""
    import gc
    import time

    from app.editing import editing_service
    from budget import limit_ms

    lines = [HR_MODEL, "hr:Worker a owl:Class ; rdfs:label \"Worker\"@en .",
             "hr:Employee rdfs:subClassOf hr:Worker ."]
    for i in range(200):
        if i % 3 == 0:
            domain = "hr:Manager"
        elif i % 3 == 1:
            domain = "[ a owl:Class ; owl:unionOf ( hr:Manager hr:Contractor ) ]"
        else:
            domain = "hr:Worker"
        lines.append(f'hr:p{i} a owl:DatatypeProperty ; rdfs:label "p {i}"@en ; rdfs:domain {domain} ; rdfs:range xsd:string .')
    pid = _open_project("\n".join(lines) + "\n")
    try:
        details = _project_node(pid, HR + "Manager")
        hows = [p["how"] for p in details["properties"] if p["label"].startswith("p ")]
        assert len(hows) == 200 and hows.count("shared") == 67 and hows.count("through") == 66
        times = []
        gc.disable()
        try:
            for _ in range(5):
                start = time.perf_counter()
                _project_node(pid, HR + "Manager")
                times.append((time.perf_counter() - start) * 1000)
        finally:
            gc.enable()
        median = sorted(times)[2]
        assert median <= limit_ms(50), f"the node details took {median:.1f} ms (median of 5)"
    finally:
        editing_service.close_all()


# --- rules only on OWL classes (attribute-reuse Stage B, 5.8, D-117) ------------------

KIND_MODEL = HR_MODEL + f"""hr:Note a rdfs:Class ; rdfs:label "Note"@en ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty hr:leads ; owl:someValuesFrom hr:Team ] .
"""


@pytest.fixture
def kinds():
    from app.editing import editing_service

    yield _open_project(KIND_MODEL)
    editing_service.close_all()


def test_rule_choices_are_none_for_an_rdfs_class(kinds):
    """AC-13: an RDFS class gets no sentence builder; an OWL class keeps it.
    What a file says about the RDFS class in OWL still comes, for the block
    to show read-only with 5.8's note."""
    note = _project_node(kinds, HR + "Note")["rules"]
    assert note["classType"] == "rdfs" and note["choices"] is None
    assert [i["type"] for i in note["items"]] == ["restriction"]
    team = _project_node(kinds, HR + "Team")["rules"]
    assert team["classType"] == "owl" and team["choices"] is not None
    # Each class at the other end carries its kind and whether it is the
    # document's own, for the builder's offer (Stage B review).
    classes = {c["label"]: c for c in team["choices"]["classes"]["items"]}
    assert classes["Note"]["type"] == "rdfs" and classes["Note"]["own"] is True
    assert classes["Team"]["type"] == "owl"
