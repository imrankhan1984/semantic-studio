"""
================================================================================
FILE: backend/tests/test_axioms.py
================================================================================

SUMMARY
    axioms-and-reasoning Stage B on the server: the seven rule commands
    (AddRestriction, ReplaceRestriction, RemoveRestriction, AddDisjointWith,
    RemoveDisjointWith, AddEquivalentClass, RemoveEquivalentClass), each one
    undo step with exact triples; the restriction named by its content, a
    duplicate refused, a missing one 404, a removal sweeping its blank node;
    every check of 5.10 refusing before anything is written; the warnings
    kept; the Turtle round trip of every 5.8 row both ways (AC-9), with a
    union read-only and never rewritten; owl:AllDisjointClasses shown as
    read-only Turtle and counted by every disjointness check and the
    canvas's *never* lines (PR #56 review), a disjointness a group states
    refused when added again and its removal told truly (X-12, T-25,
    T-26); the canvas's rule lines; and Check
    it in data too, one undo step in shapes.ttl, read-only in the shapes
    form and never rewritten by it (AC-12, row R13 as the server sees it).

BASIC IDEA
    Through the HTTP API, as the frontend drives it, with the graph read
    directly for exact triples and isomorphism, as test_relationships.py
    does. The round trip is proved by two graphs: one made by the command,
    one made by applying 5.8's Turtle shape to the same model, which must be
    isomorphic; and the Turtle shape read back through /node must give the
    sentence's content the command was given.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the Small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-8 to AC-10 and AC-12, and rows R9, R11 to R13 as the
      server sees them.
================================================================================
"""

from __future__ import annotations

import ast
import gc
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS, XSD

from app import axioms, shapes_form
from app.editing import editing_service
from app.main import app
from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
SH = "http://www.w3.org/ns/shacl#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix sh: <{SH}> .
"""

MODEL = PREFIXES + """
shop:Order a owl:Class ; rdfs:label "Order"@en .
shop:OrderLine a owl:Class ; rdfs:label "Order line"@en .
shop:Person a owl:Class ; rdfs:label "Person"@en .
shop:Organization a owl:Class ; rdfs:label "Organization"@en .
shop:Employee a owl:Class ; rdfs:label "Employee"@en .
shop:Manager a owl:Class ; rdfs:label "Manager"@en .
shop:Client a owl:Class ; rdfs:label "Client"@en .
shop:Customer a owl:Class ; rdfs:label "Customer"@en .
shop:GoldCustomer a owl:Class ; rdfs:label "Gold customer"@en .
shop:Robot a owl:Class ; rdfs:label "Robot"@en .
shop:hasLine a owl:ObjectProperty ; rdfs:label "has line"@en ;
    rdfs:domain shop:Order ; rdfs:range shop:OrderLine .
shop:manages a owl:ObjectProperty ; rdfs:label "manages"@en .
shop:partOf a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:label "part of"@en .
shop:within a owl:ObjectProperty ; rdfs:label "within"@en .
shop:partOf rdfs:subPropertyOf shop:within .
shop:birthDate a owl:DatatypeProperty ; rdfs:label "birth date"@en ; rdfs:range xsd:date .
shop:status a owl:DatatypeProperty ; rdfs:label "status"@en ; rdfs:range xsd:string .
shop:acme a shop:Organization, owl:NamedIndividual ; rdfs:label "Acme"@en .
"""


def U(local: str) -> URIRef:
    return URIRef(EX + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


@pytest.fixture
def pid() -> str:
    response = client.post("/api/projects", json={"name": "Shop", "template": "small", "baseIri": EX, "prefix": "shop"})
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    put = client.put(f"/api/projects/{project}/documents/model/source", json={"text": MODEL})
    assert put.status_code == 200, put.text
    return project


def run(pid: str, command: str, doc: str = "model", **args):
    return client.post(f"/api/projects/{pid}/documents/{doc}/commands", json={"command": command, "args": args})


def ok(pid: str, command: str, doc: str = "model", **args) -> dict:
    response = run(pid, command, doc, **args)
    assert response.status_code == 200, response.text
    return response.json()


def graph(pid: str, doc: str = "model") -> Graph:
    return editing_service.document(pid, doc).graph


def copy(g: Graph) -> Graph:
    out = Graph()
    for t in g:
        out.add(t)
    return out


def apply(pid: str, extra: str) -> None:
    response = client.put(f"/api/projects/{pid}/documents/model/source", json={"text": MODEL + extra})
    assert response.status_code == 200, response.text


def rules(pid: str, iri: str) -> dict:
    response = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": iri})
    assert response.status_code == 200, response.text
    return response.json()["rules"]


def revision(pid: str) -> int:
    return editing_service.document(pid, "model").ontology.revision


# --- every row of 5.8: the command, its Turtle shape, and the sentence's content ------

# (name, command args, the Turtle 5.8 writes, the key the form reads back)
ROWS = [
    (
        "some",
        dict(**{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine"),
        "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:someValuesFrom shop:OrderLine ] .",
        {"form": "every", "property": EX + "hasLine", "kind": "some", "filler": EX + "OrderLine", "n": None},
    ),
    (
        "only",
        dict(**{"class": EX + "Order"}, property=EX + "hasLine", kind="only", filler=EX + "OrderLine"),
        "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:allValuesFrom shop:OrderLine ] .",
        {"form": "every", "property": EX + "hasLine", "kind": "only", "filler": EX + "OrderLine", "n": None},
    ),
    (
        "exactly-qualified",
        dict(**{"class": EX + "Order"}, property=EX + "hasLine", kind="exactly", filler=EX + "OrderLine", n=2),
        'shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; '
        'owl:qualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass shop:OrderLine ] .',
        {"form": "every", "property": EX + "hasLine", "kind": "exactly", "filler": EX + "OrderLine", "n": 2},
    ),
    (
        "at-least-qualified",
        dict(**{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", filler=EX + "OrderLine", n=1),
        'shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; '
        'owl:minQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onClass shop:OrderLine ] .',
        {"form": "every", "property": EX + "hasLine", "kind": "atLeast", "filler": EX + "OrderLine", "n": 1},
    ),
    (
        "at-most-unqualified",
        dict(**{"class": EX + "Order"}, property=EX + "hasLine", kind="atMost", n=10),
        'shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; '
        'owl:maxCardinality "10"^^xsd:nonNegativeInteger ] .',
        {"form": "every", "property": EX + "hasLine", "kind": "atMost", "filler": None, "n": 10},
    ),
    (
        "attribute-at-most-one",
        dict(**{"class": EX + "Person"}, property=EX + "birthDate", kind="atMost", n=1),
        'shop:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:birthDate ; '
        'owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .',
        {"form": "every", "property": EX + "birthDate", "kind": "atMost", "filler": None, "n": 1},
    ),
    (
        "attribute-exactly-a-date",
        dict(**{"class": EX + "Person"}, property=EX + "birthDate", kind="exactly", filler="xsd:date", n=1),
        'shop:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:birthDate ; '
        'owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:date ] .',
        {"form": "every", "property": EX + "birthDate", "kind": "exactly", "filler": str(XSD.date), "n": 1},
    ),
    (
        "value-literal",
        dict(**{"class": EX + "GoldCustomer"}, property=EX + "status", kind="value",
             filler={"kind": "typed", "value": "gold", "datatype": "xsd:string"}),
        'shop:GoldCustomer rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:status ; owl:hasValue "gold" ] .',
        {"form": "every", "property": EX + "status", "kind": "value",
         "filler": {"kind": "typed", "value": "gold", "datatype": "xsd:string"}, "n": None},
    ),
    (
        "value-thing",
        dict(**{"class": EX + "Employee"}, property=EX + "manages", kind="value", filler=EX + "acme"),
        "shop:Employee rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:manages ; owl:hasValue shop:acme ] .",
        {"form": "every", "property": EX + "manages", "kind": "value", "filler": EX + "acme", "n": None},
    ),
    (
        "defines-with-a-class",
        dict(**{"class": EX + "Manager"}, form="defines", property=EX + "manages", kind="some",
             filler=EX + "Employee", **{"with": EX + "Person"}),
        "shop:Manager owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( shop:Person "
        "[ a owl:Restriction ; owl:onProperty shop:manages ; owl:someValuesFrom shop:Employee ] ) ] .",
        {"form": "defines", "property": EX + "manages", "kind": "some", "filler": EX + "Employee", "n": None,
         "with": EX + "Person"},
    ),
    (
        "defines-alone",
        dict(**{"class": EX + "Manager"}, form="defines", property=EX + "manages", kind="some", filler=EX + "Employee"),
        "shop:Manager owl:equivalentClass [ a owl:Restriction ; owl:onProperty shop:manages ; owl:someValuesFrom shop:Employee ] .",
        {"form": "defines", "property": EX + "manages", "kind": "some", "filler": EX + "Employee", "n": None},
    ),
]


@pytest.mark.parametrize("name,args,turtle,key", ROWS, ids=[r[0] for r in ROWS])
def test_a_rule_written_by_the_form_is_the_turtle_shape_of_5_8(pid, name, args, turtle, key):
    """AC-8 and AC-9, form to Turtle: the command's graph is isomorphic to
    the one 5.8's Turtle makes, and it is one undo step."""
    before = copy(graph(pid))
    result = ok(pid, "AddRestriction", **args)
    assert result["label"].startswith("Added a rule on ")
    made = copy(graph(pid))
    apply(pid, turtle)
    assert isomorphic(made, graph(pid))
    # The apply is one step and the command another: two undos, back to the start.
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert isomorphic(graph(pid), made)
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert isomorphic(graph(pid), before)
    assert client.post(f"/api/projects/{pid}/documents/model/redo").status_code == 200
    assert isomorphic(graph(pid), made)


