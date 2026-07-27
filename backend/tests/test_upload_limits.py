"""
================================================================================
FILE: backend/tests/test_upload_limits.py
================================================================================

SUMMARY
    Proves the server does only the work it was asked for: an oversized upload
    or download is refused while it is being read rather than after, and a parse
    that runs too long releases the request instead of hanging it. Covers SEC-9
    to SEC-11 and PERF-1 to PERF-3, which is backlog item S-3.

BASIC IDEA
    The distinction the whole item turns on is *when* the limit applies. A check
    after `await file.read()` reports a number once the body is already in
    memory, which is the defect. So the tests here do not merely assert 413:

      * PERF-3 sends a real 30 MB body against a 1 MB limit and measures peak
        allocation with tracemalloc. Measured with the check inside the handler
        it peaked at 124 MB, because FastAPI parses the whole multipart body
        before the endpoint is entered; with the middleware refusing on
        Content-Length first it peaks at about 5 MB. A lying header would have
        proved nothing about memory, so the body genuinely exists.
      * SEC-10 counts how many chunks the download actually pulled from the
        transport, which is what "aborted mid-stream" means in practice.
      * SEC-11 asserts /api/health still answers after a timeout, because a
        timeout that wedged the process would be no improvement.

    Large fixtures are generated in the test, never committed. N-Triples is used
    for the bulk data because one triple is one line, so size is predictable.

INPUTS / INPUT SOURCES
    - N-Triples generated in-process, in example.org namespaces.
    - The FastAPI app driven by TestClient, with the module-level caps
      monkeypatched down so the tests stay fast.
    - httpx.MockTransport for the streamed-download cases.

EXPECTED OUTPUT
    - Pass/fail per assertion. A failure means a body can reach memory
      unbounded again, or a parse can hang a request.
================================================================================
"""

import asyncio
import io
import ipaddress
import time
import tracemalloc

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile

from app.main import app
from app.routers.ontologies import _download_capped, _read_capped
from app.store import ParseTimeout, parse_rdf

client = TestClient(app)


def make_ntriples(count: int) -> bytes:
    """`count` valid N-Triples lines. One triple per line keeps size predictable."""
    return b"".join(
        f"<http://example.org/s{i}> <http://example.org/p> "
        f'"label {i}" .\n'.encode()
        for i in range(count)
    )


def upload(payload: bytes, name: str = "big.nt"):
    return client.post(
        "/api/ontologies/upload",
        files={"file": (name, io.BytesIO(payload), "application/n-triples")},
    )


# ---------------------------------------------------------------------------
# SEC-9 — upload size
# ---------------------------------------------------------------------------


def test_upload_over_the_limit_is_refused(monkeypatch):
    """SEC-9 / AC-7."""
    monkeypatch.setattr("app.routers.ontologies.MAX_UPLOAD_BYTES", 64 * 1024)
    response = upload(make_ntriples(5_000))
    assert response.status_code == 413
    detail = response.json()["detail"]
    # The message names the limit and how to change it.
    assert "MB limit" in detail
    assert "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES" in detail


def test_upload_just_under_the_limit_still_works(monkeypatch):
    """The cap must not refuse ordinary files. A limit nobody can use is a bug."""
    payload = make_ntriples(200)
    monkeypatch.setattr("app.routers.ontologies.MAX_UPLOAD_BYTES", len(payload) + 1024)
    response = upload(payload, name="small.nt")
    assert response.status_code == 200, response.json()
    assert response.json()["triples"] == 200


def test_empty_upload_is_still_refused():
    """Unchanged behaviour, kept honest: empty is a 400, not a 413."""
    response = upload(b"", name="empty.ttl")
    assert response.status_code == 400
    assert "empty" in response.json()["detail"].lower()


