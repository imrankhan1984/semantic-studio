"""
================================================================================
FILE: backend/tests/test_saved_queries.py
================================================================================

SUMMARY
    The saved-query library after sparql-text-and-query-files: entries carry a
    `mode`, a text query may have no builder state, entries saved before the
    feature read as visual, and a query id that is not "q-" plus twelve hex
    digits is refused before it can name a file (backlog CF-5).

BASIC IDEA
    The traversal tests assert on the filesystem, not only on the status code.
    The defect was a 200 that wrote `escaped.json` one folder above
    `queries/`, so a 422 that still wrote the file would pass a status-only
    check and prove nothing. Every refused id is followed by a scan of the
    data directory, and the scan itself is asserted to have found the store's
    real folder before its emptiness is trusted.

    The store is tested directly as well as through HTTP, because it is the
    second line of defence and the delete route hands it an id from the URL
    with no request model in front.

    The export (wording-and-query-export 5.12, 5.13) is read back as a zip:
    its entry names, each file's comment lines and its README. Hostile names
    (`../../x`, a line break, a drive letter) are checked on the entry names
    the archive really holds, and by unpacking it into an empty folder and
    finding nothing outside it.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl, uploaded through the API.
    - The conftest temp data directory.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-9, AC-10 and AC-13, and AC-14
      and AC-15 of wording-and-query-export.
================================================================================
"""

import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import query_export
from app.main import app
from app.queries_store import InvalidQueryId, SavedQueryStore
from app.store import saved_queries, store

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"
SELECT = "SELECT ?s WHERE { ?s ?p ?o }"
STATE = {"steps": [{"classIri": "http://example.org/space#Planet"}], "limit": 100}

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})


@pytest.fixture(scope="module")
def ontology_id() -> str:
    with EXAMPLE.open("rb") as handle:
        response = client.post(
            "/api/ontologies/upload", files={"file": ("space.ttl", handle, "text/turtle")}
        )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _json_files_outside_queries() -> set[Path]:
    """Every .json under the data directory that is not in queries/ itself."""
    queries_dir = saved_queries.dir.resolve()
    data_dir = queries_dir.parent
    # The scan has to be looking at the real store before its result means
    # anything: an empty set from the wrong folder would pass every test here.
    assert queries_dir.is_dir()
    # The whole data directory, and the top of the folder above it, which is
    # where an id with two `..` segments would have landed.
    found = set(data_dir.rglob("*.json")) | set(data_dir.parent.glob("*.json"))
    return {path.resolve() for path in found if path.resolve().parent != queries_dir}


def _save(ontology_id: str, **fields) -> "object":
    body = {"name": "q", "ontologyId": ontology_id, "state": STATE, "sparql": SELECT}
    body.update(fields)
    return client.post("/api/queries", json=body)


# --- mode (AC-9, AC-10) -------------------------------------------------------


def test_visual_is_the_default_mode(ontology_id):
    entry = _save(ontology_id).json()
    assert entry["mode"] == "visual"
    assert entry["state"] == STATE


def test_text_mode_is_stored_with_its_forked_state(ontology_id):
    # AC-10: the state it forked from travels with it, so Back to the visual
    # version still works after a reload.
    text = "SELECT ?s WHERE { { ?s a ?c } UNION { ?s ?p ?o } }"
    created = _save(ontology_id, mode="text", sparql=text).json()
    assert created["mode"] == "text"
    listed = {q["id"]: q for q in client.get("/api/queries", params={"ontology": ontology_id}).json()}
    assert listed[created["id"]]["mode"] == "text"
    assert listed[created["id"]]["sparql"] == text
    assert listed[created["id"]]["state"] == STATE


def test_text_query_written_from_nothing_has_null_state(ontology_id):
    created = _save(ontology_id, mode="text", state=None)
    assert created.status_code == 200, created.text
    assert created.json()["state"] is None


def test_visual_query_without_state_is_refused(ontology_id):
    assert _save(ontology_id, state=None).status_code == 400


def test_unknown_mode_is_refused(ontology_id):
    assert _save(ontology_id, mode="sql").status_code == 422


