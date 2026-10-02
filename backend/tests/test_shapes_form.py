"""
================================================================================
FILE: backend/tests/test_shapes_form.py
================================================================================

SUMMARY
    Shapes as the form reads them (shacl-authoring 5.3 to 5.5): which shapes
    are listed, each read into target, name, severity, message and one rule
    per path; a shape written in Turtle the form can edit opening as if made
    there; one it cannot marked read-only with each part it cannot edit; and
    the suggestions of 5.4, row S17.

BASIC IDEA
    shapes_form reads graphs and nothing else, so most cases are inline
    Turtle handed to it directly; the suggestions are also asked for
    through the route, which is how they follow a model change.

INPUTS / INPUT SOURCES
    - Inline Turtle; the conftest temp data directory for the route cases.

EXPECTED OUTPUT
    - Pass/fail for AC-3, AC-4 and row S17.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.namespace import RDFS, SKOS

from app import shapes_form
from app.editing import editing_service
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
"""

MODEL = PREFIXES + """
shop:Person a owl:Class ; rdfs:label "Person"@en .
shop:Employee a owl:Class ; rdfs:label "Employee"@en ; rdfs:subClassOf shop:Person .
shop:Organization a owl:Class ; rdfs:label "Organization"@en .
shop:name a owl:DatatypeProperty ; rdfs:label "name"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:birthDate a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:label "birth date"@en ;
    rdfs:domain shop:Person ; rdfs:range xsd:date .
shop:worksFor a owl:ObjectProperty , owl:FunctionalProperty ; rdfs:label "works for"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .
shop:salary a owl:DatatypeProperty ; rdfs:label "salary"@en ; rdfs:domain shop:Employee ; rdfs:range xsd:decimal .
"""


def g(text: str) -> Graph:
    return Graph().parse(data=PREFIXES + text, format="turtle")


MODEL_GRAPH = Graph().parse(data=MODEL, format="turtle")


def names(iri) -> str:
    return shapes_form.pick_label_in(MODEL_GRAPH, iri, ["en"])[0]


def read(text: str, shape: str = "S") -> dict:
    shapes = g(text)
    return shapes_form.read_shape(shapes, URIRef(EX + shape), MODEL_GRAPH, names, ["en"])


# --- which shapes are listed ---------------------------------------------------------------


def test_listed_are_targeted_shapes_and_node_shapes_nothing_refers_to():
    shapes = g("""
shop:A a sh:NodeShape ; rdfs:label "A rules" ; sh:targetClass shop:Person ; sh:node shop:Address .
shop:Address a sh:NodeShape ; sh:property [ sh:path shop:name ; sh:minCount 1 ] .
shop:Loose a sh:NodeShape ; rdfs:label "Loose" .
shop:Prop a sh:PropertyShape ; sh:path shop:name ; sh:targetClass shop:Person .
shop:Only sh:targetNode shop:bob .
""")
    listed = [str(n).removeprefix(EX) for n in shapes_form.listed_shapes(shapes)]
    # Address is reached only through A, so it is part of A; a property
    # shape is never a row, even with a target.
    assert listed == ["A", "Loose", "Only"]


# --- 5.5: what the form edits opens as if made there ---------------------------------------


def test_a_turtle_shape_within_the_forms_kinds_opens_editable():
    shape = read("""
shop:S a sh:NodeShape ; rdfs:label "Person rules"@en ; sh:targetClass shop:Person ;
    sh:severity sh:Warning ; sh:message "Check the people."@en ;
    sh:property [ sh:path shop:name ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:string ;
                  sh:minLength 2 ; sh:maxLength 40 ; sh:pattern "^[A-Z]" ; sh:severity sh:Warning ] ;
    sh:property [ sh:path shop:worksFor ; sh:class shop:Organization ; sh:severity sh:Warning ] ;
    sh:property [ sh:path shop:birthDate ; sh:minInclusive "1900-01-01"^^xsd:date ; sh:severity sh:Warning ] ;
    sh:property [ sh:path rdfs:label ; sh:languageIn ( "en" "fr" ) ; sh:uniqueLang true ; sh:severity sh:Warning ] ;
    sh:property [ sh:path rdfs:label ; sh:qualifiedValueShape [ sh:languageIn ( "fr" ) ] ;
                  sh:qualifiedMinCount 1 ; sh:severity sh:Warning ] ;
    sh:property [ sh:path [ sh:alternativePath ( skos:definition rdfs:comment ) ] ; sh:minCount 1 ;
                  sh:severity sh:Warning ] .
""")
    assert shape["editable"] is True, shape["unsupported"]
    assert shape["name"] == "Person rules"
    assert shape["target"] == {"iri": EX + "Person", "label": "Person", "every": None}
    assert shape["severity"] == "warning"
    assert shape["message"] == "Check the people."
    by_label = {r["pathLabel"]: r for r in shape["rules"]}
    assert set(by_label) == {"birth date", "definition", "name", "works for"}
    name = next(r for r in shape["rules"] if r["path"] == [EX + "name"])
    assert {k: name[k] for k in ("minCount", "maxCount", "datatype", "minLength", "maxLength", "pattern")} == {
        "minCount": 1, "maxCount": 1, "datatype": "xsd:string", "minLength": 2, "maxLength": 40, "pattern": "^[A-Z]",
    }
    assert name["pathKind"] == "attribute"
    works = by_label["works for"]
    assert works["class"] == EX + "Organization" and works["classLabel"] == "Organization"
    assert works["pathKind"] == "relationship"
    assert by_label["birth date"]["minInclusive"] == {"value": "1900-01-01", "datatype": "xsd:date"}
    label = next(r for r in shape["rules"] if r["path"] == [str(RDFS.label)])
    assert label["languageIn"] == ["en", "fr"] and label["uniqueLang"] is True
    # The qualified shape is folded back into the rule on the same path.
    assert label["requiredLanguages"] == ["fr"]
    assert label["pathKind"] == "name"
    definition = by_label["definition"]
    assert definition["path"] == [str(SKOS.definition), str(RDFS.comment)]
    assert definition["minCount"] == 1


