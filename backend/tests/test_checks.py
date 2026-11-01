"""
================================================================================
FILE: backend/tests/test_checks.py
================================================================================

SUMMARY
    The design checks (design-checks Stage A, D-124): every check reports
    exactly its planted finding in design-faults.ttl and nothing in
    design-clean.ttl (AC-3); the bundled examples report no Problem and FOAF
    no standard term (AC-4, AC-5); every file matches its pin and passes
    prepare_select, and the report runs every query through it (AC-6); true
    totals past 1,000 rows and a timed-out check beside the others (AC-7);
    the revision and generation in the answer (AC-8); DC-26 only with a
    namespace, DC-27's two levels, DC-28 (AC-9); every Avoid row of 5.1
    reported with its reason (AC-17); the routes; and Section 10's budgets.

BASIC IDEA
    Most tests call checks.run on a parsed graph, through a stand-in for a
    store entry, so a planted case is read without a load; the route tests
    go through the HTTP surface as every other test here does. A few
    planted cases are two checks' finding by nature (an individual inside
    the ontology's namespace is off the data pattern too; a term at an
    editor's default address is outside the namespace too): EXPECTED names
    each check's findings exactly, so a check that starts to report
    something else, or stops, fails.

    The scan for a second standard-vocabulary list reads app/ as text, after
    asserting it read the files.

INPUTS / INPUT SOURCES
    - tests/fixtures/design-faults.ttl and design-clean.ttl (rdf-fixture).
    - app/examples/*.ttl and app/vocab/foaf.rdf, qudt-3.5.2.ttl.
    - frontend/src/naming/address.table.json (the Avoid rows).

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

import contextlib
import gc
import hashlib
import json
import re
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph

from app import checks, settings, sparql_exec
from app.editing import editing_service
from app.main import app

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

HERE = Path(__file__).resolve().parent
APP = HERE.parent / "app"
FIXTURES = HERE / "fixtures"
TABLE = json.loads((HERE.parent.parent / "frontend" / "src" / "naming" / "address.table.json").read_text(encoding="utf-8"))

T = "https://w3id.org/acme/domain/test/faults-ontology"
D = "https://w3id.org/acme/data/test/"


def entry(graph: Graph, oid: str = "test") -> object:
    """A stand-in for a store entry: what checks.run reads of one."""
    return types.SimpleNamespace(
        id=oid, revision=0, ensure_loaded=lambda: graph, reading=contextlib.nullcontext, snapshots=None,
    )


def parse(path: Path) -> Graph:
    return Graph().parse(path, format="xml" if path.suffix == ".rdf" else "turtle")


def run(graph: Graph, **kwargs) -> dict:
    return checks.run(entry(graph), **kwargs)


def by_id(report: dict) -> dict:
    return {g["id"]: g for g in report["groups"]}


def findings(report: dict) -> dict:
    return {g["id"]: [(f["iri"], f["sentence"]) for f in g["findings"]] for g in report["groups"]}


# --- AC-3: one planted case per check -------------------------------------------

EXPECTED = {
    "DC-01": [(f"{T}#Lander", "Lander has no English label.")],
    "DC-02": [(f"{T}#Orbiting", "Orbiting has two preferred labels in English.")],
    "DC-03": [(f"{T}#Rover", "Rover has a note but no definition.")],
    "DC-04": [(f"{T}#robotic_vehicle", "The class robotic_vehicle is named robotic_vehicle; class names read RoboticVehicle.")],
    "DC-05": [(f"{T}#Launched_On", "The attribute Launched_On is named Launched_On; attribute names read launchedOn.")],
    "DC-06": [(f"{T}#Site2026", "Site2026 has a date in its name.")],
    "DC-07": [(f"{T}#LaunchPad", "LaunchPad's label reads LaunchPad. Write it for people: Launch pad.")],
    "DC-08": [(T, "The ontology has no creator.")],
    "DC-09": [(T, "The version IRI ends in 1.0.0 but the version is 1.1.0.")],
    "DC-10": [(f"{T}#Probe", "Probe is deprecated and names no replacement.")],
    "DC-11": [(f"{T}#Capsule", "Capsule is deprecated but Capsule one is still one.")],
    "DC-12": [(f"{T}#LoopA", "Loop a, Loop b and Loop a are in a loop.")],
    "DC-13": [(f"{T}#Level5", "Level five is 5 levels below the top.")],
    "DC-14": [(f"{T}#LanderMission", "Lander mission is under two broader concepts.")],
    "DC-15": [(f"{T}#Flyby", "Flyby is both related to and under Exploration.")],
    "DC-16": [(f"{T}#Stranded", "Stranded is in no concept scheme.")],
    "DC-17": [(f"{T}#Crew", "Two terms are called Crew: Crew and hasCrew.")],
    "DC-18": [(f"{T}#Person", "Person matches Person in FOAF.")],
    "DC-19": [(f"{D}mission/m2", "Mission two's launch time has no time zone.")],
    "DC-20": [(f"{D}lander/l1", 'Lander one\'s diameter is written as the text "6779 km".')],
    "DC-21": [(T, "This ontology imports unit-ontology.")],
    "DC-22": [(f"{D}person/bea", "Bea is declared the same as Ann.")],
    "DC-23": [(f"{T}#MissionType", "Mission type is both a class and a concept.")],
    "DC-24": [(f"{T}#apollo11", "Apollo 11 lives in the ontology's namespace.")],
    "DC-25": [(f"{T}#Spaceport", "Spaceport is never used by any individual.")],
    "DC-26": [
        (f"{D}robotic-mission/m3", "Mission three is at data/…/robotic-mission/ but its most general class is mission."),
        # Two checks' finding by nature: DC-24's individual and DC-27's term.
        (f"{T}#apollo11", "Apollo 11 is not at data/<data-domain>/<class>/<id>."),
        ("http://www.semanticweb.org/learner/ontologies/x#Stray", "Stray is not under https://w3id.org/acme/."),
    ],
    "DC-27": [(
        "http://www.semanticweb.org/learner/ontologies/x#Stray",
        "Terms under http://www.semanticweb.org/learner/ontologies/x# use an editor's default address.",
    )],
    "DC-28": [("https://w3id.org/acme/data/test-v2/mission/m9", "Mission nine's address has a version in its path (test-v2).")],
}


@pytest.fixture(scope="module")
def faults() -> dict:
    return run(parse(FIXTURES / "design-faults.ttl"), namespace="acme")


def test_the_catalogue_has_the_28_checks():
    assert [e["id"] for e in checks.manifest()] == [f"DC-{n:02d}" for n in range(1, 29)]
    assert set(EXPECTED) == {e["id"] for e in checks.manifest()}


@pytest.mark.parametrize("cid", sorted(EXPECTED))
def test_ac3_each_check_reports_exactly_its_planted_finding(faults, cid):
    group = by_id(faults)[cid]
    assert "error" not in group
    assert [(f["iri"], f["sentence"]) for f in group["findings"]] == EXPECTED[cid]
    assert group["total"] == len(EXPECTED[cid])


def test_ac3_the_clean_fixture_trips_nothing():
    report = run(parse(FIXTURES / "design-clean.ttl"), namespace="acme")
    assert len(report["groups"]) == 28
    assert {g["id"]: g["total"] for g in report["groups"] if g["total"]} == {}
    assert report["measures"]["level"]["step"] == 6


def test_every_finding_says_where_it_leads_and_the_fix(faults):
    groups = by_id(faults)
    assert groups["DC-01"]["findings"][0]["block"] == "label"
    assert groups["DC-03"]["findings"][0]["block"] == "definition"
    assert groups["DC-08"]["findings"][0]["block"] == "header"
    assert all(g["fix"] and g["heading"] for g in faults["groups"])


def test_the_levels_and_the_notes(faults):
    groups = by_id(faults)
    assert groups["DC-01"]["level"] == "Problem" and groups["DC-07"]["level"] == "Worth a look"
    assert "Imported terms are not checked." in faults["notes"]
    assert "These checks run on this computer." in faults["notes"]


# --- AC-4, AC-5: the bundled examples and borrowed terms ----------------------------


@pytest.mark.parametrize("name", ["space-exploration.ttl", "middle-earth.ttl"])
def test_ac4_the_examples_report_no_problem(name):
    report = run(parse(APP / "examples" / name))
    problems = {g["id"]: g["findings"][:2] for g in report["groups"] if g["total"] and g["level"] == "Problem"}
    assert problems == {}


def test_ac4_foaf_reports_its_unlabelled_terms_and_no_standard_term():
    """design-checks 11 says 7 terms without a label: the bundled foaf.rdf
    labels every FOAF term, and the three it reports are the vs: and wot:
    annotation properties the file declares (a spec number the file does
    not bear out, said in the build report)."""
    report = run(parse(APP / "vocab" / "foaf.rdf"))
    dc01 = by_id(report)["DC-01"]
    assert sorted(f["iri"] for f in dc01["findings"]) == [
        "http://www.w3.org/2003/06/sw-vocab-status/ns#term_status",
        "http://xmlns.com/wot/0.1/assurance",
        "http://xmlns.com/wot/0.1/src_assurance",
    ]
    w3c = re.compile(r"^http://www\.w3\.org/(1999/02/22-rdf-syntax-ns|2000/01/rdf-schema|2002/07/owl|2004/02/skos/core)#")
    for group in report["groups"]:
        for found in group["findings"]:
            assert not (found["iri"] and w3c.match(found["iri"])), (group["id"], found)


def test_foaf_owns_its_namespace_but_another_document_does_not():
    foaf = parse(APP / "vocab" / "foaf.rdf")
    assert "http://xmlns.com/foaf/0.1/" in checks.owned_namespaces(foaf)
    assert checks.owned_namespaces(parse(APP / "examples" / "space-exploration.ttl")) == frozenset()


def test_ac5_borrowed_terms_a_document_declares_are_never_reported():
    graph = Graph().parse(data="""
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
        @prefix geo: <http://www.opengis.net/ont/geosparql#> .
        @prefix ex: <http://example.org/a#> .
        <http://example.org/a> a owl:Ontology .
        geo:Feature a owl:Class .
        geo:hasGeometry a owl:ObjectProperty .
        skos:Concept a owl:Class .
        geo:sfWithin a owl:ObjectProperty .
        ex:Mine a owl:Class .
    """, format="turtle")
    report = run(graph)
    reported = {f["iri"] for g in report["groups"] for f in g["findings"]}
    assert "http://example.org/a#Mine" in reported  # the check did run
    assert not any(i and i.startswith(("http://www.opengis.net/", "http://www.w3.org/2004/02/skos/")) for i in reported)


def test_a_project_owns_only_what_is_under_its_base():
    graph = parse(FIXTURES / "design-faults.ttl")
    report = run(graph, project={"baseIri": f"{T}#"}, namespace="acme")
    stray = "http://www.semanticweb.org/learner/ontologies/x#Stray"
    assert not any(f["iri"] == stray for g in report["groups"] for f in g["findings"] if g["id"] != "DC-26")


def test_a_pattern_project_owns_its_data_and_shapes_bases_too():
    """A Small project made under the pattern keeps Alice and Acme at its
    data base: they are its own individuals (found in the browser, where
    the first build counted none)."""
    graph = parse(FIXTURES / "design-faults.ttl")
    model_only = run(graph, project={"baseIri": f"{T}#"})
    with_data = run(graph, project={"baseIri": f"{T}#", "dataBaseIri": D})
    # Only apollo11, which lives under the model's base (DC-24's case).
    assert model_only["measures"]["counts"]["individuals"] == 1
    assert with_data["measures"]["counts"]["individuals"] > 10
    assert by_id(with_data)["DC-19"]["total"] == 1


def test_the_standard_list_lives_in_checks_py_alone():
    scanned = [p for p in APP.rglob("*.py") if "__pycache__" not in p.parts]
    assert len(scanned) > 40  # the scan found the source tree
    rare = [ns for ns in checks.STANDARD_NAMESPACES if not ns.startswith("http://www.w3.org/")]
    copies = [
        p.name for p in scanned
        if p.name != "checks.py" and sum(ns in p.read_text(encoding="utf-8") for ns in rare) >= 3
    ]
    assert copies == []
    queries = list((APP / "checks").glob("*.rq"))
    assert len(queries) == 28
    for path in queries:
        text = path.read_text(encoding="utf-8")
        assert not any(ns in text for ns in rare if ns not in ("http://purl.org/dc/terms/", "http://purl.org/dc/elements/1.1/")), path.name


# --- AC-6: pinned, SELECT, through prepare_select -----------------------------------


def test_ac6_every_file_matches_its_pin_and_every_entry_has_a_file():
    listed = json.loads((APP / "checks" / "manifest.json").read_text(encoding="utf-8"))["checks"]
    files = sorted(p.name for p in (APP / "checks").glob("*.rq"))
    assert sorted(e["file"] for e in listed) == files
    for e in listed:
        assert hashlib.sha256((APP / "checks" / e["file"]).read_bytes()).hexdigest() == e["sha256"], e["file"]


def test_ac6_every_query_is_a_select_prepare_select_accepts():
    for e in checks.manifest():
        prepared = sparql_exec.prepare_select(e["query"])
        assert prepared.algebra.name == "SelectQuery", e["id"]


def test_a_changed_file_is_refused_never_run(monkeypatch):
    real = json.loads(checks.MANIFEST_PATH.read_text(encoding="utf-8"))
    real["checks"][0]["sha256"] = "0" * 64
    tampered = checks.MANIFEST_PATH.parent / "_tampered.json"
    monkeypatch.setattr(checks, "MANIFEST_PATH", tampered)
    monkeypatch.setattr(checks, "_catalogue", None)
    tampered.write_text(json.dumps(real), encoding="utf-8")
    try:
        with pytest.raises(checks.CheckFileChanged):
            checks.manifest()
    finally:
        tampered.unlink()


def test_the_report_runs_every_query_through_the_gate(monkeypatch):
    seen = []
    real = sparql_exec._prepare

    def spy(query):
        seen.append(query)
        return real(query)

    monkeypatch.setattr(sparql_exec, "_prepare", spy)
    monkeypatch.setattr(sparql_exec, "_prepared_cache", {})
    run(parse(FIXTURES / "design-clean.ttl"), namespace="acme")
    # Every check but DC-13, whose depth is counted in Python (5.5.3).
    assert sorted(seen) == sorted(e["query"] for e in checks.manifest() if e["id"] != "DC-13")


def test_ac6_open_as_a_query_is_exactly_the_file():
    response = client.get("/api/checks")
    assert response.status_code == 200
    listed = response.json()
    assert len(listed) == 28
    for item in listed:
        assert item["query"] == (APP / "checks" / f"{item['id']}.rq").read_text(encoding="utf-8")
        assert set(item) == {"id", "level", "heading", "fix", "query"}


def test_the_same_query_gives_the_same_rows_in_query():
    """Opened in Query there is no run: ss:own works its rule out from the
    graph, so the rows match the report's."""
    graph = parse(APP / "vocab" / "foaf.rdf")
    dc01 = next(e for e in checks.manifest() if e["id"] == "DC-01")
    rows = sparql_exec.execute_select(graph, dc01["query"])["rows"]
    assert sorted(r[0]["value"] for r in rows) == sorted(f["iri"] for f in by_id(run(graph))["DC-01"]["findings"])