@pytest.mark.parametrize("name,args,turtle,key", ROWS, ids=[r[0] for r in ROWS])
def test_a_rule_written_in_turtle_reads_back_as_its_sentence(pid, name, args, turtle, key):
    """AC-9, Turtle to form: the shape reads back with the content the form
    would have written, editable, and named by the key the commands take."""
    apply(pid, turtle)
    items = [i for i in rules(pid, args["class"])["items"] if i["type"] == "restriction"]
    assert len(items) == 1
    item = items[0]
    assert item["editable"] is True
    assert item["key"] == key
    # The key names it: Remove takes it away whole, no blank node left over.
    ok(pid, "RemoveRestriction", **{"class": args["class"]}, restriction=key)
    assert not any(isinstance(s, BNode) or isinstance(o, BNode) for s, _, o in graph(pid))


def test_the_sentence_parts_come_with_labels(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    item = rules(pid, EX + "Order")["items"][0]
    assert item["property"] == {"iri": EX + "hasLine", "label": "has line", "kind": "relationship"}
    assert item["filler"] == {"iri": EX + "OrderLine", "label": "Order line"}
    assert item["form"] == "every" and item["kind"] == "some" and item["n"] is None


# --- R12: outside 5.8, read-only as Turtle, never rewritten ----------------------------


UNION = (
    "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; "
    "owl:someValuesFrom [ a owl:Class ; owl:unionOf ( shop:OrderLine shop:Person ) ] ] ."
)


def test_a_union_is_shown_read_only_as_its_turtle_and_counted_on_the_box(pid):
    apply(pid, UNION)
    items = rules(pid, EX + "Order")["items"]
    assert [i["type"] for i in items] == ["turtle"]
    assert items[0]["editable"] is False
    assert "owl:unionOf" in items[0]["turtle"] and "shop:hasLine" in items[0]["turtle"]
    view = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    order = next(n for n in view["nodes"] if n["iri"] == EX + "Order")
    assert order["moreRules"] == 1
    assert not [e for e in view["edges"] if e["kind"] == "rule"]


def test_no_command_rewrites_a_rule_outside_5_8(pid):
    apply(pid, UNION)
    before = copy(graph(pid))
    key = {"form": "every", "property": EX + "hasLine", "kind": "some", "filler": None, "n": None}
    for command in ("RemoveRestriction", "ReplaceRestriction"):
        response = run(pid, command, **{"class": EX + "Order"}, restriction=key, property=EX + "hasLine",
                       kind="some", filler=EX + "OrderLine")
        assert response.status_code == 404
        assert "has no such rule" in response.json()["detail"]
    assert isomorphic(graph(pid), before)
    # A rule added beside it leaves it as it was.
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="only", filler=EX + "OrderLine")
    items = rules(pid, EX + "Order")["items"]
    assert [i["type"] for i in items] == ["restriction", "turtle"]


