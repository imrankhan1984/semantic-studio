"""
================================================================================
FILE: backend/tests/test_multi_file.py
================================================================================

SUMMARY
    Multi-file projects (E-16, D-131): a project made before E-16
    opening unchanged, files and folders added, renamed, moved and removed,
    a folder's rename with the files under it (PR 2, 5.10 item 1),
    the folder index, the path rules of 8.3, what each file sees of the
    others, the whole project read by Query, Checks, validation and
    reasoning, undo per file, drafts by id, the lock order, and the
    Section 10 budgets.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, with the service's state
    read directly where the API has no window onto it. The pre-E-16 project
    is written by hand, byte for byte as a project of that time was (no `id`
    on a manifest entry, a layout, a draft newer than its file), so the
    fixture does not move when create() does. "Nothing written outside the
    folder" is asserted by listing the parent folder before and after.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; inline Turtle; a generated
      10,000-statement project for the budgets (rdf-fixture: scale is
      generated, never committed).

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-22 and AC-29 as the server sees them, and
      the three budgets of Section 10.
================================================================================
"""

from __future__ import annotations

import gc
import json
import os
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.compare import isomorphic

from app.editing import editing_service, project_store
from app.main import app
from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/plant#"

OLD_MODEL = """@prefix plant: <http://example.org/plant#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# A comment the file keeps.
<http://example.org/plant> a owl:Ontology ;
    rdfs:label "Plant"@en .

plant:Pump a owl:Class ;
    rdfs:label "Pump"@en .

plant:Valve a owl:Class ;
    rdfs:label "Valve"@en .
"""

OLD_SHAPES = """@prefix plant: <http://example.org/plant#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

plant:PumpShape a sh:NodeShape ;
    sh:targetClass plant:Pump .
"""

OLD_DRAFT = OLD_MODEL + """
plant:Motor a owl:Class ;
    rdfs:label "Motor"@en .
"""


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def old_project() -> str:
    """A project exactly as one made before E-16 lies on disk: manifest
    entries with no `id`, model.ttl, shapes.ttl, a layout for the model and
    an autosaved draft of model.ttl newer than the file."""
    pid = "prj-" + uuid.uuid4().hex[:12]
    folder = project_store.dir / pid
    folder.mkdir()
    manifest = {
        "id": pid,
        "name": "Plant",
        "createdAt": "2026-10-01T09:00:00+00:00",
        "updatedAt": "2026-10-02T09:00:00+00:00",
        "baseIri": EX,
        "prefix": "plant",
        "primaryLanguage": "en",
        "languages": [],
        "documents": [{"file": "model.ttl", "role": "model"}, {"file": "shapes.ttl", "role": "shapes"}],
        "counts": {"classes": 2, "properties": 0, "concepts": 0, "triples": 6},
        "kind": "ontology",
        "commentsWarned": False,
        "startedFrom": "empty",
        "references": [],
    }
    (folder / "project.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (folder / "model.ttl").write_text(OLD_MODEL, encoding="utf-8")
    (folder / "shapes.ttl").write_text(OLD_SHAPES, encoding="utf-8")
    layout = {"version": 1, "generation": 3, "positions": {EX + "Pump": [10.0, 20.0]},
              "shown": None, "viewport": None, "placed": []}
    (folder / "model.layout.json").write_text(json.dumps(layout), encoding="utf-8")
    draft = folder / ".draft"
    draft.mkdir()
    (draft / "model.ttl").write_text(OLD_DRAFT, encoding="utf-8")
    (draft / "model.json").write_text(json.dumps(
        {"revision": 1, "fromEditor": True, "visualSinceSave": False, "writtenAt": "2026-10-02T09:05:00+00:00"}
    ), encoding="utf-8")
    # The draft is newer than its file, as an autosave after the last save is.
    past = time.time() - 3600
    os.utime(folder / "model.ttl", (past, past))
    os.utime(folder / "shapes.ttl", (past, past))
    return pid


def parsed(text: str) -> Graph:
    return Graph().parse(data=text, format="turtle", publicID=EX)


# --- AC-1, AC-2, AC-21: a project made before E-16 -----------------------------


def test_ac1_old_project_opens_unchanged():
    pid = old_project()
    manifest_path = project_store.folder(pid) / "project.json"
    before = manifest_path.read_bytes()
    opened = client.post(f"/api/projects/{pid}/open")
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert [d["doc"] for d in body["documents"]] == ["model", "shapes"]
    assert [d["ontologyId"] for d in body["documents"]] == [f"{pid}-model", f"{pid}-shapes"]
    assert all(d["revision"] == 0 for d in body["documents"])
    assert isomorphic(editing_service.document(pid, "model").graph, parsed(OLD_MODEL))
    assert isomorphic(editing_service.document(pid, "shapes").graph, parsed(OLD_SHAPES))
    layout = client.get(f"/api/projects/{pid}/documents/model/layout").json()
    assert layout["positions"] == {EX + "Pump": [10.0, 20.0]}
    assert layout["generation"] == 3
    # The source is the file, comment and all.
    assert client.get(f"/api/projects/{pid}/documents/model/source").json()["text"] == OLD_MODEL
    # Nothing was found, missed or skipped, and nothing was written.
    assert manifest_path.read_bytes() == before


def test_ac21_old_draft_is_offered_and_recovers():
    pid = old_project()
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert opened["recovery"]["available"] is True
    recovered = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"})
    assert recovered.status_code == 200, recovered.text
    assert isomorphic(editing_service.document(pid, "model").graph, parsed(OLD_DRAFT))
    states = {d["doc"]: d for d in recovered.json()["documents"]}
    assert states["model"]["dirty"] is True and states["shapes"]["dirty"] is False


def test_ac2_adding_a_file_gives_old_entries_their_ids_only():
    pid = old_project()
    client.post(f"/api/projects/{pid}/open")
    made = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "core"})
    assert made.status_code == 200, made.text
    documents = project_store.manifest(pid)["documents"]
    assert documents[0] == {"id": "model", "file": "model.ttl", "role": "model"}
    assert documents[1] == {"id": "shapes", "file": "shapes.ttl", "role": "shapes"}
    assert documents[2]["file"] == "core.ttl" and documents[2]["role"] == "ontology"


# --- helpers for a project of several files ------------------------------------


def new_project(name: str = "Plant", template: str = "empty") -> str:
    response = client.post(
        "/api/projects", json={"name": name, "template": template, "baseIri": EX, "prefix": "plant"}
    )
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


def add_file(pid: str, name: str, role: str = "ontology", folder: str = "") -> dict:
    response = client.post(f"/api/projects/{pid}/documents", json={"role": role, "name": name, "folder": folder})
    assert response.status_code == 200, response.text
    return response.json()


