"""
================================================================================
FILE: backend/tests/test_imports.py
================================================================================

SUMMARY
    owl:imports resolution (external-access Stage 2, backlog X-5, D-068):
    discovery, the resolution order, the closure and its limits, failure
    isolation, the merged view and its marking, provenance and refresh, the
    user's mapping, chosen files, the bundled vocabularies' manifest, and the
    two performance rows of Section 10.

BASIC IDEA
    Every network case runs against a recording server on loopback, under a
    public-looking name from conftest.py's `loopback_is_public`, and the
    assertions that matter are counts of what that server saw: zero requests
    before approval, zero for anything that resolves locally, exactly one on a
    refresh. A 4xx alone would not prove nothing was sent.

    The bundled cases use the real vocabulary IRIs (FOAF, SKOS, ...) on
    purpose, against the rdf-fixture rule, because resolving those IRIs with no
    network is the behaviour under test. They also replace broker.request with a
    function that fails the test, so "zero requests" does not depend on the
    sandbox having no internet.

INPUTS / INPUT SOURCES
    - The FastAPI app through TestClient; the imports service and store
      singletons; inline Turtle fixtures; backend/app/vocab/.

EXPECTED OUTPUT
    - Pass/fail per acceptance criterion AC-16 to AC-25 and AC-40 to AC-43
      (the backend half; the panel's half is ImportsPanel.test.tsx).
================================================================================
"""

from __future__ import annotations

import gc
import hashlib
import ipaddress
import io
import json
import shutil
import statistics
import time
import zipfile

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.graph import ModificationException

from app import imports as imports_mod
from app.graph_builder import build_viz_graph
from app.imports import MergedView, imports_service, load_manifest
from app.main import app
from app.network_broker import broker
from app.store import store

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

LOCAL = ipaddress.ip_address("127.0.0.1")
OWL_NS = "http://www.w3.org/2002/07/owl#"
PREFIXES = f"""
@prefix owl: <{OWL_NS}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/main#> .
"""


def ttl(body: str) -> bytes:
    return (PREFIXES + body).encode()


def _doc(iri: str, *, imports: tuple[str, ...] = (), cls: str = "Thing", extra: str = "") -> bytes:
    """A small ontology: its IRI, its imports, and one labelled class."""
    lines = [f"<{iri}> a owl:Ontology ."]
    lines += [f"<{iri}> owl:imports <{i}> ." for i in imports]
    lines.append(f"<{iri}/{cls}> a owl:Class ; rdfs:label \"{cls}\" .")
    return ttl("\n".join(lines) + extra)


def _upload(name: str, data: bytes) -> str:
    r = client.post("/api/ontologies/upload", files={"file": (name, data, "text/turtle")})
    assert r.status_code == 200, r.json()
    return r.json()["id"]


def _resolve(oid: str, grants: tuple[str, ...] = ()):
    headers = {"X-Semantic-Studio-Grant": ",".join(grants)} if grants else {}
    return client.post(f"/api/ontologies/{oid}/imports/resolve", headers=headers)


def _rows(oid: str) -> dict[str, dict]:
    r = client.get(f"/api/ontologies/{oid}/imports")
    assert r.status_code == 200, r.json()
    return {row["iri"]: row for row in r.json()["imports"]}


def _grant(host: str, remember: bool = True) -> dict:
    r = client.post(
        "/api/network/grants",
        json={"capability": "ontology:import", "host": host, "decision": "allow", "remember": remember},
    )
    assert r.status_code == 200, r.json()
    return r.json()


@pytest.fixture(autouse=True)
def _clean_library():
    """Each test starts with its own ontologies only and an empty imports cache.

    The store is a process singleton shared with other test files, so anything
    added here is removed afterwards, and the cache and catalog are wiped so a
    chosen file in one test cannot resolve an import in the next.
    """
    before = {o.id for o in store.list()}
    yield
    for ontology in store.list():
        if ontology.id not in before:
            store.remove(ontology.id)
    shutil.rmtree(imports_service.cache.dir, ignore_errors=True)
    imports_service.cache.catalog_path.unlink(missing_ok=True)
    imports_service.cache.clear()