# --- AC-7: totals and a check that times out --------------------------------------


def test_ac7_the_true_total_past_1000_rows():
    lines = ["@prefix owl: <http://www.w3.org/2002/07/owl#> ."] + [
        f"<http://example.org/many#C{i}> a owl:Class ." for i in range(1500)
    ]
    report = run(Graph().parse(data="\n".join(lines), format="turtle"))
    dc01 = by_id(report)["DC-01"]
    assert dc01["total"] == 1500
    assert len(dc01["findings"]) == checks.SHOWN == 100


def test_ac7_a_check_that_times_out_leaves_the_others(monkeypatch):
    real = sparql_exec.execute_select
    dc03 = next(e for e in checks.manifest() if e["id"] == "DC-03")["query"]

    def slow(graph, query, **kwargs):
        if query == dc03:
            raise sparql_exec.QueryTimeout("too slow")
        return real(graph, query, **kwargs)

    monkeypatch.setattr(sparql_exec, "execute_select", slow)
    report = run(parse(FIXTURES / "design-faults.ttl"), namespace="acme")
    groups = by_id(report)
    assert groups["DC-03"]["error"] == "This check did not finish in 30 seconds."
    assert groups["DC-01"]["total"] == 1 and "error" not in groups["DC-01"]


def test_a_real_timeout_is_said_in_its_group():
    lines = ["@prefix owl: <http://www.w3.org/2002/07/owl#> ."] + [
        f"<http://example.org/many#C{i}> a owl:Class ; <http://example.org/p> \"{i} km\" ." for i in range(3000)
    ]
    report = checks.run(entry(Graph().parse(data="\n".join(lines), format="turtle"), "slow"), timeout=0.001)
    assert any(g.get("error") == checks.TIMED_OUT for g in report["groups"])


