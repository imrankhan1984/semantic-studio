"""
================================================================================
FILE: backend/tests/test_projects.py
================================================================================

SUMMARY
    Projects (authoring-foundations): create from each template and from a
    library ontology, list from manifests alone, rename, duplicate, trash and
    export; an open project document through every existing view; ids and
    document names the server did not issue; the listing budget.

BASIC IDEA
    Everything goes through the HTTP API with the application's own client
    header, as the frontend does. The path-attack test reads every project
    route from OpenAPI, so a route added later is attacked too, and it asserts
    that the data directory is unchanged afterwards rather than only that a
    status came back.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; inline Turtle fixtures.

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-5 and AC-17, and the Section 10 listing budget.
================================================================================
"""

from __future__ import annotations

import builtins
import gc
import io
import json
import pathlib
import re
import time
import zipfile

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS, SKOS

from app.editing import editing_service, project_store
from app.main import app
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

LIBRARY_TTL = b"""@prefix ex: <http://example.org/lib#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
# A comment the copy must keep.
ex:Animal a owl:Class ; rdfs:label "Animal"@en .
ex:Dog a owl:Class ; rdfs:label "Dog"@en ; rdfs:subClassOf ex:Animal .
"""

LIBRARY_RDFXML = b"""<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#">
  <owl:Class rdf:about="http://example.org/x#Cat"><rdfs:label xml:lang="en">Cat</rdfs:label></owl:Class>
</rdf:RDF>
"""


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _create(**body) -> dict:
    body.setdefault("name", "Test project")
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _upload(data: bytes, name: str) -> str:
    response = client.post("/api/ontologies/upload", files={"file": (name, data)})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _model(pid: str) -> Graph:
    graph = Graph()
    graph.parse(project_store.folder(pid) / "model.ttl", format="turtle")
    return graph


# --- AC-1: templates ------------------------------------------------------------


@pytest.mark.parametrize(
    "template,classes,properties,concepts",
    [("empty", 0, 0, 0), ("vocabulary", 0, 0, 2), ("small", 2, 1, 0)],
)
def test_create_from_each_template_substitutes_base_and_prefix(template, classes, properties, concepts):
    project = _create(
        name="Invoices", template=template, baseIri="http://acme.test/inv#", prefix="inv"
    )
    assert re.fullmatch(r"prj-[0-9a-f]{12}", project["id"])
    assert project["counts"]["classes"] == classes
    assert project["counts"]["properties"] == properties
    assert project["counts"]["concepts"] == concepts
    text = (project_store.folder(project["id"]) / "model.ttl").read_text(encoding="utf-8")
    assert "{{" not in text, "a placeholder was left behind"
    assert "@prefix inv: <http://acme.test/inv#>" in text
    graph = _model(project["id"])
    assert (URIRef("http://acme.test/inv"), RDF.type, OWL.Ontology) in graph
    assert (URIRef("http://acme.test/inv"), RDFS.label, Literal("Invoices", lang="en")) in graph

    # ...and it opens: the document is served through the ontology endpoints.
    opened = client.post(f"/api/projects/{project['id']}/open").json()
    oid = opened["documents"][0]["ontologyId"]
    assert oid == f"{project['id']}-model"
    assert client.get(f"/api/ontologies/{oid}/graph").status_code == 200


def test_template_defaults_come_from_the_name():
    project = _create(name="My Invoices 2026", template="small")
    assert project["baseIri"] == "http://example.org/my-invoices-2026#"
    assert project["prefix"] == "myinvoices2026"
    assert project["primaryLanguage"] == "en"


def test_a_hostile_name_cannot_break_out_of_the_template():
    project = _create(name='Evil" ; a <http://evil.test/X> . #', template="empty")
    graph = _model(project["id"])
    assert not any("evil.test" in str(t) for triple in graph for t in triple if isinstance(t, URIRef))
    names = [str(o) for o in graph.objects(None, RDFS.label)]
    assert names == ['Evil" ; a <http://evil.test/X> . #']