@pytest.fixture
def no_network(monkeypatch):
    """Any attempt to reach the broker fails the test outright."""

    def refuse(*args, **kwargs):
        raise AssertionError(f"the broker was asked for {args[1] if len(args) > 1 else kwargs}")

    monkeypatch.setattr(broker, "request", refuse)


@pytest.fixture
def vocab_host(http_server, loopback_is_public):
    """`vocab.test`: a recording server holding documents by path."""
    docs: dict[str, tuple[int, bytes]] = {}

    def route(path):
        status, body = docs.get(path, (404, b"not here"))
        return status, {"Content-Type": "text/turtle"}, body

    server = http_server(route)
    loopback_is_public["vocab.test"] = [LOCAL]
    server.base = f"http://vocab.test:{server.server_address[1]}"
    server.docs = docs
    return server


# ---------------------------------------------------------------------------
# AC-16 -- listing costs nothing
# ---------------------------------------------------------------------------


def test_opening_lists_imports_and_fetches_nothing(vocab_host):
    """AC-16: the panel's listing names each import with a status, and neither
    the listing nor the graph request reaches the network."""
    remote = f"{vocab_host.base}/a"
    oid = _upload("main.ttl", _doc("http://example.org/main", imports=(remote, OWL_NS[:-1])))
    assert client.get(f"/api/ontologies/{oid}/graph").status_code == 200
    rows = _rows(oid)
    assert rows[remote]["status"] == "unresolved"
    assert rows[OWL_NS[:-1]]["status"] == "builtin"
    assert vocab_host.requests == []


# ---------------------------------------------------------------------------
# AC-17 -- the order
# ---------------------------------------------------------------------------


def test_bundled_imports_resolve_with_no_network(no_network):
    """AC-17: an ontology importing only bundled vocabularies resolves with zero
    network requests, and each row says it came from the bundle."""
    foaf, skos = "http://xmlns.com/foaf/0.1/", "http://www.w3.org/2004/02/skos/core"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(foaf, skos)))
    assert _resolve(oid).status_code == 200
    rows = _rows(oid)
    assert rows[foaf]["status"] == rows[skos]["status"] == "resolved"
    assert rows[foaf]["source"] == "bundled" and rows[foaf]["sourceName"] == "FOAF"


def test_builtin_namespaces_are_never_loaded(no_network):
    """AC-17 step 1: rdf, rdfs, owl and xsd are recognised, never looked for."""
    iris = (
        "http://www.w3.org/2002/07/owl",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2001/XMLSchema#",
    )
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=iris))
    _resolve(oid)
    assert {row["status"] for row in _rows(oid).values()} == {"builtin"}


def test_library_beats_bundled_and_matches_version_iri(no_network):
    """AC-17 step 2 before step 3: a library ontology declaring FOAF's IRI is
    used rather than the bundled copy; a versionIRI matches too."""
    foaf = "http://xmlns.com/foaf/0.1/"
    _upload("my-foaf.ttl", ttl(f"<{foaf}> a owl:Ontology . <{foaf}Local> a owl:Class ."))
    _upload(
        "versioned.ttl",
        ttl(
            "<http://example.org/v> a owl:Ontology ; "
            "owl:versionIRI <http://example.org/v/2.0> . ex:V a owl:Class ."
        ),
    )
    oid = _upload(
        "m.ttl", _doc("http://example.org/main", imports=(foaf, "http://example.org/v/2.0"))
    )
    _resolve(oid)
    rows = _rows(oid)
    assert rows[foaf]["source"] == "library"
    assert rows[foaf]["sourceName"] == "my-foaf.ttl"
    assert rows["http://example.org/v/2.0"]["source"] == "library"


def test_mapping_persists_and_beats_the_network(vocab_host):
    """AC-23: an import mapped to a library ontology resolves from it without a
    request, and the mapping survives a new service reading the same catalog."""
    remote = f"{vocab_host.base}/private"
    vocab_host.docs["/private"] = (200, _doc(remote))
    target = _upload("private-copy.ttl", _doc("http://example.org/elsewhere"))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(remote,)))
    _grant("vocab.test")
    r = client.post(
        f"/api/ontologies/{oid}/imports/mapping", json={"iri": remote, "ontologyId": target}
    )
    assert r.status_code == 200, r.json()
    assert _rows(oid)[remote]["source"] == "mapped"
    # A fresh service over the same data directory reads the catalog back.
    fresh = imports_mod.ImportsService(store)
    assert fresh.cache.mapping(remote)["ontologyId"] == target
    _resolve(oid)
    assert _rows(oid)[remote]["source"] == "mapped"
    assert vocab_host.requests == []