@pytest.mark.parametrize(
    ("text", "phrase"),
    [
        ("shop:S sh:targetClass shop:Person ; sh:or ( [ sh:path shop:name ; sh:minCount 1 ] ) .", "uses sh:or"),
        ("shop:S sh:targetClass shop:Person ; sh:sparql [ sh:select \"SELECT $this WHERE {}\" ] .", "uses sh:sparql"),
        ("shop:S a sh:NodeShape ; sh:targetNode shop:bob .", "uses sh:targetNode"),
        ("shop:S sh:targetClass shop:Person ; sh:node shop:T . shop:T sh:closed true .", "uses sh:node"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path ( shop:worksFor shop:name ) ; sh:minCount 1 ] .",
         "uses a path the form cannot edit"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:qualifiedValueShape "
         "[ sh:datatype xsd:string ] ; sh:qualifiedMinCount 1 ] .", "uses sh:qualifiedValueShape"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:minCount 1 ] , "
         "[ sh:path shop:name ; sh:maxCount 2 ] .", "has two rules on name"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:minCount 1 ; "
         "sh:severity sh:Warning ] .", "has a different severity on one rule"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:flags \"i\" ; "
         "sh:pattern \"a\" ] .", "uses sh:flags"),
        ("shop:S sh:targetClass shop:Person , shop:Organization .", "has more than one target class"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:message \"x\" ] .",
         "uses sh:message"),
        # Found in review: a type the commands refuse must not look editable.
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:datatype xsd:double ] .",
         "uses the type of value xsd:double"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:maxInclusive 1.5e2 ] .",
         "has a sh:maxInclusive the form cannot read"),
        ("shop:S sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:in ( 1.5e2 ) ] .",
         "has an allowed value of a type the form does not offer"),
    ],
)
def test_a_turtle_shape_outside_the_forms_kinds_opens_read_only_saying_why(text, phrase):
    shape = read(text)
    assert shape["editable"] is False
    assert phrase in shape["unsupported"]


def test_read_only_parts_are_listed_once_each():
    shape = read("shop:S sh:targetClass shop:Person ; sh:or ( [ sh:path shop:name ] ) ; "
                 "sh:or ( [ sh:path shop:age ] ) .")
    assert shape["unsupported"].count("uses sh:or") == 1


def test_a_shape_without_a_label_is_named_by_its_prefixed_iri():
    assert read("shop:S a sh:NodeShape ; sh:targetClass shop:Person .")["name"] == "shop:S"


def test_find_shape_takes_ids_the_list_gives_blank_nodes_included():
    shapes = g("[] a sh:NodeShape ; rdfs:label \"Anonymous\" ; sh:targetClass shop:Person .")
    (node,) = shapes_form.listed_shapes(shapes)
    assert shapes_form.find_shape(shapes, shapes_form.shape_id(node)) == node
    assert shapes_form.find_shape(shapes, "http://example.org/none") is None
    assert shapes_form.find_shape(shapes, None) is None


# --- 5.4 and S17: suggestions ----------------------------------------------------------------


def _suggest(target: str, existing: list | None = None) -> dict:
    return shapes_form.suggestions(MODEL_GRAPH, URIRef(target), existing or [], names, ["en", "fr"])


