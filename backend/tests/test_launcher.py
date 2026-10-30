"""
================================================================================
FILE: backend/tests/test_launcher.py
================================================================================

SUMMARY
    The Windows release's launcher (release-packaging 5.2, Section 11): the
    port it picks, a Semantic Studio already running found and reused,
    another program on the port not mistaken for it, uvicorn handed
    127.0.0.1 and never 0.0.0.0, STATIC_DIR beside `app`, the console's
    three sentences with the real data folder, and AC-9: its requests to its
    own server never reach a proxy.

BASIC IDEA
    The launcher is driven through `choose` and `main` with ports the
    operating system has just handed out, never 8000 itself, so a developer's
    running copy cannot change a result. A port is "taken" by a real
    listening socket, "Semantic Studio" by a small server whose
    /api/health answers as the application does, and "another program" by
    one that answers health in someone else's words. uvicorn's `Server.run`
    is replaced by a recorder, so what the server would be asked for is read
    without starting it.

    AC-9 is proved the way the network tests prove a refusal: a recording
    proxy, named by HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and a patched
    getproxies(), with NO_PROXY emptied so nothing exempts 127.0.0.1, must
    see zero requests while the launcher still finds its server. A urllib
    request in the launcher's place sends the proxy one.

INPUTS / INPUT SOURCES
    - app.launcher, app.store.

EXPECTED OUTPUT
    - Pass/fail per test.
================================================================================
"""

from __future__ import annotations

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import uvicorn

from app import launcher
from app.store import default_data_dir

APP_DIR = Path(launcher.__file__).resolve().parent
# Kept before the `recorded` fixture replaces it.
real_announce = launcher._announce


class _Answer(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.server.requests.append(self.path)
        body = json.dumps(self.server.health).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def serve():
    """serve(health) -> a server on 127.0.0.1 answering every GET with it."""
    started = []

    def start(health) -> ThreadingHTTPServer:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Answer)
        server.health, server.requests = health, []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        return server

    yield start
    for server in started:
        server.shutdown()
        server.server_close()


def free_ports(count: int) -> list[int]:
    socks = [socket.socket() for _ in range(count)]
    try:
        for sock in socks:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in socks]
    finally:
        for sock in socks:
            sock.close()


@pytest.fixture
def taken(monkeypatch):
    """taken() -> a port something is listening on that answers no HTTP.

    It accepts and never answers, so each probe waits its whole timeout."""
    monkeypatch.setattr(launcher, "PROBE_TIMEOUT_S", 0.3)
    held = []

    def take() -> int:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        held.append(sock)
        return sock.getsockname()[1]

    yield take
    for sock in held:
        sock.close()


@pytest.fixture
def recorded(monkeypatch):
    """uvicorn's run and the announcer replaced by recorders."""
    calls: dict = {}

    def run(self, sockets=None):
        calls["config"] = self.config
        calls["sockets"] = sockets
        calls["address"] = sockets[0].getsockname()

    monkeypatch.setattr(uvicorn.Server, "run", run)
    monkeypatch.setattr(launcher, "_announce", lambda *a: calls.setdefault("announce", a))
    monkeypatch.setattr(launcher.webbrowser, "open", lambda u: calls.setdefault("opened", u))
    # main() writes STATIC_DIR; monkeypatch puts back what was there.
    monkeypatch.setenv("STATIC_DIR", "before")
    return calls


def test_a_free_first_port_is_taken():
    first, second = free_ports(2)
    state, port, sock = launcher.choose([first, second])
    try:
        assert (state, port) == ("free", first)
        assert sock.getsockname() == ("127.0.0.1", first)
    finally:
        sock.close()


def test_8000_taken_gives_8001(taken):
    busy = taken()
    (nxt,) = free_ports(1)
    state, port, sock = launcher.choose([busy, nxt])
    try:
        assert (state, port) == ("free", nxt)
    finally:
        sock.close()


def test_the_ports_the_spec_names():
    assert list(launcher.PORTS) == list(range(8000, 8020))


def test_every_port_taken_says_so_and_waits(taken, recorded, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "PORTS", [taken(), taken(), taken()])
    waited = []
    monkeypatch.setattr("builtins.input", lambda prompt="": waited.append(prompt) or "")
    assert launcher.main(["--no-browser"]) == 1
    out = capsys.readouterr().out
    assert launcher.ALL_TAKEN in out and "8000 to 8019" in launcher.ALL_TAKEN
    assert waited, "the window would close before the sentence is read"
    assert "config" not in recorded


def test_a_running_semantic_studio_is_found_and_reused(serve, recorded, monkeypatch, capsys):
    running = serve({"status": "ok", "app": "semantic-studio"})
    port = running.server_address[1]
    (later,) = free_ports(1)
    monkeypatch.setattr(launcher, "PORTS", [later, port])
    assert launcher.main([]) == 0
    assert "config" not in recorded, "a second server was started on the same data folder"
    assert recorded["opened"] == f"http://127.0.0.1:{port}/"
    assert f"already running at http://127.0.0.1:{port}" in capsys.readouterr().out
    assert running.requests == ["/api/health"]


