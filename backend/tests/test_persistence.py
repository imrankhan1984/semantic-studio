from pathlib import Path

from app.store import OntologyStore

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"


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
    assert summary["triples"] == 115
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
    assert summary["triples"] == 115
    assert summary["nodes"] == 30
    assert summary["name"] == "space-exploration.ttl"

    # First real use parses the persisted bytes.
    graph = restored.ensure_loaded()
    assert len(graph) == 115
    assert restored.summary()["loaded"] is True
    viz = restored.viz()
    assert viz["stats"]["nodeCount"] == 30


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
