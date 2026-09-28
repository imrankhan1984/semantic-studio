"""
================================================================================
FILE: backend/tests/test_local_guard.py
================================================================================

SUMMARY
    Proves the local API refuses requests that did not come from the
    application's own page: a forged Host header (DNS rebinding), a
    state-changing request without the client header (cross-site request
    forgery), and a foreign Origin. Covers the external-access spec, Stage 0,
    AC-1 to AC-4 (backlog S-6, decision D-065).

BASIC IDEA
    Each refusal test checks two things: the status code, and that the library
    is unchanged afterwards. A 403 that still deleted the ontology would be
    worse than no check, because it would look like protection.

    The "every mutating route" test reads the routes from the application
    rather than listing them, so a route added later is covered without anyone
    remembering to add it here.

    Before this guard existed, the two attacks were measured against a live
    instance: a cross-site multipart upload was stored (200), and a forged Host
    listed the library and deleted an ontology (200).

INPUTS / INPUT SOURCES
    - The FastAPI app, driven through TestClient with explicit headers.
    - A tiny Turtle fixture uploaded through the normal route.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app import local_guard
from app.main import app
from app.store import store

TTL = b"@prefix : <http://example.org/> . :a :p :b ."
OK_HEADERS = {"X-Semantic-Studio": "1"}

# A client that behaves like the application's own page: a loopback Host and
# the client header. Individual tests override one thing at a time.
client = TestClient(app, base_url="http://localhost:8000")


def _upload() -> str:
    response = client.post(
        "/api/ontologies/upload",
        files={"file": ("guard.ttl", TTL, "text/turtle")},
        headers=OK_HEADERS,
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


# --- AC-1: Host --------------------------------------------------------------


@pytest.mark.parametrize("host", ["attacker.example", "attacker.example:8000", "192.168.1.20:8000"])
def test_foreign_host_is_refused_for_reads(host):
    response = client.get("/api/ontologies", headers={"Host": host})
    assert response.status_code == 400
    assert "did not come from Semantic Studio" in response.json()["detail"]


def test_foreign_host_cannot_delete():
    oid = _upload()
    response = client.delete(
        f"/api/ontologies/{oid}", headers={**OK_HEADERS, "Host": "attacker.example:8000"}
    )
    assert response.status_code == 400
    assert store.get(oid) is not None, "the refusal must happen before the delete"


@pytest.mark.parametrize(
    "host", ["localhost", "localhost:8000", "127.0.0.1:8000", "[::1]:8000", "localhost:5173"]
)
def test_loopback_hosts_are_accepted(host):
    assert client.get("/api/ontologies", headers={"Host": host}).status_code == 200


def test_extra_hosts_come_from_the_environment(monkeypatch):
    headers = {"Host": "studio.internal:443"}
    assert client.get("/api/ontologies", headers=headers).status_code == 400
    monkeypatch.setenv("SEMANTIC_STUDIO_ALLOWED_HOSTS", "other.example, Studio.Internal")
    assert client.get("/api/ontologies", headers=headers).status_code == 200


# --- AC-2: the client header on every state-changing route ---------------------


def _mutating_routes() -> list[tuple[str, str]]:
    """Every (method, path) the app exposes that is not a safe method.

    Read from the OpenAPI document rather than `app.routes`, because newer
    FastAPI versions nest included routers there and the OpenAPI paths are the
    public, stable list of every route.
    """
    found = []
    for path, operations in app.openapi()["paths"].items():
        for method in operations:
            if method.upper() in local_guard.SAFE_METHODS:
                continue
            # Fill path parameters with a placeholder; the guard runs before
            # routing, so the placeholder never has to exist.
            found.append((method.upper(), re.sub(r"\{[^}]+\}", "x", path)))
    return found


def test_route_discovery_finds_the_known_mutating_routes():
    routes = set(_mutating_routes())
    # Assert the discovery worked before trusting the next test's loop over it.
    for expected in [
        ("POST", "/api/ontologies/upload"),
        ("POST", "/api/ontologies/fetch"),
        ("DELETE", "/api/ontologies/x"),
        ("POST", "/api/ontologies/x/sparql"),
        ("POST", "/api/queries"),
        ("DELETE", "/api/queries/x"),
        # authoring-foundations: the project routes are found the same way.
        ("POST", "/api/projects"),
        ("PATCH", "/api/projects/x"),
        ("DELETE", "/api/projects/x"),
        ("POST", "/api/projects/x/documents/x/commands"),
        ("PUT", "/api/projects/x/documents/x/source"),
        ("POST", "/api/projects/x/documents/x/save"),
    ]:
        assert expected in routes


@pytest.mark.parametrize("method,path", _mutating_routes())
def test_every_mutating_route_needs_the_client_header(method, path):
    response = client.request(method, path)
    assert response.status_code == 403
    assert "did not come from Semantic Studio" in response.json()["detail"]


def test_wrong_header_value_is_refused():
    response = client.delete("/api/ontologies/x", headers={"X-Semantic-Studio": "yes"})
    assert response.status_code == 403


def test_cross_site_upload_is_not_stored():
    """The measured attack: a foreign page's multipart form post. A browser
    sends no custom header on it, and sends the attacker's Origin."""
    before = {o.id for o in store.list()}
    response = client.post(
        "/api/ontologies/upload",
        files={"file": ("csrf.ttl", TTL, "text/turtle")},
        headers={"Origin": "http://evil.example"},
    )
    assert response.status_code == 403
    assert {o.id for o in store.list()} == before


