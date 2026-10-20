"""
================================================================================
FILE: backend/tests/test_load_cancel.py
================================================================================

SUMMARY
    Proves the server stays responsive while a file loads (load-progress 5.1,
    AC-1).

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

INPUTS / INPUT SOURCES
    - The router modules' source, read with `ast`.
    - The FastAPI app under one TestClient (one portal, one event loop).

EXPECTED OUTPUT
    - Pass/fail. A failure means a load can freeze every other request again.
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
