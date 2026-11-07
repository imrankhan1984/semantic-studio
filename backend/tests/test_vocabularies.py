"""
================================================================================
FILE: backend/tests/test_vocabularies.py
================================================================================

SUMMARY
    Vocabularies, seen and added (vocabularies-and-ontologies, D-128): the
    Edit page's list and its sentence, the rule on the twelve bundled
    files, the reasoning warning above 20,000 statements, inspect from
    each of its four sources -- the web address through the broker, proved
    by a recording server that sees zero requests before approval and zero
    while offline -- the refusals, the Turtle door, and Section 10's
    budgets.

BASIC IDEA
    Each test opens a project of its own through the API, as the Edit page
    does, and reads the list back through GET …/vocabularies. The registry
    of inspected sources, the imports cache and the catalogue live in the
    data folder the whole run shares, so they are emptied after each test:
    a file chosen in one test must not be a known source in the next.

    A status code is not the network proof. The web tests run a real
    server that records every request, and assert what it saw.

INPUTS / INPUT SOURCES
    - The FastAPI app in-process; the bundled vocab/ files.
    - Inline Turtle under http://example.org/ (rdf-fixture), and a
      generated file a statement either side of 20,000.
    - conftest.py's http_server and loopback_is_public.

EXPECTED OUTPUT
    - Pass/fail per acceptance criterion: AC-1, AC-4, AC-5, AC-9, AC-11,
      AC-12, AC-16 and AC-18's budgets.
================================================================================
"""

import gc
import ipaddress
import json
import shutil
import statistics
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, URIRef
from rdflib.namespace import DCTERMS, OWL

from app import imports as imports_mod
from app import vocabularies
from app.editing import editing_service, project_store
from app.imports import imports_service, load_bundled
from app.main import app
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

PROV_O = "http://www.w3.org/ns/prov-o"
PROV = "http://www.w3.org/ns/prov#"
FOAF = "http://xmlns.com/foaf/0.1/"
DC = "http://purl.org/dc/elements/1.1/"
QUDT = "http://qudt.org/3.5.2/qudt-all"
LOCAL = ipaddress.ip_address("127.0.0.1")


@pytest.fixture(autouse=True)
def _clean():
    """Every test starts with no known source but the bundled ones."""
    before = {o.id for o in store.list()}
    yield
    editing_service.close_all()
    for ontology in store.list():
        if ontology.id not in before:
            store.remove(ontology.id)
    (store.data_dir / vocabularies.REGISTRY).unlink(missing_ok=True)
    shutil.rmtree(imports_service.cache.dir, ignore_errors=True)
    imports_service.cache.catalog_path.unlink(missing_ok=True)
    imports_service.cache.clear()


def _project(template: str = "small", name: str = "Pumps") -> str:
    pid = client.post("/api/projects", json={"name": name, "template": template}).json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


def _list(pid: str) -> dict:
    r = client.get(f"/api/projects/{pid}/documents/model/vocabularies")
    assert r.status_code == 200, r.text
    return r.json()


def _rows(pid: str) -> dict:
    return {row["title"]: row for row in _list(pid)["rows"]}


def _source(pid: str) -> str:
    return client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]


def _apply(pid: str, text: str):
    return client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})


def _inspect(pid: str, **choice):
    return client.post(f"/api/projects/{pid}/vocabularies/inspect", json=choice)


def _inspect_file(pid: str, name: str, data: bytes):
    return client.post(f"/api/projects/{pid}/vocabularies/inspect", files={"file": (name, data, "text/turtle")})


def _command(pid: str, name: str, args: dict):
    return client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": name, "args": args})


def _upload(name: str, data: bytes) -> str:
    r = client.post("/api/ontologies/upload", files={"file": (name, data, "text/turtle")})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _term_list(ns: str = "http://example.org/terms/", n: int = 3, header: bool = True) -> bytes:
    """A term list: properties and labels, no rule at all."""
    lines = [
        f"@prefix t: <{ns}> .",
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
    ]
    if header:
        lines.append(f'<{ns.rstrip("/#")}> a owl:Ontology ; rdfs:label "Team terms" .')
    lines += [f't:term{i} a rdf:Property ; rdfs:label "Term {i}" .' for i in range(n)]
    return "\n".join(lines).encode()


