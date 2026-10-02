"""
================================================================================
FILE: backend/tests/test_shacl.py
================================================================================

SUMMARY
    Validation on demand (shacl-authoring 5.6, 5.7, Section 9): rows S1 to
    S18 as the server answers them -- one panel per shape with its state,
    counts and sentences -- the pySHACL options, the 30-second limit, the
    200-problem cap, a SPARQL constraint with SERVICE refused with no request
    made, a broken shape reported without hiding the others, and the three
    budgets of Section 10.

BASIC IDEA
    Through the HTTP API, as the frontend drives it. Shapes are made by the
    shape commands where the form can make them and written in Turtle where
    the row is about Turtle (S13 to S15); the example individuals are inline
    Turtle in the model, since Stage A has no form for them (Section 5.8 is
    Stage B). Each row asserts the panel's state, the sentence, and the
    focus IRI the interface's link selects.

INPUTS / INPUT SOURCES
    - The conftest temp data directory, the small and taxonomy templates,
      inline Turtle, a recording HTTP server for S15.

EXPECTED OUTPUT
    - Pass/fail for AC-5, AC-6's data and rows S1 to S18 (server half).
================================================================================
"""

from __future__ import annotations

import gc
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph
from rdflib.namespace import RDFS

from app import shacl
from app.editing import editing_service
from app.main import app

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
XSD = "http://www.w3.org/2001/XMLSchema#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <{XSD}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
"""

# The model and its example individuals (Stage B's form does not exist yet).
MODEL = PREFIXES + """
<http://example.org/shop> a owl:Ontology .
shop:Person a owl:Class ; rdfs:label "Person"@en ; rdfs:comment "A human being."@en .
shop:Employee a owl:Class ; rdfs:label "Employee"@en ; rdfs:subClassOf shop:Person ;
    rdfs:comment "A person who works for pay."@en .
shop:Organization a owl:Class ; rdfs:label "Organization"@en ; rdfs:comment "A group."@en .
shop:Company a owl:Class ; rdfs:label "Company"@en ; rdfs:subClassOf shop:Organization ;
    rdfs:comment "A business."@en .
shop:Invoice a owl:Class ; rdfs:label "Invoice"@en .
shop:name a owl:DatatypeProperty ; rdfs:label "name"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:birthDate a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:label "birth date"@en ;
    rdfs:domain shop:Person ; rdfs:range xsd:date .
shop:code a owl:DatatypeProperty ; rdfs:label "code"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:email a owl:DatatypeProperty ; rdfs:label "email"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:age a owl:DatatypeProperty ; rdfs:label "age"@en ; rdfs:domain shop:Person ; rdfs:range xsd:integer .
shop:status a owl:DatatypeProperty ; rdfs:label "status"@en ; rdfs:domain shop:Person ; rdfs:range xsd:string .
shop:worksFor a owl:ObjectProperty ; rdfs:label "works for"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .

shop:alice a shop:Person ; rdfs:label "Alice"@en ; shop:name "Alice" ; shop:birthDate "1990-04-01"^^xsd:date ;
    shop:worksFor shop:acme ; shop:code "ALC" ; shop:email "alice@example.org" ; shop:age 34 ;
    shop:status "active" .
shop:bob a shop:Person ; rdfs:label "Bob"@en ; shop:worksFor shop:alice .
shop:carol a shop:Person ; rdfs:label "Carol"@en ; shop:name "C1" , "C2" .
shop:dave a shop:Employee ; rdfs:label "Dave"@en .
shop:erin a shop:Person ; rdfs:label "Erin"@en ; shop:name "Erin" ; shop:birthDate "yesterday" ;
    shop:code "A1" ; shop:email "bob@" ; shop:age 212 ; shop:status "maybe" .
