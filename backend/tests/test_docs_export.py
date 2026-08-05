"""
================================================================================
FILE: backend/tests/test_docs_export.py
================================================================================

SUMMARY
    Tests the documentation-export feature (backlog DOC-1): the zip a user drops
    into a repository and points GitHub Pages at. Covers the zip's contents and
    the two files that decide whether GitHub Pages works at all (.nojekyll and
    relative-only paths), the OWL/SKOS/mixed profile choice, the complete
    (never-truncated) embedded graph and its 5 MB refusal, unresolved-import
    reporting, the README, the 404, and — the criterion that matters most — that
    a hostile ontology label is escaped in the generated page rather than
    executed.

BASIC IDEA
    Ontologies are generated in-process as small Turtle strings (rdf-fixture
    conventions) and turned into a zip with docs_export.build_zip, or fetched
    through the HTTP layer for the endpoint tests. The security test feeds a
    label containing <script> through generation and asserts it appears escaped:
    this page is written to an HTML file the user publishes, a path React's
    escaping never protects, so pyLODE's reputation is not the proof — this test
    is (AC-9).

INPUTS / INPUT SOURCES
    - Turtle fixtures built inline in example.org namespaces.
    - The FastAPI app driven by TestClient for the endpoint and its 404.

EXPECTED OUTPUT
    - Pass/fail per assertion; a failure means the published artefact is wrong
      in a way its reader could not detect — a missing file, an absolute path
      that 404s off the domain root, a silently truncated graph, or unescaped
      markup.
================================================================================
"""

import io
import json
import re
import time
import zipfile

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph

from app import docs_export
from app.docs_export import (
    OversizeGraphError,
    build_zip,
    confirmation_host,
    detect_profile,
    unresolved_imports,
)
from app.main import app
from app.store import OntologyStore

client = TestClient(app)

# --- fixtures ---------------------------------------------------------------

EX = "http://example.org/ex#"

OWL_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<{EX}> a owl:Ontology ;
    rdfs:label "Example OWL ontology" ;
    rdfs:comment "A tiny OWL ontology for tests." ;
    owl:versionInfo "1.0" .
:Animal a owl:Class ; rdfs:label "Animal" ; rdfs:comment "A living creature." .
:Dog a owl:Class ; rdfs:label "Dog" ; rdfs:subClassOf :Animal .
:owns a owl:ObjectProperty ; rdfs:label "owns" ; rdfs:domain :Animal ; rdfs:range :Animal .
:Rex a owl:NamedIndividual, :Dog ; rdfs:label "Rex" .
"""

SKOS_TTL = f"""
@prefix : <{EX}> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
:scheme a skos:ConceptScheme ; skos:prefLabel "Colours" .
:red a skos:Concept ; skos:prefLabel "Red" ; skos:inScheme :scheme ;
    skos:definition "The colour red." ; skos:narrower :crimson .
:crimson a skos:Concept ; skos:prefLabel "Crimson" ; skos:inScheme :scheme ;
    skos:broader :red .
"""

MIXED_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<{EX}> a owl:Ontology ; rdfs:label "Mixed ontology" .
:Animal a owl:Class ; rdfs:label "Animal" .
:scheme a skos:ConceptScheme ; skos:prefLabel "Traits" .
:loyal a skos:Concept ; skos:prefLabel "Loyalty" ; skos:inScheme :scheme .
"""

HOSTILE_LABEL = '<script>alert(1)</script>'
HOSTILE_COMMENT = '<img src=x onerror=alert(2)>'
HOSTILE_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<{EX}> a owl:Ontology ; rdfs:label "Hostile" .
:Evil a owl:Class ; rdfs:label "{HOSTILE_LABEL}" ; rdfs:comment "{HOSTILE_COMMENT}" .
"""

IMPORTS_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<{EX}> a owl:Ontology ; rdfs:label "Importer" ;
    owl:imports <http://example.org/missing-vocab> .
:Thing a owl:Class ; rdfs:label "Thing" .
"""