def test_delete_without_header_leaves_the_ontology():
    oid = _upload()
    assert client.delete(f"/api/ontologies/{oid}").status_code == 403
    assert store.get(oid) is not None


# --- AC-3: Origin ------------------------------------------------------------


@pytest.mark.parametrize(
    "origin", ["http://evil.example", "http://localhost:9999", "null", "https://localhost:8000"]
)
def test_foreign_origin_is_refused_even_with_the_header(origin):
    oid = _upload()
    response = client.delete(f"/api/ontologies/{oid}", headers={**OK_HEADERS, "Origin": origin})
    assert response.status_code == 403
    assert store.get(oid) is not None


@pytest.mark.parametrize(
    "origin,host",
    [
        ("http://localhost:8000", "localhost:8000"),  # Docker / uvicorn: one origin
        ("http://127.0.0.1:8000", "127.0.0.1:8000"),
        ("http://localhost:5173", "localhost:5173"),  # Vite dev server, proxied
        ("http://localhost:5173", "localhost:8000"),  # a proxy that rewrites Host
    ],
)
def test_own_origins_are_accepted(origin, host):
    oid = _upload()
    response = client.delete(
        f"/api/ontologies/{oid}", headers={**OK_HEADERS, "Origin": origin, "Host": host}
    )
    assert response.status_code == 200, response.text


# --- AC-4: normal use is unchanged -------------------------------------------


def test_reads_need_no_header():
    oid = _upload()
    assert client.get(f"/api/ontologies/{oid}/graph").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_dev_preflight_still_answered_by_cors():
    """The Vite dev page's own preflight must still succeed: OPTIONS is a safe
    method here, so CORS answers it exactly as before."""
    response = client.options(
        "/api/ontologies/upload",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-semantic-studio",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_foreign_preflight_is_not_granted():
    """Why a foreign page cannot send the header at all: its preflight gets no
    allow-origin, so the browser never sends the real request."""
    response = client.options(
        "/api/ontologies/upload",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-semantic-studio",
        },
    )
    assert "access-control-allow-origin" not in response.headers


# --- helpers, unit level -----------------------------------------------------


@pytest.mark.parametrize(
    "header,expected",
    [
        ("localhost:8000", "localhost"),
        ("LOCALHOST", "localhost"),
        ("[::1]:8000", "::1"),
        ("[::1]", "::1"),
        ("127.0.0.1", "127.0.0.1"),
        ("", ""),
    ],
)
def test_host_name(header, expected):
    assert local_guard.host_name(header) == expected