@pytest.mark.parametrize("extra", [
    # A count written twice, an inverse property, a chain of two predicates on one node.
    "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty [ owl:inverseOf shop:hasLine ] ; owl:someValuesFrom shop:OrderLine ] .",
    "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:someValuesFrom shop:OrderLine ; owl:allValuesFrom shop:OrderLine ] .",
    "shop:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:birthDate ; owl:someValuesFrom xsd:date ] .",
    "shop:Order owl:disjointWith [ owl:complementOf shop:Person ] .",
    # One more statement on the restriction than its shape has.
    'shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:someValuesFrom shop:OrderLine ; rdfs:comment "x" ] .',
])
def test_other_expressions_are_turtle_too(pid, extra):
    apply(pid, extra)
    subject = EX + ("Person" if "shop:Person rdfs" in extra else "Order")
    assert [i["type"] for i in rules(pid, subject)["items"]] == ["turtle"]


def test_a_rule_is_editable_only_where_this_document_defines_the_class_and_holds_it():
    """An import's rule on its own class reads as a sentence, read-only."""
    view = Graph()
    view.parse(data=MODEL + "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; "
               "owl:someValuesFrom shop:OrderLine ] .", format="turtle")
    own = Graph()
    own.parse(data=MODEL, format="turtle")
    [item] = axioms.class_rules(view, U("Order"), own, str)
    assert item["type"] == "restriction" and item["editable"] is False
    [item] = axioms.class_rules(view, U("Order"), view, str)
    assert item["editable"] is True


# --- the matcher by content (5.10) -------------------------------------------------------


SOME = {"form": "every", "property": EX + "hasLine", "kind": "some", "filler": EX + "OrderLine", "n": None}