def _store():
    """A fresh, isolated store per test so nothing leaks between them."""
    import tempfile

    return OntologyStore(tempfile.mkdtemp(prefix="docs-export-tests-"))


def _add(ttl: str, name: str = "ex.ttl", source: str = "upload"):
    return _store().add(name, source, ttl.encode("utf-8"), "turtle")


def _zip(ttl: str, **kw) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(build_zip(_add(ttl, **kw))))


# --- AC-1 / AC-2: the zip's contents ---------------------------------------


def test_zip_contains_expected_entries():
    zf = _zip(OWL_TTL)
    names = set(zf.namelist())
    assert names == {
        "index.html",
        ".nojekyll",
        "ontology.ttl",
        "README.md",
        "assets/graph.js",
        "assets/styles.css",
        "assets/graph-data.json",
    }


def test_nojekyll_is_present_and_empty():
    zf = _zip(OWL_TTL)
    assert ".nojekyll" in zf.namelist()
    assert zf.read(".nojekyll") == b""


def test_source_ontology_is_included():
    zf = _zip(OWL_TTL)
    turtle = zf.read("ontology.ttl").decode("utf-8")
    # It must be real, re-parseable RDF describing the same ontology.
    g = Graph()
    g.parse(data=turtle, format="turtle")
    assert (None, None, None) in g
    assert "Animal" in turtle


def test_readme_names_the_ontology_and_the_steps():
    zf = _zip(OWL_TTL, name="acme-core.ttl")
    readme = zf.read("README.md").decode("utf-8")
    assert "acme-core.ttl" in readme
    assert "GitHub Pages" in readme
    assert "repository" in readme.lower()


# --- AC-4: profile detection ------------------------------------------------


def test_ontpub_profile_for_owl():
    assert detect_profile(_add(OWL_TTL).ensure_loaded()) == "ontpub"


def test_vocpub_profile_for_skos():
    assert detect_profile(_add(SKOS_TTL).ensure_loaded()) == "vocpub"


def test_mixed_ontology_uses_ontpub_and_says_so():
    o = _add(MIXED_TTL)
    assert detect_profile(o.ensure_loaded()) == "mixed"
    html = zipfile.ZipFile(io.BytesIO(build_zip(o))).read("index.html").decode()
    # The note is stated outright — guessing wrong silently would be worse.
    assert "listed rather than expanded" in html
    # And the OWL section leads (OntPub layout), before the SKOS one.
    assert html.index("Classes") < html.index("Concepts")


# --- AC-5 / AC-10: the embedded graph, complete and bounded -----------------


def test_graph_json_is_complete():
    o = _add(OWL_TTL)
    viz = o.viz()
    gd = json.loads(zipfile.ZipFile(io.BytesIO(build_zip(o))).read("assets/graph-data.json"))
    # Every entity in the full viz graph is present — never budgeted. This is
    # also the mutation guard for the truncate-instead-of-refuse defect: a
    # truncated graph fails this the moment it drops a node.
    assert len(gd["nodes"]) == len(viz["nodes"])
    assert {n["id"] for n in gd["nodes"]} == {n["id"] for n in viz["nodes"]}
    assert len(gd["edges"]) == len(viz["edges"])


def test_oversize_graph_is_refused(monkeypatch):
    o = _add(OWL_TTL)
    # Force the guard: this small graph's JSON is a few KB, so a tiny ceiling
    # makes it overflow, exercising the refusal branch with a realistic graph.
    monkeypatch.setattr(docs_export, "MAX_GRAPH_JSON_BYTES", 10)
    with pytest.raises(OversizeGraphError):
        build_zip(o)


def test_refusal_names_the_size(monkeypatch):
    o = _add(OWL_TTL)
    monkeypatch.setattr(docs_export, "MAX_GRAPH_JSON_BYTES", 10)
    with pytest.raises(OversizeGraphError) as caught:
        build_zip(o)
    message = str(caught.value)
    assert "MB" in message
    # The number is the actual size, not the limit, so it is actionable.
    assert re.search(r"\d+\.\d+ MB", message)


