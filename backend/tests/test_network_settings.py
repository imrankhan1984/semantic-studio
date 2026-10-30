"""
================================================================================
FILE: backend/tests/test_network_settings.py
================================================================================

SUMMARY
    Proves the corporate network settings (external-access Stage 4, Section
    5.5, D-070 and D-123): the proxy in its three modes, the name rules that
    still hold through a proxy, the system's certificates with the user's
    file added on top, Test connection's stages, and the refusals of a bad
    field or a bad file. Covers AC-36 to AC-39 and AC-44 to AC-46.

BASIC IDEA
    Real connections, on loopback, through real code paths. A local CONNECT
    proxy (`proxy` fixture) records every connection and request line it
    receives and tunnels `CONNECT host:443` to the TLS server mapped for that
    name; an absolute-form `GET http://...` it answers itself. TLS servers
    present certificates from tests/tls/, signed by one of two test roots:
    *system*, which plays the operating system's store, and *company*, which
    plays the Zscaler root the user adds as a file.

    The security claims are counts at the recording proxy, as in
    test_network_broker.py: "refused before the proxy" means zero connections
    accepted, never only an exception.

    The system store is played by SSL_CERT_FILE, which truststore reads on
    Linux through OpenSSL's default paths. Windows and macOS ask the
    operating system itself, which a test cannot fill, so the live trust
    tests run on Linux; the context's type and contents are asserted
    everywhere.

INPUTS / INPUT SOURCES
    - The FastAPI app through TestClient, and the broker singleton directly.
    - tests/tls/: two test roots, two server certificates and their keys
      (see the README there), and the company root in DER.
    - conftest.py's `loopback_is_public` and `http_server` fixtures.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import re
import select
import socket
import socketserver
import ssl
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import truststore
from fastapi.testclient import TestClient

from app import net_guard, network_broker
from app.main import app
from app.network_broker import FetchFailed, NetworkPolicy, broker

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

TLS = Path(__file__).resolve().parent / "tls"
APP_DIR = Path(__file__).resolve().parent.parent / "app"
LOCAL = ipaddress.ip_address("127.0.0.1")
PRIVATE = ipaddress.ip_address("127.0.0.2")
BODY = b"@prefix : <http://example.org/t#> . :A a :B ."

linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="the system store is played by SSL_CERT_FILE, which only OpenSSL's own lookup reads",
)


# ---------------------------------------------------------------------------
# Servers: a TLS origin and a recording CONNECT proxy.
# ---------------------------------------------------------------------------


class _Origin(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.server.hosts.append(self.headers.get("Host"))
        self.send_response(200)
        self.send_header("Content-Type", "text/turtle")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args):
        pass


class _TLSServer(ThreadingHTTPServer):
    def __init__(self, leaf: str):
        super().__init__(("127.0.0.1", 0), _Origin)
        self.hosts: list[str] = []
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(TLS / f"{leaf}.pem", TLS / f"{leaf}.key")

    def get_request(self):
        sock, addr = super().get_request()
        # The handshake happens in the handler's thread, so a client that
        # refuses the certificate cannot stall the accept loop.
        return self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

    def handle_error(self, request, client_address):
        pass  # a refused certificate is the expected end of some tests


@pytest.fixture
def tls_server():
    started = []

    def start(leaf: str) -> _TLSServer:
        server = _TLSServer(leaf)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        server.port = server.server_address[1]
        return server

    yield start
    for server in started:
        server.shutdown()
        server.server_close()


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        with server.lock:
            server.connections += 1
        reader = self.request.makefile("rb")
        line = reader.readline().decode("latin-1").strip()
        if not line:
            return
        server.lines.append(line)
        while reader.readline() not in (b"\r\n", b"\n", b""):
            pass
        method, target, _version = line.split(" ", 2)
        if server.refuse_status:
            self.request.sendall(f"HTTP/1.1 {server.refuse_status} Forbidden\r\nContent-Length: 0\r\n\r\n".encode())
            return
        if method != "CONNECT":
            # An absolute-form request for plain http: answered here.
            self.request.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/turtle\r\nContent-Length: "
                + str(len(BODY)).encode() + b"\r\nConnection: close\r\n\r\n" + BODY
            )
            return
        host, _, port = target.rpartition(":")
        destination = server.routes.get((host, int(port)))
        if destination is None:
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            return
        upstream = socket.create_connection(destination)
        self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        pair = [self.request, upstream]
        try:
            while True:
                ready, _, _ = select.select(pair, [], [], 5)
                if not ready:
                    return
                for sock in ready:
                    data = sock.recv(65536)
                    if not data:
                        return
                    (upstream if sock is self.request else self.request).sendall(data)
        finally:
            upstream.close()


class _Proxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


@pytest.fixture
def proxy():
    """A recording CONNECT proxy: ``connections``, ``lines``, ``routes``."""
    server = _Proxy(("127.0.0.1", 0), _ProxyHandler)
    server.lock = threading.Lock()
    server.connections = 0
    server.lines = []
    server.routes = {}
    server.refuse_status = 0
    server.port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()
    server.server_close()


def _manual(port: int, **extra) -> dict:
    body = {
        "mode": "manual",
        "https": {"host": "127.0.0.1", "port": port},
        "http": {"host": "", "port": None},
        "noProxy": ["localhost", "127.0.0.1"],
    }
    body.update(extra)
    response = client.put("/api/network/connection", json=body)
    assert response.status_code == 200, response.json()
    return response.json()


def _mode(mode: str) -> None:
    assert client.put("/api/network/connection", json={"mode": mode}).status_code == 200


def _upload_ca(name: str = "company-ca.pem", data: bytes | None = None):
    data = (TLS / name).read_bytes() if data is None else data
    return client.put("/api/network/connection/ca", files={"file": (name, data, "application/octet-stream")})


def _get(url: str):
    host = network_broker._host_of(url)
    broker.policy.grant("ontology:import", host, "allow", remember=True)
    return broker.request("ontology:import", url, reason="t", max_bytes=1 << 20, timeout=10)


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


# ---------------------------------------------------------------------------
# AC-36 -- the three proxy choices
# ---------------------------------------------------------------------------


def test_the_default_is_the_system_proxy_and_none_is_found():
    view = client.get("/api/network/connection").json()
    assert view["mode"] == "system"
    assert view["systemProxy"] is None
    assert view["noProxy"] == ["localhost", "127.0.0.1"]
    assert view["caFile"] is None


def test_manual_sends_https_through_the_proxy_as_connect_to_the_name(proxy, tls_server, loopback_is_public):
    """AC-36 and AC-46: the proxy is asked for `CONNECT secure.test:443`, by
    name, and the TLS name checked is the original one."""
    origin = tls_server("company-site")
    loopback_is_public["secure.test"] = [LOCAL]
    proxy.routes[("secure.test", 443)] = ("127.0.0.1", origin.port)
    _manual(proxy.port)
    assert _upload_ca().status_code == 200

    response = _get("https://secure.test/onto.ttl")

    assert response.status == 200 and response.body == BODY and response.proxied
    assert proxy.lines == ["CONNECT secure.test:443 HTTP/1.1"]
    assert origin.hosts == ["secure.test"]
    # Never the pinned address, in the request line or anywhere it was told.
    assert not any("127.0.0.1" in line for line in proxy.lines)


def test_manual_sends_plain_http_to_the_http_proxy_with_the_original_url(proxy, loopback_is_public):
    """The HTTP pair, when given, carries http:// URLs; the request line is
    the original absolute URL. An explicit port skips the https-first try."""
    second = _Proxy(("127.0.0.1", 0), _ProxyHandler)
    second.lock, second.connections, second.lines, second.routes, second.refuse_status = (
        threading.Lock(), 0, [], {}, 0,
    )
    threading.Thread(target=second.serve_forever, daemon=True).start()
    try:
        loopback_is_public["plain.test"] = [LOCAL]
        _manual(proxy.port, http={"host": "127.0.0.1", "port": second.server_address[1]})
        response = _get("http://plain.test:8080/onto.ttl")
        assert response.status == 200 and response.body == BODY
        assert second.lines == ["GET http://plain.test:8080/onto.ttl HTTP/1.1"]
        assert proxy.connections == 0
    finally:
        second.shutdown()
        second.server_close()


def test_a_bypassed_host_goes_direct_and_pinned(proxy, http_server, loopback_is_public):
    server = http_server(lambda _p: (200, {}, BODY))
    loopback_is_public["direct.test"] = [LOCAL]
    _manual(proxy.port, noProxy=["localhost", "direct.test"])
    response = _get(f"http://direct.test:{server.server_address[1]}/x")
    assert response.status == 200 and not response.proxied
    assert server.requests == ["/x"]
    assert server.hosts == [f"direct.test:{server.server_address[1]}"]
    assert proxy.connections == 0


def test_the_system_proxy_is_read_at_each_request(monkeypatch, proxy, http_server, loopback_is_public):
    """No proxy found: direct and pinned. One appears: the next request uses
    it, with nothing restarted or saved in between."""
    server = http_server(lambda _p: (200, {}, BODY))
    loopback_is_public["moving.test"] = [LOCAL]
    found: dict = {}
    monkeypatch.setattr(urllib.request, "getproxies", lambda: dict(found))
    url = f"http://moving.test:{server.server_address[1]}/x"

    assert not _get(url).proxied
    assert server.requests == ["/x"] and proxy.connections == 0

    found["http"] = f"http://127.0.0.1:{proxy.port}"
    assert _get(url).proxied
    assert proxy.lines == [f"GET {url} HTTP/1.1"]
    assert server.requests == ["/x"]
    view = client.get("/api/network/connection").json()
    assert view["systemProxy"] == f"127.0.0.1:{proxy.port}"


def test_no_proxy_ignores_the_system_proxy(monkeypatch, proxy, http_server, loopback_is_public):
    server = http_server(lambda _p: (200, {}, BODY))
    loopback_is_public["plain.test"] = [LOCAL]
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": f"http://127.0.0.1:{proxy.port}"})
    _mode("none")
    assert not _get(f"http://plain.test:{server.server_address[1]}/x").proxied
    assert proxy.connections == 0


def test_a_system_proxy_of_another_kind_is_refused_not_bypassed(monkeypatch, loopback_is_public):
    loopback_is_public["plain.test"] = [LOCAL]
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": "socks5://127.0.0.1:1080"})
    with pytest.raises(FetchFailed, match="cannot use"):
        _get("http://plain.test:8080/x")


# ---------------------------------------------------------------------------
# AC-38 -- through a proxy, the name rules still refuse, and the proxy hears
# nothing.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://10.1.2.3:8080/x",                # a non-public address in the URL
        "http://inside.test:8080/x",             # resolves here to a private address
        "https://inside.test/x",
        "http://intranet:8080/x",                # a single-label name
        "http://wiki.corp.internal:8080/x",      # reserved suffixes
        "http://printer.local:8080/x",
        "http://box.lan:8080/x",
        "http://nas.home.arpa:8080/x",
    ],
)
def test_proxy_mode_refuses_internal_names_with_zero_requests_to_the_proxy(url, proxy, loopback_is_public):
    loopback_is_public["inside.test"] = [LOCAL, PRIVATE]
    _manual(proxy.port)
    with pytest.raises(net_guard.BlockedAddress):
        _get(url)
    assert proxy.connections == 0


def test_a_name_this_machine_cannot_look_up_is_the_proxys_to_find(monkeypatch, proxy):
    """D-070 refuses a name that answers privately; one that does not answer
    at all goes to the proxy, which resolves it, as a browser's would."""
    def no_answer(_host):
        raise net_guard.BlockedAddress(net_guard.UNRESOLVABLE_HOST_DETAIL)

    monkeypatch.setattr(net_guard, "resolve_host", no_answer)
    _manual(proxy.port)
    response = _get("http://outside.example:8080/x")
    assert response.proxied and proxy.lines == ["GET http://outside.example:8080/x HTTP/1.1"]