def test_a_duplicate_is_refused_and_nothing_is_written(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    before, at = copy(graph(pid)), revision(pid)
    response = run(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some",
                   filler=EX + "OrderLine")
    assert response.status_code == 422
    assert response.json()["detail"] == "Order already has this rule."
    assert isomorphic(graph(pid), before) and revision(pid) == at


def test_a_duplicate_written_in_turtle_is_one_rule_by_its_content(pid):
    # Two identical restrictions on fresh blank nodes are one rule: Remove takes one.
    turtle = "shop:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:someValuesFrom shop:OrderLine ] ."
    apply(pid, turtle + "\n" + turtle)
    assert len([i for i in rules(pid, EX + "Order")["items"] if i["type"] == "restriction"]) == 2
    ok(pid, "RemoveRestriction", **{"class": EX + "Order"}, restriction=SOME)
    assert len([i for i in rules(pid, EX + "Order")["items"] if i["type"] == "restriction"]) == 1


def test_replace_sweeps_the_old_rule_and_writes_the_new_as_one_step(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    before = copy(graph(pid))
    result = ok(pid, "ReplaceRestriction", **{"class": EX + "Order"}, restriction=SOME,
                property=EX + "hasLine", kind="atLeast", filler=EX + "OrderLine", n=2)
    assert result["label"] == "Changed a rule on has line of Order"
    items = rules(pid, EX + "Order")["items"]
    assert [(i["kind"], i["n"]) for i in items] == [("atLeast", 2)]
    assert len([t for t in graph(pid) if isinstance(t[0], BNode)]) == 4
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert isomorphic(graph(pid), before)


def test_replace_with_the_same_rule_changes_nothing(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    response = run(pid, "ReplaceRestriction", **{"class": EX + "Order"}, restriction=SOME,
                   property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    assert response.status_code == 422 and response.json()["detail"] == "That would change nothing."


def test_a_missing_rule_is_404_with_a_sentence(pid):
    response = run(pid, "RemoveRestriction", **{"class": EX + "Order"}, restriction=SOME)
    assert response.status_code == 404
    assert response.json()["detail"].startswith("Order has no such rule")


def test_a_defining_form_is_found_without_its_named_class(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Manager"}, form="defines", property=EX + "manages", kind="some",
       filler=EX + "Employee", **{"with": EX + "Person"})
    key = {"form": "defines", "property": EX + "manages", "kind": "some", "filler": EX + "Employee", "n": None}
    ok(pid, "RemoveRestriction", **{"class": EX + "Manager"}, restriction=key)
    assert not any(isinstance(s, BNode) for s, _, _ in graph(pid))


def test_deleting_the_class_takes_its_rules(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Manager"}, form="defines", property=EX + "manages", kind="some",
       filler=EX + "Employee", **{"with": EX + "Person"})
    ok(pid, "DeleteEntity", iri=EX + "Manager")
    assert not any(isinstance(s, BNode) or isinstance(o, BNode) for s, _, o in graph(pid))


def test_a_rule_is_written_only_on_this_documents_class(pid):
    response = run(pid, "AddRestriction", **{"class": str(OWL.Thing)}, property=EX + "hasLine", kind="some",
                   filler=EX + "OrderLine")
    assert response.status_code == 422
    assert "in this document" in response.json()["detail"]


# --- the checks of 5.10, each before anything is written ---------------------------------


def _refused(pid: str, command: str, sentence: str, **args) -> None:
    before, at = copy(graph(pid)), revision(pid)
    response = run(pid, command, **args)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == sentence
    assert isomorphic(graph(pid), before) and revision(pid) == at


def test_r11_at_least_above_at_most_is_refused(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atMost", n=2)
    _refused(pid, "AddRestriction", "Order cannot have at least 3 and at most 2 lines.",
             **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=3)
    # Exactly is both: exactly 3 is at least 3.
    _refused(pid, "AddRestriction", "Order cannot have at least 3 and at most 2 lines.",
             **{"class": EX + "Order"}, property=EX + "hasLine", kind="exactly", n=3)
    # A different filler is a different count: no contradiction.
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=3,
       filler=EX + "OrderLine")


def test_replacing_a_count_is_checked_without_the_one_it_replaces(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atMost", n=2)
    key = {"form": "every", "property": EX + "hasLine", "kind": "atMost", "filler": None, "n": 2}
    ok(pid, "ReplaceRestriction", **{"class": EX + "Order"}, restriction=key, property=EX + "hasLine",
       kind="atLeast", n=3)


def test_r11_a_count_on_a_relationship_that_chains_is_refused(pid):
    _refused(pid, "AddRestriction",
             'part of chains, so OWL 2 does not allow counting it. Use "has at least one" instead.',
             **{"class": EX + "Order"}, property=EX + "partOf", kind="atLeast", n=1)
    # One with a chaining relationship under it is not simple either.
    _refused(pid, "AddRestriction",
             'part of chains and is under within, so OWL 2 does not allow counting within. '
             'Use "has at least one" instead.',
             **{"class": EX + "Order"}, property=EX + "within", kind="exactly", n=1)
    # *some* is allowed on it.
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "partOf", kind="some", filler=EX + "Order")


@pytest.mark.parametrize("n", [-1, 1001, True, 1.5, "2", None])
def test_n_is_a_whole_number_from_0_to_1000(pid, n):
    _refused(pid, "AddRestriction", "A number of 0 to 1,000.",
             **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=n)


def test_0_and_1000_are_allowed(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=0)
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atMost", n=1000)


def test_an_attribute_takes_only_a_count_or_a_value(pid):
    _refused(pid, "AddRestriction",
             "birth date is an attribute; an attribute takes exactly, at least, at most or a value.",
             **{"class": EX + "Person"}, property=EX + "birthDate", kind="some", filler="xsd:date")


def test_some_and_only_need_a_class(pid):
    _refused(pid, "AddRestriction", "Choose the class it points to.",
             **{"class": EX + "Order"}, property=EX + "hasLine", kind="some")


def test_a_class_disjoint_with_or_the_same_as_itself_is_refused(pid):
    _refused(pid, "AddDisjointWith", "A class cannot be disjoint with itself.", a=EX + "Person", b=EX + "Person")
    _refused(pid, "AddEquivalentClass", "A class cannot mean the same as itself.", a=EX + "Person", b=EX + "Person")


def test_equivalent_and_disjoint_together_are_refused_either_way(pid):
    ok(pid, "AddDisjointWith", a=EX + "Client", b=EX + "Customer")
    _refused(pid, "AddEquivalentClass", "Client cannot mean the same as Customer and be disjoint with it.",
             a=EX + "Client", b=EX + "Customer")
    ok(pid, "RemoveDisjointWith", a=EX + "Customer", b=EX + "Client")
    ok(pid, "AddEquivalentClass", a=EX + "Customer", b=EX + "Client")
    _refused(pid, "AddDisjointWith", "Client cannot be disjoint with Customer and mean the same as it.",
             a=EX + "Client", b=EX + "Customer")


def test_disjoint_and_equivalent_are_each_one_statement_read_either_way(pid):
    result = ok(pid, "AddDisjointWith", a=EX + "Person", b=EX + "Organization")
    assert result["label"] == "Made Person and Organization disjoint"
    assert (U("Person"), OWL.disjointWith, U("Organization")) in graph(pid)
    items = rules(pid, EX + "Organization")["items"]
    assert items == [{"type": "disjoint", "other": {"iri": EX + "Person", "label": "Person"}, "editable": True}]
    _refused(pid, "AddDisjointWith", "Organization and Person are already disjoint.",
             a=EX + "Organization", b=EX + "Person")
    ok(pid, "RemoveDisjointWith", a=EX + "Organization", b=EX + "Person")
    assert (U("Person"), OWL.disjointWith, U("Organization")) not in graph(pid)
    ok(pid, "AddEquivalentClass", a=EX + "Client", b=EX + "Customer")
    assert rules(pid, EX + "Customer")["items"][0]["type"] == "equivalent"
    ok(pid, "RemoveEquivalentClass", a=EX + "Customer", b=EX + "Client")
    assert (U("Client"), OWL.equivalentClass, U("Customer")) not in graph(pid)


def test_a_kind_of_two_disjoint_classes_is_kept_and_warned(pid):
    ok(pid, "AddSubClassOf", child=EX + "Robot", parent=EX + "Person")
    ok(pid, "AddSubClassOf", child=EX + "Robot", parent=EX + "Organization")
    ok(pid, "AddDisjointWith", a=EX + "Person", b=EX + "Organization")
    sentence = "Robot can never have members: it would be a kind of Organization and of Person."
    assert rules(pid, EX + "Robot")["warnings"] == [{"text": sentence}]
    # Under Person's disjoint rule too, where the change was made.
    assert rules(pid, EX + "Person")["warnings"] == [{"text": sentence, "disjoint": EX + "Organization"}]


def test_disjoint_with_one_of_its_own_kinds_is_kept_and_warned(pid):
    ok(pid, "AddSubClassOf", child=EX + "Employee", parent=EX + "Person")
    ok(pid, "AddDisjointWith", a=EX + "Employee", b=EX + "Person")
    text = "Employee can never have members: it is a kind of Person and disjoint with it."
    assert rules(pid, EX + "Employee")["warnings"] == [{"text": text, "disjoint": EX + "Person"}]
    assert rules(pid, EX + "Person")["warnings"] == [{"text": text, "disjoint": EX + "Employee"}]



# --- owl:AllDisjointClasses, as Protégé writes three or more (PR #56 review) -------------


GROUP = "[] a owl:AllDisjointClasses ; owl:members ( shop:Person shop:Organization shop:Robot ) ."


def test_an_all_disjoint_group_is_read_only_turtle_in_each_members_block(pid):
    apply(pid, GROUP)
    for member in ("Person", "Organization", "Robot"):
        items = rules(pid, EX + member)["items"]
        assert [i["type"] for i in items] == ["turtle"], member
        assert items[0]["editable"] is False
        turtle = items[0]["turtle"]
        assert "owl:AllDisjointClasses" in turtle
        assert all(f"shop:{m}" in turtle for m in ("Person", "Organization", "Robot"))
    assert rules(pid, EX + "Order")["items"] == []


def _group(g: Graph) -> Graph:
    out = Graph()
    for t in axioms.closure(g, next(g.subjects(RDF.type, OWL.AllDisjointClasses))):
        out.add(t)
    return out


def test_no_command_rewrites_an_all_disjoint_group(pid):
    apply(pid, GROUP)
    before = copy(graph(pid))
    response = run(pid, "RemoveDisjointWith", a=EX + "Person", b=EX + "Organization")
    assert response.status_code == 422
    assert isomorphic(graph(pid), before)
    # A rule added beside it leaves it as it was, and both are shown.
    ok(pid, "AddRestriction", **{"class": EX + "Person"}, property=EX + "birthDate", kind="atMost", n=1)
    assert [i["type"] for i in rules(pid, EX + "Person")["items"]] == ["restriction", "turtle"]
    assert isomorphic(_group(graph(pid)), _group(before))


def test_removing_a_disjointness_only_a_group_states_says_so_truly(pid):
    # X-12, T-25: it said "not disjoint in this document", which was untrue.
    apply(pid, GROUP)
    _refused(pid, "RemoveDisjointWith",
             "Person and Organization are disjoint through a group of classes written in Turtle. Edit it in Turtle.",
             a=EX + "Person", b=EX + "Organization")
    # Two classes no statement makes disjoint keep their sentence.
    _refused(pid, "RemoveDisjointWith", "Person and Order are not disjoint in this document.",
             a=EX + "Person", b=EX + "Order")


def test_adding_a_disjointness_a_group_already_states_is_refused(pid):
    # X-12, T-26 (Q2): refused as a duplicate rule is, nothing written.
    apply(pid, GROUP)
    _refused(pid, "AddDisjointWith", "Person and Organization are already disjoint.",
             a=EX + "Person", b=EX + "Organization")
    _refused(pid, "AddDisjointWith", "Robot and Person are already disjoint.", a=EX + "Robot", b=EX + "Person")
    assert not list(graph(pid).triples((None, OWL.disjointWith, None)))
    # A class outside the group is made disjoint as before.
    ok(pid, "AddDisjointWith", a=EX + "Person", b=EX + "Order")


def test_equivalent_to_a_class_in_its_all_disjoint_group_is_refused(pid):
    apply(pid, GROUP)
    _refused(pid, "AddEquivalentClass", "Person cannot mean the same as Organization and be disjoint with it.",
             a=EX + "Person", b=EX + "Organization")
    _refused(pid, "AddEquivalentClass", "Robot cannot mean the same as Person and be disjoint with it.",
             a=EX + "Robot", b=EX + "Person")
    ok(pid, "AddEquivalentClass", a=EX + "Person", b=EX + "Client")


def test_a_kind_of_two_classes_of_an_all_disjoint_group_is_kept_and_warned(pid):
    apply(pid, GROUP)
    ok(pid, "AddSubClassOf", child=EX + "Employee", parent=EX + "Person")
    ok(pid, "AddSubClassOf", child=EX + "Employee", parent=EX + "Organization")
    sentence = "Employee can never have members: it would be a kind of Organization and of Person."
    assert rules(pid, EX + "Employee")["warnings"] == [{"text": sentence}]
    assert {"text": sentence, "disjoint": EX + "Organization"} in rules(pid, EX + "Person")["warnings"]


def test_a_kind_of_a_class_in_its_own_all_disjoint_group_is_kept_and_warned(pid):
    apply(pid, GROUP)
    ok(pid, "AddSubClassOf", child=EX + "Robot", parent=EX + "Person")
    text = "Robot can never have members: it is a kind of Person and disjoint with it."
    assert rules(pid, EX + "Robot")["warnings"] == [{"text": text, "disjoint": EX + "Person"}]
    assert rules(pid, EX + "Person")["warnings"] == [{"text": text, "disjoint": EX + "Robot"}]


def test_an_all_disjoint_group_gives_each_box_its_never_lines(pid):
    apply(pid, GROUP)
    view = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    nodes = {n["iri"]: n for n in view["nodes"]}
    ref = lambda local, label: {"iri": EX + local, "label": label}  # noqa: E731
    assert nodes[EX + "Person"]["disjoint"] == [ref("Organization", "Organization"), ref("Robot", "Robot")]
    assert nodes[EX + "Robot"]["disjoint"] == [ref("Organization", "Organization"), ref("Person", "Person")]
    assert "disjoint" not in nodes[EX + "Order"]

# --- the builder's choices ---------------------------------------------------------------


def test_the_builder_is_offered_the_models_properties_classes_and_things(pid):
    choices = rules(pid, EX + "Order")["choices"]
    props = {p["iri"]: p["kind"] for p in choices["properties"]["items"]}
    assert props[EX + "hasLine"] == "relationship" and props[EX + "birthDate"] == "attribute"
    assert EX + "OrderLine" in {c["iri"] for c in choices["classes"]["items"]}
    assert EX + "acme" in {t["iri"] for t in choices["things"]["items"]}
    assert choices["classes"]["total"] == len(choices["classes"]["items"])


# --- the canvas (5.9) -------------------------------------------------------------------


def test_rule_lines_on_the_canvas_and_a_defining_one(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=1,
       filler=EX + "OrderLine")
    ok(pid, "AddRestriction", **{"class": EX + "Manager"}, form="defines", property=EX + "manages", kind="some",
       filler=EX + "Employee", **{"with": EX + "Person"})
    ok(pid, "AddRestriction", **{"class": EX + "Person"}, property=EX + "birthDate", kind="atMost", n=1)
    ok(pid, "AddDisjointWith", a=EX + "Person", b=EX + "Organization")
    view = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    lines = {(e["source"], e["target"]): e for e in view["edges"] if e["kind"] == "rule"}
    assert set(lines) == {(EX + "Order", EX + "OrderLine"), (EX + "Manager", EX + "Employee")}
    order = lines[(EX + "Order", EX + "OrderLine")]
    assert order["rule"] == {"form": "every", "kind": "atLeast", "n": 1, "property": EX + "hasLine",
                             "propertyLabel": "has line", "fillerLabel": "Order line", "withLabel": None}
    assert order["key"]["kind"] == "atLeast"
    assert lines[(EX + "Manager", EX + "Employee")]["rule"]["form"] == "defines"
    assert lines[(EX + "Manager", EX + "Employee")]["rule"]["withLabel"] == "Person"
    nodes = {n["iri"]: n for n in view["nodes"]}
    # An attribute's count has no class at the other end: counted on the box.
    assert nodes[EX + "Person"]["moreRules"] == 1
    assert nodes[EX + "Person"]["disjoint"] == [{"iri": EX + "Organization", "label": "Organization"}]
    assert nodes[EX + "Organization"]["disjoint"] == [{"iri": EX + "Person", "label": "Person"}]
    assert "moreRules" not in nodes[EX + "Order"]


# --- AC-12: Check it in data too ---------------------------------------------------------


def _shape_of(pid: str, cls: str):
    shapes = graph(pid, "shapes")
    return [s for s in shapes_form.listed_shapes(shapes) if (s, URIRef(SH + "targetClass"), URIRef(cls)) in shapes]


def test_r13_check_it_in_data_too_adds_the_rule_in_one_undo_step_and_validate_reports(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    ok(pid, "CreateExample", **{"class": EX + "Order"}, label="order 7")
    before = copy(graph(pid, "shapes"))
    model_before = copy(graph(pid))
    result = ok(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=SOME)
    assert result["label"] == "Added a check on has line to Order rules"
    assert isomorphic(graph(pid), model_before)  # the model is not touched
    [node] = _shape_of(pid, EX + "Order")
    expected = Graph()
    expected.parse(data=PREFIXES + f"""
        <{node}> a sh:NodeShape ; rdfs:label "Order rules"@en ; sh:targetClass shop:Order ;
          sh:property [ sh:path shop:hasLine ; sh:qualifiedValueShape [ sh:class shop:OrderLine ] ;
                        sh:qualifiedMinCount 1 ] .
    """, format="turtle")
    added = Graph()
    for t in set(graph(pid, "shapes")) - set(before):
        added.add(t)
    assert isomorphic(added, expected)
    report = client.post(f"/api/projects/{pid}/validate").json()
    problems = [p for s in report["shapes"] if s.get("id") == str(node) for p in s["problems"]]
    assert [p["focus"] for p in problems] == [EX + "order7"]
    # In the learner's words, not the validator's.
    assert [p["sentence"] for p in problems] == ["order 7 is not linked by has line to an Order line; every Order must be."]
    # One undo step in shapes.ttl takes it all away.
    assert client.post(f"/api/projects/{pid}/documents/shapes/undo").status_code == 200
    assert isomorphic(graph(pid, "shapes"), before)


def test_a_qualified_check_is_read_only_in_the_shapes_form_and_never_rewritten(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=SOME)
    [node] = _shape_of(pid, EX + "Order")
    view = client.get(f"/api/projects/{pid}/shapes").json()
    shape = next(s for s in view["shapes"] if s["iri"] == str(node))
    assert shape["editable"] is False
    assert "uses sh:qualifiedValueShape" in shape["unsupported"]
    before = copy(graph(pid, "shapes"))
    for command, args in (
        ("AddRule", {"rule": {"path": [EX + "hasLine"], "minCount": 2}, "merge": True}),
        ("ReplaceRule", {"path": [EX + "hasLine"], "rule": {"path": [EX + "hasLine"], "minCount": 2}}),
        ("RemoveRule", {"path": [EX + "hasLine"]}),
        ("SetShapeSeverity", {"severity": "warning"}),
    ):
        response = run(pid, command, "shapes", shape=str(node), **args)
        assert response.status_code == 422, command
        assert "Change it in the Turtle editor" in response.json()["detail"]
    assert isomorphic(graph(pid, "shapes"), before)
    # A second check beside it adds, and still rewrites nothing.
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atMost", n=5)
    key = {"form": "every", "property": EX + "hasLine", "kind": "atMost", "filler": None, "n": 5}
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=key)
    assert set(before) <= set(graph(pid, "shapes"))


def test_a_check_twice_is_refused(pid):
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="some", filler=EX + "OrderLine")
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=SOME)
    response = run(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=SOME)
    assert response.status_code == 422 and response.json()["detail"] == "Order rules already checks this."


def test_a_plain_check_joins_the_forms_rule_and_the_shape_stays_editable(pid):
    sid = ok(pid, "CreateShape", "shapes", target=EX + "Order")["created"]
    ok(pid, "AddRule", "shapes", shape=sid, rule={"path": [EX + "hasLine"], "minCount": 1})
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="only", filler=EX + "OrderLine")
    only = {"form": "every", "property": EX + "hasLine", "kind": "only", "filler": EX + "OrderLine", "n": None}
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=only)
    shape = next(s for s in client.get(f"/api/projects/{pid}/shapes").json()["shapes"] if s["iri"] == sid)
    assert shape["editable"] is True
    [rule] = shape["rules"]
    assert rule["minCount"] == 1 and rule["class"] == EX + "OrderLine"
    # A count that disagrees with the form's rule is refused, never overwritten.
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "hasLine", kind="atLeast", n=3)
    three = {"form": "every", "property": EX + "hasLine", "kind": "atLeast", "filler": None, "n": 3}
    response = run(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=three)
    assert response.status_code == 422
    assert response.json()["detail"] == "Order rules already checks has line differently; change that rule in the Shapes view."


