"""
================================================================================
FILE: backend/tests/test_links_between_files.py
================================================================================

SUMMARY
    Links between files, PR 1 (links-between-files 5.1 to 5.5, D-133): the
    grouped step, RenameIri across every project file, DeleteEntity's uses,
    Deprecate, and Turtle Apply's warning for a term other files still use.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, on a small project:
    Pump defined in core.ttl, used by equipment.ttl (Motor a kind of Pump,
    drives with range Pump) and by shapes.ttl (a shape targeting Pump). The
    service's state is read directly where the API has no window onto it.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; commands and inline Turtle
      (rdf-fixture: the smallest fixture that proves the point).

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-5, AC-10 and AC-11 as the server sees them.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdflib import Literal, URIRef
from rdflib.namespace import DCTERMS, OWL

from app.editing import editing_service, text_mentions, uses_phrase
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/plant#"
PUMP, PUMPE = URIRef(EX + "Pump"), URIRef(EX + "Pumpe")


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def run(pid, doc, command, dry_run=False, **args):
    body = {"command": command, "args": args}
    if dry_run:
        body["dryRun"] = True
    return client.post(f"/api/projects/{pid}/documents/{doc}/commands", json=body)


def ok(pid, doc, command, **args) -> dict:
    response = run(pid, doc, command, **args)
    assert response.status_code == 200, response.text
    return response.json()


def source(pid, doc) -> str:
    return client.get(f"/api/projects/{pid}/documents/{doc}/source").json()["text"]


def graph(pid, doc):
    return editing_service.document(pid, doc).graph


def mentions(g, iri) -> bool:
    return (iri, None, None) in g or (None, iri, None) in g or (None, None, iri) in g


@pytest.fixture
def linked():
    response = client.post("/api/projects", json={"name": "Plant", "template": "empty", "baseIri": EX, "prefix": "plant"})
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    docs = []
    for name in ("core", "equipment"):
        made = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": name, "folder": ""})
        assert made.status_code == 200, made.text
        docs.append(made.json()["entry"]["id"])
    core, equipment = docs
    ok(pid, core, "CreateClass", label="Pump")
    ok(pid, equipment, "CreateClass", label="Motor")
    ok(pid, equipment, "AddSubClassOf", child=EX + "Motor", parent=EX + "Pump")
    ok(pid, equipment, "CreateObjectProperty", label="drives", domain=EX + "Motor", range=EX + "Pump")
    ok(pid, "shapes", "CreateShape", target=EX + "Pump")
    return pid, core, equipment


def test_ac1_rename_changes_every_file(linked):
    pid, core, equipment = linked
    result = ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    assert result["label"] == "Renamed plant:Pump to plant:Pumpe (also in equipment.ttl, shapes.ttl)"
    assert {d["doc"] for d in result["documents"]} == {core, equipment, "shapes"}
    for doc in (core, equipment, "shapes"):
        assert not mentions(graph(pid, doc), PUMP), doc
        assert mentions(graph(pid, doc), PUMPE), doc


def test_ac2_rename_one_undo_restores_every_file_and_redo(linked):
    pid, core, equipment = linked
    docs = (core, equipment, "shapes")
    before = {d: source(pid, d) for d in docs}
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    after = {d: source(pid, d) for d in docs}
    for asked in docs:
        assert client.post(f"/api/projects/{pid}/documents/{asked}/undo").status_code == 200
        assert {d: source(pid, d) for d in docs} == before, asked
        assert client.post(f"/api/projects/{pid}/documents/{asked}/redo").status_code == 200
        assert {d: source(pid, d) for d in docs} == after, asked


def test_ac3_undo_refused_while_a_member_is_not_on_top(linked):
    pid, core, equipment = linked
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    ok(pid, equipment, "CreateClass", label="Gear")
    revisions = {d.doc: d.ontology.revision for d in editing_service._open[pid].values()}
    refused = client.post(f"/api/projects/{pid}/documents/{core}/undo")
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Undo the later change in equipment.ttl first."
    assert {d.doc: d.ontology.revision for d in editing_service._open[pid].values()} == revisions


def test_ac4_rename_refused_outside_the_defining_file(linked):
    pid, core, equipment = linked
    revisions = {d.doc: d.ontology.revision for d in editing_service._open[pid].values()}
    refused = run(pid, equipment, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Pump is defined in core.ttl. Open that file to change it."
    assert {d.doc: d.ontology.revision for d in editing_service._open[pid].values()} == revisions


def test_ac5_dry_run_counts_uses_by_file(linked):
    pid, core, equipment = linked
    revisions = {d.doc: d.ontology.revision for d in editing_service._open[pid].values()}
    answer = run(pid, core, "RenameIri", dry_run=True, old=EX + "Pump", new=EX + "Pumpe").json()
    shapes_count = sum(1 for t in graph(pid, "shapes") if PUMP in t)
    assert answer["uses"] == [
        {"doc": equipment, "file": "equipment.ttl", "count": 2},
        {"doc": "shapes", "file": "shapes.ttl", "count": shapes_count},
    ]
    assert answer["queries"] == 0 and answer["snapshots"] == []
    assert {d.doc: d.ontology.revision for d in editing_service._open[pid].values()} == revisions


def test_ac8_delete_plan_lists_uses_and_ac9_delete_leaves_them(linked):
    pid, core, equipment = linked
    plan = run(pid, core, "DeleteEntity", dry_run=True, iri=EX + "Pump").json()["impact"]
    assert plan["importMentions"] == 0
    first = plan["uses"][0]
    assert first["file"] == "equipment.ttl" and first["count"] == 2
    assert [s["label"] for s in first["sample"]] == ["drives", "Motor"]
    others = {d: source(pid, d) for d in (equipment, "shapes")}
    ok(pid, core, "DeleteEntity", iri=EX + "Pump")
    assert not mentions(graph(pid, core), PUMP)
    assert {d: source(pid, d) for d in (equipment, "shapes")} == others


def test_ac10_deprecate_one_step(linked):
    pid, core, equipment = linked
    ok(pid, core, "CreateClass", label="Pumpe")
    depth = len(editing_service.document(pid, core).undo)
    ok(pid, core, "Deprecate", iri=EX + "Pump", replacedBy=EX + "Pumpe")
    g = graph(pid, core)
    assert (PUMP, OWL.deprecated, Literal(True)) in g and (PUMP, DCTERMS.isReplacedBy, PUMPE) in g
    assert len(editing_service.document(pid, core).undo) == depth + 1
    assert run(pid, core, "Deprecate", iri=EX + "Pump").json()["detail"] == "Pump is already deprecated."
    assert run(pid, equipment, "Deprecate", iri=EX + "Pump").status_code == 422


def test_ac11_apply_removing_a_used_term_warns(linked):
    pid, core, equipment = linked
    text = "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<http://example.org/plant#Valve> a owl:Class .\n"
    applied = client.put(f"/api/projects/{pid}/documents/{core}/source", json={"text": text})
    assert applied.status_code == 200, applied.text
    warnings = applied.json()["usedElsewhere"]
    assert [w["iri"] for w in warnings] == [EX + "Pump"]
    assert warnings[0]["message"].startswith("Pump is gone from this file, and 2 statements in equipment.ttl and ")


def test_phrase_and_mentions():
    assert uses_phrase([{"file": "a/b.ttl", "count": 1}]) == "1 statement in b.ttl"
    assert uses_phrase([{"file": "x.ttl", "count": 3}, {"file": "y.ttl", "count": 1}]) == "3 statements in x.ttl and 1 in y.ttl"
    prefixes = {"plant": EX}
    assert text_mentions("SELECT * { ?x a plant:Pump . }", PUMP, prefixes)
    assert not text_mentions("SELECT * { ?x a plant:PumpStation }", PUMP, prefixes)
    assert text_mentions(f"SELECT * {{ ?x a <{EX}Pump> }}", PUMP, {})
