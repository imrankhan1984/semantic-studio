"""
================================================================================
FILE: backend/tests/test_relationships.py
================================================================================

SUMMARY
    The server half of relationships-and-project-kinds Stage A: a project's
    kind (from its template, judged from a library copy, inferred the first
    time an older project opens, changed through PATCH without touching the
    model); SetEnds and SwapEnds as one undo step each; the canvas lines
    numbered apart when they share two boxes, a loop for a class linked to
    itself; and the tree listing every relationship and attribute of a
    project document with its ends.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, with the graph read
    directly for exact triples and isomorphism, the way test_editing.py
    does. The commands' deltas, labels and refusals are in test_editing.py's
    tables with every other command; this file holds what those tables
    cannot say.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the four templates; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-1 (the server half), AC-5's data, AC-6, and matrix
      rows R1, R2, R5, R6 and R21 as the server sees them.
================================================================================
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS

from app.editing import editing_service, project_store
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
"""

MODEL = PREFIXES + """
shop:Person a owl:Class ; rdfs:label "Person"@en .
shop:Organization a owl:Class ; rdfs:label "Organization"@en .
shop:worksFor a owl:ObjectProperty ; rdfs:label "works for"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .
shop:memberOf a owl:ObjectProperty ; rdfs:label "member of"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .
shop:employs a owl:ObjectProperty ; rdfs:label "employs"@en ;
    rdfs:domain shop:Organization ; rdfs:range shop:Person .
shop:knows a owl:ObjectProperty ; rdfs:label "knows"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Person .
shop:likes a owl:ObjectProperty ; rdfs:label "likes"@en .
shop:name a owl:DatatypeProperty ; rdfs:label "name"@en ;
    rdfs:domain shop:Person ; rdfs:range xsd:string .
"""