def test_without_approval_nothing_reaches_the_proxy(proxy):
    _manual(proxy.port)
    with pytest.raises(network_broker.ApprovalRequired):
        broker.request("ontology:import", "https://unasked.example/x", reason="t", max_bytes=1024, timeout=5)
    assert proxy.connections == 0


# ---------------------------------------------------------------------------
# AC-37 -- the system's certificates, the file on top, never verification off
# ---------------------------------------------------------------------------


def test_the_trust_is_the_operating_systems():
    assert isinstance(broker.tls_context(), truststore.SSLContext)
    assert client.get("/api/network/connection").json()["trust"] == "system"


def test_the_file_is_added_to_the_system_context_not_in_place_of_it():
    assert _upload_ca().status_code == 200
    context = broker.tls_context()
    assert isinstance(context, truststore.SSLContext)
    # truststore keeps OpenSSL's context inside and does not list it itself;
    # the inner context is what holds an added file, and what Windows' and
    # macOS' verification reads the custom roots from.
    subjects = [dict(x[0] for x in c["subject"]).get("commonName") for c in context._ctx.get_ca_certs()]
    assert "Semantic Studio Test Company Root" in subjects
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname


@pytest.fixture
def system_store(monkeypatch, tmp_path):
    """The *system* test root plays the operating system's store."""
    monkeypatch.setenv("SSL_CERT_FILE", str(TLS / "system-ca.pem"))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path))