# --- AC-9: DC-26, DC-27, DC-28 ------------------------------------------------------


def test_ac9_dc26_only_with_a_namespace():
    graph = parse(FIXTURES / "design-faults.ttl")
    assert "DC-26" not in by_id(run(graph))
    assert "DC-26" in by_id(run(graph, namespace="acme"))


@pytest.mark.parametrize(
    "ontology, sentence",
    [
        ("https://w3id.org/acme/domain/finance/invoices", "The ontology's address does not end in -ontology, -taxonomy, -vocabulary, -shapes or -mapping."),
        ("https://w3id.org/acme/finance/invoice-ontology", "The ontology is not under core/, domain/<domain>/ or app/<application>/."),
        ("http://example.org/invoice-ontology", "The ontology is not under https://w3id.org/acme/."),
    ],
)
def test_ac9_dc26_the_artifact_sentences(ontology, sentence):
    graph = Graph().parse(data=f"<{ontology}> a <http://www.w3.org/2002/07/owl#Ontology> .", format="turtle")
    assert sentence in [s for _, s in findings(run(graph, namespace="acme"))["DC-26"]]


def test_ac9_dc26_a_term_not_under_the_ontology():
    graph = Graph().parse(data="""
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        <https://w3id.org/acme/core/unit-ontology> a owl:Ontology .
        <https://w3id.org/acme/core/other-ontology#Lander> a owl:Class ; rdfs:label "Lander"@en .
    """, format="turtle")
    assert ("https://w3id.org/acme/core/other-ontology#Lander", "Lander is not under the ontology's address followed by #.") in findings(run(graph, namespace="acme"))["DC-26"]