shop:acme a shop:Company ; rdfs:label "Acme"@en .
"""


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _create(**body) -> str:
    body.setdefault("name", "Shop")
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


@pytest.fixture
def pid() -> str:
    # The empty template: the model is replaced below, and the small one's
    # starter shapes (Stage B, 5.8) would join every check.
    project = _create(template="empty", baseIri=EX, prefix="shop")
    assert client.put(f"/api/projects/{project}/documents/model/source", json={"text": MODEL}).status_code == 200
    return project


def cmd(pid: str, command: str, **args) -> dict:
    response = client.post(f"/api/projects/{pid}/documents/shapes/commands", json={"command": command, "args": args})
    assert response.status_code == 200, response.text
    return response.json()


def shape(pid: str, target: str, *rules: dict, **extra) -> str:
    """A shape made the way the form makes it: CreateShape, then one AddRule
    per rule."""
    sid = cmd(pid, "CreateShape", target=target, **extra)["created"]
    for rule in rules:
        cmd(pid, "AddRule", shape=sid, rule=rule)
    return sid


def shapes_text(pid: str, text: str) -> None:
    """Shapes written in Turtle, through the editor's apply."""
    if "shapes" not in editing_service._open[pid]:
        assert client.post(f"/api/projects/{pid}/documents", json={"role": "shapes"}).status_code == 200
    response = client.put(f"/api/projects/{pid}/documents/shapes/source", json={"text": PREFIXES + text})
    assert response.status_code == 200, response.text


def validate(pid: str) -> dict:
    response = client.post(f"/api/projects/{pid}/validate")
    assert response.status_code == 200, response.text
    return response.json()


def panel(result: dict, sid: str) -> dict:
    return next(p for p in result["shapes"] if p["id"] == sid)


def sentences(p: dict) -> list[str]:
    return [problem["sentence"] for problem in p["problems"]]


def about(p: dict, focus: str) -> list[dict]:
    return [problem for problem in p["problems"] if problem["focus"] == EX + focus]


# --- S1 to S9: each rule kind's sentence -----------------------------------------------


def test_s1_a_required_name_reports_who_has_none_and_links_to_them(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    p = panel(validate(pid), sid)
    assert p["state"] == "fails"
    bob = about(p, "bob")
    assert [b["sentence"] for b in bob] == ["Bob has no name; every Person must have at least 1."]
    # The link: the focus IRI the interface selects, and the name it shows.
    assert bob[0]["focusLabel"] == "Bob"
    # Five people (an Employee included), three with no name: Bob, Dave and Erin has one.
    assert p["focusCount"] == 5
    assert p["failingCount"] == 2
    assert p["problemCount"] == 2
    assert p["target"]["many"] == "people"


def test_s2_at_most_one_name_counts_the_values(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "maxCount": 1})
    p = panel(validate(pid), sid)
    assert p["state"] == "fails"
    assert sentences(p) == ["Carol has 2 names; every Person may have at most 1."]


def test_s3_a_value_of_the_wrong_type_names_the_value_and_the_type(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "birthDate"], "datatype": "xsd:date"})
    p = panel(validate(pid), sid)
    assert p["state"] == "fails"
    assert sentences(p) == ['Erin\'s birth date "yesterday" is not a date.']
    assert p["problems"][0]["value"] == '"yesterday"'


def test_s4_points_to_fails_for_a_person_and_passes_for_a_subclass_instance(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "worksFor"], "class": EX + "Organization"})
    p = panel(validate(pid), sid)
    assert p["state"] == "fails"
    # Bob works for Alice, a Person; Alice works for Acme, a Company, which
    # is a kind of Organization, so she passes without inference.
    assert sentences(p) == ["Bob works for Alice, which is not an Organization."]
    assert about(p, "alice") == []


def test_s5_an_employee_is_checked_by_a_shape_on_person(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    p = panel(validate(pid), sid)
    assert [d["sentence"] for d in about(p, "dave")] == ["Dave has no name; every Person must have at least 1."]


def test_s6_text_length_and_pattern_show_the_value(pid):
    sid = shape(
        pid, EX + "Person",
        {"path": [EX + "code"], "minLength": 3},
        {"path": [EX + "email"], "pattern": r"^[^@\s]+@[^@\s]+\.[^@\s]+$"},
    )
    p = panel(validate(pid), sid)
    assert sorted(sentences(p)) == [
        'Erin\'s code "A1" is shorter than 3 characters.',
        'Erin\'s email "bob@" does not match the pattern of the rule.',
    ]


def test_s7_number_and_date_ranges_name_the_limit(pid):
    sid = shape(
        pid, EX + "Person",
        {"path": [EX + "age"], "minInclusive": {"value": "0", "datatype": "xsd:integer"},
         "maxInclusive": {"value": "150", "datatype": "xsd:integer"}},
        {"path": [EX + "birthDate"], "minInclusive": {"value": "2000-01-01", "datatype": "xsd:date"}},
    )
    p = panel(validate(pid), sid)
    assert "Erin's age 212 is above the maximum of 150." in sentences(p)
    assert "Alice's birth date \"1990-04-01\" is below the minimum of 2000-01-01." in sentences(p)


def test_s8_allowed_values_list_what_is_allowed(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "status"], "in": [
        {"kind": "typed", "value": "active", "datatype": "xsd:string"},
        {"kind": "typed", "value": "retired", "datatype": "xsd:string"},
    ]})
    p = panel(validate(pid), sid)
    # Alice's "active" is written plain in Turtle and the form sends
    # xsd:string: the list is written plain, so she passes.
    assert sentences(p) == ['Erin\'s status "maybe" is not one of: active, retired.']


