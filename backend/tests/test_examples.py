"""
================================================================================
FILE: backend/tests/test_examples.py
================================================================================

SUMMARY
    Example data (shacl-authoring Stage B, 5.8): which individuals are a
    project's examples, the fields an example's form shows, the four example
    commands with their refusals and undo, the tree's Examples section, the
    canvas leaving examples out, the Small template's two examples and
    starter shapes, and rows S21 to S23 as the server answers them. Also the
    server's half of the Stage A follow-ups: *name (label)* (item 4).

BASIC IDEA
    Through the HTTP API, as the frontend drives it, with the document's
    graph read directly where the API has no window onto it. A refusal is
    asserted as an unmoved revision and an isomorphic graph, not as a
    status code alone.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small and taxonomy-small
      templates; inline Turtle of three to five statements a behaviour
      (rdf-fixture).

EXPECTED OUTPUT
    - Pass/fail for AC-8 and the server side of rows S21 to S23.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

from app import examples
from app.editing import editing_service, project_store
from app.main import app
from app.shapes_form import path_label

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"


def U(local: str) -> URIRef:
    return URIRef(EX + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _create(template: str = "small") -> str:
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": template, "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    return project


@pytest.fixture
def pid() -> str:
    """A fresh small-template project, open: Alice, Acme and three shapes."""
    return _create()


def run(pid: str, command: str, doc: str = "model", **args):
    return client.post(f"/api/projects/{pid}/documents/{doc}/commands", json={"command": command, "args": args})


def ok(pid: str, command: str, **args) -> dict:
    response = run(pid, command, **args)
    assert response.status_code == 200, response.text
    return response.json()


def graph(pid: str) -> Graph:
    return editing_service.document(pid, "model").graph


def copy(pid: str) -> Graph:
    out = Graph()
    for t in graph(pid):
        out.add(t)
    return out


def revision(pid: str) -> int:
    return editing_service.document(pid, "model").ontology.revision


def model_id(pid: str) -> str:
    return editing_service.document(pid, "model").ontology.id


def node(pid: str, iri: str) -> dict:
    response = client.get(f"/api/ontologies/{model_id(pid)}/node", params={"iri": iri})
    assert response.status_code == 200, response.text
    return response.json()


def apply(pid: str, text: str) -> None:
    response = client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})
    assert response.status_code == 200, response.text


def validate(pid: str) -> dict:
    response = client.post(f"/api/projects/{pid}/validate")
    assert response.status_code == 200, response.text
    return response.json()


BIRTH_DATE = """
shop:birthDate a owl:DatatypeProperty ; rdfs:label "birth date"@en ;
    rdfs:domain shop:Person ; rdfs:range xsd:date .