def _with_rules(ns: str, statements: int) -> bytes:
    """A file of exactly `statements` statements, one of them a rule."""
    lines = [
        f"@prefix t: <{ns}> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        f'<{ns.rstrip("#/")}> a owl:Ontology ; rdfs:label "Big rules" .',  # 2
        "t:A a owl:Class . t:B a owl:Class ; rdfs:subClassOf t:A .",  # 3
    ]
    for i in range(statements - 5):
        lines.append(f't:A rdfs:comment "note {i}" .')
    return "\n".join(lines).encode()


# ---------------------------------------------------------------------------
# AC-1, AC-2: the list and its sentence
# ---------------------------------------------------------------------------


def test_the_four_statuses_and_the_heads_sentence():
    """AC-1: imported, reused, used but not added, not found; rdflib's own
    foaf: binding, in every graph, never makes FOAF added."""
    pid = _project()
    text = _source(pid) + (
        f"\n@prefix dc: <{DC}> .\n"
        f"<http://example.org/pumps> <http://www.w3.org/2002/07/owl#imports> <{PROV_O}> .\n"
        f"<http://example.org/pumps#Operator> a <http://www.w3.org/2002/07/owl#Class> ;\n"
        f"    <http://www.w3.org/2000/01/rdf-schema#subClassOf> <{FOAF}Person> .\n"
        "<http://example.org/pumps#Pump> <http://www.w3.org/2000/01/rdf-schema#seeAlso> <http://unknown.example/x#Thing> .\n"
    )
    assert _apply(pid, text).status_code == 200
    listed = _list(pid)
    assert listed["sentence"] == "Uses 4 vocabularies; 1 is used but not added, 1 is not found."
    rows = {r["title"]: r for r in listed["rows"]}
    assert set(rows) == {"PROV-O", "Dublin Core Elements 1.1", "FOAF", "http://unknown.example/x#"}
    assert (rows["PROV-O"]["status"], rows["PROV-O"]["how"]) == ("added", "imported")
    assert (rows["Dublin Core Elements 1.1"]["status"], rows["Dublin Core Elements 1.1"]["how"]) == ("added", "reused")
    assert rows["Dublin Core Elements 1.1"]["prefix"] == "dc"
    assert rows["FOAF"]["status"] == "used" and rows["FOAF"]["uses"] == 1
    assert rows["http://unknown.example/x#"]["status"] == "notFound"
    # AC-2's source words come from these: a bundled source, named.
    assert rows["PROV-O"]["source"] == {"kind": "bundled", "name": "Bundled", "fetchedAt": None}
    assert rows["http://unknown.example/x#"]["source"] is None


def test_a_new_project_uses_no_other_vocabulary():
    assert _list(_project("small"))["sentence"] == "Uses no other vocabulary."


@pytest.mark.parametrize("rows, said", [
    ([], "Uses no other vocabulary."),
    ([{"status": "added"}], "Uses 1 vocabulary."),
    ([{"status": "added"}] * 3, "Uses 3 vocabularies."),
    ([{"status": "added"}] * 3 + [{"status": "used"}], "Uses 4 vocabularies; 1 is used but not added."),
    ([{"status": "used"}] * 2 + [{"status": "notFound"}], "Uses 3 vocabularies; 2 are used but not added, 1 is not found."),
])
def test_the_heads_sentence(rows, said):
    assert vocabularies.head_sentence(rows) == said


def test_the_lines_that_add_a_vocabulary_are_not_use():
    """dcterms:requires is a dcterms: term, but it adds; it never makes
    DCMI Metadata Terms a vocabulary used but not added."""
    pid = _project()
    assert _inspect(pid, bundled="dcelements").status_code == 200
    assert _command(pid, "AddVocabulary", {"iri": DC, "prefix": "dc"}).status_code == 200
    assert set(_rows(pid)) == {"Dublin Core Elements 1.1"}


