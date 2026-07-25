from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.routers.ontologies import to_raw_url

EXAMPLE = Path(__file__).parent.parent.parent / "examples" / "space-exploration.ttl"

client = TestClient(app)


def test_rejects_arbitrary_web_server():
    r = client.post("/api/ontologies/fetch", json={"url": "https://example.org/onto.ttl"})
    assert r.status_code == 400
    assert "github.com" in r.json()["detail"]


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


def test_accepts_github_com_hosts_only():
    # No network call is made for the rejection path, so a bad-but-allowed URL
    # must get past validation and fail later (502/422), never with 400.
    r = client.post(
        "/api/ontologies/fetch",
        json={"url": "https://raw.githubusercontent.com/this-user/does-not-exist/main/x.ttl"},
    )
    assert r.status_code != 400


def test_blob_url_conversion():
    assert (
        to_raw_url("https://github.com/o/r/blob/main/dir/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/dir/f.ttl"
    )
    assert (
        to_raw_url("https://www.github.com/o/r/raw/main/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/f.ttl"
    )
    # Already-raw URLs pass through untouched
    assert (
        to_raw_url("https://raw.githubusercontent.com/o/r/main/f.ttl")
        == "https://raw.githubusercontent.com/o/r/main/f.ttl"
    )


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
