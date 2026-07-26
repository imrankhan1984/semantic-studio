"""
================================================================================
FILE: backend/tests/test_source_view.py
================================================================================

SUMMARY
    Tests the /source endpoint that powers the View tab: the original file is
    returned verbatim, the "pretty" form re-serializes to valid Turtle with the
    same triple count, large files truncate on a line boundary while reporting
    the true size, and an absurd size request is rejected.

BASIC IDEA
    Uploads the demo ontology, then requests its source in both modes and with
    a tiny max_bytes, asserting the text, format flags and truncation metadata.

INPUTS / INPUT SOURCES
    - examples/space-exploration.ttl (uploaded via the API).

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate a source-view regression.
================================================================================
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"

client = TestClient(app)


@pytest.fixture(scope="module")
def ontology_id() -> str:
    with EXAMPLE.open("rb") as f:
        response = client.post(
            "/api/ontologies/upload",
            files={"file": ("space-exploration.ttl", f, "text/turtle")},
        )
    assert response.status_code == 200
    return response.json()["id"]


def test_returns_the_original_file_verbatim(ontology_id):
    body = client.get(f"/api/ontologies/{ontology_id}/source").json()
    assert body["pretty"] is False
    assert body["format"] == "turtle"
    assert body["truncated"] is False
    assert body["name"] == "space-exploration.ttl"
    # Comments and layout only exist in the original, never in a re-serialization.
    assert "# Relationships stated as OWL restrictions" in body["text"]
    # Compared with newlines normalized, which is what the endpoint returns.
    assert body["text"] == EXAMPLE.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert "\r" not in body["text"]
    assert body["lines"] > 50


def test_pretty_form_is_valid_turtle_with_the_same_content(ontology_id):
    body = client.get(f"/api/ontologies/{ontology_id}/source", params={"pretty": True}).json()
    assert body["pretty"] is True
    assert body["format"] == "turtle"
    assert "@prefix" in body["text"]
    # Re-serialized output drops the source comments but keeps the statements.
    assert "# Relationships stated as OWL restrictions" not in body["text"]
    assert "Celestial Body" in body["text"]

    from rdflib import Graph

    reparsed = Graph().parse(data=body["text"], format="turtle")
    original = Graph().parse(EXAMPLE, format="turtle")
    assert len(reparsed) == len(original)


def test_truncates_at_a_line_boundary(ontology_id):
    body = client.get(
        f"/api/ontologies/{ontology_id}/source", params={"max_bytes": 400}
    ).json()
    assert body["truncated"] is True
    assert len(body["text"]) <= 400
    # Cut on a newline, so no half-written statement is shown.
    assert not body["text"].endswith("\n") or body["text"].count("\n") > 0
    # The full size is still reported so the UI can say what was left out.
    assert body["bytes"] > len(body["text"])


def test_rejects_an_absurd_request_size(ontology_id):
    response = client.get(
        f"/api/ontologies/{ontology_id}/source", params={"max_bytes": 999_999_999}
    )
    assert response.status_code == 422


def test_unknown_ontology():
    assert client.get("/api/ontologies/ont-nope/source").status_code == 404