def test_ac9_dc27_two_levels():
    example = Graph().parse(data="<http://example.org/x> a <http://www.w3.org/2002/07/owl#Ontology> .", format="turtle")
    group = by_id(run(example))["DC-27"]
    assert group["level"] == "Worth a look"
    assert group["findings"][0]["sentence"] == "The ontology uses an example address (example.org)."
    editor = Graph().parse(data="<http://www.semanticweb.org/ann/ontologies/2026/1/untitled> a <http://www.w3.org/2002/07/owl#Ontology> .", format="turtle")
    group = by_id(run(editor))["DC-27"]
    assert group["level"] == "Problem"
    assert group["findings"][0]["sentence"] == "The ontology uses an editor's default address."


def test_ac9_dc28_capitals_underscores_and_versions():
    graph = Graph().parse(data="<https://w3id.org/acme/domain/Fin_ance/invoice-v2-ontology> a <http://www.w3.org/2002/07/owl#Ontology> .", format="turtle")
    assert [s for _, s in findings(run(graph))["DC-28"]] == [
        "The ontology's address has a capital letter in its path (Fin_ance).",
        "The ontology's address has an underscore in its path (Fin_ance).",
        "The ontology's address has a version in its path (invoice-v2-ontology).",
    ]


def test_dc24_is_a_problem_in_a_project_made_under_the_pattern(faults):
    graph = parse(FIXTURES / "design-faults.ttl")
    assert by_id(faults)["DC-24"]["level"] == "Worth a look"
    report = run(graph, project={"baseIri": f"{T}#", "dataBaseIri": D}, namespace="acme")
    assert by_id(report)["DC-24"]["level"] == "Problem"


