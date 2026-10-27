"""
================================================================================
FILE: backend/tests/test_attribute_reuse.py
================================================================================

SUMMARY
    attribute-reuse Stage A, the commands (AC-1 to AC-6): a create naming a
    property that exists answers 409 already_defined with the property; the
    reuse plan gives the case of 5.2 for document and imported parents;
    ShareDomain writes the union of 5.0 row 5, or a shared parent for an
    RDFS class, or moves the domain up, never a second rdfs:domain and in
    one undo step that restores the document exactly; UnshareDomain never
    leaves a union of one; replacing or clearing a shared domain takes its
    blank nodes with it; and the 5.4 Fix shares two domain lines.

BASIC IDEA
    Each test opens a Small project, replaces its model with inline Turtle
    and drives the commands route as the form does. What is written is read
    back from the document's graph, and the union's shape is compared
    statement by statement with the shape the standard gives. An imported
    class comes from a library ontology mapped as an import, as
    test_canvas.py does it.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the Small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-6 and the 5.4 Fix.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdflib import BNode, Graph, URIRef
from rdflib.collection import Collection
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS

from app import axioms
from app.editing import editing_service
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

HR = "http://example.org/hr#"
PREFIXES = f"""@prefix hr: <{HR}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
"""

MODEL = PREFIXES + """
hr:Worker a owl:Class ; rdfs:label "Worker"@en .
hr:Employee a owl:Class ; rdfs:label "Employee"@en ; rdfs:subClassOf hr:Worker .
hr:Manager a owl:Class ; rdfs:label "Manager"@en ; rdfs:subClassOf hr:Employee .
hr:Contractor a owl:Class ; rdfs:label "Contractor"@en ; rdfs:subClassOf hr:Worker .
hr:Intern a owl:Class ; rdfs:label "Intern"@en ; rdfs:subClassOf hr:Worker .
hr:Team a owl:Class ; rdfs:label "Team"@en .
hr:Volunteer a rdfs:Class ; rdfs:label "Volunteer"@en .
hr:hasName a owl:DatatypeProperty ; rdfs:label "hasName"@en ; rdfs:domain hr:Employee ; rdfs:range xsd:string .
hr:hasJobCode a owl:DatatypeProperty ; rdfs:label "hasJobCode"@en ; rdfs:domain hr:Manager .
hr:nickname a owl:DatatypeProperty ; rdfs:label "nickname"@en .
hr:reportsTo a owl:ObjectProperty ; rdfs:label "reportsTo"@en ; rdfs:domain hr:Employee ; rdfs:range hr:Manager .
"""


def U(local: str) -> URIRef:
    return URIRef(HR + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def open_project(text: str = MODEL) -> str:
    response = client.post("/api/projects", json={"name": "HR", "template": "small", "baseIri": HR, "prefix": "hr"})
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    return pid


@pytest.fixture
def pid() -> str:
    return open_project()


def command(pid: str, name: str, dry: bool = False, **args):
    return client.post(
        f"/api/projects/{pid}/documents/model/commands", json={"command": name, "args": args, "dryRun": dry}
    )


def ok(pid: str, name: str, **args) -> dict:
    response = command(pid, name, **args)
    assert response.status_code == 200, response.text
    return response.json()


def plan(pid: str, prop: str, cls: str) -> dict:
    response = command(pid, "ShareDomain", dry=True, property=f"hr:{prop}", **{"class": f"hr:{cls}"})
    assert response.status_code == 200, response.text
    return response.json()["plan"]


def graph(pid: str) -> Graph:
    return editing_service.document(pid, "model").graph


def copy(pid: str) -> Graph:
    out = Graph()
    for t in graph(pid):
        out.add(t)
    return out


def revision(pid: str) -> int:
    return editing_service.document(pid, "model").ontology.revision


def undo(pid: str) -> None:
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200


def union_of(g: Graph, prop: URIRef) -> list:
    """The members, after checking the statements are exactly 5.0 row 5's:
    one rdfs:domain, a blank node typed owl:Class with owl:unionOf and a
    list, and nothing else on the node."""
    domains = list(g.objects(prop, RDFS.domain))
    assert len(domains) == 1, f"one rdfs:domain, never a second: {domains}"
    node = domains[0]
    assert isinstance(node, BNode)
    assert set(g.predicate_objects(node)) == {(RDF.type, OWL.Class), (OWL.unionOf, g.value(node, OWL.unionOf))}
    return list(Collection(g, g.value(node, OWL.unionOf)))


def orphans(g: Graph) -> list:
    """Blank nodes nothing points at: debris a union left behind."""
    return [s for s in set(g.subjects()) if isinstance(s, BNode) and (None, None, s) not in g]


# --- AC-1: a create with a name that exists ---------------------------------------------


def test_an_existing_attribute_name_answers_409_already_defined_with_the_property(pid):
    before, rev = copy(pid), revision(pid)
    response = command(pid, "CreateDatatypeProperty", label="hasName", domain="hr:Manager")
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "already_defined"
    assert detail["message"] == "There is already an attribute hasName, of Employee."
    assert detail["property"] == {
        "iri": HR + "hasName", "label": "hasName", "kind": "attribute",
        "domain": {"form": "one", "classes": [{"iri": HR + "Employee", "label": "Employee"}]},
        "range": "http://www.w3.org/2001/XMLSchema#string",
    }
    assert isomorphic(graph(pid), before) and revision(pid) == rev, "nothing written"


def test_an_existing_relationship_iri_answers_409_too(pid):
    response = command(pid, "CreateObjectProperty", label="Reports", iri="hr:reportsTo", domain="hr:Contractor")
    assert response.status_code == 409
    assert response.json()["detail"]["property"]["kind"] == "relationship"
    assert response.json()["detail"]["message"] == "There is already a relationship reportsTo, of Employee."


def test_a_property_of_the_other_kind_says_so_and_anything_else_keeps_the_iri_sentence(pid):
    rev = revision(pid)
    other = command(pid, "CreateObjectProperty", label="hasName", range="hr:Team")
    assert other.status_code == 422
    assert other.json()["detail"] == "hasName is an attribute in this project; a relationship needs another name."
    cls = command(pid, "CreateDatatypeProperty", label="x", iri="hr:Team")
    assert cls.status_code == 422
    assert cls.json()["detail"] == "hr:Team is already used in this document; choose another IRI."
    assert revision(pid) == rev


# --- AC-2, AC-3: the plan, case by case -------------------------------------------------


def test_case_a_a_property_with_no_class_is_given_one(pid):
    assert plan(pid, "nickname", "Manager")["case"] == "A"
    ok(pid, "ShareDomain", property="hr:nickname", **{"class": "hr:Manager"})
    assert list(graph(pid).objects(U("nickname"), RDFS.domain)) == [U("Manager")]


def test_case_b_a_kind_of_the_domain_already_has_it_and_nothing_is_written(pid):
    shown = plan(pid, "hasName", "Manager")
    assert shown["case"] == "B" and shown["via"] == {"iri": HR + "Employee", "label": "Employee"}
    before, rev = copy(pid), revision(pid)
    response = command(pid, "ShareDomain", property="hr:hasName", **{"class": "hr:Manager"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Manager already has hasName, because a Manager is an Employee."
    assert isomorphic(graph(pid), before) and revision(pid) == rev
    assert plan(pid, "hasName", "Employee")["case"] == "B", "C is D"


def test_case_c_the_domain_moves_up(pid):
    assert plan(pid, "hasJobCode", "Employee")["case"] == "C"
    ok(pid, "ShareDomain", property="hr:hasJobCode", **{"class": "hr:Employee"})
    assert list(graph(pid).objects(U("hasJobCode"), RDFS.domain)) == [U("Employee")]


def test_case_d_offers_the_subclass_the_union_and_the_shared_parent(pid):
    shown = plan(pid, "hasName", "Contractor")
    assert shown["case"] == "D"
    choices = shown["choices"]
    assert choices["subclass"] is True and choices["union"] is True and choices["parent"] is True
    # Employee and Contractor already share Worker: moving up names what else gains it.
    assert [u["label"] for u in choices["up"]] == ["Worker"]
    assert [g["label"] for g in choices["up"][0]["gains"]] == ["Intern"]
    assert "owl:unionOf" in shown["turtle"] and "hr:Contractor" in shown["turtle"]


def test_case_d_up_moves_the_domain_to_the_shared_parent(pid):
    ok(pid, "ShareDomain", property="hr:hasName", how="up", parent="hr:Worker", **{"class": "hr:Contractor"})
    assert list(graph(pid).objects(U("hasName"), RDFS.domain)) == [U("Worker")]
    refused = command(pid, "ShareDomain", property="hr:reportsTo", how="up", parent="hr:Team", **{"class": "hr:Contractor"})
    assert refused.status_code == 422 and "is not a parent" in refused.json()["detail"]


def test_an_expression_domain_and_two_domain_lines_are_refused_with_their_sentence():
    pid = open_project(MODEL + """