# ---------------------------------------------------------------------------
# Network, provenance, refresh (AC-17 step 5, AC-22)
# ---------------------------------------------------------------------------


def test_network_import_asks_first_then_caches_with_provenance(vocab_host):
    """No grant: 409 naming ontology:import and zero requests. After approval:
    resolved, with source URL, time and SHA-256 recorded (AC-22)."""
    remote = f"{vocab_host.base}/a.ttl"
    body = _doc(remote, cls="Remote")
    vocab_host.docs["/a.ttl"] = (200, body)
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(remote,)))

    r = _resolve(oid)
    assert r.status_code == 409
    [req] = r.json()["detail"]["requests"]
    assert req["capability"] == "ontology:import" and req["host"] == "vocab.test"
    assert '"m.ttl" imports' in req["reason"]
    assert vocab_host.requests == [], "fetched before approval"
    # What was resolved and what was asked is saved first; the row says why.
    assert "permission to connect to vocab.test" in _rows(oid)[remote]["error"]

    once = _grant("vocab.test", remember=False)
    assert _resolve(oid, (once["id"],)).status_code == 200
    row = _rows(oid)[remote]
    assert row["status"] == "resolved" and row["source"] == "network"
    assert row["fetchedAt"] and row["sourceUrl"] == remote
    assert row["sha256"] == hashlib.sha256(body).hexdigest()
    assert len(vocab_host.requests) == 1


def test_cached_copy_is_reused_and_refresh_refetches(vocab_host):
    """A second resolve reads the cache (no request); Refresh goes back through
    the broker (exactly one more)."""
    remote = f"{vocab_host.base}/a.ttl"
    vocab_host.docs["/a.ttl"] = (200, _doc(remote))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(remote,)))
    _grant("vocab.test")
    _resolve(oid)
    _resolve(oid)
    assert len(vocab_host.requests) == 1
    r = client.post(f"/api/ontologies/{oid}/imports/refresh")
    assert r.status_code == 200, r.json()
    assert len(vocab_host.requests) == 2


def test_refresh_without_a_grant_asks(vocab_host):
    """Refresh re-fetches through the broker, so a revoked site asks again."""
    remote = f"{vocab_host.base}/a.ttl"
    vocab_host.docs["/a.ttl"] = (200, _doc(remote))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(remote,)))
    grant = _grant("vocab.test")
    _resolve(oid)
    client.delete(f"/api/network/grants/{grant['id']}")
    assert client.post(f"/api/ontologies/{oid}/imports/refresh").status_code == 409
    assert len(vocab_host.requests) == 1


# ---------------------------------------------------------------------------
# AC-18 -- closure, cycles, limits
# ---------------------------------------------------------------------------


def test_closure_follows_imports_of_imports_and_stops_at_cycles(vocab_host):
    """AC-18: A imports B, B imports C and A. All three resolve once each; the
    cycle back to A and to the main file stops."""
    base = vocab_host.base
    a, b, c = f"{base}/a", f"{base}/b", f"{base}/c"
    vocab_host.docs["/a"] = (200, _doc(a, imports=(b,), cls="A"))
    vocab_host.docs["/b"] = (200, _doc(b, imports=(c, a, "http://example.org/main"), cls="B"))
    vocab_host.docs["/c"] = (200, _doc(c, cls="C"))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(a,)))
    _grant("vocab.test")
    assert _resolve(oid).status_code == 200
    rows = _rows(oid)
    assert {rows[i]["status"] for i in (a, b, c)} == {"resolved"}
    assert rows[c]["depth"] == 3 and rows[c]["importedBy"] == b
    assert rows[a]["documentCount"] == 3
    assert sorted(vocab_host.requests) == ["/a", "/b", "/c"]
    assert "http://example.org/main" not in rows


