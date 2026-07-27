"""
================================================================================
FILE: backend/tests/test_sparql_endpoint.py
================================================================================

SUMMARY
    Tests SPARQL execution and its safety rails: SELECT returns rows, literals
    and unbound OPTIONAL variables serialize correctly, UPDATE/CONSTRUCT/ASK
    and malformed queries are rejected, a SERVICE clause is refused at any
    nesting depth without a request being made, the row cap truncates, and the
    schema/query-node/saved-query endpoints behave.

BASIC IDEA
    Uploads the demo ontology through the HTTP layer, then runs known queries
    against it and asserts both the results and the error handling. Also calls
    execute_select directly to test the row cap and non-SELECT rejection.

    The SERVICE tests point the clause at a loopback server that records every
    request it receives, and assert it received none. A status code alone would
    also pass against an application that made the call and then discarded the
    answer, which is exactly the defect being fixed.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl (uploaded via the API).
    - Hand-written SPARQL query strings.
    - A ThreadingHTTPServer on 127.0.0.1 standing in for a SPARQL endpoint.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a query-execution or
      safety-rail regression.
================================================================================
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph
from rdflib.plugins.sparql import prepareQuery

from app.main import app
from app.sparql_exec import QueryError, _contains_service, execute_select, prepare_select

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"
SPACE = "http://example.org/space#"

client = TestClient(app)

PLANETS = f"""
PREFIX : <{SPACE}>
SELECT ?planet WHERE {{ ?planet a :Planet . }}
"""


@pytest.fixture(scope="module")
def ontology_id() -> str:
    with EXAMPLE.open("rb") as f:
        response = client.post(
            "/api/ontologies/upload",
            files={"file": ("space-exploration.ttl", f, "text/turtle")},
        )
    assert response.status_code == 200
    return response.json()["id"]


@pytest.fixture(scope="module")
def graph() -> Graph:
    g = Graph()
    g.parse(EXAMPLE, format="turtle")
    return g


def test_select_returns_rows(ontology_id):
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": PLANETS})
    assert response.status_code == 200
    body = response.json()
    assert body["vars"] == ["planet"]
    values = {row[0]["value"] for row in body["rows"]}
    assert values == {SPACE + "Earth", SPACE + "Mars"}
    assert body["rows"][0][0]["type"] == "uri"
    assert body["rows"][0][0]["label"] in {"Earth", "Mars"}
    assert body["truncated"] is False
    assert body["durationMs"] >= 0


def test_literals_and_unbound_values(ontology_id):
    query = f"""
    PREFIX : <{SPACE}>
    SELECT ?planet ?diameter ?missing WHERE {{
      ?planet a :Planet .
      ?planet :diameterKm ?diameter .
      OPTIONAL {{ ?planet :nothingHere ?missing . }}
    }}
    """
    body = client.post(
        f"/api/ontologies/{ontology_id}/sparql", json={"query": query}
    ).json()
    assert body["vars"] == ["planet", "diameter", "missing"]
    row = body["rows"][0]
    assert row[1]["type"] == "literal"
    assert (row[1]["datatype"] or "") in {"xsd:integer", "xsd:decimal"}
    assert row[2] is None  # unbound OPTIONAL variable


def test_update_is_rejected(ontology_id):
    query = f'INSERT DATA {{ <{SPACE}X> a <{SPACE}Planet> . }}'
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": query})
    assert response.status_code == 400


def test_construct_and_ask_are_rejected(ontology_id):
    for query in (
        f"PREFIX : <{SPACE}> CONSTRUCT {{ ?s ?p ?o }} WHERE {{ ?s ?p ?o }}",
        f"PREFIX : <{SPACE}> ASK {{ ?s a :Planet }}",
    ):
        response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": query})
        assert response.status_code == 400, query
        assert "SELECT" in response.json()["detail"]


def test_malformed_query_is_rejected(ontology_id):
    response = client.post(
        f"/api/ontologies/{ontology_id}/sparql", json={"query": "SELECT ?x WHERE { ?x"}
    )
    assert response.status_code == 400
    assert "parse" in response.json()["detail"].lower()


def test_unknown_ontology(ontology_id):
    response = client.post("/api/ontologies/ont-nope/sparql", json={"query": PLANETS})
    assert response.status_code == 404


def test_row_cap_truncates(graph):
    result = execute_select(graph, "SELECT ?s ?p ?o WHERE { ?s ?p ?o }", max_rows=3)
    assert result["rowCount"] == 3
    assert result["truncated"] is True


def test_execute_select_rejects_non_select(graph):
    with pytest.raises(QueryError):
        execute_select(graph, "ASK { ?s ?p ?o }")


def test_query_schema_and_node_endpoints(ontology_id):
    schema = client.get(f"/api/ontologies/{ontology_id}/query-schema").json()
    assert any(c["iri"] == SPACE + "Planet" for c in schema["classes"])

    node = client.get(
        f"/api/ontologies/{ontology_id}/query-node", params={"iri": SPACE + "Earth"}
    ).json()
    assert node["isClass"] is False
    assert node["types"][0]["iri"] == SPACE + "Planet"

    missing = client.get(
        f"/api/ontologies/{ontology_id}/query-node", params={"iri": SPACE + "Nope"}
    )
    assert missing.status_code == 404


def test_saved_queries_roundtrip(ontology_id):
    state = {"steps": [{"classIri": SPACE + "Planet"}], "limit": 100}
    created = client.post(
        "/api/queries",
        json={
            "name": "All planets",
            "ontologyId": ontology_id,
            "state": state,
            "sparql": PLANETS,
        },
    ).json()
    assert created["name"] == "All planets"
    assert created["ontologyName"] == "space-exploration.ttl"

    listed = client.get("/api/queries", params={"ontology": ontology_id}).json()
    assert any(q["id"] == created["id"] for q in listed)

    # Saving with the same id updates in place instead of duplicating.
    updated = client.post(
        "/api/queries",
        json={
            "id": created["id"],
            "name": "Planets renamed",
            "ontologyId": ontology_id,
            "state": state,
            "sparql": PLANETS,
        },
    ).json()
    assert updated["id"] == created["id"]
    assert updated["createdAt"] == created["createdAt"]
    assert len(client.get("/api/queries", params={"ontology": ontology_id}).json()) == 1

    assert client.delete(f"/api/queries/{created['id']}").status_code == 200
    assert client.delete(f"/api/queries/{created['id']}").status_code == 404


def test_saved_query_requires_known_ontology():
    response = client.post(
        "/api/queries",
        json={"name": "x", "ontologyId": "ont-nope", "state": {}, "sparql": "SELECT * {}"},
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# SERVICE refusal — backlog S-2, spec section 5.2. SEC-6 to SEC-8 and UNIT-2.
#
# A SERVICE clause is legal inside a SELECT, so SELECT-only does not stop it.
# rdflib resolves one by POSTing to the address in the query, which turns this
# endpoint into a way to reach hosts the user could not reach themselves.
# ---------------------------------------------------------------------------


class _SparqlRecorder(BaseHTTPRequestHandler):
    """Records any request rdflib manages to make, and answers plausibly."""

    RESULTS = json.dumps(
        {"head": {"vars": ["s"]}, "results": {"bindings": []}}
    ).encode()

    def _record_and_answer(self):
        self.server.requests.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/sparql-results+json")
        self.send_header("Content-Length", str(len(self.RESULTS)))
        self.end_headers()
        self.wfile.write(self.RESULTS)

    do_GET = _record_and_answer
    do_POST = _record_and_answer

    def log_message(self, *args):
        pass


@pytest.fixture
def sparql_recorder():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SparqlRecorder)
    server.requests = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_service_is_refused_and_never_called(ontology_id, sparql_recorder):
    """SEC-6. The zero-requests assertion is the real test, not the 400."""
    endpoint = f"http://127.0.0.1:{sparql_recorder.server_address[1]}/sparql"
    query = f"SELECT ?s WHERE {{ SERVICE <{endpoint}> {{ ?s ?p ?o }} }}"
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": query})
    # The decisive assertion first: the refusal is worth nothing if the request
    # was made anyway and the result merely thrown away.
    assert sparql_recorder.requests == [], "rdflib called out to the SERVICE endpoint"
    assert response.status_code == 400
    assert "SERVICE" in response.json()["detail"]


@pytest.mark.parametrize(
    "template",
    [
        "SELECT ?s WHERE {{ SERVICE SILENT <{ep}> {{ ?s ?p ?o }} }}",
        "SELECT ?s WHERE {{ {{ ?s ?p ?o }} UNION {{ SERVICE <{ep}> {{ ?s ?p ?o }} }} }}",
        "SELECT ?s WHERE {{ ?s ?p ?o OPTIONAL {{ SERVICE <{ep}> {{ ?s ?p ?q }} }} }}",
        "SELECT ?s WHERE {{ {{ SELECT ?s WHERE {{ SERVICE <{ep}> {{ ?s ?p ?o }} }} }} }}",
        "SELECT ?s WHERE {{ GRAPH ?g {{ SERVICE <{ep}> {{ ?s ?p ?o }} }} }}",
    ],
    ids=["silent", "union", "optional", "subselect", "graph"],
)
def test_service_is_refused_at_every_nesting_depth(ontology_id, sparql_recorder, template):
    """SEC-7 and UNIT-2. Checking only the top level of the algebra is not enough.

    SILENT matters especially: it tells rdflib to swallow errors, so a naive
    implementation would call out and report success either way.
    """
    endpoint = f"http://127.0.0.1:{sparql_recorder.server_address[1]}/sparql"
    query = template.format(ep=endpoint)
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": query})
    assert sparql_recorder.requests == [], f"called out for: {query}"
    assert response.status_code == 400, query


def test_service_detection_walks_the_algebra_not_the_text():
    """UNIT-2, at the function itself, with no HTTP in the way.

    `_contains_service` is asserted against a parsed algebra directly so a
    failure points at the walk rather than at the endpoint wiring.
    """
    endpoint = "http://127.0.0.1:9/sparql"
    nested = [
        f"SELECT ?s WHERE {{ SERVICE <{endpoint}> {{ ?s ?p ?o }} }}",
        f"SELECT ?s WHERE {{ ?s ?p ?o . OPTIONAL {{ SERVICE SILENT <{endpoint}> {{ ?s ?p ?q }} }} }}",
        f"SELECT ?s WHERE {{ {{ ?s ?p ?o }} UNION {{ SERVICE <{endpoint}> {{ ?s ?p ?o }} }} }}",
    ]
    for query in nested:
        assert _contains_service(prepareQuery(query).algebra), query
        with pytest.raises(QueryError) as caught:
            prepare_select(query)
        assert "SERVICE" in str(caught.value)

    # And no false positives on queries that merely mention the word.
    for query in (
        "SELECT ?service WHERE { ?service ?p ?o }",
        "# SERVICE\nSELECT ?s WHERE { ?s ?p 'SERVICE' }",
    ):
        assert not _contains_service(prepareQuery(query).algebra), query


@pytest.mark.parametrize(
    "query",
    [
        # The word in a comment.
        "# a service query\nSELECT ?s WHERE { ?s ?p ?o } LIMIT 1",
        # The word as a variable name.
        "SELECT ?service WHERE { ?service ?p ?o } LIMIT 1",
        # The word in a literal, in the casing the clause uses.
        "SELECT ?s WHERE { ?s ?p ?o . FILTER(?o != 'SERVICE') } LIMIT 1",
        # A property whose IRI contains it.
        "SELECT ?s WHERE { ?s ?p ?o . FILTER(STRSTARTS(STR(?p), 'http://example.org/service')) } LIMIT 1",
    ],
    ids=["comment", "variable", "literal", "iri-fragment"],
)
def test_the_word_service_alone_does_not_refuse_a_query(ontology_id, query):
    """SEC-8 / AC-6. Text matching would fail every one of these."""
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": query})
    assert response.status_code == 200, response.json()


def test_ordinary_queries_still_run(ontology_id):
    """The fix must not cost the feature. A plain SELECT is unaffected."""
    response = client.post(f"/api/ontologies/{ontology_id}/sparql", json={"query": PLANETS})
    assert response.status_code == 200
    assert response.json()["rowCount"] == 2