"""


def with_turtle(pid: str, extra: str) -> None:
    """The document as it is, plus a few statements, applied as Turtle."""
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    if "@prefix xsd:" not in text:
        extra = "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n" + extra
    apply(pid, text + "\n" + extra)


# --- which individuals are examples ------------------------------------------


def test_an_individual_of_a_class_is_an_example_and_the_model_is_not():
    g = Graph().parse(data="""
        @prefix : <http://example.org/x#> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
        @prefix sh: <http://www.w3.org/ns/shacl#> .
        :Person a owl:Class .
        :bob a :Person .
        :lone a owl:NamedIndividual .
        :Apple a skos:Concept .
        :PersonRules a sh:NodeShape .
        :knows a owl:ObjectProperty .
    """, format="turtle")
    x = "http://example.org/x#"
    # Written in Turtle with only its class still counts: it is what a
    # shape's sh:targetClass finds.
    assert examples.is_example(g, URIRef(x + "bob"))
    assert examples.example_classes(g, URIRef(x + "bob")) == [URIRef(x + "Person")]
    assert examples.is_example(g, URIRef(x + "lone"))
    assert examples.example_classes(g, URIRef(x + "lone")) == []
    for other in ("Person", "Apple", "PersonRules", "knows"):
        assert not examples.is_example(g, URIRef(x + other)), other
    assert examples.examples(g) == [URIRef(x + "bob"), URIRef(x + "lone")]


# --- the Small template (5.8, row S23) -----------------------------------------


def test_the_small_template_has_alice_and_acme_and_three_editable_starter_shapes(pid):
    g = graph(pid)
    assert (U("alice"), RDF.type, U("Person")) in g
    assert (U("acme"), RDF.type, U("Organization")) in g
    # Alice is not yet member of Acme: the first fix a learner makes.
    assert (U("alice"), U("memberOf"), None) not in g
    assert any(d["role"] == "shapes" for d in project_store.manifest(pid)["documents"])
    shapes = client.get(f"/api/projects/{pid}/shapes").json()["shapes"]
    assert [(s["name"], s["editable"]) for s in shapes] == [
        ("Check my model", True), ("Organization rules", True), ("Person rules", True),
    ]


def test_s23_a_small_projects_first_validate_is_a_mix_of_red_and_green(pid):
    result = validate(pid)
    states = {p["name"]: p["state"] for p in result["shapes"]}
    assert states == {"Person rules": "fails", "Organization rules": "passes", "Check my model": "passes"}
    person = next(p for p in result["shapes"] if p["name"] == "Person rules")
    assert [p["sentence"] for p in person["problems"]] == [
        "Alice is not linked by member of; every Person must be."
    ]
    # The fix, from Alice's form: link her to Acme. Then all is green.
    ok(pid, "SetExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    assert {p["state"] for p in validate(pid)["shapes"]} == {"passes"}


def test_the_taxonomy_small_template_has_no_examples_and_no_starter_shapes():
    pid = _create("taxonomy-small")
    assert examples.examples(graph(pid)) == []
    assert all(d["role"] != "shapes" for d in project_store.manifest(pid)["documents"])


# --- CreateExample and the example commands -----------------------------------


def test_s21_bob_from_persons_form_named_dated_and_linked_to_acme(pid):
    with_turtle(pid, BIRTH_DATE)
    created = ok(pid, "CreateExample", **{"class": "shop:Person", "label": "Bob"})
    assert created["created"] == EX + "bob"
    assert created["label"] == "Created example Bob of Person"
    ok(pid, "SetExampleValue", iri="shop:bob", property="shop:birthDate",
       value={"kind": "typed", "value": "1990-05-01", "datatype": "xsd:date"})
    ok(pid, "AddExampleValue", iri="shop:bob", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    g = graph(pid)
    assert (U("bob"), RDF.type, U("Person")) in g
    assert (U("bob"), RDFS.label, Literal("Bob", lang="en")) in g
    assert (U("bob"), U("birthDate"), Literal("1990-05-01", datatype=XSD.date)) in g
    assert (U("bob"), U("memberOf"), U("acme")) in g
    # The tree lists Bob under Person, in its Examples section.
    tree = client.get(f"/api/ontologies/{model_id(pid)}/hierarchy").json()
    forest = tree["examples"]
    assert EX + "bob" in [c["id"] for c in forest["children"][EX + "Person"]]
    assert forest["nodes"][EX + "bob"]["kind"] == "individual"
    assert tree["counts"]["examples"] == 3
    # Saved and reloaded, the Turtle says it.
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 200
    text = (project_store.folder(pid) / "model.ttl").read_text(encoding="utf-8")
    reloaded = Graph().parse(data=text, format="turtle")
    assert (U("bob"), RDF.type, U("Person")) in reloaded
    assert (U("bob"), U("memberOf"), U("acme")) in reloaded


def test_an_examples_form_lists_its_classes_own_and_inherited_fields(pid):
    with_turtle(pid, BIRTH_DATE + """
