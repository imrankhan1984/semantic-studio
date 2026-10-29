"""
================================================================================
FILE: backend/tests/test_library_examples.py
================================================================================

SUMMARY
    The library's four bundled entries (home-and-examples, U-13a, D-111),
    two examples and two reference ontologies (reference-ontologies 5.2,
    E-12): each entry's group, and QUDT seeded, removed, restored and
    replaced like the others;
    seeding on a first start and never again, a removal that stays removed,
    a changed file replacing its entry under the same id, the restore
    endpoint; the manifest and its hashes; and what each new file must hold
    -- every floor of 5.2 for Space Exploration, the content of 5.3 for The
    Lord of the Rings; and the one server sentence that said *triples*, now
    *statements* (5.7); and the ready-made questions of query-page-rework
    5.4, each pinned, a SELECT, and answering what 5.4 measured against its
    example. (test_examples.py is a project's example data,
    shacl-authoring 5.8: a different thing that had the name first.)

BASIC IDEA
    Seeding runs against a store on a temporary data folder, a fresh
    OntologyStore on the same folder standing for a restart, and the parse
    count is a count of calls to store.parse_rdf -- Section 10's budget is a
    count, not a timing. The broker's request is replaced with one that fails
    the test, so "no network" does not lean on the sandbox.

    QUDT is 6.9 MB and a 3 s parse, so the seeding tests seed SEEDED, the
    manifest with a five-statement stand-in in QUDT's place; what is being
    tested is the bookkeeping, which is the same for every entry. One test
    seeds the real file, so the real one is proved to arrive too.

    The files are read straight from backend/app/examples/ with rdflib, the
    way the seeding reads them, and each floor is asserted as a count or as
    named statements rather than by eye. A floor is a minimum: the test says
    "at least", so the file can grow without the test moving, and a floor
    that slips fails by name.

INPUTS / INPUT SOURCES
    - backend/app/examples/manifest.json, the two Turtle files beside it, and
      backend/app/vocab/foaf.rdf and qudt-3.5.2.ttl.
    - library_examples, OntologyStore and SavedQueryStore on pytest's
      tmp_path; the FastAPI app through TestClient for the endpoint.

EXPECTED OUTPUT
    - Pass/fail for AC-1 to AC-6, the backend half of AC-10, and the
      server's part of AC-9; the server's half of query-page-rework AC-8;
      reference-ontologies AC-1 and AC-2.
================================================================================
"""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path

import pytest
from rdflib import OWL, RDF, RDFS, SKOS, XSD, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS
from fastapi.testclient import TestClient

from app import library_examples
from app import store as store_mod
from app.main import app
from app.network_broker import broker
from app.queries_store import SavedQueryStore
from app.store import OntologyStore, store as app_store

APP = Path(__file__).resolve().parent.parent / "app"
MANIFEST = json.loads((APP / "examples" / "manifest.json").read_text(encoding="utf-8"))
SPACE = Namespace("http://example.org/space#")
ME = Namespace("http://example.org/middle-earth#")
CC_BY_4 = URIRef("https://creativecommons.org/licenses/by/4.0/")


def _entry(key: str) -> dict:
    return next(e for e in MANIFEST["examples"] if e["key"] == key)


# QUDT's stand-in for the seeding tests (see BASIC IDEA): small, and with a
# class, so its card has a sketch as QUDT's does.
STANDIN = Path(tempfile.mkdtemp(prefix="qudt-standin-")) / "qudt-standin.ttl"
STANDIN.write_bytes(
    b"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
    b"@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
    b'<http://example.org/units> a owl:Ontology ; rdfs:label "Units" .\n'
    b'<http://example.org/units#Unit> a owl:Class ; rdfs:label "Unit"@en .\n'
    b'<http://example.org/units#Metre> a <http://example.org/units#Unit> ; rdfs:label "metre"@en .\n'
)
SEEDED = [
    {**e, "file": str(STANDIN), "sha256": hashlib.sha256(STANDIN.read_bytes()).hexdigest()}
    if e["key"] == "qudt" else e
    for e in MANIFEST["examples"]
]


@pytest.fixture(autouse=True)
def small_qudt(monkeypatch):
    """Seed the stand-in for QUDT; `real_qudt` undoes it."""
    monkeypatch.setattr(library_examples, "load_manifest", lambda: SEEDED)


@pytest.fixture
def real_qudt(small_qudt, monkeypatch):
    monkeypatch.setattr(library_examples, "load_manifest", lambda: MANIFEST["examples"])


def _graph(key: str) -> Graph:
    entry = _entry(key)
    return Graph().parse(data=(APP / entry["file"]).read_bytes(), format=entry["format"])


@pytest.fixture(scope="module")
def space() -> Graph:
    return _graph("space")


@pytest.fixture(scope="module")
def middle_earth() -> Graph:
    return _graph("middle-earth")


# --- the manifest -----------------------------------------------------------


def test_manifest_lists_the_four_entries_in_their_order():
    assert [e["key"] for e in MANIFEST["examples"]] == ["space", "middle-earth", "foaf", "qudt"]
    assert [e["name"] for e in MANIFEST["examples"]] == [
        "Space Exploration",
        "The Lord of the Rings",
        "FOAF (Friend of a Friend)",
        "QUDT",
    ]
    for entry in MANIFEST["examples"]:
        assert entry["purpose"].strip(), entry["key"]


def test_every_entry_has_its_group():
    # reference-ontologies 5.2 item 1: teaching material, or a published
    # vocabulary to build on. Nothing else.
    assert {e["key"]: e["group"] for e in MANIFEST["examples"]} == {
        "space": "example",
        "middle-earth": "example",
        "foaf": "reference",
        "qudt": "reference",
    }