@linux_only
def test_a_server_signed_by_a_system_root_is_trusted(system_store, tls_server, loopback_is_public):
    origin = tls_server("system-site")
    loopback_is_public["system.test"] = [LOCAL]
    assert _get(f"https://system.test:{origin.port}/x").body == BODY


@linux_only
def test_the_file_adds_a_root_and_the_system_roots_stay(system_store, tls_server, loopback_is_public):
    company = tls_server("company-site")
    system = tls_server("system-site")
    loopback_is_public["secure.test"] = [LOCAL]
    loopback_is_public["system.test"] = [LOCAL]
    with pytest.raises(FetchFailed) as refused:
        _get(f"https://secure.test:{company.port}/x")
    assert any(isinstance(e, ssl.SSLCertVerificationError) for e in network_broker._causes(refused.value))

    assert _upload_ca().status_code == 200
    assert _get(f"https://secure.test:{company.port}/x").body == BODY
    assert _get(f"https://system.test:{system.port}/x").body == BODY

    # Remove: the next request trusts the system store alone.
    view = client.delete("/api/network/connection/ca").json()
    assert view["caFile"] is None
    assert not (broker.data_dir / network_broker.CA_FILE_NAME).exists()
    with pytest.raises(FetchFailed):
        _get(f"https://secure.test:{company.port}/x")
    assert _get(f"https://system.test:{system.port}/x").body == BODY