def test_a_check_of_a_rule_the_model_lacks_is_404(pid):
    response = run(pid, "CheckInData", "shapes", **{"class": EX + "Order"}, restriction=SOME)
    assert response.status_code == 404


@pytest.mark.parametrize("name,args,turtle,key", ROWS, ids=[r[0] for r in ROWS])
def test_every_rule_can_be_checked_in_data(pid, name, args, turtle, key):
    ok(pid, "AddRestriction", **args)
    ok(pid, "CheckInData", "shapes", **{"class": args["class"]}, restriction=key)
    assert client.post(f"/api/projects/{pid}/validate").status_code == 200


def test_a_checked_value_and_count_are_reported_in_words(pid):
    value = {"form": "every", "property": EX + "status", "kind": "value",
             "filler": {"kind": "typed", "value": "gold", "datatype": "xsd:string"}, "n": None}
    ok(pid, "AddRestriction", **{"class": EX + "GoldCustomer"}, property=EX + "status", kind="value",
       filler={"kind": "typed", "value": "gold", "datatype": "xsd:string"})
    ok(pid, "AddRestriction", **{"class": EX + "Person"}, property=EX + "birthDate", kind="atMost", n=1,
       filler="xsd:date")
    ok(pid, "CheckInData", "shapes", **{"class": EX + "GoldCustomer"}, restriction=value)
    count = {"form": "every", "property": EX + "birthDate", "kind": "atMost", "filler": str(XSD.date), "n": 1}
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Person"}, restriction=count)
    ok(pid, "CreateExample", **{"class": EX + "GoldCustomer"}, label="Gail")
    ok(pid, "CreateExample", **{"class": EX + "Person"}, label="Pat")
    for day in ("2000-01-01", "2000-01-02"):
        ok(pid, "AddExampleValue", iri=EX + "pat", property=EX + "birthDate",
           value={"kind": "typed", "value": day, "datatype": "xsd:date"})
    report = client.post(f"/api/projects/{pid}/validate").json()
    said = {p["sentence"] for s in report["shapes"] for p in s["problems"]}
    assert 'Gail does not have status "gold"; every Gold customer must.' in said
    assert "Pat has 2 birth dates that are dates; every Person may have at most 1." in said