# ---------------------------------------------------------------------------
# AC-4, AC-5: the rule, and the warning above 20,000 statements
# ---------------------------------------------------------------------------

RULE_TABLE = {
    "skos": ("imported", 252, 56), "dcterms": ("imported", 700, 107), "dcelements": ("reused", 107, 0),
    "foaf": ("imported", 631, 171), "dcat3": ("imported", 1695, 89), "prov-o": ("imported", 1146, 198),
    "org": ("imported", 748, 120), "time": ("imported", 1296, 267), "shacl": ("imported", 1128, 186),
    "vcard": ("imported", 882, 150), "bfo-2020": ("imported", 1014, 258), "qudt": ("imported", 132166, 1407),
}


def test_the_rule_gives_section_5_4s_table_for_the_twelve_bundled_files():
    """AC-4, from the files themselves: the manifest's counts, which New
    project decides by, are what the rule counts, and so is the result."""
    entries = imports_mod.load_manifest()["vocabularies"]
    assert {e["id"] for e in entries} == set(RULE_TABLE)
    for entry in entries:
        graph = load_bundled(entry)
        how, statements, rules = RULE_TABLE[entry["id"]]
        assert (len(graph), vocabularies.count_rules(graph)) == (statements, rules), entry["id"]
        assert (entry["statements"], entry["rules"]) == (statements, rules), entry["id"]
        assert vocabularies.how_for(vocabularies.count_rules(graph)) == how, entry["id"]
        assert vocabularies.bundled(entry["id"]).how == how
        # The own imports a sentence names without parsing are the file's.
        assert set(vocabularies.BUNDLED_IMPORTS.get(entry["id"], ())) == set(imports_mod.declared_imports(graph)), entry["id"]


def test_a_vocabulary_above_20000_statements_is_imported_and_warned_about():
    """AC-5: the size changes the words only, never the outcome."""
    pid = _project()
    big = _inspect_file(pid, "big.ttl", _with_rules("http://example.org/big#", 20_001)).json()
    assert big["statements"] == 20_001 and big["how"] == "imported"
    assert "probably stop at its 30-second limit" in big["sentence"]
    small = _inspect_file(pid, "small.ttl", _with_rules("http://example.org/small#", 20_000)).json()
    assert small["statements"] == 20_000 and small["how"] == "imported"
    assert "30-second" not in small["sentence"]
    assert "so the reasoner and the checks use them" in small["sentence"]


def test_qudts_sentence_names_the_limit_and_the_host_to_allow():
    """AC-5 for QUDT: imported, the reasoning warning, and the one host its
    own imports will ask for (SKOS is bundled, so it is not counted)."""
    pid = _project()
    found = _inspect(pid, bundled="qudt").json()
    assert found["how"] == "imported" and found["iri"] == QUDT
    assert found["sentence"] == (
        "QUDT 3.5.2 holds rules: 1,407 statements about hierarchies, domains and ranges. It will be imported. "
        "It is large (132,166 statements), so reasoning with imports on will probably stop at its 30-second limit. "
        "It also imports 1 file from www.linkedmodel.org, which you will be asked to allow."
    )
    assert found["hosts"] == ["www.linkedmodel.org"]


def test_a_term_list_is_reused_by_its_prefix():
    pid = _project()
    found = _inspect(pid, bundled="dcelements").json()
    assert found["how"] == "reused" and found["prefix"] == "dc"
    assert found["sentence"] == (
        "Dublin Core Elements 1.1 is a list of terms with no rules. "
        "Its terms will be reused by prefix dc:; nothing is imported."
    )


def test_a_file_without_a_header_is_known_by_its_namespace():
    """5.9: the main namespace stands for its IRI, and a reused one is
    required by that namespace."""
    pid = _project()
    found = _inspect_file(pid, "terms.ttl", _term_list("http://example.org/plain/", header=False)).json()
    assert found["iri"] == "http://example.org/plain/"
    assert found["sentence"].startswith(
        "This file has no ontology header; it is identified by its namespace http://example.org/plain/."
    )
    assert _command(pid, "AddVocabulary", {"iri": found["iri"], "prefix": found["prefix"]}).status_code == 200
    graph = editing_service.document(pid, "model").graph
    assert (URIRef("http://example.org/pumps"), DCTERMS.requires, URIRef("http://example.org/plain/")) in graph