# Every way Python, httpx or the environment can be told to stop checking.
_VERIFY_OFF = [
    re.compile(r"\bverify\s*=\s*(?:False|0|None)\b"),
    re.compile(r"\bCERT_NONE\b"),
    re.compile(r"\bcheck_hostname\s*=\s*(?:False|0)\b"),
    re.compile(r"_create_unverified_context"),
    re.compile(r"PYTHONHTTPSVERIFY"),
    re.compile(r"\bverify_mode\s*="),
]


def _verify_off(source: str) -> list[str]:
    return [m.group(0) for pattern in _VERIFY_OFF for m in pattern.finditer(source)]


def test_the_scan_sees_every_way_to_switch_verification_off():
    for line in (
        "httpx.Client(verify=False)",
        "httpx.get(url, verify = 0)",
        "ctx.verify_mode = ssl.CERT_NONE",
        "ctx.check_hostname = False",
        "ssl._create_unverified_context()",
        "os.environ['PYTHONHTTPSVERIFY'] = '0'",
    ):
        assert _verify_off(line), line
    assert not _verify_off("httpx.Client(verify=self.tls_context())")


def test_no_path_switches_certificate_verification_off():
    files = sorted(APP_DIR.rglob("*.py"))
    assert any(f.name == "network_broker.py" for f in files), "the scan found no source"
    offenders = [f"{f.name}: {hit}" for f in files for hit in _verify_off(f.read_text(encoding="utf-8"))]
    assert offenders == []
    # And the one client the broker builds is handed the checking context.
    assert "verify=self.tls_context()" in (APP_DIR / "network_broker.py").read_text(encoding="utf-8")


