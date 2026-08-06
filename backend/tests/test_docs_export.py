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

from app import docs_export, provenance
from app.docs_export import (
    OversizeGraphError,
    OversizeHtmlError,
    OversizeNodeCountError,
    OversizeSourceError,
    OversizeZipError,
    TermCountError,
    abox_counts,
    build_graph_data,
    build_zip,
    confirmation_host,
    detect_profile,
    has_omitted_constructs,
    unresolved_imports,
)
from app.main import app
from app.routers import ontologies as ontologies_router
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
        "source/original.ttl",
        "exports/ontology.ttl",
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
    turtle = zf.read("exports/ontology.ttl").decode("utf-8")
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


def test_graph_json_is_complete_schema():
    # AC-5 (amended): the embedded graph is the whole SCHEMA graph — every
    # schema entity, never budgeted — but individuals are excluded by default.
    # This is also the mutation guard for the truncate-instead-of-refuse defect:
    # a truncated graph fails this the moment it drops a schema node.
    o = _add(OWL_TTL)
    viz = o.viz()
    gd = json.loads(zipfile.ZipFile(io.BytesIO(build_zip(o))).read("assets/graph-data.json"))
    schema_ids = {n["id"] for n in viz["nodes"] if n["kind"] != "individual"}
    assert {n["id"] for n in gd["nodes"]} == schema_ids
    # No A-box edge survives the default export.
    assert not any(e["kind"] in ("instanceOf", "assertion") for e in gd["edges"])


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


# ============================================================================
# v0.5 REWORK — A-box exclusion, edge meaning, source preservation, guards,
# the simplified-documentation statement, provenance and the rate limit.
# ============================================================================

# An ontology with two named individuals whose IRIs look confidential, and one
# object-property assertion between them. The whole point of AC-15 is that these
# do not reach the published artefact unless the user opts in.
ALICE = f"{EX}AliceConfidential"
BOB = f"{EX}BobConfidential"
ABOX_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<{EX}> a owl:Ontology ; rdfs:label "Directory" .
:Person a owl:Class ; rdfs:label "Person" .
:knows a owl:ObjectProperty ; rdfs:label "knows" ; rdfs:domain :Person ; rdfs:range :Person .
:AliceConfidential a owl:NamedIndividual, :Person ; rdfs:label "Alice Confidential" .
:BobConfidential a owl:NamedIndividual, :Person ; rdfs:label "Bob Confidential" ;
    :knows :AliceConfidential .
"""

# owl:Restriction is a construct the exporter does not render; its presence must
# trigger the simplified-documentation statement (AC-21).
RESTRICTION_TTL = f"""
@prefix : <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<{EX}> a owl:Ontology ; rdfs:label "Restricted" .
:Animal a owl:Class ; rdfs:label "Animal" .
:owns a owl:ObjectProperty ; rdfs:label "owns" .
:Owner a owl:Class ; rdfs:label "Owner" ; rdfs:subClassOf
    [ a owl:Restriction ; owl:onProperty :owns ; owl:someValuesFrom :Animal ] .
"""

# Non-Turtle sources, to prove the EXACT original bytes are preserved with the
# right extension (AC-18) rather than silently reserialized to Turtle.
RDFXML_BYTES = (
    '<?xml version="1.0"?>\n'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n'
    '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"\n'
    '         xmlns:owl="http://www.w3.org/2002/07/owl#">\n'
    '  <owl:Class rdf:about="http://example.org/ex#Animal">\n'
    "    <rdfs:label>Animal</rdfs:label>\n"
    "  </owl:Class>\n"
    "</rdf:RDF>\n"
).encode("utf-8")

JSONLD_BYTES = (
    "{\n"
    '  "@context": {"rdfs": "http://www.w3.org/2000/01/rdf-schema#",\n'
    '               "owl": "http://www.w3.org/2002/07/owl#"},\n'
    '  "@id": "http://example.org/ex#Animal",\n'
    '  "@type": "owl:Class",\n'
    '  "rdfs:label": "Animal"\n'
    "}\n"
).encode("utf-8")


def _add_bytes(data: bytes, fmt: str, name: str, source: str = "upload"):
    return _store().add(name, source, data, fmt)


def _gd(ontology, **kw) -> dict:
    """The graph-data.json of an ontology's export, parsed."""
    return json.loads(zipfile.ZipFile(io.BytesIO(build_zip(ontology, **kw))).read("assets/graph-data.json"))


def _html(ontology, **kw) -> str:
    return zipfile.ZipFile(io.BytesIO(build_zip(ontology, **kw))).read("index.html").decode("utf-8")


