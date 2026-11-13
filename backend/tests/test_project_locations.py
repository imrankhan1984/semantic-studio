"""
================================================================================
FILE: backend/tests/test_project_locations.py
================================================================================

SUMMARY
    Projects anywhere, PR 1 (projects-anywhere 5.1 to 5.6, AC-1 to AC-10):
    a project made in a folder the person chose, a project folder opened
    from elsewhere, a moved folder located, Remove from Home, and what
    Delete and Duplicate do for a project that is not in the app's folder.

BASIC IDEA
    Every test works in a temporary "home" folder: folders.home is moved
    there, so the refused-folder table's AppData and C:\\Users rules point
    inside it, and the real AppData that holds pytest's temporary folders
    on Windows is not refused. The registry is the shared data folder's,
    so it is removed after each test, as vocabularies.json is.

    The security rows (Section 9) are held as the spec words them: a hostile
    project.json refused field by field with nothing registered; a document
    path climbing out dropped by the index and its file's marker in no
    answer; a folder copied by hand two ids, a change in one leaving the
    other's bytes; Delete 409 and the folder's listing unchanged; and an
    AST scan proving only projects.py touches project-locations.json, which
    is shown to catch a reader planted for it first.

INPUTS / INPUT SOURCES
    - The app through TestClient, with the client header.
    - Hostile project.json values, built here (rdf-fixture: inline, minimal).

EXPECTED OUTPUT
    - Pass/fail; two budgets (Section 10) under the `perf` mark.
================================================================================
"""

import ast
import gc
import json
import os
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import folders, projects
from app.editing import editing_service, project_store
from app.main import app
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})
APP = Path(__file__).resolve().parents[1] / "app"


@pytest.fixture(autouse=True)
def _clean():
    yield
    editing_service.close_all()
    project_store.registry_path.unlink(missing_ok=True)


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    """A home folder of the test's own, with a Work folder in it."""
    here = tmp_path / "home"
    (here / "Work").mkdir(parents=True)
    monkeypatch.setattr(folders, "home", lambda: here)
    return here


def _create(**body) -> dict:
    body.setdefault("name", "Test project")
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _listing(folder: Path) -> list[tuple[str, bytes]]:
    """Every file under a folder with its bytes: "unchanged" means this."""
    out = []
    for path in sorted(folder.rglob("*")):
        if path.is_file():
            out.append((path.relative_to(folder).as_posix(), path.read_bytes()))
    return out


def _elsewhere(home: Path, name: str = "Motors", template: str = "small") -> Path:
    """A project the app made, its folder copied to the Work folder, as a
    colleague's or a Git clone would arrive; the default-folder original
    is trashed so only the copy is the project."""
    made = _create(name=name, template=template)
    target = home / "Work" / name
    shutil.copytree(project_store.folder(made["id"]), target)
    client.delete(f"/api/projects/{made['id']}")
    return target


def _open(folder: Path):
    return client.post("/api/projects/locations", json={"folder": str(folder)})


def _message(response) -> str:
    """The sentence of a refusal: a path refusal carries its field too."""
    detail = response.json()["detail"]
    return detail["message"] if isinstance(detail, dict) else detail


# --- AC-1: create in a chosen folder -----------------------------------------------


def test_ac1_create_in_chosen_folder(home):
    made = _create(name="Motor catalogue", template="small", location={"parent": str(home / "Work")})
    target = home / "Work" / "Motor catalogue"
    assert made["folder"] == str(target) and made["missing"] is False
    names = sorted(p.name for p in target.iterdir())
    assert names == [".gitignore", "model.ttl", "project.json", "shapes.ttl"]
    assert (target / ".gitignore").read_bytes() == b".draft/\n.trash/\ndata/\n"
    registry = json.loads(project_store.registry_path.read_text(encoding="utf-8"))
    assert registry[made["id"]]["folder"] == str(target)
    listed = {p["id"]: p for p in client.get("/api/projects").json()}
    assert listed[made["id"]]["folder"] == str(target)
    # Nothing in the default folder for it.
    assert not (project_store.dir / made["id"]).exists()
    # It opens and saves where it lives.
    opened = client.post(f"/api/projects/{made['id']}/open")
    assert opened.status_code == 200 and opened.json()["project"]["folder"] == str(target)
    pid = made["id"]
    assert client.post(f"/api/projects/{pid}/documents/model/commands",
                       json={"command": "CreateClass", "args": {"label": "Pump"}}).status_code == 200
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 200
    assert "Pump" in (target / "model.ttl").read_text(encoding="utf-8")