def test_s9_languages_outside_the_project_and_two_names_in_one(pid):
    client.patch(f"/api/projects/{pid}", json={"languages": ["fr"]})
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    # skos:prefLabel names him: which of two English rdfs:labels a name is
    # taken from is set order, and a sentence must not depend on it.
    text += '\nshop:frank a shop:Person ; skos:prefLabel "Frank"@en ; rdfs:label "Franky"@en , "Frankie"@en , "Franz"@de .\n'
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    sid = shape(pid, EX + "Person", {"path": [str(RDFS.label)], "languageIn": ["en", "fr"], "uniqueLang": True})
    p = panel(validate(pid), sid)
    assert sorted(sentences(p)) == [
        # rdfs:label beside the model's *name* attribute (follow-up 4).
        'Frank has 2 names (label) in English; one per language is allowed.',
        'Frank\'s name (label) "Franz"@de is in German, which is not one of the project\'s languages.',
    ]


# --- S10 to S12: model checks, taxonomies and nothing to check -------------------------


def test_s10_check_my_model_names_the_class_without_a_definition(pid):
    sid = cmd(pid, "CreateShape", preset="modelCheck")["created"]
    p = panel(validate(pid), sid)
    assert p["state"] == "fails"
    # Invoice has no rdfs:comment and no skos:definition; the template's
    # classes are described by rdfs:comment, which counts.
    assert sentences(p) == ["Invoice has no definition; every class must have at least 1."]
    assert p["problems"][0]["focus"] == EX + "Invoice"
    assert p["target"]["many"] == "classes"


def test_s11_a_concept_missing_its_french_preferred_name_fails(pid):
    tax = _create(name="Fruit", template="taxonomy-small", baseIri="http://example.org/fruit#", prefix="fruit")
    client.patch(f"/api/projects/{tax}", json={"languages": ["fr"]})
    sid = cmd(tax, "CreateShape", preset="modelCheck")["created"]
    result = validate(tax)
    p = panel(result, sid)
    assert p["state"] == "fails"
    assert "Fruit has no preferred name in French; every concept must have one." in sentences(p)
    assert p["target"]["many"] == "concepts"


def test_s12_a_class_with_no_instances_has_nothing_to_check(pid):
    sid = shape(pid, EX + "Invoice", {"path": [EX + "code"], "minCount": 1})
    p = panel(validate(pid), sid)
    assert p["state"] == "nothing"
    assert p["focusCount"] == 0
    assert p["problems"] == []


def test_a_warning_shape_is_amber_not_red(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "maxCount": 1})
    cmd(pid, "SetShapeSeverity", shape=sid, severity="warning")
    p = panel(validate(pid), sid)
    assert p["state"] == "warnings"
    assert p["warningCount"] == 1
    assert p["problemCount"] == 0
    assert p["problems"][0]["severity"] == "warning"


def test_a_passing_shape_says_how_many_it_checked(pid):
    sid = shape(pid, EX + "Organization", {"path": [str(RDFS.label)], "minCount": 1})
    p = panel(validate(pid), sid)
    assert p["state"] == "passes"
    assert p["focusCount"] == 1  # Acme, a Company


def test_the_shapes_own_message_replaces_the_sentence(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "maxCount": 1})
    cmd(pid, "SetShapeMessage", shape=sid, value="One name per person, please.")
    assert sentences(panel(validate(pid), sid)) == ["One name per person, please."]


def test_panels_sort_failing_first(pid):
    passing = shape(pid, EX + "Organization", {"path": [str(RDFS.label)], "minCount": 1})
    nothing = shape(pid, EX + "Invoice", {"path": [EX + "code"], "minCount": 1})
    failing = shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    assert [p["id"] for p in validate(pid)["shapes"]] == [failing, nothing, passing]