# --- AC-17: every Avoid row of 5.1 -------------------------------------------------

ONT = "https://w3id.org/acme/domain/finance/invoice-ontology"
REPORTED_BY = {"name:DC-06": "DC-06", "name:DC-04": "DC-04", "layer": "DC-26", "type": "DC-26", "data": "DC-26", "class": "DC-26"}


def _avoid_graph(row: dict) -> Graph:
    head = (
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
    )
    address = row["address"]
    if row["role"] == "artifact":
        return Graph().parse(data=head + f"<{address}> a owl:Ontology .", format="turtle")
    body = f"<{ONT}> a owl:Ontology .\n<{ONT}#Invoice> a owl:Class ; rdfs:label \"Invoice\"@en .\n"
    if row["role"] == "term":
        body += f"<{address}> a owl:Class ; rdfs:label \"Some term\"@en .\n"
    else:
        body += f"<{ONT}#OverdueInvoice> a owl:Class ; rdfs:subClassOf <{ONT}#Invoice> ; rdfs:label \"Overdue invoice\"@en .\n"
        typed = f"{ONT}#OverdueInvoice" if row.get("generalClass") else f"{ONT}#Invoice"
        body += f"<{address}> a <{typed}> ; rdfs:label \"INV/10442\"@en .\n"
    return Graph().parse(data=head + body, format="turtle")