def test_only_the_broker_imports_truststore():
    importing = sorted(
        f.name for f in APP_DIR.rglob("*.py")
        if re.search(r"^\s*(?:import|from)\s+truststore\b", f.read_text(encoding="utf-8"), re.M)
    )
    assert importing == ["network_broker.py"]


# ---------------------------------------------------------------------------
# AC-39 -- Test connection names the failing stage
# ---------------------------------------------------------------------------


@pytest.fixture
def w3(monkeypatch, tls_server, loopback_is_public):
    """www.w3.org served locally with a company-signed certificate."""
    origin = tls_server("company-site")
    loopback_is_public["www.w3.org"] = [LOCAL]
    monkeypatch.setattr(network_broker, "TEST_URL", "https://www.w3.org/1999/02/22-rdf-syntax-ns")
    return origin


def _test() -> dict:
    response = client.post("/api/network/test")
    assert response.status_code == 200
    return response.json()


def test_connected_through_the_proxy(w3, proxy):
    proxy.routes[("www.w3.org", 443)] = ("127.0.0.1", w3.port)
    _manual(proxy.port)
    _upload_ca()
    assert _test() == {"ok": True, "stage": None, "message": "Connected through the proxy. Certificate trusted."}
    assert proxy.lines == ["CONNECT www.w3.org:443 HTTP/1.1"]
    # Logged under its own word, and needing no grant.
    assert broker.activity.latest(1)[0]["capability"] == "network:test"
    assert broker.policy.snapshot()["grants"] == []


def test_connected_directly(w3, monkeypatch):
    monkeypatch.setattr(network_broker, "TEST_URL", f"https://www.w3.org:{w3.port}/1999/02/22-rdf-syntax-ns")
    _upload_ca()
    assert _test() == {"ok": True, "stage": None, "message": "Connected directly. Certificate trusted."}


def test_the_proxy_cannot_be_reached(w3):
    port = _closed_port()
    _manual(port)
    result = _test()
    assert result["stage"] == "proxy" and not result["ok"]
    assert result["message"] == f"Could not reach the proxy at 127.0.0.1:{port}. Check the address and port."


def test_the_proxy_refuses(w3, proxy):
    proxy.refuse_status = 403
    _manual(proxy.port)
    assert _test() == {"ok": False, "stage": "proxy", "message": "The proxy refused the connection (status 403)."}


def test_the_certificate_is_not_trusted(w3, proxy):
    proxy.routes[("www.w3.org", 443)] = ("127.0.0.1", w3.port)
    _manual(proxy.port)
    result = _test()
    assert result["stage"] == "tls"
    assert result["message"] == (
        "The site's certificate was not trusted. Ask IT for the company's root "
        "certificate file and add it here."
    )


def test_the_site_cannot_be_reached(w3, monkeypatch):
    monkeypatch.setattr(network_broker, "TEST_URL", f"https://www.w3.org:{_closed_port()}/x")
    result = _test()
    assert result["stage"] == "http"
    assert result["message"].startswith("Could not reach www.w3.org (")
    assert result["message"].endswith("). Check that you are online.")


def test_offline_tests_nothing(w3, proxy):
    _manual(proxy.port)
    broker.policy.set_offline(True)
    assert _test() == {"ok": False, "stage": "offline", "message": "Semantic Studio is working offline."}
    assert proxy.connections == 0