def test_read_capped_stops_reading_at_the_limit():
    """The mechanism, at the function: it stops rather than reading on.

    The counter proves the read was abandoned. A version that read the whole
    body and then measured it would consume every chunk and still return 413.
    """
    payload = make_ntriples(50_000)
    consumed = {"bytes": 0}

    class CountingBytesIO(io.BytesIO):
        def read(self, size=-1):
            chunk = super().read(size)
            consumed["bytes"] += len(chunk)
            return chunk

    upload_file = UploadFile(
        file=CountingBytesIO(payload),
        filename="big.nt",
        headers=Headers({"content-type": "application/n-triples"}),
    )
    limit = 64 * 1024
    with pytest.raises(Exception) as caught:
        asyncio.run(_read_capped(upload_file, limit, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"))
    assert getattr(caught.value, "status_code", None) == 413
    # Read no more than the limit plus the chunk that crossed it.
    assert consumed["bytes"] <= limit + 64 * 1024
    assert consumed["bytes"] < len(payload), "the whole body was read anyway"


# ---------------------------------------------------------------------------
# PERF-3 — the one that matters: memory during a rejected oversized upload
# ---------------------------------------------------------------------------


def test_declared_oversize_is_refused_before_the_body_is_parsed():
    """AC-11 / PERF-3, the mechanism.

    The refusal has to happen in middleware. FastAPI resolves
    `UploadFile = File(...)` by parsing the entire multipart body before the
    endpoint function is entered, so a Content-Length check written inside the
    handler runs too late to prevent anything. Measured before the middleware
    existed: rejecting a 30 MB upload against a 1 MB limit peaked at 124 MB.
    """
    response = client.post(
        "/api/ontologies/upload",
        files={"file": ("huge.nt", io.BytesIO(b"x" * 1024), "application/n-triples")},
        headers={"content-length": str(200 * 1024 * 1024)},
    )
    assert response.status_code == 413
    assert "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES" in response.json()["detail"]


def test_peak_memory_stays_small_while_rejecting_a_real_oversized_upload(monkeypatch):
    """AC-11 / PERF-3, the measurement, with a body that genuinely exists.

    A lying Content-Length header would prove nothing about memory. This sends
    a real 30 MB body against a 1 MB limit and measures peak allocation across
    the request. The client's own copy of the payload is built and measured
    before the window opens so what is left is the server's behaviour.
    """
    monkeypatch.setattr("app.routers.ontologies.MAX_UPLOAD_BYTES", 1024 * 1024)
    payload = b"x" * (30 * 1024 * 1024)
    body = io.BytesIO(payload)

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        response = client.post(
            "/api/ontologies/upload",
            files={"file": ("huge.nt", body, "application/n-triples")},
        )
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert response.status_code == 413
    peak_mb = peak / (1024 * 1024)
    assert peak_mb < 10, f"peak was {peak_mb:.2f} MB while rejecting a 30 MB upload"


# ---------------------------------------------------------------------------
# SEC-10 — fetch size, enforced while streaming
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_download_aborts_mid_stream_when_the_body_is_too_large(monkeypatch):
    """SEC-10 / AC-7. The abort is counted, not assumed.

    The transport hands out 4 MB in 64 KB chunks. With the cap at 256 KB the
    loop must stop after a handful, not drain the response and measure it.
    """
    monkeypatch.setattr("app.routers.ontologies.MAX_FETCH_BYTES", 256 * 1024)
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")],
    )
    served = {"chunks": 0}
    total_chunks = 64

    async def stream():
        for _ in range(total_chunks):
            served["chunks"] += 1
            yield b"y" * (64 * 1024)

    def handler(request: httpx.Request) -> httpx.Response:
        # No content-length: force the streaming path rather than the header gate.
        return httpx.Response(200, content=stream())

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as http:
        with pytest.raises(Exception) as caught:
            await _download_capped(http, "https://public.example/big.nt")
    assert getattr(caught.value, "status_code", None) == 413
    assert served["chunks"] < total_chunks, "the whole body was streamed anyway"
    assert served["chunks"] <= 8, f"pulled {served['chunks']} chunks for a 4-chunk cap"


@pytest.mark.anyio
async def test_declared_oversize_download_is_refused_before_streaming(monkeypatch):
    """A Content-Length over the cap means there is no point starting."""
    monkeypatch.setattr("app.routers.ontologies.MAX_FETCH_BYTES", 256 * 1024)
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")],
    )
    pulled = {"chunks": 0}

    async def stream():
        pulled["chunks"] += 1
        yield b"z" * 1024

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-length": str(200 * 1024 * 1024)}, content=stream()
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as http:
        with pytest.raises(Exception) as caught:
            await _download_capped(http, "https://public.example/big.nt")
    assert getattr(caught.value, "status_code", None) == 413
    assert pulled["chunks"] == 0, "the body was streamed despite a declared oversize"