def test_ac1_a_library_copy_takes_a_location_too(home):
    loaded = client.post(
        "/api/ontologies/upload",
        files={"file": ("lib.ttl", b"@prefix ex: <http://example.org/l#> .\n"
                                   b"@prefix owl: <http://www.w3.org/2002/07/owl#> .\nex:A a owl:Class .\n", "text/turtle")},
    )
    assert loaded.status_code == 200, loaded.text
    made = _create(name="From the library", fromOntologyId=loaded.json()["id"], location={"parent": str(home / "Work")})
    assert (home / "Work" / "From the library" / "model.ttl").is_file()
    assert made["folder"] == str(home / "Work" / "From the library")
    client.delete(f"/api/ontologies/{loaded.json()['id']}")


# The subfolder rule's one table, read by frontend/src/projects/folderWords.test.ts too.
FOLDER_NAMES = json.loads(
    (Path(__file__).resolve().parents[2] / "frontend" / "src" / "projects" / "folderName.table.json").read_text(encoding="utf-8")
)


def test_ac1_the_subfolder_rule_matches_the_browsers():
    assert len(FOLDER_NAMES["names"]) > 10
    for name, made in FOLDER_NAMES["names"]:
        if made is None:
            with pytest.raises(folders.FolderRefused):
                folders.folder_name(name)
        else:
            assert folders.folder_name(name) == made, name


def test_ac1_the_subfolder_name_is_made_from_the_project_name():
    assert folders.folder_name("Motor catalogue") == "Motor catalogue"
    assert folders.folder_name("Motors/Pumps: v2?") == "Motors-Pumps- v2-"
    assert folders.folder_name("  ..Hidden") == "Hidden"
    assert len(folders.folder_name("x" * 200)) == 64
    for device in ("CON", "nul", "com1", "LPT3.txt"):
        with pytest.raises(folders.FolderRefused):
            folders.folder_name(device)


def test_ac1_a_failed_registry_write_removes_only_what_was_written(home, monkeypatch):
    def broken(_registry):
        raise OSError("disk full")

    monkeypatch.setattr(project_store, "_write_registry", broken)
    before = sorted(p.name for p in (home / "Work").iterdir())
    response = client.post("/api/projects", json={"name": "Gone", "location": {"parent": str(home / "Work")}})
    assert response.status_code == 422
    assert sorted(p.name for p in (home / "Work").iterdir()) == before
    assert not project_store.registry_path.exists()


# --- AC-2: the default folder unchanged ------------------------------------------------


def test_ac2_default_folder_unchanged(home):
    made = [_create(name=f"Default {i}", template="small") for i in range(2)]
    manifests = {p["id"]: (project_store.dir / p["id"] / "project.json").read_bytes() for p in made}
    listed = {p["id"]: p for p in client.get("/api/projects").json()}
    for pid in manifests:
        assert listed[pid]["folder"] is None and listed[pid]["missing"] is False
        assert client.post(f"/api/projects/{pid}/open").status_code == 200
        client.post(f"/api/projects/{pid}/close", json={"discard": True})
    assert not project_store.registry_path.exists()
    for pid, data in manifests.items():
        assert (project_store.dir / pid / "project.json").read_bytes() == data


# --- AC-3: an existing subfolder ----------------------------------------------------------