def test_a_system_proxy_of_another_kind_is_named(w3, monkeypatch):
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"https": "socks5://127.0.0.1:1080"})
    result = _test()
    assert result["stage"] == "proxy"
    assert result["message"] == (
        "The system proxy (socks5://127.0.0.1:1080) is of a kind Semantic Studio cannot use."
    )


def test_network_test_cannot_be_granted():
    r = client.post(
        "/api/network/grants",
        json={"capability": "network:test", "host": "www.w3.org", "decision": "allow", "remember": True},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# AC-44 -- a bad field is refused with a sentence, and nothing is saved
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "https,field,sentence",
    [
        ({"host": "", "port": 8080}, "httpsHost", "Enter the proxy's host name or address."),
        ({"host": "http://proxy.corp", "port": 8080}, "httpsHost", "without http:// or https://"),
        ({"host": "proxy.corp/path", "port": 8080}, "httpsHost", "without a path"),
        ({"host": "proxy.corp:8080", "port": 8080}, "httpsHost", "port in its own field"),
        ({"host": "proxy corp", "port": 8080}, "httpsHost", "not a host name"),
        ({"host": "proxy.corp", "port": 0}, "httpsPort", "Enter a port from 1 to 65535."),
        ({"host": "proxy.corp", "port": 65536}, "httpsPort", "Enter a port from 1 to 65535."),
        ({"host": "proxy.corp", "port": "80a"}, "httpsPort", "Enter a port from 1 to 65535."),
        ({"host": "proxy.corp", "port": None}, "httpsPort", "Enter a port from 1 to 65535."),
    ],
)
def test_a_bad_field_is_refused_and_nothing_saved(https, field, sentence):
    before = client.get("/api/network/connection").json()
    r = client.put("/api/network/connection", json={"mode": "manual", "https": https})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_connection"
    assert sentence in detail["fields"][field]
    assert client.get("/api/network/connection").json() == before


def test_the_http_pair_and_the_bypass_list_are_checked_too():
    r = client.put(
        "/api/network/connection",
        json={
            "mode": "manual",
            "https": {"host": "proxy.corp", "port": 9400},
            "http": {"host": "", "port": 80},
            "noProxy": ["intranet.corp", "not a host"],
        },
    )
    fields = r.json()["detail"]["fields"]
    assert set(fields) == {"httpHost", "noProxy"}
    assert "not a host" in fields["noProxy"]


def test_a_good_manual_proxy_is_saved_in_network_policy_json_not_settings_json():
    view = _manual(9400, http={"host": "", "port": None}, noProxy=["intranet.corp", ".corp.example"])
    assert view["https"] == {"host": "127.0.0.1", "port": 9400}
    stored = json.loads((broker.data_dir / "network-policy.json").read_text(encoding="utf-8"))
    assert stored["connection"]["mode"] == "manual"
    assert stored["connection"]["noProxy"] == ["intranet.corp", ".corp.example"]
    settings_file = broker.data_dir / "settings.json"
    assert not settings_file.exists() or "connection" not in settings_file.read_text(encoding="utf-8")


def test_another_mode_keeps_the_manual_fields_and_takes_no_half_typed_host():
    _manual(9400)
    r = client.put("/api/network/connection", json={"mode": "none", "https": {"host": "half/typ", "port": "x"}})
    assert r.status_code == 200
    assert r.json()["mode"] == "none" and r.json()["https"] == {"host": "127.0.0.1", "port": 9400}


def test_the_settings_survive_a_restart(tmp_path):
    policy = NetworkPolicy(tmp_path / "network-policy.json")
    connection = network_broker.validate_connection(
        {"mode": "manual", "https": {"host": "proxy.corp", "port": 9400}}, policy.connection
    )
    policy.set_connection(connection)
    assert NetworkPolicy(tmp_path / "network-policy.json").connection == connection