@pytest.mark.parametrize(
    "limit, value, expected",
    [
        ("MAX_DEPTH", 2, "deeper than 2 levels"),
        ("MAX_DOCUMENTS", 2, "first 2 imported documents"),
        ("MAX_TOTAL_BYTES", 450, "150 MB total limit"),
    ],
)
def test_closure_limits_keep_what_fits_and_name_the_limit(
    vocab_host, monkeypatch, limit, value, expected
):
    """AC-18: at a limit, what fits is kept and the listing names the limit."""
    monkeypatch.setattr(imports_mod, limit, value)
    base = vocab_host.base
    chain = [f"{base}/d{i}" for i in range(4)]
    for i, iri in enumerate(chain):
        nxt = (chain[i + 1],) if i + 1 < len(chain) else ()
        vocab_host.docs[f"/d{i}"] = (200, _doc(iri, imports=nxt, cls=f"D{i}"))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(chain[0],)))
    _grant("vocab.test")
    assert _resolve(oid).status_code == 200
    listing = client.get(f"/api/ontologies/{oid}/imports").json()
    assert expected in listing["limit"]
    statuses = [row["status"] for row in listing["imports"]]
    assert statuses[0] == "resolved"
    assert "unresolved" in statuses
    graph = client.get(f"/api/ontologies/{oid}/graph?imports=true")
    assert graph.status_code == 200


# ---------------------------------------------------------------------------
# AC-19 -- failure isolation
# ---------------------------------------------------------------------------


def test_a_failed_import_never_stops_the_ontology(vocab_host):
    """AC-19: a 404 and an unparseable import each fail with a reason; the
    other import resolves, and the ontology opens with imports on or off."""
    base = vocab_host.base
    good, missing, broken = f"{base}/good", f"{base}/missing", f"{base}/broken"
    vocab_host.docs["/good"] = (200, _doc(good))
    vocab_host.docs["/broken"] = (200, b"@prefix : <http://example.org/x#> . :a :b :c")
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(good, missing, broken)))
    _grant("vocab.test")
    assert _resolve(oid).status_code == 200
    rows = _rows(oid)
    assert rows[good]["status"] == "resolved"
    assert rows[missing]["status"] == "failed" and "404" in rows[missing]["error"]
    assert rows[broken]["status"] == "failed" and rows[broken]["error"]
    for flag in ("false", "true"):
        assert client.get(f"/api/ontologies/{oid}/graph?imports={flag}").status_code == 200


def test_offline_fails_network_imports_and_sends_nothing(vocab_host):
    """Offline: bundled still resolves, a network import fails with the
    offline sentence and no dialog, and the recording server sees nothing --
    not even with a remembered grant for the host."""
    _grant("vocab.test")
    client.put("/api/network/offline", json={"offline": True})
    remote = f"{vocab_host.base}/a"
    foaf = "http://xmlns.com/foaf/0.1/"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(foaf, remote)))
    assert _resolve(oid).status_code == 200
    rows = _rows(oid)
    assert rows[foaf]["status"] == "resolved"
    assert rows[remote]["status"] == "failed" and "offline" in rows[remote]["error"]
    assert client.get(f"/api/ontologies/{oid}/imports").json()["offline"] is True
    assert vocab_host.requests == []


def test_blocked_host_is_reported_as_blocked(vocab_host):
    remote = f"{vocab_host.base}/a"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(remote,)))
    client.post(
        "/api/network/grants",
        json={"capability": "ontology:import", "host": "vocab.test", "decision": "block", "remember": True},
    )
    assert _resolve(oid).status_code == 200
    row = _rows(oid)[remote]
    assert row["status"] == "blocked" and "vocab.test" in row["error"]
    assert vocab_host.requests == []


# ---------------------------------------------------------------------------
# AC-20, AC-21 -- the merged view and its marking
# ---------------------------------------------------------------------------

FOAF = "http://xmlns.com/foaf/0.1/"


