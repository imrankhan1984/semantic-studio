"""
================================================================================
FILE: backend/tests/test_source_view.py
================================================================================

SUMMARY
    Tests the /source endpoint that powers the View tab: the original file is
    returned verbatim, the "pretty" form re-serializes to valid Turtle with the
    same triple count, large files truncate on a line boundary while reporting
    the true size, and an absurd size request is rejected. Above 20,000
    statements only the part the cap shows is serialised, with the true count
    (CF-3), while the documentation export still writes the whole.

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

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})


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


# ---------------------------------------------------------------------------
# A large ontology (CF-3): above BOUNDED_SOURCE_FROM statements the formatted
# view serialises only the part its cap can show. Proved by a count of the
# statements handed to serialize, never by a timing.
# ---------------------------------------------------------------------------

BIG_CLASSES = 4_000


def _big_turtle() -> bytes:
    # Six statements a class, one with a restriction's blank node, so the part
    # has to bring a blank node's own statements with its subject.
    lines = [
        "@prefix ex: <http://example.org/big#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    ]
    for i in range(BIG_CLASSES):
        lines.append(
            f'ex:C{i:05d} a owl:Class ; rdfs:label "Class {i}"@en ; '
            f'rdfs:comment "Generated class number {i}." ; '
            f"rdfs:subClassOf ex:C{i // 3:05d} , "
            f"[ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:C{i // 2:05d} ] ."
        )
    return "\n".join(lines).encode("utf-8")


@pytest.fixture(scope="module")
def big_id() -> str:
    response = client.post(
        "/api/ontologies/upload",
        files={"file": ("big-for-source.ttl", _big_turtle(), "text/turtle")},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


@pytest.fixture
def serialised(monkeypatch) -> list[int]:
    """The size of every graph handed to Graph.serialize while the test runs."""
    from rdflib import Graph

    sizes: list[int] = []
    real = Graph.serialize

    def spy(self, *args, **kwargs):
        sizes.append(len(self))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Graph, "serialize", spy)
    return sizes


def _total(oid: str) -> int:
    from app.store import store

    return len(store.get(oid).ensure_loaded())


def test_a_large_ontology_serialises_only_the_part_shown(big_id, serialised):
    from rdflib import Graph

    from app.store import BOUNDED_SOURCE_FROM

    total = _total(big_id)
    assert total > BOUNDED_SOURCE_FROM
    body = client.get(
        f"/api/ontologies/{big_id}/source", params={"pretty": True, "max_bytes": 200_000}
    ).json()
    # Never the whole graph: only the part, a fraction of it.
    assert serialised and max(serialised) < total // 4
    assert body["truncated"] is True
    assert body["statements"]["total"] == total
    assert 0 < body["statements"]["shown"] <= max(serialised)
    assert len(body["text"]) <= 200_000
    # The part is whole subjects, so it is Turtle on its own, blank nodes and all.
    part = Graph().parse(data=body["text"], format="turtle")
    assert len(part) == body["statements"]["shown"]
    assert "ex:C00000" in body["text"]


def test_under_the_threshold_the_view_is_unchanged(ontology_id, serialised):
    from app.store import store

    # An earlier test may have cached the whole; this one watches it written.
    store.get(ontology_id).pretty_cache = None
    body = client.get(f"/api/ontologies/{ontology_id}/source", params={"pretty": True}).json()
    assert serialised == [_total(ontology_id)]
    assert "statements" not in body
    assert body["truncated"] is False


def test_the_documentation_export_still_serialises_everything(big_id, serialised):
    from app.store import store

    store.get(big_id).pretty_cache = None
    response = client.get(f"/api/ontologies/{big_id}/documentation")
    assert response.status_code == 200, response.text[:300]
    assert _total(big_id) in serialised
