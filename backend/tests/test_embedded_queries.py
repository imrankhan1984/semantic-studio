"""
================================================================================
FILE: backend/tests/test_embedded_queries.py
================================================================================

SUMMARY
    GET /api/ontologies/{id}/embedded-queries: SPARQL stored in a loaded file as
    SHACL sh:select / sh:construct / sh:ask or SPIN sp:text is found, labelled
    and given its form; the listing is capped at 200 rows and 100 KB a text,
    and says so; `$this` is flagged; the query schema carries the count; and
    the listing holds its 100 ms budget on a 40,000-class ontology.

BASIC IDEA
    Small inline Turtle for behaviour, a generated N-Triples file for scale.
    The SHACL and SPIN namespaces are real vocabulary IRIs, against the usual
    fixture rule, because recognising those exact predicates is the feature.

    The budget is the median of five with the collector paused (D-024), in a
    module that also holds a 40,000-class ontology; one sample would measure
    how many other fixtures the suite has resident.

INPUTS / INPUT SOURCES
    - Inline Turtle; generated N-Triples for the budget.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-11 and Section 10's first number.
================================================================================
"""

import gc
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.embedded_queries import MAX_ENTRIES, MAX_TEXT_CHARS, query_form

from budget import limit_ms

client = TestClient(main.app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

PREFIXES = """
@prefix ex: <http://example.org/shapes#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sp: <http://spinrdf.org/sp#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
"""

SHAPES = PREFIXES + """
ex:PersonShape a sh:NodeShape ;
    rdfs:label "Person shape" ;
    sh:sparql [
        sh:select \"\"\"SELECT $this WHERE { $this ex:age ?age . FILTER (?age < 0) }\"\"\" ;
    ] .

ex:HasName rdfs:label "Has a name" ;
    sh:ask "ASK { ?s ex:name ?n }" .

ex:Copy rdfs:label "Copy names" ;
    sh:construct "CONSTRUCT { ?s ex:label ?n } WHERE { ?s ex:name ?n }" .

ex:SpinSelect rdfs:label "SPIN select" ;
    sp:text \"\"\"# a comment naming CONSTRUCT
PREFIX ex: <http://example.org/ASK#>
SELECT ?s WHERE { ?s a ex:Thing }\"\"\" .

ex:SpinDescribe rdfs:label "SPIN describe" ;
    sp:text "DESCRIBE <http://example.org/x>" .

ex:NotText rdfs:label "Not text" ;
    sh:select ex:SomethingElse .
"""


def _upload(text: str, name: str, mime: str = "text/turtle") -> str:
    response = client.post(
        "/api/ontologies/upload", files={"file": (name, text.encode("utf-8"), mime)}
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _listing(oid: str) -> dict:
    response = client.get(f"/api/ontologies/{oid}/embedded-queries")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def shapes_oid() -> str:
    return _upload(SHAPES, "shapes.ttl")


def test_shacl_and_spin_literals_are_found_with_their_form(shapes_oid):
    listing = _listing(shapes_oid)
    by_label = {q["label"]: q for q in listing["queries"]}
    # The blank node carrying sh:select is named after the shape pointing at it.
    assert by_label["Person shape"]["form"] == "SELECT"
    assert by_label["Person shape"]["subject"] is None
    assert by_label["Has a name"]["form"] == "ASK"
    assert by_label["Copy names"]["form"] == "CONSTRUCT"
    # SPIN's form is read from the text, past the comment and the IRI that
    # each contain a different form's keyword.
    assert by_label["SPIN select"]["form"] == "SELECT"
    assert by_label["SPIN describe"]["form"] == "DESCRIBE"
    assert by_label["SPIN select"]["predicate"] == "http://spinrdf.org/sp#text"
    # An IRI object is not query text.
    assert "Not text" not in by_label
    assert listing["total"] == 5
    assert listing["truncated"] is False


def test_shacl_variables_are_flagged(shapes_oid):
    by_label = {q["label"]: q for q in _listing(shapes_oid)["queries"]}
    assert by_label["Person shape"]["shaclVariables"] is True
    assert by_label["Has a name"]["shaclVariables"] is False


def test_the_query_schema_carries_the_count(shapes_oid):
    # The panel learns whether to show the list from the schema it already
    # fetches, so Query mode's request count does not change (AC-1).
    schema = client.get(f"/api/ontologies/{shapes_oid}/query-schema").json()
    assert schema["embeddedQueryCount"] == 5


def test_a_file_without_queries_lists_nothing():
    oid = _upload(PREFIXES + 'ex:A rdfs:label "A" .\n', "plain.ttl")
    assert _listing(oid) == {"queries": [], "total": 0, "truncated": False}
    assert client.get(f"/api/ontologies/{oid}/query-schema").json()["embeddedQueryCount"] == 0


def test_listing_is_capped_at_200_and_reports_the_total():
    rows = [
        f'ex:Q{i:04d} rdfs:label "Query {i}" ; sh:select "SELECT * WHERE {{ ?s ?p ?o }}" .'
        for i in range(MAX_ENTRIES + 50)
    ]
    oid = _upload(PREFIXES + "\n".join(rows) + "\n", "many.ttl")
    listing = _listing(oid)
    assert len(listing["queries"]) == MAX_ENTRIES
    assert listing["total"] == MAX_ENTRIES + 50
    assert listing["truncated"] is True
    # Sorted, so the same 200 come back every time.
    assert listing["queries"][0]["label"] == "Query 0"


def test_a_long_text_is_cut_and_flagged():
    long_text = "SELECT * WHERE { ?s ?p ?o } #" + "x" * (MAX_TEXT_CHARS + 10)
    oid = _upload(PREFIXES + f'ex:Long rdfs:label "Long" ; sh:select "{long_text}" .\n', "long.ttl")
    (entry,) = _listing(oid)["queries"]
    assert entry["truncated"] is True
    assert len(entry["text"]) == MAX_TEXT_CHARS


def test_listing_never_runs_anything(shapes_oid, monkeypatch):
    # Read-only: listing a query must not execute it.
    from app import sparql_exec
    from app.routers import ontologies

    def refuse(*_args, **_kwargs):
        raise AssertionError("listing executed a query")

    # Both names: the router imported execute_select directly.
    monkeypatch.setattr(ontologies, "execute_select", refuse)
    monkeypatch.setattr(sparql_exec, "prepare_select", refuse)
    assert _listing(shapes_oid)["total"] == 5


def test_embedded_select_runs_and_other_forms_are_refused(shapes_oid):
    by_label = {q["label"]: q for q in _listing(shapes_oid)["queries"]}
    run = client.post(
        f"/api/ontologies/{shapes_oid}/sparql", json={"query": by_label["SPIN select"]["text"]}
    )
    assert run.status_code == 200, run.text
    refused = client.post(
        f"/api/ontologies/{shapes_oid}/sparql", json={"query": by_label["Has a name"]["text"]}
    )
    assert refused.status_code == 400


def test_unknown_ontology_is_404():
    assert client.get("/api/ontologies/ont-nope/embedded-queries").status_code == 404


@pytest.mark.parametrize(
    "text,form",
    [
        ("select ?s {}", "SELECT"),
        ("PREFIX a: <http://x/SELECT#>\nASK {}", "ASK"),
        ("# DESCRIBE\nCONSTRUCT {} WHERE {}", "CONSTRUCT"),
        ("INSERT DATA { <a:b> <a:c> <a:d> }", "UPDATE"),
        ("", "UNKNOWN"),
    ],
)
def test_query_form(text, form):
    assert query_form(text) == form


# --- budget --------------------------------------------------------------------


def _big_ntriples(classes: int, queries: int) -> bytes:
    """A 40,000-class binary tree with `queries` sh:select literals on it."""
    ex = "http://example.org/embedded#"
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    sub = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    owl_class = "http://www.w3.org/2002/07/owl#Class"
    select = "http://www.w3.org/ns/shacl#select"
    out = []
    for i in range(classes):
        iri = f"{ex}C{i}"
        out.append(f"<{iri}> <{type_}> <{owl_class}> .")
        out.append(f'<{iri}> <{label}> "Generated class number {i}" .')
        if i > 0:
            out.append(f"<{iri}> <{sub}> <{ex}C{(i - 1) // 2}> .")
        if i < queries:
            out.append(f'<{iri}> <{select}> "SELECT ?x WHERE {{ ?x a <{iri}> }}" .')
    return ("\n".join(out) + "\n").encode("utf-8")


@pytest.mark.perf
def test_listing_budget():
    """Section 10: at most 100 ms on the 40,000-node fixture, median of five."""
    oid = _upload(_big_ntriples(40000, 300).decode("utf-8"), "big-embedded.nt", "application/n-triples")
    _listing(oid)  # parse and warm, outside the timed window

    samples = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            listing = _listing(oid)
            samples.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = sorted(samples)[2]
    # The work was real: the cap bound, over a total the fixture chose.
    assert listing["total"] == 300 and len(listing["queries"]) == MAX_ENTRIES
    assert median <= limit_ms(100), f"embedded-queries listing took {median:.1f} ms (median of 5)"