# ---------------------------------------------------------------------------
# Inspect from its four sources (AC-9, AC-10), refusals (AC-11, AC-12)
# ---------------------------------------------------------------------------


def test_inspect_from_the_library_then_add_it():
    oid = _upload("team.ttl", _term_list("http://example.org/team#"))
    pid = _project()
    found = _inspect(pid, ontologyId=oid).json()
    assert found["iri"] == "http://example.org/team" and found["how"] == "reused"
    assert found["source"]["kind"] == "library" and not found["alreadyAdded"]
    assert _command(pid, "AddVocabulary", {"iri": found["iri"], "prefix": "team"}).status_code == 200
    row = _rows(pid)["Team terms"]
    assert (row["status"], row["how"], row["prefix"]) == ("added", "reused", "team")
    assert row["source"]["name"] == "Your library: team.ttl"
    again = _inspect(pid, ontologyId=oid).json()
    assert again["alreadyAdded"] is True


def test_inspect_a_file_keeps_it_and_add_imports_it_locally():
    """A file with rules: imported, and resolved from the kept copy, with
    no network (the cache and the catalogue, as a chosen import is)."""
    data = _with_rules("http://example.org/team#", 40)
    pid = _project()
    found = _inspect_file(pid, "team.ttl", data).json()
    assert found["how"] == "imported" and found["source"] == {"kind": "file", "name": "File: team.ttl", "fetchedAt": None}
    assert imports_service.cache.mapping("http://example.org/team") == {"iri": "http://example.org/team", "kind": "file"}
    assert _command(pid, "AddVocabulary", {"iri": "http://example.org/team", "prefix": "team"}).status_code == 200
    row = _rows(pid)["Big rules"]
    assert (row["status"], row["how"], row["loaded"]) == ("added", "imported", True)
    assert row["source"]["name"] == "File: team.ttl"


@pytest.fixture
def vocab_host(http_server, loopback_is_public):
    """`vocab.test`: a recording server holding one vocabulary."""
    body = _term_list("http://vocab.test/terms/")

    def route(path):
        return (200, {"Content-Type": "text/turtle"}, body) if path == "/terms.ttl" else (404, {}, b"no")

    server = http_server(route)
    loopback_is_public["vocab.test"] = [LOCAL]
    server.url = f"http://vocab.test:{server.server_address[1]}/terms.ttl"
    return server


def test_a_web_address_asks_first_and_sends_nothing_before_approval(vocab_host):
    """AC-9: 409 naming the host, the capability and why, and the recording
    server saw zero requests; after an Allow, one."""
    pid = _project()
    r = _inspect(pid, url=vocab_host.url)
    assert r.status_code == 409, r.text
    [asked] = r.json()["detail"]["requests"]
    assert asked["capability"] == "ontology:import" and asked["host"] == "vocab.test"
    assert asked["reason"] == vocabularies.INSPECT_REASON
    assert vocab_host.requests == [], "fetched before approval"
    grant = client.post("/api/network/grants", json={
        "capability": "ontology:import", "host": "vocab.test", "decision": "allow", "remember": True,
    })
    assert grant.status_code == 200
    found = _inspect(pid, url=vocab_host.url).json()
    assert found["iri"] == "http://vocab.test/terms" and found["source"]["kind"] == "web"
    assert found["source"]["name"] == "Web: vocab.test" and found["source"]["fetchedAt"]
    assert vocab_host.requests == ["/terms.ttl"]


