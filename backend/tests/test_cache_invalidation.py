"""
================================================================================
FILE: backend/tests/test_cache_invalidation.py
================================================================================

SUMMARY
    AC-16 (D-081): after a change to a project document, every derived view --
    graph, hierarchy, detail, query schema, pretty source, merged-imports view
    -- reflects it; and a library ontology never rebuilds any of them.

BASIC IDEA
    Each view is read once before the change, so it is cached, then read
    again after: a view that kept its old cache would still lack the new
    class. The library half counts builder calls through monkeypatched
    builders, because "never rebuilds" is a count, not a timing.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-16.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import store as store_module
from app.editing import editing_service
from app.imports import imports_service
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/cache#"
NEW = EX + "Freshly"


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


@pytest.fixture
def pid() -> str:
    project = client.post(
        "/api/projects", json={"name": "Cache", "template": "small", "baseIri": EX, "prefix": "cache"}
    ).json()["id"]
    client.post(f"/api/projects/{project}/open")
    return project


def _views(oid: str, imports: bool = False) -> dict:
    params = {"imports": "true"} if imports else {}
    return {
        "graph": client.get(f"/api/ontologies/{oid}/graph", params=params).json(),
        "hierarchy": client.get(f"/api/ontologies/{oid}/hierarchy", params=params).json(),
        "schema": client.get(f"/api/ontologies/{oid}/query-schema", params=params).json(),
        "pretty": client.get(f"/api/ontologies/{oid}/source", params={"pretty": "true"}).json(),
        "search": client.get(f"/api/ontologies/{oid}/search", params={"q": "fresh", **params}).json(),
    }


def _has_new(views: dict) -> dict:
    return {
        "graph": any(n["id"] == NEW for n in views["graph"]["nodes"]),
        "hierarchy": NEW in views["hierarchy"]["classes"]["nodes"],
        "schema": any(c["iri"] == NEW for c in views["schema"]["classes"]),
        "pretty": "Freshly" in views["pretty"]["text"],
        "search": any(n["id"] == NEW for n in views["search"]),
    }


@pytest.mark.parametrize("imports", [False, True])
def test_every_view_reflects_a_command(pid, imports):
    oid = f"{pid}-model"
    before = _has_new(_views(oid, imports))
    assert not any(before.values())
    response = client.post(
        f"/api/projects/{pid}/documents/model/commands",
        json={"command": "CreateClass", "args": {"label": "Freshly"}},
    )
    assert response.status_code == 200
    after = _has_new(_views(oid, imports))
    assert all(after.values()), after
    detail = client.get(f"/api/ontologies/{oid}/node", params={"iri": NEW})
    assert detail.status_code == 200 and detail.json()["label"] == "Freshly"


def test_the_merged_view_follows_the_revision(pid):
    oid = f"{pid}-model"
    document = editing_service.document(pid, "model")
    first = imports_service.merged(document.ontology)["graph"]
    client.post(
        f"/api/projects/{pid}/documents/model/commands",
        json={"command": "CreateClass", "args": {"label": "Freshly"}},
    )
    second = imports_service.merged(document.ontology)["graph"]
    assert second is not first
    assert document.ontology.merged_cache["revision"] == document.ontology.revision
    assert client.get(f"/api/ontologies/{oid}/graph?imports=true").status_code == 200


def test_every_view_reflects_an_apply_and_an_undo(pid):
    oid = f"{pid}-model"
    _views(oid)
    text = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    client.put(
        f"/api/projects/{pid}/documents/model/source",
        json={"text": text + f'\n<{NEW}> a <http://www.w3.org/2002/07/owl#Class> ; <http://www.w3.org/2000/01/rdf-schema#label> "Freshly"@en .\n'},
    )
    assert all(_has_new(_views(oid)).values())
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert not any(_has_new(_views(oid)).values())


def test_a_library_ontology_never_rebuilds_its_views(monkeypatch):
    oid = client.post(
        "/api/ontologies/upload",
        files={"file": ("steady.ttl", b"@prefix ex: <http://example.org/steady#> .\n"
                        b"ex:A a <http://www.w3.org/2002/07/owl#Class> .\n"
                        b"ex:B <http://www.w3.org/2000/01/rdf-schema#subClassOf> ex:A .\n")},
    ).json()["id"]
    calls = {"viz": 0, "hierarchy": 0, "schema": 0}

    def counting(name, real):
        def wrapper(*args, **kwargs):
            calls[name] += 1
            return real(*args, **kwargs)
        return wrapper

    monkeypatch.setattr(store_module, "build_viz_graph", counting("viz", store_module.build_viz_graph))
    monkeypatch.setattr(store_module, "build_hierarchy", counting("hierarchy", store_module.build_hierarchy))
    monkeypatch.setattr(store_module, "build_query_schema", counting("schema", store_module.build_query_schema))
    ontology = store_module.store.get(oid)
    for _ in range(3):
        client.get(f"/api/ontologies/{oid}/graph")
        client.get(f"/api/ontologies/{oid}/graph", params={"lang": "fr"})
        client.get(f"/api/ontologies/{oid}/hierarchy")
        client.get(f"/api/ontologies/{oid}/query-schema")
        client.get(f"/api/ontologies/{oid}/source", params={"pretty": "true"})
    # The viz was built at ingest; the other two once each, on first read.
    assert calls == {"viz": 0, "hierarchy": 1, "schema": 1}
    assert ontology.revision == 0 and ontology.pretty_cache[0] == 0