@pytest.fixture
def merged_oid(no_network):
    """An ontology whose own class is a foaf:Person, with FOAF resolved."""
    body = _doc(
        "http://example.org/main",
        imports=(FOAF,),
        cls="Student",
        extra=f"\n<http://example.org/main/Student> rdfs:subClassOf <{FOAF}Person> .",
    )
    oid = _upload("m.ttl", body)
    assert _resolve(oid).status_code == 200
    return oid


def test_graph_and_search_cover_the_union_only_with_imports_on(merged_oid):
    """AC-20: off is the file alone; on adds FOAF, and search finds it."""
    ids = lambda flag: {  # noqa: E731
        n["id"] for n in client.get(f"/api/ontologies/{merged_oid}/graph?imports={flag}&limit=5000").json()["nodes"]
    }
    assert f"{FOAF}Agent" not in ids("false")
    assert f"{FOAF}Agent" in ids("true")
    off = client.get(f"/api/ontologies/{merged_oid}/search?q=Agent").json()
    on = client.get(f"/api/ontologies/{merged_oid}/search?q=Agent&imports=true").json()
    assert not any(h["id"] == f"{FOAF}Agent" for h in off)
    assert any(h["id"] == f"{FOAF}Agent" for h in on)


def test_imported_entities_are_marked_with_their_source(merged_oid):
    """AC-21: graph nodes, the detail panel and the hierarchy name FOAF; the
    ontology's own entity is not marked."""
    nodes = {
        n["id"]: n
        for n in client.get(f"/api/ontologies/{merged_oid}/graph?imports=true&limit=5000").json()["nodes"]
    }
    assert nodes[f"{FOAF}Agent"]["importedFrom"] == "FOAF"
    assert "importedFrom" not in nodes["http://example.org/main/Student"]

    detail = client.get(
        f"/api/ontologies/{merged_oid}/node", params={"iri": f"{FOAF}Person", "imports": "true"}
    ).json()
    assert detail["importedFrom"] == "FOAF"
    own = client.get(
        f"/api/ontologies/{merged_oid}/node",
        params={"iri": "http://example.org/main/Student", "imports": "true"},
    ).json()
    assert "importedFrom" not in own

    tree = client.get(f"/api/ontologies/{merged_oid}/hierarchy?imports=true").json()["classes"]
    assert tree["nodes"][f"{FOAF}Person"]["importedFrom"] == "FOAF"
    origins = {ref["id"]: ref["origin"] for refs in tree["children"].values() for ref in refs}
    assert origins[f"{FOAF}Person"] == "imported"
    assert origins["http://example.org/main/Student"] == "asserted"


def test_query_schema_and_sparql_run_over_the_union(merged_oid):
    """AC-20: the builder's schema gains FOAF's classes and SPARQL sees them,
    with the imported-document count stated."""
    off = client.get(f"/api/ontologies/{merged_oid}/query-schema").json()
    on = client.get(f"/api/ontologies/{merged_oid}/query-schema?imports=true").json()
    assert {c["iri"] for c in on["classes"]} > {c["iri"] for c in off["classes"]}
    query = f"SELECT ?c WHERE {{ ?c a <{OWL_NS}Class> }}"
    r_off = client.post(f"/api/ontologies/{merged_oid}/sparql", json={"query": query}).json()
    r_on = client.post(f"/api/ontologies/{merged_oid}/sparql?imports=true", json={"query": query}).json()
    assert r_on["rowCount"] > r_off["rowCount"]
    assert r_on["importDocuments"] == 1 and "importDocuments" not in r_off


def test_a_triple_in_both_documents_is_one_row(no_network):
    """The RDF merge is a set: a class the file and FOAF both declare is one
    row, where rdflib's own aggregate returned it twice."""
    oid = _upload(
        "m.ttl",
        _doc("http://example.org/main", imports=(FOAF,), extra=f"\n<{FOAF}Person> a owl:Class ."),
    )
    _resolve(oid)
    query = f"SELECT ?c WHERE {{ ?c a <{OWL_NS}Class> FILTER(?c = <{FOAF}Person>) }}"
    r = client.post(f"/api/ontologies/{oid}/sparql?imports=true", json={"query": query}).json()
    assert r["rowCount"] == 1