def test_a_hand_edited_bad_value_falls_back_on_its_own_and_logs_once(tmp_path, caplog):
    path = tmp_path / "network-policy.json"
    path.write_text(json.dumps({
        "offline": False,
        "grants": [],
        "connection": {
            "mode": "manual",
            "https": {"host": "proxy.corp", "port": 99999},
            "http": {"host": "web.corp", "port": 8080},
            "noProxy": ["a.corp"],
            "caFile": None,
        },
    }), encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="app.network_broker"):
        connection = NetworkPolicy(path).connection
    # The bad port costs its pair, and Manual with no HTTPS proxy reads as the
    # default mode; the good values stay.
    assert connection["https"] == {"host": "", "port": None}
    assert connection["mode"] == "system"
    assert connection["http"] == {"host": "web.corp", "port": 8080}
    assert connection["noProxy"] == ["a.corp"]
    assert len([r for r in caplog.records if "connection" in r.getMessage()]) == 1


# ---------------------------------------------------------------------------
# AC-45 -- the certificate file
# ---------------------------------------------------------------------------


def test_a_pem_file_is_kept_and_named_with_its_fingerprint():
    data = (TLS / "company-ca.pem").read_bytes()
    view = _upload_ca().json()
    assert view["caFile"] == {"name": "company-ca.pem", "sha256": hashlib.sha256(data).hexdigest()}
    stored = (broker.data_dir / "network-ca.pem").read_text(encoding="ascii")
    assert stored.startswith("-----BEGIN CERTIFICATE-----")


def test_a_der_file_is_stored_as_pem():
    data = (TLS / "company-ca.der").read_bytes()
    view = _upload_ca("company-ca.der").json()
    assert view["caFile"]["sha256"] == hashlib.sha256(data).hexdigest()
    stored = (broker.data_dir / "network-ca.pem").read_text(encoding="ascii")
    assert ssl.PEM_cert_to_DER_cert(stored) == data


def test_a_file_with_a_private_key_is_refused():
    data = (TLS / "company-site.pem").read_bytes() + (TLS / "company-site.key").read_bytes()
    r = _upload_ca("bundle.pem", data)
    assert r.status_code == 422 and "private key" in r.json()["detail"]
    assert not (broker.data_dir / "network-ca.pem").exists()
    assert client.get("/api/network/connection").json()["caFile"] is None


@pytest.mark.parametrize("data", [b"not a certificate at all", b"\x30\x82\x01\x00junk", b""])
def test_a_file_with_no_certificate_is_refused(data):
    r = _upload_ca("nothing.pem", data)
    assert r.status_code == 422 and "no certificate" in r.json()["detail"]
    assert not (broker.data_dir / "network-ca.pem").exists()


def test_a_file_over_1_mb_is_refused_before_it_is_read(monkeypatch):
    """The middleware's half: with the route's own count lifted, a declared
    1.1 MB body is still 413, where the route would have read it all and
    answered 422."""
    from app.routers import network as network_router

    monkeypatch.setattr(network_router, "CA_MAX_BYTES", 10 * 1024 * 1024)
    r = _upload_ca("big.pem", b"A" * (network_broker.CA_MAX_BYTES + 128 * 1024))
    assert r.status_code == 413 and "larger than 1 MB" in r.json()["detail"]


def test_the_route_counts_the_bytes_itself(monkeypatch):
    """The middleware reads a declared size; the route counts what arrives."""
    from app.routers import network as network_router

    monkeypatch.setattr(network_router, "CA_MAX_BYTES", 1000)
    r = _upload_ca("big.pem", (TLS / "company-ca.pem").read_bytes())
    assert r.status_code == 413
    assert not (broker.data_dir / "network-ca.pem").exists()


def test_the_name_kept_is_a_plain_file_name():
    data = (TLS / "company-ca.pem").read_bytes()
    assert _upload_ca("../../root<x>.pem", data).json()["caFile"]["name"] == "rootx.pem"
    assert _upload_ca("C:\\Users\\me\\Zscaler Root.cer", data).json()["caFile"]["name"] == "Zscaler Root.cer"