# --- S13 to S15: shapes written in Turtle ------------------------------------------------


def test_s13_a_shape_with_sh_or_is_listed_read_only_and_validated(pid):
    shapes_text(pid, """
shop:ContactShape a sh:NodeShape ; rdfs:label "Contact rules"@en ; sh:targetClass shop:Person ;
    sh:or ( [ sh:path shop:email ; sh:minCount 1 ] [ sh:path shop:code ; sh:minCount 1 ] ) .
""")
    listed = client.get(f"/api/projects/{pid}/shapes").json()["shapes"]
    assert [s["name"] for s in listed] == ["Contact rules"]
    assert listed[0]["editable"] is False
    assert "uses sh:or" in listed[0]["unsupported"]
    p = panel(validate(pid), EX + "ContactShape")
    assert p["state"] == "fails"
    assert {problem["focus"] for problem in p["problems"]} == {EX + "bob", EX + "carol", EX + "dave"}


def test_s14_a_broken_shape_could_not_run_and_the_others_are_still_checked(pid):
    shapes_text(pid, """
shop:Broken a sh:NodeShape ; rdfs:label "Broken rules"@en ; sh:targetClass shop:Person ;
    sh:property [ sh:path shop:name ; sh:minCount "x" ] .
shop:Good a sh:NodeShape ; rdfs:label "Good rules"@en ; sh:targetClass shop:Person ;
    sh:property [ sh:path shop:name ; sh:maxCount 1 ] .
""")
    result = validate(pid)
    broken = panel(result, EX + "Broken")
    assert broken["state"] == "error"
    assert "minCount" in broken["error"]
    good = panel(result, EX + "Good")
    assert good["state"] == "fails"
    assert sentences(good) == ["Carol has 2 names; every Person may have at most 1."]


def test_a_blank_node_shape_beside_a_broken_one_is_still_checked(pid):
    # Found in review: pySHACL's use_shapes takes IRIs only, so the
    # shape-by-shape pass reported every blank-node shape as could not run.
    shapes_text(pid, """
[] a sh:NodeShape ; rdfs:label "Anonymous rules"@en ; sh:targetClass shop:Person ;
    sh:property [ sh:path shop:name ; sh:maxCount 1 ] .
shop:Broken a sh:NodeShape ; rdfs:label "Broken rules"@en ; sh:targetClass shop:Person ;
    sh:property [ sh:path shop:name ; sh:minCount "x" ] .
""")
    result = validate(pid)
    anonymous = next(p for p in result["shapes"] if p["name"] == "Anonymous rules")
    assert anonymous["id"].startswith("_:")
    assert anonymous["state"] == "fails"
    assert sentences(anonymous) == ["Carol has 2 names; every Person may have at most 1."]
    assert panel(result, EX + "Broken")["state"] == "error"
    # The id is the one the shapes list gives, so a row finds its result.
    listed = client.get(f"/api/projects/{pid}/shapes").json()["shapes"]
    assert anonymous["id"] in {s["id"] for s in listed}


def test_s15_a_sparql_shape_with_service_is_refused_and_sends_nothing(pid, http_server):
    server = http_server(lambda path: (200, {"Content-Type": "application/sparql-results+json"}, b"{}"))
    port = server.server_address[1]
    shapes_text(pid, f"""
shop:Remote a sh:NodeShape ; rdfs:label "Remote rules"@en ; sh:targetClass shop:Person ;
    sh:sparql [ sh:select "SELECT $this WHERE {{ SERVICE <http://127.0.0.1:{port}/sparql> {{ ?s ?p ?o }} }}" ] .
shop:Local a sh:NodeShape ; rdfs:label "Local rules"@en ; sh:targetClass shop:Person ;
    sh:property [ sh:path shop:name ; sh:maxCount 1 ] .
""")
    result = validate(pid)
    remote = panel(result, EX + "Remote")
    assert remote["state"] == "error"
    assert "SERVICE" in remote["error"]
    assert panel(result, EX + "Local")["state"] == "fails"
    # The recording server saw nothing: refused, not merely failed.
    assert server.requests == []


# --- S16, S18: stale results and the cap -------------------------------------------------


