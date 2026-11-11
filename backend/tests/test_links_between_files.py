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
    - Pass/fail for AC-1 to AC-11 as the server sees them, and Section 10's
      two rename budgets (`perf`); its checks ratio belongs to PR 2.
================================================================================
"""

from __future__ import annotations

import gc
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import DCTERMS, OWL, RDF

from app import editing
from app.editing import editing_service, project_store, text_mentions, uses_phrase
from app.main import app
from app.snapshots import Loaded
from budget import limit_ms

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
    # A dry run writes nothing, not even the saved-query store's folder.
    assert not (project_store.folder(pid) / "queries").exists()


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


# --- AC-6: recovery restores a group or none of it ---------------------------------


def _wait_for(predicate, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def _drafted_and_stopped(pid: str, docs) -> Path:
    """Wait for every file's draft, then what a killed server leaves: the
    files and drafts on disk, nothing in memory."""
    draft = project_store.folder(pid) / ".draft"
    assert _wait_for(lambda: all((draft / f"{d}.json").exists() for d in docs))
    for document in editing_service._open.pop(pid).values():
        editing_service._cancel(document)
        editing_service.store.unregister_document(document.ontology.id)
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return draft


def test_ac6_recovery_restores_a_group(linked, monkeypatch):
    pid, core, equipment = linked
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.02)
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    _drafted_and_stopped(pid, (core, equipment, "shapes"))
    restored = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).json()
    assert "dropped" not in restored
    for doc in (core, equipment, "shapes"):
        assert mentions(graph(pid, doc), PUMPE) and not mentions(graph(pid, doc), PUMP), doc


def test_ac6_recovery_restores_none_of_a_group_missing_a_member(linked, monkeypatch):
    pid, core, equipment = linked
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.02)
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    draft = _drafted_and_stopped(pid, (core, equipment, "shapes"))
    for name in (f"{equipment}.ttl", f"{equipment}.json"):
        (draft / name).unlink()
    restored = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).json()
    assert restored["dropped"] == (
        "The unsaved changes in core.ttl and shapes.ttl were not recovered: they changed other files too, "
        "and those files' unsaved changes were not kept."
    )
    for doc in (core, equipment, "shapes"):
        assert not mentions(graph(pid, doc), PUMPE), doc


def test_recovery_does_not_need_a_member_already_saved(linked, monkeypatch):
    # A member on disk needs no draft (5.1 items 4, 5): the save refreshes
    # the other drafts' claims, so they are still recovered.
    pid, core, equipment = linked
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.02)
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    draft = project_store.folder(pid) / ".draft"
    assert _wait_for(lambda: all((draft / f"{d}.json").exists() for d in (core, equipment, "shapes")))
    assert client.post(f"/api/projects/{pid}/documents/{equipment}/save", json={}).status_code == 200
    _drafted_and_stopped(pid, (core, "shapes"))
    restored = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).json()
    assert "dropped" not in restored
    for doc in (core, equipment, "shapes"):
        assert mentions(graph(pid, doc), PUMPE), doc


# --- AC-7: a branch relationship is a group of two, as before ------------------------


def test_ac7_branch_pair_still_a_group_of_two(linked):
    pid, core, equipment = linked
    ok(pid, core, "CreateConcept", prefLabel="Pump types")
    made = ok(pid, core, "CreateBranchRelationship", label="pump type", domain=EX + "Pump", branch=EX + "PumpTypes")
    assert made["partner"]["doc"] == "shapes"
    model_step = editing_service.document(pid, core).undo[-1]
    shapes_step = editing_service.document(pid, "shapes").undo[-1]
    assert model_step.group == shapes_step.group and model_step.by_role
    assert model_step.members == {"shapes": shapes_step} and shapes_step.members[core] is model_step
    # D-127's labels, with no files named.
    assert model_step.label == made["label"] and "also in" not in model_step.label
    prop = URIRef(made["created"])
    undone = client.post(f"/api/projects/{pid}/documents/shapes/undo").json()
    assert undone["partner"]["doc"] == core
    assert (prop, None, None) not in graph(pid, core)
    client.post(f"/api/projects/{pid}/documents/{core}/redo")
    assert (prop, None, None) in graph(pid, core)


# --- 5.1 item 6, 5.2 items 3 and 5 ------------------------------------------------------


def test_a_member_in_a_removed_file_is_dropped_with_its_sentence(linked):
    pid, core, equipment = linked
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    assert client.delete(f"/api/projects/{pid}/documents/{equipment}").status_code == 200
    undone = client.post(f"/api/projects/{pid}/documents/{core}/undo").json()
    assert undone["dropped"] == "Part of this change was in a file that was removed."
    assert mentions(graph(pid, core), PUMPE)


def test_redo_refused_while_a_member_is_not_on_top(linked):
    pid, core, equipment = linked
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    ok(pid, equipment, "CreateClass", label="Gear")
    client.post(f"/api/projects/{pid}/documents/{equipment}/undo")  # Gear
    client.post(f"/api/projects/{pid}/documents/{equipment}/undo")  # the rename, every file
    ok(pid, "shapes", "CreateShape", target=EX + "Motor")  # drops shapes' redo branch
    dropped = client.post(f"/api/projects/{pid}/documents/{core}/redo").json()
    assert dropped["dropped"] == (
        "This step also changed shapes.ttl, which has changed since, so it can no longer be redone."
    )


def test_layout_entries_follow_the_address_in_every_file(linked):
    pid, core, equipment = linked
    for doc in (core, equipment):
        layout = project_store.read_layout(pid, doc)
        layout["positions"][EX + "Pump"] = [1.0, 2.0]
        project_store.write_layout(pid, doc, layout)
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    for doc in (core, equipment):
        positions = project_store.read_layout(pid, doc)["positions"]
        assert EX + "Pumpe" in positions and EX + "Pump" not in positions, doc
    client.post(f"/api/projects/{pid}/documents/{equipment}/undo")
    assert EX + "Pump" in project_store.read_layout(pid, core)["positions"]


def test_a_new_address_another_file_uses_is_refused(linked):
    pid, core, equipment = linked
    defined = run(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Motor")
    assert defined.json()["detail"] == "Motor is already defined in equipment.ttl."
    # Only mentioned there, never typed: a rename would merge two terms.
    ok(pid, equipment, "AddAnnotation", iri=EX + "Motor", property="rdfs:seeAlso",
       value={"kind": "link", "value": EX + "Pumpen"})
    refused = run(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpen")
    assert refused.status_code == 422
    assert refused.json()["detail"] == "plant:Pumpen is already used in equipment.ttl; choose another IRI."
    assert mentions(graph(pid, core), PUMP)


def test_dry_run_counts_saved_queries_and_names_snapshots(linked):
    pid, core, equipment = linked
    saved = client.post("/api/queries", json={
        "name": "Pumps", "ontologyId": f"{pid}-{core}", "mode": "text",
        "sparql": f"PREFIX plant: <{EX}>\nSELECT ?p WHERE {{ ?p a plant:Pump }}",
    })
    assert saved.status_code == 200, saved.text
    data = Graph()
    data.add((URIRef(EX + "p1"), RDF.type, PUMP))
    editing_service.snapshots._loaded[pid] = {"pumps-abc123": Loaded({"source": "pumps.csv"}, data)}
    answer = run(pid, core, "RenameIri", dry_run=True, old=EX + "Pump", new=EX + "Pumpe").json()
    assert answer["queries"] == 1
    assert answer["snapshots"] == [{"id": "pumps-abc123", "label": "pumps.csv"}]
    editing_service.snapshots._loaded[pid] = {}
    # Neither is changed by the rename (Section 4).
    ok(pid, core, "RenameIri", old=EX + "Pump", new=EX + "Pumpe")
    assert "plant:Pump " in project_store.queries(pid).list()[0]["sparql"]


# --- Section 10: the budgets ------------------------------------------------------------


def _median_ms(action, setup=None, samples: int = 5) -> float:
    """Median of five with the collector off (D-024)."""
    times = []
    gc.disable()
    try:
        for _ in range(samples):
            if setup:
                setup()
            start = time.perf_counter()
            action()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return sorted(times)[samples // 2]


@pytest.fixture
def ten_files():
    """10 files, 10,000 statements in all, Term in the first and used 200
    times across the other nine (Section 10), generated, never committed."""
    response = client.post("/api/projects", json={"name": "Ten", "template": "empty", "baseIri": EX, "prefix": "plant"})
    pid = response.json()["id"]
    client.post(f"/api/projects/{pid}/open")
    docs = ["model"] + [
        client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": f"part{n}", "folder": ""})
        .json()["entry"]["id"] for n in range(1, 10)
    ]
    rdf, owl, rdfs = str(RDF), str(OWL), "http://www.w3.org/2000/01/rdf-schema#"
    term = f"<{EX}Term>"
    used = 0
    for n, doc in enumerate(docs):
        lines = [f"{term} <{rdf}type> <{owl}Class> ."] if n == 0 else []
        for i in range(333):
            c = f"<{EX}C{n}_{i}>"
            lines += [f"{c} <{rdf}type> <{owl}Class> .", f"{c} <{rdfs}label> \"C {n} {i}\"@en ."]
            if n and used < 200 and i < 23:
                lines.append(f"{c} <{rdfs}subClassOf> {term} .")
                used += 1
            else:
                lines.append(f"{c} <{rdfs}comment> \"filler\"@en .")
        assert client.put(f"/api/projects/{pid}/documents/{doc}/source", json={"text": "\n".join(lines) + "\n"}).status_code == 200
    assert used == 200
    return pid


@pytest.mark.perf
def test_budget_rename_dry_run(ten_files):
    pid = ten_files
    ask = lambda: run(pid, "model", "RenameIri", dry_run=True, old=EX + "Term", new=EX + "Renamed")  # noqa: E731
    assert sum(u["count"] for u in ask().json()["uses"]) == 200
    median = _median_ms(ask)
    assert median < limit_ms(150), f"rename dry run {median:.1f} ms"


@pytest.mark.perf
def test_budget_rename_and_undo(ten_files):
    pid = ten_files
    rename = lambda: ok(pid, "model", "RenameIri", old=EX + "Term", new=EX + "Renamed")  # noqa: E731
    undo = lambda: client.post(f"/api/projects/{pid}/documents/model/undo")  # noqa: E731
    renames, undos = [], []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            rename()
            renames.append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            assert undo().status_code == 200
            undos.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    assert sorted(renames)[2] < limit_ms(500), f"rename {sorted(renames)[2]:.1f} ms"
    assert sorted(undos)[2] < limit_ms(500), f"undo {sorted(undos)[2]:.1f} ms"