def folder(pid: str, path: str) -> list[str]:
    response = client.post(f"/api/projects/{pid}/folders", json={"path": path})
    assert response.status_code == 200, response.text
    return response.json()["folders"]


def run(pid: str, doc: str, command: str, **args):
    return client.post(f"/api/projects/{pid}/documents/{doc}/commands", json={"command": command, "args": args})


def ok(pid: str, doc: str, command: str, **args) -> dict:
    response = run(pid, doc, command, **args)
    assert response.status_code == 200, response.text
    return response.json()


def apply(pid: str, doc: str, text: str):
    return client.put(f"/api/projects/{pid}/documents/{doc}/source", json={"text": text})


def disk(pid: str) -> set[str]:
    """Every path in the data folder's projects folder outside this project,
    for "nothing written outside the project folder" (8.3)."""
    root = project_store.dir
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.relative_to(root).parts[0] != pid}


def inside(pid: str) -> list[str]:
    folder_path = project_store.folder(pid)
    return sorted(p.relative_to(folder_path).as_posix() for p in folder_path.rglob("*"))


# --- AC-3, AC-4: New file --------------------------------------------------------

RDF_TYPE = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
OWL_ONTOLOGY = URIRef("http://www.w3.org/2002/07/owl#Ontology")


@pytest.mark.parametrize("role", ["ontology", "vocabulary", "shapes"])
def test_ac3_new_file_in_each_role_at_the_root_and_in_a_folder(role):
    pid = new_project()
    folder(pid, "vocab")
    for where in ("", "vocab"):
        made = add_file(pid, f"equipment-{role}", role, where)
        entry = made["entry"]
        expected = f"{where}/equipment-{role}.ttl" if where else f"equipment-{role}.ttl"
        assert entry["file"] == expected and entry["role"] == role
        assert made["document"]["doc"] == entry["id"] and made["document"]["file"] == expected
        text = project_store.folder(pid).joinpath(*expected.split("/")).read_text(encoding="utf-8")
        assert f"@prefix plant: <{EX}> ." in text
        headers = list(Graph().parse(data=text, format="turtle").subjects(RDF_TYPE, OWL_ONTOLOGY))
        if role == "shapes":
            assert headers == [] and "@prefix sh:" in text
        else:
            # Its own header, the base plus its path (5.1 item 6).
            assert headers == [URIRef(EX + expected[: -len(".ttl")])]
        listed = {d["doc"]: d for d in client.post(f"/api/projects/{pid}/open").json()["documents"]}
        assert listed[entry["id"]]["role"] == role


def test_ac4_a_class_in_a_new_file_is_under_the_base():
    pid = new_project()
    core = add_file(pid, "core")["entry"]["id"]
    assert ok(pid, core, "CreateClass", label="Pump")["created"] == EX + "Pump"


# --- AC-5: ids -------------------------------------------------------------------


def test_ac5_minted_ids_and_the_id_pattern():
    from app.projects import split_document_id

    pid = new_project()
    doc = add_file(pid, "core")["entry"]["id"]
    assert doc[0] == "f" and len(doc) == 9 and all(c in "0123456789abcdef" for c in doc[1:])
    assert split_document_id(f"{pid}-model") == (pid, "model")
    assert split_document_id(f"{pid}-shapes") == (pid, "shapes")
    assert split_document_id(f"{pid}-{doc}") == (pid, doc)
    for bad in (f"{pid}-core", f"{pid}-f123", f"{pid}-{doc}\n", f"{pid}-F0000000A", f"{pid}-../x"):
        assert split_document_id(bad) is None


@pytest.mark.parametrize("path", [
    "f00000000/source", "f00000000/canvas", "f00000000/layout", "f00000000/vocabularies",
    "f00000000/annotation-properties", "f00000000/languages", "f00000000/download",
    "core/source", "..%2Fmodel/source",
])
def test_ac5_an_id_not_issued_is_404(path):
    pid = new_project()
    assert client.get(f"/api/projects/{pid}/documents/{path}").status_code == 404


def test_ac5_writes_to_an_id_not_issued_are_404_and_write_nothing():
    pid = new_project()
    before = inside(pid)
    for method, path, body in [
        ("PUT", "f00000000/source", {"text": "x"}),
        ("PUT", "f00000000/layout", {"positions": {}}),
        ("PATCH", "f00000000", {"name": "x"}),
        ("DELETE", "f00000000", None),
        ("POST", "f00000000/commands", {"command": "SetLabel", "args": {}}),
        ("POST", "f00000000/undo", None),
        ("POST", "f00000000/save", None),
    ]:
        response = client.request(method, f"/api/projects/{pid}/documents/{path}", json=body)
        assert response.status_code == 404, (method, path, response.text)
    assert inside(pid) == before


# --- AC-6: the path rules of 8.3 ---------------------------------------------------


# A file name has .ttl added when left off (5.5 item 5), so "trailing." and
# "project.json" become names that pass; the folder table holds those.
BAD_NAMES = [
    "..", "../escape", "/etc/passwd", "a\\b", "C:evil", "CON", "con.ttl", "nul", "com1.ttl", "lpt9.ttl",
    ".hidden", "x.original.ttl", "a" * 70, "", "   ", "naïve", "a\nb",
]


@pytest.mark.parametrize("name", BAD_NAMES)
def test_ac6_a_bad_name_is_refused_beside_its_field_and_nothing_is_written(name):
    pid = new_project()
    outside, before = disk(pid), inside(pid)
    response = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": name})
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "path" and detail["field"] == "name" and detail["message"].endswith(".")
    assert disk(pid) == outside and inside(pid) == before


@pytest.mark.parametrize("path", [
    "..", "../out", "/abs", "a\\b", "C:/x", "a/../b", "CON", "a/", "/", "a//b", "x.", "data", "queries", ".draft",
])
def test_ac6_a_bad_folder_is_refused_and_nothing_is_written(path):
    pid = new_project()
    outside, before = disk(pid), inside(pid)
    for response in (
        client.post(f"/api/projects/{pid}/folders", json={"path": path}),
        client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "x", "folder": path}),
    ):
        assert response.status_code == 422, (path, response.text)
        assert response.json()["detail"]["code"] == "path"
    assert disk(pid) == outside and inside(pid) == before


def test_ac6_a_case_clash_a_fourth_level_and_a_101st_file():
    pid = new_project()
    add_file(pid, "Core")
    clash = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "core.TTL"})
    assert clash.status_code == 422 and clash.json()["detail"]["field"] == "name"
    assert "already a file called Core.ttl" in clash.json()["detail"]["message"]
    folder(pid, "a")
    folder(pid, "a/b")
    folder(pid, "a/b/c")
    deep = client.post(f"/api/projects/{pid}/folders", json={"path": "a/b/c/d"})
    assert deep.status_code == 422 and "3 levels" in deep.json()["detail"]["message"]
    assert add_file(pid, "deep", folder="a/b/c")["entry"]["file"] == "a/b/c/deep.ttl"
    for n in range(97):
        add_file(pid, f"m{n}")
    assert len(project_store.manifest(pid)["documents"]) == 100
    full = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "one-more"})
    assert full.status_code == 422
    assert full.json()["detail"] == {
        "code": "path", "field": None, "message": "This project has 100 files, the most it can hold.",
    }
    assert not (project_store.folder(pid) / "one-more.ttl").exists()