@pytest.mark.parametrize("row", TABLE["avoid"], ids=lambda r: r["address"].split("acme/")[1])
def test_ac17_every_avoid_row_is_reported_with_its_reason(row):
    report = findings(run(_avoid_graph(row), namespace="acme"))
    address = row["address"].rstrip("#")
    if row["reported"] == "none":
        # One language in addresses (FactureClient): no check of a name or
        # an address can tell a name's language without a dictionary. Said
        # in the build report.
        naming_checks = ("DC-04", "DC-05", "DC-06", "DC-24", "DC-26", "DC-28")
        assert not any(i == address for cid in naming_checks for i, _ in report.get(cid, []))
        return
    cid = REPORTED_BY[row["reported"]]
    assert any(i == address for i, _ in report[cid]), (cid, report)
    if row["role"] == "data" and "#" in address:
        assert any(i == address for i, _ in report["DC-24"])


# --- AC-8 and the routes -----------------------------------------------------------


def _upload(path: Path) -> str:
    response = client.post("/api/ontologies/upload", files={"file": (path.name, path.read_bytes(), "text/turtle")})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_the_route_answers_the_report():
    oid = _upload(FIXTURES / "design-clean.ttl")
    response = client.get(f"/api/ontologies/{oid}/checks")
    assert response.status_code == 200
    body = response.json()
    assert set(body) >= {"revision", "generation", "ran_ms", "measures", "groups"}
    assert body["revision"] == 0 and body["generation"] == 0
    assert all(set(g) >= {"id", "level", "heading", "fix", "total", "findings"} for g in body["groups"])


