"""
================================================================================
FILE: backend/tests/test_reasoning.py
================================================================================

SUMMARY
    Reasoning on demand (axioms-and-reasoning Stage A, AC-1 to AC-7): the
    facts a run shows and how they are grouped, the problems and their
    causes, a reason for every fact, the run's bounds (limit, Stop, one at a
    time, the ceiling, a failing worker), what goes stale, that a run
    changes nothing in the project, and the inferred edges the tree and the
    canvas are given. Plus the timing budgets of Section 10.

BASIC IDEA
    Every model is written in the test (rdf-fixture): a shop model in
    Turtle, applied to a Small project through the Turtle route as a
    learner would, so the run goes through the real route, the real
    spawned process and OWL-RL. The two full snapshots are generated as
    CSV in the test and imported through the data route.

    The probe's IRIs must never reach a response, so the security test
    reads every route's answer as text -- the run, each group's pages, the
    facts about every entity and the reason for every fact -- and looks for
    the scheme in all of it.

    The 30-second limit is lowered through the module attribute for the
    test that needs a run to time out, and a run is made slow by a dense
    generated model, not by sleeping in the worker.

INPUTS / INPUT SOURCES
    - The app through TestClient with the client header; app.reasoning
      directly for the unit tests and the budgets.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

import gc
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS

from app import reasoning
from app.editing import editing_service
from app.main import app
from tests.budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"


def U(local: str) -> URIRef:
    return URIRef(EX + local)


PREFIXES = """
@prefix : <http://example.org/shop#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
"""

# The shop model: a kind chain, domains and ranges, an other way round, a
# relationship that chains, one that works both ways, one under another, and
# a Manager defined by a restriction. Every entity named.
SHOP = PREFIXES + """
<http://example.org/shop> a owl:Ontology ; rdfs:label "Shop"@en .
:Agent a owl:Class ; rdfs:label "Agent"@en .
:Person a owl:Class ; rdfs:label "Person"@en ; rdfs:subClassOf :Agent .
:Employee a owl:Class ; rdfs:label "Employee"@en ; rdfs:subClassOf :Person .
:Organization a owl:Class ; rdfs:label "Organization"@en .
:Team a owl:Class ; rdfs:label "Team"@en .
:Manager a owl:Class ; rdfs:label "Manager"@en ;
    owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person
        [ a owl:Restriction ; owl:onProperty :manages ; owl:someValuesFrom :Employee ] ) ] .