def test_ac6_a_folder_that_is_a_link_out_is_refused(tmp_path):
    pid = new_project()
    target = tmp_path / "elsewhere"
    target.mkdir()
    try:
        os.symlink(target, project_store.folder(pid) / "linked", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this machine cannot make a symbolic link")
    response = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "x", "folder": "linked"})
    assert response.status_code == 422
    assert list(target.iterdir()) == []


# The name rule's one table, read by frontend/src/files/names.test.ts too.
NAMES = json.loads(
    (Path(__file__).resolve().parents[2] / "frontend" / "src" / "files" / "names.table.json").read_text(encoding="utf-8")
)


def test_the_name_table_is_read():
    assert len(NAMES["segments"]) > 20 and len(NAMES["files"]) > 5 and len(NAMES["folders"]) > 5


@pytest.mark.parametrize("name,passes", NAMES["segments"])
def test_ac6_the_segment_rule_matches_the_browsers(name, passes):
    from app.projects import segment_error

    assert (segment_error(name) is None) is passes


@pytest.mark.parametrize("typed,expected", NAMES["files"])
def test_ac6_a_file_name_matches_the_browsers(typed, expected):
    from app.projects import PathRefused, file_name

    try:
        assert file_name(typed) == expected
    except PathRefused:
        assert expected is None


@pytest.mark.parametrize("path,passes", NAMES["folders"])
def test_ac6_a_folder_matches_the_browsers(path, passes):
    from app.projects import PathRefused, folder_parts

    try:
        folder_parts(path)
        assert passes
    except PathRefused:
        assert not passes


# --- AC-7, AC-8: the folder index ---------------------------------------------------


def test_ac7_a_copied_file_is_found_with_an_id_and_a_role():
    pid = new_project()
    client.post(f"/api/projects/{pid}/close")
    folder_path = project_store.folder(pid)
    (folder_path / "vocab").mkdir()
    (folder_path / "vocab" / "equipment.ttl").write_text(
        "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n"
        f"<{EX}Pump> a skos:Concept ; skos:prefLabel \"Pump\"@en .\n", encoding="utf-8")
    (folder_path / "rules.ttl").write_text(
        "@prefix sh: <http://www.w3.org/ns/shacl#> .\n"
        f"<{EX}S> a sh:NodeShape ; sh:targetClass <{EX}Pump> .\n", encoding="utf-8")
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert sorted(opened["found"]) == ["rules.ttl", "vocab/equipment.ttl"]
    by_file = {d["file"]: d for d in opened["documents"]}
    assert by_file["vocab/equipment.ttl"]["role"] == "vocabulary"
    assert by_file["rules.ttl"]["role"] == "shapes"
    assert by_file["vocab/equipment.ttl"]["doc"].startswith("f")
    assert opened["folders"] == ["vocab"]
    # Found once: the manifest holds them now, and the next open says nothing.
    client.post(f"/api/projects/{pid}/close")
    again = client.post(f"/api/projects/{pid}/open").json()
    assert again["found"] == []
    assert {d["doc"]: d["file"] for d in again["documents"]} == {d["doc"]: d["file"] for d in opened["documents"]}


def test_ac8_a_missing_file_is_dropped_and_a_link_is_skipped(tmp_path):
    pid = new_project()
    core = add_file(pid, "core")["entry"]["id"]
    client.post(f"/api/projects/{pid}/close")
    folder_path = project_store.folder(pid)
    (folder_path / "core.ttl").unlink()
    outside = tmp_path / "secret.ttl"
    outside.write_text(f"<{EX}Secret> a <http://www.w3.org/2002/07/owl#Class> .\n", encoding="utf-8")
    try:
        os.symlink(outside, folder_path / "linked.ttl")
        linked = True
    except (OSError, NotImplementedError):
        linked = False
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert opened["missing"] == ["core.ttl"]
    assert core not in {d["doc"] for d in opened["documents"]}
    assert all(d.get("id") != core for d in project_store.manifest(pid)["documents"])
    if linked:
        assert opened["skipped"] == [{"path": "linked.ttl", "reason": "linked.ttl is a link, so it was not read."}]
        assert "linked.ttl" not in {d["file"] for d in opened["documents"]}


def test_ac8_a_project_with_no_model_file_left_gets_an_empty_one():
    pid = new_project()
    add_file(pid, "rules", "shapes")
    client.post(f"/api/projects/{pid}/close")
    (project_store.folder(pid) / "model.ttl").unlink()
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert opened["missing"] == ["model.ttl"] and opened["wroteModel"] is True
    assert opened["documents"][0]["doc"] == "model"
    assert (project_store.folder(pid) / "model.ttl").is_file()


# --- AC-9, AC-10, AC-11: what each file sees -----------------------------------------


@pytest.fixture
def plant():
    """core.ttl defining Pump, and vocab/equipment.ttl, both ontology files."""
    pid = new_project()
    folder(pid, "vocab")
    core = add_file(pid, "core")["entry"]["id"]
    equipment = add_file(pid, "equipment", folder="vocab")["entry"]["id"]
    ok(pid, core, "CreateClass", label="Pump")
    return pid, core, equipment


def test_ac9_a_term_in_one_file_is_read_only_in_another(plant):
    pid, core, equipment = plant
    oid = f"{pid}-{equipment}"
    tree = client.get(f"/api/ontologies/{oid}/hierarchy").json()
    assert tree["classes"]["nodes"][EX + "Pump"]["fromFile"] == {"doc": core, "file": "core.ttl"}
    detail = client.get(f"/api/ontologies/{oid}/node", params={"iri": EX + "Pump"}).json()
    assert detail["fromFile"] == {"doc": core, "file": "core.ttl"}
    assert detail["rules"]["choices"] is None  # no builder: not this file's to change
    own = client.get(f"/api/ontologies/{pid}-{core}/node", params={"iri": EX + "Pump"}).json()
    assert "fromFile" not in own
    graph = client.get(f"/api/ontologies/{oid}/graph").json()
    assert any(n["id"] == EX + "Pump" and n["fromFile"]["file"] == "core.ttl" for n in graph["nodes"])