def test_zip_size_for_a_small_ontology():
    data = build_zip(_add(OWL_TTL))
    assert len(data) <= 2 * 1024 * 1024


def test_generation_time():
    o = _add(OWL_TTL)
    o.viz()  # already-parsed, as AC-10 specifies
    started = time.perf_counter()
    build_zip(o)
    assert time.perf_counter() - started <= 20.0


# --- AC-14: the fetch-source confirmation rule ------------------------------


def test_upload_source_needs_no_confirmation():
    assert confirmation_host("upload") is None


def test_url_source_is_flagged_for_confirmation():
    host = confirmation_host("https://spec.edmcouncil.org/fibo/ontology/prod.ttl")
    assert host == "spec.edmcouncil.org"


# --- AC-7: unresolved imports ----------------------------------------------


def test_unresolved_imports_are_listed():
    o = _add(IMPORTS_TTL)
    assert unresolved_imports(o.ensure_loaded()) == ["http://example.org/missing-vocab"]
    html = zipfile.ZipFile(io.BytesIO(build_zip(o))).read("index.html").decode()
    assert "http://example.org/missing-vocab" in html
    assert "not" in html.lower() and "resolved" in html.lower()


# --- AC-9: escaping (the criterion that matters most) -----------------------


def test_hostile_label_is_escaped_in_output():
    html = _zip(HOSTILE_TTL).read("index.html").decode()
    # The raw markup must never appear — it would be executed on the published
    # page under the user's own domain.
    assert HOSTILE_LABEL not in html
    assert "<img src=x onerror=" not in html
    # It must appear, escaped, so the label is still shown as text.
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_graph_json_is_serialized_not_concatenated():
    zf = _zip(HOSTILE_TTL)
    html = zf.read("index.html").decode()
    # The inline data block must not let a hostile label break out of <script>.
    assert "</script>alert" not in html
    assert "<script>alert(1)</script>" not in html
    # The standalone data file is valid JSON (serialized, not concatenated) and
    # preserves the label as data — escaping is a markup concern, not a data one.
    gd = json.loads(zf.read("assets/graph-data.json"))
    labels = {n["label"] for n in gd["nodes"]}
    assert HOSTILE_LABEL in labels


# --- AC-3 / AC-6: self-contained, subpath-safe paths ------------------------


def test_no_path_is_root_absolute():
    html = _zip(OWL_TTL).read("index.html").decode()
    # A leading "/" works locally and 404s the moment the site is served from a
    # GitHub Pages subpath — the worst failure, because it passes the author.
    assert not re.search(r'(?:src|href)\s*=\s*"/', html)


def test_page_makes_no_external_resource_load():
    html = _zip(OWL_TTL).read("index.html").decode()
    styles = _zip(OWL_TTL).read("assets/styles.css").decode()
    # No resource-loading reference may be absolute/protocol-relative: src=,
    # url() in CSS, and stylesheet/script hrefs. Anchor hyperlinks in prose are
    # navigation, not loads, and are excluded by design (the page links terms).
    assert not re.search(r'src\s*=\s*["\'](?:https?:)?//', html)
    assert not re.search(r'<link[^>]+href\s*=\s*["\'](?:https?:)?//', html)
    assert not re.search(r'url\(\s*["\']?(?:https?:)?//', html + styles)


# --- AC-11 / endpoint -------------------------------------------------------


def test_unknown_ontology_returns_404():
    assert client.get("/api/ontologies/ont-nope/documentation").status_code == 404


def test_endpoint_returns_zip_attachment():
    with io.BytesIO(OWL_TTL.encode("utf-8")) as f:
        up = client.post(
            "/api/ontologies/upload",
            files={"file": ("acme-core.ttl", f, "text/turtle")},
        )
    oid = up.json()["id"]
    resp = client.get(f"/api/ontologies/{oid}/documentation")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers["content-disposition"]
    assert "acme-core-docs.zip" in resp.headers["content-disposition"]
    # The body is a real zip with the site in it.
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    assert "index.html" in zf.namelist()
