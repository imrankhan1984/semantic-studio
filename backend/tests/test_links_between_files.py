"""
================================================================================
FILE: backend/tests/test_links_between_files.py
================================================================================

SUMMARY
    Links between files, PR 1 (links-between-files 5.1 to 5.5, D-133): the
    grouped step, RenameIri across every project file, DeleteEntity's uses,
    Deprecate, and Turtle Apply's warning for a term other files still use.
    PR 2 (5.6 to 5.8): the hierarchy-move warning by command and by Apply,
    DC-30 and DC-31 in the Checks report, and MoveToFile.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, on a small project:
    Pump defined in core.ttl, used by equipment.ttl (Motor a kind of Pump,
    drives with range Pump) and by shapes.ttl (a shape targeting Pump). The
    service's state is read directly where the API has no window onto it.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; commands and inline Turtle
      (rdf-fixture: the smallest fixture that proves the point).

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-11 and AC-15 to AC-22 as the server sees
      them, and Section 10's three budgets (`perf`): the two rename timings
      and the checks ratio.
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


# =====================================================================================
# PR 2 (links-between-files 5.6 to 5.8, AC-15 to AC-24)
# =====================================================================================

SKOS_NS = "http://www.w3.org/2004/02/skos/core#"


def new_file(pid: str, name: str, role: str = "ontology") -> str:
    made = client.post(f"/api/projects/{pid}/documents", json={"role": role, "name": name, "folder": ""})
    assert made.status_code == 200, made.text
    return made.json()["entry"]["id"]


def apply(pid: str, doc: str, text: str) -> dict:
    applied = client.put(f"/api/projects/{pid}/documents/{doc}/source", json={"text": text})
    assert applied.status_code == 200, applied.text
    return applied.json()


# --- 5.6: the hierarchy-move warning -------------------------------------------------


@pytest.fixture
def branch():
    """AC-15's project: Pump in model.ttl with a branch relationship *has
    valve type* to Valve types, a concept of vocab.ttl, Gate valve under it;
    the rule in shapes.ttl; two examples in data.ttl with Gate valve."""
    response = client.post("/api/projects", json={"name": "Valves", "template": "empty", "baseIri": EX, "prefix": "plant"})
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    vocab = new_file(pid, "vocab", "vocabulary")
    ok(pid, vocab, "CreateConcept", prefLabel="Valve types")
    ok(pid, vocab, "CreateConcept", prefLabel="Gate valve", broader=EX + "ValveTypes")
    ok(pid, "model", "CreateClass", label="Pump")
    made = ok(pid, "model", "CreateBranchRelationship", label="has valve type", domain=EX + "Pump", branch=EX + "ValveTypes")
    data = new_file(pid, "data")
    apply(pid, data, (
        f"<{EX}p1> a <{EX}Pump> ; <{made['created']}> <{EX}GateValve> .\n"
        f"<{EX}p2> a <{EX}Pump> ; <{made['created']}> <{EX}GateValve> .\n"
    ))
    return pid, vocab


def test_ac15_branch_move_warns(branch):
    pid, vocab = branch
    result = ok(pid, vocab, "RemoveBroader", concept=EX + "GateValve", broader=EX + "ValveTypes")
    assert result["warnings"] == [{
        "text": "Gate valve is no longer under Valve types, so Pump's has valve type no longer allows it. "
                "2 examples use it.",
        "block": "broader",
        "about": EX + "GateValve",
    }]
    # The way back is a move too, said the other way round.
    back = ok(pid, vocab, "AddBroader", concept=EX + "GateValve", broader=EX + "ValveTypes")
    assert back["warnings"][0]["text"].startswith("Gate valve is now under Valve types, so Pump's has valve type now allows it.")


@pytest.fixture
def ranged():
    """AC-16's: Motor under Pump in core.ttl; drives in equipment.ttl with
    range Pump; Car in equipment.ttl with the rule *every has part some
    Pump*; Gear, under nothing a range or a rule names."""
    response = client.post("/api/projects", json={"name": "Drives", "template": "empty", "baseIri": EX, "prefix": "plant"})
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    core, equipment = new_file(pid, "core"), new_file(pid, "equipment")
    ok(pid, core, "CreateClass", label="Pump")
    ok(pid, core, "CreateClass", label="Motor", parent=EX + "Pump")
    ok(pid, core, "CreateClass", label="Gear")
    ok(pid, core, "CreateClass", label="Part")
    ok(pid, core, "AddSubClassOf", child=EX + "Gear", parent=EX + "Part")
    ok(pid, equipment, "CreateObjectProperty", label="drives", range=EX + "Pump")
    ok(pid, equipment, "CreateObjectProperty", label="has part")
    ok(pid, equipment, "CreateClass", label="Car")
    ok(pid, equipment, "AddRestriction", **{"class": EX + "Car"}, form="every", property=EX + "hasPart",
       kind="some", filler=EX + "Pump")
    return pid, core, equipment


def test_ac16_range_move_warns(ranged):
    pid, core, equipment = ranged
    result = ok(pid, core, "RemoveSubClassOf", child=EX + "Motor", parent=EX + "Pump")
    assert [w["text"] for w in result["warnings"]] == [
        "Motor is no longer under Pump, so Car's rule on has part no longer expects it.",
        "Motor is no longer under Pump, so drives no longer expects it.",
    ]
    assert {w["block"] for w in result["warnings"]} == {"parents"}
    assert {w["about"] for w in result["warnings"]} == {EX + "Motor"}


def test_ac16_the_text_door_warns_alike(ranged):
    pid, core, equipment = ranged
    text = source(pid, core).replace("rdfs:subClassOf plant:Pump", "rdfs:comment \"no longer a pump\"@en")
    assert "no longer a pump" in text
    applied = apply(pid, core, text)
    assert [w["text"] for w in applied["hierarchyWarnings"]] == [
        "Motor is no longer under Pump, so Car's rule on has part no longer expects it.",
        "Motor is no longer under Pump, so drives no longer expects it.",
    ]


def test_the_text_door_warns_of_another_files_term_moved_here(ranged):
    # equipment.ttl states the parent of core.ttl's Gear: taking it away by
    # Turtle in equipment.ttl moves Gear, a term this file does not type.
    pid, core, equipment = ranged
    ok(pid, core, "RemoveSubClassOf", child=EX + "Gear", parent=EX + "Part")
    before = source(pid, equipment)
    apply(pid, equipment, before + f"\n<{EX}Gear> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <{EX}Pump> .\n")
    applied = apply(pid, equipment, before)
    assert [w["text"] for w in applied["hierarchyWarnings"]] == [
        "Gear is no longer under Pump, so Car's rule on has part no longer expects it.",
        "Gear is no longer under Pump, so drives no longer expects it.",
    ]


def test_ac17_warning_never_blocks_and_a_move_changing_no_rule_says_nothing(ranged):
    pid, core, equipment = ranged
    result = ok(pid, core, "RemoveSubClassOf", child=EX + "Motor", parent=EX + "Pump")
    assert result["warnings"]
    assert (URIRef(EX + "Motor"), URIRef("http://www.w3.org/2000/01/rdf-schema#subClassOf"), PUMP) not in graph(pid, core)
    quiet = ok(pid, core, "RemoveSubClassOf", child=EX + "Gear", parent=EX + "Part")
    assert "warnings" not in quiet
    assert apply(pid, core, source(pid, core) + "\n")["hierarchyWarnings"] == []


# --- 5.7: DC-30 and DC-31 ------------------------------------------------------------


def checks_of(pid: str, doc: str) -> dict:
    report = client.get(f"/api/ontologies/{pid}/checks?doc={doc}")
    assert report.status_code == 200, report.text
    return {g["id"]: g for g in report.json()["groups"]}


def test_ac18_dc30_lists_each_statement_with_its_file(linked):
    pid, core, equipment = linked
    assert checks_of(pid, core)["DC-30"]["findings"] == []
    ok(pid, core, "DeleteEntity", iri=EX + "Pump")
    group = checks_of(pid, equipment)["DC-30"]
    assert group["level"] == "Problem" and group["total"] == len(group["findings"])
    by_file = {}
    for finding in group["findings"]:
        by_file.setdefault(finding["file"], []).append(finding)
    motor = [f for f in by_file["equipment.ttl"] if f["iri"] == EX + "Motor"]
    assert [f["sentence"] for f in motor] == ["equipment.ttl: Motor is a kind of Pump, which no file defines."]
    assert motor[0]["doc"] == equipment
    assert [f["sentence"] for f in by_file["equipment.ttl"] if f["iri"] == EX + "drives"] == [
        "equipment.ttl: drives has range Pump, which no file defines.",
    ]
    # The shape's target is a statement too, named by its shape, in its file.
    assert [f["doc"] for f in by_file["shapes.ttl"]] == ["shapes"]


def test_dc30_counts_an_import_and_a_switched_on_snapshot_as_saying_it(linked):
    pid, core, equipment = linked
    ok(pid, equipment, "AddAnnotation", iri=EX + "Motor", property="rdfs:seeAlso", value={"kind": "link", "value": EX + "row1"})
    assert [f["iri"] for f in checks_of(pid, core)["DC-30"]["findings"]] == [EX + "Motor"]
    data = Graph()
    data.add((URIRef(EX + "row1"), RDF.type, PUMP))
    meta = {"id": "rows-abc123", "source": "rows.csv", "importedAt": "2026-11-11T00:00:00Z",
            "rows": {"kept": 1, "total": 1}, "enabled": True}
    editing_service.snapshots._loaded[pid] = {"rows-abc123": Loaded(meta, data)}
    try:
        assert checks_of(pid, core)["DC-30"]["findings"] == []
        editing_service.snapshots._loaded[pid]["rows-abc123"].meta["enabled"] = False
        assert len(checks_of(pid, core)["DC-30"]["findings"]) == 1
    finally:
        editing_service.snapshots._loaded[pid] = {}


def test_ac19_dc31_lists_a_term_typed_in_two_files(linked):
    pid, core, equipment = linked
    assert checks_of(pid, core)["DC-31"]["findings"] == []
    applied = apply(pid, equipment, source(pid, equipment) + f"\n<{EX}Pump> a <http://www.w3.org/2002/07/owl#Class> .\n")
    assert applied["definedElsewhere"]
    group = checks_of(pid, core)["DC-31"]
    assert group["level"] == "Worth a look"
    assert [(f["iri"], f["sentence"], f["files"]) for f in group["findings"]] == [
        (EX + "Pump", "Pump is defined in core.ttl and equipment.ttl.", ["core.ttl", "equipment.ttl"]),
    ]
    assert group["findings"][0]["doc"] == core


def test_dc30_and_dc31_are_pinned_select_files():
    from app import checks, sparql_exec

    for cid in ("DC-30", "DC-31"):
        entry = next(e for e in checks.manifest() if e["id"] == cid)
        path = Path(checks.CHECKS_DIR) / entry["file"]
        import hashlib

        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]
        sparql_exec.prepare_select(entry["query"])  # a SELECT the runner accepts
        assert cid in checks._COMPUTED


# --- 5.8: Move to file ---------------------------------------------------------------


@pytest.fixture
def movable(linked):
    """AC-20's: Pump in core.ttl with a rule (every drives some Motor) and an
    address under a prefix only core.ttl declares (AC-22)."""
    pid, core, equipment = linked
    ok(pid, core, "CreateClass", label="Motor housing")
    ok(pid, core, "AddRestriction", **{"class": EX + "Pump"}, form="every", property=EX + "drives",
       kind="some", filler=EX + "MotorHousing")
    text = source(pid, core)
    text = "@prefix spare: <http://example.org/spare#> .\n" + text + "\nplant:Pump rdfs:seeAlso spare:Catalogue .\n"
    apply(pid, core, text)
    return pid, core, equipment


def test_ac20_move_to_file_one_step_no_link_breaks(movable):
    pid, core, equipment = movable
    own = {t for t in graph(pid, core) if t[0] == PUMP}
    assert len(own) >= 4
    pointing = {d: {t for t in graph(pid, d) if t[2] == PUMP} for d in (equipment, "shapes")}
    result = ok(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
    assert result["label"] == "Moved Pump to equipment.ttl"
    assert result["moved"] == {"doc": equipment, "file": "equipment.ttl"}
    assert {d["doc"] for d in result["documents"]} == {core, equipment}
    assert (PUMP, None, None) not in graph(pid, core)
    for t in own:
        if isinstance(t[2], URIRef):
            assert t in graph(pid, equipment)
    # The rule's blank nodes went whole: no restriction is left in core.ttl.
    assert not [t for t in graph(pid, core) if t[1] == OWL.onProperty]
    assert [t for t in graph(pid, equipment) if t[1] == OWL.someValuesFrom][0][2] == URIRef(EX + "MotorHousing")
    for d, kept in pointing.items():
        assert {t for t in graph(pid, d) if t[2] == PUMP} == kept, d
    assert "spare: <http://example.org/spare#>" in source(pid, equipment)
    # One undo step in each file, sharing a group.
    a, b = editing_service.document(pid, core).undo[-1], editing_service.document(pid, equipment).undo[-1]
    assert a.group == b.group and a.members == {equipment: b} and b.label == "Moved Pump from core.ttl"
    assert checks_of(pid, core)["DC-30"]["findings"] == []


def test_ac21_move_refusals(movable):
    pid, core, equipment = movable
    revisions = {d.doc: d.ontology.revision for d in editing_service._open[pid].values()}
    refusals = [
        (core, {"iri": EX + "Pump", "target": "shapes"},
         "Shapes live in a shapes file; move the class, then its shapes follow its address."),
        (core, {"iri": EX + "Pump", "target": core}, "Pump is already defined in core.ttl."),
        (equipment, {"iri": EX + "Pump", "target": equipment}, "Pump is defined in core.ttl. Open that file to change it."),
        (core, {"iri": EX + "Nothing", "target": equipment}, "Nothing has no statements of its own in core.ttl to move."),
        (core, {"iri": EX + "Pump", "target": "../model"}, "There is no such file in this project."),
    ]
    for doc, args, sentence in refusals:
        refused = run(pid, doc, "MoveToFile", **args)
        assert refused.status_code == 422, args
        assert refused.json()["detail"] == sentence
    assert {d.doc: d.ontology.revision for d in editing_service._open[pid].values()} == revisions
    # A target that already defines it: a term typed in two files (Turtle).
    apply(pid, equipment, source(pid, equipment) + f"\n<{EX}Pump> a <http://www.w3.org/2002/07/owl#Class> .\n")
    texts = {d: source(pid, d) for d in (core, equipment)}
    refused = run(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
    assert refused.json()["detail"] == "Pump is already defined in equipment.ttl."
    assert {d: source(pid, d) for d in (core, equipment)} == texts


def test_ac22_move_undo_byte_for_byte(movable):
    pid, core, equipment = movable
    # Once with the target's text as written, once after a command has
    # cleared it: both read back the same, prefixes included.
    for prepare in (None, lambda: ok(pid, equipment, "CreateClass", label="Gear")):
        if prepare:
            prepare()
        before = {d: source(pid, d) for d in (core, equipment)}
        for asked in (core, equipment):
            ok(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
            assert source(pid, equipment) != before[equipment]
            assert client.post(f"/api/projects/{pid}/documents/{asked}/undo").status_code == 200
            assert {d: source(pid, d) for d in (core, equipment)} == before, asked
        moved = ok(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
        after = {d: source(pid, d) for d in (core, equipment)}
        client.post(f"/api/projects/{pid}/documents/{equipment}/undo")
        client.post(f"/api/projects/{pid}/documents/{core}/redo")
        assert {d: source(pid, d) for d in (core, equipment)} == after
        client.post(f"/api/projects/{pid}/documents/{core}/undo")
        assert moved["label"]


def test_move_drops_the_box_from_the_files_canvas_and_undo_puts_it_back(movable):
    pid, core, equipment = movable
    layout = project_store.read_layout(pid, core)
    layout["positions"][EX + "Pump"] = [3.0, 4.0]
    project_store.write_layout(pid, core, layout)
    ok(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
    assert EX + "Pump" not in project_store.read_layout(pid, core)["positions"]
    # An undone move finds its box's place, as an undone delete does.
    client.post(f"/api/projects/{pid}/documents/{equipment}/undo")
    assert project_store.read_layout(pid, core)["positions"][EX + "Pump"] == [3.0, 4.0]
    client.post(f"/api/projects/{pid}/documents/{core}/redo")
    assert EX + "Pump" not in project_store.read_layout(pid, core)["positions"]


def test_a_blank_node_two_terms_share_is_not_split(linked):
    # A restriction written once for two classes (Turtle can): moving one
    # class would leave the other pointing at a description in another
    # file, so the move is refused and nothing changes.
    pid, core, equipment = linked
    text = source(pid, core) + (
        f"\n<{EX}Valve> a <http://www.w3.org/2002/07/owl#Class> .\n"
        f"_:r a <http://www.w3.org/2002/07/owl#Restriction> ; "
        f"<http://www.w3.org/2002/07/owl#onProperty> <{EX}drives> ; "
        f"<http://www.w3.org/2002/07/owl#someValuesFrom> <{EX}Valve> .\n"
        f"<{EX}Pump> <http://www.w3.org/2000/01/rdf-schema#subClassOf> _:r .\n"
        f"<{EX}Valve> <http://www.w3.org/2000/01/rdf-schema#subClassOf> _:r .\n"
    )
    apply(pid, core, text)
    texts = {d: source(pid, d) for d in (core, equipment)}
    refused = run(pid, core, "MoveToFile", iri=EX + "Pump", target=equipment)
    assert refused.status_code == 422
    assert refused.json()["detail"] == (
        "Pump shares a rule with another term, written in Turtle; move it in Turtle, or give each term its own rule first."
    )
    assert {d: source(pid, d) for d in (core, equipment)} == texts


# --- Section 10: the checks ratio (AC-24) ---------------------------------------------


@pytest.mark.perf
def test_budget_checks_ratio(ten_files, monkeypatch):
    """DC-30 and DC-31 keep the Checks report within 10% of its time without
    them (Section 10): the same report, the same statements, with and
    without the two entries -- without them it is main's report. A ratio,
    so never scaled. Every check runs on both sides, H9 included: its pair
    query reached the 30 s timeout on this project (37.1 s for the whole
    report on 037ff50), and since it reads one row per class it finishes
    in tens of milliseconds, so the report holds no fixed timeout that
    would hide a ratio. The report is asserted to hold no error."""
    from app import checks

    pid = ten_files
    path = f"/api/ontologies/{pid}/checks?doc=model"
    full = list(checks.manifest())
    without = [e for e in full if e["id"] not in ("DC-30", "DC-31")]
    monkeypatch.setattr(checks, "manifest", lambda: full)
    report = client.get(path).json()  # warm: parsed queries, views
    assert "overCap" not in report and {"DC-30", "DC-31", "H9"} <= {g["id"] for g in report["groups"]}
    assert not [g["id"] for g in report["groups"] if "error" in g]
    times = {"with": [], "without": []}
    gc.disable()
    try:
        for _ in range(5):
            for side, entries in (("with", full), ("without", without)):
                monkeypatch.setattr(checks, "manifest", lambda entries=entries: entries)
                start = time.perf_counter()
                assert client.get(path).status_code == 200
                times[side].append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    with_ms, without_ms = sorted(times["with"])[2], sorted(times["without"])[2]
    assert with_ms / without_ms < 1.10, f"with {with_ms:.0f} ms, without {without_ms:.0f} ms"