def test_ac10_a_change_is_refused_a_pointer_is_written_here(plant):
    pid, core, equipment = plant
    before = editing_service.document(pid, core).ontology.revision
    refused = run(pid, equipment, "SetLabel", iri=EX + "Pump", value="Big pump")
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Pump is defined in core.ttl. Open that file to change it."
    assert run(pid, equipment, "AddSubClassOf", child=EX + "Pump", parent=EX + "Pump").status_code == 422
    assert editing_service.document(pid, core).ontology.revision == before
    ok(pid, equipment, "CreateClass", label="Motor")
    made = ok(pid, equipment, "CreateObjectProperty", label="drives", domain=EX + "Motor", range=EX + "Pump")
    prop = URIRef(made["created"])
    rdfs_range = URIRef("http://www.w3.org/2000/01/rdf-schema#range")
    assert (prop, rdfs_range, URIRef(EX + "Pump")) in editing_service.document(pid, equipment).graph
    assert (prop, None, None) not in editing_service.document(pid, core).graph
    assert editing_service.document(pid, core).ontology.revision == before


def test_ac11_creating_a_term_another_file_defines(plant):
    pid, core, equipment = plant
    refused = run(pid, equipment, "CreateClass", label="Pump")
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Pump is already defined in core.ttl."
    text = ("@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
            f"<{EX}Pump> a owl:Class ; rdfs:label \"Pump\"@en .\n")
    applied = apply(pid, equipment, text)
    assert applied.status_code == 200, applied.text
    warnings = applied.json()["definedElsewhere"]
    assert [w["message"] for w in warnings] == ["Pump is already defined in core.ttl."]
    assert warnings[0]["file"] == "core.ttl"


# --- AC-12: the whole project read the same, one file or ten -------------------------


def split_statements(n_classes: int = 60) -> list[str]:
    """A small model as N-Triples lines: classes in a chain, a label each, an
    example of each, a shape-free model the checks have something to say about."""
    rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    owl = "http://www.w3.org/2002/07/owl#"
    rdfs = "http://www.w3.org/2000/01/rdf-schema#"
    lines = []
    for i in range(n_classes):
        c = f"<{EX}C{i}>"
        lines.append(f"{c} <{rdf}type> <{owl}Class> .")
        lines.append(f"{c} <{rdfs}label> \"Class {i}\"@en .")
        if i:
            lines.append(f"{c} <{rdfs}subClassOf> <{EX}C{i - 1}> .")
        lines.append(f"<{EX}e{i}> <{rdf}type> {c} .")
        lines.append(f"<{EX}e{i}> <{rdfs}label> \"Example {i}\"@en .")
    return lines


def project_with(chunks: list[list[str]]) -> tuple[str, list[str]]:
    pid = new_project()
    docs = ["model"]
    for i in range(1, len(chunks)):
        docs.append(add_file(pid, f"part{i}")["entry"]["id"])
    for doc, lines in zip(docs, chunks):
        response = apply(pid, doc, "\n".join(lines) + "\n")
        assert response.status_code == 200, response.text
    return pid, docs


def test_ac12_query_checks_validation_and_reasoning_agree_split_or_whole():
    lines = split_statements()
    one, _ = project_with([lines])
    ten, _ = project_with([lines[i::10] for i in range(10)])
    query = "SELECT ?s ?o WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?o } ORDER BY ?s ?o"
    answers = []
    for pid in (one, ten):
        rows = client.post(f"/api/ontologies/{pid}-model/sparql", json={"query": query}).json()["rows"]
        report = client.get(f"/api/ontologies/{pid}-model/checks").json()
        groups = {g["id"]: (g["total"], sorted(json.dumps(f, sort_keys=True) for f in g["findings"]))
                  for g in report["groups"]}
        valid = client.post(f"/api/projects/{pid}/validate").json()
        reasoned = client.post(f"/api/projects/{pid}/reasoning", json={}).json()
        answers.append((rows, groups, valid["statements"], reasoned["status"], reasoned.get("counts")))
    assert answers[0][0] == answers[1][0] and len(answers[0][0]) == 59
    assert answers[0][1] == answers[1][1]
    assert answers[0][2] == answers[1][2]
    assert answers[0][3:] == answers[1][3:]


# --- AC-13: one file's change reaches the other's views -------------------------------


def test_ac13_a_change_in_one_file_refreshes_the_others_views(plant):
    pid, core, equipment = plant
    tree = client.get(f"/api/ontologies/{pid}-{equipment}/hierarchy").json()
    assert EX + "Valve" not in tree["classes"]["nodes"]
    ok(pid, equipment, "CreateClass", label="Motor")
    ok(pid, equipment, "CreateObjectProperty", label="feeds", domain=EX + "Motor", range=EX + "Pump")
    first = client.get(f"/api/projects/{pid}/documents/{equipment}/canvas").json()
    assert {n["iri"]: n for n in first["nodes"]}[EX + "Pump"]["label"] == "Pump"
    ok(pid, core, "CreateClass", label="Valve")
    ok(pid, core, "SetLabel", iri=EX + "Pump", value="Water pump")
    tree = client.get(f"/api/ontologies/{pid}-{equipment}/hierarchy").json()
    assert tree["classes"]["nodes"][EX + "Valve"]["fromFile"]["doc"] == core
    canvas = client.get(f"/api/projects/{pid}/documents/{equipment}/canvas").json()
    boxes = {n["iri"]: n for n in canvas["nodes"]}
    assert boxes[EX + "Pump"]["label"] == "Water pump"
    assert boxes[EX + "Pump"]["fromFile"] == {"doc": core, "file": "core.ttl"}


# --- AC-14: undo per file, and the paired step ------------------------------------------


def test_ac14_undo_in_one_file_leaves_the_other(plant):
    pid, core, equipment = plant
    ok(pid, equipment, "CreateClass", label="Motor")
    core_graph = set(editing_service.document(pid, core).graph)
    core_revision = editing_service.document(pid, core).ontology.revision
    assert client.post(f"/api/projects/{pid}/documents/{equipment}/undo").status_code == 200
    assert (URIRef(EX + "Motor"), None, None) not in editing_service.document(pid, equipment).graph
    assert set(editing_service.document(pid, core).graph) == core_graph
    assert editing_service.document(pid, core).ontology.revision == core_revision
    assert client.post(f"/api/projects/{pid}/documents/{core}/undo").status_code == 200
    assert (URIRef(EX + "Pump"), None, None) not in editing_service.document(pid, core).graph


def test_ac14_a_branch_step_in_a_file_pairs_with_the_main_shapes_file():
    pid = new_project(template="small")
    terms = add_file(pid, "terms", "vocabulary")["entry"]["id"]
    ok(pid, terms, "CreateClass", label="Machine")
    ok(pid, terms, "CreateConcept", prefLabel="Colour")
    made = ok(pid, terms, "CreateBranchRelationship", label="colour", domain=EX + "Machine", branch=EX + "Colour")
    assert made["partner"]["doc"] == "shapes"
    prop = URIRef(made["created"])
    assert (prop, None, None) in editing_service.document(pid, terms).graph
    shapes_revision = editing_service.document(pid, "shapes").ontology.revision
    model_revision = editing_service.document(pid, "model").ontology.revision
    undone = client.post(f"/api/projects/{pid}/documents/{terms}/undo").json()
    assert undone["partner"]["doc"] == "shapes"
    assert editing_service.document(pid, "shapes").ontology.revision == shapes_revision + 1
    assert (prop, None, None) not in editing_service.document(pid, terms).graph
    # model.ttl was never part of it.
    assert editing_service.document(pid, "model").ontology.revision == model_revision