hr:code a owl:DatatypeProperty ; rdfs:label "code"@en ; rdfs:domain [ owl:intersectionOf ( hr:Employee hr:Team ) ] .
hr:badge a owl:DatatypeProperty ; rdfs:label "badge"@en ; rdfs:domain hr:Employee , hr:Team .
""")
    assert plan(pid, "code", "Contractor")["refused"].startswith("The class code belongs to is written as an expression")
    assert plan(pid, "badge", "Contractor")["refused"] == (
        "badge lists Employee and Team separately, which means both. Share it from its warning first."
    )


# --- AC-4: the union, the shape of 5.0 row 5 --------------------------------------------


def test_sharing_writes_one_domain_a_blank_owl_class_union_and_undo_restores_exactly(pid):
    before = copy(pid)
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Contractor"})
    g = graph(pid)
    assert union_of(g, U("hasName")) == [U("Employee"), U("Contractor")]
    assert orphans(g) == []
    undo(pid)
    assert set(graph(pid)) == set(before), "the very statements back, blank nodes and all"


def test_sharing_again_grows_the_union_and_drops_a_member_now_covered():
    pid = open_project(MODEL + "hr:Lead a owl:Class ; rdfs:label \"Lead\"@en .\n")
    ok(pid, "ShareDomain", property="hr:hasJobCode", how="union", **{"class": "hr:Contractor"})
    ok(pid, "ShareDomain", property="hr:hasJobCode", how="union", **{"class": "hr:Team"})
    assert union_of(graph(pid), U("hasJobCode")) == [U("Manager"), U("Contractor"), U("Team")]
    # Employee is above Manager: Manager goes, Employee covers it.
    ok(pid, "ShareDomain", property="hr:hasJobCode", how="union", **{"class": "hr:Employee"})
    assert union_of(graph(pid), U("hasJobCode")) == [U("Contractor"), U("Team"), U("Employee")]
    assert orphans(graph(pid)) == []


def test_no_command_writes_a_second_domain(pid):
    for how in ("union", "parent"):
        extra = {"parentLabel": "Staff"} if how == "parent" else {}
        ok(pid, "ShareDomain", property="hr:reportsTo", how=how, **extra, **{"class": "hr:Team"})
        assert len(list(graph(pid).objects(U("reportsTo"), RDFS.domain))) == 1
        undo(pid)


def test_a_union_written_in_turtle_is_read_by_the_plan():
    pid = open_project(MODEL.replace(
        "rdfs:domain hr:Employee ; rdfs:range xsd:string",
        "rdfs:domain [ a owl:Class ; owl:unionOf ( hr:Employee hr:Team ) ] ; rdfs:range xsd:string",
    ))
    shown = plan(pid, "hasName", "Manager")
    assert shown["case"] == "B" and shown["domain"]["form"] == "union"
    shown = plan(pid, "hasName", "Contractor")
    assert shown["case"] == "D" and shown["choices"]["subclass"] is False, "hidden when the domain is a union"


# --- AC-5: an RDFS class, and an imported one --------------------------------------------


def test_with_an_rdfs_class_sharing_makes_a_parent_both_links_and_the_domain_in_one_step(pid):
    shown = plan(pid, "hasName", "Volunteer")
    assert shown["case"] == "D" and shown["choices"]["union"] is False and shown["choices"]["parent"] is True
    refused = command(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Volunteer"})
    assert refused.status_code == 422 and refused.json()["detail"].startswith('RDFS has no way to say "either"')
    before = copy(pid)
    ok(pid, "ShareDomain", property="hr:hasName", how="parent", parentLabel="Person", **{"class": "hr:Volunteer"})
    g = graph(pid)
    person = U("Person")
    assert (person, RDF.type, RDFS.Class) in g and (person, RDF.type, OWL.Class) not in g, "RDFS is in use here"
    assert (U("Employee"), RDFS.subClassOf, person) in g and (U("Volunteer"), RDFS.subClassOf, person) in g
    assert list(g.objects(U("hasName"), RDFS.domain)) == [person]
    undo(pid)
    assert set(graph(pid)) == set(before), "one undo step"


def test_an_existing_parent_is_used_and_a_loop_refused(pid):
    ok(pid, "ShareDomain", property="hr:reportsTo", how="parent", parent="hr:Worker", **{"class": "hr:Team"})
    assert (U("Team"), RDFS.subClassOf, U("Worker")) in graph(pid)
    undo(pid)
    # Manager is a kind of Employee: as Employee's parent it would make a loop.
    loop = command(pid, "ShareDomain", property="hr:reportsTo", how="parent", parent="hr:Manager", **{"class": "hr:Team"})
    assert loop.status_code == 422
    assert loop.json()["detail"] == "Manager is already a kind of Employee, so it cannot be its parent too."
    member = command(pid, "ShareDomain", property="hr:reportsTo", how="parent", parent="hr:Team", **{"class": "hr:Team"})
    assert member.json()["detail"] == "Team is one of the classes being shared; choose another parent."


def _imported_project() -> str:
    lib = client.post("/api/ontologies/upload", files={"file": ("hrcore.ttl", (PREFIXES.replace(HR, "http://example.org/core#").replace("hr:", "core:") + """