# --- AC-15: instance data excluded by default (the P0, the security row) ----


def test_default_export_has_no_abox():
    # Mutation guard: re-including the A-box (kind "individual" back in the
    # default documentable set, or the abox edge filter removed) turns this red.
    gd = _gd(_add(ABOX_TTL))
    assert not any(n["kind"] == "individual" for n in gd["nodes"])
    assert not any(e["kind"] in ("instanceOf", "assertion") for e in gd["edges"])


def test_confidential_individual_absent_by_default():
    o = _add(ABOX_TTL)
    html = _html(o)
    gd = _gd(o)
    graph_json = json.dumps(gd)
    for iri in (ALICE, BOB):
        assert iri not in html
        assert iri not in graph_json


# --- AC-16: the opt-in includes them, and the counts are reported -----------


def test_opt_in_includes_individuals():
    o = _add(ABOX_TTL)
    gd = _gd(o, include_individuals=True)
    ids = {n["id"] for n in gd["nodes"]}
    assert ALICE in ids and BOB in ids
    assert any(e["kind"] == "assertion" for e in gd["edges"])
    # The Named Individuals section appears in the page under the opt-in.
    assert "Named Individuals" in _html(o, include_individuals=True)


def test_opt_in_reports_counts():
    # abox_counts is what the confirmation states before generating (AC-16).
    individuals, assertions = abox_counts(_add(ABOX_TTL).viz())
    assert individuals == 2
    assert assertions == 1


def test_endpoint_include_individuals_query():
    with io.BytesIO(ABOX_TTL.encode("utf-8")) as f:
        oid = client.post(
            "/api/ontologies/upload", files={"file": ("dir.ttl", f, "text/turtle")}
        ).json()["id"]
    # Default: excluded.
    default_zip = client.get(f"/api/ontologies/{oid}/documentation").content
    default_gd = json.loads(zipfile.ZipFile(io.BytesIO(default_zip)).read("assets/graph-data.json"))
    assert ALICE not in {n["id"] for n in default_gd["nodes"]}
    # Opt-in: included.
    inc_zip = client.get(f"/api/ontologies/{oid}/documentation?include_individuals=true").content
    inc_gd = json.loads(zipfile.ZipFile(io.BytesIO(inc_zip)).read("assets/graph-data.json"))
    assert ALICE in {n["id"] for n in inc_gd["nodes"]}
    # Any other value means excluded, per the endpoint's contract.
    other = client.get(f"/api/ontologies/{oid}/documentation?include_individuals=yes").content
    other_gd = json.loads(zipfile.ZipFile(io.BytesIO(other)).read("assets/graph-data.json"))
    assert ALICE not in {n["id"] for n in other_gd["nodes"]}


# --- AC-17: edges keep their meaning, and a legend maps every kind present ---


def test_graph_edges_carry_kind_and_label():
    gd = _gd(_add(OWL_TTL))
    assert gd["edges"], "the fixture has structural edges"
    for e in gd["edges"]:
        assert "kind" in e and "label" in e
    assert any(e["kind"] == "subClassOf" for e in gd["edges"])


def test_legend_covers_every_edge_kind_present():
    html = _html(_add(OWL_TTL))
    assert 'class="graph-legend"' in html
    # OWL_TTL has subClassOf and domain/range edges; their legend labels appear.
    assert "Sub-class of" in html
    # A-box kinds are excluded by default, so their labels must NOT appear.
    assert "Instance of" not in html
    assert "Assertion" not in html


def test_hostile_edge_label_is_escaped():
    # An edge label is ontology-derived (a property name); prove the inline JSON
    # path escapes it, so a hostile label cannot break out of the <script> block.
    viz = {
        "nodes": [
            {"id": "a", "label": "A", "kind": "class", "degree": 1},
            {"id": "b", "label": "B", "kind": "class", "degree": 1},
        ],
        "edges": [{"source": "a", "target": "b", "kind": "assertion",
                   "label": "</script><script>alert(1)</script>"}],
    }
    gd = build_graph_data(viz, {}, include_individuals=True)
    inline = docs_export._inline_graph_json(gd)
    assert "<script>" not in inline
    assert "</script>" not in inline
    assert "\\u003cscript\\u003e" in inline


# --- AC-18: the original source bytes are preserved -------------------------


def test_original_source_bytes_preserved_ttl():
    zf = _zip(OWL_TTL)
    assert zf.read("source/original.ttl") == OWL_TTL.encode("utf-8")


