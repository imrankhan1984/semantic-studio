"""
================================================================================
FILE: backend/tests/test_fetch_restrictions.py
================================================================================

SUMMARY
    Tests the URL-fetch guard rails: which hosts are allowed, how GitHub
    Enterprise URLs are rejected, and how github.com "blob" URLs are rewritten
    to raw download URLs. Also confirms plain file upload still works.

BASIC IDEA
    The /fetch endpoint and its helpers (is_github_enterprise_host, to_raw_url)
    decide what may be downloaded. These tests exercise those rules directly
    and via the HTTP layer using FastAPI's TestClient.

INPUTS / INPUT SOURCES
    - Constructed URLs (github.com, GitHub Enterprise-looking, arbitrary).
    - examples/space-exploration.ttl for the upload path.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate the fetch policy regressed.
================================================================================
"""

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.routers.ontologies import is_github_enterprise_host, to_raw_url

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"

# In-process HTTP client that drives the FastAPI app without a real server.
client = TestClient(app)


def test_rejects_github_enterprise_host():
    r = client.post(
        "/api/ontologies/fetch",
        json={"url": "https://github.mycompany.com/team/repo/blob/main/onto.ttl"},
    )
    assert r.status_code == 400
    assert "GitHub Enterprise" in r.json()["detail"]
    assert "upload" in r.json()["detail"]


def test_rejects_non_http_scheme():
    r = client.post("/api/ontologies/fetch", json={"url": "ftp://github.com/x.ttl"})
    assert r.status_code == 400


def test_github_enterprise_detection():
    assert is_github_enterprise_host("github.mycompany.com")
    assert is_github_enterprise_host("github.internal")
    assert is_github_enterprise_host("mygithub.corp.example")
    # Standard github.com family is allowed
    assert not is_github_enterprise_host("github.com")
    assert not is_github_enterprise_host("www.github.com")
    assert not is_github_enterprise_host("raw.githubusercontent.com")
    assert not is_github_enterprise_host("gist.githubusercontent.com")
    # GitHub Pages and user content are allowed
    assert not is_github_enterprise_host("example.github.io")
    # Arbitrary non-GitHub servers are allowed
    assert not is_github_enterprise_host("example.org")
    assert not is_github_enterprise_host("api.finto.fi")
    assert not is_github_enterprise_host("xmlns.com")


def test_blob_url_conversion():
    assert (
        to_raw_url("https://github.com/o/r/blob/main/dir/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/dir/f.ttl"
    )
    assert (
        to_raw_url("https://www.github.com/o/r/raw/main/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/f.ttl"
    )
    # Already-raw URLs and non-GitHub URLs pass through untouched
    assert (
        to_raw_url("https://raw.githubusercontent.com/o/r/main/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/f.ttl"
    )
    assert to_raw_url("https://example.org/data/onto.ttl") == "https://example.org/data/onto.ttl"


def test_upload_still_works():
    with EXAMPLE.open("rb") as f:
        r = client.post(
            "/api/ontologies/upload",
            files={"file": ("space-exploration.ttl", f, "text/turtle")},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["triples"] > 100
    assert body["format"] == "turtle"