def test_ac3_existing_subfolder_refused_nothing_written(home):
    target = home / "Work" / "Motor catalogue"
    target.mkdir()
    (target / "notes.txt").write_text("mine", encoding="utf-8")
    before_default = sorted(p.name for p in project_store.dir.iterdir())
    response = client.post("/api/projects", json={"name": "Motor catalogue", "location": {"parent": str(home / "Work")}})
    assert response.status_code == 422
    assert _message(response) == f"{target} already exists. Choose another name or folder."
    assert response.json()["detail"]["field"] == "location"
    assert [p.name for p in target.iterdir()] == ["notes.txt"]
    assert sorted(p.name for p in project_store.dir.iterdir()) == before_default
    assert not project_store.registry_path.exists()


@pytest.mark.parametrize("where", ["data", "inside", "root"])
def test_ac3_a_refused_parent_writes_nothing(home, where):
    if where == "data":
        parent = store.data_dir
    elif where == "inside":
        parent = _elsewhere(home)
        _open(parent)
    else:
        parent = Path(str(home.anchor))
    before = sorted(p.name for p in parent.iterdir())
    response = client.post("/api/projects", json={"name": "Nested", "location": {"parent": str(parent)}})
    assert response.status_code == 422, response.text
    assert sorted(p.name for p in parent.iterdir()) == before
    if where == "inside":
        assert _message(response) == "That folder is inside the project Motors."


# --- AC-4: open a project folder ---------------------------------------------------------


def test_ac4_open_folder_registers_and_index_runs(home):
    folder = _elsewhere(home)
    manifest = (folder / "project.json").read_bytes()
    old_id = json.loads(manifest)["id"]
    response = _open(folder)
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert pid != old_id and projects.PROJECT_ID.fullmatch(pid)
    listed = client.get("/api/projects").json()
    assert listed[0]["id"] == pid, "a project just put on Home is listed first"
    assert listed[0]["folder"] == str(folder)
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert {d["file"] for d in opened["documents"]} == {"model.ttl", "shapes.ttl"}
    assert (folder / "project.json").read_bytes() == manifest, "the manifest is written only if the index changed something"
    # Opening registers; it never writes a .gitignore into a folder it opens.
    assert not (folder / ".gitignore").exists()


def test_ac4_a_found_file_is_indexed_on_first_open(home):
    folder = _elsewhere(home)
    (folder / "extra.ttl").write_text(
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<http://example.org/x#X> a owl:Class .\n", encoding="utf-8"
    )
    pid = _open(folder).json()["id"]
    opened = client.post(f"/api/projects/{pid}/open").json()
    assert "extra.ttl" in opened["found"]


def test_ac4_saved_queries_come_back_under_the_new_id(home):
    made = _create(name="Queries", template="small")
    client.post(f"/api/projects/{made['id']}/open")
    saved = client.post("/api/queries", json={
        "name": "All classes", "ontologyId": f"{made['id']}-model", "ontologyName": "Queries",
        "sparql": "SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> }", "mode": "text",
    })
    assert saved.status_code == 200, saved.text
    editing_service.close_all()
    target = home / "Work" / "Queries"
    shutil.copytree(project_store.folder(made["id"]), target)
    pid = _open(target).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    listed = client.get("/api/queries", params={"ontology": f"{pid}-model"}).json()
    assert [q["name"] for q in listed] == ["All classes"]
    # Read as this project's, never rewritten on disk.
    on_disk = json.loads(next((target / "queries").glob("q-*.json")).read_text(encoding="utf-8"))
    assert on_disk["ontologyId"] == f"{made['id']}-model"


def test_ac4_a_folder_without_project_json_is_refused(home):
    plain = home / "Work" / "Plain"
    plain.mkdir()
    response = _open(plain)
    assert response.status_code == 422
    assert _message(response) == folders.NO_PROJECT
    assert not project_store.registry_path.exists()