# --- AC-15: rename and move --------------------------------------------------------------


def test_ac15_rename_and_move_keep_id_iris_history_and_layout(plant):
    pid, core, equipment = plant
    layout = {"positions": {EX + "Pump": [1.0, 2.0]}, "shown": None, "viewport": None, "placed": []}
    assert client.put(f"/api/projects/{pid}/documents/{core}/layout", json=layout).status_code == 200
    graph = set(editing_service.document(pid, core).graph)
    renamed = client.patch(f"/api/projects/{pid}/documents/{core}", json={"name": "base"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["entry"] == {"id": core, "file": "base.ttl", "role": "ontology"}
    moved = client.patch(f"/api/projects/{pid}/documents/{core}", json={"folder": "vocab"})
    assert moved.json()["entry"]["file"] == "vocab/base.ttl"
    folder_path = project_store.folder(pid)
    assert (folder_path / "vocab" / "base.ttl").is_file() and not (folder_path / "core.ttl").exists()
    document = editing_service.document(pid, core)
    assert set(document.graph) == graph and document.undo
    assert client.get(f"/api/projects/{pid}/documents/{core}/layout").json()["positions"] == {EX + "Pump": [1.0, 2.0]}
    assert client.post(f"/api/projects/{pid}/documents/{core}/save").status_code == 200
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert {d["doc"]: d["file"] for d in opened["documents"]}[core] == "vocab/base.ttl"
    assert (URIRef(EX + "Pump"), None, None) in editing_service.document(pid, core).graph
    # model.ttl renamed keeps its id.
    assert client.patch(f"/api/projects/{pid}/documents/model", json={"name": "main"}).status_code == 200
    assert editing_service.document(pid, "model").file == "main.ttl"


def test_ac15_rename_refuses_a_clash_and_changes_nothing(plant):
    pid, core, equipment = plant
    add_file(pid, "other")
    refused = client.patch(f"/api/projects/{pid}/documents/{core}", json={"name": "OTHER"})
    assert refused.status_code == 422 and refused.json()["detail"]["field"] == "name"
    assert editing_service.document(pid, core).file == "core.ttl"
    # A change of case alone is the same file: allowed.
    assert client.patch(f"/api/projects/{pid}/documents/{core}", json={"name": "Core"}).status_code == 200


# --- AC-16: remove ------------------------------------------------------------------------


def test_ac16_remove_moves_to_the_trash_and_the_last_model_file_stays(plant):
    pid, core, equipment = plant
    removed = client.delete(f"/api/projects/{pid}/documents/{core}")
    assert removed.status_code == 200, removed.text
    trashed = removed.json()["trashed"]
    assert trashed.startswith(".trash/") and (project_store.folder(pid) / trashed).is_file()
    assert all(d.get("id") != core for d in project_store.manifest(pid)["documents"])
    tree = client.get(f"/api/ontologies/{pid}-{equipment}/hierarchy").json()
    assert EX + "Pump" not in tree["classes"]["nodes"]
    assert client.get(f"/api/projects/{pid}/documents/{core}/source").status_code == 404
    assert client.delete(f"/api/projects/{pid}/documents/{equipment}").status_code == 200
    last = client.delete(f"/api/projects/{pid}/documents/model")
    assert last.status_code == 422
    assert last.json()["detail"] == "model.ttl is the project's last ontology or vocabulary file, so it cannot be removed."


# --- AC-17: drafts by id, recovery all or none --------------------------------------------


def _rewrite_draft(folder: Path, doc: str, text: str) -> None:
    """A draft's text changed by hand, its sidecar's hash with it: recovery
    drops a draft whose sidecar names another text (CF-14), and this is a
    draft the sidecar speaks for that does not parse."""
    import hashlib

    data = text.encode("utf-8")
    (folder / f"{doc}.ttl").write_bytes(data)
    meta = json.loads((folder / f"{doc}.json").read_text(encoding="utf-8"))
    meta["sha256"] = hashlib.sha256(data).hexdigest()
    (folder / f"{doc}.json").write_text(json.dumps(meta), encoding="utf-8")


def test_ac17_a_nested_file_drafts_by_id_and_recovery_is_all_or_none(plant, monkeypatch):
    from app import editing

    pid, core, equipment = plant
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.01)
    ok(pid, equipment, "CreateClass", label="Motor")
    ok(pid, core, "CreateClass", label="Valve")
    draft = project_store.folder(pid) / ".draft"
    deadline = time.time() + 5
    written = lambda: all((draft / f"{d}.{x}").exists() for d in (core, equipment) for x in ("ttl", "json"))  # noqa: E731
    while time.time() < deadline and not written():
        time.sleep(0.02)
    assert written()
    assert not (project_store.folder(pid) / "vocab" / ".draft").exists()
    # The server stops: nothing saved, the open documents forgotten.
    for document in editing_service._open.pop(pid).values():
        editing_service._cancel(document)
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert opened["recovery"]["available"] is True
    # One draft broken: nothing is restored.
    _rewrite_draft(draft, equipment, "this is not turtle")
    assert client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).status_code == 422
    assert (URIRef(EX + "Valve"), None, None) not in editing_service.document(pid, core).graph
    assert all(not d.dirty for d in editing_service._open[pid].values())
    _rewrite_draft(draft, equipment, f"<{EX}Motor> a <http://www.w3.org/2002/07/owl#Class> .\n")
    restored = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).json()
    assert {d["doc"] for d in restored["documents"] if d["dirty"]} == {core, equipment}
    assert (URIRef(EX + "Valve"), None, None) in editing_service.document(pid, core).graph
    assert (URIRef(EX + "Motor"), None, None) in editing_service.document(pid, equipment).graph


# --- AC-18: duplicate and export ------------------------------------------------------------