<http://example.org/core> a owl:Ontology .
core:Contractor a owl:Class ; rdfs:label "Contractor"@en .
""").encode())}).json()["id"]
    pid = open_project(MODEL + "<http://example.org/hr> a owl:Ontology ; owl:imports <http://example.org/core> .\n")
    client.post(f"/api/ontologies/{pid}-model/imports/mapping", json={"iri": "http://example.org/core", "ontologyId": lib})
    return pid


def test_an_imported_class_takes_a_union_but_is_never_given_a_parent():
    pid = _imported_project()
    core = "http://example.org/core#Contractor"
    shown = command(pid, "ShareDomain", dry=True, property="hr:hasName", **{"class": core}).json()["plan"]
    assert shown["case"] == "D"
    assert shown["choices"]["parent"] is False and shown["choices"]["union"] is True
    assert shown["choices"]["subclass"] is False, "no parent is added to an import's class"
    refused = command(pid, "ShareDomain", property="hr:hasName", how="parent", parentLabel="Person", **{"class": core})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Contractor comes from hrcore.ttl, so it cannot be given a new parent here."
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": core})
    assert union_of(graph(pid), U("hasName")) == [U("Employee"), URIRef(core)]


def test_an_imported_parent_counts_for_case_b():
    pid = _imported_project()
    apply = client.put(f"/api/projects/{pid}/documents/model/source", json={"text": MODEL.replace(
        'hr:Team a owl:Class ; rdfs:label "Team"@en .',
        'hr:Team a owl:Class ; rdfs:label "Team"@en ; rdfs:subClassOf <http://example.org/core#Contractor> .',
    ) + "<http://example.org/hr> a owl:Ontology ; owl:imports <http://example.org/core> .\n"
        + "hr:rate a owl:DatatypeProperty ; rdfs:label \"rate\"@en ; rdfs:domain <http://example.org/core#Contractor> .\n"})
    assert apply.status_code == 200
    assert plan(pid, "rate", "Team")["case"] == "B"


# --- AC-6: taking a class out ------------------------------------------------------------


def test_unsharing_from_three_leaves_two_and_from_two_the_plain_domain(pid):
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Contractor"})
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Team"})
    ok(pid, "UnshareDomain", property="hr:hasName", **{"class": "hr:Contractor"})
    assert union_of(graph(pid), U("hasName")) == [U("Employee"), U("Team")]
    ok(pid, "UnshareDomain", property="hr:hasName", **{"class": "hr:Employee"})
    g = graph(pid)
    assert list(g.objects(U("hasName"), RDFS.domain)) == [U("Team")]
    assert orphans(g) == [] and not [s for s in g.subjects(OWL.unionOf, None)], "no union of one, no debris"
    refused = command(pid, "UnshareDomain", property="hr:hasName", **{"class": "hr:Employee"})
    assert refused.status_code == 422 and refused.json()["detail"] == "Employee is not one of the classes hasName belongs to."


def test_replacing_or_clearing_a_shared_domain_takes_its_blank_nodes(pid):
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Contractor"})
    ok(pid, "SetDomain", property="hr:hasName", target="hr:Team")
    assert list(graph(pid).objects(U("hasName"), RDFS.domain)) == [U("Team")] and orphans(graph(pid)) == []
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Contractor"})
    ok(pid, "ClearDomain", property="hr:hasName")
    assert orphans(graph(pid)) == []
    ok(pid, "ShareDomain", property="hr:reportsTo", how="union", **{"class": "hr:Contractor"})
    ok(pid, "SetEnds", property="hr:reportsTo", domain="hr:Team")
    assert orphans(graph(pid)) == []


# --- 5.4: the Fix for two domain lines ---------------------------------------------------


def test_the_fix_shares_two_domain_lines_as_a_union():
    pid = open_project(MODEL + 'hr:badge a owl:DatatypeProperty ; rdfs:label "badge"@en ; rdfs:domain hr:Employee , hr:Team .\n')
    assert command(pid, "ShareDomain", dry=True, property="hr:badge").json()["plan"]["case"] == "separate"
    ok(pid, "ShareDomain", property="hr:badge", how="union")
    assert set(union_of(graph(pid), U("badge"))) == {U("Employee"), U("Team")}
    assert axioms.domain_of(graph(pid), U("badge")).form == "union"


def test_the_fix_with_an_rdfs_class_needs_a_parent_name():
    pid = open_project(MODEL + 'hr:badge a owl:DatatypeProperty ; rdfs:label "badge"@en ; rdfs:domain hr:Employee , hr:Volunteer .\n')
    assert command(pid, "ShareDomain", property="hr:badge", how="union").status_code == 422
    ok(pid, "ShareDomain", property="hr:badge", how="parent", parentLabel="Helper")
    assert list(graph(pid).objects(U("badge"), RDFS.domain)) == [U("Helper")]


# --- found in code review ----------------------------------------------------------------


def test_a_new_inverse_leaves_a_shared_start_a_union(pid):
    """Its range is named ends only: the union's blank node copied there
    would have two statements and read as an expression from then on."""
    ok(pid, "ShareDomain", property="hr:reportsTo", how="union", **{"class": "hr:Contractor"})
    ok(pid, "SetInverse", property="hr:reportsTo", label="manages")
    g = graph(pid)
    assert axioms.domain_of(g, U("reportsTo")).form == "union"
    assert list(g.objects(U("manages"), RDFS.range)) == []
    assert list(g.objects(U("manages"), RDFS.domain)) == [U("Manager")]


def test_swap_is_refused_for_a_shared_start(pid):
    ok(pid, "ShareDomain", property="hr:reportsTo", how="union", **{"class": "hr:Contractor"})
    refused = command(pid, "SwapEnds", property="hr:reportsTo")
    assert refused.status_code == 422
    assert refused.json()["detail"].startswith("reportsTo starts at several classes, so it cannot be swapped")


def test_deleting_a_member_class_shrinks_the_union_never_the_others(pid):
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Contractor"})
    ok(pid, "ShareDomain", property="hr:hasName", how="union", **{"class": "hr:Team"})
    ok(pid, "DeleteEntity", iri="hr:Team", strategy="orphan")
    assert union_of(graph(pid), U("hasName")) == [U("Employee"), U("Contractor")]
    ok(pid, "DeleteEntity", iri="hr:Contractor", strategy="orphan")
    g = graph(pid)
    assert list(g.objects(U("hasName"), RDFS.domain)) == [U("Employee")]
    assert orphans(g) == []
    undo(pid)
    assert union_of(graph(pid), U("hasName")) == [U("Employee"), U("Contractor")]


def test_moving_up_names_no_class_the_union_would_cover_anyway():
    pid = open_project(MODEL + 'hr:SeniorContractor a owl:Class ; rdfs:label "SeniorContractor"@en ; rdfs:subClassOf hr:Contractor .\n')
    up = plan(pid, "hasName", "Contractor")["choices"]["up"][0]
    assert [g["label"] for g in up["gains"]] == ["Intern"], "SeniorContractor has it through Contractor"


def test_the_form_lists_only_the_documents_own_domain_lines():
    """Remove is UnshareDomain on the document: a domain line an import adds
    is not offered (code review)."""
    pid = _imported_project()
    core = "http://example.org/core#"
    lib = client.post("/api/ontologies/upload", files={"file": ("extra.ttl", (PREFIXES + f"""
<http://example.org/extra> a owl:Ontology .
hr:hasName rdfs:domain <{core}Contractor> .
""").encode())}).json()["id"]
    source = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    client.put(f"/api/projects/{pid}/documents/model/source", json={"text": source + "\n<http://example.org/hr> owl:imports <http://example.org/extra> .\n"})
    client.post(f"/api/ontologies/{pid}-model/imports/mapping", json={"iri": "http://example.org/extra", "ontologyId": lib})
    details = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": HR + "hasName", "imports": "true"}).json()
    assert details["domain"] == {"form": "one", "classes": [{"iri": HR + "Employee", "label": "Employee", "type": "owl"}]}
    # The view reads both lines, and warns of them.
    assert any(w.get("code") == "separate" and "fix" not in w for w in details["warnings"])