# --- found in the code review of PR #56 ----------------------------------------------------


def test_a_counted_relationship_cannot_be_made_to_chain_afterwards(pid):
    """One rule, both directions: a count needs a simple relationship, so
    making the counted one chain, or putting a chaining one under it, is
    refused as adding the count to a chaining one is."""
    ok(pid, "AddRestriction", **{"class": EX + "Order"}, property=EX + "manages", kind="atMost", n=1)
    before = copy(graph(pid))
    response = run(pid, "SetCharacteristic", property=EX + "manages", characteristic="transitive", on=True)
    assert response.status_code == 422
    assert response.json()["detail"] == (
        'A rule counts manages, and OWL 2 does not allow counting a relationship that chains. '
        'Remove the count, or leave "Chains" off.'
    )
    response = run(pid, "AddSubPropertyOf", child=EX + "partOf", parent=EX + "manages")
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "A rule counts manages, and part of chains and is under it; OWL 2 does not allow counting it then."
    )
    assert isomorphic(graph(pid), before)


def test_a_rule_command_on_the_shapes_document_says_so(pid):
    response = run(pid, "AddDisjointWith", "shapes", a=EX + "Person", b=EX + "Order")
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "A class's rules live in model.ttl; run rule commands on the model document."
    )


def test_a_class_disjoint_with_itself_in_turtle_is_shown_warned_and_counted(pid):
    apply(pid, "shop:Robot owl:disjointWith shop:Robot .")
    got = rules(pid, EX + "Robot")
    assert [i["type"] for i in got["items"]] == ["turtle"]
    assert "owl:disjointWith shop:Robot" in got["items"][0]["turtle"]
    assert got["warnings"] == [{"text": "Robot can never have members: it is disjoint with itself."}]
    view = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    assert next(n for n in view["nodes"] if n["iri"] == EX + "Robot")["moreRules"] == 1


