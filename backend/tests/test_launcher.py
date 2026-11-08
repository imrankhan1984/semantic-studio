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
    own server never reach a proxy. Then the version check
    (launcher-version-check, Section 11): version() read from VERSION.txt,
    /api/health saying it, the same version opened, and an older, newer,
    unnamed or other one refused with its 5.3 sentence.

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

    The launcher's own version is pinned by replacing `launcher.version`, so
    a result never depends on whether this checkout has a VERSION.txt; the
    reader itself is tested on files written to a temporary folder.

INPUTS / INPUT SOURCES
    - app.launcher, app.store, app.version.

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
from app import version as version_module
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
    running = serve({"status": "ok", "app": "semantic-studio", "version": launcher.version()})
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
    # A fresh opener, never urlopen: urlopen keeps the first opener it
    # builds, proxy and all, for every later test in the process.
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.build_opener().open(f"http://127.0.0.1:{port}/api/health", timeout=5)
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


def test_a_failed_start_keeps_its_reason_on_screen(recorded, monkeypatch, capsys):
    """uvicorn ends a failed start with sys.exit(3), past _run's handler."""

    def run(self, sockets=None):
        raise SystemExit(3)

    monkeypatch.setattr(uvicorn.Server, "run", run)
    monkeypatch.setattr(launcher, "PORTS", free_ports(1))
    waited = []
    monkeypatch.setattr("builtins.input", lambda prompt="": waited.append(prompt) or "")
    assert launcher.main(["--no-browser"]) == 2
    assert waited and "stopped because of the error above" in capsys.readouterr().out


@pytest.mark.skipif(os.name == "nt", reason="TIME_WAIT does not hold a listening port on Windows")
def test_a_quick_restart_gets_the_same_port():
    """The last run's connections in TIME_WAIT do not move a restart to 8001."""
    (port,) = free_ports(1)
    server = launcher.bind(port)
    client = socket.create_connection(("127.0.0.1", port))
    accepted, _ = server.accept()
    accepted.close()  # the server closes first: its side waits in TIME_WAIT
    client.close()
    server.close()
    again = launcher.bind(port)
    assert again is not None, "a quick restart could not take its own port back"
    again.close()


def test_a_port_someone_listens_on_is_still_taken(taken):
    assert launcher.bind(taken()) is None


# ---------------------------------------------------------------------------
# X-15: the launcher checks the running version (launcher-version-check).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text, expected", [
    ("Semantic Studio 1.1.0\nBuilt from commit abc\n", "1.1.0"),
    ("Semantic Studio 1.10.2\r\n", "1.10.2"),
    ("", "development"),
    ("Semantic Studio\n", "development"),
    ("Semantic Studio \n", "development"),
    ("Version 1.1.0\n", "development"),
    ("\nSemantic Studio 1.1.0\n", "development"),
])
def test_version_is_what_follows_semantic_studio_on_the_first_line(tmp_path, text, expected):
    path = tmp_path / "VERSION.txt"
    path.write_bytes(text.encode("utf-8"))
    assert version_module.read_version(path) == expected


def test_version_without_a_file_or_with_an_unreadable_one_is_development(tmp_path):
    assert version_module.read_version(tmp_path / "VERSION.txt") == "development"
    assert version_module.read_version(tmp_path) == "development"  # a folder, not a file
    bad = tmp_path / "bad.txt"
    bad.write_bytes(b"Semantic Studio \xff\xfe\n")
    assert version_module.read_version(bad) == "development"


def test_version_reads_the_file_above_app_once():
    assert version_module.VERSION_FILE == APP_DIR.parent / "VERSION.txt"
    version_module.version.cache_clear()
    try:
        first = version_module.version()
        assert version_module.version() == first
        assert version_module.version.cache_info().misses == 1
    finally:
        version_module.version.cache_clear()


def test_the_health_answer_says_the_version(monkeypatch):
    from fastapi.testclient import TestClient

    import app.main as main_module

    monkeypatch.setattr(main_module, "version", lambda: "1.1.0")
    client = TestClient(main_module.app, base_url="http://localhost")
    assert client.get("/api/health").json() == {"status": "ok", "app": "semantic-studio", "version": "1.1.0"}


def test_the_health_answer_says_development_from_source():
    """This checkout has no VERSION.txt above app, as a copy run from source."""
    from fastapi.testclient import TestClient

    from app.main import app

    assert not version_module.VERSION_FILE.exists()
    client = TestClient(app, base_url="http://localhost")
    assert client.get("/api/health").json()["version"] == version_module.version() == "development"


