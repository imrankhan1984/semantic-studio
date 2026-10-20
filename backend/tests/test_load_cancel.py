"""
================================================================================
FILE: backend/tests/test_load_cancel.py
================================================================================

SUMMARY
    Proves the server stays responsive while a file loads (load-progress 5.1,
    AC-1), and that a cancelled load leaves nothing behind (5.3, AC-3, AC-4).

BASIC IDEA
    The upload and fetch routes are `async`, so anything they call directly
    runs on the server's one event loop. A 35 MB file measured 47 s of a
    frozen server before 5.1. Two tests hold that shut:

      * A scan of `routers/` reads every `async` route's own body (not the
        functions it hands to the threadpool) for a direct call to
        `store.add` or `parse_rdf`.
      * An upload is held inside its parse by an Event, and the library list
        is asked for meanwhile, from another thread, through the same client
        and so the same event loop. It must be answered while the parse is
        still held. An Event, never a sleep: the test knows the parse has
        started, and the parse goes on only when the test says so.

    Cancel is tested the same way: a load is held at one step (the download,
    the parse, the summary), cancelled, released, and the data folder and the
    library compared with before. Each hold sits at a different check in
    `store.add`, so removing any one check turns one test red: a cancel in
    the download must never reach the parse, one in the parse never the
    summary, and one in the summary never a write.

INPUTS / INPUT SOURCES
    - The router modules' source, read with `ast`.
    - The FastAPI app under one TestClient (one portal, one event loop).
    - httpx.MockTransport as the broker's transport, for the held download.

EXPECTED OUTPUT
    - Pass/fail. A failure means a load can freeze every other request
      again, or a cancelled load can still reach the library.
================================================================================
"""

from __future__ import annotations

import ast
import io
import threading
from pathlib import Path

from fastapi.testclient import TestClient

from app import store as store_mod
from app.main import app

ROUTERS = Path(__file__).resolve().parents[1] / "app" / "routers"
HEADERS = {"X-Semantic-Studio": "1"}
TURTLE = b"@prefix ex: <http://example.org/> .\nex:a ex:p ex:b .\n"
# Long enough for a correct server never to come near it, short enough that
# a frozen one fails the test rather than hanging the suite.
WAIT_S = 10


def _direct_calls(fn: ast.AsyncFunctionDef) -> list[str]:
    """`store.add` / `parse_rdf` called in the route's own body.

    A nested def or lambda is skipped: that is work handed elsewhere (the
    threadpool), and passing `store.add` itself as an argument is not a call.
    """
    found: list[str] = []

    def visit(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                func = child.func
                if isinstance(func, ast.Attribute) and func.attr == "add" and (
                    isinstance(func.value, ast.Name) and func.value.id == "store"
                ):
                    found.append(f"store.add (line {child.lineno})")
                name = func.id if isinstance(func, ast.Name) else (
                    func.attr if isinstance(func, ast.Attribute) else None
                )
                if name in ("parse_rdf", "_parse_rdf_blocking"):
                    found.append(f"{name} (line {child.lineno})")
            visit(child)

    visit(fn)
    return found


def _is_route(fn: ast.AsyncFunctionDef) -> bool:
    return any(
        isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
        and isinstance(d.func.value, ast.Name) and d.func.value.id in ("router", "app")
        for d in fn.decorator_list
    )


def test_no_async_route_parses_on_the_event_loop():
    files = sorted(ROUTERS.glob("*.py"))
    # Assert the scan read something before asserting it found nothing.
    assert any(p.name == "ontologies.py" for p in files)
    routes = 0
    offenders = []
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.AsyncFunctionDef) and _is_route(node):
                routes += 1
                offenders += [f"{path.name}:{node.name}: {c}" for c in _direct_calls(node)]
    assert routes >= 2, "the scan found no async routes"
    assert offenders == [], offenders


def test_the_scan_sees_a_direct_call():
    """The scan's own check: a route calling store.add directly is caught."""
    source = (
        "@router.post('/x')\n"
        "async def x():\n"
        "    def work():\n"
        "        return store.add(1)\n"
        "    await run_in_threadpool(store.add, 1)\n"
        "    return store.add(2)\n"
    )
    fn = ast.parse(source).body[0]
    assert _direct_calls(fn) == ["store.add (line 6)"]


