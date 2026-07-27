"""
================================================================================
FILE: backend/tests/test_network_restrictions.py
================================================================================

SUMMARY
    Proves the server will not fetch an address the user could not reach
    themselves. Covers SEC-1 to SEC-5 and MSG-1 of the
    network-and-resource-limits specification, which is backlog item S-1.

BASIC IDEA
    A status code is not proof. Every test here runs a real HTTP server on a
    loopback address that records every request it receives, points the
    application at it, and asserts two things: the request was refused, *and*
    the recorder saw zero requests. The second assertion is the test. An
    application that fetched the file and then discarded it would pass the
    first one.

    Because "zero requests" is only meaningful if the recorder would have
    recorded, one control test contacts it directly and asserts it counts. If
    that test ever fails, every other assertion in this file is vacuous.

    The redirect case (SEC-3) needs a public host that redirects to loopback,
    which cannot be arranged with real DNS in a test. It drives the download
    loop through an httpx MockTransport instead, with the resolver stubbed so
    the first hop looks public, and asserts the second hop was never requested
    of either the transport or the recorder.

INPUTS / INPUT SOURCES
    - A ThreadingHTTPServer bound to 127.0.0.1 on an ephemeral port.
    - The FastAPI app, driven in-process by TestClient.
    - A stubbed app.net_guard.resolve_host for the multi-address cases.

EXPECTED OUTPUT
    - Pass/fail per assertion. A failure means the server can be pointed at
      an internal address again.
================================================================================
"""

import ipaddress
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.net_guard import ALL_REFUSAL_MESSAGES, BlockedAddress
from app.routers.ontologies import _download_capped

client = TestClient(app)

TURTLE = b"""
@prefix : <http://example.org/secret#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Secret a rdfs:Class ; rdfs:label "Secret" .
"""


class _Recorder(BaseHTTPRequestHandler):
    """Serves a valid ontology and records that it was asked for one.

    Serving something valid matters: if this returned an error, a refusal could
    be mistaken for the fetch having failed on its own.
    """

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.server.requests.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "text/turtle")
        self.send_header("Content-Length", str(len(TURTLE)))
        self.end_headers()
        self.wfile.write(TURTLE)

    def log_message(self, *args):
        pass  # keep the pytest output readable


