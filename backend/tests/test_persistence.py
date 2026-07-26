"""
================================================================================
FILE: backend/tests/test_persistence.py
================================================================================

SUMMARY
    Tests that ontologies survive a "restart": that add() writes the data and
    metadata files, that a fresh OntologyStore over the same directory restores
    them lazily (without parsing until first use), that ordering is preserved,
    that remove() deletes the files, and that corrupt metadata is skipped.

BASIC IDEA
    Persistence is what lets a previously loaded ontology reappear in the
    dropdown. These tests use a throwaway tmp_path directory, add the example
    ontology, then construct a second store over the same directory to
    simulate an app restart and assert the state comes back correctly.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl.
    - pytest's tmp_path fixture (a fresh temp directory per test).

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a persistence/restore bug.
================================================================================
"""

from pathlib import Path

from rdflib import Graph

from app.store import OntologyStore

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
