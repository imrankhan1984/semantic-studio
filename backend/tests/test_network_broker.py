"""
================================================================================
FILE: backend/tests/test_network_broker.py
================================================================================

SUMMARY
    Proves the network broker (external-access Stage 1, backlog E-T1, decisions
    D-066 and D-067) lets nothing out without the user's approval, keeps the
    address rules above every grant, connects to the address it judged, and
    logs every attempt. Covers AC-6 to AC-15 and the decision-overhead budget.

BASIC IDEA
    Every security claim is proved with a recording server and asserted as a
    count of requests it received -- zero where the claim is "nothing was
    sent" -- never only as a status code. A 409 or 403 with a request already
    made would be a failure that looked like a pass.

    The servers are on loopback. The `loopback_is_public` fixture (conftest.py)
    lets the judgement treat exactly 127.0.0.1 as public and points test names
    at it; 127.0.0.2 stays refused and plays the private address. Each test
    starts online with no grants (an autouse fixture resets the broker).

    The rebinding test does not fake net_guard's resolver. It fakes
    socket.getaddrinfo itself, which is what any unpinned client would call
    again when connecting, so an implementation that resolved twice would
    really reach the private server and the test would fail.

INPUTS / INPUT SOURCES
    - The FastAPI app through TestClient, and the broker singleton directly.
    - Recording HTTP servers from conftest.py's `http_server` fixture.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import gc
import ipaddress
import json
import socket
import statistics
import time

import pytest
from fastapi.testclient import TestClient

from app import network_broker
from app.main import app
from app.network_broker import (
    OFFLINE_DETAIL,
    ApprovalRequired,
    HostBlocked,
    NetworkPolicy,
    Offline,
    broker,
)
from app.net_guard import BlockedAddress
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

LOCAL = ipaddress.ip_address("127.0.0.1")
CONTEXT = b'{"@context":{"name":"http://example.org/name"}}'
TURTLE = b"@prefix : <http://example.org/b#> . :A a <http://www.w3.org/2002/07/owl#Class> ."


def _context(_path):
    return 200, {"Content-Type": "application/ld+json"}, CONTEXT


def _turtle(_path):
    return 200, {"Content-Type": "text/turtle"}, TURTLE


def _doc(url: str) -> bytes:
    return f'{{"@context":"{url}","@id":"http://example.org/A","name":"x"}}'.encode()


def _upload(doc: bytes, grant_ids: tuple[str, ...] = ()):
    headers = {"X-Semantic-Studio-Grant": ",".join(grant_ids)} if grant_ids else {}
    return client.post(
        "/api/ontologies/upload",
        files={"file": ("doc.jsonld", doc, "application/ld+json")},
        headers=headers,
    )


def _grant(capability, host, decision="allow", remember=False) -> dict:
    r = client.post(
        "/api/network/grants",
        json={"capability": capability, "host": host, "decision": decision, "remember": remember},
    )
    assert r.status_code == 200, r.json()
    return r.json()


@pytest.fixture
def context_host(http_server, loopback_is_public):
    """A public-looking context host, `ctx.test`, served from loopback."""
    server = http_server(_context)
    loopback_is_public["ctx.test"] = [LOCAL]
    server.url = f"http://ctx.test:{server.server_address[1]}/ctx.jsonld"
    return server


# ---------------------------------------------------------------------------
# AC-6 -- no grant, no request
# ---------------------------------------------------------------------------


def test_upload_with_a_remote_context_asks_and_sends_nothing(context_host):
    """AC-6 and AC-14, first half: the 409 names everything the dialog needs."""
    r = _upload(_doc(context_host.url))
    assert r.status_code == 409, r.json()
    detail = r.json()["detail"]
    assert detail["code"] == "approval_required"
    [request] = detail["requests"]
    assert request["capability"] == "jsonld:context"
    assert request["host"] == "ctx.test"
    assert request["url"] == context_host.url
    assert request["reason"] and request["sends"]
    assert request["encrypted"] is False
    assert context_host.requests == [], "the context was fetched before approval"
    assert store.list() == [] or all(o.name != "doc.jsonld" for o in store.list())


@pytest.mark.parametrize("capability", sorted(network_broker.CAPABILITIES))
def test_every_capability_asks_for_a_new_host(capability, context_host):
    """AC-6 for all four capabilities, at the broker."""
    with pytest.raises(ApprovalRequired) as caught:
        broker.request(capability, context_host.url, reason="test", max_bytes=1024, timeout=5)
    assert caught.value.requests[0]["capability"] == capability
    assert context_host.requests == []


def test_no_name_is_looked_up_before_approval(monkeypatch, http_server):
    """A DNS query for a name in a file tells the name's owner the file was
    opened. The policy is asked first, so an unapproved name is never resolved."""
    from app import net_guard

    def explode(_host):
        raise AssertionError("resolved a name the user has not approved")

    monkeypatch.setattr(net_guard, "resolve_host", explode)
    with pytest.raises(ApprovalRequired):
        broker.request("jsonld:context", "https://beacon.test/c", reason="t", max_bytes=1, timeout=1)


# ---------------------------------------------------------------------------
# AC-7 -- just this time
# ---------------------------------------------------------------------------


def test_just_once_covers_the_retry_and_nothing_after(context_host):
    """AC-7. The id rides on the retry; the next separate action asks again."""
    doc = _doc(context_host.url)
    assert _upload(doc).status_code == 409
    grant = _grant("jsonld:context", "ctx.test", remember=False)
    assert grant["remember"] is False

    retried = _upload(doc, (grant["id"],))
    assert retried.status_code == 200, retried.json()
    assert context_host.requests == ["/ctx.jsonld"]

    # A separate action, without the id: asks again, sends nothing.
    assert _upload(doc).status_code == 409
    # The spent id is worth nothing now either.
    assert _upload(doc, (grant["id"],)).status_code == 409
    assert context_host.requests == ["/ctx.jsonld"]
    # Just-once grants are never listed as standing permissions.
    assert client.get("/api/network/policy").json()["grants"] == []
    client.delete(f"/api/ontologies/{retried.json()['id']}")


def test_a_just_once_grant_is_for_its_own_host_and_capability(context_host):
    grant = _grant("ontology:import", "ctx.test", remember=False)
    assert _upload(_doc(context_host.url), (grant["id"],)).status_code == 409
    other = _grant("jsonld:context", "elsewhere.test", remember=False)
    assert _upload(_doc(context_host.url), (other["id"],)).status_code == 409
    assert context_host.requests == []


# ---------------------------------------------------------------------------
# AC-8 -- always
# ---------------------------------------------------------------------------


def test_always_allow_is_remembered_per_capability(context_host):
    """AC-8."""
    _grant("jsonld:context", "ctx.test", remember=True)
    first = _upload(_doc(context_host.url))
    second = _upload(_doc(context_host.url))
    assert first.status_code == 200 and second.status_code == 200
    assert len(context_host.requests) == 2
    # A different capability to the same host still asks.
    with pytest.raises(ApprovalRequired):
        broker.request("ontology:import", context_host.url, reason="t", max_bytes=1024, timeout=5)
    assert len(context_host.requests) == 2
    for r in (first, second):
        client.delete(f"/api/ontologies/{r.json()['id']}")


def test_remembered_grants_survive_a_restart(tmp_path):
    policy = NetworkPolicy(tmp_path / "network-policy.json")
    policy.grant("jsonld:context", "Example.ORG.", "allow", remember=True)
    policy.set_offline(True)
    reloaded = NetworkPolicy(tmp_path / "network-policy.json")
    assert reloaded.decide("jsonld:context", "example.org", frozenset()) == "allow"
    assert reloaded.offline is True


def test_a_corrupt_policy_file_grants_nothing(tmp_path):
    path = tmp_path / "network-policy.json"
    path.write_text("{not json", encoding="utf-8")
    assert NetworkPolicy(path).decide("jsonld:context", "example.org", frozenset()) == "ask"


# ---------------------------------------------------------------------------
# AC-9 -- block and revoke
# ---------------------------------------------------------------------------


def test_block_refuses_without_asking_and_revoke_restores_ask(context_host):
    """AC-9."""
    grant = _grant("jsonld:context", "ctx.test", decision="block")
    assert grant["remember"] is True, "a Block is always remembered"
    r = _upload(_doc(context_host.url))
    assert r.status_code == 403
    assert "ctx.test" in r.json()["detail"]
    assert context_host.requests == []

    assert client.delete(f"/api/network/grants/{grant['id']}").status_code == 200
    assert _upload(_doc(context_host.url)).status_code == 409
    assert context_host.requests == []


def test_block_beats_a_just_once_allow(context_host):
    _grant("jsonld:context", "ctx.test", decision="block")
    once = _grant("jsonld:context", "ctx.test", remember=False)
    assert _upload(_doc(context_host.url), (once["id"],)).status_code == 403
    assert context_host.requests == []


# ---------------------------------------------------------------------------
# AC-10 -- offline
# ---------------------------------------------------------------------------


def test_offline_refuses_everything_and_sends_nothing(context_host, http_server):
    """AC-10, including the typed URL, and including a host already allowed."""
    typed = http_server(_turtle)
    _grant("jsonld:context", "ctx.test", remember=True)
    assert client.put("/api/network/offline", json={"offline": True}).json() == {"offline": True}

    upload = _upload(_doc(context_host.url))
    fetch = client.post(
        "/api/ontologies/fetch",
        json={"url": f"http://ctx.test:{typed.server_address[1]}/t.ttl"},
    )
    for r in (upload, fetch):
        assert r.status_code == 503
        assert r.json()["detail"] == OFFLINE_DETAIL
    for capability in network_broker.CAPABILITIES:
        with pytest.raises(Offline):
            broker.request(capability, context_host.url, reason="t", max_bytes=1, timeout=1)
    assert context_host.requests == [] and typed.requests == []
    assert client.get("/api/network/policy").json()["offline"] is True

    client.put("/api/network/offline", json={"offline": False})
    assert _upload(_doc(context_host.url)).status_code == 200


# ---------------------------------------------------------------------------
# AC-11 -- the address rules outrank every grant; redirects re-ask
# ---------------------------------------------------------------------------


def test_a_private_address_is_refused_even_when_allowed(http_server, loopback_is_public):
    """AC-11. The grant is for the name; the name resolves somewhere private."""
    private = http_server(_context, host="127.0.0.2")
    loopback_is_public["inside.test"] = [ipaddress.ip_address("127.0.0.2")]
    _grant("jsonld:context", "inside.test", remember=True)
    _grant("jsonld:context", "10.0.0.1", remember=True)
    url = f"http://inside.test:{private.server_address[1]}/ctx"
    for target in (url, "http://10.0.0.1/ctx"):
        with pytest.raises(BlockedAddress):
            broker.request("jsonld:context", target, reason="t", max_bytes=1024, timeout=5)
    assert private.requests == []


def test_a_redirect_to_another_host_asks_for_that_host(http_server, loopback_is_public):
    """AC-11, second sentence. An approved site cannot hand the request on."""
    other = http_server(_context)
    port = other.server_address[1]
    # One server plays both hosts; the Host header says which was asked for.
    first = http_server(lambda p: (302, {"Location": f"http://other.test:{port}/ctx"}, b""))
    loopback_is_public["first.test"] = [LOCAL]
    loopback_is_public["other.test"] = [LOCAL]
    _grant("jsonld:context", "first.test", remember=True)
    url = f"http://first.test:{first.server_address[1]}/start"

    with pytest.raises(ApprovalRequired) as caught:
        broker.request("jsonld:context", url, reason="Because.", max_bytes=1024, timeout=5)
    asked = caught.value.requests[0]
    assert asked["host"] == "other.test"
    assert "first.test redirected" in asked["reason"]
    assert other.requests == [], "the redirect target was contacted before approval"

    _grant("jsonld:context", "other.test", remember=True)
    response = broker.request("jsonld:context", url, reason="t", max_bytes=1024, timeout=5)
    assert response.body == CONTEXT
    assert other.hosts == [f"other.test:{port}"]


def test_a_typed_url_is_its_own_approval_but_its_redirect_is_not(http_server, loopback_is_public):
    """AC-15 with AC-11: the typed host needs no dialog, a new host does."""
    other = http_server(_turtle)
    typed = http_server(
        lambda p: (302, {"Location": f"http://other.test:{other.server_address[1]}/o.ttl"}, b"")
    )
    loopback_is_public["typed.test"] = [LOCAL]
    loopback_is_public["other.test"] = [LOCAL]
    r = client.post(
        "/api/ontologies/fetch",
        json={"url": f"http://typed.test:{typed.server_address[1]}/o.ttl"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["requests"][0]["host"] == "other.test"
    assert r.json()["detail"]["requests"][0]["capability"] == "ontology:fetch"
    assert typed.requests == ["/o.ttl"] and other.requests == []


# ---------------------------------------------------------------------------
# AC-12 -- pinning
# ---------------------------------------------------------------------------


def test_the_connection_goes_to_the_address_that_was_checked(http_server, monkeypatch, loopback_is_public):
    """AC-12, D-067. A resolver that answers public, then private.

    Faked at socket.getaddrinfo, below net_guard, so a client that resolved
    the name again to connect would get the private answer and reach the
    private server. The pinned broker resolves once.
    """
    public = http_server(_context)
    port = public.server_address[1]
    private = http_server(_context, host="127.0.0.2", port=port)
    answers = ["127.0.0.1", "127.0.0.2", "127.0.0.2", "127.0.0.2"]
    real = socket.getaddrinfo

    def rebinding(host, *args, **kwargs):
        if host == "rebind.test":
            ip = answers.pop(0) if len(answers) > 1 else answers[0]
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]
        return real(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", rebinding)
    _grant("jsonld:context", "rebind.test", remember=True)
    response = broker.request(
        "jsonld:context", f"http://rebind.test:{port}/ctx", reason="t", max_bytes=1024, timeout=5
    )
    assert response.body == CONTEXT
    assert private.requests == [], "the connection followed the second DNS answer"
    assert public.requests == ["/ctx"]
    # The real name still reached the server, for virtual hosting.
    assert public.hosts == [f"rebind.test:{port}"]


def test_an_https_connection_is_pinned_with_the_name_in_sni(monkeypatch):
    """The pinned https request carries the host for SNI and certificate checks."""
    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["host"] = request.headers["host"]
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, content=CONTEXT)

    from app import net_guard

    monkeypatch.setattr(broker, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(net_guard, "resolve_host", lambda h: [ipaddress.ip_address("93.184.216.34")])
    _grant("jsonld:context", "secure.test", remember=True)
    broker.request("jsonld:context", "https://secure.test/c.jsonld", reason="t", max_bytes=1024, timeout=5)
    assert seen == {
        "url": "https://93.184.216.34/c.jsonld",
        "host": "secure.test",
        "sni": "secure.test",
    }


# ---------------------------------------------------------------------------
# AC-13 / AC-15 -- the activity log
# ---------------------------------------------------------------------------


def test_every_attempt_is_logged_newest_first(context_host, http_server):
    """AC-13 and AC-15: time, capability, URL, outcome and bytes."""
    typed = http_server(_turtle)
    typed_url = f"http://ctx.test:{typed.server_address[1]}/t.ttl"
    fetched = client.post("/api/ontologies/fetch", json={"url": typed_url})
    assert fetched.status_code == 200
    _upload(_doc(context_host.url))  # asks

    entries = client.get("/api/network/activity").json()
    assert [e["outcome"] for e in entries[:2]] == ["asked", "ok"]
    ok = entries[1]
    assert ok["capability"] == "ontology:fetch"
    assert ok["url"] == typed_url
    assert ok["bytes"] == len(TURTLE)
    assert ok["status"] == 200
    assert ok["encrypted"] is False
    assert {"time", "capability", "url", "outcome", "bytes"} <= set(ok)
    client.delete(f"/api/ontologies/{fetched.json()['id']}")


def test_the_log_rotates_and_the_panel_reads_the_latest(monkeypatch, tmp_path):
    """AC-13: rotation at the size limit, and the latest N across the seam."""
    monkeypatch.setattr(network_broker, "ACTIVITY_ROTATE_BYTES", 2000)
    log = network_broker.ActivityLog(tmp_path / "network-activity.jsonl")
    for i in range(60):
        log.append({"n": i, "pad": "x" * 60})
    assert (tmp_path / "network-activity.jsonl.1").exists()
    assert (tmp_path / "network-activity.jsonl").stat().st_size < 2000 + 200
    # About 25 lines fit per file; one previous file is kept, so the newest
    # ~35 survive. Thirty crosses the seam between the two files.
    current = len((tmp_path / "network-activity.jsonl").read_text().splitlines())
    assert current < 30
    latest = log.latest(30)
    assert [e["n"] for e in latest] == list(range(59, 29, -1))


def test_the_activity_endpoint_caps_its_limit():
    assert client.get("/api/network/activity?limit=0").status_code == 422
    assert client.get("/api/network/activity?limit=100000").status_code == 422
    assert client.get("/api/network/activity?limit=200").status_code == 200


# ---------------------------------------------------------------------------
# AC-14 -- a JSON-LD context after approval, and after a restart
# ---------------------------------------------------------------------------


def test_an_approved_context_is_kept_so_a_restart_does_not_reconnect(context_host):
    """AC-14's second half, and the reason the context is stored.

    A just-once approval was for loading this file. Re-reading the stored file
    after a restart must neither connect again nor ask again.
    """
    grant = _grant("jsonld:context", "ctx.test")
    loaded = _upload(_doc(context_host.url), (grant["id"],))
    assert loaded.status_code == 200
    oid = loaded.json()["id"]
    assert loaded.json()["triples"] == 1
    assert context_host.requests == ["/ctx.jsonld"]

    # Simulate a restart: drop the parsed graph and every derived view.
    ontology = store.get(oid)
    ontology.graph = ontology.viz_cache = None
    graph = client.get(f"/api/ontologies/{oid}/graph")
    assert graph.status_code == 200, graph.json()
    assert context_host.requests == ["/ctx.jsonld"], "the restore reconnected"
    assert store.get(oid).graph is not None and len(store.get(oid).graph) == 1

    client.delete(f"/api/ontologies/{oid}")
    assert not ontology.data_path.with_suffix(".contexts.json").exists()


# ---------------------------------------------------------------------------
# The policy endpoints
# ---------------------------------------------------------------------------


def test_grant_validation():
    bad_capability = client.post(
        "/api/network/grants",
        json={"capability": "shell:exec", "host": "example.org", "decision": "allow"},
    )
    bad_host = client.post(
        "/api/network/grants",
        json={"capability": "jsonld:context", "host": "a b/c", "decision": "allow"},
    )
    bad_decision = client.post(
        "/api/network/grants",
        json={"capability": "jsonld:context", "host": "example.org", "decision": "maybe"},
    )
    assert [r.status_code for r in (bad_capability, bad_host, bad_decision)] == [422, 422, 422]
    assert client.delete("/api/network/grants/grant-nope").status_code == 404


def test_the_policy_lists_remembered_decisions():
    allow = _grant("jsonld:context", "Example.org", remember=True)
    block = _grant("ontology:fetch", "bad.example", decision="block")
    grants = client.get("/api/network/policy").json()["grants"]
    assert {(g["capability"], g["host"], g["decision"]) for g in grants} == {
        ("jsonld:context", "example.org", "allow"),
        ("ontology:fetch", "bad.example", "block"),
    }
    assert {g["id"] for g in grants} == {allow["id"], block["id"]}
    on_disk = json.loads((broker.data_dir / "network-policy.json").read_text(encoding="utf-8"))
    assert len(on_disk["grants"]) == 2


def test_a_later_decision_replaces_the_earlier_one():
    _grant("jsonld:context", "example.org", decision="block")
    _grant("jsonld:context", "example.org", remember=True)
    grants = client.get("/api/network/policy").json()["grants"]
    assert [g["decision"] for g in grants] == ["allow"]


# ---------------------------------------------------------------------------
# Performance: the policy lookup, with no network
# ---------------------------------------------------------------------------


@pytest.mark.perf
def test_decision_overhead():
    """Broker decision <= 1 ms. Median of five samples with the collector
    paused (D-024), each sample the mean of 1,000 decisions against a policy
    holding 200 remembered grants."""
    for i in range(200):
        broker.policy.grant("jsonld:context", f"host{i}.example", "allow", remember=True)
    samples = []
    gc_was_enabled = gc.isenabled()
    gc.disable()
    try:
        for _ in range(5):
            started = time.perf_counter()
            for i in range(1000):
                broker.decision_for("jsonld:context", f"host{i % 400}.example")
            samples.append((time.perf_counter() - started) * 1000 / 1000)
    finally:
        if gc_was_enabled:
            gc.enable()
    median_ms = statistics.median(samples)
    assert median_ms <= limit_ms(1.0), f"{median_ms:.4f} ms per decision"


def test_policy_decisions_are_typed_exceptions():
    """The three refusals are NetworkDecision, which the parser must not swallow."""
    for exc in (Offline(), HostBlocked("h"), ApprovalRequired([{"host": "h"}])):
        assert isinstance(exc, network_broker.NetworkDecision)