@pytest.fixture
def recorder():
    """A loopback HTTP server that counts every request it receives."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    server.requests = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def _url(server, host="127.0.0.1", path="/secret.ttl"):
    return f"http://{host}:{server.server_address[1]}{path}"


def test_recorder_is_genuinely_reachable(recorder):
    """Control. Without this, every "zero requests" assertion below is vacuous.

    If the loopback server were unreachable from this process -- a proxy
    variable being the classic cause -- a completely unprotected application
    would look protected.
    """
    response = httpx.get(_url(recorder), trust_env=False, timeout=10)
    assert response.status_code == 200
    assert b"Secret" in response.content
    assert len(recorder.requests) == 1


def test_loopback_is_refused_and_never_contacted(recorder):
    """SEC-1."""
    r = client.post("/api/ontologies/fetch", json={"url": _url(recorder)})
    assert r.status_code == 400
    assert recorder.requests == [], "the server made the request anyway"
    assert "Local file tab" in r.json()["detail"]


@pytest.mark.parametrize(
    "host",
    ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"],
    ids=["localhost", "loopback-ip", "loopback-8", "ipv6-loopback"],
)
def test_every_loopback_spelling_is_refused(recorder, host):
    """SEC-2, the loopback half."""
    r = client.post("/api/ontologies/fetch", json={"url": _url(recorder, host=host)})
    assert r.status_code == 400
    assert recorder.requests == []


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.1/onto.ttl",
        "http://192.168.1.1/onto.ttl",
        "http://172.16.0.1/onto.ttl",
        "http://169.254.169.254/latest/meta-data/",
        "http://[fd00::1]/onto.ttl",
        "http://[fe80::1]/onto.ttl",
    ],
    ids=["private-10", "private-192", "private-172", "metadata", "ipv6-ula", "ipv6-ll"],
)
def test_private_and_metadata_addresses_are_refused(url):
    """SEC-2, the private half. 169.254.169.254 is the one that returns keys."""
    r = client.post("/api/ontologies/fetch", json={"url": url})
    assert r.status_code == 400
    assert "Local file tab" in r.json()["detail"]


@pytest.mark.parametrize(
    "url",
    ["http://2130706433/onto.ttl", "http://[::ffff:127.0.0.1]/onto.ttl"],
    ids=["integer-form", "ipv4-mapped"],
)
def test_alternative_spellings_of_loopback_are_refused(url):
    """SEC-4. Both denote 127.0.0.1 while looking like something else."""
    r = client.post("/api/ontologies/fetch", json={"url": url})
    assert r.status_code == 400


def test_multi_address_host_is_refused(monkeypatch):
    """SEC-5 / AC-4: one blocked address among several blocks the URL."""
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [
            ipaddress.ip_address("93.184.216.34"),
            ipaddress.ip_address("127.0.0.1"),
        ],
    )
    r = client.post("/api/ontologies/fetch", json={"url": "https://split.example/onto.ttl"})
    assert r.status_code == 400
    assert "Local file tab" in r.json()["detail"]


@pytest.mark.anyio
async def test_redirect_to_loopback_is_not_followed(recorder, monkeypatch):
    """SEC-3 / AC-2. The case that breaks a check applied only to the first URL.

    The first hop is a public host, so the naive implementation passes its one
    check and then follows the redirect straight to loopback. Here the loop
    re-checks, so the recorder is never contacted and the message says the
    redirect was the problem.
    """
    blocked = _url(recorder)
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": blocked})

    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")]
        if host == "public.example"
        else [ipaddress.ip_address("127.0.0.1")],
    )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as http:
        with pytest.raises(BlockedAddress) as caught:
            await _download_capped(http, "https://public.example/onto.ttl")

    assert recorder.requests == [], "the redirect was followed to the loopback server"
    assert seen == ["https://public.example/onto.ttl"], "more than the first hop was requested"
    # The user pasted a legitimate URL; the message must say what really failed.
    assert "redirected" in str(caught.value)


@pytest.mark.anyio
async def test_redirect_chain_is_bounded(monkeypatch):
    """A redirect loop between public hosts ends rather than spinning."""
    hops: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        nxt = len(hops)
        return httpx.Response(302, headers={"location": f"https://public.example/hop{nxt}"})

    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")],
    )
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as http:
        with pytest.raises(Exception) as caught:
            await _download_capped(http, "https://public.example/start")
    assert "redirected more than" in str(getattr(caught.value, "detail", caught.value))
    # Six requests: the original plus MAX_REDIRECTS further hops.
    assert len(hops) == 6


def test_a_public_url_still_reaches_the_download_path(monkeypatch, recorder):
    """The guard must not refuse the thing the application exists to do.

    The address check passes for a public host; the fetch then fails at the
    connection, which proves the request got past the guard rather than being
    stopped by it.
    """
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")],
    )
    r = client.post(
        "/api/ontologies/fetch",
        json={"url": "https://public.example.invalid/onto.ttl"},
    )
    # 502 is a connection failure, which only happens after the guard allowed it.
    assert r.status_code == 502, r.json()
    assert "Local file tab" not in r.json().get("detail", "")


def test_scheme_and_github_enterprise_rules_are_unchanged():
    """REG-3 in this file's terms: the older rules still apply, with 400."""
    r = client.post("/api/ontologies/fetch", json={"url": "ftp://example.org/f.ttl"})
    assert r.status_code == 400
    r = client.post(
        "/api/ontologies/fetch",
        json={"url": "https://github.mycompany.com/t/r/blob/main/o.ttl"},
    )
    assert r.status_code == 400
    assert "GitHub Enterprise" in r.json()["detail"]


@pytest.mark.network
def test_a_real_public_ontology_still_loads():
    """REG-2 / AC-9. The guard must not break the application's main use.

    Skipped by default because it reaches the internet. Run it deliberately:

        pytest tests -m network

    FOAF is used because it is small, stable, and served from a plain host with
    no redirect chain worth depending on.
    """
    response = client.post(
        "/api/ontologies/fetch", json={"url": "http://xmlns.com/foaf/spec/index.rdf"}
    )
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["triples"] > 100
    client.delete(f"/api/ontologies/{body['id']}")


def test_refusal_messages_name_a_next_step_and_stay_calm():
    """MSG-1 across every message this specification adds."""
    forbidden = ("vulnerability", "attack", "forgery", "ssrf", "malicious", "exploit")
    for message in ALL_REFUSAL_MESSAGES:
        lowered = message.lower()
        assert not any(word in lowered for word in forbidden), message
    # A refusal a user actually sees, end to end, carries the way forward.
    r = client.post("/api/ontologies/fetch", json={"url": "http://127.0.0.1:9/f.ttl"})
    detail = r.json()["detail"]
    assert "Local file tab" in detail
    assert not any(word in detail.lower() for word in forbidden)
