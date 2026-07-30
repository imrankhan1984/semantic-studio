"""
================================================================================
FILE: backend/tests/test_persistence.py
================================================================================

SUMMARY
    Tests that ontologies survive a "restart": that add() writes the data and
    metadata files, that a fresh OntologyStore over the same directory restores
    them lazily (without parsing until first use), that ordering is preserved,
    that remove() deletes the files, and that corrupt metadata is skipped.

    It also covers the saved-query cascade: deleting an ontology deletes every
    query saved against it, and the delete response says how many it took.

BASIC IDEA
    Persistence is what lets a previously loaded ontology reappear in the
    dropdown. These tests use a throwaway tmp_path directory, add the example
    ontology, then construct a second store over the same directory to
    simulate an app restart and assert the state comes back correctly.

    The cascade tests are different in shape and deliberately so: they run
    through the HTTP layer with TestClient, because what is being asserted is
    the *response body*. `deletedQueries` is what the interface repeats back to
    the user, so a test against the store alone would prove the queries were
    deleted without proving the user is told.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl.
    - pytest's tmp_path fixture (a fresh temp directory per test).
    - The FastAPI app, via TestClient, for the cascade tests.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a persistence/restore bug, or
      a cascade that deletes work without reporting it.
================================================================================
"""

from pathlib import Path

from fastapi.testclient import TestClient
from rdflib import Graph

from app.main import app
from app.store import OntologyStore

client = TestClient(app)

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"

# Derived from the file rather than hard-coded, so extending the example
# ontology does not break unrelated persistence tests.
EXAMPLE_TRIPLES = len(Graph().parse(EXAMPLE, format="turtle"))


def _add_example(store: OntologyStore):
    return store.add(
        name="space-exploration.ttl",
        source="upload",
        data=EXAMPLE.read_bytes(),
        fmt="turtle",
    )


def test_add_persists_files(tmp_path):
    store = OntologyStore(tmp_path)
    ontology = _add_example(store)
    assert (tmp_path / "ontologies" / f"{ontology.id}.rdf").exists()
    assert (tmp_path / "ontologies" / f"{ontology.id}.meta.json").exists()
    summary = ontology.summary()
    assert summary["triples"] == EXAMPLE_TRIPLES
    assert summary["loaded"] is True


def test_previous_session_restored_lazily(tmp_path):
    first = OntologyStore(tmp_path)
    oid = _add_example(first).id

    # Simulate an app restart: a brand-new store over the same directory.
    second = OntologyStore(tmp_path)
    restored = second.get(oid)
    assert restored is not None

    # Listing works from metadata alone — nothing parsed yet.
    summary = restored.summary()
    assert restored.graph is None
    assert summary["loaded"] is False
    assert summary["triples"] == EXAMPLE_TRIPLES
    assert summary["nodes"] > 0
    assert summary["name"] == "space-exploration.ttl"

    # First real use parses the persisted bytes.
    graph = restored.ensure_loaded()
    assert len(graph) == EXAMPLE_TRIPLES
    assert restored.summary()["loaded"] is True
    viz = restored.viz()
    assert viz["stats"]["nodeCount"] == summary["nodes"]


def test_multiple_restores_keep_insertion_order(tmp_path):
    first = OntologyStore(tmp_path)
    a = _add_example(first).id
    b = _add_example(first).id

    second = OntologyStore(tmp_path)
    assert [o.id for o in second.list()] == [a, b]


def test_remove_deletes_from_disk(tmp_path):
    first = OntologyStore(tmp_path)
    oid = _add_example(first).id
    assert first.remove(oid) is True
    assert not (tmp_path / "ontologies" / f"{oid}.rdf").exists()
    assert not (tmp_path / "ontologies" / f"{oid}.meta.json").exists()
    assert first.remove(oid) is False

    # A later session sees nothing.
    second = OntologyStore(tmp_path)
    assert second.list() == []


def test_corrupt_metadata_is_skipped(tmp_path):
    store = OntologyStore(tmp_path)
    _add_example(store)
    (tmp_path / "ontologies" / "broken.meta.json").write_text("{not json", encoding="utf-8")

    second = OntologyStore(tmp_path)
    assert len(second.list()) == 1


# ---------------------------------------------------------------------------
# The saved-query cascade — backlog U-3, spec `saved-query-deletion-warning`.
#
# Removing an ontology has always deleted every query saved against it. That is
# deliberate: a re-loaded file gets a fresh id, so a retained query would point
# at nothing. What was missing is that the response said only which ontology
# went, so the interface had no number to warn with and no number to confirm.
# ---------------------------------------------------------------------------


def _upload() -> str:
    """Upload the example ontology through the API and return its id."""
    with EXAMPLE.open("rb") as f:
        response = client.post(
            "/api/ontologies/upload",
            files={"file": ("space-exploration.ttl", f, "text/turtle")},
        )
    assert response.status_code == 200
    return response.json()["id"]


def _save_query(oid: str, name: str) -> str:
    """Save one query against `oid` and return its id."""
    response = client.post(
        "/api/queries",
        json={
            "name": name,
            "ontologyId": oid,
            "state": {"steps": []},
            "sparql": "SELECT * WHERE { ?s ?p ?o }",
        },
    )
    assert response.status_code == 200
    return response.json()["id"]


def test_delete_reports_removed_query_count():
    """AC-1. Three saved queries, three reported."""
    oid = _upload()
    for name in ("Planets", "Missions", "Agencies"):
        _save_query(oid, name)

    body = client.delete(f"/api/ontologies/{oid}").json()

    assert body["deleted"] == oid
    assert body["deletedQueries"] == 3


def test_delete_reports_zero_when_no_saved_queries():
    """AC-2. The field is always present, so the client never has to guess
    whether a missing key means none or means an older server."""
    oid = _upload()

    body = client.delete(f"/api/ontologies/{oid}").json()

    assert body["deletedQueries"] == 0


def test_delete_still_removes_every_saved_query():
    """AC-3. The cascade itself, which the count must not be allowed to
    outlive: a number reported by a delete that stopped deleting would be
    worse than no number at all."""
    oid = _upload()
    qids = [_save_query(oid, name) for name in ("One", "Two")]

    client.delete(f"/api/ontologies/{oid}")

    # Gone from the store, not merely absent from a filtered listing.
    for qid in qids:
        assert client.delete(f"/api/queries/{qid}").status_code == 404


def test_delete_unknown_ontology_still_404s():
    """AC-4. The 404 comes before any query is touched, so a typo'd id cannot
    delete anything."""
    response = client.delete("/api/ontologies/ont-does-not-exist")

    assert response.status_code == 404
    assert "ont-does-not-exist" in response.json()["detail"]


def test_queries_for_other_ontologies_survive():
    """AC-5. The filter on the cascade is the whole reason this is safe to do
    at all; without it, removing one file would empty the library."""
    doomed = _upload()
    kept = _upload()
    _save_query(doomed, "Goes")
    kept_qid = _save_query(kept, "Stays")

    body = client.delete(f"/api/ontologies/{doomed}").json()

    assert body["deletedQueries"] == 1
    survivors = client.get("/api/queries", params={"ontology": kept}).json()
    assert [q["id"] for q in survivors] == [kept_qid]

    client.delete(f"/api/ontologies/{kept}")