def test_entry_saved_before_mode_existed_reads_as_visual(ontology_id):
    # Written the way the store wrote before this feature: no `mode` key.
    qid = "q-0123456789ab"
    old = {
        "id": qid,
        "name": "Old query",
        "ontologyId": ontology_id,
        "ontologyName": "space.ttl",
        "state": STATE,
        "sparql": SELECT,
        "createdAt": "2026-08-01T00:00:00+00:00",
        "updatedAt": "2026-08-01T00:00:00+00:00",
    }
    path = saved_queries.dir / f"{qid}.json"
    path.write_text(json.dumps(old), encoding="utf-8")
    before = path.read_bytes()

    listed = {q["id"]: q for q in client.get("/api/queries", params={"ontology": ontology_id}).json()}
    assert listed[qid]["mode"] == "visual"
    # No migration: reading it did not rewrite it.
    assert path.read_bytes() == before
    client.delete(f"/api/queries/{qid}")


def test_update_keeps_id_and_can_change_mode(ontology_id):
    created = _save(ontology_id).json()
    updated = _save(ontology_id, id=created["id"], mode="text", sparql="SELECT * { ?a ?b ?c }").json()
    assert updated["id"] == created["id"]
    assert updated["mode"] == "text"
    assert updated["createdAt"] == created["createdAt"]


def test_saved_text_is_capped(ontology_id):
    assert _save(ontology_id, mode="text", sparql="#" * (100 * 1024 + 1)).status_code == 422
    assert _save(ontology_id, mode="text", sparql="#" * (100 * 1024)).status_code == 200


# --- the id is a file name (AC-13, CF-5) ---------------------------------------

HOSTILE_IDS = [
    "../escaped",
    "..\\x",
    "",
    "q-" + "a" * 13,  # one digit over
    "q-" + "a" * 500,  # over-long
    "q-0123456789AB",  # upper case is not what the store mints
    "q-0123456789ab\n",
    "q-0123456789ab/../../x",
    "/etc/passwd",
]


@pytest.mark.parametrize("qid", HOSTILE_IDS)
def test_hostile_id_is_refused_and_writes_nothing(ontology_id, qid):
    before = _json_files_outside_queries()
    queries_before = set(saved_queries.dir.iterdir())

    response = _save(ontology_id, id=qid)

    assert response.status_code == 422, response.text
    assert _json_files_outside_queries() == before
    # Nothing written inside queries/ either: a refused save is not a save.
    assert set(saved_queries.dir.iterdir()) == queries_before


def test_escape_that_used_to_work_is_now_absent(ontology_id):
    # The measured reproduction, restated as the absence of its product.
    target = saved_queries.dir.parent / "escaped.json"
    assert _save(ontology_id, id="../escaped").status_code == 422
    assert not target.exists()


def test_delete_with_a_backslash_id_touches_nothing(ontology_id, tmp_path):
    # The delete route takes its id from the URL, where `/` cannot reach it but
    # `\` can -- a path separator on Windows. It must answer "no such query"
    # and leave the file beside queries/ where it is.
    victim = saved_queries.dir.parent / "victim.json"
    victim.write_text("{}", encoding="utf-8")
    try:
        response = client.delete("/api/queries/..%5Cvictim")
        assert response.status_code == 404
        assert victim.exists()
    finally:
        victim.unlink(missing_ok=True)


def test_store_refuses_hostile_ids_on_its_own(tmp_path):
    # The second line of defence, with no request model in front of it.
    store = SavedQueryStore(tmp_path)
    for qid in ["../escaped", "..\\x", "q-0123456789ab\n"]:
        with pytest.raises(InvalidQueryId):
            store.save(name="n", ontology_id="o", ontology_name="o", state={}, sparql=SELECT, qid=qid)
        assert store.get(qid) is None
        assert store.delete(qid) is False
    assert list(tmp_path.rglob("*.json")) == []
    assert not (tmp_path / "escaped.json").exists()


def test_store_mints_ids_that_match_its_own_pattern(tmp_path):
    store = SavedQueryStore(tmp_path)
    entry = store.save(name="n", ontology_id="o", ontology_name="o", state={}, sparql=SELECT)
    assert store.get(entry["id"])["id"] == entry["id"]
    assert store.delete(entry["id"]) is True


# --- export (wording-and-query-export 5.12, 5.13; AC-14, AC-15) ---------------

_fresh = iter(range(10_000))


def _fresh_ontology(name: str = "Shop.ttl") -> str:
    """An ontology of its own, so a test counts only the queries it saved:
    the content differs each time, or the upload hands back the first."""
    n = next(_fresh)
    body = f"<http://example.org/shop#Thing{n}> a <http://www.w3.org/2002/07/owl#Class> .\n"
    response = client.post("/api/ontologies/upload", files={"file": (name, body.encode(), "text/turtle")})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _export(oid: str) -> zipfile.ZipFile:
    response = client.get("/api/queries/export", params={"ontologyId": oid})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith("attachment; filename=")
    return zipfile.ZipFile(io.BytesIO(response.content))