shop:Employee a owl:Class ; rdfs:label "Employee"@en ; rdfs:subClassOf shop:Person .
shop:salary a owl:DatatypeProperty ; rdfs:label "salary"@en ; rdfs:domain shop:Employee ; rdfs:range xsd:decimal .
shop:Company a owl:Class ; rdfs:label "Company"@en ; rdfs:subClassOf shop:Organization .
shop:initech a shop:Company ; rdfs:label "Initech"@en .
shop:carol a shop:Employee ; rdfs:label "Carol"@en ; shop:salary "100.5"^^xsd:decimal .
""")
    details = node(pid, EX + "carol")
    example = details["example"]
    assert example["classes"] == [{"iri": EX + "Employee", "label": "Employee"}]
    fields = {f["label"]: f for f in example["fields"]}
    # The class's own attribute, and Person's attribute and relationship.
    assert set(fields) == {"salary", "birth date", "member of"}
    assert fields["salary"]["datatype"] == "xsd:decimal"
    assert fields["salary"]["values"] == [{"kind": "typed", "value": "100.5", "datatype": "xsd:decimal"}]
    # A relationship's choices are the examples of its end class or below:
    # Acme, and Initech as a Company, a kind of Organization; never Alice.
    member = fields["member of"]
    assert [o["label"] for o in member["options"]] == ["Acme", "Initech"]
    assert member["optionsTotal"] == 2
    assert member["rangeLabel"] == "Organization"
    # A class is not an example, and carries no example block.
    assert "example" not in node(pid, EX + "Person")


def test_a_relationship_without_an_end_class_offers_every_example(pid):
    with_turtle(pid, 'shop:knows a owl:ObjectProperty ; rdfs:label "knows"@en ; rdfs:domain shop:Person .\n')
    fields = {f["label"]: f for f in node(pid, EX + "alice")["example"]["fields"]}
    assert fields["knows"]["range"] is None
    assert [o["label"] for o in fields["knows"]["options"]] == ["Acme", "Alice"]


def test_the_choices_are_capped_with_the_true_total(pid, monkeypatch):
    monkeypatch.setattr(examples, "OPTIONS_CAP", 1)
    with_turtle(pid, 'shop:globex a shop:Organization ; rdfs:label "Globex"@en .\n')
    member = next(f for f in node(pid, EX + "alice")["example"]["fields"] if f["label"] == "member of")
    assert [o["label"] for o in member["options"]] == ["Acme"]
    assert member["optionsTotal"] == 2


def test_an_attribute_takes_one_value_when_set_and_more_when_added(pid):
    with_turtle(pid, 'shop:nickname a owl:DatatypeProperty ; rdfs:label "nickname"@en ; rdfs:domain shop:Person .\n')
    ok(pid, "AddExampleValue", iri="shop:alice", property="shop:nickname", value={"kind": "text", "value": "Al"})
    ok(pid, "AddExampleValue", iri="shop:alice", property="shop:nickname", value={"kind": "text", "value": "Ali"})
    assert len(set(graph(pid).objects(U("alice"), U("nickname")))) == 2
    ok(pid, "SetExampleValue", iri="shop:alice", property="shop:nickname", value={"kind": "text", "value": "Lissy"})
    assert set(graph(pid).objects(U("alice"), U("nickname"))) == {Literal("Lissy", lang="en")}
    result = ok(pid, "RemoveExampleValue", iri="shop:alice", property="shop:nickname",
                value={"kind": "text", "value": "Lissy", "lang": "en"})
    assert result["label"] == "Removed nickname from Alice"
    assert (U("alice"), U("nickname"), None) not in graph(pid)


@pytest.mark.parametrize(
    "command,args,fragment",
    [
        # Row S22: a wrong value is refused, with the type's sentence.
        ("SetExampleValue", {"iri": "shop:alice", "property": "shop:birthDate",
                             "value": {"kind": "typed", "value": "yesterday", "datatype": "xsd:date"}},
         '"yesterday" is not a valid date (expected YYYY-MM-DD).'),
        ("SetExampleValue", {"iri": "shop:alice", "property": "shop:birthDate",
                             "value": {"kind": "typed", "value": "42", "datatype": "xsd:integer"}},
         "birth date is a date; give a value of that type."),
        ("SetExampleValue", {"iri": "shop:alice", "property": "shop:birthDate",
                             "value": {"kind": "link", "value": "shop:acme"}},
         "birth date is a date"),
        ("AddExampleValue", {"iri": "shop:alice", "property": "shop:memberOf",
                             "value": {"kind": "text", "value": "Acme"}},
         "A value of member of is another example"),
        ("AddExampleValue", {"iri": "shop:alice", "property": "shop:memberOf",
                             "value": {"kind": "link", "value": "shop:nobody"}},
         "There is no example shop:nobody"),
        ("AddExampleValue", {"iri": "shop:alice", "property": "rdfs:comment",
                             "value": {"kind": "text", "value": "Hi"}},
         "is not an attribute or a relationship"),
        ("AddExampleValue", {"iri": "shop:Person", "property": "shop:memberOf",
                             "value": {"kind": "link", "value": "shop:acme"}},
         "There is no example shop:Person"),
        ("RemoveExampleValue", {"iri": "shop:alice", "property": "shop:memberOf",
                                "value": {"kind": "link", "value": "shop:acme"}},
         "Alice has no such member of to remove."),
        ("CreateExample", {"class": "shop:memberOf", "label": "X"}, "is not a class of this model"),
        ("CreateExample", {"class": "shop:Person"}, "primary language"),
        ("CreateExample", {"class": "shop:Person", "label": "Alice"}, "already used"),
    ],
)
def test_a_refused_example_command_changes_nothing(pid, command, args, fragment):
    with_turtle(pid, BIRTH_DATE)
    before, rev = copy(pid), revision(pid)
    response = run(pid, command, **args)
    assert response.status_code == 422
    assert fragment in response.json()["detail"]
    assert revision(pid) == rev
    assert isomorphic(graph(pid), before)


def test_example_commands_run_on_the_model_only(pid):
    response = run(pid, "CreateExample", doc="shapes", **{"class": "shop:Person", "label": "Bob"})
    assert response.status_code == 422
    assert "Examples live in model.ttl" in response.json()["detail"]


@pytest.mark.parametrize(
    "command,args",
    [
        ("CreateExample", {"class": "shop:Organization", "label": "Globex"}),
        ("SetExampleValue", {"iri": "shop:alice", "property": "shop:memberOf", "value": {"kind": "link", "value": "shop:acme"}}),
        ("AddExampleValue", {"iri": "shop:alice", "property": "shop:memberOf", "value": {"kind": "link", "value": "shop:acme"}}),
    ],
)
def test_each_example_command_is_one_undo_step(pid, command, args):
    before = copy(pid)
    ok(pid, command, **args)
    after = copy(pid)
    assert not isomorphic(before, after)
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert isomorphic(graph(pid), before)
    assert client.post(f"/api/projects/{pid}/documents/model/redo").status_code == 200
    assert isomorphic(graph(pid), after)


def test_remove_example_value_is_one_undo_step(pid):
    ok(pid, "AddExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    before = copy(pid)
    ok(pid, "RemoveExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert isomorphic(graph(pid), before)


def test_deleting_an_example_takes_its_links_and_says_example(pid):
    ok(pid, "AddExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    dry = client.post(f"/api/projects/{pid}/documents/model/commands",
                      json={"command": "DeleteEntity", "args": {"iri": "shop:acme"}, "dryRun": True}).json()
    assert dry["impact"]["kind"] == "example"
    result = ok(pid, "DeleteEntity", iri="shop:acme")
    assert result["label"] == "Deleted example Acme"
    g = graph(pid)
    assert (U("acme"), None, None) not in g
    assert (U("alice"), U("memberOf"), U("acme")) not in g


def test_a_class_delete_names_its_examples_as_individuals(pid):
    dry = client.post(f"/api/projects/{pid}/documents/model/commands",
                      json={"command": "DeleteEntity", "args": {"iri": "shop:Person"}, "dryRun": True}).json()
    assert [i["label"] for i in dry["impact"]["individuals"]] == ["Alice"]


# --- the tree and the canvas (5.8) ----------------------------------------------


def test_the_tree_lists_examples_by_class_and_a_library_ontology_has_no_section(pid):
    tree = client.get(f"/api/ontologies/{model_id(pid)}/hierarchy").json()
    forest = tree["examples"]
    assert sorted(forest["roots"]) == [EX + "Organization", EX + "Person"]
    assert forest["children"][EX + "Person"] == [{"id": EX + "alice", "origin": "asserted"}]
    assert forest["nodes"][EX + "Person"]["kind"] == "class"
    assert tree["counts"]["examples"] == 2
    # An example of two classes is under each, as a class with two parents is.
    with_turtle(pid, "shop:alice a shop:Organization .\n")
    forest = client.get(f"/api/ontologies/{model_id(pid)}/hierarchy").json()["examples"]
    assert {c["id"] for c in forest["children"][EX + "Organization"]} == {EX + "acme", EX + "alice"}


def test_a_project_without_examples_has_no_examples_section():
    pid = _create("empty")
    tree = client.get(f"/api/ontologies/{model_id(pid)}/hierarchy").json()
    assert "examples" not in tree
    assert "examples" not in tree["counts"]


def test_the_canvas_does_not_draw_examples(pid):
    canvas = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    drawn = {n["iri"] for n in canvas["nodes"]}
    assert EX + "Person" in drawn
    assert not drawn & {EX + "alice", EX + "acme"}


# --- Stage A follow-up 4: *name (label)* -----------------------------------------


def test_rdfs_label_reads_name_label_only_beside_a_name_attribute():
    model = Graph().parse(data="""
        @prefix : <http://example.org/x#> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        :Person a owl:Class .
    """, format="turtle")
    assert path_label(model, (RDFS.label,), ["en"]) == "name"
    model.add((URIRef("http://example.org/x#name"), RDF.type, OWL.DatatypeProperty))
    model.add((URIRef("http://example.org/x#name"), RDFS.label, Literal("name", lang="en")))
    assert path_label(model, (RDFS.label,), ["en"]) == "name (label)"
    # The attribute itself keeps its own name.
    assert path_label(model, (URIRef("http://example.org/x#name"),), ["en"]) == "name"
    # A concept's name is its preferred name, never confused.
    assert path_label(model, (SKOS.prefLabel,), ["en"]) == "preferred name"


def test_a_name_label_plural_puts_the_s_before_the_brackets():
    from app.shacl import plural

    assert plural("name (label)") == "names (label)"
    assert plural("phone number") == "phone numbers"


def test_a_wrong_value_written_in_turtle_can_be_removed_from_the_form(pid):
    # Found in review: Remove checked the value it removed, so the very
    # values a shape flags -- a wrong date, a type the form does not offer,
    # a text under a relationship -- could not be taken away.
    with_turtle(pid, BIRTH_DATE + """