def test_s16_the_revisions_checked_come_back_so_a_change_shows_as_stale(pid):
    sid = shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    first = validate(pid)
    model_rev = first["revisions"]["model"]
    shapes_rev = first["revisions"]["shapes"]
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    text = text.replace('shop:bob a shop:Person ; rdfs:label "Bob"@en ;', 'shop:bob a shop:Person ; rdfs:label "Bob"@en ; shop:name "Bob" ;')
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    state = client.post(f"/api/projects/{pid}/open").json()["documents"]
    assert next(d for d in state if d["doc"] == "model")["revision"] != model_rev
    second = validate(pid)
    assert second["revisions"]["model"] > model_rev
    assert second["revisions"]["shapes"] == shapes_rev
    # Unsaved changes are checked: Bob now has a name, and nothing was saved.
    assert about(panel(second, sid), "bob") == []


def test_s18_a_panel_carries_200_problems_and_the_true_total(pid):
    people = "\n".join(f"shop:p{i} a shop:Person ." for i in range(1500))
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"] + people
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    sid = shape(pid, EX + "Person", {"path": [EX + "age"], "minCount": 1})
    p = panel(validate(pid), sid)
    assert len(p["problems"]) == 200
    # 1,500 nameless people, plus Bob, Carol and Dave.
    assert p["problemsTotal"] == 1503
    assert p["problemCount"] == 1503


# --- AC-5 and Section 9: what is checked, and how -----------------------------------------


def test_validation_runs_with_inference_advanced_js_and_imports_off(pid, monkeypatch):
    seen: list[dict] = []
    real = shacl.pyshacl.validate

    def recording(*args, **kwargs):
        seen.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(shacl.pyshacl, "validate", recording)
    shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    validate(pid)
    assert seen, "pySHACL was never called"
    for kwargs in seen:
        assert kwargs["inference"] == "none"
        assert kwargs["advanced"] is False
        assert kwargs["js"] is False
        assert kwargs["do_owl_imports"] is False


def test_owl_imports_in_the_shapes_are_not_followed(pid, http_server):
    server = http_server(lambda path: (200, {"Content-Type": "text/turtle"}, b""))
    port = server.server_address[1]
    shapes_text(pid, f"""
<http://example.org/shapes> a owl:Ontology ; owl:imports <http://127.0.0.1:{port}/more.ttl> .
shop:S a sh:NodeShape ; sh:targetClass shop:Person ; sh:property [ sh:path shop:name ; sh:maxCount 1 ] .
""")
    assert panel(validate(pid), EX + "S")["state"] == "fails"
    assert server.requests == []


def test_a_from_clause_in_a_sparql_shape_reads_no_file(pid, tmp_path):
    secret = tmp_path / "secret.ttl"
    secret.write_text('<http://x/s> <http://x/p> "TOP SECRET" .', encoding="utf-8")
    shapes_text(pid, f"""
shop:Leak a sh:NodeShape ; rdfs:label "Leak"@en ; sh:targetClass shop:Person ;
    sh:sparql [ sh:select "SELECT $this ?value FROM <{secret.as_uri()}> WHERE {{ ?s ?p ?value }}" ] .
""")
    result = validate(pid)
    assert "TOP SECRET" not in str(result)


def test_validate_refuses_a_dataset_as_data():
    from rdflib import Dataset

    with pytest.raises(TypeError):
        shacl.validate(Dataset(), Graph(), ["en"])


def test_a_check_past_the_limit_is_stopped_with_its_size(pid, monkeypatch):
    real = shacl.pyshacl.validate

    def slow(*args, **kwargs):
        time.sleep(0.6)
        return real(*args, **kwargs)

    monkeypatch.setattr(shacl.pyshacl, "validate", slow)
    monkeypatch.setattr(shacl, "VALIDATE_TIMEOUT_SECONDS", 0.1)
    shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    result = validate(pid)
    assert result["stopped"] is True
    assert result["shapes"] == []
    assert result["shapeCount"] == 1
    assert result["statements"] == len(editing_service.document(pid, "model").graph)