@pytest.mark.parametrize(
    "body,fragment",
    [
        ({"name": ""}, "needs a name"),
        ({"name": "x", "baseIri": "example.org/x#"}, "absolute IRI ending in # or /"),
        ({"name": "x", "baseIri": "http://example.org/x"}, "absolute IRI ending in # or /"),
        ({"name": "x", "baseIri": "http://ex.org/a> <b#"}, "absolute IRI ending in # or /"),
        ({"name": "x", "prefix": "1abc"}, "prefix must start with a letter"),
        ({"name": "x", "primaryLanguage": "english!"}, "well-formed language tag"),
    ],
)
def test_invalid_creation_is_refused_with_a_sentence(body, fragment):
    before = sorted(p.name for p in project_store.dir.iterdir())
    response = client.post("/api/projects", json=body)
    assert response.status_code == 422
    assert fragment in response.json()["detail"]
    assert sorted(p.name for p in project_store.dir.iterdir()) == before


# --- AC-2: start a project from a library ontology --------------------------------


def test_start_from_a_library_turtle_file_copies_it_verbatim_and_leaves_the_library_alone():
    oid = _upload(LIBRARY_TTL, "animals.ttl")
    library = store.get(oid)
    meta_before = json.dumps(library.meta, sort_keys=True)
    project = _create(name="Animals", fromOntologyId=oid)
    copied = (project_store.folder(project["id"]) / "model.ttl").read_bytes()
    assert copied.replace(b"\r\n", b"\n") == LIBRARY_TTL
    assert project["counts"]["classes"] == 2
    # The library entry is untouched: bytes, metadata, and still listed once.
    assert library.data_path.read_bytes() == LIBRARY_TTL
    assert json.dumps(store.get(oid).meta, sort_keys=True) == meta_before
    assert [o["id"] for o in client.get("/api/ontologies").json()].count(oid) == 1


def test_start_from_a_non_turtle_library_file_writes_clean_turtle():
    oid = _upload(LIBRARY_RDFXML, "cat.rdf")
    project = _create(name="Cats", fromOntologyId=oid)
    graph = _model(project["id"])
    assert isomorphic(graph, store.get(oid).ensure_loaded())


def test_start_from_an_unknown_or_project_ontology_is_refused():
    assert client.post("/api/projects", json={"name": "x", "fromOntologyId": "ont-000000000000"}).status_code == 404
    project = _create(name="Source")
    client.post(f"/api/projects/{project['id']}/open")
    response = client.post("/api/projects", json={"name": "x", "fromOntologyId": f"{project['id']}-model"})
    assert response.status_code == 404


# --- AC-3: listing from manifests alone ---------------------------------------------


def test_projects_are_listed_newest_first_and_never_in_the_library():
    first = _create(name="First")
    second = _create(name="Second")
    listed = [p["id"] for p in client.get("/api/projects").json()]
    assert listed.index(second["id"]) < listed.index(first["id"])
    client.post(f"/api/projects/{first['id']}/open")
    library = [o["id"] for o in client.get("/api/ontologies").json()]
    assert not any(i.startswith("prj-") for i in library)


def test_listing_opens_no_turtle_file(monkeypatch):
    """Section 10's count test: listing reads manifests and nothing else."""
    for i in range(3):
        _create(name=f"Counted {i}", template="small")
    opened: list[str] = []
    real_open = builtins.open
    real_read_text = pathlib.Path.read_text

    def spy_open(file, *args, **kwargs):
        opened.append(str(file))
        return real_open(file, *args, **kwargs)

    def spy_read_text(self, *args, **kwargs):
        opened.append(str(self))
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy_open)
    monkeypatch.setattr(io, "open", spy_open)
    monkeypatch.setattr(pathlib.Path, "read_text", spy_read_text)
    listed = client.get("/api/projects").json()
    assert len(listed) >= 3
    assert opened, "the spy saw nothing, so it proves nothing"
    assert all(path.endswith("project.json") for path in opened), opened


# --- AC-4: rename, duplicate, delete, export ------------------------------------------


def test_rename_changes_only_the_manifest_name():
    project = _create(name="Before", template="small")
    folder = project_store.folder(project["id"])
    model_before = (folder / "model.ttl").read_bytes()
    renamed = client.patch(f"/api/projects/{project['id']}", json={"name": "After"}).json()
    assert renamed["name"] == "After"
    assert renamed["baseIri"] == project["baseIri"] and renamed["prefix"] == project["prefix"]
    assert (folder / "model.ttl").read_bytes() == model_before