:worksFor a owl:ObjectProperty ; rdfs:label "works for"@en ; rdfs:domain :Person ; rdfs:range :Organization .
:employs a owl:ObjectProperty ; rdfs:label "employs"@en ; owl:inverseOf :worksFor .
:manages a owl:ObjectProperty ; rdfs:label "manages"@en .
:partOf a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:label "part of"@en .
:marriedTo a owl:ObjectProperty, owl:SymmetricProperty ; rdfs:label "married to"@en .
:memberOf a owl:ObjectProperty ; rdfs:label "member of"@en ; rdfs:range :Team .
:leads a owl:ObjectProperty ; rdfs:label "leads"@en ; rdfs:subPropertyOf :memberOf .
:alice a owl:NamedIndividual ; rdfs:label "Alice"@en ; :worksFor :acme ; :manages :bob .
:bob a owl:NamedIndividual, :Employee ; rdfs:label "bob"@en .
:acme a owl:NamedIndividual ; rdfs:label "Acme"@en .
:unitA a owl:NamedIndividual ; rdfs:label "unit A"@en ; :partOf :divB .
:divB a owl:NamedIndividual ; rdfs:label "division B"@en ; :partOf :acme .
:bo a owl:NamedIndividual ; rdfs:label "Bo"@en ; :marriedTo :ann .
:ann a owl:NamedIndividual ; rdfs:label "Ann"@en ; :leads :teamA .
:teamA a owl:NamedIndividual ; rdfs:label "Team A"@en .
"""


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def create(template: str = "small") -> str:
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": template, "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    return project


def apply(pid: str, text: str) -> dict:
    response = client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})
    assert response.status_code == 200, response.text
    return response.json()


def reason(pid: str, status: int = 200, **body) -> dict:
    response = client.post(f"/api/projects/{pid}/reasoning", json=body)
    assert response.status_code == status, response.text
    return response.json()


def shown(result: dict) -> dict:
    return {g["kind"]: [item["sentence"] for item in g["items"]] for g in result["groups"]}


@pytest.fixture
def shop() -> str:
    pid = create()
    apply(pid, SHOP)
    return pid


# The shop model's facts, exactly, in their groups (AC-1, AC-3).
SHOP_FACTS = {
    "kinds": ["Employee is a kind of Agent", "Manager is a kind of Agent", "Manager is a kind of Person"],
    "same": [],
    "memberships": [
        "Acme is an Organization", "Alice is a Manager", "Alice is a Person", "Alice is an Agent",
        "bob is a Person", "bob is an Agent", "Team A is a Team",
    ],
    "links": ["Acme employs Alice", "Ann married to Bo", "Ann member of Team A", "unit A part of Acme"],
}


def items(result: dict) -> list[dict]:
    return [item for g in result["groups"] for item in g["items"]] + result["importedFacts"]["items"]


# --- what is shown (5.4) -----------------------------------------------------------------


def test_the_shop_models_facts_exactly_in_their_groups(shop):
    result = reason(shop)
    assert result["status"] == "done" and result["sentence"] is None and result["stale"] is False
    assert shown(result) == SHOP_FACTS
    assert [g["total"] for g in result["groups"]] == [3, 0, 7, 4]
    assert result["importedFacts"]["total"] == 0
    assert result["statements"] == len(Graph().parse(data=SHOP, format="turtle"))
    # No built-in, reflexive or blank-node fact: OWL-RL added 200 of those.
    for item in items(result):
        assert item["s"].startswith(EX) and item["o"].startswith(EX), item
        assert item["s"] != item["o"]


def test_facts_about_imported_terms_alone_are_counted_apart():
    stated = Graph().parse(data=PREFIXES + """
        :Person a owl:Class ; rdfs:subClassOf :Agent . :Agent a owl:Class ; rdfs:subClassOf :Being .
        :Being a owl:Class . :Employee a owl:Class ; rdfs:subClassOf :Person .
    """, format="turtle")
    raw = reasoning.reason(stated.serialize(format="nt"), "", [])
    imported = {EX + "Person", EX + "Agent", EX + "Being"}
    outcome = reasoning.analyse(
        list(stated), raw, key=reasoning.Key(1, 0, True, False), languages=["en"], probes=[], imported=imported,
    )
    summary = outcome.summary()
    # Person is a kind of Being: both ends from an import, one line apart.
    assert summary["importedFacts"]["total"] == 1
    assert [i["sentence"] for i in summary["importedFacts"]["items"]] == ["Person is a kind of Being"]
    assert shown(summary)["kinds"] == ["Employee is a kind of Agent", "Employee is a kind of Being"]


def test_a_long_group_is_paged_two_hundred_at_a_time_with_its_true_total(shop):
    many = "".join(f':e{i} a :Employee ; rdfs:label "e{i:03d}"@en .' + "\n" for i in range(450))
    apply(shop, SHOP + many)
    result = reason(shop)
    memberships = next(g for g in result["groups"] if g["kind"] == "memberships")
    assert memberships["total"] == 7 + 900 and len(memberships["items"]) == 200
    page = client.get(f"/api/projects/{shop}/reasoning", params={"group": "memberships", "offset": 800}).json()
    assert page["total"] == 907 and page["offset"] == 800 and len(page["items"]) == 107
    assert page["stale"] is False
    assert client.get(f"/api/projects/{shop}/reasoning", params={"group": "nope"}).status_code == 404


def import_rows(pid: str, name: str, header: str, rows: list[str], chosen: dict) -> dict:
    text = header + "\n" + "\n".join(rows) + "\n"
    response = client.post(
        f"/api/projects/{pid}/data",
        files={"file": (name, text.encode(), "text/csv")},
        data={"choices": json.dumps(chosen), "options": "{}"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def employees(pid: str, n: int = 3, name: str = "people.csv") -> dict:
    return import_rows(pid, name, "id,name", [f"{i},Person {i}" for i in range(1, n + 1)], {
        "classIri": EX + "Employee", "idColumn": "id", "columns": {"name": {"as": "name"}},
    })


def test_snapshots_join_only_when_asked(shop):
    employees(shop)
    without = reason(shop)
    assert shown(without) == SHOP_FACTS
    with_data = reason(shop, includeData=True)
    assert with_data["statements"] > without["statements"] and with_data["includeData"] is True
    added = set(shown(with_data)["memberships"]) - set(SHOP_FACTS["memberships"])
    assert added == {f"Person {i} is a Person" for i in range(1, 4)} | {f"Person {i} is an Agent" for i in range(1, 4)}


def test_reasoning_is_for_ontology_projects_and_needs_a_run_first():
    taxonomy = create("taxonomy-small")
    refused = client.post(f"/api/projects/{taxonomy}/reasoning", json={})
    assert refused.status_code == 422 and refused.json()["detail"] == "Reasoning is for ontology projects."
    ontology = create()
    missing = client.get(f"/api/projects/{ontology}/reasoning")
    assert missing.status_code == 404 and "Nothing has been reasoned" in missing.json()["detail"]
    # An id the server never issued is 404 like everywhere else.
    assert client.post("/api/projects/prj-000000000000/reasoning", json={}).status_code == 404


# --- problems (5.5) ------------------------------------------------------------------------

ROBOT = SHOP + """
:Person owl:disjointWith :Organization .
:Robot a owl:Class ; rdfs:label "Robot"@en ; rdfs:subClassOf :Android , :Organization .
:Android a owl:Class ; rdfs:label "Android"@en ; rdfs:subClassOf :Person .
:carl a owl:NamedIndividual, :Person, :Organization ; rdfs:label "carl"@en .
"""


def test_a_thing_in_disjoint_classes_and_a_class_that_can_never_have_members(shop):
    apply(shop, ROBOT)
    result = reason(shop)
    sentences = [p["sentence"] for p in result["problems"]]
    assert sentences == [
        "Robot can never have members: it is a kind of Person and a kind of Organization, "
        "and no Person is an Organization.",
        "carl cannot be both a Person and an Organization: no Person is an Organization.",
    ]
    robot, carl = result["problems"]
    assert robot["kind"] == "neverMembers" and robot["subject"] == EX + "Robot"
    # Its causes: the stated path to each of the pair, and the disjointness,
    # each a fact whose subject is a link.
    assert [(c["s"], c["p"], c["o"], c["inferred"]) for c in robot["causes"]] == [
        (EX + "Robot", str(RDFS.subClassOf), EX + "Android", False),
        (EX + "Android", str(RDFS.subClassOf), EX + "Person", False),
        (EX + "Robot", str(RDFS.subClassOf), EX + "Organization", False),
        (EX + "Person", str(OWL.disjointWith), EX + "Organization", False),
    ]
    assert robot["reasoner"].endswith("(the reasoner's words)") and "test member of" in robot["reasoner"]
    assert carl["kind"] == "disjointMember" and carl["subject"] == EX + "carl"
    assert [c["sentence"] for c in carl["causes"]] == [
        "carl is a Person", "carl is an Organization", "no Person is an Organization",
    ]
    about = client.get(f"/api/projects/{shop}/reasoning", params={"about": EX + "Robot"}).json()
    assert about["neverMembers"] is True


def test_no_result_ever_names_a_probe_member(shop):
    # Every class gets a probe; a has-value rule makes a probe meet another
    # thing too (5.5). Nothing that leaves the server may carry the scheme.
    apply(shop, ROBOT + """
        :Gold a owl:Class ; rdfs:label "Gold"@en ; rdfs:subClassOf
            [ a owl:Restriction ; owl:onProperty :worksFor ; owl:hasValue :carl ] .
    """)
    texts = []
    result = reason(shop)
    texts.append(json.dumps(result))
    texts.append(client.get(f"/api/projects/{shop}/reasoning").text)
    for kind in ("kinds", "same", "memberships", "links", "imported"):
        texts.append(client.get(f"/api/projects/{shop}/reasoning", params={"group": kind}).text)
    facts = items(result) + [c for p in result["problems"] for c in p["causes"]]
    for subject in {f["s"] for f in facts} | {f["o"] for f in facts}:
        texts.append(client.get(f"/api/projects/{shop}/reasoning", params={"about": subject}).text)
    for fact in facts:
        answer = client.get(f"/api/projects/{shop}/reasoning/why", params={k: fact[k] for k in "spo"})
        assert answer.status_code == 200, (fact, answer.text)
        texts.append(answer.text)
        for premise in answer.json()["premises"]:
            if premise["o"] is not None:
                texts.append(client.get(
                    f"/api/projects/{shop}/reasoning/why", params={k: premise[k] for k in "spo"},
                ).text)
    texts.append(client.get(f"/api/ontologies/{shop}-model/hierarchy", params={"inferred": True}).text)
    texts.append(client.get(f"/api/projects/{shop}/documents/model/canvas", params={"inferred": True}).text)
    assert len(texts) > 40 and all(texts)
    assert [t for t in texts if reasoning.PROBE in t] == []
    # The probe found what it is for, so the scan above had something to miss.
    assert any(p["kind"] == "neverMembers" for p in result["problems"])


def test_never_to_itself_never_both_ways_and_different_things_made_the_same_each_once(shop):
    apply(shop, SHOP + """
        :knows a owl:ObjectProperty, owl:IrreflexiveProperty ; rdfs:label "knows"@en .
        :alice :knows :alice .
        :above a owl:ObjectProperty, owl:AsymmetricProperty ; rdfs:label "above"@en .
        :unitA :above :divB . :divB :above :unitA .
        :holder a owl:ObjectProperty, owl:FunctionalProperty ; rdfs:label "holder"@en .
        :p1 rdfs:label "passport 1"@en ; :holder :ann , :anne .
        :anne rdfs:label "Anne"@en ; owl:differentFrom :ann .
    """)
    result = reason(shop)
    problems = {p["kind"]: p for p in result["problems"]}
    assert problems["irreflexive"]["sentence"] == "Alice is linked to itself by knows, which is never to itself."
    # OWL-RL reports the pair once per direction; it is shown once.
    assert sum(1 for p in result["problems"] if p["kind"] == "asymmetric") == 1
    assert problems["asymmetric"]["sentence"] == (
        "division B above unit A and unit A above division B, but above is never both ways."
    )
    assert problems["differentSame"]["sentence"] == (
        "Ann and Anne are stated to be different things, but the reasoner concludes they are the same thing."
    )
    same = problems["differentSame"]["causes"][1]
    assert same["inferred"] is True
    answer = client.get(f"/api/projects/{shop}/reasoning/why", params={k: same[k] for k in "spo"}).json()
    assert answer["family"] == "sameThing"


def test_anything_else_keeps_the_reasoners_words_with_names_for_iris():
    raw = reasoning.RawResult("done", errors=[f"Something odd about {EX}alice and {EX}acme"])
    outcome = reasoning.analyse(
        list(Graph().parse(data=SHOP, format="turtle")), raw, key=reasoning.Key(1, 0, False, False),
        languages=["en"], probes=[],
    )
    assert [p["sentence"] for p in outcome.problems] == ["Something odd about Alice and Acme (the reasoner's words)"]


# --- why (5.6) -------------------------------------------------------------------------

FAMILIES = SHOP + """
:Order a owl:Class ; rdfs:label "Order"@en ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLine ; owl:allValuesFrom :OrderLine ] .
:OrderLine a owl:Class ; rdfs:label "Order line"@en .
:hasLine a owl:ObjectProperty ; rdfs:label "has line"@en .
:order7 a :Order ; rdfs:label "order 7"@en ; :hasLine :l1 .
:l1 rdfs:label "L1"@en .
:Client a owl:Class ; rdfs:label "Client"@en ; owl:equivalentClass :Customer .
:Customer a owl:Class ; rdfs:label "Customer"@en .
:carol a :Client ; rdfs:label "carol"@en .
:holder a owl:ObjectProperty, owl:FunctionalProperty ; rdfs:label "holder"@en .
:p1 rdfs:label "passport 1"@en ; :holder :ann , :anne .
:anne rdfs:label "Anne"@en .
"""

# One fact per family of 5.6, with the reason it reads.
EXPECTED_REASONS = {
    "Employee is a kind of Agent": ("kindChain", "Employee is a kind of Person, and Person is a kind of Agent"),
    "bob is a Person": ("memberKind", "bob is an Employee, and every Employee is a Person"),
    "Alice is a Person": ("domainRange", "Alice works for Acme, and whoever works for something is a Person"),
    "Acme is an Organization": (
        "domainRange", "Alice works for Acme, and whatever something works for is an Organization",
    ),
    "Acme employs Alice": ("inverse", "Alice works for Acme, and employs is works for the other way round"),
    "Ann married to Bo": ("symmetric", "Bo married to Ann, and married to works both ways"),
    "unit A part of Acme": ("transitive", "unit A part of division B, division B part of Acme, and part of chains"),
    "Ann member of Team A": ("subProperty", "Ann leads Team A, and leads is a kind of member of"),
    "Alice is a Manager": (
        "defining",
        "Alice is a Person and Alice manages bob and bob is an Employee, and a Manager is exactly "
        "a Person that manages at least one Employee",
    ),
    "L1 is an Order line": ("only", "order 7 has line L1, and every Order's has line can only be Order lines"),
    "carol is a Customer": ("same", "carol is a Client, and Client and Customer mean the same thing"),
    "Ann and Anne are the same thing": (
        "sameThing", "passport 1 holder Ann and Anne, and holder is at most one, so they are the same",
    ),
}


def why(pid: str, fact: dict) -> dict:
    response = client.get(f"/api/projects/{pid}/reasoning/why", params={k: fact[k] for k in "spo"})
    assert response.status_code == 200, response.text
    return response.json()


def test_each_family_gives_its_reason_one_step_with_its_premises(shop):
    apply(shop, FAMILIES)
    result = reason(shop)
    facts = {item["sentence"]: item for item in items(result)}
    families = set()
    for sentence, (family, words) in EXPECTED_REASONS.items():
        assert sentence in facts, sentence
        answer = why(shop, facts[sentence])
        assert (answer["family"], answer["sentence"]) == (family, words), sentence
        assert answer["premises"], sentence
        families.add(family)
    assert families == set(reasoning.FAMILIES)
    # The transitive reason's three lines, as the spec draws them.
    lines = why(shop, facts["unit A part of Acme"])["premises"]
    assert [(p["sentence"], p["inferred"]) for p in lines] == [
        ("unit A part of division B", False), ("division B part of Acme", False), ("part of chains", False),
    ]
    # An inferred premise is marked, and has its own reason: walking back.
    manager = why(shop, facts["Alice is a Manager"])
    inferred = [p for p in manager["premises"] if p["inferred"]]
    assert [p["sentence"] for p in inferred] == ["Alice is a Person"]
    assert why(shop, inferred[0])["family"] == "domainRange"
    definition = manager["premises"][-1]
    assert definition["o"] is None and definition["inferred"] is False
    # A stated fact asked about says so; a fact not in the result is 404.
    assert why(shop, manager["premises"][1])["family"] == "stated"
    assert client.get(
        f"/api/projects/{shop}/reasoning/why", params={"s": EX + "acme", "p": str(RDF.type), "o": EX + "Robot"},
    ).status_code == 404


def test_every_fact_on_the_family_model_has_a_plain_reason(shop):
    apply(shop, FAMILIES)
    result = reason(shop)
    assert [item["sentence"] for item in items(result) if why(shop, item)["family"] is None] == []


def test_a_fact_no_family_explains_says_so():
    fact = (U("a"), U("p"), U("b"))
    answer = reasoning.Explainer(reasoning.Index([]), reasoning.Index([fact]), str).explain(fact)
    assert answer == {"family": None, "sentence": reasoning.NO_REASON, "premises": []}


# --- two full snapshots: coverage counted (5.6, R7), and their budget -------------------------

SNAPSHOT_MODEL = PREFIXES + """
:Agent a owl:Class ; rdfs:label "Agent"@en .
:Person a owl:Class ; rdfs:label "Person"@en ; rdfs:subClassOf :Agent .
:Organization a owl:Class ; rdfs:label "Organization"@en ; rdfs:subClassOf :Agent .
:memberOf a owl:ObjectProperty ; rdfs:label "member of"@en ; rdfs:domain :Person ; rdfs:range :Organization .
:hasMember a owl:ObjectProperty ; rdfs:label "has member"@en ; owl:inverseOf :memberOf .
:born a owl:DatatypeProperty ; rdfs:label "born"@en ; rdfs:domain :Person ; rdfs:range xsd:date .
""" + "".join(f':C{i} a owl:Class ; rdfs:label "Class {i}"@en ; rdfs:subClassOf :Agent .' + "\n" for i in range(55))


@pytest.fixture
def two_snapshots() -> str:
    pid = create()
    apply(pid, SNAPSHOT_MODEL)
    import_rows(pid, "orgs.csv", "id,name", [f"o{i},Org {i}" for i in range(2000)], {
        "classIri": EX + "Organization", "idColumn": "id", "columns": {"name": {"as": "name"}},
    })
    import_rows(pid, "people.csv", "id,name,born,org", [
        f"p{i},Person {i},19{50 + i % 50}-01-0{1 + i % 9},o{i % 2000}" for i in range(2000)
    ], {
        "classIri": EX + "Person", "idColumn": "id",
        "columns": {
            "name": {"as": "name"},
            "born": {"as": "attribute", "property": EX + "born"},
            "org": {"as": "relationship", "property": EX + "memberOf"},
        },
    })
    return pid


def all_facts(pid: str, result: dict) -> list[dict]:
    out = []
    for group in result["groups"] + [result["importedFacts"]]:
        for offset in range(0, group["total"], reasoning.PAGE):
            page = client.get(f"/api/projects/{pid}/reasoning", params={"group": group["kind"], "offset": offset})
            out += page.json()["items"]
    return out


def test_every_fact_on_two_full_snapshots_has_a_plain_reason(two_snapshots):
    result = reason(two_snapshots, includeData=True)
    assert result["status"] == "done"
    facts = all_facts(two_snapshots, result)
    assert len(facts) == sum(g["total"] for g in result["groups"]) + result["importedFacts"]["total"]
    assert len(facts) >= 6000
    outcome = reasoning.service.result(two_snapshots)
    covered = sum(1 for f in facts if outcome.why(f["s"], f["p"], f["o"])["family"] is not None)
    # The count the test plan keeps (R7): every one, as the prototype found.
    assert covered == len(facts), f"{covered} of {len(facts)} facts have a plain reason"


# --- bounds (5.2, AC-2) ----------------------------------------------------------------


def chain(n: int = 150) -> str:
    """A dense model: a relationship that chains along n things takes OWL-RL
    seconds (150 measured at 11 s), so a run is long enough to stop."""
    return SHOP + "".join(f":n{i} :partOf :n{i + 1} ." + "\n" for i in range(n))


def start_in_background(pid: str, **body) -> tuple[threading.Thread, dict]:
    answer: dict = {}

    def go():
        response = client.post(f"/api/projects/{pid}/reasoning", json=body)
        answer["status"], answer["body"] = response.status_code, response.json()

    thread = threading.Thread(target=go)
    thread.start()
    return thread, answer


def wait_for_process(pid: str) -> reasoning.RunHandle:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        handle = reasoning.service._running.get(pid)
        if handle is not None and handle.process is not None and handle.process.is_alive():
            return handle
        time.sleep(0.02)
    raise AssertionError("the run never started its process")


def test_stop_kills_the_process_and_a_second_run_is_refused_meanwhile(shop):
    apply(shop, chain())
    thread, answer = start_in_background(shop)
    handle = wait_for_process(shop)
    # One run per project: a second press is 409 with the sentence.
    second = client.post(f"/api/projects/{shop}/reasoning", json={})
    assert second.status_code == 409 and second.json()["detail"] == "A run is already going."
    # The app stays usable: the model can be edited meanwhile.
    edited = client.post(f"/api/projects/{shop}/documents/model/commands",
                         json={"command": "CreateClass", "args": {"label": "Invoice"}})
    assert edited.status_code == 200, edited.text
    assert client.delete(f"/api/projects/{shop}/reasoning").json() == {"stopped": True}
    thread.join(timeout=10)
    assert not thread.is_alive()
    # Not a timing budget (Section 10): the process is gone once the run
    # Stop ended has returned.
    assert handle.process.is_alive() is False
    assert answer["status"] == 200 and answer["body"]["status"] == "stopped"
    assert answer["body"]["sentence"] == "Stopped. Nothing was concluded."
    assert client.delete(f"/api/projects/{shop}/reasoning").json() == {"stopped": False}
    apply(shop, SHOP)
    assert reason(shop)["status"] == "done"


def test_a_run_past_the_time_limit_is_killed_with_its_sentence(shop, monkeypatch):
    apply(shop, chain())
    monkeypatch.setattr(reasoning, "TIME_LIMIT_SECONDS", 1.5)
    started = time.monotonic()
    result = reason(shop)
    assert time.monotonic() - started < 10
    assert result["status"] == "timedOut"
    assert result["sentence"] == "Stopped after 30 seconds. Try without the data snapshots, or with fewer imports."
    assert not reasoning.service.running(shop)


def test_the_time_limit_and_the_ceiling_are_fixed_not_settings():
    import inspect

    assert reasoning.TIME_LIMIT_SECONDS == 30.0 and reasoning.MAX_STATEMENTS == 200_000
    source = inspect.getsource(reasoning)
    assert "os.environ" not in source and "getenv(" not in source


def test_a_set_over_the_ceiling_is_refused_before_any_process_starts(shop, monkeypatch):
    monkeypatch.setattr(reasoning, "MAX_STATEMENTS", 10)
    started = []
    monkeypatch.setattr(reasoning, "reason", lambda *a, **k: started.append(a))
    result = reason(shop)
    count = len(Graph().parse(data=SHOP, format="turtle"))
    assert result["status"] == "tooLarge" and started == [] and result["statements"] == count
    assert result["sentence"] == (
        f"This project has {count:,} statements to reason over. Semantic Studio reasons over at most "
        "10: try without the data snapshots, or with fewer imports."
    )


def test_a_worker_that_fails_says_so_in_a_sentence_and_the_app_carries_on(shop):
    raw = reasoning.reason("this is not N-Triples\n", "", [])
    assert raw.status == "failed" and raw.message
    outcome = reasoning.Outcome("failed", reasoning.Key(1, 0, False, False), message=raw.message)
    assert outcome.sentence() == f"The reasoner stopped with an error: {raw.message}"
    assert reason(shop)["status"] == "done"


# --- what goes stale, and what a run never touches (5.3, AC-6) --------------------------------


def inferred_edges(pid: str, imports: bool = False) -> list:
    tree = client.get(
        f"/api/ontologies/{pid}-model/hierarchy", params={"inferred": True, "imports": imports},
    ).json()
    return [
        (parent, ref["id"]) for key in ("classes", "examples") if key in tree
        for parent, kids in tree[key]["children"].items() for ref in kids if ref["origin"] == "inferred"
    ]


def is_stale(pid: str, **params) -> bool:
    return client.get(f"/api/projects/{pid}/reasoning", params=params).json()["stale"]


def create_class(pid: str) -> None:
    response = client.post(f"/api/projects/{pid}/documents/model/commands",
                           json={"command": "CreateClass", "args": {"label": "Invoice"}})
    assert response.status_code == 200, response.text


def test_any_change_makes_the_result_stale_and_its_marks_go(shop):
    reason(shop)
    assert not is_stale(shop) and inferred_edges(shop)
    create_class(shop)
    assert is_stale(shop) and inferred_edges(shop) == []
    reason(shop)
    assert not is_stale(shop)
    assert client.post(f"/api/projects/{shop}/documents/model/undo").status_code == 200
    assert is_stale(shop) and inferred_edges(shop) == []
    # The imports switch: a result reasoned without them is stale for a view
    # with them.
    reason(shop)
    assert is_stale(shop, imports=True) and inferred_edges(shop, imports=True) == []
    assert not is_stale(shop, imports=False)
    # A snapshot switched off.
    sid = employees(shop, 1, "one.csv")["snapshot"]["id"]
    reason(shop)
    assert not is_stale(shop)
    assert client.patch(f"/api/projects/{shop}/data/{sid}", json={"enabled": False}).status_code == 200
    assert is_stale(shop) and inferred_edges(shop) == []
    # The panel's result stays readable while stale; the close drops it.
    assert client.get(f"/api/projects/{shop}/reasoning").json()["status"] == "done"
    assert client.post(f"/api/projects/{shop}/close", json={"discard": True}).status_code == 200
    assert reasoning.service.result(shop) is None


def test_a_run_finishing_after_a_change_is_stale_when_it_lands(shop, monkeypatch):
    real = reasoning.reason

    def edit_meanwhile(*args, **kwargs):
        create_class(shop)
        return real(*args, **kwargs)

    monkeypatch.setattr(reasoning, "reason", edit_meanwhile)
    result = reason(shop)
    assert result["status"] == "done" and result["stale"] is True
    assert inferred_edges(shop) == []


def test_a_run_changes_nothing_in_the_file_the_revision_the_dirty_flag_or_the_undo_history(shop):
    assert client.post(f"/api/projects/{shop}/documents/model/save", json={}).status_code == 200
    employees(shop)
    document = editing_service.document(shop, "model")

    def state():
        return (
            document.path.read_bytes(), document.ontology.revision, document.dirty,
            list(document.undo), list(document.redo), set(document.graph),
        )

    before = state()
    reason(shop)
    reason(shop, includeData=True)
    assert state() == before


# --- the budgets of Section 10 (median of five, D-024) ---------------------------------------


def median_ms(action, samples: int = 5) -> float:
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


@pytest.mark.perf
def test_reasoning_over_the_small_template_budget():
    pid = create()
    median = median_ms(lambda: reason(pid))
    assert median <= limit_ms(1000), f"reasoning over the Small template took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_reasoning_over_two_full_snapshots_budget(two_snapshots):
    median = median_ms(lambda: reason(two_snapshots, includeData=True))
    assert median <= limit_ms(8000), f"reasoning over two full snapshots took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_the_probe_run_on_a_sixty_class_model_budget():
    model = Graph().parse(data=SNAPSHOT_MODEL + ROBOT.replace(PREFIXES, ""), format="turtle")
    classes = sorted(str(c) for c in model.subjects(RDF.type, OWL.Class) if isinstance(c, URIRef))
    assert len(classes) >= 60
    nt = model.serialize(format="nt")
    times = sorted(reasoning.reason(nt, "", classes).probe_ms for _ in range(5))
    assert times[2] <= limit_ms(500), f"the probe run took {times[2]:.0f} ms (median of 5)"


@pytest.mark.perf
def test_filter_group_and_explain_six_thousand_conclusions_budget(two_snapshots):
    reason(two_snapshots, includeData=True)
    outcome = reasoning.service.result(two_snapshots)
    stated = list(outcome.stated.all)
    raw = reasoning.RawResult("done", added=[t for t in outcome.closure.all if t not in outcome.stated])
    counted = []

    def work():
        result = reasoning.analyse(stated, raw, key=outcome.key, languages=["en"], probes=[])
        explainer = reasoning.Explainer(result.stated, result.closure, result.names)
        facts = [fact["t"] for kind in reasoning.GROUPS for fact in result.facts[kind]]
        for t in facts:
            explainer.explain(t)
        counted.append(len(facts))

    median = median_ms(work)
    assert min(counted) >= 6000
    assert median <= limit_ms(300), f"filtering, grouping and explaining took {median:.0f} ms (median of 5)"