def test_export_holds_one_rq_per_query_visual_and_text_and_a_readme():
    oid = _fresh_ontology("Space missions.ttl")
    name = store.get(oid).name
    assert _save(oid, name="Planets").status_code == 200
    assert _save(oid, name="Moons by planet", mode="text", state=None,
                 sparql="SELECT ?m WHERE { ?m a ?c }").status_code == 200
    archive = _export(oid)
    assert sorted(archive.namelist()) == ["Moons by planet.rq", "Planets.rq", "README.txt"]

    today = date.today().isoformat()
    visual = archive.read("Planets.rq").decode("utf-8")
    assert visual == (
        "# Saved query: Planets\n"
        f"# Ontology: {name}\n"
        "# Made with: the visual builder\n"
        f"# Exported from Semantic Studio on {today}\n"
        "\n"
        f"{SELECT}\n"
    )
    text = archive.read("Moons by planet.rq").decode("utf-8")
    assert "# Made with: the text editor\n" in text
    assert text.endswith("SELECT ?m WHERE { ?m a ?c }\n")

    readme = archive.read("README.txt").decode("utf-8")
    assert "Query, choose\nText, then Open .rq file..." in readme
    assert "visual builder comes back as text" in readme


def test_export_names_are_safe_for_traversal_and_line_breaks(tmp_path):
    oid = _fresh_ontology()
    hostile = ["../../x", "first line\nsecond line", "C:\\Windows\\evil", "/etc/passwd", "..", "a\r# injected"]
    for name in hostile:
        assert _save(oid, name=name).status_code == 200
    archive = _export(oid)
    names = archive.namelist()
    # Read first: an archive with nothing in it would pass every check below.
    assert len(names) == len(hostile) + 1
    for entry in names:
        assert "/" not in entry and "\\" not in entry and ".." not in entry and ":" not in entry, entry
    assert "x.rq" in names and "first line second line.rq" in names and "query.rq" in names

    # Each name stays on its comment line: four comment lines, then a blank.
    for entry in names:
        if not entry.endswith(".rq"):
            continue
        head = archive.read(entry).decode("utf-8").split("\n")
        assert [line[:2] for line in head[:4]] == ["# "] * 4, head
        assert head[4] == "" and head[5] == SELECT
    broken = archive.read("first line second line.rq").decode("utf-8")
    assert broken.startswith("# Saved query: first line second line\n# Ontology: ")
    assert "# Saved query: a # injected\n" in archive.read("a injected.rq").decode("utf-8")

    # Unpacked, nothing lands outside the folder it was unpacked into.
    target = tmp_path / "out"
    target.mkdir()
    archive.extractall(target)
    assert sorted(p.name for p in tmp_path.rglob("*") if p.is_file() and target not in p.parents) == []
    assert len(list(target.iterdir())) == len(names)


def test_export_numbers_repeats_without_regard_to_case_and_cuts_long_names():
    oid = _fresh_ontology()
    for name in ["Bonds", "bonds", "Bonds", "readme", "x" * 200]:
        assert _save(oid, name=name).status_code == 200
    names = set(_export(oid).namelist())
    stems = {n[:-3] for n in names if n.endswith(".rq")}
    assert {s.casefold() for s in stems if s.casefold().startswith("bonds")} == {"bonds", "bonds (2)", "bonds (3)"}
    assert "readme.rq" in names and "README.txt" in names
    assert "x" * 80 + ".rq" in names


def test_export_with_no_saved_queries_holds_only_the_readme():
    assert _export(_fresh_ontology()).namelist() == ["README.txt"]


def test_export_of_an_unknown_ontology_is_404():
    response = client.get("/api/queries/export", params={"ontologyId": "ont-000000000000"})
    assert response.status_code == 404


@pytest.mark.parametrize("oid", ["../x", "ont-0123", "ont-0123456789AB", "prj-0123456789ab-model", "ont-0123456789ab\n", ""])
def test_export_refuses_an_id_outside_the_pattern_before_any_lookup(oid, monkeypatch):
    looked = []
    monkeypatch.setattr(store, "get", lambda *a, **k: looked.append(a))
    response = client.get("/api/queries/export", params={"ontologyId": oid})
    assert response.status_code == 422, response.text
    assert looked == []


def test_export_header_name_carries_no_quote_or_line_break():
    assert query_export.zip_filename('The "Lord"\r\nX-Evil: 1') == "The-Lord-X-Evil-1-saved-queries.zip"
    assert query_export.zip_filename("../..") == "ontology-saved-queries.zip"
