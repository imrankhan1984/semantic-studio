"""
================================================================================
FILE: backend/tests/test_node_detail.py
================================================================================

SUMMARY
    GET /{id}/node for a library ontology's class: its rules as the Edit
    page reads them, every one read-only (explore-rules 5.3, AC-3).

BASIC IDEA
    Upload a small library ontology with one rule of each reading -- a
    restriction, a definition, disjointness, and a shape outside the
    sentences -- and read the class back through the route. A library
    document is no one's to change here, so nothing may come back editable,
    and a property carries no rules at all.

INPUTS / INPUT SOURCES
    - An inline Turtle string, uploaded through the API.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

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