def test_the_route_reads_the_namespace_at_each_run():
    oid = _upload(FIXTURES / "design-clean.ttl")
    assert "DC-26" not in {g["id"] for g in client.get(f"/api/ontologies/{oid}/checks").json()["groups"]}
    settings.update_naming("acme")
    try:
        body = client.get(f"/api/ontologies/{oid}/checks").json()
    finally:
        settings.update_naming(None)
    assert body["namespace"] == "acme"
    assert "DC-26" in {g["id"] for g in body["groups"]}


@pytest.mark.parametrize("path", [
    "/api/ontologies/no-such-id/checks",
    "/api/ontologies/prj-000000000000-model/checks",
    "/api/ontologies/prj-000000000000/checks?doc=model",
    "/api/ontologies/..%2F..%2Fsecret/checks?doc=model",
])
def test_an_id_not_issued_is_404(path):
    assert client.get(path).status_code == 404


def test_the_doc_form_matches_the_project_id_before_the_store_is_asked(monkeypatch):
    from app.routers import checks as checks_router
    asked = []
    real = checks_router.store.get
    monkeypatch.setattr(checks_router.store, "get", lambda oid: asked.append(oid) or real(oid))
    for bad in ("..%2Fsecret", "prj-xyz", "prj-000000000000%0A"):
        assert client.get(f"/api/ontologies/{bad}/checks?doc=model").status_code == 404
    assert asked == []


@pytest.fixture
def project():
    response = client.post("/api/projects", json={"name": "Shop", "template": "small", "baseIri": "http://example.org/shop#", "prefix": "shop"})
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    yield pid
    editing_service.close_all()


def test_ac8_the_revision_moves_with_an_edit(project):
    before = client.get(f"/api/ontologies/{project}/checks", params={"doc": "model"}).json()
    response = client.post(f"/api/projects/{project}/documents/model/commands", json={"command": "CreateClass", "args": {"label": "Ship"}})
    assert response.status_code == 200, response.text
    after = client.get(f"/api/ontologies/{project}-model/checks").json()
    assert after["revision"] == before["revision"] + 1


def test_a_shapes_document_runs_three_checks(project):
    body = client.get(f"/api/ontologies/{project}-shapes/checks").json()
    assert [g["id"] for g in body["groups"]] == ["DC-01", "DC-03", "DC-08"]
    assert len(body["skipped"]) == 25
    assert checks.SHAPES_NOTE in body["notes"]


def test_an_empty_document_says_there_is_nothing_to_check():
    graph = Graph().parse(data="<http://example.org/e> a <http://www.w3.org/2002/07/owl#Ontology> .", format="turtle")
    report = run(graph)
    assert report["empty"] is True and report["emptySentence"] == "Nothing to check yet: add a class or a concept."


def test_the_report_changes_nothing(project):
    doc = editing_service.document(project, "model")
    before = (doc.ontology.revision, len(doc.graph))
    client.get(f"/api/ontologies/{project}-model/checks")
    assert (doc.ontology.revision, len(doc.graph)) == before


# --- Section 10: budgets, and AC-12a: the cap ---------------------------------------


def _median_ms(action, samples: int = 5) -> float:
    action()  # warm: the parsed queries and the reference index
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


def _dense_graph(individuals: int) -> Graph:
    """A model-and-data document, worst case for DC-19 and DC-20: every
    individual carries a date-time and a number-as-text, which those two
    scan on every statement. The size is set by the number of individuals."""
    b, d = "http://example.org/o#", "http://example.org/d/"
    lines = [
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
        "<http://example.org/o> a owl:Ontology .",
    ]
    for c in range(40):
        parent = f" ; rdfs:subClassOf <{b}C{c // 8}>" if c % 8 else ""
        lines.append(f'<{b}C{c}> a owl:Class ; rdfs:label "Class {c}"@en ; rdfs:comment "d"@en{parent} .')
    for p in range(20):
        lines.append(f'<{b}p{p}> a owl:DatatypeProperty ; rdfs:label "p{p}"@en ; rdfs:comment "d"@en .')
    for i in range(individuals):
        lines.append(
            f'<{d}i{i}> a <{b}C{i % 40}> ; rdfs:label "Item {i}"@en ; '
            f'<{b}p{i % 20}> "2026-01-01T10:00:00"^^xsd:dateTime ; '
            f'<{b}p{(i + 1) % 20}> "6779 km" ; <{b}p{(i + 2) % 20}> "plain text value" .'
        )
    return Graph().parse(data="\n".join(lines), format="turtle")