def test_a_plain_text_value_counts_as_text_in_the_checks_sentence(pid):
    """pySHACL takes Turtle's plain "P" for xsd:string, and so does the count."""
    apply(pid, '''
shop:nickname a owl:DatatypeProperty ; rdfs:label "nickname"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:nickname ;
    owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:string ] .
shop:pat a shop:Person, owl:NamedIndividual ; rdfs:label "Pat"@en ; shop:nickname "P", "Patty" .
''')
    key = {"form": "every", "property": EX + "nickname", "kind": "atMost", "filler": str(XSD.string), "n": 1}
    ok(pid, "CheckInData", "shapes", **{"class": EX + "Person"}, restriction=key)
    report = client.post(f"/api/projects/{pid}/validate").json()
    said = {p["sentence"] for s in report["shapes"] for p in s["problems"]}
    assert "Pat has 2 nicknames that are text; every Person may have at most 1." in said


def test_the_builder_offers_only_the_projects_own_examples_as_things():
    own = Graph()
    own.parse(data=MODEL, format="turtle")
    view = Graph()
    view.parse(data=MODEL + "shop:imported a owl:NamedIndividual , shop:Organization .", format="turtle")
    things = {t["iri"] for t in axioms.choices(view, own, str)["things"]["items"]}
    assert EX + "acme" in things and EX + "imported" not in things


def test_the_builders_choices_are_built_once_per_revision(pid, monkeypatch):
    calls = []
    real = axioms.choices
    monkeypatch.setattr(axioms, "choices", lambda *a: calls.append(1) or real(*a))
    rules(pid, EX + "Order")
    rules(pid, EX + "Person")
    assert len(calls) == 1
    ok(pid, "CreateClass", label="Invoice")
    choices = rules(pid, EX + "Order")["choices"]
    assert len(calls) == 2
    assert EX + "Invoice" in {c["iri"] for c in choices["classes"]["items"]}



# --- one reader of a domain (attribute-reuse 5.3, D-116) --------------------------------

D = "http://example.org/d#"
DOMAIN_PREFIXES = f"""@prefix d: <{D}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
"""


def _domain(turtle: str, prop: str = "p") -> axioms.DomainReading:
    g = Graph()
    g.parse(data=DOMAIN_PREFIXES + turtle, format="turtle")
    return axioms.domain_of(g, URIRef(D + prop))


def test_domain_of_reads_each_of_the_five_forms():
    """AC-7: none, one, union (owl:Class optional when read), separate,
    expression."""
    assert _domain("d:p a owl:DatatypeProperty .").form == "none"
    one = _domain("d:p rdfs:domain d:Employee .")
    assert (one.form, one.classes) == ("one", (URIRef(D + "Employee"),))
    union = _domain("d:p rdfs:domain [ a owl:Class ; owl:unionOf ( d:Employee d:Manager ) ] .")
    assert union.form == "union" and union.classes == (URIRef(D + "Employee"), URIRef(D + "Manager"))
    assert isinstance(union.node, BNode)
    untyped = _domain("d:p rdfs:domain [ owl:unionOf ( d:Employee d:Manager ) ] .")
    assert untyped.form == "union", "owl:Class is optional when reading"
    separate = _domain("d:p rdfs:domain d:Manager , d:Employee .")
    assert separate.form == "separate"
    assert separate.classes == (URIRef(D + "Employee"), URIRef(D + "Manager"))
    expression = _domain("d:p rdfs:domain [ owl:intersectionOf ( d:Employee d:Manager ) ] .")
    assert expression.form == "expression" and expression.classes == ()