shop:alice shop:birthDate "yesterday"^^xsd:date , "2020"^^xsd:gYear ;
    shop:memberOf "Acme" .
""")
    fields = {f["label"]: f for f in node(pid, EX + "alice")["example"]["fields"]}
    for label in ("birth date", "member of"):
        for value in fields[label]["values"]:
            # Exactly what the form's Remove sends: the value as /node gave it.
            ok(pid, "RemoveExampleValue", iri="shop:alice", property=f"shop:{'birthDate' if label == 'birth date' else 'memberOf'}",
               value=value)
    g = graph(pid)
    assert (U("alice"), U("birthDate"), None) not in g
    assert (U("alice"), U("memberOf"), None) not in g


# --- PR #51 review ---------------------------------------------------------------

FLOAT_AND_YEAR = """
shop:height a owl:DatatypeProperty ; rdfs:label "height"@en ; rdfs:domain shop:Person ; rdfs:range xsd:float .
shop:since a owl:DatatypeProperty ; rdfs:label "since"@en ; rdfs:domain shop:Person ; rdfs:range xsd:gYear .
"""


def test_a_type_outside_the_seven_is_stored_typed_and_checked_where_it_can_be(pid):
    # PR #51 review, item 1: an xsd:float was saved as text in a language.
    with_turtle(pid, FLOAT_AND_YEAR)
    ok(pid, "SetExampleValue", iri="shop:alice", property="shop:height",
       value={"kind": "typed", "value": "1.75", "datatype": str(XSD.float)})
    ok(pid, "SetExampleValue", iri="shop:alice", property="shop:since",
       value={"kind": "typed", "value": "2020", "datatype": "xsd:gYear"})
    g = graph(pid)
    assert (U("alice"), U("height"), Literal("1.75", datatype=XSD.float)) in g
    assert (U("alice"), U("since"), Literal("2020", datatype=XSD.gYear)) in g
    fields = {f["label"]: f for f in node(pid, EX + "alice")["example"]["fields"]}
    assert fields["height"]["datatype"] == str(XSD.float)
    for value, fragment in (
        ({"kind": "typed", "value": "tall", "datatype": str(XSD.float)}, '"tall" is not a valid xsd:float.'),
        ({"kind": "text", "value": "1.80", "lang": "en"}, "height is a value of type xsd:float"),
        ({"kind": "typed", "value": "1.80", "datatype": "xsd:decimal"}, "height is a value of type xsd:float"),
    ):
        before, rev = copy(pid), revision(pid)
        response = run(pid, "SetExampleValue", iri="shop:alice", property="shop:height", value=value)
        assert response.status_code == 422 and fragment in response.json()["detail"], response.text
        assert revision(pid) == rev and isomorphic(graph(pid), before)


def test_a_link_only_reaches_an_individual_of_the_end_class_or_below(pid):
    # PR #51 review, item 2: the server took any individual.
    with_turtle(pid, """
shop:Company a owl:Class ; rdfs:label "Company"@en ; rdfs:subClassOf shop:Organization .
shop:initech a shop:Company ; rdfs:label "Initech"@en .
shop:bob a shop:Person ; rdfs:label "Bob"@en .
""")
    for command in ("AddExampleValue", "SetExampleValue"):
        before, rev = copy(pid), revision(pid)
        response = run(pid, command, iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:bob"})
        assert response.status_code == 422
        assert response.json()["detail"] == "Bob is not an Organization; member of links only to an Organization."
        assert revision(pid) == rev and isomorphic(graph(pid), before)
    # Of the end class, or of a class below it, is fine.
    ok(pid, "AddExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:acme"})
    ok(pid, "SetExampleValue", iri="shop:alice", property="shop:memberOf", value={"kind": "link", "value": "shop:initech"})
    assert set(graph(pid).objects(U("alice"), U("memberOf"))) == {U("initech")}