def test_file_only_and_merged_caches_never_mix(merged_oid):
    """The derived caches are keyed apart: asking for the merged graph first
    does not change what the file-only graph returns, and vice versa."""
    on = client.get(f"/api/ontologies/{merged_oid}/graph?imports=true&limit=5000").json()
    off = client.get(f"/api/ontologies/{merged_oid}/graph?limit=5000").json()
    assert on["stats"]["nodeTotal"] > off["stats"]["nodeTotal"]
    again = client.get(f"/api/ontologies/{merged_oid}/graph?imports=true&limit=5000").json()
    assert again["stats"]["nodeTotal"] == on["stats"]["nodeTotal"]


# ---------------------------------------------------------------------------
# AC-22 -- read-only
# ---------------------------------------------------------------------------


def test_the_merged_view_refuses_writes(merged_oid):
    view = imports_service.merged(store.get(merged_oid))["graph"]
    triple = (URIRef("http://example.org/x"), URIRef("http://example.org/p"), URIRef("http://example.org/y"))
    with pytest.raises(ModificationException):
        view.add(triple)
    with pytest.raises(ModificationException):
        view.remove(triple)


def test_merged_view_does_not_touch_the_files_prefixes():
    """A qname for an imported IRI binds its generated prefix in the view's own
    manager, not in the file's graph."""
    own, other = Graph(), Graph()
    own.bind("ex", "http://example.org/main#")
    other.add((URIRef("http://elsewhere.test/v#A"), URIRef("http://elsewhere.test/v#p"), URIRef("http://elsewhere.test/v#B")))
    view = MergedView([own, other])
    view.qname(URIRef("http://elsewhere.test/v#A"))
    assert "http://elsewhere.test/v#" not in {str(ns) for _, ns in own.namespaces()}


# ---------------------------------------------------------------------------
# AC-24 -- the manifest
# ---------------------------------------------------------------------------


def test_every_bundled_vocabulary_has_licence_source_and_matching_hash():
    """AC-24: a missing licence or a hash that does not match the file fails."""
    manifest = load_manifest()
    assert len(manifest["vocabularies"]) == 11
    for entry in manifest["vocabularies"]:
        assert entry["license"]["name"] and entry["license"]["url"].startswith("http"), entry["id"]
        assert entry["sourceUrl"].startswith("https://"), entry["id"]
        data = (imports_mod.VOCAB_DIR / entry["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["id"]
        assert entry["iris"], entry["id"]


def test_a_tampered_bundled_file_is_refused(tmp_path, monkeypatch, no_network):
    """The check runs on every read: changed bytes are not parsed as FOAF, and
    the import fails with the reason rather than showing the altered file."""
    shutil.copytree(imports_mod.VOCAB_DIR, tmp_path / "vocab")
    (tmp_path / "vocab" / "foaf.rdf").write_bytes(b"<rdf:RDF/>")
    monkeypatch.setattr(imports_mod, "VOCAB_DIR", tmp_path / "vocab")
    imports_mod.clear_bundled_cache()
    try:
        oid = _upload("m.ttl", _doc("http://example.org/main", imports=(FOAF,)))
        _resolve(oid)
        row = _rows(oid)[FOAF]
        assert row["status"] == "failed" and "checksum" in row["error"]
    finally:
        imports_mod.clear_bundled_cache()


# ---------------------------------------------------------------------------
# AC-40 to AC-43 -- chosen files
# ---------------------------------------------------------------------------


def _choose(oid: str, files: list[tuple[str, bytes]], **form):
    return client.post(
        f"/api/ontologies/{oid}/imports/files",
        files=[("files", (name, data, "text/turtle")) for name, data in files],
        data={k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()},
    )


def test_chosen_files_match_by_iri_at_any_depth(vocab_host):
    """AC-41: files matched by owl:Ontology IRI and by versionIRI, including an
    import that only appeared at depth 2; an unmatched file is not kept."""
    base = vocab_host.base
    a, deep = f"{base}/a", "http://example.org/deep/2.0"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(a,)))
    # Offline, so the first pass fails a and never learns about deep...
    client.put("/api/network/offline", json={"offline": True})
    _resolve(oid)
    assert _rows(oid)[a]["status"] == "failed"
    # ...choosing a reveals it, and choosing deep's file (by versionIRI) resolves it.
    r = _choose(oid, [("a.ttl", _doc(a, imports=(deep,), cls="A"))])
    assert r.json()["matched"] == [{"iri": a, "file": "a.ttl"}]
    assert _rows(oid)[deep]["status"] == "unresolved"
    deep_doc = ttl(
        f"<http://example.org/deep> a owl:Ontology ; owl:versionIRI <{deep}> . ex:Deep a owl:Class ."
    )
    r = _choose(oid, [("deep.ttl", deep_doc), ("stray.ttl", _doc("http://example.org/stray"))])
    body = r.json()
    assert body["matched"] == [{"iri": deep, "file": "deep.ttl"}]
    assert body["unmatched"] == ["stray.ttl"]
    rows = _rows(oid)
    assert rows[a]["source"] == rows[deep]["source"] == "file"
    assert rows[deep]["sourceName"] == "deep.ttl"
    kept = [json.loads(p.read_text())["fileName"] for p in imports_service.cache.dir.glob("*.meta.json")]
    assert "stray.ttl" not in kept
    assert vocab_host.requests == []


