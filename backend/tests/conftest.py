"""
================================================================================
FILE: backend/tests/conftest.py
================================================================================

SUMMARY
    pytest's automatic configuration file. It runs before any test module is
    collected and points the app's data directory at a throwaway temp folder.

BASIC IDEA
    The store persists ontologies and saved queries to a per-user directory.
    If tests used the real one they would pollute (or read) the developer's
    actual library. Setting the env var here — at import time, before any app
    module loads and reads it — guarantees every test run gets a clean,
    isolated, disposable data directory.

    It also carries the network fixtures shared across files: an autouse reset
    of the network broker's policy and log, `loopback_is_public` (lets a pinned
    connection reach a loopback test server under a public-looking name), and
    `http_server` (recording HTTP servers).

INPUTS / INPUT SOURCES
    - None beyond the test run itself.

EXPECTED OUTPUT
    - SEMANTIC_STUDIO_DATA_DIR set to a fresh temp directory for the test run.
    - The fixtures above.
================================================================================
"""

import os
import tempfile

# Isolate the persistent store: tests must never touch the developer's real
# per-user data directory. This runs before any app module is imported, so
# default_data_dir() in store.py picks up this override.
os.environ["SEMANTIC_STUDIO_DATA_DIR"] = tempfile.mkdtemp(prefix="semantic-studio-tests-")


# ---------------------------------------------------------------------------
# Network fixtures, shared by the broker, restriction and parser tests.
#
# Since D-067 the broker connects to the address it judged, so a test cannot
# make a public-looking name reach a loopback server by faking the resolver
# alone -- the connection would go to whatever fake address it returned. The
# honest arrangement is the reverse: let the judgement treat exactly
# 127.0.0.1 as public, point test names at it, and keep every other loopback
# address (127.0.0.2 serves as "the private one") refused.
# ---------------------------------------------------------------------------

import ipaddress  # noqa: E402
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

import pytest  # noqa: E402

PUBLIC_FOR_TESTS = ipaddress.ip_address("127.0.0.1")


@pytest.fixture(autouse=True)
def _fresh_network_policy():
    """Every test starts online, with no grants and an empty activity log."""
    from app.network_broker import broker

    broker.reset()
    yield
    broker.reset()


@pytest.fixture
def loopback_is_public(monkeypatch):
    """127.0.0.1 counts as public; names in ``names`` resolve to it.

    Returns the dict of names so a test can add its own, including a list of
    answers to hand out one per lookup (the rebinding case).
    """
    from app import net_guard

    real_judge = net_guard.is_blocked_address
    real_resolve = net_guard.resolve_host
    names: dict[str, object] = {}

    def judge(ip):
        return False if ip == PUBLIC_FOR_TESTS else real_judge(ip)

    def resolve(host):
        answer = names.get(host)
        if answer is None:
            return real_resolve(host)
        if isinstance(answer, list) and answer and isinstance(answer[0], list):
            # A sequence of answers, one per lookup.
            return answer.pop(0) if len(answer) > 1 else answer[0]
        return answer

    monkeypatch.setattr(net_guard, "is_blocked_address", judge)
    monkeypatch.setattr(net_guard, "resolve_host", resolve)
    return names


class _Handler(BaseHTTPRequestHandler):
    """Answers from the server's ``routes`` table and records every request."""

    def _serve(self):
        server = self.server
        server.requests.append(self.path)
        server.hosts.append(self.headers.get("Host"))
        length = int(self.headers.get("Content-Length") or 0)
        server.bodies.append(self.rfile.read(length) if length else b"")
        status, headers, body = server.route(self.path)
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _serve  # noqa: N815 - BaseHTTPRequestHandler's spelling
    do_POST = _serve  # noqa: N815

    def log_message(self, *args):
        pass


@pytest.fixture
def http_server():
    """Start recording HTTP servers: ``http_server(route, host=..., port=...)``.

    ``route(path) -> (status, headers, body)``. Each server records ``requests``
    (paths), ``hosts`` (Host headers) and ``bodies``.
    """
    started = []

    def start(route, host="127.0.0.1", port=0):
        server = ThreadingHTTPServer((host, port), _Handler)
        server.route = route
        server.requests, server.hosts, server.bodies = [], [], []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        return server

    yield start
    for server in started:
        server.shutdown()
        server.server_close()
