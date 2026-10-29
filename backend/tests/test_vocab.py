"""
================================================================================
FILE: backend/tests/test_vocab.py
================================================================================

SUMMARY
    QUDT 3.5.2 as a bundled vocabulary (reference-ontologies 5.1, AC-1): the
    file pinned by SHA-256 with its source and retrieval date, its licence
    recorded in vocab/NOTICE.md with the UCUM notice it carries, a changed
    byte refused, the measurements of 5.1 item 3 held to the file, and
    `owl:imports <http://qudt.org/3.5.2/qudt-all>` resolving offline.

BASIC IDEA
    The manifest and the NOTICE are read as files and compared with what was
    found in QUDT on 2026-10-29, so neither can drift from the bytes. The
    measurements are counted from one parse of the real file, shared by the
    module, because Stage B builds its prefixes on them: a QUDT that grew a
    namespace fails here by name rather than quietly in a picker.

    The import is resolved with the broker set offline, the strongest form of
    "no network": QUDT and SKOS resolve from the bundle and QUDT's own import
    of VAEM, which is not bundled (5.1 item 4), fails with the offline
    sentence. Every call to the broker is recorded on its way to the real
    one, which refuses it offline: VAEM is the only one, so QUDT itself never
    went near the network.

INPUTS / INPUT SOURCES
    - backend/app/vocab/manifest.json, NOTICE.md, qudt-3.5.2.ttl and the
      repository's .gitattributes.
    - The FastAPI app through TestClient, for the import.

EXPECTED OUTPUT
    - Pass/fail for AC-1.
================================================================================
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import OWL, RDF, RDFS, Graph, URIRef

from app import imports as imports_mod
from app.imports import VocabIntegrityError, bundled_bytes, bundled_for
from app.main import app
from app.network_broker import broker
from app.store import store

VOCAB = Path(__file__).resolve().parent.parent / "app" / "vocab"
MANIFEST = json.loads((VOCAB / "manifest.json").read_text(encoding="utf-8"))
QUDT_IRI = "http://qudt.org/3.5.2/qudt-all"
SKOS_IRI = "http://www.w3.org/2004/02/skos/core"
VAEM_IRI = "http://www.linkedmodel.org/schema/vaem"
QUDT_SCHEMA = "http://qudt.org/schema/qudt/"

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})


def _qudt() -> dict:
    return next(v for v in MANIFEST["vocabularies"] if v["id"] == "qudt")


@pytest.fixture(scope="module")
def qudt() -> Graph:
    return Graph().parse(VOCAB / "qudt-3.5.2.ttl", format="turtle")


# --- the file, its pin and its licence ---------------------------------------


def test_qudt_is_pinned_with_its_source_and_retrieval_date():
    entry = _qudt()
    assert entry["file"] == "qudt-3.5.2.ttl" and entry["format"] == "turtle"
    assert entry["sourceUrl"] == "https://qudt.org/3.5.2/qudt-all"
    assert entry["retrieved"] == "2026-10-29"
    assert entry["sha256"] == "aa11e3a4b6f0cd60327981f992099538a00fbf23281ef679fef8ddca96e65940"
    data = (VOCAB / entry["file"]).read_bytes()
    assert len(data) == 6_867_319
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    assert entry["iris"] == [QUDT_IRI]
    assert bundled_for(QUDT_IRI) is not None


def test_qudt_licence_is_the_one_the_file_states():
    entry = _qudt()
    assert entry["license"]["name"] == "CC BY 4.0"
    assert entry["license"]["url"] == "https://creativecommons.org/licenses/by/4.0/"
    text = (VOCAB / entry["file"]).read_text(encoding="utf-8")
    # 5.1 item 2: what the file says, read before it was committed.
    assert "Creative Commons Attribution 4.0 International License (CC BY 4.0)" in text
    assert "Attribution should be made to QUDT.org" in text
    assert "subject to a license from Regenstrief Institute, Inc. and The UCUM Organization" in text


def test_notice_carries_the_qudt_row_and_the_ucum_notice():
    notice = (VOCAB / "NOTICE.md").read_text(encoding="utf-8")
    assert "| BFO 2020 |" in notice, "NOTICE.md did not load"
    row = next(line for line in notice.splitlines() if line.startswith("| QUDT 3.5.2 |"))
    assert "`qudt-3.5.2.ttl`" in row and "https://qudt.org/3.5.2/qudt-all" in row
    assert "CC BY 4.0" in row and "Attribution: QUDT.org" in row
    assert "https://ucum.org/license" in row
    # Repeated as the UCUM licence asks: the copyright and the disclaimer.
    flat = " ".join(" ".join(line.lstrip("> ") for line in notice.splitlines()).split())
    assert "Regenstrief Institute, Inc. and the Unified Codes for Units of Measures (UCUM) Organization" in flat
    assert "PROVIDED 'AS IS.'" in flat


def test_the_file_is_binary_in_gitattributes():
    attributes = (VOCAB.parent.parent.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "backend/app/vocab/*.ttl binary" in attributes


def test_a_changed_byte_is_refused(tmp_path, monkeypatch):
    data = (VOCAB / "qudt-3.5.2.ttl").read_bytes()
    (tmp_path / "qudt-3.5.2.ttl").write_bytes(data[:-1] + b" ")
    monkeypatch.setattr(imports_mod, "VOCAB_DIR", tmp_path)
    with pytest.raises(VocabIntegrityError):
        bundled_bytes(_qudt())


# --- 5.1 item 3: what was measured ------------------------------------------


def _namespace(iri) -> str:
    text = str(iri)
    return text[: max(text.rfind("#"), text.rfind("/")) + 1]


def _named(graph: Graph, kind) -> set:
    return {s for s in graph.subjects(RDF.type, kind) if isinstance(s, URIRef)}


def test_qudt_measures_as_recorded(qudt):
    """The numbers in the spec's version row and architecture.md."""
    assert len(qudt) == 132_166
    classes = _named(qudt, OWL.Class) | _named(qudt, RDFS.Class)
    objects = _named(qudt, OWL.ObjectProperty)
    datatypes = _named(qudt, OWL.DatatypeProperty)
    assert (len(classes), len(objects), len(datatypes)) == (228, 100, 100)
    # Every class is QUDT's own; the properties are too, but for the three
    # outside terms QUDT re-declares (skos, dtype, dcterms): declared, not
    # defined, so they add no prefix of QUDT's.
    assert {_namespace(c) for c in classes} == {QUDT_SCHEMA}
    assert Counter(_namespace(p) for p in objects | datatypes) == {
        QUDT_SCHEMA: 196,
        "http://www.w3.org/2004/02/skos/core#": 1,
        "http://www.linkedmodel.org/schema/dtype#": 2,
        "http://purl.org/dc/terms/": 1,
    }


