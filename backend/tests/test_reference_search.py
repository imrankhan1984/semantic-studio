"""
================================================================================
FILE: backend/tests/test_reference_search.py
================================================================================

SUMMARY
    Reference terms in the Edit pickers and the commands (reference-ontologies
    5.6, AC-7), the Turtle editor's check on Apply (5.7, AC-8), the index and
    its disk cache, and the Section 10 budgets on a generated fixture of
    QUDT's measured size.

BASIC IDEA
    Every check goes through the HTTP API, as the pickers and the editor do.
    A reference is in use only when the document declares its namespace, and
    rdflib binds foaf: in every Graph by default, so the decisive test is a
    project that declares nothing and is offered nothing. A declared prefix
    nothing uses yet must survive a visual change and a save, or the first
    class a learner makes would switch FOAF off.

    The budget fixture is generated, never committed: about 132,000
    statements and 6.8 MB of Turtle, a few hundred terms in the reference's
    own namespace and the rest individuals in another, QUDT's shape
    (Stage A's measurement). Each timing is a median of five with the
    collector paused (D-024), through limit_ms.

INPUTS / INPUT SOURCES
    - The bundled FOAF and QUDT files, through references.py.
    - The conftest temp data directory; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-7 and AC-8 (server side) and the Section 10 budgets.
================================================================================
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app import references
from app.editing import editing_service, project_store
from app.main import app
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

FOAF = "http://xmlns.com/foaf/0.1/"
QUDT = "http://qudt.org/schema/qudt/"


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _project(refs: list[str], template: str = "empty", **body) -> str:
    body.setdefault("name", "Staff")
    r = client.post("/api/projects", json={"template": template, "references": refs, **body})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


def _search(pid: str, q: str, kind: str = "class", refs: bool = True, imports: bool = True) -> list[dict]:
    r = client.get(
        f"/api/ontologies/{pid}-model/search",
        params={"q": q, "kind": kind, "references": str(refs).lower(), "imports": str(imports).lower()},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _command(pid: str, name: str, args: dict):
    return client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": name, "args": args})


def _apply(pid: str, text: str):
    return client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})


def _source(pid: str) -> str:
    return client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]


def _create_class(pid: str, label: str) -> str:
    r = _command(pid, "CreateClass", {"label": label})
    assert r.status_code == 200, r.text
    return r.json()["created"]


# --- AC-7: what the pickers offer ---------------------------------------------


def test_declared_foaf_offers_its_classes_after_the_documents_marked():
    pid = _project(["foaf"])
    own = _create_class(pid, "Organ donor")
    found = _search(pid, "organ")
    ids = [n["id"] for n in found]
    assert ids[0] == own, "the document's own match comes first"
    assert FOAF + "Organization" in ids
    organization = next(n for n in found if n["id"] == FOAF + "Organization")
    assert organization["fromReference"] == "FOAF"
    assert organization["label"] == "Organization"
    assert "fromReference" not in found[0]
    # Only the kind asked for: FOAF's properties are not classes.
    assert all(n["kind"] == "class" for n in found)


def test_property_kinds_are_offered_by_kind():
    pid = _project(["foaf"])
    found = _search(pid, "member", kind="objectProperty")
    assert FOAF + "member" in [n["id"] for n in found]
    assert all(n["kind"] == "objectProperty" for n in found)


def test_without_the_prefix_nothing_is_offered_though_rdflib_binds_foaf():
    pid = _project([])
    assert _search(pid, "organization") == []


def test_dcterms_requires_alone_puts_nothing_in_use():
    pid = _project([])
    text = _source(pid).replace(
        "a owl:Ontology", "a owl:Ontology ;\n    <http://purl.org/dc/terms/requires> <http://xmlns.com/foaf/0.1/>"
    )
    assert _apply(pid, text).status_code == 200
    assert _search(pid, "organization") == []


def test_references_false_offers_nothing():
    pid = _project(["foaf"])
    assert _search(pid, "organization", refs=False) == []


def test_a_prefix_typed_in_turtle_puts_the_reference_in_use():
    pid = _project([])
    text = f"@prefix f: <{FOAF}> .\n" + _source(pid)
    assert _apply(pid, text).status_code == 200
    assert FOAF + "Organization" in [n["id"] for n in _search(pid, "organization")]


def test_a_library_ontology_offers_no_reference_terms():
    oid = next(o["id"] for o in client.get("/api/ontologies").json() if o["source"] == "example") if any(
        o["source"] == "example" for o in client.get("/api/ontologies").json()
    ) else None
    if oid is None:
        upload = client.post(
            "/api/ontologies/upload",
            files={"file": ("lib.ttl", f"@prefix foaf: <{FOAF}> .\n<http://example.org/a> a <http://www.w3.org/2002/07/owl#Class> .".encode())},
        )
        oid = upload.json()["id"]
    r = client.get(f"/api/ontologies/{oid}/search", params={"q": "zzzorganization", "references": "true"})
    assert r.status_code == 200 and r.json() == []


def test_imported_and_declared_shows_once_as_imported():
    pid = _project(["foaf"])
    text = _source(pid).replace(
        "a owl:Ontology", "a owl:Ontology ;\n    <http://www.w3.org/2002/07/owl#imports> <http://xmlns.com/foaf/0.1/>"
    )
    assert _apply(pid, text).status_code == 200
    assert client.post(f"/api/ontologies/{pid}-model/imports/resolve").status_code == 200
    found = [n for n in _search(pid, "organization") if n["id"] == FOAF + "Organization"]
    assert len(found) == 1
    assert found[0].get("importedFrom") and "fromReference" not in found[0]


def test_the_index_is_never_sent_whole():
    listed = client.get("/api/references").json()
    assert [r["key"] for r in listed] == ["foaf", "qudt"]
    assert listed[0] == {
        "key": "foaf",
        "title": "FOAF",
        "prefixes": {"foaf": FOAF},
        "purpose": "people, organizations and their links",
        "sentence": "It reuses FOAF for people and organizations.",
    }
    assert listed[1]["prefixes"] == {"qudt": QUDT}
    pid = _project(["foaf"])
    r = client.get(f"/api/ontologies/{pid}-model/search", params={"q": "a", "references": "true", "limit": 5})
    assert len(r.json()) <= 5


# --- AC-7: the commands accept them -------------------------------------------


def test_context_exists_accepts_a_reference_term_in_use():
    pid = _project(["foaf"])
    child = _create_class(pid, "Company")
    r = _command(pid, "AddSubClassOf", {"child": child, "parent": FOAF + "Organization"})
    assert r.status_code == 200, r.text
    assert "foaf:Organization" in _source(pid)


def test_context_exists_refuses_it_when_not_in_use():
    pid = _project([])
    child = _create_class(pid, "Company")
    r = _command(pid, "AddSubClassOf", {"child": child, "parent": FOAF + "Organization"})
    assert r.status_code == 422


def test_context_exists_refuses_a_term_the_reference_does_not_define():
    pid = _project(["foaf"])
    child = _create_class(pid, "Company")
    r = _command(pid, "AddSubClassOf", {"child": child, "parent": FOAF + "Organisation"})
    assert r.status_code == 422


def test_a_declared_prefix_survives_a_visual_change_and_a_save():
    """QUDT, not FOAF: FOAF's dcterms:requires is written foaf:, which uses
    the prefix, while nothing in a new QUDT project uses qudt: yet (the
    removal check of keep_prefixes stayed green with FOAF)."""
    pid = _project(["qudt"])
    assert f"<{QUDT}>" not in _source(pid).split("PREFIX qudt:")[0], "only the declaration names it"
    _create_class(pid, "Pump")
    assert f"PREFIX qudt: <{QUDT}>" in _source(pid)
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 200
    text = (project_store.folder(pid) / "model.ttl").read_text(encoding="utf-8")
    assert f"qudt: <{QUDT}>" in text
    client.post(f"/api/projects/{pid}/close", json={})
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    assert QUDT + "QuantityKind" in [n["id"] for n in _search(pid, "quantity kind")]


def test_a_reference_not_in_use_is_never_indexed():
    """A FOAF project's pickers and checks never parse QUDT: in_use is what
    keeps a 6.9 MB parse away from projects that do not need it."""
    pid = _project(["foaf"])
    qudt = references.by_key("qudt")
    references.forget()
    (store.data_dir / "references" / f"{qudt['sha256']}.json").unlink(missing_ok=True)
    assert FOAF + "Organization" in [n["id"] for n in _search(pid, "organization")]
    child = _create_class(pid, "Company")
    assert _command(pid, "AddSubClassOf", {"child": child, "parent": FOAF + "Organization"}).status_code == 200
    _apply(pid, _source(pid) + "\n<http://example.org/staff#a> a <http://xmlns.com/foaf/0.1/Banana> .\n")
    assert qudt["sha256"] not in references._indexes
    assert references.by_key("foaf")["sha256"] in references._indexes


def test_shapes_document_reads_the_models_declarations():
    pid = _project(["foaf"])
    assert client.post(f"/api/projects/{pid}/documents", json={"role": "shapes"}).status_code == 200
    assert editing_service.declared_for(f"{pid}-shapes").get("foaf") == FOAF


# --- AC-8: the Turtle editor's check ------------------------------------------


def test_apply_names_an_unknown_reference_term_with_the_closest_match_and_still_applies():
    pid = _project(["qudt"])
    before = client.post(f"/api/projects/{pid}/open").json()["documents"][0]["revision"]
    text = _source(pid) + "\n<http://example.org/staff#Pump> <http://qudt.org/schema/qudt/hasQuantityKnd> <http://example.org/staff#x> .\n"
    r = _apply(pid, text)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] > before, "the text applied"
    assert body["references"] == {
        "terms": [{"term": "qudt:hasQuantityKnd", "reference": "QUDT", "suggestion": "qudt:hasQuantityKind"}],
        "more": 0,
    }


def test_apply_names_a_term_with_no_close_match_without_a_suggestion():
    pid = _project(["foaf"])
    r = _apply(pid, _source(pid) + "\n<http://example.org/staff#a> a <http://xmlns.com/foaf/0.1/Banana> .\n")
    assert r.json()["references"]["terms"] == [{"term": "foaf:Banana", "reference": "FOAF", "suggestion": None}]


def test_apply_with_known_terms_or_no_reference_names_nothing():
    pid = _project(["foaf"])
    r = _apply(pid, _source(pid) + "\n<http://example.org/staff#a> a <http://xmlns.com/foaf/0.1/Person> .\n")
    assert r.json()["references"] == {"terms": [], "more": 0}
    plain = _project([])
    r = _apply(plain, _source(plain) + "\n<http://example.org/staff#a> a <http://xmlns.com/foaf/0.1/Banana> .\n")
    assert r.json()["references"] == {"terms": [], "more": 0}


def test_apply_counts_past_five():
    pid = _project(["foaf"])
    extra = "".join(f"\n<http://example.org/staff#a> a <{FOAF}Unknown{i}> ." for i in range(8))
    found = _apply(pid, _source(pid) + extra + "\n").json()["references"]
    assert len(found["terms"]) == 5 and found["more"] == 3


# --- the index and its cache ------------------------------------------------------


def test_index_holds_only_the_namespace_and_is_cached_on_disk_by_hash(monkeypatch):
    entry = references.by_key("foaf")
    references.forget()
    path = store.data_dir / "references" / f"{entry['sha256']}.json"
    if path.exists():
        path.unlink()
    built = references.index("foaf")
    assert all(t["iri"].startswith(FOAF) for t in built.terms)
    assert FOAF + "Organization" in built.defined
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["sha256"] == entry["sha256"] and saved["version"] == references.INDEX_VERSION
    references.forget()

    def no_parse(*_a, **_k):
        raise AssertionError("the disk cache should have answered")

    monkeypatch.setattr(references, "build", no_parse)
    again = references.index("foaf")
    assert again.defined == built.defined and again.terms == built.terms


def test_a_cache_of_another_hash_is_rebuilt():
    entry = references.by_key("foaf")
    references.forget()
    path = store.data_dir / "references" / f"{entry['sha256']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "sha256": "0" * 64, "terms": [], "defined": []}), encoding="utf-8")
    assert FOAF + "Organization" in references.index("foaf").defined


def test_keep_prefixes_writes_back_only_reference_prefixes():
    text = "PREFIX owl: <http://www.w3.org/2002/07/owl#>\n\n<http://e> a owl:Ontology .\n"
    kept = references.keep_prefixes(text, {"foaf": FOAF, "ex": "http://example.org/x#"})
    assert kept.startswith(f"PREFIX foaf: <{FOAF}>\n")
    assert "ex:" not in kept
    assert references.keep_prefixes(kept, {"foaf": FOAF}) == kept


def test_declared_prefixes_reads_both_forms():
    text = f'@prefix foaf: <{FOAF}> .\nPREFIX q: <{QUDT}>\n<a> <b> "@prefix x: <http://x/>" .\n'
    assert references.declared_prefixes(text) == {"foaf": FOAF, "q": QUDT}


# --- Section 10 budgets -----------------------------------------------------------


def _qudt_sized(tmp_path) -> dict:
    """About 132,000 statements and 6.8 MB of Turtle in QUDT's shape: five
    hundred terms in the reference's namespace, then individuals with long
    descriptions in another."""
    ns, other = "http://example.org/ref/", "http://example.org/unit/"
    lines = [
        f"@prefix ref: <{ns}> .",
        f"@prefix unit: <{other}> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
        "",
    ]
    kinds = ["owl:Class"] * 230 + ["owl:ObjectProperty"] * 100 + ["owl:DatatypeProperty"] * 100 + ["owl:AnnotationProperty"] * 76
    for i, kind in enumerate(kinds):
        lines.append(f'ref:Term{i} a {kind} ; rdfs:label "Term number {i}"@en ; rdfs:comment "A term of the reference."@en .')
    statements = len(kinds) * 3
    i = 0
    while statements < 132_000:
        lines.append(
            f'unit:U{i} a ref:Term0 ; rdfs:label "Unit {i}"@en ; ref:Term300 "{i}.5"^^xsd:decimal ;\n'
            f'    ref:Term230 unit:U{max(0, i - 1)} ; ref:Term231 unit:U{i // 2} ;\n'
            f'    rdfs:comment "A generated unit of measure, with a description about as long as those in the file it stands in for, which run to a sentence or two of prose about the unit, its symbol and where it is used, number {i}."@en ;\n'
            f'    ref:Term431 "U{i}" ; ref:Term432 "http://example.org/doc/{i}"^^xsd:anyURI ; ref:Term301 {i} .'
        )
        statements += 9
        i += 1
    data = "\n".join(lines).encode("utf-8")
    path = tmp_path / "ref.ttl"
    path.write_bytes(data)
    assert 6_000_000 < len(data) < 8_000_000, len(data)
    return {
        "key": "sized",
        "file": str(path),
        "format": "turtle",
        "sha256": hashlib.sha256(data).hexdigest(),
        "reuse": {"title": "Sized", "ontology": ns, "prefixes": {"ref": ns}, "purpose": "", "sentence": ""},
    }


def _median(run, samples: int = 5) -> float:
    """Median of five with the collector paused while each sample runs
    (D-024), and run between them: a parse leaves cycles behind, and five
    parses' worth held at once measured the heap, not the build (3.9 s
    against 1.6 s in a fresh process)."""
    times = []
    gc.disable()
    try:
        for _ in range(samples):
            gc.collect()
            start = time.perf_counter()
            run()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return statistics.median(times)


# A first build is the first parse in its process: a second parse in one
# process measured twice as slow on Windows with nothing left behind to
# collect (1.6 s, then 2.6 s and 3.5 s), so each sample is a fresh
# interpreter, timed inside it, its start-up and imports outside the clock.
_FIRST_BUILD = """
import json, sys, time
from app import references
entry = json.loads(sys.argv[1])
start = time.perf_counter()
found = references.index_of(entry)
print(json.dumps({"ms": (time.perf_counter() - start) * 1000, "terms": len(found.terms)}))
"""


@pytest.mark.perf
def test_budget_index_first_build_and_from_the_disk_cache(tmp_path):
    entry = _qudt_sized(tmp_path)
    data = tmp_path / "data"
    env = {**os.environ, "SEMANTIC_STUDIO_DATA_DIR": str(data)}
    cache = data / "references" / f"{entry['sha256']}.json"
    samples = []
    for _ in range(5):
        cache.unlink(missing_ok=True)
        out = subprocess.run(
            [sys.executable, "-c", _FIRST_BUILD, json.dumps(entry)],
            cwd=pathlib.Path(__file__).resolve().parents[1], env=env,
            capture_output=True, text=True, check=True,
        )
        result = json.loads(out.stdout.strip().splitlines()[-1])
        assert result["terms"] == 506
        samples.append(result["ms"])
    built = statistics.median(samples)
    assert cache.is_file(), "the first build writes the disk cache"
    assert built <= limit_ms(3000), f"first build took {built:.0f} ms (median of 5 fresh processes)"

    # From the cache: the file the last child wrote, read in this process.
    monkey = store.data_dir
    try:
        store.data_dir = data

        def cached():
            references.forget()
            assert len(references.index_of(entry).terms) == 506

        read = _median(cached)
    finally:
        store.data_dir = monkey
        references.forget()
    assert read <= limit_ms(200), f"from the disk cache took {read:.0f} ms (median of 5)"


@pytest.mark.perf
def test_budget_picker_search_with_qudt_in_use():
    pid = _project(["qudt"])
    references.index("qudt")  # built once, as the first picker would
    _search(pid, "quantity")  # the view built once, as any first search

    def run():
        _search(pid, "quantity")

    took = _median(run)
    assert took <= limit_ms(50), f"a picker search took {took:.1f} ms (median of 5)"


# --- found in code review ------------------------------------------------------


def test_the_autosave_draft_keeps_a_declared_reference_prefix():
    pid = _project(["qudt"])
    _create_class(pid, "Pump")
    document = editing_service.document(pid, "model")
    editing_service._write_draft(document, document.generation)
    draft = (project_store.folder(pid) / ".draft" / "model.ttl").read_text(encoding="utf-8")
    assert f"PREFIX qudt: <{QUDT}>" in draft


def test_undoing_an_apply_takes_its_declarations_away():
    pid = _project([])
    _create_class(pid, "Pump")  # the editor's text is now clean Turtle, none kept
    assert _apply(pid, f"@prefix qudt: <{QUDT}> .\n" + _source(pid)).status_code == 200
    assert editing_service.declared_for(f"{pid}-model").get("qudt") == QUDT
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200
    assert "qudt" not in editing_service.declared_for(f"{pid}-model")
    assert _search(pid, "quantity kind") == []
    assert client.post(f"/api/projects/{pid}/documents/model/redo").status_code == 200
    assert editing_service.declared_for(f"{pid}-model").get("qudt") == QUDT


def test_set_comment_holds_the_header_to_the_description_limit():
    pid = _project([])
    header = client.post(f"/api/projects/{pid}/open").json()["documents"][0]["header"]
    r = _command(pid, "SetComment", {"iri": header, "value": "x" * 2001})
    assert r.status_code == 422 and "at most 2,000 characters" in r.json()["detail"]
    assert _command(pid, "SetComment", {"iri": header, "value": "x" * 2000}).status_code == 200
    # Any other entity's comment is not a description.
    child = _create_class(pid, "Pump")
    assert _command(pid, "SetComment", {"iri": child, "value": "y" * 2001}).status_code == 200


def test_two_prefix_declarations_on_one_line_are_both_read():
    text = f"PREFIX ex: <http://example.org/x#> PREFIX foaf: <{FOAF}>\n<a> <b> <c> .\n"
    assert references.declared_prefixes(text) == {"ex": "http://example.org/x#", "foaf": FOAF}


def test_a_command_never_builds_an_index_under_the_document_lock(monkeypatch):
    pid = _project(["qudt"])
    child = _create_class(pid, "Pump")
    document = editing_service.document(pid, "model")
    references.forget()
    (store.data_dir / "references" / f"{references.by_key('qudt')['sha256']}.json").unlink(missing_ok=True)
    held = []
    real = references.build

    def watched(entry):
        held.append(document.lock._is_owned())
        return real(entry)

    monkeypatch.setattr(references, "build", watched)
    r = _command(pid, "AddSubClassOf", {"child": child, "parent": QUDT + "QuantityKind"})
    assert r.status_code == 200, r.text
    assert held == [False], "the first build ran while the document was locked"


# --- found in the PR #72 review ------------------------------------------------

OWN = "http://example.org/staff#"


def _own_project(refs: list[str], template: str = "empty", **body) -> str:
    return _project(refs, template, baseIri=OWN, prefix="staff", **body)


@pytest.mark.parametrize(
    "refs, body",
    [([], {"description": "Who works here."}), (["qudt"], {})],
    ids=["a description", "a reference"],
)
def test_a_new_project_keeps_its_own_prefix_and_a_line_using_it_applies(refs, body):
    """longturtle drops every unused prefix, the project's own included, so
    a template with an addition lost it and its first Turtle line using it
    failed as unbound, where a plain template accepted it."""
    pid = _own_project(refs, **body)
    text = (project_store.folder(pid) / "model.ttl").read_text(encoding="utf-8")
    assert f"PREFIX staff: <{OWN}>" in text or f"@prefix staff: <{OWN}>" in text
    r = _apply(pid, _source(pid) + "\nstaff:Pump a owl:Class .\n")
    assert r.status_code == 200, r.text


def test_the_own_prefix_survives_a_visual_change_and_a_save():
    pid = _own_project([])
    header = client.post(f"/api/projects/{pid}/open").json()["documents"][0]["header"]
    assert _command(pid, "SetComment", {"iri": header, "value": "Who works here."}).status_code == 200
    assert client.post(f"/api/projects/{pid}/documents/model/save", json={}).status_code == 200
    text = (project_store.folder(pid) / "model.ttl").read_text(encoding="utf-8")
    assert "Who works here." in text, "the save wrote the visual change"
    assert f"PREFIX staff: <{OWN}>" in text


def test_keep_prefixes_writes_the_own_prefix_once():
    text = "PREFIX owl: <http://www.w3.org/2002/07/owl#>\n\n<http://e> a owl:Ontology .\n"
    kept = references.keep_prefixes(text, {}, ("staff", OWN))
    assert kept.startswith(f"PREFIX staff: <{OWN}>\n")
    assert references.keep_prefixes(kept, {}, ("staff", OWN)) == kept


def test_a_cache_of_another_version_is_rebuilt():
    entry = references.by_key("foaf")
    references.forget()
    path = store.data_dir / "references" / f"{entry['sha256']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    stale = {"version": references.INDEX_VERSION + 1, "sha256": entry["sha256"], "terms": [], "defined": []}
    path.write_text(json.dumps(stale), encoding="utf-8")
    assert FOAF + "Organization" in references.index("foaf").defined
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == references.INDEX_VERSION