def test_suggestions_come_from_the_class_and_its_parents():
    out = _suggest(EX + "Employee")
    rules = [s["rule"] for s in out["suggestions"]]
    assert {"path": [EX + "name"], "datatype": "xsd:string", "pathLabel": "name", "pathKind": "attribute"} in rules
    assert {"path": [EX + "birthDate"], "maxCount": 1, "pathLabel": "birth date", "pathKind": "attribute"} in rules
    assert {"path": [EX + "salary"], "datatype": "xsd:decimal", "pathLabel": "salary", "pathKind": "attribute"} in rules
    assert {"path": [EX + "worksFor"], "class": EX + "Organization", "classLabel": "Organization",
            "pathLabel": "works for", "pathKind": "relationship"} in rules
    assert {"path": [EX + "worksFor"], "maxCount": 1, "pathLabel": "works for", "pathKind": "relationship"} in rules
    assert {"path": [str(RDFS.label)], "requiredLanguages": ["en"], "pathLabel": "name",
            "pathKind": "name"} in rules
    assert {"path": [str(RDFS.label)], "uniqueLang": True, "languageIn": ["en", "fr"], "pathLabel": "name",
            "pathKind": "name"} in rules
    # The paths the rule editor offers: names, definitions, then the
    # attributes and relationships, own and inherited.
    assert [p["label"] for p in out["paths"]] == ["name", "definition", "birth date", "name", "salary", "works for"]


def test_a_parents_suggestions_do_not_include_a_childs_attributes():
    rules = [s["rule"]["path"] for s in _suggest(EX + "Person")["suggestions"]]
    assert [EX + "salary"] not in rules


def test_concepts_are_suggested_a_preferred_name_in_each_language_and_a_definition():
    rules = [s["rule"] for s in _suggest(str(SKOS.Concept))["suggestions"]]
    assert rules[0]["requiredLanguages"] == ["en", "fr"]
    assert rules[0]["path"] == [str(SKOS.prefLabel)]
    assert rules[1]["minCount"] == 1 and rules[1]["pathLabel"] == "definition"


def test_a_suggestion_already_said_is_not_offered_again_and_a_partial_one_is():
    existing = [{"path": [EX + "name"], "datatype": "xsd:string", "minCount": 1},
                {"path": [str(RDFS.label)], "requiredLanguages": ["en", "fr"]}]
    ids = [s["id"] for s in _suggest(EX + "Person", existing)["suggestions"]]
    assert f"type:{EX}name" not in ids
    assert "name-primary" not in ids  # en is already required
    assert "name-per-language" in ids  # uniqueLang is not said yet


@pytest.fixture
def pid() -> str:
    response = client.post("/api/projects", json={"name": "Shop", "template": "empty", "baseIri": EX, "prefix": "shop"})
    project = response.json()["id"]
    client.post(f"/api/projects/{project}/open")
    assert client.put(f"/api/projects/{project}/documents/model/source", json={"text": MODEL}).status_code == 200
    yield project
    editing_service.close_all()


def _ids(pid: str, shape: str | None = None) -> list[str]:
    params = {"target": EX + "Person"}
    if shape:
        params["shape"] = shape
    response = client.get(f"/api/projects/{pid}/shapes/suggestions", params=params)
    assert response.status_code == 200, response.text
    return [s["id"] for s in response.json()["suggestions"]]


def test_s17_suggestions_added_are_not_offered_twice_and_follow_a_model_change(pid):
    sid = client.post(f"/api/projects/{pid}/documents/shapes/commands",
                      json={"command": "CreateShape", "args": {"target": EX + "Person"}}).json()["created"]
    assert f"type:{EX}name" in _ids(pid, sid)
    rule = {"path": [EX + "name"], "datatype": "xsd:string"}
    added = client.post(f"/api/projects/{pid}/documents/shapes/commands",
                        json={"command": "AddRule", "args": {"shape": sid, "rule": rule, "merge": True}})
    assert added.status_code == 200, added.text
    assert f"type:{EX}name" not in _ids(pid, sid)
    # A new attribute on Person is suggested at once: worked out from the
    # same graph the form shows.
    created = client.post(f"/api/projects/{pid}/documents/model/commands", json={
        "command": "CreateDatatypeProperty",
        "args": {"label": "email", "domain": EX + "Person", "datatype": "xsd:string"},
    })
    assert created.status_code == 200, created.text
    assert f"type:{EX}email" in _ids(pid, sid)


def test_suggestions_refuse_a_target_that_is_not_an_iri(pid):
    response = client.get(f"/api/projects/{pid}/shapes/suggestions", params={"target": "not an iri"})
    assert response.status_code == 422


def test_the_shapes_route_lists_nothing_before_shapes_ttl_exists(pid):
    body = client.get(f"/api/projects/{pid}/shapes").json()
    assert body["shapes"] == [] and body["revision"] is None