def test_duplicate_is_an_independent_copy_without_the_draft():
    project = _create(name="Original", template="small")
    folder = project_store.folder(project["id"])
    (folder / ".draft").mkdir()
    (folder / ".draft" / "model.ttl").write_text("draft", encoding="utf-8")
    copy = client.post(f"/api/projects/{project['id']}/duplicate").json()
    assert copy["id"] != project["id"] and copy["name"] == "Original (copy)"
    copy_folder = project_store.folder(copy["id"])
    assert not (copy_folder / ".draft").exists()

    client.post(f"/api/projects/{copy['id']}/open")
    changed = client.post(
        f"/api/projects/{copy['id']}/documents/model/commands",
        json={"command": "CreateClass", "args": {"label": "Only in the copy"}},
    )
    assert changed.status_code == 200
    client.post(f"/api/projects/{copy['id']}/documents/model/save")
    assert "Only in the copy" in (copy_folder / "model.ttl").read_text(encoding="utf-8")
    assert "Only in the copy" not in (folder / "model.ttl").read_text(encoding="utf-8")


def test_delete_moves_the_folder_to_the_trash_and_says_where():
    project = _create(name="Doomed", template="small")
    folder = project_store.folder(project["id"])
    response = client.delete(f"/api/projects/{project['id']}")
    assert response.status_code == 200
    location = response.json()["location"]
    assert location == f"projects/.trash/{project['id']}"
    assert not folder.exists()
    assert (store.data_dir / location / "model.ttl").is_file(), "nothing is destroyed"
    assert project["id"] not in [p["id"] for p in client.get("/api/projects").json()]


def test_delete_refuses_a_project_open_with_unsaved_changes():
    project = _create(name="Busy", template="small")
    client.post(f"/api/projects/{project['id']}/open")
    client.post(
        f"/api/projects/{project['id']}/documents/model/commands",
        json={"command": "CreateClass", "args": {"label": "Unsaved"}},
    )
    assert client.delete(f"/api/projects/{project['id']}").status_code == 409
    assert project_store.folder(project["id"]).exists()


def test_export_is_a_zip_of_the_folder_without_the_draft():
    project = _create(name="Exported", template="small")
    folder = project_store.folder(project["id"])
    (folder / ".draft").mkdir()
    (folder / ".draft" / "model.ttl").write_text("draft", encoding="utf-8")
    response = client.get(f"/api/projects/{project['id']}/export")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    assert "model.ttl" in names and "project.json" in names
    assert not any(n.startswith(".draft") for n in names)


def test_a_shapes_document_can_be_added_once():
    project = _create(name="Shaped")
    client.post(f"/api/projects/{project['id']}/open")
    added = client.post(f"/api/projects/{project['id']}/documents", json={"role": "shapes"})
    assert added.status_code == 200
    assert [d["file"] for d in added.json()["documents"]] == ["model.ttl", "shapes.ttl"]
    again = client.post(f"/api/projects/{project['id']}/documents", json={"role": "shapes"})
    assert again.status_code == 422
    assert client.get(f"/api/ontologies/{project['id']}-shapes/graph").status_code == 200


# --- AC-5: an open project document through the existing views -------------------------


def test_an_open_project_document_works_in_every_existing_view():
    project = _create(name="Everywhere", template="small")
    client.post(f"/api/projects/{project['id']}/open")
    oid = f"{project['id']}-model"
    person = "http://example.org/everywhere#Person"
    assert client.get(f"/api/ontologies/{oid}/graph").json()["stats"]["kindCounts"]["class"] == 2
    assert client.get(f"/api/ontologies/{oid}/node", params={"iri": person}).json()["label"] == "Person"
    assert client.get(f"/api/ontologies/{oid}/search", params={"q": "pers"}).json()[0]["id"] == person
    assert client.get(f"/api/ontologies/{oid}/neighborhood", params={"iri": person}).status_code == 200
    assert client.get(f"/api/ontologies/{oid}/hierarchy").json()["counts"]["classes"] == 2
    schema = client.get(f"/api/ontologies/{oid}/query-schema").json()
    assert any(c["iri"] == person for c in schema["classes"])
    rows = client.post(
        f"/api/ontologies/{oid}/sparql",
        json={"query": "SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> }"},
    ).json()
    assert rows["rowCount"] == 2
    source = client.get(f"/api/ontologies/{oid}/source").json()
    assert "Person" in source["text"]
    assert client.get(f"/api/ontologies/{oid}/imports").status_code == 200
    docs = client.get(f"/api/ontologies/{oid}/documentation")
    assert docs.status_code == 200 and docs.headers["content-type"] == "application/zip"
    # The documentation carries the current draft, not the file last saved.
    client.post(
        f"/api/projects/{project['id']}/documents/model/commands",
        json={"command": "CreateClass", "args": {"label": "Drafted"}},
    )
    zipped = zipfile.ZipFile(io.BytesIO(client.get(f"/api/ontologies/{oid}/documentation").content))
    original = [n for n in zipped.namelist() if n.startswith("source/original")][0]
    assert b"Drafted" in zipped.read(original)