def test_a_web_address_sends_nothing_while_offline(vocab_host):
    """AC-9, offline: refused, a grant notwithstanding, and zero requests."""
    pid = _project()
    client.post("/api/network/grants", json={
        "capability": "ontology:import", "host": "vocab.test", "decision": "allow", "remember": True,
    })
    assert client.put("/api/network/offline", json={"offline": True}).status_code == 200
    r = _inspect(pid, url=vocab_host.url)
    assert r.status_code == 503, r.text
    assert vocab_host.requests == []


def test_a_private_address_is_refused_and_never_contacted(http_server):
    """The broker's address rules hold for this door too (Section 9 row 1)."""
    server = http_server(lambda path: (200, {"Content-Type": "text/turtle"}, _term_list()))
    pid = _project()
    client.post("/api/network/grants", json={
        "capability": "ontology:import", "host": "127.0.0.2", "decision": "allow", "remember": True,
    })
    r = _inspect(pid, url=f"http://127.0.0.2:{server.server_address[1]}/t.ttl")
    assert r.status_code in (403, 409, 422), r.text
    assert server.requests == []


def test_a_file_that_does_not_parse_says_so_and_writes_nothing():
    """AC-11: parse_errors.py's sentence, the raw text apart, nothing kept."""
    pid = _project()
    before = _source(pid)
    r = _inspect_file(pid, "broken.ttl", b"@prefix ex: <http://example.org/x#> .\nex:A a ex:B")
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "parse_error" and detail["message"]
    assert _source(pid) == before
    assert vocabularies.registry() == {}
    assert not imports_service.cache.dir.exists() or not any(imports_service.cache.dir.iterdir())


def test_the_model_itself_and_a_loop_are_refused_before_anything_is_written():
    """AC-12."""
    pid = _project()
    model = editing_service.document(pid, "model").graph
    model_iri = "http://example.org/pumps"
    itself = (
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        f"<{model_iri}> a owl:Ontology .\n<{model_iri}#X> a owl:Class .\n"
    ).encode()
    r = _inspect_file(pid, "pumps.ttl", itself)
    assert r.status_code == 422 and r.json()["detail"] == "This is the model itself."
    assert _inspect(pid, ontologyId=f"{pid}-model").json()["detail"] == "This is the model itself."
    importer = (
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        f"<http://example.org/plant> a owl:Ontology ; owl:imports <{model_iri}> .\n"
        "<http://example.org/plant#Valve> a owl:Class .\n"
    ).encode()
    oid = _upload("plant.ttl", importer)
    r = _inspect(pid, ontologyId=oid)
    assert r.status_code == 422
    assert r.json()["detail"] == "That ontology already imports this model; adding it would make a loop."
    assert len(model) == len(editing_service.document(pid, "model").graph)
    assert vocabularies.registry() == {}


def test_inspect_needs_an_issued_open_project():
    assert _inspect("prj-000000000000", bundled="prov-o").status_code == 404
    assert _inspect("prj-NOT-HEX", bundled="prov-o").status_code == 404
    pid = client.post("/api/projects", json={"name": "Shut", "template": "small"}).json()["id"]
    assert _inspect(pid, bundled="prov-o").status_code == 409


# ---------------------------------------------------------------------------
# AC-16: the Turtle door
# ---------------------------------------------------------------------------


def test_what_is_typed_in_turtle_shows_after_apply_and_is_never_rewritten():
    """AC-16: an import typed for a term list, and a prefix typed for a
    vocabulary with rules -- the other outcome than the rule's -- show as
    typed, and the list changes nothing in the text."""
    pid = _project()
    text = _source(pid) + (
        f"\n@prefix foaf: <{FOAF}> .\n"
        f"<http://example.org/pumps> <http://www.w3.org/2002/07/owl#imports> <{DC}> .\n"
    )
    assert _apply(pid, text).status_code == 200
    rows = _rows(pid)
    assert (rows["FOAF"]["status"], rows["FOAF"]["how"]) == ("added", "reused")
    assert (rows["Dublin Core Elements 1.1"]["status"], rows["Dublin Core Elements 1.1"]["how"]) == ("added", "imported")
    assert _source(pid) == text
    assert editing_service.document(pid, "model").state()["canUndo"] is True