def test_another_program_on_the_port_is_not_mistaken_for_it(serve):
    other = serve({"status": "ok"})
    port = other.server_address[1]
    (nxt,) = free_ports(1)
    assert launcher.is_semantic_studio(port) is False
    state, chosen, sock = launcher.choose([port, nxt])
    try:
        assert (state, chosen) == ("free", nxt)
        assert other.requests == ["/api/health", "/api/health"]
    finally:
        sock.close()


def test_a_silent_listener_is_not_mistaken_for_it(taken):
    assert launcher.is_semantic_studio(taken(), timeout=0.3) is False


def test_uvicorn_is_asked_for_127_0_0_1_only(recorded, monkeypatch):
    (port,) = free_ports(1)
    monkeypatch.setattr(launcher, "PORTS", [port])
    assert launcher.main(["--no-browser"]) == 0
    config = recorded["config"]
    assert config.host == "127.0.0.1" and config.host != "0.0.0.0"
    assert config.port == port
    assert recorded["address"] == ("127.0.0.1", port)
    assert config.reload is False and config.workers == 1


def test_the_main_application_is_what_is_served(recorded, monkeypatch):
    from app.main import app

    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    launcher.main(["--no-browser"])
    assert recorded["config"].app is app


def test_static_dir_is_static_beside_app(recorded, monkeypatch):
    assert launcher.STATIC_DIR == APP_DIR.parent / "static"
    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    launcher.main(["--no-browser"])
    assert os.environ["STATIC_DIR"] == str(APP_DIR.parent / "static")


def test_no_browser_is_passed_to_the_announcer(recorded, monkeypatch):
    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    launcher.main(["--no-browser"])
    assert recorded["announce"][2] is False
    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    del recorded["announce"]
    launcher.main([])
    assert recorded["announce"][2] is True


def test_the_console_says_the_three_sentences_with_the_real_data_folder(serve, recorded, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    launcher.main(["--no-browser"])
    data_dir = recorded["announce"][1]
    assert Path(data_dir) == default_data_dir()

    up = serve({"status": "ok", "app": "semantic-studio"})
    port = up.server_address[1]
    opened = []
    monkeypatch.setattr(launcher.webbrowser, "open", opened.append)
    real_announce(port, data_dir, True)
    assert capsys.readouterr().out.splitlines()[-3:] == [
        f"Semantic Studio is running at http://127.0.0.1:{port}",
        f"Your work is kept in {default_data_dir()}",
        "Close this window to stop Semantic Studio.",
    ]
    assert opened == [f"http://127.0.0.1:{port}/"]


def test_the_health_answer_says_semantic_studio():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app, base_url="http://localhost")
    assert client.get("/api/health").json()["app"] == launcher.APP_ID


def test_importing_the_launcher_starts_nothing():
    """The reasoner's spawned process imports this module as __mp_main__."""
    source = (APP_DIR / "launcher.py").read_text(encoding="utf-8")
    tail = source[source.index("def main("):]
    assert 'if __name__ == "__main__":\n    sys.exit(_run())' in tail
    module_level = [line for line in source.splitlines() if line.startswith(("choose(", "main(", "server"))]
    assert module_level == []


# ---------------------------------------------------------------------------
# AC-9: behind a system proxy the launcher still finds its own server.
# ---------------------------------------------------------------------------


@pytest.fixture
def system_proxy(http_server, monkeypatch):
    """A recording proxy every way Python can be told about one."""
    import urllib.request

    proxy = http_server(lambda path: (502, {}, b"the proxy"))
    address = f"http://127.0.0.1:{proxy.server_address[1]}"
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, address)
    # Windows' <local> does not cover a dotted address; nothing here does.
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(name, "")
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": address, "https": address, "all": address})
    return proxy


def test_the_proxy_is_one_urllib_would_use(system_proxy, serve):
    """The arrangement is proved able to catch the defect before it is
    trusted: a plain urllib request to 127.0.0.1 does go to this proxy."""
    import urllib.error
    import urllib.request

    port = serve({"status": "ok", "app": "semantic-studio"}).server_address[1]
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5)
    assert len(system_proxy.requests) == 1


def test_the_launchers_requests_never_reach_a_proxy(system_proxy, serve):
    up = serve({"status": "ok", "app": "semantic-studio"})
    port = up.server_address[1]
    assert launcher.is_semantic_studio(port) is True
    assert launcher.wait_until_up(port, timeout=5) is True
    state, found, _ = launcher.choose([port])
    assert (state, found) == ("running", port)
    assert system_proxy.requests == [], "the launcher asked the proxy for its own server"
    assert len(up.requests) == 3