def test_library_list_is_answered_while_an_upload_is_parsed(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    real = store_mod._parse_rdf_blocking

    def held(data, fmt):
        # Only this test's file: entering the client seeds the examples.
        if data == TURTLE:
            entered.set()
            release.wait(WAIT_S * 3)
        return real(data, fmt)

    monkeypatch.setattr(store_mod, "_parse_rdf_blocking", held)
    # One client entered as a context: one portal, so one event loop for
    # both requests, as a running server has.
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
        upload: dict = {}

        def send_upload():
            upload["response"] = client.post(
                "/api/ontologies/upload",
                files={"file": ("held.ttl", io.BytesIO(TURTLE), "text/turtle")},
            )

        listing: dict = {}

        def ask_list():
            listing["response"] = client.get("/api/ontologies")

        uploader = threading.Thread(target=send_upload)
        uploader.start()
        try:
            assert entered.wait(WAIT_S), "the upload never reached its parse"
            asker = threading.Thread(target=ask_list)
            asker.start()
            asker.join(WAIT_S)
            answered_while_held = not asker.is_alive()
        finally:
            release.set()
            uploader.join(WAIT_S * 3)
        assert answered_while_held, "the library list waited for the parse"
        assert listing["response"].status_code == 200
        assert upload["response"].status_code == 200
        client.delete(f"/api/ontologies/{upload['response'].json()['id']}")


# ---------------------------------------------------------------------------
# 5.3 -- Cancel (AC-3, AC-4)
# ---------------------------------------------------------------------------

import ipaddress  # noqa: E402
import uuid  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402

from app.loads import LoadCancelled, RunningLoads, running_loads  # noqa: E402
from app.network_broker import broker  # noqa: E402
from app.store import store  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as c:
        yield c


def _files():
    return sorted(p.name for p in store.onto_dir.iterdir())


def _library(client):
    return sorted(o["id"] for o in client.get("/api/ontologies").json())


class Hold:
    """Holds a call on this test's input until released; counts every call."""

    def __init__(self, real, match):
        self.real, self.match = real, match
        self.entered, self.release = threading.Event(), threading.Event()
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.match(*args):
            self.entered.set()
            self.release.wait(WAIT_S * 3)
        return self.real(*args, **kwargs)


def _in_thread(fn):
    out: dict = {}
    thread = threading.Thread(target=lambda: out.setdefault("r", fn()))
    thread.start()
    return thread, out


def _upload(client, load_id, body=TURTLE, name="cancel.ttl"):
    return client.post(
        "/api/ontologies/upload",
        files={"file": (name, io.BytesIO(body), "text/turtle")},
        data={"loadId": load_id},
    )


def _held_parse(monkeypatch):
    hold = Hold(store_mod._parse_rdf_blocking, lambda data, fmt: data == TURTLE)
    monkeypatch.setattr(store_mod, "_parse_rdf_blocking", hold)
    return hold


def _held_summary(monkeypatch):
    # The test's file is the only one-statement graph these tests load.
    hold = Hold(store_mod.build_viz_graph, lambda graph: len(graph) == 1)
    monkeypatch.setattr(store_mod, "build_viz_graph", hold)
    return hold


def _cancel_while_held(client, hold, send, load_id):
    thread, out = _in_thread(send)
    try:
        assert hold.entered.wait(WAIT_S), "the load never reached the held step"
        stop = client.post(f"/api/ontologies/loads/{load_id}/cancel")
    finally:
        hold.release.set()
        thread.join(WAIT_S * 3)
    return stop, out["r"]


def test_a_cancel_during_the_parse_stops_the_load_and_writes_nothing(client, monkeypatch):
    hold = _held_parse(monkeypatch)
    summary = Hold(store_mod.build_viz_graph, lambda graph: False)
    monkeypatch.setattr(store_mod, "build_viz_graph", summary)
    files, library = _files(), _library(client)
    load_id = str(uuid.uuid4())
    stop, loaded = _cancel_while_held(client, hold, lambda: _upload(client, load_id), load_id)
    assert stop.status_code == 200 and stop.json() == {"stopped": True}
    assert loaded.status_code == 409
    assert loaded.json()["detail"]["code"] == "load_cancelled"
    # The check after the parse caught it: no summary was even built.
    assert summary.calls == 0
    assert _files() == files
    assert _library(client) == library
    assert len(running_loads) == 0


def test_a_cancel_during_the_summary_writes_nothing(client, monkeypatch):
    """The last check, after the summary, is the one that stops this."""
    hold = _held_summary(monkeypatch)
    files, library = _files(), _library(client)
    load_id = str(uuid.uuid4())
    stop, loaded = _cancel_while_held(client, hold, lambda: _upload(client, load_id), load_id)
    assert stop.json() == {"stopped": True}
    assert loaded.status_code == 409
    assert _files() == files
    assert _library(client) == library


def test_a_cancel_during_a_download_stops_before_the_parse(client, monkeypatch):
    monkeypatch.setattr(
        "app.net_guard.resolve_host", lambda host: [ipaddress.ip_address("93.184.216.34")]
    )
    download = Hold(lambda request: httpx.Response(200, content=TURTLE), lambda request: True)
    monkeypatch.setattr(broker, "transport", httpx.MockTransport(download))
    parse = Hold(store_mod._parse_rdf_blocking, lambda data, fmt: False)
    monkeypatch.setattr(store_mod, "_parse_rdf_blocking", parse)
    files, library = _files(), _library(client)
    load_id = str(uuid.uuid4())

    def send():
        return client.post(
            "/api/ontologies/fetch",
            json={"url": "https://public.example/held.ttl", "loadId": load_id},
        )

    stop, loaded = _cancel_while_held(client, download, send, load_id)
    assert stop.json() == {"stopped": True}
    assert loaded.status_code == 409
    assert parse.calls == 0, "the file was parsed after its load was cancelled"
    assert _files() == files
    assert _library(client) == library
    assert len(running_loads) == 0


def test_a_cancel_after_the_load_ended_stops_nothing(client):
    load_id = str(uuid.uuid4())
    loaded = _upload(client, load_id)
    assert loaded.status_code == 200
    oid = loaded.json()["id"]
    stop = client.post(f"/api/ontologies/loads/{load_id}/cancel")
    assert stop.json() == {"stopped": False}
    assert oid in _library(client)
    client.delete(f"/api/ontologies/{oid}")


def test_an_unknown_id_stops_nothing_and_a_non_uuid_is_refused(client):
    stop = client.post(f"/api/ontologies/loads/{uuid.uuid4()}/cancel")
    assert stop.status_code == 200 and stop.json() == {"stopped": False}
    assert client.post("/api/ontologies/loads/not-a-uuid/cancel").status_code == 422
    assert _upload(client, "not-a-uuid").status_code == 422
    fetched = client.post(
        "/api/ontologies/fetch", json={"url": "https://public.example/x.ttl", "loadId": "x"}
    )
    assert fetched.status_code == 422
    assert len(running_loads) == 0


def test_the_cancel_route_needs_the_client_header():
    with TestClient(app, base_url="http://localhost") as bare:
        r = bare.post(f"/api/ontologies/loads/{uuid.uuid4()}/cancel")
    assert r.status_code == 403


def test_a_load_without_an_id_loads_as_before(client):
    r = client.post(
        "/api/ontologies/upload",
        files={"file": ("plain.ttl", io.BytesIO(TURTLE), "text/turtle")},
    )
    assert r.status_code == 200
    assert len(running_loads) == 0
    client.delete(f"/api/ontologies/{r.json()['id']}")


def test_the_table_is_empty_after_a_success(client):
    ok = _upload(client, str(uuid.uuid4()))
    assert ok.status_code == 200 and len(running_loads) == 0
    client.delete(f"/api/ontologies/{ok.json()['id']}")


def test_the_table_is_empty_after_a_failure(client):
    bad = _upload(client, str(uuid.uuid4()), body=b"<<< not rdf", name="bad.ttl")
    assert bad.status_code == 422 and len(running_loads) == 0


def test_the_table_is_empty_after_a_timeout(client, monkeypatch):
    # A real file against a limit no parse meets, as test_upload_limits.py
    # does: parse_rdf's pool waits for its worker on the way out, so a held
    # parse would hold the request too.
    body = b"".join(
        f'<http://example.org/s{i}> <http://example.org/p> "{i}" .\n'.encode()
        for i in range(20_000)
    )
    monkeypatch.setattr("app.routers.ontologies.PARSE_TIMEOUT_SECONDS", 0.001)
    late = _upload(client, str(uuid.uuid4()), body=body, name="slow.nt")
    assert late.status_code == 504 and len(running_loads) == 0


def test_the_table_holds_a_load_only_while_it_runs(client, monkeypatch):
    hold = _held_summary(monkeypatch)
    load_id = str(uuid.uuid4())
    thread, out = _in_thread(lambda: _upload(client, load_id))
    try:
        assert hold.entered.wait(WAIT_S)
        assert len(running_loads) == 1
        client.post(f"/api/ontologies/loads/{load_id}/cancel")
    finally:
        hold.release.set()
        thread.join(WAIT_S * 3)
    assert out["r"].status_code == 409 and len(running_loads) == 0


def test_a_committed_load_cannot_be_cancelled():
    """The last check and a cancel take one lock: exactly one wins."""
    loads = RunningLoads()
    with loads.running("a") as mark:
        mark.commit()
        assert loads.cancel("a") is False
    with loads.running("b") as mark:
        assert loads.cancel("b") is True
        with pytest.raises(LoadCancelled):
            mark.commit()
    assert len(loads) == 0


def test_a_second_load_under_a_running_id_is_refused(client, monkeypatch):
    hold = _held_parse(monkeypatch)
    load_id = str(uuid.uuid4())
    thread, out = _in_thread(lambda: _upload(client, load_id))
    try:
        assert hold.entered.wait(WAIT_S)
        again = _upload(client, load_id, body=TURTLE + b"\n", name="again.ttl")
    finally:
        hold.release.set()
        thread.join(WAIT_S * 3)
    assert again.status_code == 409
    assert out["r"].status_code == 200
    client.delete(f"/api/ontologies/{out['r'].json()['id']}")