def test_a_closed_project_document_is_not_served():
    project = _create(name="Closed", template="small")
    client.post(f"/api/projects/{project['id']}/open")
    client.post(f"/api/projects/{project['id']}/close")
    assert client.get(f"/api/ontologies/{project['id']}-model/graph").status_code == 404


def test_a_project_document_cannot_be_deleted_through_the_library_route():
    project = _create(name="Kept", template="small")
    client.post(f"/api/projects/{project['id']}/open")
    assert client.delete(f"/api/ontologies/{project['id']}-model").status_code == 404
    assert project_store.folder(project["id"]).exists()


# --- AC-17: ids and document names the server did not issue ----------------------------

BAD_IDS = [
    "..",
    "../ontologies",
    "..%2F..%2Fontologies",
    "..\\..\\ontologies",
    "C:\\Windows",
    "%2Fetc%2Fpasswd",
    "prj-123",
    "prj-zzzzzzzzzzzz",
    "prj-0123456789ab%0A",
    "PRJ-0123456789AB",
    "prj-0123456789ab",  # well-formed, never issued
]
BAD_DOCS = ["..", "model.ttl", "shapes2", "project.json", "..%2Fproject.json", "..\\model", "%2Fetc%2Fpasswd", "MODEL"]
ANY_BODY = {
    "name": "x", "role": "shapes", "command": "CreateClass", "args": {"label": "x"},
    "action": "discard", "text": "", "languages": [], "discard": True,
}


def _project_routes() -> list[tuple[str, str]]:
    found = []
    for path, operations in app.openapi()["paths"].items():
        if "{pid}" in path:
            for method in operations:
                found.append((method.upper(), path))
    return found


def _snapshot() -> list[str]:
    return sorted(str(p.relative_to(store.data_dir)) for p in store.data_dir.rglob("*"))


def test_route_discovery_finds_the_project_routes():
    routes = _project_routes()
    assert ("POST", "/api/projects/{pid}/documents/{doc}/commands") in routes
    assert ("PUT", "/api/projects/{pid}/documents/{doc}/source") in routes
    assert len(routes) >= 15


@pytest.mark.parametrize("method,path", _project_routes())
def test_every_project_route_refuses_ids_and_documents_it_did_not_issue(method, path):
    real = _create(name="Target", template="small")
    client.post(f"/api/projects/{real['id']}/open")
    before = _snapshot()
    attempts = [path.replace("{pid}", bad).replace("{doc}", "model") for bad in BAD_IDS]
    if "{doc}" in path:
        attempts += [path.replace("{pid}", real["id"]).replace("{doc}", bad) for bad in BAD_DOCS]
    for url in attempts:
        kwargs = {} if method in ("GET", "DELETE") else {"json": ANY_BODY}
        response = client.request(method, url, **kwargs)
        assert response.status_code in (404, 405), (method, url, response.status_code, response.text)
    assert _snapshot() == before, "a refused request changed the data directory"


# --- Section 10: listing 100 projects ---------------------------------------------------


@pytest.mark.perf
def test_list_budget():
    """At most 100 ms for 100 projects, median of five with the collector paused."""
    existing = len(project_store.list())
    for i in range(max(0, 100 - existing)):
        _create(name=f"Budget {i}", template="small")
    client.get("/api/projects")  # warm
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
    assert len(listed) >= 100
    assert median <= limit_ms(100), f"listing {len(listed)} projects took {median:.1f} ms (median of 5)"
