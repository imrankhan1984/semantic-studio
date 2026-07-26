"""
================================================================================
FILE: backend/tests/test_sparql_endpoint.py
================================================================================

SUMMARY
    Tests SPARQL execution and its safety rails: SELECT returns rows, literals
    and unbound OPTIONAL variables serialize correctly, UPDATE/CONSTRUCT/ASK
    and malformed queries are rejected, the row cap truncates, and the
    schema/query-node/saved-query endpoints behave.

BASIC IDEA
    Uploads the demo ontology through the HTTP layer, then runs known queries
    against it and asserts both the results and the error handling. Also calls
    execute_select directly to test the row cap and non-SELECT rejection.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl (uploaded via the API).
    - Hand-written SPARQL query strings.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a query-execution or
      safety-rail regression.
================================================================================
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph

from app.main import app
from app.sparql_exec import QueryError, execute_select

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