def test_a_mismatched_file_needs_confirmation(no_network):
    """AC-42: chosen for one import, declaring another: kept only once the user
    confirms, and then used for the import it was chosen for."""
    wanted = "http://example.org/wanted/"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(wanted,)))
    other = _doc("http://example.org/wanted-v2")
    r = _choose(oid, [("w.ttl", other)], forIri=wanted)
    assert r.json()["mismatch"] == [
        {"file": "w.ttl", "declares": "http://example.org/wanted-v2", "forIri": wanted}
    ]
    assert _rows(oid)[wanted]["status"] == "unresolved"
    r = _choose(oid, [("w.ttl", other)], forIri=wanted, acceptMismatch=True)
    assert r.json()["matched"] == [{"iri": wanted, "file": "w.ttl"}]
    assert _rows(oid)[wanted]["status"] == "resolved"


def test_a_chosen_file_serves_every_ontology_importing_it(no_network):
    """AC-43: FOAF-like private import chosen once resolves for a second
    ontology without choosing again, and without the network."""
    private = "http://example.org/private"
    first = _upload("one.ttl", _doc("http://example.org/one", imports=(private,)))
    _choose(first, [("private.ttl", _doc(private))])
    second = _upload("two.ttl", _doc("http://example.org/two", imports=(private,)))
    _resolve(second)
    row = _rows(second)[private]
    assert row["status"] == "resolved" and row["source"] == "file"


def test_a_path_in_the_file_name_is_never_read_or_written(no_network, tmp_path):
    """AC-43: the server takes bytes, never a path. A client-supplied name that
    looks like a path is kept only as a label; the bytes land under the cache
    key and nothing is read from, or written to, the named place."""
    target = tmp_path / "secret.ttl"
    target.write_bytes(_doc("http://example.org/private", cls="Secret"))
    private = "http://example.org/private"
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=(private,)))
    r = _choose(oid, [(str(target), _doc(private, cls="FromBrowser"))])
    assert r.json()["matched"][0]["iri"] == private
    view = imports_service.merged(store.get(oid))["graph"]
    assert (URIRef(f"{private}/FromBrowser"), None, None) in view
    assert (URIRef(f"{private}/Secret"), None, None) not in view
    assert all(p.parent == imports_service.cache.dir for p in imports_service.cache.dir.iterdir())


def test_chosen_files_keep_the_upload_cap(monkeypatch, no_network):
    """Each chosen file has the upload path's cap, enforced while reading."""
    from app.routers import ontologies

    oid = _upload("m.ttl", _doc("http://example.org/main", imports=("http://example.org/p",)))
    monkeypatch.setattr(ontologies, "MAX_UPLOAD_BYTES", 100)
    r = _choose(oid, [("big.ttl", b"#" * 1000)])
    assert r.status_code == 413


# ---------------------------------------------------------------------------
# AC-25 -- documentation export
# ---------------------------------------------------------------------------