# ---------------------------------------------------------------------------
# SEC-11 — parse timeout
# ---------------------------------------------------------------------------


def test_parse_timeout_raises_rather_than_hanging():
    """The store-level mechanism, with a timeout too small to ever be met."""
    with pytest.raises(ParseTimeout) as caught:
        parse_rdf(make_ntriples(20_000), "nt", timeout=0.001)
    message = str(caught.value)
    assert "SEMANTIC_STUDIO_PARSE_TIMEOUT" in message
    assert "seconds to parse" in message


def test_upload_timeout_returns_504_and_the_server_keeps_serving(monkeypatch):
    """SEC-11 / AC-8. The second assertion is why the timeout is worth having."""
    monkeypatch.setattr("app.routers.ontologies.PARSE_TIMEOUT_SECONDS", 0.001)
    response = upload(make_ntriples(20_000), name="slow.nt")
    assert response.status_code == 504
    detail = response.json()["detail"]
    assert "SEMANTIC_STUDIO_PARSE_TIMEOUT" in detail
    # A timeout that wedged the process would be no improvement on hanging.
    assert client.get("/api/health").status_code == 200
    # And a normal upload still works immediately afterwards.
    monkeypatch.setattr("app.routers.ontologies.PARSE_TIMEOUT_SECONDS", 60.0)
    assert upload(make_ntriples(50), name="fine.nt").status_code == 200


def test_a_timed_out_upload_leaves_nothing_in_the_library(monkeypatch):
    """Nothing is persisted until the parse succeeds, so a refusal leaves no trace."""
    before = len(client.get("/api/ontologies").json())
    monkeypatch.setattr("app.routers.ontologies.PARSE_TIMEOUT_SECONDS", 0.001)
    assert upload(make_ntriples(20_000), name="ghost.nt").status_code == 504
    assert len(client.get("/api/ontologies").json()) == before


# ---------------------------------------------------------------------------
# PERF-1 and PERF-2 — the added work must not be felt
# ---------------------------------------------------------------------------


def test_address_check_adds_under_50ms(monkeypatch):
    """PERF-1 / AC-10.

    The work added to a successful fetch is one resolution plus the judgement.
    The resolver is stubbed so this measures the code rather than the network,
    which is the part this specification is responsible for.
    """
    import ipaddress

    from app.net_guard import assert_url_fetchable

    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [ipaddress.ip_address("93.184.216.34")],
    )
    started = time.perf_counter()
    for _ in range(100):
        assert_url_fetchable("https://example.org/onto.ttl")
    per_call_ms = (time.perf_counter() - started) * 1000 / 100
    assert per_call_ms < 50, f"{per_call_ms:.3f} ms per check"


def test_chunked_read_is_not_materially_slower_than_one_read():
    """PERF-2 / AC-10, for a 5 MB body."""
    payload = make_ntriples(100_000)
    assert len(payload) > 4 * 1024 * 1024, "fixture should be about 5 MB"

    def timed(fn):
        started = time.perf_counter()
        fn()
        return (time.perf_counter() - started) * 1000

    def one_read():
        f = UploadFile(file=io.BytesIO(payload), filename="x.nt")
        asyncio.run(f.read())

    def chunked():
        f = UploadFile(file=io.BytesIO(payload), filename="x.nt")
        asyncio.run(_read_capped(f, len(payload) + 1, "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"))

    overhead = timed(chunked) - timed(one_read)
    assert overhead < 100, f"chunked read cost {overhead:.1f} ms more for 5 MB"