def test_ac18_duplicate_and_export_keep_folders_without_draft_and_trash(plant):
    import io
    import zipfile

    pid, core, equipment = plant
    folder_path = project_store.folder(pid)
    (folder_path / ".draft").mkdir(exist_ok=True)
    (folder_path / ".draft" / "x.ttl").write_text("x", encoding="utf-8")
    (folder_path / ".trash").mkdir(exist_ok=True)
    (folder_path / ".trash" / "old.ttl").write_text("x", encoding="utf-8")
    copy = client.post(f"/api/projects/{pid}/duplicate").json()["id"]
    copied = project_store.folder(copy)
    assert (copied / "vocab" / "equipment.ttl").is_file() and (copied / "core.ttl").is_file()
    assert not (copied / ".draft").exists() and not (copied / ".trash").exists()
    assert [d["id"] for d in project_store.manifest(copy)["documents"]] == [
        d["id"] for d in project_store.manifest(pid)["documents"]
    ]
    names = zipfile.ZipFile(io.BytesIO(client.get(f"/api/projects/{pid}/export").content)).namelist()
    assert "vocab/equipment.ttl" in names and "core.ttl" in names
    assert not any(n.startswith((".draft", ".trash")) for n in names)


def test_export_and_duplicate_never_follow_a_link(tmp_path, plant):
    import io
    import zipfile

    pid, core, equipment = plant
    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "key.ttl").write_text("secret", encoding="utf-8")
    try:
        os.symlink(secret, project_store.folder(pid) / "out", target_is_directory=True)
        os.symlink(secret / "key.ttl", project_store.folder(pid) / "key.ttl")
    except (OSError, NotImplementedError):
        pytest.skip("this machine cannot make a symbolic link")
    names = zipfile.ZipFile(io.BytesIO(client.get(f"/api/projects/{pid}/export").content)).namelist()
    assert not any("key.ttl" in n for n in names)
    copy = client.post(f"/api/projects/{pid}/duplicate").json()["id"]
    assert not (project_store.folder(copy) / "out").exists()
    assert not (project_store.folder(copy) / "key.ttl").exists()


# --- AC-19: Home's counts ----------------------------------------------------------------------


def test_ac19_home_counts_are_project_totals(plant):
    pid, core, equipment = plant
    ok(pid, equipment, "CreateClass", label="Motor")
    ok(pid, "model", "CreateClass", label="Site")
    assert client.post(f"/api/projects/{pid}/documents/{equipment}/save").status_code == 200
    listed = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert listed["counts"]["classes"] == 3


# --- AC-20: the lock order --------------------------------------------------------------------