def U(local: str) -> URIRef:
    return URIRef(EX + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _create(**body) -> dict:
    body.setdefault("name", "Test project")
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _open(pid: str) -> dict:
    response = client.post(f"/api/projects/{pid}/open")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def pid() -> str:
    project = _create(name="Shop", template="small", baseIri=EX, prefix="shop")["id"]
    _open(project)
    assert client.put(f"/api/projects/{project}/documents/model/source", json={"text": MODEL}).status_code == 200
    return project


def run(pid: str, command: str, **args):
    return client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": command, "args": args})


def graph(pid: str) -> Graph:
    return editing_service.document(pid, "model").graph


def snapshot(pid: str) -> Graph:
    copy = Graph()
    for t in graph(pid):
        copy.add(t)
    return copy


# --- AC-1: the kind ------------------------------------------------------------------


@pytest.mark.parametrize(
    "template,kind,classes,concepts",
    [
        ("empty", "ontology", 0, 0),
        ("small", "ontology", 2, 0),
        ("taxonomy-empty", "taxonomy", 0, 0),
        ("taxonomy-small", "taxonomy", 0, 3),
        # The E-6 name for a small scheme, still accepted.
        ("vocabulary", "taxonomy", 0, 2),
    ],
)
def test_a_template_names_the_kind_of_project_it_starts(template, kind, classes, concepts):
    project = _create(name="Fruit", template=template)
    assert project["kind"] == kind
    assert project["counts"]["classes"] == classes and project["counts"]["concepts"] == concepts
    manifest = json.loads((project_store.folder(project["id"]) / "project.json").read_text(encoding="utf-8"))
    assert manifest["kind"] == kind
    # A taxonomy starts with its one concept scheme, named after the project.
    if kind == "taxonomy" and template != "vocabulary":
        text = (project_store.folder(project["id"]) / "model.ttl").read_text(encoding="utf-8")
        assert "skos:ConceptScheme" in text and '"Fruit"@en' in text


@pytest.mark.parametrize(
    "text,kind",
    [
        (PREFIXES + 'shop:A a skos:Concept . shop:B a skos:Concept ; skos:broader shop:A .', "taxonomy"),
        (PREFIXES + "shop:A a owl:Class .", "ontology"),
        # Both: an ontology whose values are concepts, the commoner case.
        (PREFIXES + "shop:A a owl:Class . shop:B a skos:Concept .", "ontology"),
        (PREFIXES + "shop:x rdfs:label \"nothing typed\" .", "ontology"),
    ],
)
def test_a_library_copy_is_judged_from_its_content(text, kind):
    upload = client.post("/api/ontologies/upload", files={"file": ("lib.ttl", text.encode())})
    assert upload.status_code == 200, upload.text
    project = _create(name="Copy", fromOntologyId=upload.json()["id"])
    assert project["kind"] == kind


def test_a_project_made_before_kinds_gets_one_the_first_time_it_opens():
    project = _create(name="Old", template="taxonomy-small")
    path = project_store.folder(project["id"]) / "project.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    del manifest["kind"]
    path.write_text(json.dumps(manifest), encoding="utf-8")
    listed = next(p for p in client.get("/api/projects").json() if p["id"] == project["id"])
    assert listed["kind"] is None
    assert _open(project["id"])["project"]["kind"] == "taxonomy"
    assert json.loads(path.read_text(encoding="utf-8"))["kind"] == "taxonomy"


def test_changing_the_kind_rewrites_nothing_but_the_manifest(pid):
    """R21: the kind switch with content of the other kind present."""
    assert run(pid, "CreateConcept", prefLabel="Status").status_code == 200
    model = project_store.folder(pid) / "model.ttl"
    before_bytes, before_graph = model.read_bytes(), snapshot(pid)
    before_revision = editing_service.document(pid, "model").ontology.revision
    response = client.patch(f"/api/projects/{pid}", json={"kind": "taxonomy"})
    assert response.status_code == 200 and response.json()["kind"] == "taxonomy"
    assert model.read_bytes() == before_bytes
    assert isomorphic(graph(pid), before_graph)
    assert editing_service.document(pid, "model").ontology.revision == before_revision
    canvas = client.get(f"/api/projects/{pid}/documents/model/canvas").json()
    assert canvas["kind"] == "taxonomy"
    # Everything is still drawn: the other kind is shown, never hidden.
    kinds = {n["kind"] for n in canvas["nodes"]}
    assert kinds == {"class", "concept"}


def test_a_kind_that_is_not_one_is_refused(pid):
    response = client.patch(f"/api/projects/{pid}", json={"kind": "thesaurus"})
    assert response.status_code == 422
    assert client.get("/api/projects").json()[0]["kind"] == "ontology"


# --- R6: SetEnds, one step; SwapEnds ---------------------------------------------------


def test_set_ends_completes_a_relationship_as_one_undo_step(pid):
    before = snapshot(pid)
    response = run(pid, "SetEnds", property="shop:likes", domain="shop:Person", range="shop:Organization")
    assert response.status_code == 200, response.text
    assert (U("likes"), RDFS.domain, U("Person")) in graph(pid)
    assert (U("likes"), RDFS.range, U("Organization")) in graph(pid)
    assert response.json()["delta"]["addedTotal"] == 2
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert isomorphic(graph(pid), before), "one undo must take both ends away"
    client.post(f"/api/projects/{pid}/documents/model/redo")
    assert (U("likes"), RDFS.range, U("Organization")) in graph(pid)


def test_set_ends_sets_one_end_and_leaves_the_other(pid):
    assert run(pid, "SetEnds", property="shop:worksFor", range="shop:Person").status_code == 200
    assert set(graph(pid).objects(U("worksFor"), RDFS.domain)) == {U("Person")}
    assert set(graph(pid).objects(U("worksFor"), RDFS.range)) == {U("Person")}


def test_swap_ends_is_one_step_and_undoes_exactly(pid):
    before = snapshot(pid)
    response = run(pid, "SwapEnds", property="shop:worksFor")
    assert response.status_code == 200, response.text
    assert set(graph(pid).objects(U("worksFor"), RDFS.domain)) == {U("Organization")}
    assert set(graph(pid).objects(U("worksFor"), RDFS.range)) == {U("Person")}
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert isomorphic(graph(pid), before)


def test_swap_ends_with_one_end_moves_it_to_the_other_side(pid):
    assert run(pid, "SetDomain", property="shop:likes", target="shop:Person").status_code == 200
    assert run(pid, "SwapEnds", property="shop:likes").status_code == 200
    assert list(graph(pid).objects(U("likes"), RDFS.domain)) == []
    assert list(graph(pid).objects(U("likes"), RDFS.range)) == [U("Person")]


@pytest.mark.parametrize(
    "prop,fragment",
    [
        ("shop:knows", "same class"),
        ("shop:likes", "no start or end"),
        ("shop:name", "is an attribute"),
    ],
)
def test_a_swap_that_cannot_mean_anything_is_refused_and_changes_nothing(pid, prop, fragment):
    before = snapshot(pid)
    response = run(pid, "SwapEnds", property=prop)
    assert response.status_code == 422 and fragment in response.json()["detail"]
    assert isomorphic(graph(pid), before)


# --- AC-5: lines drawn apart; a loop ----------------------------------------------------


def test_lines_on_the_same_two_boxes_are_numbered_apart_in_both_directions(pid):
    edges = client.get(f"/api/projects/{pid}/documents/model/canvas").json()["edges"]
    pair = [e for e in edges if {e["source"], e["target"]} == {EX + "Person", EX + "Organization"}]
    assert {e["property"] for e in pair} == {EX + "worksFor", EX + "memberOf", EX + "employs"}
    assert sorted(e["pair"] for e in pair) == [0, 1, 2]
    assert {e["pairs"] for e in pair} == {3}


def test_a_class_linked_to_itself_is_drawn_as_a_line_on_one_box(pid):
    """R5: Person knows Person."""
    edges = client.get(f"/api/projects/{pid}/documents/model/canvas").json()["edges"]
    loop = next(e for e in edges if e.get("property") == EX + "knows")
    assert loop["source"] == loop["target"] == EX + "Person"
    assert loop["pairs"] == 1


def test_a_self_relationship_created_on_the_canvas_has_the_same_class_at_both_ends(pid):
    response = run(pid, "CreateObjectProperty", label="reports to", domain="shop:Person", range="shop:Person")
    assert response.status_code == 200, response.text
    g = graph(pid)
    assert (U("reportsTo"), RDF.type, OWL.ObjectProperty) in g
    assert (U("reportsTo"), RDFS.domain, U("Person")) in g and (U("reportsTo"), RDFS.range, U("Person")) in g


# --- AC-6: the tree lists every relationship and attribute ------------------------------


def test_the_tree_lists_every_relationship_and_attribute_with_its_ends(pid):
    tree = client.get(f"/api/ontologies/{pid}-model/hierarchy").json()
    relationships = tree["objectProperties"]["nodes"]
    assert set(relationships) == {EX + x for x in ("worksFor", "memberOf", "employs", "knows", "likes")}
    assert relationships[EX + "worksFor"]["ends"] == {"domain": "Person", "range": "Organization"}
    assert relationships[EX + "likes"]["ends"] == {"domain": None, "range": None}
    attributes = tree["datatypeProperties"]["nodes"]
    assert attributes[EX + "name"]["ends"] == {"domain": "Person", "range": "xsd:string"}


def test_a_sub_relationship_still_nests_under_its_parent(pid):
    assert client.put(
        f"/api/projects/{pid}/documents/model/source",
        json={"text": MODEL + "shop:worksFor rdfs:subPropertyOf shop:memberOf .\n"},
    ).status_code == 200
    forest = client.get(f"/api/ontologies/{pid}-model/hierarchy").json()["objectProperties"]
    assert EX + "worksFor" not in forest["roots"]
    assert {c["id"] for c in forest["children"][EX + "memberOf"]} == {EX + "worksFor"}


def test_a_new_relationship_appears_in_the_tree_at_once(pid):
    """Finding 6 of the audit: a new relationship never reached the tree."""
    assert run(pid, "CreateObjectProperty", label="owns", domain="shop:Person").status_code == 200
    tree = client.get(f"/api/ontologies/{pid}-model/hierarchy").json()
    assert EX + "owns" in tree["objectProperties"]["nodes"]


def test_a_library_ontology_keeps_the_sub_property_tree_only():
    upload = client.post("/api/ontologies/upload", files={"file": ("lib.ttl", MODEL.encode())})
    tree = client.get(f"/api/ontologies/{upload.json()['id']}/hierarchy").json()
    assert "objectProperties" not in tree and "datatypeProperties" not in tree