# ---------------------------------------------------------------------------
# Section 10 (AC-18)
# ---------------------------------------------------------------------------


def _median(fn, before=None, runs: int = 5) -> float:
    """Median of five with the collector off around them (D-024)."""
    times = []
    gc.collect()
    gc.disable()
    try:
        for _ in range(runs):
            if before:
                before()
            start = time.perf_counter()
            fn()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return statistics.median(times)


@pytest.mark.perf
def test_inspect_budget():
    """inspect of PROV-O, the parse included: at most 1 s."""
    pid = _project()
    took = _median(lambda: _inspect(pid, bundled="prov-o").raise_for_status(), before=imports_mod.clear_bundled_cache)
    assert took <= limit_ms(1000), f"inspect took {took:.0f} ms (median of 5)"


def _big_model(pid: str, statements: int = 10_000) -> None:
    lines = [_source(pid)]
    for i in range(statements // 2):
        lines.append(
            f'<http://example.org/pumps#P{i}> a <http://www.w3.org/2002/07/owl#Class> ; '
            f'<http://www.w3.org/2000/01/rdf-schema#label> "P{i}"@en .'
        )
    assert _apply(pid, "\n".join(lines)).status_code == 200


@pytest.mark.perf
def test_list_budget():
    """GET …/vocabularies on a 10,000-statement document with three
    vocabularies added: at most 200 ms."""
    pid = _project()
    _big_model(pid)
    for vocab_id, iri, prefix in (("prov-o", PROV_O, "prov"), ("dcelements", DC, "dc"), ("org", "http://www.w3.org/ns/org", "org")):
        assert _inspect(pid, bundled=vocab_id).status_code == 200
        assert _command(pid, "AddVocabulary", {"iri": iri, "prefix": prefix}).status_code == 200, iri
    assert len(_list(pid)["rows"]) == 3
    took = _median(lambda: _list(pid))
    assert took <= limit_ms(200), f"the list took {took:.0f} ms (median of 5)"


def test_one_parse(monkeypatch):
    """Inspecting QUDT parses it once, and a second inspect, or adding it,
    not again: the count and the import come from that one parse."""
    pid = _project()
    imports_mod.clear_bundled_cache()
    calls = []
    real = Graph.parse

    def counted(self, *args, **kwargs):
        calls.append(kwargs.get("format"))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Graph, "parse", counted)
    assert _inspect(pid, bundled="qudt").status_code == 200
    assert calls == ["turtle"]
    assert _inspect(pid, bundled="qudt").status_code == 200
    assert _command(pid, "AddVocabulary", {"iri": QUDT, "prefix": "qudt"}).status_code == 200
    # Adding resolves QUDT's own import of SKOS, which is RDF/XML: parsed
    # once too. QUDT, the only Turtle among them, never again.
    assert calls.count("turtle") == 1, "QUDT was parsed again"
    assert calls == ["turtle", "xml"]


@pytest.mark.perf
def test_qudt_import_budget():
    """A project importing QUDT: the canvas and the hierarchy with imports
    on, each at most 1 s on its first call (the merged view built)."""
    pid = _project()
    assert _inspect(pid, bundled="qudt").status_code == 200
    assert _command(pid, "AddVocabulary", {"iri": QUDT, "prefix": "qudt"}).status_code == 200
    document = editing_service.document(pid, "model")

    def cold():
        document.ontology.merged_cache = None
        document._canvas = None

    canvas = _median(
        lambda: client.get(f"/api/projects/{pid}/documents/model/canvas?imports=true").raise_for_status(), before=cold
    )
    hierarchy = _median(
        lambda: client.get(f"/api/ontologies/{pid}-model/hierarchy?imports=true").raise_for_status(), before=cold
    )
    assert canvas <= limit_ms(1000), f"canvas took {canvas:.0f} ms"
    assert hierarchy <= limit_ms(1000), f"hierarchy took {hierarchy:.0f} ms"