def test_qudt_says_what_it_is_and_what_it_imports(qudt):
    ontology = URIRef(QUDT_IRI)
    assert (ontology, RDF.type, OWL.Ontology) in qudt
    assert str(qudt.value(ontology, RDFS.label)) == "QUDT Collection 3.5.2"
    assert set(qudt.objects(ontology, OWL.imports)) == {URIRef(VAEM_IRI), URIRef(SKOS_IRI)}


# --- an offline import -------------------------------------------------------


@pytest.fixture
def offline(monkeypatch):
    """Offline, and every broker call recorded on its way to the real one."""
    asked: list[str] = []
    real = broker.request

    def recording(capability, url, *args, **kwargs):
        asked.append(url)
        return real(capability, url, *args, **kwargs)

    monkeypatch.setattr(broker, "request", recording)
    assert client.put("/api/network/offline", json={"offline": True}).status_code == 200
    yield asked
    # The parsed QUDT is 132,000 statements: not held for the rest of the suite.
    imports_mod.clear_bundled_cache()


def test_importing_qudt_resolves_from_the_bundle_offline(offline, monkeypatch):
    # The library comes before the bundle (D-068), and the seeded QUDT entry
    # is the same file under the same IRI, so a library holding it answers
    # first. The library step sees nothing here, as in a library QUDT was
    # removed from: the bundle is what is proved.
    monkeypatch.setattr(imports_mod.imports_service, "_library_iris", lambda _other: [])
    doc = (
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        f"<http://example.org/units> a owl:Ontology ; owl:imports <{QUDT_IRI}> .\n"
    ).encode()
    uploaded = client.post("/api/ontologies/upload", files={"file": ("u.ttl", doc, "text/turtle")})
    assert uploaded.status_code == 200, uploaded.text
    oid = uploaded.json()["id"]
    try:
        assert client.post(f"/api/ontologies/{oid}/imports/resolve").status_code == 200
        rows = {r["iri"]: r for r in client.get(f"/api/ontologies/{oid}/imports").json()["imports"]}
        assert rows[QUDT_IRI]["status"] == "resolved" and rows[QUDT_IRI]["source"] == "bundled"
        assert rows[QUDT_IRI]["sourceName"] == "QUDT 3.5.2"
        assert rows[SKOS_IRI]["status"] == "resolved"
        # 5.1 item 4: VAEM is not bundled, and offline it is not fetched.
        assert rows[VAEM_IRI]["status"] == "failed" and "offline" in rows[VAEM_IRI]["error"]
        assert offline == [VAEM_IRI]
        nodes = client.get(f"/api/ontologies/{oid}/graph?imports=true&limit=5000").json()["nodes"]
        assert f"{QUDT_SCHEMA}Unit" in {n["id"] for n in nodes}
    finally:
        store.remove(oid)