def test_ac4_a_folder_holding_a_project_below_is_refused(home):
    folder = _elsewhere(home)
    outer = home / "Work"
    shutil.copy(folder / "project.json", outer / "project.json")
    response = _open(outer)
    assert response.status_code == 422
    assert _message(response) == "That folder holds the project Motors."
    # And the one inside it is inside the other.
    inner = _open(folder)
    assert inner.status_code == 422
    assert "is inside the project" in _message(inner)


# --- AC-5: a hostile project.json ---------------------------------------------------------


def _hostile(home: Path, change) -> Path:
    folder = _elsewhere(home)
    manifest = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    change(manifest)
    (folder / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


HOSTILE = {
    "base IRI holding > and a newline": (lambda m: m.update(baseIri="http://example.org/x#> .\n<a> <b> <c"), "base IRI"),
    "base IRI holding a space": (lambda m: m.update(baseIri="http://example.org/a b#"), "base IRI"),
    "prefix not a PREFIX": (lambda m: m.update(prefix="1bad prefix"), "prefix"),
    "primary language not a tag": (lambda m: m.update(primaryLanguage="english please"), "primary language"),
    "a language not a tag": (lambda m: m.update(languages=["fr", "not a tag"]), "languages"),
    "101 documents": (lambda m: m.update(documents=[{"file": f"f{i}.ttl", "role": "ontology"} for i in range(101)]), "files"),
    "a document path climbing out": (lambda m: m["documents"].append({"id": "f00000001", "file": "../../secret.ttl", "role": "ontology"}), "file path"),
    "a document id not issued": (lambda m: m["documents"].append({"id": "../x", "file": "x.ttl", "role": "ontology"}), "file id"),
    "a name with a control character": (lambda m: m.update(name="Mo\x00tors"), "name"),
    "a name too long": (lambda m: m.update(name="x" * 121), "name"),
    "no name": (lambda m: m.pop("name"), "name"),
    "an unknown kind": (lambda m: m.update(kind="spreadsheet"), "kind"),
    "a shapes base IRI with a quote": (lambda m: m.update(shapesBaseIri='http://example.org/"x#'), "shapes base IRI"),
    "an unknown reference": (lambda m: m.update(references=["evil"]), "reference"),
    "a bad snapshot id": (lambda m: m.update(data=[{"id": "../../x"}]), "data snapshot"),
    "a naming part not in the rule": (lambda m: m.update(naming={"layer": "core", "subject": "Has Space"}), "naming"),
    "counts not numbers": (lambda m: m.update(counts={"classes": "<b>9</b>"}), "counts"),
}


@pytest.mark.parametrize("case", sorted(HOSTILE))
def test_ac5_hostile_manifest_fields_refused(home, case):
    change, field = HOSTILE[case]
    folder = _hostile(home, change)
    response = _open(folder)
    assert response.status_code == 422, (case, response.text)
    message = _message(response)
    assert message.startswith("This project.json has ") and field in message, (case, message)
    assert not project_store.registry_path.exists(), "nothing is registered"
    assert all(p["folder"] != str(folder) for p in client.get("/api/projects").json())


def test_ac5_a_file_over_1_mb_and_a_non_object_are_refused(home):
    folder = _elsewhere(home)
    manifest = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    manifest["padding"] = "x" * (1024 * 1024)
    (folder / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
    response = _open(folder)
    assert response.status_code == 422 and "larger than 1 MB" in _message(response)
    (folder / "project.json").write_text("[1, 2, 3]", encoding="utf-8")
    response = _open(folder)
    assert response.status_code == 422 and "no JSON object" in _message(response)
    (folder / "project.json").write_text("{not json", encoding="utf-8")
    assert _open(folder).status_code == 422
    assert not project_store.registry_path.exists()


def test_ac5_unknown_fields_are_kept_and_the_manifest_id_is_never_read(home):
    folder = _hostile(home, lambda m: m.update(id="prj-000000000000", somethingNew={"kept": True}))
    response = _open(folder)
    assert response.status_code == 200, response.text
    assert response.json()["id"] != "prj-000000000000"
    assert json.loads((folder / "project.json").read_text(encoding="utf-8"))["somethingNew"] == {"kept": True}


def test_ac5_dotdot_path_dropped(home):
    """A document path climbing out, written after the folder came on Home
    (a Git pull): the index drops the entry at open, and the outside file's
    marker reaches no answer."""
    secret = home / "secret.ttl"
    secret.write_text(
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<http://example.org/MARKER-SECRET-7f3> a owl:Class .\n",
        encoding="utf-8",
    )
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    manifest = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    manifest["documents"].append({"id": "f00000001", "file": "../../secret.ttl", "role": "ontology"})
    (folder / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
    opened = client.post(f"/api/projects/{pid}/open")
    assert opened.status_code == 200, opened.text
    assert "MARKER-SECRET-7f3" not in opened.text
    assert "../../secret.ttl" in opened.json()["missing"]
    for doc in opened.json()["documents"]:
        oid = doc["ontologyId"]
        for url in (f"/api/ontologies/{oid}/graph", f"/api/projects/{pid}/documents/{doc['doc']}/source",
                    f"/api/ontologies/{oid}/search?q=MARKER"):
            assert "MARKER-SECRET-7f3" not in client.get(url).text, url


def test_ac5_a_hostile_base_iri_pulled_later_is_refused_at_open(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    manifest = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    manifest["baseIri"] = "http://example.org/x#> .\n<a> <b> <c"
    (folder / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
    response = client.post(f"/api/projects/{pid}/open")
    assert response.status_code == 422 and "base IRI" in response.json()["detail"]


# --- AC-6: a folder copied by hand ------------------------------------------------------


def test_ac6_copied_folder_two_ids_independent(home):
    first = _elsewhere(home)
    second = home / "Work" / "Motors copy"
    shutil.copytree(first, second)
    a = _open(first).json()["id"]
    b = _open(second).json()["id"]
    assert a != b
    ids = [p["id"] for p in client.get("/api/projects").json()]
    assert ids.count(a) == 1 and ids.count(b) == 1
    untouched = _listing(second)
    client.post(f"/api/projects/{a}/open")
    assert client.post(f"/api/projects/{a}/documents/model/commands",
                       json={"command": "CreateClass", "args": {"label": "OnlyInFirst"}}).status_code == 200
    assert client.post(f"/api/projects/{a}/documents/model/save", json={}).status_code == 200
    assert "OnlyInFirst" in (first / "model.ttl").read_text(encoding="utf-8")
    assert _listing(second) == untouched


def test_ac6_a_copy_inside_the_default_folder_lists_two_ids():
    """Measured on aca4704: two cards with one id. The id is the folder's."""
    made = _create(name="Original", template="small")
    copy = project_store.dir / "prj-0000000000c1"
    shutil.copytree(project_store.dir / made["id"], copy)
    try:
        ids = [p["id"] for p in client.get("/api/projects").json()]
        assert made["id"] in ids and "prj-0000000000c1" in ids
        assert ids.count(made["id"]) == 1
    finally:
        client.delete("/api/projects/prj-0000000000c1")


# --- AC-7: the same folder twice -----------------------------------------------------------


def test_ac7_same_folder_twice_refused(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    text = str(folder)
    # Every separator doubled but the first: a path starting // is a network
    # path on POSIX, refused before any filesystem call (below).
    first = text.index(os.sep) + 1
    doubled = text[:first] + text[first:].replace(os.sep, os.sep + os.sep)
    doors = [text, text + os.sep, doubled]
    if os.name == "nt":
        doors.append(str(folder).upper())
        doors.append(str(folder).replace("\\", "/"))
    for door in doors:
        response = client.post("/api/projects/locations", json={"folder": door})
        assert response.status_code == 409, (door, response.text)
        assert response.json()["detail"] == {"code": "already_on_home", "id": pid, "message": "This project is already on Home."}
    network = client.post("/api/projects/locations", json={"folder": "//" + text.lstrip("\\/")})
    assert network.status_code == 422 and _message(network) == folders.NETWORK, network.text
    assert len(json.loads(project_store.registry_path.read_text(encoding="utf-8"))) == 1


@pytest.mark.skipif(os.name != "nt", reason="8.3 short names are Windows'")
def test_ac7_a_short_name_is_the_same_folder(home):
    import ctypes

    folder = _elsewhere(home, name="Motor catalogue long")
    pid = _open(folder).json()["id"]
    size = ctypes.windll.kernel32.GetShortPathNameW(str(folder), None, 0)
    buffer = ctypes.create_unicode_buffer(size)
    ctypes.windll.kernel32.GetShortPathNameW(str(folder), buffer, size)
    if buffer.value == str(folder):
        pytest.skip("8.3 names are off on this volume")
    response = client.post("/api/projects/locations", json={"folder": buffer.value})
    assert response.status_code == 409 and response.json()["detail"]["id"] == pid


# --- AC-8: a moved folder ------------------------------------------------------------------


def test_ac8_missing_then_locate_keeps_id(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    person = json.loads((folder / "project.json").read_text(encoding="utf-8"))["baseIri"] + "Person"
    layout = {"version": 1, "generation": 0, "positions": {person: [1.0, 2.0]}, "shown": [], "viewport": None}
    assert client.put(f"/api/projects/{pid}/documents/model/layout", json=layout).status_code == 200
    client.post(f"/api/projects/{pid}/close", json={"discard": True})
    moved = home / "Work" / "Motors v2"
    folder.rename(moved)
    card = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert card["missing"] is True and card["folder"] == str(folder) and card["name"] == "Motors"
    assert card["counts"] == {} and card["documents"] == []
    # Every other route is 404 for it, as for an id never issued (5.5 item 3).
    assert client.post(f"/api/projects/{pid}/open").status_code == 404
    assert client.get(f"/api/projects/{pid}/export").status_code == 404
    # Locate keeps the id.
    manifest = json.loads((moved / "project.json").read_text(encoding="utf-8"))
    manifest["name"] = "Motors v2"
    (moved / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
    located = client.patch(f"/api/projects/{pid}/location", json={"folder": str(moved)})
    assert located.status_code == 200, located.text
    assert located.json()["id"] == pid and located.json()["name"] == "Motors v2"
    card = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert card["missing"] is False and card["folder"] == str(moved)
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    read = client.get(f"/api/projects/{pid}/documents/model/layout").json()
    assert read["positions"][person] == [1.0, 2.0]


def test_ac8_locate_is_404_for_a_default_folder_project_and_an_id_never_issued(home):
    made = _create(name="Here")
    assert client.patch(f"/api/projects/{made['id']}/location", json={"folder": str(home)}).status_code == 404
    assert client.patch("/api/projects/prj-0123456789ab/location", json={"folder": str(home)}).status_code == 404
    assert client.delete(f"/api/projects/{made['id']}/location").status_code == 404


# --- AC-9: Delete and Remove from Home ------------------------------------------------------


def test_ac9_delete_registered_409_folder_untouched(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    before = _listing(folder)
    response = client.delete(f"/api/projects/{pid}")
    assert response.status_code == 409
    assert response.json()["detail"] == "This project's folder is yours. Remove it from Home instead."
    assert _listing(folder) == before
    assert any(p["id"] == pid for p in client.get("/api/projects").json())


def test_ac9_remove_from_home_leaves_folder(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    client.post(f"/api/projects/{pid}/close")
    before = _listing(folder)
    response = client.delete(f"/api/projects/{pid}/location")
    assert response.status_code == 200 and response.json() == {"removed": pid}
    assert _listing(folder) == before
    assert pid not in json.loads(project_store.registry_path.read_text(encoding="utf-8"))
    assert all(p["id"] != pid for p in client.get("/api/projects").json())
    # Open project folder brings it back, with a new id (5.6 item 5).
    again = _open(folder).json()["id"]
    assert again != pid


def test_ac9_remove_from_home_with_unsaved_changes_is_409(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": "CreateClass", "args": {"label": "X"}})
    assert client.delete(f"/api/projects/{pid}/location").status_code == 409
    assert pid in json.loads(project_store.registry_path.read_text(encoding="utf-8"))


def test_ac9_a_missing_project_can_be_removed_from_home(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    folder.rename(home / "Work" / "Elsewhere")
    assert client.delete(f"/api/projects/{pid}/location").status_code == 200
    assert all(p["id"] != pid for p in client.get("/api/projects").json())


# --- AC-10: Duplicate -----------------------------------------------------------------------


def test_ac10_duplicate_goes_to_default_folder(home):
    folder = _elsewhere(home)
    (folder / ".git").mkdir()
    (folder / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    pid = _open(folder).json()["id"]
    before = sorted(p.name for p in (home / "Work").iterdir())
    copy = client.post(f"/api/projects/{pid}/duplicate")
    assert copy.status_code == 200, copy.text
    body = copy.json()
    assert body["folder"] is None and body["name"] == "Motors (copy)"
    assert (project_store.dir / body["id"] / "model.ttl").is_file()
    assert not (project_store.dir / body["id"] / ".git").exists(), "the person's repository is not the project"
    assert sorted(p.name for p in (home / "Work").iterdir()) == before


def test_rename_changes_the_name_only_never_the_folder(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    renamed = client.patch(f"/api/projects/{pid}", json={"name": "Pumps"}).json()
    assert renamed["name"] == "Pumps" and renamed["folder"] == str(folder)
    assert folder.is_dir()
    assert json.loads(project_store.registry_path.read_text(encoding="utf-8"))[pid]["name"] == "Pumps"


def test_a_project_going_missing_while_open_fails_its_next_save_with_404(home):
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": "CreateClass", "args": {"label": "X"}})
    editing_service.close_all()  # timers off: the folder is moved next
    client.post(f"/api/projects/{pid}/open")
    client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": "CreateClass", "args": {"label": "Y"}})
    for document in editing_service._open[pid].values():
        editing_service._cancel(document)
    folder.rename(home / "Work" / "Moved away")
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 404
    assert not folder.exists(), "the folder is never made again"


def test_an_open_project_located_keeps_its_unsaved_changes_and_saves_where_it_is_now(home):
    """5.5 item 4: unsaved changes are kept until the folder is found; then
    Locate… tells every open file its new folder, and Save writes there."""
    folder = _elsewhere(home)
    pid = _open(folder).json()["id"]
    client.post(f"/api/projects/{pid}/open")
    assert client.post(f"/api/projects/{pid}/documents/model/commands",
                       json={"command": "CreateClass", "args": {"label": "Kept"}}).status_code == 200
    for document in editing_service._open[pid].values():
        editing_service._cancel(document)
    moved = home / "Work" / "Moved"
    folder.rename(moved)
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 404
    located = client.patch(f"/api/projects/{pid}/location", json={"folder": str(moved)})
    assert located.status_code == 200, located.text
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 200
    assert "Kept" in (moved / "model.ttl").read_text(encoding="utf-8")
    assert not folder.exists(), "nothing is written where the folder was"


def test_the_registry_ignores_a_network_path_written_into_it_by_hand(home):
    project_store.registry_path.write_text(json.dumps({
        "prj-0000000000aa": {"folder": "\\\\server\\share\\Motors", "addedAt": "x"},
        "../evil": {"folder": str(home), "addedAt": "x"},
    }), encoding="utf-8")
    assert project_store.registry() == {}
    assert client.post("/api/projects/prj-0000000000aa/open").status_code == 404


# --- the scan: only projects.py touches the registry ---------------------------------------


_REGISTRY_NAMES = {"LOCATIONS_FILE", "registry_path", "_write_registry"}


def registry_touches(source: str, module: str) -> list[str]:
    """Every place in `source` naming project-locations.json or the
    registry's file or writer, as "module:line"."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and "project-locations" in node.value:
            found.append(f"{module}:{node.lineno}")
        elif isinstance(node, ast.Attribute) and node.attr in _REGISTRY_NAMES:
            found.append(f"{module}:{node.lineno}")
        elif isinstance(node, ast.Name) and node.id in _REGISTRY_NAMES:
            found.append(f"{module}:{node.lineno}")
        elif isinstance(node, ast.ImportFrom) and any(a.name in _REGISTRY_NAMES for a in node.names):
            found.append(f"{module}:{node.lineno}")
    return found


def test_the_registry_scan_catches_a_planted_reader():
    planted = (
        "import json\nfrom pathlib import Path\n"
        "def peek(d):\n    return json.loads((Path(d) / 'project-locations.json').read_text())\n"
        "def peek2(store):\n    return store.registry_path.read_text()\n"
        "from .projects import LOCATIONS_FILE\n"
    )
    assert len(registry_touches(planted, "planted.py")) == 3


def test_only_projects_py_touches_the_registry():
    touches = []
    for path in sorted(APP.rglob("*.py")):
        if path.name == "projects.py" and path.parent == APP:
            continue
        touches += registry_touches(path.read_text(encoding="utf-8"), path.relative_to(APP).as_posix())
    assert touches == []
    # And projects.py does touch it: the scan reads the right tree.
    assert registry_touches((APP / "projects.py").read_text(encoding="utf-8"), "projects.py")


# --- Section 10: the list and the open ----------------------------------------------------


@pytest.fixture
def own_data(tmp_path):
    """A data folder of the test's own: the run shares one, and by the time
    a budget runs it holds every project the suite has made (690 in a full
    run), not the hundred the spec measures."""
    shared = project_store.dir.parent
    project_store.configure(tmp_path / "data")
    yield tmp_path / "data"
    editing_service.close_all()
    project_store.configure(shared)


@pytest.mark.perf
def test_budget_list_with_registered(home, own_data):
    """GET /api/projects with 100 projects, 50 of them in registered folders
    on the same disk: at most 25 ms, median of five."""
    base = _create(name="Budget base", template="small")
    source = project_store.folder(base["id"])
    registry = project_store.registry()
    for i in range(50):
        target = home / "Work" / f"Reg {i}"
        shutil.copytree(source, target)
        registry[f"prj-{i:012x}"] = {"folder": str(target), "addedAt": "2026-11-12T00:00:00+00:00", "name": f"Reg {i}"}
    with project_store._lock:
        project_store._write_registry(registry)
    for i in range(49):
        _create(name=f"Budget {i}", template="small")
    client.get("/api/projects")
    samples = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            listed = client.get("/api/projects").json()
            samples.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = sorted(samples)[2]
    assert len(listed) == 100 and sum(1 for p in listed if p["folder"]) == 50
    assert median <= limit_ms(25), f"listing {len(listed)} projects took {median:.1f} ms (median of 5)"


@pytest.mark.perf
def test_budget_open_registered_ratio(home, own_data):
    """Opening a registered Small project is at most 1.2 times opening the
    same project in the default folder, interleaved, medians of five: a
    ratio, so not scaled."""
    default = _create(name="Ratio", template="small")["id"]
    target = home / "Work" / "Ratio"
    shutil.copytree(project_store.folder(default), target)
    registered = _open(target).json()["id"]
    times: dict = {default: [], registered: []}
    for pid in (default, registered):
        client.post(f"/api/projects/{pid}/open")
        client.post(f"/api/projects/{pid}/close", json={"discard": True})
    gc.disable()
    try:
        for _ in range(5):
            for pid in (default, registered):
                client.post(f"/api/projects/{pid}/close", json={"discard": True})
                start = time.perf_counter()
                assert client.post(f"/api/projects/{pid}/open").status_code == 200
                times[pid].append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = {pid: sorted(t)[2] for pid, t in times.items()}
    ratio = median[registered] / median[default]
    assert ratio <= 1.2, f"registered {median[registered]:.1f} ms, default {median[default]:.1f} ms: {ratio:.2f}x"