def test_registry_survives_a_restart_in_shape():
    """What inspect kept is read back as a known source (the file is the
    record, not memory)."""
    pid = _project()
    _inspect_file(pid, "team.ttl", _term_list("http://example.org/team#"))
    data = json.loads((store.data_dir / vocabularies.REGISTRY).read_text(encoding="utf-8"))
    assert data["version"] == vocabularies.REGISTRY_VERSION
    [entry] = data["entries"].values()
    assert entry["iri"] == "http://example.org/team" and entry["rules"] == 0
    assert vocabularies.source_for("http://example.org/team").how == "reused"


# ---------------------------------------------------------------------------
# Security review: a namespace Turtle cannot hold never reaches the text
# ---------------------------------------------------------------------------


def _hostile_rdfxml(with_header: bool = True) -> bytes:
    """RDF/XML whose subjects' IRIs hold `>` and a newline: rdflib's parser
    keeps them with only a warning. Cut at the last `/`, the namespace
    closes a PREFIX line and writes a statement of its own."""
    tail = (
        "http://example.org/v>\n<http://example.org/pumps> "
        "<http://www.w3.org/2000/01/rdf-schema#comment> \"INJECTED\" .\nPREFIX zz: <http://example.org/a/"
    )
    escaped = tail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("\n", "&#10;")
    header = '<owl:Ontology xmlns:owl="http://www.w3.org/2002/07/owl#" rdf:about="http://example.org/vocab"/>' if with_header else ""
    return (
        '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        + header
        + "".join(f'<rdf:Property rdf:about="{escaped}{n}"/>' for n in "ABC")
        + '<rdf:Property rdf:about="http://example.org/v/fine"/></rdf:RDF>'
    ).encode()


def test_a_namespace_turtle_cannot_hold_is_never_written_into_the_model():
    """The review's attack, end to end: inspect, Add, save, reopen. The
    hostile namespace is never read as one, so nothing is injected."""
    pid = _project()
    found = _inspect_file(pid, "v.rdf", _hostile_rdfxml()).json()
    assert ">" not in found["namespace"] and "\n" not in found["namespace"]
    assert vocabularies.iri_ok(found["namespace"]), found["namespace"]
    assert _command(pid, "AddVocabulary", {"iri": found["iri"], "prefix": found["prefix"]}).status_code == 200
    text = _source(pid)
    assert "INJECTED" not in text and "zz:" not in text
    assert client.post(f"/api/projects/{pid}/documents/model/save").status_code == 200
    editing_service.close_all()
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    graph = editing_service.document(pid, "model").graph
    assert not any("INJECTED" in str(o) for o in graph.objects())


def test_a_file_of_nothing_but_hostile_names_is_refused():
    """Header-less, the hostile namespace would be the IRI too: no term
    Turtle can hold, so nothing to add."""
    pid = _project()
    tail = "http://example.org/v>\n<x> <y> \"z\" .\nPREFIX q: <http://example.org/a/A"
    escaped = tail.replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("\n", "&#10;")
    data = (
        '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        f'<rdf:Property rdf:about="{escaped}"/></rdf:RDF>'
    ).encode()
    r = _inspect_file(pid, "v.rdf", data)
    assert r.status_code == 422 and r.json()["detail"] == "This file defines no terms to reuse."


def test_a_recorded_hostile_namespace_is_refused_and_never_written():
    """Defence again where a namespace leaves: a registry entry from before
    the check is refused by Add, and keep_prefixes never writes one."""
    from app import references

    pid = _project()
    hostile = "http://example.org/v>\n<a> <b> \"c\" .\nPREFIX z: <http://example.org/a/"
    vocabularies._record(vocabularies.Source(
        iri="http://example.org/old", title="Old", prefixes={"old": hostile}, kind="file",
        name="File: old.ttl", statements=3, rules=0, ref={"kind": "cache", "key": "0" * 24},
    ))
    r = _command(pid, "AddVocabulary", {"iri": "http://example.org/old", "prefix": "old"})
    assert r.status_code == 422 and "Turtle cannot hold" in r.json()["detail"]
    assert references.keep_prefixes("<a> <b> <c> .\n", {"old": hostile}) == "<a> <b> <c> .\n"