@pytest.mark.parametrize("entry", MANIFEST["examples"], ids=lambda e: e["key"])
def test_each_file_matches_its_hash(entry):
    data = (APP / entry["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    # home-and-examples Section 10: the three small parses at the first start
    # are bounded here. QUDT is the one large entry, measured on its own
    # (reference-ontologies 5.2 item 4, test_vocab.py).
    if entry["key"] != "qudt":
        assert len(data) <= 1024 * 1024


def test_foaf_is_the_bundled_vocabulary_not_a_copy():
    entry = _entry("foaf")
    assert entry["file"] == "vocab/foaf.rdf"
    vocab = json.loads((APP / "vocab" / "manifest.json").read_text(encoding="utf-8"))
    foaf = next(v for v in vocab["vocabularies"] if v["file"] == "foaf.rdf")
    assert entry["sha256"] == foaf["sha256"]
    assert "Dan Brickley and Libby Miller, CC BY 1.0" in entry["purpose"]
    # Nothing in examples/ shadows the vocabulary.
    assert not list((APP / "examples").glob("foaf*"))


def test_qudt_is_the_bundled_vocabulary_not_a_copy():
    entry = _entry("qudt")
    assert entry["file"] == "vocab/qudt-3.5.2.ttl" and entry["format"] == "turtle"
    vocab = json.loads((APP / "vocab" / "manifest.json").read_text(encoding="utf-8"))
    qudt = next(v for v in vocab["vocabularies"] if v["file"] == "qudt-3.5.2.ttl")
    assert entry["sha256"] == qudt["sha256"]
    # 5.2 item 3, word for word.
    assert entry["purpose"] == (
        "Quantities, units and dimensions: the standard vocabulary for measurements. "
        "QUDT.org, CC BY 4.0."
    )
    assert "questions" not in entry
    assert not list((APP / "examples").glob("qudt*"))


def test_the_new_files_are_binary_in_gitattributes():
    attributes = (APP.parent.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "backend/app/examples/*.ttl binary" in attributes


# --- seeding: once, under fixed ids, and a removal stays removed -----------

KEYS = ["space", "middle-earth", "foaf", "qudt"]


@pytest.fixture
def parses(monkeypatch):
    """Every parse the store makes, counted; and no connection allowed."""
    calls: list = []
    real = store_mod.parse_rdf

    def counting(*args, **kwargs):
        calls.append(args[1] if len(args) > 1 else kwargs.get("fmt"))
        return real(*args, **kwargs)

    def refuse(*_args, **_kwargs):
        raise AssertionError("seeding the examples opened a connection")

    monkeypatch.setattr(store_mod, "parse_rdf", counting)
    monkeypatch.setattr(broker, "request", refuse)
    return calls


def test_example_ids_are_fixed_and_shaped_like_any_library_id():
    for key in KEYS:
        oid = library_examples.example_id(key)
        assert re.fullmatch(r"ont-[0-9a-f]{12}", oid)
        assert oid == "ont-" + hashlib.sha256(f"example:{key}".encode()).hexdigest()[:12]
    assert len({library_examples.example_id(k) for k in KEYS}) == 4


def test_a_first_start_adds_the_four_entries(tmp_path, parses):
    store = OntologyStore(tmp_path)
    added = library_examples.seed(store)
    assert added == [library_examples.example_id(k) for k in KEYS]
    entries = {o.id: o.summary() for o in store.list()}
    for entry in SEEDED:
        summary = entries[library_examples.example_id(entry["key"])]
        assert summary["source"] == "example"
        assert summary["name"] == entry["name"]
        assert summary["example"] == {"key": entry["key"], "purpose": entry["purpose"]}
        # The card's sketch is computed in the same parse, as for an upload.
        assert summary["card"]["sketch"]["nodes"]
    assert len(parses) == 4
    state = json.loads((tmp_path / "examples.json").read_text(encoding="utf-8"))
    assert state == {"seeded": {e["key"]: e["sha256"] for e in SEEDED}}


def test_a_later_start_parses_nothing_and_keeps_the_ids(tmp_path, parses):
    library_examples.seed(OntologyStore(tmp_path))
    first = [o.id for o in OntologyStore(tmp_path).list()]
    parses.clear()
    restarted = OntologyStore(tmp_path)
    assert library_examples.seed(restarted) == []
    assert parses == []
    assert sorted(o.id for o in restarted.list()) == sorted(first)
    # Nothing was parsed to list them either: the lazy start-up holds.
    assert all(not o.summary()["loaded"] for o in restarted.list())


def test_a_removed_example_stays_removed_after_a_restart(tmp_path, parses):
    store = OntologyStore(tmp_path)
    library_examples.seed(store)
    gone = library_examples.example_id("middle-earth")
    assert store.remove(gone)
    parses.clear()
    restarted = OntologyStore(tmp_path)
    assert library_examples.seed(restarted) == []
    assert restarted.get(gone) is None
    assert parses == []


def _changed_manifest(tmp_path, key: str, extra: bytes):
    """The manifest as a release with a changed file would ship it."""
    entries = json.loads(json.dumps(SEEDED))
    entry = next(e for e in entries if e["key"] == key)
    data = (APP / entry["file"]).read_bytes() + extra
    changed = tmp_path / "changed.ttl"
    changed.write_bytes(data)
    # An absolute path wins over APP_DIR in the join seeding makes.
    entry["file"] = str(changed)
    entry["sha256"] = hashlib.sha256(data).hexdigest()
    return entries


SOL = b'\n<http://example.org/space#Sun> <http://www.w3.org/2000/01/rdf-schema#label> "Sol"@es .\n'


def test_a_changed_file_replaces_its_entry_under_the_same_id(tmp_path, parses, monkeypatch):
    data_dir = tmp_path / "data"
    store = OntologyStore(data_dir)
    library_examples.seed(store)
    oid = library_examples.example_id("space")
    before = store.get(oid).summary()["triples"]
    queries = SavedQueryStore(data_dir)
    saved = queries.save(name="Missions to Mars", ontology_id=oid, ontology_name="Space Exploration",
                         state=None, sparql="SELECT * WHERE { ?s ?p ?o }", mode="text")

    entries = _changed_manifest(tmp_path, "space", SOL)
    monkeypatch.setattr(library_examples, "load_manifest", lambda: entries)
    parses.clear()
    restarted = OntologyStore(data_dir)
    assert library_examples.seed(restarted) == [oid]
    assert len(parses) == 1
    assert [o.id for o in restarted.list()].count(oid) == 1
    assert restarted.get(oid).summary()["triples"] == before + 1
    # The replacement is on disk, so the start after that serves it too.
    assert OntologyStore(data_dir).get(oid).summary()["triples"] == before + 1
    assert [q["id"] for q in SavedQueryStore(data_dir).list(ontology_id=oid)] == [saved["id"]]


def test_a_changed_file_does_not_bring_back_a_removed_example(tmp_path, parses, monkeypatch):
    store = OntologyStore(tmp_path / "data")
    library_examples.seed(store)
    oid = library_examples.example_id("space")
    store.remove(oid)
    entries = _changed_manifest(tmp_path, "space", SOL)
    monkeypatch.setattr(library_examples, "load_manifest", lambda: entries)
    restarted = OntologyStore(tmp_path / "data")
    assert library_examples.seed(restarted) == []
    assert restarted.get(oid) is None


# --- US spelling and the Rosetta mission (load-and-shapes 5.5) ----------------

# The British forms 5.5 replaced, and the US form each became. A proper name
# keeps its own spelling: the Indian Space Research Organisation is one.
BRITISH = {
    "programme": "program", "programmes": "programs", "travelled": "traveled",
    "travelling": "traveling", "kilometres": "kilometers", "recognised": "recognized",
    "defence": "defense", "colour": "color",
}
PROPER_NAMES = ("Indian Space Research Organisation",)


@pytest.mark.parametrize("key", ["space", "middle-earth"])
def test_english_text_uses_us_spelling(key):
    text = (APP / _entry(key)["file"]).read_text(encoding="utf-8")
    assert len(text) > 10_000, "the example file did not load"
    for name in PROPER_NAMES:
        text = text.replace(name, "")
    graph = _graph(key)
    english = [str(o) for o in graph.objects() if isinstance(o, Literal) and (o.language or "").startswith("en")]
    assert english, "no English text was read"
    # The English literals, and the file's own comments, which are English too.
    comments = [line for line in text.splitlines() if line.lstrip().startswith("#")]
    for words in english + comments:
        if any(name in words for name in PROPER_NAMES):
            continue
        for british in BRITISH:
            assert not re.search(rf"\b{british}\b", words, re.IGNORECASE), (british, words)


def test_the_rosetta_mission_is_called_a_mission(space):
    assert space.value(SPACE.Rosetta, RDFS.label) == Literal("Rosetta mission", lang="en")
    # The spacecraft keeps its name.
    assert space.value(SPACE.RosettaOrbiter, RDFS.label) == Literal("Rosetta", lang="en")
    assert space.value(SPACE.ISRO, RDFS.comment) == Literal("The Indian Space Research Organisation.", lang="en")
    assert Literal("Soviet space program", lang="en") in set(space.objects(None, RDFS.label))


def _older(key: str, tmp_path) -> dict:
    """The manifest entry a library seeded before 5.5 holds: the British text."""
    entry = dict(_entry(key))
    data = (APP / entry["file"]).read_bytes()
    us_to_british = [(us, gb) for gb, us in BRITISH.items()]
    # Longest first, so "programs" is not read as "program" + "s".
    for us, gb in sorted(us_to_british, key=lambda pair: -len(pair[0])):
        data = re.sub(rb"\b" + us.encode() + rb"\b", gb.encode(), data)
    data = data.replace(b'rdfs:label "Rosetta mission"@en', b'rdfs:label "Rosetta"@en')
    assert data != (APP / entry["file"]).read_bytes()
    older = tmp_path / f"older-{key}.ttl"
    older.write_bytes(data)
    entry["file"] = str(older)
    entry["sha256"] = hashlib.sha256(data).hexdigest()
    return entry


def test_an_older_library_gets_the_new_words_under_the_same_ids(tmp_path, parses, monkeypatch):
    data_dir = tmp_path / "data"
    older = [_older(e["key"], tmp_path) if e["group"] == "example" else e for e in SEEDED]
    monkeypatch.setattr(library_examples, "load_manifest", lambda: older)
    store = OntologyStore(data_dir)
    library_examples.seed(store)
    space_id, me_id = library_examples.example_id("space"), library_examples.example_id("middle-earth")
    labels = set(store.get(space_id).ensure_loaded().objects(SPACE.Rosetta, RDFS.label))
    assert labels == {Literal("Rosetta", lang="en")}

    # The next start ships this release's manifest.
    monkeypatch.setattr(library_examples, "load_manifest", lambda: SEEDED)
    parses.clear()
    restarted = OntologyStore(data_dir)
    assert sorted(library_examples.seed(restarted)) == sorted([space_id, me_id])
    assert len(parses) == 2
    assert sorted(o.id for o in restarted.list()) == sorted(library_examples.example_id(k) for k in KEYS)
    graph = OntologyStore(data_dir).get(space_id).ensure_loaded()
    assert set(graph.objects(SPACE.Rosetta, RDFS.label)) == {Literal("Rosetta mission", lang="en")}
    assert "kilometers" in str(graph.value(SPACE.diameterKm, RDFS.comment))
    defense = [str(o) for o in OntologyStore(data_dir).get(me_id).ensure_loaded().objects(None, RDFS.comment)]
    assert any("defense" in c for c in defense) and not any("defence" in c for c in defense)


def test_the_real_qudt_is_seeded_removed_and_restored_under_its_fixed_id(tmp_path, parses, real_qudt):
    """reference-ontologies AC-2: the 6.9 MB file itself, once, through the
    same bookkeeping as the examples."""
    store = OntologyStore(tmp_path)
    qudt = library_examples.example_id("qudt")
    assert library_examples.seed(store) == [library_examples.example_id(k) for k in KEYS]
    summary = store.get(qudt).summary()
    assert summary["name"] == "QUDT" and summary["source"] == "example"
    assert summary["triples"] == 132_166
    assert summary["card"]["sketch"]["nodes"]
    assert library_examples.as_listed(summary)["example"]["group"] == "reference"

    assert store.remove(qudt)
    parses.clear()
    restarted = OntologyStore(tmp_path)
    assert library_examples.seed(restarted) == [] and restarted.get(qudt) is None
    assert parses == []
    assert library_examples.restore(restarted) == [qudt]
    assert parses == ["turtle"]
    assert OntologyStore(tmp_path).get(qudt).summary()["triples"] == 132_166


def test_a_changed_qudt_replaces_its_entry_under_the_same_id(tmp_path, parses, monkeypatch):
    data_dir = tmp_path / "data"
    library_examples.seed(OntologyStore(data_dir))
    oid = library_examples.example_id("qudt")
    before = OntologyStore(data_dir).get(oid).summary()["triples"]
    extra = b'<http://example.org/units#Second> <http://www.w3.org/2000/01/rdf-schema#label> "second"@en .\n'
    entries = _changed_manifest(tmp_path, "qudt", extra)
    monkeypatch.setattr(library_examples, "load_manifest", lambda: entries)
    restarted = OntologyStore(data_dir)
    assert library_examples.seed(restarted) == [oid]
    assert restarted.get(oid).summary()["triples"] == before + 1


def test_a_listed_entry_carries_its_group_from_the_manifest(tmp_path, parses):
    """Attached when listed, never stored: an entry seeded before groups
    existed, whose record has only key and purpose, gains its group."""
    store = OntologyStore(tmp_path)
    library_examples.seed(store)
    groups = {}
    for ontology in store.list():
        record = ontology.summary()["example"]
        assert set(record) == {"key", "purpose"}
        groups[record["key"]] = library_examples.as_listed(ontology.summary())["example"]["group"]
    assert groups == {"space": "example", "middle-earth": "example", "foaf": "reference", "qudt": "reference"}
    # A person's own file is no bundled entry, whatever it is called.
    own = {"source": "upload", "name": "QUDT", "example": None}
    assert library_examples.as_listed(own) == own


def test_a_failed_entry_does_not_hide_the_ones_restored(tmp_path, parses, monkeypatch):
    """PR #71 review: QUDT failing, last, must not lose Space and LOTR, which
    are on disk; it stays missing, and nothing at all is a failure."""
    store = OntologyStore(tmp_path)
    library_examples.seed(store)
    for key in ("space", "middle-earth", "qudt"):
        store.remove(library_examples.example_id(key))
    broken = [{**e, "file": str(tmp_path / "gone.ttl")} if e["key"] == "qudt" else e for e in SEEDED]
    monkeypatch.setattr(library_examples, "load_manifest", lambda: broken)
    assert library_examples.restore(store) == [library_examples.example_id(k) for k in ("space", "middle-earth")]
    assert store.get(library_examples.example_id("qudt")) is None
    with pytest.raises(OSError):
        library_examples.restore(store)


def test_restore_adds_back_only_the_missing_ones(tmp_path, parses):
    store = OntologyStore(tmp_path)
    library_examples.seed(store)
    gone = library_examples.example_id("foaf")
    store.remove(gone)
    kept = store.get(library_examples.example_id("space"))
    parses.clear()
    assert library_examples.restore(store) == [gone]
    assert len(parses) == 1
    assert store.get(library_examples.example_id("space")) is kept
    assert library_examples.restore(store) == []
    # And the next start leaves the restored one where it is.
    assert library_examples.seed(OntologyStore(tmp_path)) == []


# --- the endpoint and the start-up -------------------------------------------

HEADERS = {"X-Semantic-Studio": "1"}


@pytest.fixture
def no_examples_after():
    """The app's own store is shared by every test file: leave it as found."""
    yield
    for key in KEYS:
        app_store.remove(library_examples.example_id(key))
    (app_store.data_dir / "examples.json").unlink(missing_ok=True)


def test_the_server_start_seeds_the_library(no_examples_after, parses):
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
        listed = {o["id"]: o for o in client.get("/api/ontologies").json()}
    for key in KEYS:
        assert listed[library_examples.example_id(key)]["source"] == "example"


def test_a_failed_seed_does_not_stop_the_server(no_examples_after, monkeypatch):
    def broken(_store):
        raise OSError("the data folder is read-only")

    monkeypatch.setattr(library_examples, "seed", broken)
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/ontologies").status_code == 200


def test_restore_endpoint_brings_back_only_the_missing_ones(no_examples_after, parses):
    library_examples.seed(app_store)
    client = TestClient(app, base_url="http://localhost", headers=HEADERS)
    gone = library_examples.example_id("middle-earth")
    assert client.delete(f"/api/ontologies/{gone}").status_code == 200
    parses.clear()
    response = client.post("/api/examples/restore")
    assert response.status_code == 200
    body = response.json()
    assert body["restored"] == [gone]
    assert len(parses) == 1
    ids = [o["id"] for o in body["ontologies"]]
    assert all(library_examples.example_id(k) in ids for k in KEYS)
    assert body["ontologies"] == client.get("/api/ontologies").json()
    assert client.post("/api/examples/restore").json()["restored"] == []


def test_restore_endpoint_goes_through_local_guard(no_examples_after, parses):
    library_examples.seed(app_store)
    gone = library_examples.example_id("foaf")
    app_store.remove(gone)
    bare = TestClient(app, base_url="http://localhost")
    assert bare.post("/api/examples/restore").status_code == 403
    foreign = TestClient(app, base_url="http://localhost",
                         headers={**HEADERS, "Origin": "http://evil.example"})
    assert foreign.post("/api/examples/restore").status_code == 403
    assert app_store.get(gone) is None


def test_an_unknown_entity_is_said_in_statements_not_triples(no_examples_after, parses):
    # 5.7: the detail panel shows this 404's words as they come.
    library_examples.seed(app_store)
    client = TestClient(app, base_url="http://localhost", headers=HEADERS)
    oid = library_examples.example_id("space")
    response = client.get(f"/api/ontologies/{oid}/node", params={"iri": "http://example.org/space#Nothing"})
    assert response.status_code == 404
    assert response.json()["detail"] == "No statements found for http://example.org/space#Nothing"


# --- Space Exploration: every floor of 5.2 ------------------------------------


def _named(graph: Graph, kind) -> set:
    return {s for s in graph.subjects(RDF.type, kind) if isinstance(s, URIRef)}


def _classes(graph: Graph) -> set:
    return _named(graph, OWL.Class) | _named(graph, RDFS.Class)


def _properties(graph: Graph) -> set:
    return (
        _named(graph, OWL.ObjectProperty)
        | _named(graph, OWL.DatatypeProperty)
        | _named(graph, OWL.AnnotationProperty)
    )


def test_space_has_twenty_classes_three_levels_deep(space):
    classes = _classes(space)
    assert len(classes) >= 20

    def depth(cls, seen=()) -> int:
        parents = [p for p in space.objects(cls, RDFS.subClassOf) if p in classes and p not in seen]
        return 1 + max((depth(p, seen + (cls,)) for p in parents), default=0)

    assert max(depth(c) for c in classes) >= 3
    # The examples 5.2 names.
    assert (SPACE.TerrestrialPlanet, RDFS.subClassOf, SPACE.Planet) in space
    assert (SPACE.Planet, RDFS.subClassOf, SPACE.CelestialBody) in space
    for craft in ("Probe", "CrewedSpacecraft", "Rover"):
        assert (SPACE[craft], RDFS.subClassOf, SPACE.Spacecraft) in space
    assert (SPACE.CrewedMission, RDFS.subClassOf, SPACE.Mission) in space
    assert (SPACE.SpaceAgency, RDFS.subClassOf, SPACE.Organization) in space


def test_space_labels_every_class_and_property_in_english_and_french(space):
    for term in _classes(space) | _properties(space):
        langs = {o.language for o in space.objects(term, RDFS.label) if isinstance(o, Literal)}
        assert {"en", "fr"} <= langs, term
        comments = [o for o in space.objects(term, RDFS.comment) if o.language == "en"]
        assert comments, term


def test_space_has_every_graph_kind(space):
    assert _named(space, OWL.ObjectProperty)
    assert _named(space, OWL.DatatypeProperty)
    assert _named(space, OWL.AnnotationProperty)
    assert _named(space, SKOS.ConceptScheme)
    assert _named(space, SKOS.Concept)
    assert _named(space, SKOS.Collection)
    assert _named(space, OWL.Ontology)
    # One class declared with RDFS alone, for the RDFS class colour.
    assert _named(space, RDFS.Class) - _named(space, OWL.Class)


def _individuals(graph: Graph) -> set:
    classes = _classes(graph)
    return {s for s, o in graph.subject_objects(RDF.type) if o in classes and isinstance(s, URIRef)}


def test_space_has_thirty_linked_individuals(space):
    individuals = _individuals(space)
    assert len(individuals) >= 30
    assert (SPACE.Sun, RDF.type, SPACE.Star) in space
    planets = {s for s in individuals if any(
        space.query("ASK { ?s rdf:type/rdfs:subClassOf* ?c }", initBindings={"s": s, "c": SPACE.Planet})
    )}
    assert {SPACE[p] for p in ("Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune")} == planets
    assert (SPACE.Pluto, RDF.type, SPACE.DwarfPlanet) in space
    assert (SPACE.Ceres, RDF.type, SPACE.DwarfPlanet) in space
    assert len(set(space.subjects(RDF.type, SPACE.Moon))) >= 5
    assert len(set(space.subjects(RDF.type, SPACE.SpaceAgency))) >= 6

    missions = {s for s in space.subjects(SPACE.usedSpacecraft, None)}
    complete = {
        m for m in missions
        if (m, SPACE.operatedBy, None) in space
        and ((m, SPACE.target, None) in space or (m, SPACE.landedOn, None) in space)
    }
    assert len(complete) >= 8


def test_space_has_data_values_of_every_common_type(space):
    typed = {o.datatype for o in space.objects() if isinstance(o, Literal) and o.datatype}
    for datatype in (XSD.integer, XSD.decimal, XSD.date, XSD.gYear, XSD.boolean):
        assert datatype in typed, datatype
    # A string-valued property: its range says xsd:string, and Turtle writes
    # its plain values without the type, as RDF 1.1 reads them.
    strings = [p for p in space.subjects(RDFS.range, XSD.string)]
    assert strings and any(
        isinstance(o, Literal) and o.datatype in (None, XSD.string) and not o.language
        for p in strings for o in space.objects(None, p)
    )


def test_space_has_what_the_reasoner_works_on(space):
    assert (SPACE.orbits, OWL.inverseOf, SPACE.isOrbitedBy) in space
    assert (SPACE.partOf, RDF.type, OWL.TransitiveProperty) in space
    assert _named(space, OWL.SymmetricProperty)
    assert any(p in _properties(space) for p in space.objects(None, RDFS.subPropertyOf))
    assert (SPACE.Luna, OWL.sameAs, SPACE.EarthsMoon) in space
    # A domain or range that places an individual with no stated type.
    typed = set(space.subjects(RDF.type, None))
    placed = False
    for prop, _ in space.subject_objects(RDFS.domain):
        placed |= any(s not in typed for s in space.subjects(prop, None))
    for prop, _ in space.subject_objects(RDFS.range):
        placed |= any(isinstance(o, URIRef) and o not in typed for o in space.objects(None, prop))
    assert placed


def _restrictions(graph: Graph, predicate) -> list:
    return [r for r in graph.subjects(RDF.type, OWL.Restriction) if (r, predicate, None) in graph]


def test_space_has_rules_on_classes_and_a_defined_class(space):
    assert _restrictions(space, OWL.someValuesFrom)
    assert _restrictions(space, OWL.allValuesFrom)
    qualified = [OWL.qualifiedCardinality, OWL.minQualifiedCardinality, OWL.maxQualifiedCardinality]
    assert any(_restrictions(space, q) for q in qualified)
    assert [c for c, _ in space.subject_objects(OWL.equivalentClass) if isinstance(c, URIRef)]


def test_space_has_both_kinds_of_disjointness(space):
    assert list(space.subject_objects(OWL.disjointWith))
    assert list(space.subjects(RDF.type, OWL.AllDisjointClasses))


def test_space_has_the_mission_types_scheme(space):
    scheme = SPACE.MissionTypes
    concepts = set(space.subjects(SKOS.inScheme, scheme))
    assert len(concepts) >= 8
    assert len(set(space.objects(scheme, SKOS.hasTopConcept))) == 1
    # Two levels below the top: a concept whose broader has a broader.
    assert any(
        (b, SKOS.broader, None) in space for c in concepts for b in space.objects(c, SKOS.broader)
    )
    for predicate in (SKOS.broader, SKOS.narrower, SKOS.related, SKOS.altLabel, SKOS.definition, SKOS.notation):
        assert any((c, predicate, None) in space for c in concepts), predicate
    assert len(_named(space, SKOS.Collection)) == 1


def test_space_carries_what_the_documentation_export_reads(space):
    ontology = next(iter(_named(space, OWL.Ontology)))
    for predicate in (DCTERMS.title, DCTERMS.description, DCTERMS.creator, DCTERMS.created, OWL.versionInfo):
        assert (ontology, predicate, None) in space, predicate
    assert (ontology, DCTERMS.license, CC_BY_4) in space


def test_space_is_about_six_to_nine_hundred_statements(space):
    assert 600 <= len(space) <= 900


# --- The Lord of the Rings: the content of 5.3 ------------------------------

CHARACTERS = {
    "Hobbit": ["Frodo", "Bilbo", "Samwise", "Merry", "Pippin", "RosieCotton", "Gollum"],
    "Wizard": ["Gandalf", "Saruman"],
    "Man": ["Aragorn", "Boromir", "Faramir", "Denethor", "Theoden", "Eomer", "Eowyn"],
    "Elf": ["Legolas", "Elrond", "Arwen", "Galadriel"],
    "Dwarf": ["Gimli", "Gloin"],
    "Maia": ["Sauron"],
    "Ent": ["Treebeard"],
}


def _is_a(graph: Graph, term, cls) -> bool:
    return bool(graph.query(
        "ASK { ?t rdf:type/rdfs:subClassOf* ?c }", initBindings={"t": term, "c": cls}
    ))


def test_lotr_model(middle_earth):
    g = middle_earth
    for kind in ("Hobbit", "Elf", "Dwarf", "Man", "Wizard", "Ent", "Maia"):
        assert _is_a(g, ME[kind], OWL.Class)
        assert (ME[kind], RDFS.subClassOf, ME.Character) in g or (
            ME[kind], RDFS.subClassOf, ME.Maia
        ) in g, kind
    disjoint = next(g.subjects(RDF.type, OWL.AllDisjointClasses))
    members = set(g.items(g.value(disjoint, OWL.members)))
    assert members == {ME.Hobbit, ME.Elf, ME.Dwarf, ME.Man}
    for sub, sup in [("Region", "Place"), ("Realm", "Place"), ("Settlement", "Place"),
                     ("Fortress", "Place"), ("Ring", "Artifact"), ("Weapon", "Artifact"),
                     ("Battle", "Event"), ("Council", "Event")]:
        assert (ME[sub], RDFS.subClassOf, ME[sup]) in g
    assert (ME.Group, RDF.type, OWL.Class) in g and (ME.Book, RDF.type, OWL.Class) in g
    assert (ME.parentOf, OWL.inverseOf, ME.childOf) in g
    assert (ME.spouseOf, RDF.type, OWL.SymmetricProperty) in g
    assert (ME.siblingOf, RDF.type, OWL.SymmetricProperty) in g
    assert (ME.locatedIn, RDF.type, OWL.TransitiveProperty) in g
    for prop in ("memberOf", "livesIn", "bears", "wields", "madeBy", "takesPartIn",
                 "takesPlaceIn", "appearsIn", "leaderOf"):
        assert (ME[prop], RDF.type, OWL.ObjectProperty) in g, prop
    assert (ME.bornInYear, RDFS.range, XSD.integer) in g
    assert (ME.publishedIn, RDFS.range, XSD.gYear) in g


def test_lotr_characters_and_aliases(middle_earth):
    g = middle_earth
    for kind, names in CHARACTERS.items():
        for name in names:
            assert (ME[name], RDF.type, ME[kind]) in g, name
    for who, alias in [("Aragorn", "Strider"), ("Gandalf", "Mithrandir"), ("Gollum", "Sméagol"),
                       ("Aragorn", "Elessar")]:
        assert alias in {str(o) for o in g.objects(ME[who], SKOS.altLabel)}, alias


def test_lotr_fellowship_and_family(middle_earth):
    g = middle_earth
    nine = {"Frodo", "Samwise", "Merry", "Pippin", "Gandalf", "Aragorn", "Legolas", "Gimli", "Boromir"}
    assert set(g.subjects(ME.memberOf, ME.TheFellowship)) == {ME[n] for n in nine}
    assert (ME.TheFellowship, RDF.type, ME.Group) in g
    for parent, child in [("Denethor", "Boromir"), ("Denethor", "Faramir"),
                          ("Elrond", "Arwen"), ("Gloin", "Gimli")]:
        assert (ME[parent], ME.parentOf, ME[child]) in g
    assert (ME.Eomer, ME.siblingOf, ME.Eowyn) in g
    assert (ME.Aragorn, ME.spouseOf, ME.Arwen) in g
    assert (ME.Samwise, ME.spouseOf, ME.RosieCotton) in g


def test_lotr_rings_and_weapons(middle_earth):
    g = middle_earth
    assert (ME.TheOneRing, ME.madeBy, ME.Sauron) in g
    bearers = set(g.subjects(ME.bears, ME.TheOneRing))
    assert bearers == {ME.Bilbo, ME.Frodo, ME.Gollum, ME.Samwise}
    for who, ring in [("Gandalf", "Narya"), ("Galadriel", "Nenya"), ("Elrond", "Vilya")]:
        assert (ME[who], ME.bears, ME[ring]) in g
    for who, weapon in [("Bilbo", "Sting"), ("Frodo", "Sting"), ("Aragorn", "Anduril"),
                        ("Gandalf", "Glamdring")]:
        assert (ME[who], ME.wields, ME[weapon]) in g


def test_lotr_places_nest(middle_earth):
    g = middle_earth
    nesting = [("Eriador", "MiddleEarth"), ("TheShire", "Eriador"), ("Hobbiton", "TheShire"),
               ("Rivendell", "Eriador"), ("Rohan", "MiddleEarth"), ("Edoras", "Rohan"),
               ("HelmsDeep", "Rohan"), ("Gondor", "MiddleEarth"), ("MinasTirith", "Gondor"),
               ("Mordor", "MiddleEarth"), ("MountDoom", "Mordor"), ("Lothlorien", "MiddleEarth"),
               ("Moria", "MiddleEarth"), ("Isengard", "MiddleEarth")]
    for inner, outer in nesting:
        assert (ME[inner], ME.locatedIn, ME[outer]) in g, inner
        assert _is_a(g, ME[inner], ME.Place), inner


def test_lotr_books_and_events(middle_earth):
    g = middle_earth
    for book, year in [("FellowshipOfTheRing", "1954"), ("TheTwoTowers", "1954"),
                       ("TheReturnOfTheKing", "1955")]:
        assert (ME[book], ME.publishedIn, Literal(year, datatype=XSD.gYear)) in g
        assert (ME[book], DCTERMS.creator, Literal("J. R. R. Tolkien")) in g
    for name in ("Frodo", "Samwise", "Gandalf", "Aragorn"):
        assert len(set(g.objects(ME[name], ME.appearsIn))) == 3, name
    events = [("CouncilOfElrond", "Rivendell", "Council"), ("BattleOfHelmsDeep", "HelmsDeep", "Battle"),
              ("BattleOfThePelennorFields", "MinasTirith", "Battle"),
              ("DestructionOfTheRing", "MountDoom", "Event")]
    for event, place, kind in events:
        assert (ME[event], RDF.type, ME[kind]) in g
        assert (ME[event], ME.takesPlaceIn, ME[place]) in g
        assert list(g.subjects(ME.takesPartIn, ME[event])), event


def test_lotr_birth_years(middle_earth):
    g = middle_earth
    for who, year in [("Bilbo", 2890), ("Frodo", 2968), ("Samwise", 2980), ("Merry", 2982),
                      ("Pippin", 2990), ("Aragorn", 2931)]:
        assert (ME[who], ME.bornInYear, Literal(year, datatype=XSD.integer)) in g, who


def test_lotr_says_what_it_is_and_is_not(middle_earth):
    g = middle_earth
    ontology = next(iter(_named(g, OWL.Ontology)))
    assert str(g.value(ontology, DCTERMS.description)) == (
        "An unofficial teaching dataset of facts from The Lord of the Rings. "
        "Not affiliated with or endorsed by the Tolkien Estate."
    )
    assert (ontology, DCTERMS.license, CC_BY_4) in g


# A sentence ends at . ! or ? followed by a space or the end; an initial
# such as "J. R. R." would count, which is why it is never in a comment.
_SENTENCE_END = re.compile(r"[.!?](\s|$)")


def test_lotr_comments_are_one_plain_sentence_at_most(middle_earth):
    comments = list(middle_earth.objects(None, RDFS.comment))
    assert comments
    for comment in comments:
        assert len(_SENTENCE_END.findall(str(comment).strip())) == 1, str(comment)


def test_lotr_is_about_five_to_eight_hundred_statements(middle_earth):
    assert 500 <= len(middle_earth) <= 800


# --- the ready-made questions (query-page-rework 5.4, AC-8) ---------------

QUESTIONS = [(e["key"], q) for e in MANIFEST["examples"] for q in e.get("questions", [])]

# 5.4's table, as measured: rows, and for the short ones the names in order.
ANSWERS = {
    "space-missions-to-mars": (3, ["Mars 2020", "Mars Orbiter Mission", "Tianwen-1"]),
    "space-moons-of-jupiter": (4, ["Callisto", "Europa", "Ganymede", "Io"]),
    "space-missions-per-agency": (8, None),
    "middle-earth-ring-bearers": (4, ["Bilbo Baggins", "Frodo Baggins", "Gollum", "Samwise Gamgee"]),
    "middle-earth-fellowship": (9, None),
    "middle-earth-who-lives-where": (21, None),
    "foaf-classes": (13, None),
    "foaf-person-properties": (16, None),
}


def test_every_example_has_two_or_three_questions_and_5_4s_eight_in_all():
    for entry in MANIFEST["examples"]:
        # QUDT came with none (reference-ontologies writes no questions).
        if entry["key"] == "qudt":
            continue
        assert 2 <= len(entry["questions"]) <= 3, entry["key"]
    assert sorted(q["id"] for _key, q in QUESTIONS) == sorted(ANSWERS)


@pytest.mark.parametrize("key,question", QUESTIONS, ids=lambda v: v["id"] if isinstance(v, dict) else v)
def test_each_question_exists_matches_its_hash_and_is_a_select(key, question):
    from app.sparql_exec import prepare_select

    path = APP / question["file"]
    assert path.parent == APP / "examples" / "questions"
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == question["sha256"]
    text = data.decode("utf-8")
    # Opens with the one line that says what it shows.
    assert text.startswith("# ") and len(text.split("\n", 1)[0]) > 10
    prepare_select(text)  # raises unless a SELECT this application may run
    assert question["title"].endswith("?")


def test_the_question_files_are_binary_in_gitattributes():
    attributes = (APP.parent.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "backend/app/examples/questions/*.rq binary" in attributes


def test_every_question_answers_as_5_4_records(no_examples_after, parses):
    """Each question run against its example, through the route a click
    takes, with the row count 5.4 measured; the agency count NASA first."""
    library_examples.seed(app_store)
    client = TestClient(app, base_url="http://localhost", headers=HEADERS)
    for key, question in QUESTIONS:
        oid = library_examples.example_id(key)
        text = (APP / question["file"]).read_text(encoding="utf-8")
        response = client.post(f"/api/ontologies/{oid}/sparql", json={"query": text})
        assert response.status_code == 200, (question["id"], response.text)
        body = response.json()
        rows, names = ANSWERS[question["id"]]
        assert body["rowCount"] == rows, question["id"]
        if names is not None:
            assert [row[1]["value"] for row in body["rows"]] == names, question["id"]
        if question["id"] == "space-missions-per-agency":
            assert body["rows"][0][1]["value"] == "NASA"
            assert body["rows"][0][2]["value"] == "9"


def test_a_listed_example_carries_its_questions_and_nothing_else_does(no_examples_after, parses, tmp_path):
    """The record is attached when listed, by `source` and the example
    record, never by name: a library entry called Space Exploration is not
    an example."""
    library_examples.seed(app_store)
    client = TestClient(app, base_url="http://localhost", headers=HEADERS)
    space_file = (APP / "examples" / "space-exploration.ttl").read_bytes()
    copy = client.post(
        "/api/ontologies/upload", files={"file": ("Space Exploration.ttl", space_file, "text/turtle")}
    ).json()["id"]
    try:
        listed = {o["id"]: o for o in client.get("/api/ontologies").json()}
        space = listed[library_examples.example_id("space")]["example"]
        assert [q["title"] for q in space["questions"]] == [
            "Which missions went to Mars?",
            "Which moons orbit Jupiter?",
            "How many missions did each agency run?",
        ]
        first = space["questions"][0]
        assert set(first) == {"id", "title", "about", "text"}
        assert first["text"] == (APP / "examples" / "questions" / "space-missions-to-mars.rq").read_text(encoding="utf-8")
        assert first["about"] == first["text"].split("\n", 1)[0][2:]
        assert listed[copy]["example"] is None
    finally:
        client.delete(f"/api/ontologies/{copy}")


def test_a_question_that_cannot_be_read_is_left_out_never_a_failed_listing(monkeypatch, tmp_path):
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["examples"][0]["questions"].append(
        {"id": "gone", "title": "Gone?", "file": "examples/questions/no-such-file.rq", "sha256": "0" * 64}
    )
    monkeypatch.setattr(library_examples, "load_manifest", lambda: manifest["examples"])
    library_examples._questions.cache_clear()
    try:
        listed = library_examples.as_listed(
            {"source": "example", "example": {"key": "space", "purpose": "p"}}
        )
        assert [q["id"] for q in listed["example"]["questions"]] == [
            q["id"] for q in MANIFEST["examples"][0]["questions"]
        ]
    finally:
        library_examples._questions.cache_clear()