# design-checks 10 (v1.1, D-125). The report runs only on documents at or
# under CHECKS_MAX_STATEMENTS, and the budget holds there. Space Exploration
# (833 statements) runs every check well inside 500 ms. The worst case under
# the cap -- 9,966 statements, every individual with a date-time and a
# number-as-text -- runs in about 1.9 s, inside 3 s. QUDT (132,166 statements)
# is over the cap and runs no query at all; test_ac12a_over_the_cap, a count,
# proves it. So neither budget is a measured number the spec did not ask for:
# both are the spec's, now met because the input is bounded.
SPACE_LIMIT_MS = 500
UNDER_CAP_LIMIT_MS = 3_000


@pytest.mark.perf
def test_budget_space_exploration():
    graph = parse(APP / "examples" / "space-exploration.ttl")
    assert _median_ms(lambda: run(graph)) <= limit_ms(SPACE_LIMIT_MS)


@pytest.mark.perf
def test_budget_the_largest_document_under_the_cap():
    graph = _dense_graph(1_950)
    # Genuinely near the top of what the report runs on.
    assert checks.CHECKS_MAX_STATEMENTS - 500 < len(graph) <= checks.CHECKS_MAX_STATEMENTS
    assert _median_ms(lambda: run(graph)) <= limit_ms(UNDER_CAP_LIMIT_MS)


def test_ac12a_over_the_cap(monkeypatch):
    """The count-based QUDT test: QUDT has more statements than the cap, so
    the report runs no query (a count, not a timing: it stays in the blocking
    job), names both numbers, measures nothing, and still lists every check so
    each is offered as a query."""
    graph = parse(APP / "vocab" / "qudt-3.5.2.ttl")
    assert len(graph) > checks.CHECKS_MAX_STATEMENTS
    ran = []
    real = sparql_exec.execute_select
    monkeypatch.setattr(sparql_exec, "execute_select", lambda *a, **k: ran.append(1) or real(*a, **k))
    report = run(graph, namespace="acme")
    assert ran == []
    assert report["overCap"] == {"statements": len(graph), "cap": checks.CHECKS_MAX_STATEMENTS}
    assert report["measures"] is None
    assert report["empty"] is False
    assert [g["id"] for g in report["groups"]] == [e["id"] for e in checks.manifest()]
    assert all(g["total"] == 0 and g["findings"] == [] for g in report["groups"])


def test_ac12a_a_document_under_the_cap_runs_every_check():
    report = run(parse(FIXTURES / "design-clean.ttl"), namespace="acme")
    assert "overCap" not in report
    assert report["measures"] is not None
    assert len(report["groups"]) == 28


def test_ac12a_the_route_answers_over_the_cap():
    data = "\n".join(
        f'<http://example.org/d/i{i}> a <http://example.org/o#C{i % 40}> . '
        for i in range(checks.CHECKS_MAX_STATEMENTS + 200)
    )
    response = client.post(
        "/api/ontologies/upload", files={"file": ("big.ttl", data.encode("utf-8"), "text/turtle")}
    )
    assert response.status_code == 200, response.text
    oid = response.json()["id"]
    body = client.get(f"/api/ontologies/{oid}/checks").json()
    assert body["overCap"]["cap"] == checks.CHECKS_MAX_STATEMENTS
    assert body["overCap"]["statements"] > checks.CHECKS_MAX_STATEMENTS
    assert body["measures"] is None
    assert len(body["groups"]) >= 27  # DC-26 only with a namespace set