def test_a_shape_on_an_imported_class_finds_its_instances(pid):
    lib = client.post(
        "/api/ontologies/upload",
        files={"file": ("staff.ttl", b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/staff> a owl:Ontology .
<http://example.org/staff#Staff> a owl:Class ; rdfs:label "Staff"@en .
<http://example.org/staff#sam> a <http://example.org/staff#Staff> ; rdfs:label "Sam"@en .
""")},
    ).json()["id"]
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    text += "\n<http://example.org/shop> owl:imports <http://example.org/staff> .\n"
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    response = client.post(f"/api/ontologies/{pid}-model/imports/mapping",
                           json={"iri": "http://example.org/staff", "ontologyId": lib})
    assert response.status_code == 200, response.text
    sid = shape(pid, "http://example.org/staff#Staff", {"path": [EX + "code"], "minCount": 1})
    p = panel(validate(pid), sid)
    assert p["focusCount"] == 1
    assert sentences(p) == ["Sam has no code; every Staff must have at least 1."]


def test_validate_changes_nothing(pid):
    shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1})
    before = {d: (editing_service.document(pid, d).ontology.revision, len(editing_service.document(pid, d).graph))
              for d in ("model", "shapes")}
    validate(pid)
    after = {d: (editing_service.document(pid, d).ontology.revision, len(editing_service.document(pid, d).graph))
             for d in ("model", "shapes")}
    assert before == after


def test_a_project_without_shapes_validates_to_no_panels(pid):
    result = validate(pid)
    assert result["shapes"] == []
    assert result["shapeCount"] == 0
    assert result["revisions"]["shapes"] is None


def test_validate_needs_the_project_open(pid):
    editing_service.close(pid, discard=True)
    assert client.post(f"/api/projects/{pid}/validate").status_code == 409
    assert client.post("/api/projects/prj-000000000000/validate").status_code == 404


@pytest.mark.parametrize(
    ("word", "expected"),
    [("person", "people"), ("Person", "People"), ("class", "classes"), ("company", "companies"),
     ("phone number", "phone numbers"), ("day", "days"), ("box", "boxes"), ("name", "names")],
)
def test_plural(word, expected):
    assert shacl.plural(word) == expected


# --- Section 10: the budgets -----------------------------------------------------------------


def _median_ms(action, samples: int = 5) -> float:
    times = []
    gc.disable()
    try:
        for _ in range(samples):
            start = time.perf_counter()
            action()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return sorted(times)[samples // 2]


def _big_data(pid: str, statements: int = 10_000) -> None:
    """The 10,000-statement fixture with example data: people, each with a
    name, an age and an employer, generated rather than committed."""
    lines = [MODEL]
    i = 0
    count = len(Graph().parse(data=MODEL, format="turtle"))
    while count < statements:
        lines.append(f'shop:x{i} a shop:Person ; shop:name "Person {i}" ; shop:age {i % 120} ; '
                     f'shop:worksFor shop:acme ; shop:code "C{i:04d}" .')
        count += 5
        i += 1
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": "\n".join(lines)}).status_code == 200
    assert len(editing_service.document(pid, "model").graph) >= statements


@pytest.mark.perf
def test_validate_budget(pid):
    _big_data(pid)
    rules = [
        {"path": [EX + "name"], "minCount": 1, "maxCount": 1, "datatype": "xsd:string"},
        {"path": [EX + "age"], "maxInclusive": {"value": "150", "datatype": "xsd:integer"}},
        {"path": [EX + "worksFor"], "class": EX + "Organization"},
        {"path": [EX + "code"], "minLength": 3, "pattern": "^C[0-9]+$"},
        {"path": [str(RDFS.label)], "uniqueLang": True},
    ]
    for i in range(10):
        shape(pid, EX + "Person", rules[i % len(rules)], name=f"Timed {i}")
    median = _median_ms(lambda: validate(pid))
    assert median <= limit_ms(2000), f"validating 10,000 statements with 10 shapes took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_shapes_budget(pid):
    for i in range(50):
        shape(pid, EX + "Person", {"path": [EX + "name"], "minCount": 1}, {"path": [EX + "age"], "maxCount": 1},
              name=f"Listed {i}")
    median = _median_ms(lambda: client.get(f"/api/projects/{pid}/shapes"))
    assert len(client.get(f"/api/projects/{pid}/shapes").json()["shapes"]) == 50
    assert median <= limit_ms(100), f"the list and form structure of 50 shapes took {median:.1f} ms (median of 5)"


@pytest.mark.perf
def test_suggestions_budget(pid):
    _big_data(pid)
    sid = shape(pid, EX + "Employee", {"path": [EX + "name"], "minCount": 1})
    params = {"target": EX + "Employee", "shape": sid}
    median = _median_ms(lambda: client.get(f"/api/projects/{pid}/shapes/suggestions", params=params))
    assert median <= limit_ms(100), f"suggestions took {median:.1f} ms (median of 5)"