def test_original_source_bytes_preserved_rdfxml():
    o = _add_bytes(RDFXML_BYTES, "xml", "animal.rdf")
    zf = zipfile.ZipFile(io.BytesIO(build_zip(o)))
    assert zf.read("source/original.rdf") == RDFXML_BYTES
    # And the canonical Turtle is separate and real.
    Graph().parse(data=zf.read("exports/ontology.ttl").decode("utf-8"), format="turtle")


def test_original_source_bytes_preserved_jsonld():
    o = _add_bytes(JSONLD_BYTES, "json-ld", "animal.jsonld")
    zf = zipfile.ZipFile(io.BytesIO(build_zip(o)))
    assert zf.read("source/original.jsonld") == JSONLD_BYTES


def test_canonical_ttl_present_in_exports():
    zf = _zip(OWL_TTL)
    assert "exports/ontology.ttl" in zf.namelist()
    Graph().parse(data=zf.read("exports/ontology.ttl").decode("utf-8"), format="turtle")


# --- AC-19 / AC-20: the independent size guards, each naming its limit -------


def test_oversize_node_count_is_refused(monkeypatch):
    monkeypatch.setattr(docs_export, "GRAPH_MAX_NODES", 1)
    with pytest.raises(OversizeNodeCountError) as caught:
        build_zip(_add(OWL_TTL))
    assert "entities" in str(caught.value)


def test_interactive_ceiling_draws_statically(monkeypatch):
    monkeypatch.setattr(docs_export, "GRAPH_INTERACTIVE_MAX_NODES", 1)
    o = _add(OWL_TTL)
    assert "interactive layout disabled" in _html(o)
    # The ceiling rides in the data so the browser-side viewer honours it.
    assert _gd(o)["interactiveMaxNodes"] == 1


def test_oversize_source_is_refused(monkeypatch):
    monkeypatch.setattr(docs_export, "MAX_SOURCE_BYTES", 5)
    with pytest.raises(OversizeSourceError) as caught:
        build_zip(_add(OWL_TTL))
    assert "MB" in str(caught.value)


def test_oversize_html_is_refused(monkeypatch):
    monkeypatch.setattr(docs_export, "MAX_HTML_BYTES", 10)
    with pytest.raises(OversizeHtmlError):
        build_zip(_add(OWL_TTL))


def test_zip_size_cap(monkeypatch):
    monkeypatch.setattr(docs_export, "MAX_ZIP_BYTES", 10)
    with pytest.raises(OversizeZipError):
        build_zip(_add(OWL_TTL))


def test_term_count_cap(monkeypatch):
    monkeypatch.setattr(docs_export, "MAX_TERMS", 0)
    with pytest.raises(TermCountError):
        build_zip(_add(OWL_TTL))


# --- AC-21: the simplified-documentation statement --------------------------


def test_simplified_note_present_when_constructs_omitted():
    o = _add(RESTRICTION_TTL)
    assert has_omitted_constructs(o.ensure_loaded())
    assert "simplified documentation" in _html(o)


def test_simplified_note_absent_for_plain_vocab():
    o = _add(SKOS_TTL)
    assert not has_omitted_constructs(o.ensure_loaded())
    assert "simplified documentation" not in _html(o)


def test_abox_note_present_by_default_and_absent_under_opt_in():
    o = _add(ABOX_TTL)
    assert "Instance data (individuals) is not included" in _html(o)
    assert "Instance data (individuals) is not included" not in _html(o, include_individuals=True)


# --- AC-22: provenance activity and the rate limit --------------------------


def test_export_records_a_provenance_activity():
    provenance.reset()
    with io.BytesIO(OWL_TTL.encode("utf-8")) as f:
        oid = client.post(
            "/api/ontologies/upload", files={"file": ("prov.ttl", f, "text/turtle")}
        ).json()["id"]
    client.get(f"/api/ontologies/{oid}/documentation")
    matching = [
        a for a in provenance.activities()
        if a["@type"] == "documentation-export" and a["subject"] == oid
    ]
    assert len(matching) == 1
    assert matching[0]["include_individuals"] is False
    assert "at" in matching[0]


def test_rate_limit_on_documentation_endpoint(monkeypatch):
    ontologies_router._reset_docs_rate_limit()
    monkeypatch.setattr(ontologies_router, "DOCS_RATE_MAX", 2)
    try:
        with io.BytesIO(OWL_TTL.encode("utf-8")) as f:
            oid = client.post(
                "/api/ontologies/upload", files={"file": ("rate.ttl", f, "text/turtle")}
            ).json()["id"]
        statuses = [
            client.get(f"/api/ontologies/{oid}/documentation").status_code for _ in range(3)
        ]
        assert statuses[:2] == [200, 200]
        assert statuses[2] == 429
    finally:
        ontologies_router._reset_docs_rate_limit()