@pytest.mark.parametrize("turtle", [
    # A statement beyond the shape.
    "d:p rdfs:domain [ a owl:Class ; owl:unionOf ( d:A d:B ) ; rdfs:label \"x\" ] .",
    # A type other than owl:Class.
    "d:p rdfs:domain [ a owl:Restriction ; owl:unionOf ( d:A d:B ) ] .",
    # The same node used by a second statement.
    "_:u a owl:Class ; owl:unionOf ( d:A d:B ) . d:p rdfs:domain _:u . d:q rdfs:domain _:u .",
    # A blank member: a nested expression.
    "d:p rdfs:domain [ owl:unionOf ( d:A [ owl:complementOf d:B ] ) ] .",
    # A union beside a named domain.
    "d:p rdfs:domain d:A , [ owl:unionOf ( d:A d:B ) ] .",
    # A list cell with an extra statement.
    "_:c1 rdf:first d:A ; rdf:rest _:c2 ; rdfs:label \"x\" . _:c2 rdf:first d:B ; rdf:rest rdf:nil . "
    "d:p rdfs:domain [ owl:unionOf _:c1 ] .",
    # A list that never ends.
    "_:c1 rdf:first d:A . d:p rdfs:domain [ owl:unionOf _:c1 ] .",
    # An empty list.
    "d:p rdfs:domain [ owl:unionOf () ] .",
])
def test_anything_but_the_exact_union_shape_is_an_expression(turtle):
    """AC-7: the union is read only in 5.3's exact shape."""
    assert _domain(turtle).form == "expression"


def _cyclic() -> Graph:
    g = Graph()
    head, tail = BNode(), BNode()
    node = BNode()
    g.add((URIRef(D + "p"), RDFS.domain, node))
    g.add((node, OWL.unionOf, head))
    g.add((head, RDF.first, URIRef(D + "A")))
    g.add((head, RDF.rest, tail))
    g.add((tail, RDF.first, URIRef(D + "B")))
    g.add((tail, RDF.rest, head))  # back to the start
    return g


def _long(members: int) -> Graph:
    g = Graph()
    node = BNode()
    cells = [BNode() for _ in range(members)]
    g.add((URIRef(D + "p"), RDFS.domain, node))
    g.add((node, RDF.type, OWL.Class))
    g.add((node, OWL.unionOf, cells[0]))
    for i, cell in enumerate(cells):
        g.add((cell, RDF.first, URIRef(f"{D}C{i}")))
        g.add((cell, RDF.rest, cells[i + 1] if i + 1 < members else RDF.nil))
    return g


class _Counting(Graph):
    """Counts the list cells read, to tell a stop on a revisit from a stop
    at the cap: both read a cycle as an expression."""

    def __init__(self, source: Graph):
        super().__init__()
        for t in source:
            self.add(t)
        self.reads = 0

    def predicate_objects(self, subject=None, unique=False):
        self.reads += 1
        return super().predicate_objects(subject, unique)


def test_a_cycle_and_a_list_past_the_cap_are_expressions():
    """AC-14, Section 9: the list walk stops on a revisit and at 100."""
    cyclic = _Counting(_cyclic())
    assert axioms.domain_of(cyclic, URIRef(D + "p")).form == "expression"
    assert cyclic.reads <= 3, "a two-cell cycle stops at its first revisit, not at the cap"
    assert axioms.domain_of(_long(100), URIRef(D + "p")).form == "union"
    assert len(axioms.domain_of(_long(100), URIRef(D + "p")).classes) == 100
    assert axioms.domain_of(_long(101), URIRef(D + "p")).form == "expression"


@pytest.mark.perf
def test_domain_of_on_a_long_or_cyclic_list_budget():
    """Section 10: <= 2 ms on a 101-member list or a cycle, median of five."""
    for g in (_long(101), _cyclic()):
        times = []
        gc.disable()
        try:
            for _ in range(5):
                start = time.perf_counter()
                axioms.domain_of(g, URIRef(D + "p"))
                times.append((time.perf_counter() - start) * 1000)
        finally:
            gc.enable()
        median = sorted(times)[2]
        assert median <= limit_ms(2), f"domain_of took {median:.2f} ms (median of 5)"


# --- the scan: only axioms.py and editing.py read a domain's objects (AC-7) ------------

APP = Path(__file__).resolve().parent.parent / "app"
DOMAIN_READERS = {"axioms.py", "editing.py"}
# Graph calls that hand back what a domain statement points at. subjects()
# is not one: it answers the properties, never the domain.
READING_CALLS = {"objects", "value", "subject_objects", "triples", "predicate_objects", "pairs",
                 "items", "first", "quads", "triples_choices"}
DOMAIN_IRI = "http://www.w3.org/2000/01/rdf-schema#domain"


def _is_domain(node: ast.AST) -> bool:
    if isinstance(node, ast.Attribute) and node.attr == "domain":
        return isinstance(node.value, ast.Name) and node.value.id == "RDFS"
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "RDFS":
        return isinstance(node.slice, ast.Constant) and node.slice.value == "domain"
    return isinstance(node, ast.Constant) and node.value == DOMAIN_IRI


def domain_reads(source: str) -> list[str]:
    """Each call that reads rdfs:domain's objects, and each alias of the
    predicate (a name bound to it would hide a read from the first rule)."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in READING_CALLS:
            arguments = list(node.args) + [k.value for k in node.keywords]
            for arg in arguments:
                parts = arg.elts if isinstance(arg, (ast.Tuple, ast.List)) else [arg]
                # Inside the argument too: URIRef("...#domain") is a read.
                if any(_is_domain(n) for part in parts for n in ast.walk(part)):
                    found.append(f"line {node.lineno}: .{node.func.attr}() reads rdfs:domain")
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None and _is_domain(node.value):
            found.append(f"line {node.lineno}: rdfs:domain bound to a name")
    return found


def test_the_domain_scan_catches_a_planted_read():
    planted = '''
def a(g, p):
    return list(g.objects(p, RDFS.domain))

def b(g, p):
    return g.value(p, RDFS.domain)

def c(g):
    return g.subject_objects(RDFS.domain)

def d(g, p):
    return g.triples((p, RDFS.domain, None))

def e(g, p):
    return g.objects(p, RDFS["domain"])

def f(g, p):
    return g.objects(p, URIRef("http://www.w3.org/2000/01/rdf-schema#domain"))

DOMAIN = RDFS.domain

def fine(g, cls):
    return g.subjects(RDFS.domain, cls)
'''
    assert len(domain_reads(planted)) == 7, domain_reads(planted)


def test_only_axioms_and_editing_read_a_domain():
    files = sorted(APP.rglob("*.py"))
    assert len(files) > 15, "the scan found too few files to mean anything"
    assert domain_reads((APP / "editing.py").read_text(encoding="utf-8")), "the scan sees editing's reads"
    offenders = {}
    for path in files:
        if path.name in DOMAIN_READERS:
            continue
        found = domain_reads(path.read_text(encoding="utf-8"))
        if found:
            offenders[str(path.relative_to(APP))] = found
    assert offenders == {}