def test_ac20_commands_in_two_files_that_read_each_other_never_wait_forever(plant):
    import threading

    pid, core, equipment = plant
    failures: list = []

    def work(doc: str, label: str) -> None:
        try:
            for i in range(100):
                editing_service.command(pid, doc, "CreateClass", {"label": f"{label} {i}", "parent": EX + "Pump"})
                editing_service.canvas_view(pid, doc)
        except Exception as exc:  # noqa: BLE001 - any failure fails the test
            failures.append(exc)

    threads = [threading.Thread(target=work, args=(core, "Core")),
               threading.Thread(target=work, args=(equipment, "Equipment"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not any(t.is_alive() for t in threads), "a command waited on another for ever"
    assert failures == []
    assert len(editing_service.document(pid, equipment).undo) == 100


# --- AC-29: a folder's rename (5.10 item 1, PR 2) -----------------------------------------------


def rename_folder(pid: str, path: str, name: str):
    return client.patch(f"/api/projects/{pid}/folders", json={"path": path, "name": name})


@pytest.fixture
def nested():
    """vocab/equipment.ttl with an unsaved change and a layout, and
    vocab/parts/bolt.ttl under it: a folder with files at two levels."""
    pid = new_project()
    folder(pid, "vocab")
    folder(pid, "vocab/parts")
    equipment = add_file(pid, "equipment", folder="vocab")["entry"]["id"]
    bolt = add_file(pid, "bolt", folder="vocab/parts")["entry"]["id"]
    ok(pid, equipment, "CreateClass", label="Pump")
    layout = {"positions": {EX + "Pump": [3.0, 4.0]}, "shown": None, "viewport": None, "placed": []}
    assert client.put(f"/api/projects/{pid}/documents/{equipment}/layout", json=layout).status_code == 200
    return pid, equipment, bolt


def test_ac29_a_folder_rename_moves_the_paths_and_nothing_else(nested):
    pid, equipment, bolt = nested
    graph = set(editing_service.document(pid, equipment).graph)
    before = editing_service.document(pid, equipment).ontology.revision
    shift = client.post(f"/api/projects/{pid}/open").json()["revisionShift"]
    renamed = rename_folder(pid, "vocab", "kit")
    assert renamed.status_code == 200, renamed.text
    body = renamed.json()
    assert body["folders"] == ["kit", "kit/parts"]
    assert {f["id"]: f["file"] for f in body["files"]} == {
        equipment: "kit/equipment.ttl", bolt: "kit/parts/bolt.ttl",
    }
    assert {d["doc"]: d["file"] for d in body["documents"]} == {
        equipment: "kit/equipment.ttl", bolt: "kit/parts/bolt.ttl",
    }
    # On disk and in the manifest, in one write; the ids are the same.
    assert [p for p in inside(pid) if not p.startswith(".draft")] == sorted(
        [f"{equipment}.layout.json", "kit", "kit/equipment.ttl", "kit/parts",
         "kit/parts/bolt.ttl", "model.ttl", "project.json"]
    )
    assert {d["id"]: d["file"] for d in project_store.manifest(pid)["documents"]} == {
        "model": "model.ttl", equipment: "kit/equipment.ttl", bolt: "kit/parts/bolt.ttl",
    }
    # Statements, undo history, the unsaved change and the layout all stay.
    document = editing_service.document(pid, equipment)
    assert set(document.graph) == graph and document.ontology.revision == before
    assert document.dirty and document.undo and document.undo[-1].label == "Created class Pump"
    assert client.get(f"/api/projects/{pid}/documents/{equipment}/layout").json()["positions"] == {
        EX + "Pump": [3.0, 4.0]
    }
    # The whole-project revision moved, so every file's views refetch (the
    # one write counts once, whatever the rename moved).
    assert body["revisionShift"] == shift + 1
    # A save after the rename writes the new path, not the old one.
    assert client.post(f"/api/projects/{pid}/documents/{equipment}/save").status_code == 200
    assert (project_store.folder(pid) / "kit" / "equipment.ttl").read_text(encoding="utf-8").find("Pump") > 0
    assert not (project_store.folder(pid) / "vocab").exists()
    # And it is still there, under its id, when the project is opened again.
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert {d["doc"]: d["file"] for d in opened["documents"]}[equipment] == "kit/equipment.ttl"
    assert opened["found"] == [] and opened["missing"] == []


def test_ac29_a_rename_to_only_another_case_is_allowed(nested):
    pid, equipment, bolt = nested
    renamed = rename_folder(pid, "vocab", "Vocab")
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["folders"] == ["Vocab", "Vocab/parts"]
    assert editing_service.document(pid, equipment).file == "Vocab/equipment.ttl"
    assert [p.name for p in project_store.folder(pid).iterdir() if p.is_dir() and p.name != ".draft"] == ["Vocab"]


@pytest.mark.parametrize(
    "name,field",
    [
        ("..", "name"),
        ("../out", "name"),
        ("/abs", "name"),
        ("a\b", "name"),
        ("C:", "name"),
        ("CON", "name"),
        ("spare.", "name"),
        ("queries", "name"),
        ("", "name"),
        ("parts/deep", "name"),
    ],
)
def test_ac29_a_refused_name_changes_nothing(nested, name, field):
    pid, equipment, bolt = nested
    outside = disk(pid)
    refused = rename_folder(pid, "vocab", name)
    assert refused.status_code == 422, (name, refused.text)
    assert refused.json()["detail"]["field"] == field
    assert isinstance(refused.json()["detail"]["message"], str)
    assert editing_service.document(pid, equipment).file == "vocab/equipment.ttl"
    assert (project_store.folder(pid) / "vocab" / "equipment.ttl").is_file()
    assert disk(pid) == outside


def test_ac29_a_name_a_sibling_holds_is_refused_without_case(nested):
    pid, equipment, bolt = nested
    folder(pid, "spare")
    clash = rename_folder(pid, "vocab", "SPARE")
    assert clash.status_code == 422
    assert clash.json()["detail"] == {
        "code": "path", "field": "name",
        "message": "There is already a folder called spare in this folder.",
    }
    # A file's name at the same level clashes too.
    add_file(pid, "notes")
    assert rename_folder(pid, "vocab", "notes.ttl").status_code == 422
    assert editing_service.document(pid, equipment).file == "vocab/equipment.ttl"


def test_ac29_the_folder_must_be_one_the_project_has(nested):
    pid, equipment, bolt = nested
    missing = rename_folder(pid, "nowhere", "kit")
    assert missing.status_code == 422 and missing.json()["detail"]["field"] == "folder"
    assert rename_folder(pid, "", "kit").json()["detail"]["message"] == (
        "The project folder itself cannot be renamed."
    )
    assert client.patch("/api/projects/prj-000000000000/folders", json={"path": "vocab", "name": "kit"}).status_code == 404
    assert rename_folder(pid, "vocab", 7).status_code == 422


def test_ac29_a_folder_that_is_a_link_out_is_refused(tmp_path, nested):
    """A folder reached through a link leads out of the project (5.2 item 4):
    refused before anything is renamed, as every other path is."""
    pid, equipment, bolt = nested
    away = tmp_path / "away"
    away.mkdir()
    (away / "sneak.ttl").write_text("# nothing", encoding="utf-8")
    link = project_store.folder(pid) / "linked"
    try:
        link.symlink_to(away, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this platform does not allow a symbolic link here")
    refused = rename_folder(pid, "linked", "kit")
    assert refused.status_code == 422
    assert refused.json()["detail"]["message"] == "That path leads outside the project folder."
    assert (away / "sneak.ttl").is_file() and away.name == "away"


# --- AC-22: every new route needs the client header ---------------------------------------------


def test_ac22_the_new_routes_refuse_a_request_without_the_client_header(plant):
    pid, core, equipment = plant
    bare = TestClient(app, base_url="http://localhost")
    for method, path, body in [
        ("POST", f"/api/projects/{pid}/documents", {"role": "ontology", "name": "x"}),
        ("PATCH", f"/api/projects/{pid}/documents/{core}", {"name": "y"}),
        ("DELETE", f"/api/projects/{pid}/documents/{core}", None),
        ("POST", f"/api/projects/{pid}/folders", {"path": "z"}),
        ("PATCH", f"/api/projects/{pid}/folders", {"path": "vocab", "name": "kit"}),
        ("DELETE", f"/api/projects/{pid}/folders", {"path": "vocab"}),
    ]:
        assert bare.request(method, path, json=body).status_code == 403, (method, path)
    assert editing_service.document(pid, core).file == "core.ttl"
    assert not (project_store.folder(pid) / "x.ttl").exists() and (project_store.folder(pid) / "vocab").is_dir()


def test_folders_are_made_and_removed_only_when_empty(plant):
    pid, core, equipment = plant
    assert folder(pid, "spare") == ["spare", "vocab"]
    full = client.request("DELETE", f"/api/projects/{pid}/folders", json={"path": "vocab"})
    assert full.status_code == 422 and full.json()["detail"]["message"] == "Only an empty folder can be removed."
    emptied = client.request("DELETE", f"/api/projects/{pid}/folders", json={"path": "spare"})
    assert emptied.json()["folders"] == ["vocab"]


# --- found in the code review ---------------------------------------------------------------


def test_the_project_revision_never_comes_round_again(plant):
    """5.3 item 7 with the shift: removing an unedited file leaves the bare
    sum where it was, so a validation or a reasoning result would still read
    as current over a file that is gone."""
    pid, core, equipment = plant
    assert client.post(f"/api/projects/{pid}/open").json()["revisionShift"] == 2  # two files added
    first = client.post(f"/api/projects/{pid}/validate").json()["revisions"]["model"]
    removed = client.delete(f"/api/projects/{pid}/documents/{equipment}").json()
    assert removed["revisionShift"] == 3  # equipment's revision 0, and 1
    after = client.post(f"/api/projects/{pid}/validate").json()["revisions"]["model"]
    assert after > first
    renamed = client.patch(f"/api/projects/{pid}/documents/{core}", json={"name": "base"}).json()
    assert renamed["revisionShift"] == 4
    assert client.post(f"/api/projects/{pid}/validate").json()["revisions"]["model"] > after


def test_the_comments_question_is_asked_for_each_file(plant):
    pid, core, equipment = plant
    commented = "# kept by hand\n" + f"<{EX}Gauge> a <http://www.w3.org/2002/07/owl#Class> .\n"
    for doc in ("model", core):
        path = editing_service.document(pid, doc).path
        text = path.read_text(encoding="utf-8")
        path.write_text(commented + text, encoding="utf-8")
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    client.post(f"/api/projects/{pid}/open")
    for doc, backup in (("model", "model.original.ttl"), (core, "core.original.ttl")):
        ok(pid, doc, "CreateClass", label=f"Visual {doc}")
        asked = client.post(f"/api/projects/{pid}/documents/{doc}/save").json()
        assert asked == {"needsCommentsWarning": True, "backup": backup}
        saved = client.post(f"/api/projects/{pid}/documents/{doc}/save", json={"confirmRewrite": True})
        assert saved.status_code == 200
        assert (editing_service.document(pid, doc).path.parent / backup).is_file()
    manifest = project_store.manifest(pid)
    assert manifest["commentsWarned"] is True and manifest["commentsWarnedDocs"] == [core]


def test_a_case_change_outside_the_app_on_a_case_sensitive_disk(tmp_path):
    probe = tmp_path / "Probe"
    probe.write_text("x", encoding="utf-8")
    if (tmp_path / "probe").exists():
        pytest.skip("this filesystem ignores case, so one name is one file")
    pid = new_project()
    core = add_file(pid, "Core")["entry"]["id"]
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    folder_path = project_store.folder(pid)
    (folder_path / "Core.ttl").rename(folder_path / "core.ttl")
    opened = client.post(f"/api/projects/{pid}/open")
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["missing"] == ["Core.ttl"] and body["found"] == ["core.ttl"]
    assert core not in {d["doc"] for d in body["documents"]}


def test_removing_model_ttl_keeps_its_saved_queries(plant):
    pid, core, equipment = plant
    saved = client.post("/api/queries", json={
        "name": "All classes", "ontologyId": f"{pid}-model", "mode": "text",
        "sparql": "SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> }",
    })
    assert saved.status_code == 200, saved.text
    assert client.delete(f"/api/projects/{pid}/documents/model").status_code == 200
    listed = client.get("/api/queries", params={"ontology": f"{pid}-{core}"}).json()
    assert [q["name"] for q in listed] == ["All classes"]
    report = client.get(f"/api/ontologies/{pid}-{core}/checks").json()
    assert [q["name"] for q in report["aids"]["questions"]] == ["All classes"]


def test_no_model_file_left_never_lands_on_a_file_that_is_there():
    pid = new_project()
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    folder_path = project_store.folder(pid)
    # model.ttl now holds shapes: found again as a shapes file, and the
    # project has no ontology file left.
    (folder_path / "model.ttl").write_text(
        "@prefix sh: <http://www.w3.org/ns/shacl#> .\n"
        f"<{EX}S> a sh:NodeShape ; sh:targetClass <{EX}Pump> .\n", encoding="utf-8")
    manifest = project_store.manifest(pid)
    manifest["documents"] = []
    project_store.write_manifest(pid, manifest)
    opened = client.post(f"/api/projects/{pid}/open").json()
    files = {d["file"]: d for d in opened["documents"]}
    assert files["model.ttl"]["role"] == "shapes" and files["model.ttl"]["doc"] != "model"
    assert files["model 2.ttl"]["role"] == "ontology" and opened["wroteModel"] is True
    assert len({d["doc"] for d in opened["documents"]}) == len(opened["documents"])


def test_shapes_ttl_at_the_root_is_kept_for_a_shapes_file(plant):
    pid, core, equipment = plant
    refused = client.post(f"/api/projects/{pid}/documents", json={"role": "ontology", "name": "shapes"})
    assert refused.status_code == 422
    assert refused.json()["detail"]["message"] == "At the project folder, shapes.ttl is kept for a shapes file."
    assert client.patch(f"/api/projects/{pid}/documents/{core}", json={"name": "shapes"}).status_code == 422
    # In a folder the name is free, and the first shape command still makes
    # shapes.ttl at the root.
    add_file(pid, "shapes", folder="vocab")
    made = client.post(f"/api/projects/{pid}/documents/shapes/commands",
                       json={"command": "CreateShape", "args": {"target": EX + "Pump"}})
    assert made.status_code == 200, made.text
    assert (project_store.folder(pid) / "shapes.ttl").is_file()


# --- Section 10: the budgets ------------------------------------------------------------------

PREFIXES = (
    f"@prefix plant: <{EX}> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
)
CLASSES = 3334  # three statements each: 10,002 in all


def _class_line(i: int) -> str:
    parent = f" ; rdfs:subClassOf plant:C{(i - 1) // 2}" if i else ""
    return f'plant:C{i} a owl:Class ; rdfs:label "Class {i}"@en{parent} .'


def _median_ms(action, setup=None, samples: int = 5) -> float:
    """Median of five with the collector off (D-024), as test_editing's."""
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


def _ten_files() -> tuple[str, list[str]]:
    """10,000 statements over ten ontology files, a class's parent most
    often in another file: written to disk while closed, then opened, so
    the files are the manifest's and nothing is found."""
    pid = new_project("Ten")
    docs = ["model"] + [add_file(pid, f"part{n}")["entry"]["id"] for n in range(1, 10)]
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    files = {d["id"]: d["file"] for d in project_store.manifest(pid)["documents"]}
    for n, doc in enumerate(docs):
        lines = [_class_line(i) for i in range(CLASSES) if i % 10 == n]
        (project_store.folder(pid) / files[doc]).write_text(PREFIXES + "\n".join(lines) + "\n", encoding="utf-8")
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    assert sum(len(editing_service.document(pid, d).graph) for d in docs) >= 10_000
    return pid, docs


def _one_file() -> str:
    pid = new_project("One")
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    lines = [_class_line(i) for i in range(CLASSES)]
    (project_store.folder(pid) / "model.ttl").write_text(PREFIXES + "\n".join(lines) + "\n", encoding="utf-8")
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


@pytest.mark.perf
def test_command_budget_ten_files():
    """A command in one file of ten holding 10,000 statements, its parent in
    another file: <= 50 ms, median of five, as test_command_budget."""
    pid, docs = _ten_files()
    counter = iter(range(100))
    # The parent, C1, is in part1; the command runs in part5.
    median = _median_ms(lambda: ok(pid, docs[5], "CreateClass", label=f"Timed {next(counter)}", parent=EX + "C1"))
    assert median <= limit_ms(50), f"a command took {median:.1f} ms (median of 5)"


@pytest.mark.perf
def test_canvas_budget_ten_files():
    """The canvas view of one file in that project, built afresh for each
    sample, the view of the other files included: <= 150 ms."""
    pid, docs = _ten_files()
    document = editing_service.document(pid, docs[5])

    def invalidate():
        document._canvas = None
        document.ontology.file_cache = None

    client.get(f"/api/projects/{pid}/documents/{docs[5]}/canvas")  # warm-up
    median = _median_ms(lambda: client.get(f"/api/projects/{pid}/documents/{docs[5]}/canvas"), setup=invalidate)
    assert median <= limit_ms(150), f"the canvas view took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_open_ratio():
    """Opening the ten-file project is at most 1.5 times opening one file of
    the same 10,000 statements, measured here, the two interleaved: a ratio
    of two timings on one machine, so not scaled (budget.py)."""
    ten, _ = _ten_files()
    one = _one_file()
    times: dict = {one: [], ten: []}
    gc.disable()
    try:
        for _ in range(5):
            for pid in (one, ten):
                client.post(f"/api/projects/{pid}/close", json={"discard": True})
                start = time.perf_counter()
                assert client.post(f"/api/projects/{pid}/open").status_code == 200
                times[pid].append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = {pid: sorted(t)[2] for pid, t in times.items()}
    ratio = median[ten] / median[one]
    assert ratio <= 1.5, f"ten files opened in {median[ten]:.0f} ms, one in {median[one]:.0f} ms: {ratio:.2f}x"