@pytest.mark.parametrize("running, own, expected", [
    ("1.10.0", "1.9.2", "newer"),
    ("1.9.2", "1.10.0", "older"),
    ("1.1.0", "1.1.0", "same"),
    ("1.1", "1.1.0", "same"),
    ("1.1.0", "1.1", "same"),
    ("1.0.0", "1.1.0", "older"),
    ("1.2.0", "1.1.0", "newer"),
    ("2", "1.99.99", "newer"),
    (None, "1.1.0", "older"),
    (None, "development", "older"),
    ("development", "1.1.0", "another"),
    ("1.1.0", "development", "another"),
    ("1.x-rc", "1.1.0", "another"),
    ("1.1.0", "1.x-rc", "another"),
    ("development", "development", "same"),
])
def test_versions_compare_part_by_part(running, own, expected):
    assert launcher.compare(running, own) == expected


@pytest.mark.parametrize("answer, expected", [
    ({"app": "semantic-studio", "version": "1.0.0"}, "1.0.0"),
    ({"app": "semantic-studio"}, None),
    ({"app": "semantic-studio", "version": 1}, None),
    ({"app": "semantic-studio", "version": ""}, None),
    ({"app": "semantic-studio", "version": "1.0\n\x1b[2J"}, None),
    ({"app": "semantic-studio", "version": "9" * 65}, None),
])
def test_only_a_version_shaped_answer_is_read(answer, expected):
    assert launcher.running_version(answer) == expected


@pytest.fixture
def own_version(monkeypatch):
    monkeypatch.setattr(launcher, "version", lambda: "1.1.0")
    return "1.1.0"


def test_the_same_version_running_is_opened_as_today(serve, recorded, own_version, monkeypatch, capsys):
    running = serve({"status": "ok", "app": "semantic-studio", "version": "1.1.0"})
    port = running.server_address[1]
    monkeypatch.setattr(launcher, "PORTS", [port])
    assert launcher.main(["--no-browser"]) == 0
    assert capsys.readouterr().out.strip() == (
        f"Semantic Studio is already running at http://127.0.0.1:{port}. Opening it in your browser."
    )
    assert "config" not in recorded and "opened" not in recorded
    assert running.requests == ["/api/health"]


MISMATCHES = [
    ({"version": "1.0.0"},
     "An older version of Semantic Studio (1.0.0) is running at {address}. "
     "Close its window, titled Semantic Studio, then start this one (1.1.0) again."),
    ({},
     "An older version of Semantic Studio is running at {address}. "
     "Close its window, titled Semantic Studio, then start this one (1.1.0) again."),
    ({"version": "1.2.0"},
     "A newer version of Semantic Studio (1.2.0) is running at {address}. "
     "Close its window, titled Semantic Studio, then start this one (1.1.0) again, or keep using the newer one."),
    ({"version": "development"},
     "Another version of Semantic Studio (development) is running at {address}. "
     "Close it, then start this one (1.1.0) again."),
]


@pytest.mark.parametrize("said, sentence", MISMATCHES, ids=["older", "no-version", "newer", "development"])
def test_another_version_running_opens_nothing_and_says_which(
        serve, recorded, own_version, monkeypatch, capsys, said, sentence):
    running = serve({"status": "ok", "app": "semantic-studio", **said})
    port = running.server_address[1]
    # A free port after it: no server may be started there either.
    monkeypatch.setattr(launcher, "PORTS", [port, *free_ports(1)])
    waited = []
    monkeypatch.setattr("builtins.input", lambda prompt="": waited.append(prompt) or "")
    assert launcher.main([]) == 1
    assert capsys.readouterr().out.strip() == sentence.format(address=f"http://127.0.0.1:{port}")
    assert waited, "the window would close before the sentence is read"
    assert "config" not in recorded and "announce" not in recorded, "a server was started beside another version"
    assert "opened" not in recorded, "the browser was sent to another version"
    assert running.requests == ["/api/health"]


def test_the_free_port_is_let_go_when_another_version_is_found(serve, own_version):
    running = serve({"status": "ok", "app": "semantic-studio", "version": "1.0.0"})
    port = running.server_address[1]
    (free,) = free_ports(1)
    state, found, said = launcher.choose([port, free])
    assert (state, found) == ("running", port)
    assert isinstance(said, str) and "(1.0.0)" in said and "(1.1.0)" in said
    again = launcher.bind(free)
    assert again is not None, "choose kept a port it did not hand out"
    again.close()


def test_the_first_semantic_studio_found_decides(serve, own_version):
    old = serve({"status": "ok", "app": "semantic-studio", "version": "1.0.0"})
    same = serve({"status": "ok", "app": "semantic-studio", "version": "1.1.0"})
    state, found, said = launcher.choose([old.server_address[1], same.server_address[1]])
    assert (state, found) == ("running", old.server_address[1]) and isinstance(said, str)
    assert same.requests == []