def test_documentation_never_documents_imported_terms(merged_oid):
    """AC-25: with FOAF resolved and the merged view built, the export still
    documents only the file's own terms."""
    client.get(f"/api/ontologies/{merged_oid}/graph?imports=true")
    r = client.get(f"/api/ontologies/{merged_oid}/documentation")
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as archive:
        index = archive.read("index.html").decode()
        graph_data = archive.read("assets/graph-data.json").decode()
    assert "Student" in index
    assert f"{FOAF}Agent" not in index and f"{FOAF}Agent" not in graph_data


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------


def test_cancel_stops_after_the_current_document(vocab_host, monkeypatch):
    """Section 6: Cancel stops after the document in hand; the rest stay
    unresolved and say so."""
    base = vocab_host.base
    iris = [f"{base}/c{i}" for i in range(3)]
    for i, iri in enumerate(iris):
        vocab_host.docs[f"/c{i}"] = (200, _doc(iri, cls=f"C{i}"))
    oid = _upload("m.ttl", _doc("http://example.org/main", imports=tuple(iris)))
    _grant("vocab.test")
    real = imports_service._download

    def download_then_cancel(*args, **kwargs):
        result = real(*args, **kwargs)
        imports_service.cancel(oid)
        return result

    monkeypatch.setattr(imports_service, "_download", download_then_cancel)
    assert _resolve(oid).status_code == 200
    rows = _rows(oid)
    statuses = [rows[i]["status"] for i in iris]
    assert statuses == ["resolved", "unresolved", "unresolved"]
    assert rows[iris[1]]["error"] == "Stopped before this import was resolved."
    assert len(vocab_host.requests) == 1


# ---------------------------------------------------------------------------
# Section 10 -- performance
# ---------------------------------------------------------------------------


def _median_ms(fn, runs: int = 5) -> float:
    """Median of five, collector paused (D-024)."""
    samples = []
    enabled = gc.isenabled()
    gc.disable()
    try:
        for _ in range(runs):
            started = time.perf_counter()
            fn()
            samples.append((time.perf_counter() - started) * 1000)
    finally:
        if enabled:
            gc.enable()
    return statistics.median(samples)


@pytest.mark.perf
def test_bundled_closure_budget(no_network):
    """Resolving an ontology that imports every bundled vocabulary, parse
    included, <= 2 s. The parsed-vocabulary cache is cleared before each run,
    so the time is the cold one the budget describes."""
    iris = tuple(entry["iris"][0] for entry in load_manifest()["vocabularies"])
    ontology = store.get(_upload("m.ttl", _doc("http://example.org/main", imports=iris)))

    def cold_resolve():
        imports_mod.clear_bundled_cache()
        imports_service.resolve(ontology, max_bytes=imports_mod.MAX_TOTAL_BYTES)

    elapsed = _median_ms(cold_resolve)
    rows = imports_service.listing(ontology)["imports"]
    assert {r["status"] for r in rows} == {"resolved"}
    assert len(rows) == 11
    assert elapsed <= 2000, f"{elapsed:.0f} ms"


@pytest.mark.perf
def test_merged_view_overhead(no_network):
    """/graph with imports on <= 1.5x the same triples in a single graph.

    Timed on the part that differs: building the graph view, uncached, over
    the merged view against over one graph holding the identical triples. The
    endpoint itself serves a cached build, so timing it would compare two
    dictionary lookups and prove nothing. Every bundled vocabulary is imported,
    eleven documents, which is the worst case the subject pruning in
    MergedView exists for.
    """
    iris = tuple(entry["iris"][0] for entry in load_manifest()["vocabularies"])
    ontology = store.get(_upload("m.ttl", _doc("http://example.org/main", imports=iris)))
    imports_service.resolve(ontology, max_bytes=imports_mod.MAX_TOTAL_BYTES)
    view = imports_service.merged(ontology)["graph"]
    single = Graph()
    for triple in view.triples((None, None, None)):
        single.add(triple)
    assert len(single) == len(view)
    merged_ms = _median_ms(lambda: build_viz_graph(view))
    single_ms = _median_ms(lambda: build_viz_graph(single))
    ratio = merged_ms / single_ms
    assert ratio <= 1.5, f"{merged_ms:.1f} ms merged vs {single_ms:.1f} ms single ({ratio:.2f}x)"
