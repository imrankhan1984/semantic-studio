"""
================================================================================
FILE: backend/app/network_broker.py
================================================================================

SUMMARY
    The one door from Semantic Studio to the internet. Every outbound request
    names what it is for (a capability), and goes out only if the user has
    allowed that capability for that host, the application is not offline, and
    every address involved is public. Each attempt is written to an activity
    log. No other backend module may open a network connection; a source-scan
    test enforces that (test_no_direct_network.py). Decisions D-066 and D-067.
    It also owns the connection settings for corporate networks: the proxy,
    the trusted certificates and Test connection (Stage 4, D-070, D-123).

BASIC IDEA
    A request passes five gates, in an order chosen so that a refusal costs no
    traffic of any kind, DNS included:

      1. Offline refuses everything, before anything else is looked at.
      2. The scheme must be http(s), and a host that needs no lookup to judge
         (an address literal, `localhost`) is judged now. Asking the user to
         approve an address that will be refused anyway is a question with no
         right answer.
      3. The policy: Block refuses without asking; no grant raises
         ApprovalRequired, which every router returns as HTTP 409 and the
         frontend turns into a dialog. **This comes before name resolution on
         purpose** -- a DNS query to a name in a file someone sent you tells
         its owner you opened it, which is the beacon this feature exists to
         stop.
      4. The name is resolved once and every answer judged (net_guard).
      5. The connection is made **to the address that was judged**, with the
         real name carried in the Host header and in TLS SNI, so certificate
         checking still validates the name. Resolving twice -- once to judge,
         once to connect -- was the DNS rebinding window D-012 accepted; it is
         closed here (D-067).

    Redirects are followed by hand, at most five, and every hop passes gates
    2 to 5 again. A redirect to another host needs that host's own grant for
    the same capability, so an approved site cannot hand the request on to one
    the user never saw.

    Grants are either remembered (network-policy.json in the data directory) or
    just-once. A just-once grant is held in memory and is honoured only for a
    request that presents its id in the X-Semantic-Studio-Grant header -- the
    frontend's retry of the action the user approved -- and is spent when that
    request ends. So "just this time" means one action, not "until restart".
    The header is carried from the HTTP layer to the broker in a contextvar set
    by GrantScopeMiddleware, which also reaches the parse worker thread because
    store.parse_rdf runs it inside a copy of the caller's context.

    A typed URL is its own approval (Section 5.2 of external-access.md): the
    first host of an `ontology:fetch` marked `user_initiated` goes without a
    dialog. It still obeys offline, Block and the address rules, and a redirect
    to a different host still asks.

    An `http://` URL with no explicit port is tried over `https://` first, and
    falls back to plain http only if the encrypted connection cannot be made
    (open question 2, taken as recommended). The log records which was used.

    Corporate networks (Stage 4, D-070, D-123). A proxy is chosen per request:
    *system* (the default) reads `urllib.request.getproxies()` every time,
    never cached, and with none found connects directly; *none* is direct;
    *manual* is the HTTPS and HTTP host and port the user saved, with a bypass
    list. Through a proxy the original URL goes to the proxy, with no pinned
    address, Host override or SNI name, because the proxy resolves and
    connects. Gates 1 to 3 are unchanged, and gate 4 becomes D-070's
    name-based check: a name resolving locally to any non-public address is
    refused before the proxy hears of it. Single-label names and reserved
    suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`) are refused at gate
    2 in every mode, since the address check would refuse them after a lookup
    anyway and a proxy would not. A bypassed host is direct and pinned.

    Trust is the operating system's, through `truststore`, with the user's
    certificate file added on top (`load_verify_locations`), never in place
    of it. Where truststore cannot load, Python's own list plus the file.
    Verification is never switched off: there is no setting, flag or variable
    for it, and test_network_settings.py scans for one.

INPUTS / INPUT SOURCES
    - Calls to `broker.request(capability, url, ...)` from the fetch router,
      from net_guard's rdflib chokepoint, from imports.py and from
      sparql_service.py's SERVICE handler.
    - network-policy.json (grants, offline and the connection settings),
      network-ca.pem and network-activity.jsonl in the data directory.
    - The system proxy, through urllib.request.getproxies at request time.
    - The X-Semantic-Studio-Grant request header, via GrantScopeMiddleware.
    - The system resolver, through net_guard.resolve_host.

EXPECTED OUTPUT
    - A BrokerResponse (final URL, status, headers, body) for a request that
      was made. Non-2xx statuses are returned, not raised; the caller decides.
    - Raises Offline, HostBlocked, ApprovalRequired, net_guard.BlockedAddress,
      TooLarge or FetchFailed for a request that was refused or failed.
    - One JSON line per attempt in network-activity.jsonl, rotated at 5 MB.
    - The connection settings as the panel reads them, and Test connection's
      {ok, stage, message}.
================================================================================
"""

from __future__ import annotations

import contextvars
import copy
import hashlib
import json
import logging
import os
import re
import ssl
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from . import net_guard

# The operating system's certificates (D-123). Imported here alone, the one
# door. If it cannot load, the broker falls back to Python's own list and the
# Connection section says so, rather than failing every connection.
try:
    import truststore
except Exception:  # pragma: no cover - an unsupported platform
    truststore = None

log = logging.getLogger(__name__)

# What each capability is for, in the words the dialog uses. The capability
# names themselves are never shown to the user (Section 7 of the spec); the
# phrase completes "Always, for ... from this site".
CAPABILITIES: dict[str, dict[str, str]] = {
    "ontology:fetch": {
        "phrase": "downloading ontologies",
        "sends": "A download request for the file. Nothing from your library.",
    },
    "ontology:import": {
        "phrase": "importing ontologies",
        "sends": "A download request for each file. Nothing from your library.",
    },
    "jsonld:context": {
        "phrase": "loading JSON-LD contexts",
        "sends": "A download request for the context. Nothing from your file or library.",
    },
    "sparql:service": {
        "phrase": "running SPARQL queries",
        "sends": "The query text shown. Nothing else from your ontology.",
    },
}

GRANT_HEADER = "x-semantic-studio-grant"

MAX_REDIRECTS = net_guard.MAX_REDIRECTS

# A just-once grant nobody presents is dropped after this long. It exists for
# the few seconds between the dialog and the retry; an unspent one lying around
# would be a standing permission the user did not mean to give.
ONCE_GRANT_TTL_SECONDS = 300.0

# The activity log rotates here, keeping one previous file. The panel shows the
# latest 200 entries, which fit many times over in either file.
ACTIVITY_ROTATE_BYTES = 5 * 1024 * 1024
ACTIVITY_DEFAULT_LIMIT = 200
ACTIVITY_MAX_LIMIT = 1000

# The https-first attempt for an http:// URL gets a short connect timeout: a
# host that silently drops port 443 would otherwise hold the user for the whole
# request timeout before the fallback is even tried.
UPGRADE_CONNECT_TIMEOUT = 5.0

# Names refused without a lookup. `localhost` resolves locally and harmlessly,
# but it can only ever be refused, so asking about it is pointless. The other
# suffixes, and a name with no dot, are D-070's: through a proxy no address is
# ever seen, so the name is all there is to judge.
_LOCAL_NAMES = ("localhost",)
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa")

OFFLINE_DETAIL = "Semantic Studio is working offline, so nothing was downloaded."

_REDIRECT_CODES = (301, 302, 303, 307, 308)


# Test connection (Stage 4, 5.5 item 5): an explicit user action, so it needs
# no grant, like a typed URL. Its capability is the log's word for it and is
# never grantable. The URL is a module value so a test can point it at a
# local server; the message names only its host.
TEST_CAPABILITY = "network:test"
TEST_URL = "https://www.w3.org/1999/02/22-rdf-syntax-ns"
TEST_MAX_BYTES = 2 * 1024 * 1024
TEST_TIMEOUT = 15.0

PROXY_MODES = ("system", "none", "manual")
DEFAULT_NO_PROXY = ("localhost", "127.0.0.1")

# The certificate file (5.5 item 3): at most 1 MB, at least one certificate,
# kept as PEM under one fixed name in the data folder.
CA_FILE_NAME = "network-ca.pem"
CA_MAX_BYTES = 1024 * 1024

CA_TOO_LARGE = (
    "That file is larger than 1 MB, so it is not a certificate file. Choose the "
    "certificate itself, a .pem, .crt or .cer file."
)
CA_NO_CERTIFICATE = (
    "That file holds no certificate Semantic Studio can read. Choose a .pem, "
    ".crt or .cer file exported from the certificate itself."
)
CA_PRIVATE_KEY = (
    "That file contains a private key, which has no place among trusted "
    "certificates. Choose a file that holds only the certificate."
)

CONNECTION_INVALID = "The connection settings were not saved. Correct the fields marked."


def blocked_detail(host: str) -> str:
    """The sentence for a remembered Block. Names the host and the way back."""
    return (
        f"You chose not to let Semantic Studio connect to {host}. "
        "You can change that in Network settings."
    )


# ---------------------------------------------------------------------------
# Refusals. Each carries the sentence the user sees; the HTTP status is chosen
# in main.py's exception handlers, so every route maps them the same way.
# ---------------------------------------------------------------------------


class NetworkDecision(Exception):
    """A request the policy stopped. Parsers must not treat this as "wrong
    format, try the next one" -- store._parse_rdf_blocking re-raises it."""


class Offline(NetworkDecision):
    def __init__(self) -> None:
        super().__init__(OFFLINE_DETAIL)


class HostBlocked(NetworkDecision):
    def __init__(self, host: str) -> None:
        super().__init__(blocked_detail(host))
        self.host = host


class ApprovalRequired(NetworkDecision):
    """No grant for this capability and host. Nothing has been sent."""

    def __init__(self, requests: list[dict]) -> None:
        super().__init__(f"Approval required to connect to {requests[0]['host']}.")
        self.requests = requests

    def body(self) -> dict:
        return {"code": "approval_required", "requests": self.requests}


class TooLarge(Exception):
    """The response passed max_bytes and was abandoned while reading."""

    def __init__(self, url: str, limit: int) -> None:
        super().__init__(f"{url} is larger than the {limit // (1024 * 1024)} MB limit.")
        self.url = url
        self.limit = limit


class FetchFailed(Exception):
    """The connection could not be made or completed (not an HTTP status)."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"Fetching {url} failed: {reason}")
        self.url = url
        self.reason = reason


class CertificateRefused(ValueError):
    """A certificate file that is not one. Carries the sentence shown."""


class ConnectionInvalid(ValueError):
    """Connection settings refused on Save, one sentence per field."""

    def __init__(self, fields: dict[str, str]) -> None:
        super().__init__(CONNECTION_INVALID)
        self.fields = fields

    def body(self) -> dict:
        return {"code": "invalid_connection", "message": CONNECTION_INVALID, "fields": self.fields}


class TooManyRedirects(FetchFailed):
    def __init__(self, url: str) -> None:
        Exception.__init__(
            self, f"That URL redirected more than {MAX_REDIRECTS} times and was not followed."
        )
        self.url = url


@dataclass
class BrokerResponse:
    url: str            # the final URL, after redirects and any https upgrade
    status: int
    headers: httpx.Headers
    body: bytes
    proxied: bool = False   # went through a proxy rather than direct and pinned


# ---------------------------------------------------------------------------
# The per-request grant scope.
# ---------------------------------------------------------------------------

# The just-once grant ids the current HTTP request presented. Empty outside a
# request, which is the right answer for anything that is not the retry of an
# approved action.
_presented: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar(
    "semantic_studio_presented_grants", default=frozenset()
)


def presented_grants() -> frozenset[str]:
    return _presented.get()


class GrantScopeMiddleware:
    """Reads X-Semantic-Studio-Grant into the request's context, and spends the
    just-once grants it named when the request ends -- whether or not the
    action used them, so a grant cannot outlive the retry it was issued for.

    Plain ASGI rather than BaseHTTPMiddleware, so the contextvar is set in the
    very context the route (and, through copy_context, the parse worker) runs
    in.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        ids: set[str] = set()
        for name, value in scope.get("headers", ()):
            if name.decode("latin-1").lower() == GRANT_HEADER:
                ids.update(p.strip() for p in value.decode("latin-1").split(",") if p.strip())
        if not ids:
            await self.app(scope, receive, send)
            return
        token = _presented.set(frozenset(ids))
        try:
            await self.app(scope, receive, send)
        finally:
            _presented.reset(token)
            broker.policy.spend(ids)


# ---------------------------------------------------------------------------
# Policy: remembered grants on disk, just-once grants in memory.
# ---------------------------------------------------------------------------


def normalize_host(host: str) -> str:
    """One spelling per host, so a grant for `Example.org.` covers `example.org`."""
    return host.strip().strip("[]").rstrip(".").lower()


# ---------------------------------------------------------------------------
# Connection settings (Stage 4): the shape stored in network-policy.json under
# `connection`, its validation, and the reading of a hand-edited file.
# ---------------------------------------------------------------------------

# One label of a host name; a proxy host is labels joined by dots, or an
# address literal. A scheme or a path is refused with its own sentence.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_NAME_RE = re.compile(rf"^{_LABEL}(?:\.{_LABEL})*$")


def default_connection() -> dict:
    return {
        "mode": "system",
        "https": {"host": "", "port": None},
        "http": {"host": "", "port": None},
        "noProxy": list(DEFAULT_NO_PROXY),
        "caFile": None,
    }


def _is_host(value: str) -> bool:
    if net_guard._literal_address(value) is not None and not value.isdigit():
        return True
    return len(value) <= 253 and bool(_NAME_RE.match(value.lower()))


def proxy_host_problem(host: str) -> Optional[str]:
    """The sentence for a proxy host that cannot be one, or None."""
    if not host:
        return "Enter the proxy's host name or address."
    if "://" in host:
        return "Enter the host name only, without http:// or https://."
    if "/" in host:
        return "Enter the host name only, without a path."
    if ":" in host and net_guard._literal_address(host) is None:
        return "Enter the port in its own field."
    if not _is_host(host):
        return "That is not a host name or an address."
    return None


def _port_value(port) -> Optional[int]:
    if isinstance(port, bool):
        return None
    if isinstance(port, int):
        return port if 1 <= port <= 65535 else None
    if isinstance(port, str) and port.strip().isdigit():
        return _port_value(int(port.strip()))
    return None


PORT_PROBLEM = "Enter a port from 1 to 65535."


def _bypass_entry_ok(entry: str) -> bool:
    # A leading dot or `*.` names every host under a domain, as browsers read it.
    bare = entry[2:] if entry.startswith("*.") else entry.lstrip(".")
    return bool(bare) and _is_host(bare)


def validate_connection(body: dict, saved: dict) -> dict:
    """The connection to store, or ConnectionInvalid naming every bad field.

    Only *Manual* reads the proxy fields; another mode keeps the saved ones
    untouched, so switching to No proxy with a half-typed host is never
    refused and never stores the half. The certificate file is not part of
    this body: it has routes of its own.
    """
    mode = body.get("mode")
    if mode not in PROXY_MODES:
        raise ConnectionInvalid({"mode": "Choose one of the three proxy settings."})
    result = copy.deepcopy(saved)
    result["mode"] = mode
    if mode != "manual":
        return result
    errors: dict[str, str] = {}
    https = body.get("https") or {}
    http = body.get("http") or {}
    https_host = str(https.get("host") or "").strip()
    http_host = str(http.get("host") or "").strip()
    problem = proxy_host_problem(https_host)
    if problem:
        errors["httpsHost"] = problem
    https_port = _port_value(https.get("port"))
    if https_port is None:
        errors["httpsPort"] = PORT_PROBLEM
    http_port_raw = http.get("port")
    http_port = None
    if http_host:
        problem = proxy_host_problem(http_host)
        if problem:
            errors["httpHost"] = problem
        http_port = _port_value(http_port_raw)
        if http_port is None:
            errors["httpPort"] = PORT_PROBLEM
    elif http_port_raw not in (None, ""):
        errors["httpHost"] = (
            "Enter the HTTP proxy's host, or leave both HTTP fields empty to use "
            "the HTTPS proxy."
        )
    entries = [str(e).strip() for e in (body.get("noProxy") or []) if str(e).strip()]
    bad = [e for e in entries if not _bypass_entry_ok(e)]
    if bad:
        errors["noProxy"] = (
            f"\u201c{bad[0][:80]}\u201d is not a host name. Separate host names with commas."
        )
    if errors:
        raise ConnectionInvalid(errors)
    result["https"] = {"host": https_host.lower(), "port": https_port}
    result["http"] = {"host": http_host.lower(), "port": http_port}
    result["noProxy"] = [e.lower() for e in entries]
    return result


def _read_connection(raw) -> dict:
    """A stored connection, each bad value replaced by its default.

    The file is the user's to edit by hand. A value that cannot be one falls
    back on its own, logged once per read, so a typo in a port costs that port
    and not the whole section; and a Manual with no usable HTTPS proxy is read
    as the default mode, never as "connect to nothing".
    """
    result = default_connection()
    if raw is None:
        return result
    bad: list[str] = []
    if not isinstance(raw, dict):
        log.warning("network-policy.json: connection is not an object; using the defaults")
        return result

    def pair(key: str) -> None:
        value = raw.get(key, result[key])
        host = value.get("host") if isinstance(value, dict) else None
        port = value.get("port") if isinstance(value, dict) else None
        if host in ("", None) and port is None:
            return
        if isinstance(host, str) and proxy_host_problem(host) is None and _port_value(port):
            result[key] = {"host": host.lower(), "port": _port_value(port)}
        else:
            bad.append(key)

    pair("https")
    pair("http")
    entries = raw.get("noProxy", result["noProxy"])
    if isinstance(entries, list) and all(isinstance(e, str) and _bypass_entry_ok(e) for e in entries):
        result["noProxy"] = [e.lower() for e in entries]
    else:
        bad.append("noProxy")
    ca = raw.get("caFile")
    if isinstance(ca, dict) and isinstance(ca.get("name"), str) and isinstance(ca.get("sha256"), str) \
            and re.fullmatch(r"[0-9a-f]{64}", ca["sha256"]):
        result["caFile"] = {"name": ca["name"], "sha256": ca["sha256"]}
    elif ca is not None:
        bad.append("caFile")
    mode = raw.get("mode", "system")
    if mode in PROXY_MODES and not (mode == "manual" and not result["https"]["host"]):
        result["mode"] = mode
    else:
        bad.append("mode")
    if bad:
        log.warning("network-policy.json: unreadable connection values %s; using their defaults", bad)
    return result


def certificate_pem(data: bytes) -> str:
    """The certificates in ``data`` as PEM text, or CertificateRefused.

    Read only as certificates, by the standard ssl module: PEM blocks are
    kept as they are, anything else is taken as DER and wrapped. Either way a
    throwaway context must load the result and hold at least one certificate.
    A private key is refused outright: a trust file has no use for one, and
    keeping it would put a secret in the data folder.
    """
    if len(data) > CA_MAX_BYTES:
        raise CertificateRefused(CA_TOO_LARGE)
    if b"PRIVATE KEY" in data:
        raise CertificateRefused(CA_PRIVATE_KEY)
    if b"-----BEGIN CERTIFICATE-----" in data:
        blocks = re.findall(
            rb"-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----", data
        )
        pem = "\n".join(b.decode("ascii") for b in blocks) + "\n"
    else:
        pem = ssl.DER_cert_to_PEM_cert(data)
    probe = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    try:
        probe.load_verify_locations(cadata=pem)
    except (ssl.SSLError, ValueError):
        raise CertificateRefused(CA_NO_CERTIFICATE) from None
    if probe.cert_store_stats().get("x509", 0) < 1:
        raise CertificateRefused(CA_NO_CERTIFICATE)
    return pem


def _system_trust() -> ssl.SSLContext:
    """The operating system's trust, or Python's own list where truststore
    cannot load. Both verify certificates and names; nothing here may not."""
    if truststore is not None:
        try:
            return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        except Exception:  # pragma: no cover - an unsupported platform
            pass
    return ssl.create_default_context()


def trust_source() -> str:
    """"system" when the operating system's certificates are trusted, else
    "python": the Connection section says which."""
    if truststore is None:
        return "python"
    try:
        truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:  # pragma: no cover - an unsupported platform
        return "python"
    return "system"


def _proxy_url(host: str, port: int) -> str:
    literal = f"[{host}]" if ":" in host else host
    return f"http://{literal}:{port}"


def _bypassed(host: str, entries: Iterable[str]) -> bool:
    for entry in entries:
        if entry.startswith("*."):
            entry = entry[1:]
        if entry.startswith("."):
            if host.endswith(entry) or host == entry[1:]:
                return True
        elif host == entry or host.endswith("." + entry):
            return True
    return False


def proxy_label(proxy: str) -> str:
    """A proxy as the person reads it: host and port, never a password a
    system proxy URL may carry (`http://user:secret@proxy:8080`)."""
    netloc = urlsplit(proxy).netloc
    return netloc.rpartition("@")[2]


def system_proxy(scheme: str = "https") -> Optional[str]:
    """The system's proxy URL for ``scheme``, read now, or None.

    On Windows getproxies() reads the proxy in Windows' settings; elsewhere
    the HTTPS_PROXY and HTTP_PROXY variables. Never cached: a laptop moving
    between the office and home changes it without telling anyone.
    """
    try:
        value = urllib.request.getproxies().get(scheme)
    except Exception:
        return None
    if not value:
        return None
    return value if "://" in value else "http://" + value


class NetworkPolicy:
    def __init__(self, path: Optional[Path]) -> None:
        self._path = path
        self._lock = threading.Lock()
        self.offline = False
        # (capability, host) -> grant. One remembered decision per pair: a new
        # one replaces the old, so Allow after Block is a change of mind rather
        # than a contradiction.
        self._remembered: dict[tuple[str, str], dict] = {}
        self._once: dict[str, tuple[dict, float]] = {}
        # Replaced whole, never changed in place, so a request reading it
        # mid-save sees the old settings or the new, not half of each.
        self.connection = default_connection()
        self._load()

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # A corrupt policy file is read as "nothing granted", never as
            # "everything allowed": the failure mode must be one more question,
            # not one fewer.
            return
        self.offline = bool(data.get("offline", False))
        self.connection = _read_connection(data.get("connection"))
        for grant in data.get("grants", []):
            try:
                key = (grant["capability"], grant["host"])
                if grant["decision"] in ("allow", "block") and key[0] in CAPABILITIES:
                    self._remembered[key] = grant
            except (KeyError, TypeError):
                continue

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "offline": self.offline,
            "grants": list(self._remembered.values()),
            "connection": self.connection,
        }
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        # Replace rather than rewrite, so a crash mid-write cannot leave half a
        # policy. On Windows a just-written file is briefly held by the indexer
        # or antivirus and the replace is refused; measured in this suite at
        # roughly one save in thirty. A short retry is the standard answer.
        for attempt in range(10):
            try:
                os.replace(tmp, self._path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.02)

    def snapshot(self) -> dict:
        with self._lock:
            return {"offline": self.offline, "grants": list(self._remembered.values())}

    def set_offline(self, offline: bool) -> None:
        with self._lock:
            self.offline = offline
            self._save()

    def set_connection(self, connection: dict) -> None:
        with self._lock:
            self.connection = connection
            self._save()

    def grant(self, capability: str, host: str, decision: str, remember: bool) -> dict:
        host = normalize_host(host)
        # A Block is a remembered refusal by definition. "Don't allow, just
        # this time" is simply not sending the request, which needs no record.
        remember = remember or decision == "block"
        entry = {
            "id": "grant-" + uuid.uuid4().hex[:12],
            "capability": capability,
            "host": host,
            "decision": decision,
            "remember": remember,
            "grantedAt": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            if remember:
                self._remembered[(capability, host)] = entry
                self._save()
            else:
                self._prune_once()
                self._once[entry["id"]] = (entry, time.monotonic())
        return entry

    def revoke(self, grant_id: str) -> bool:
        with self._lock:
            for key, entry in list(self._remembered.items()):
                if entry["id"] == grant_id:
                    del self._remembered[key]
                    self._save()
                    return True
            return self._once.pop(grant_id, None) is not None

    def spend(self, ids: Iterable[str]) -> None:
        with self._lock:
            for grant_id in ids:
                self._once.pop(grant_id, None)

    def _prune_once(self) -> None:
        now = time.monotonic()
        for grant_id, (_entry, at) in list(self._once.items()):
            if now - at > ONCE_GRANT_TTL_SECONDS:
                del self._once[grant_id]

    def decide(self, capability: str, host: str, presented: frozenset[str]) -> str:
        """"allow", "block" or "ask" for one capability and host.

        A remembered Block wins over a presented just-once Allow: the dialog is
        never shown for a blocked host, so a once-grant for one can only come
        from something other than the user answering it.
        """
        host = normalize_host(host)
        with self._lock:
            remembered = self._remembered.get((capability, host))
            if remembered is not None and remembered["decision"] == "block":
                return "block"
            if remembered is not None:
                return "allow"
            for grant_id in presented:
                held = self._once.get(grant_id)
                if held is None:
                    continue
                entry, at = held
                if time.monotonic() - at > ONCE_GRANT_TTL_SECONDS:
                    continue
                if entry["capability"] == capability and entry["host"] == host:
                    return "allow"
        return "ask"

    def clear(self) -> None:
        """Forget everything. For tests."""
        with self._lock:
            changed = self.offline or bool(self._remembered) or self.connection != default_connection()
            self.offline = False
            self.connection = default_connection()
            self._remembered.clear()
            self._once.clear()
            if changed:
                self._save()


# ---------------------------------------------------------------------------
# The activity log.
# ---------------------------------------------------------------------------


class ActivityLog:
    def __init__(self, path: Optional[Path]) -> None:
        self._path = path
        self._lock = threading.Lock()
        # Kept in memory too when there is no directory (unit tests).
        self._memory: list[dict] = []

    def append(self, entry: dict) -> None:
        with self._lock:
            if self._path is None:
                self._memory.append(entry)
                return
            self._path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if self._path.stat().st_size >= ACTIVITY_ROTATE_BYTES:
                    os.replace(self._path, self._path.with_suffix(".jsonl.1"))
            except FileNotFoundError:
                pass
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def latest(self, limit: int = ACTIVITY_DEFAULT_LIMIT) -> list[dict]:
        """Newest first. Reads the previous file only if the current one is short."""
        with self._lock:
            if self._path is None:
                return list(reversed(self._memory[-limit:])) if limit else []
            # Oldest first, current file last, so the tail is the newest.
            lines: list[str] = []
            for path in (self._path, self._path.with_suffix(".jsonl.1")):
                if len(lines) >= limit:
                    break
                try:
                    lines = path.read_text(encoding="utf-8").splitlines() + lines
                except FileNotFoundError:
                    continue
        entries: list[dict] = []
        for line in reversed(lines[-limit:] if limit else []):
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
        return entries

    def clear(self) -> None:
        with self._lock:
            self._memory.clear()
            if self._path is not None:
                for path in (self._path, self._path.with_suffix(".jsonl.1")):
                    path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# The broker.
# ---------------------------------------------------------------------------


def _host_of(url: str) -> str:
    return normalize_host(urlsplit(url).hostname or "")


def _pinned_url(url: str, address) -> tuple[str, str]:
    """The URL rewritten to connect to ``address``, and the Host header value.

    The path, query and port are kept; only the host part changes. The Host
    header carries the original name (and a non-default port), which is what
    the server's virtual hosting reads.
    """
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port
    literal = f"[{address}]" if address.version == 6 else str(address)
    netloc = f"{literal}:{port}" if port else literal
    host_header = f"[{host}]" if ":" in host else host
    if port:
        host_header = f"{host_header}:{port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, "")), host_header


class NetworkBroker:
    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.configure(data_dir)

    # The httpx transport. None is httpx's own, which is what runs. Tests set
    # an httpx.MockTransport to count how much of a streamed body was pulled,
    # which a real socket's buffering would hide.
    transport: Optional[httpx.BaseTransport] = None

    def configure(self, data_dir: Optional[Path]) -> None:
        self.data_dir = Path(data_dir) if data_dir else None
        self.policy = NetworkPolicy(self.data_dir / "network-policy.json" if self.data_dir else None)
        self.activity = ActivityLog(
            self.data_dir / "network-activity.jsonl" if self.data_dir else None
        )

    def reset(self) -> None:
        """Forget grants, offline, the connection settings and the log. For tests."""
        self.policy.clear()
        self.activity.clear()
        if self.data_dir is not None:
            (self.data_dir / CA_FILE_NAME).unlink(missing_ok=True)

    # --- connection settings (Stage 4) --------------------------------------

    def connection_view(self) -> dict:
        """The settings as the Connection section reads them, with what the
        system offers now and which certificates are trusted."""
        view = copy.deepcopy(self.policy.connection)
        found = system_proxy("https") or system_proxy("http")
        view["systemProxy"] = proxy_label(found) if found else None
        view["trust"] = trust_source()
        return view

    def save_connection(self, body: dict) -> dict:
        """Validate and store; ConnectionInvalid names each refused field."""
        self.policy.set_connection(validate_connection(body, self.policy.connection))
        return self.connection_view()

    def _ca_path(self) -> Optional[Path]:
        return self.data_dir / CA_FILE_NAME if self.data_dir else None

    def set_ca_file(self, data: bytes, name: str) -> dict:
        """Keep a certificate file, added to the trusted set from the next
        request. A DER file is stored as PEM; CertificateRefused otherwise."""
        pem = certificate_pem(data)
        path = self._ca_path()
        if path is None:
            raise RuntimeError("The broker has no data folder for a certificate file.")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(pem, encoding="ascii")
        os.replace(tmp, path)
        # Shown back in the panel: the last part of either kind of path, and
        # only plain characters, whatever the browser claimed.
        base = re.split(r"[\\/]", name or "")[-1]
        clean = re.sub(r"[^A-Za-z0-9 ._-]", "", base)[:100].strip() or "certificate.pem"
        connection = copy.deepcopy(self.policy.connection)
        connection["caFile"] = {"name": clean, "sha256": hashlib.sha256(data).hexdigest()}
        self.policy.set_connection(connection)
        return self.connection_view()

    def remove_ca_file(self) -> dict:
        path = self._ca_path()
        if path is not None:
            path.unlink(missing_ok=True)
        connection = copy.deepcopy(self.policy.connection)
        connection["caFile"] = None
        self.policy.set_connection(connection)
        return self.connection_view()

    def tls_context(self) -> ssl.SSLContext:
        """The trust for one request: the system's, plus the user's file.

        Built per request rather than cached, so a file added or removed is
        trusted or forgotten by the very next request, and no stale context
        can outlive a Remove. The file is added with load_verify_locations,
        which extends a context's trust and never replaces it.
        """
        context = _system_trust()
        path = self._ca_path()
        if self.policy.connection.get("caFile") and path is not None and path.exists():
            context.load_verify_locations(cafile=str(path))
        return context

    def _proxy_for(self, url: str) -> Optional[str]:
        """The proxy for ``url`` under the saved settings, or None for direct.

        Asked after the policy gate: on Windows and macOS the system bypass
        check can itself look a name up, which must not happen for a host the
        user has not approved.
        """
        connection = self.policy.connection
        mode = connection["mode"]
        if mode == "none":
            return None
        host = _host_of(url)
        scheme = urlsplit(url).scheme
        if mode == "manual":
            if _bypassed(host, connection["noProxy"]):
                return None
            pair = connection["http"] if scheme == "http" and connection["http"]["host"] else connection["https"]
            return _proxy_url(pair["host"], pair["port"])
        proxy = system_proxy(scheme)
        if proxy is None:
            return None
        try:
            if urllib.request.proxy_bypass(host):
                return None
        except Exception:
            pass
        if urlsplit(proxy).scheme not in ("http", "https"):
            raise FetchFailed(
                url,
                f"the system proxy ({urlsplit(proxy).scheme}://{proxy_label(proxy)}) is of a kind "
                "Semantic Studio cannot use",
            )
        return proxy

    # --- logging ----------------------------------------------------------

    def _log(self, capability: str, url: str, outcome: str, status: int = 0, size: int = 0) -> None:
        self.activity.append(
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "capability": capability,
                "url": url,
                "host": _host_of(url),
                "outcome": outcome,
                "status": status,
                "bytes": size,
                "encrypted": url.lower().startswith("https:"),
            }
        )

    # --- the gates --------------------------------------------------------

    def _judge_without_lookup(self, url: str, after_redirect: bool) -> str:
        """Gate 2: scheme, and any host that can be refused without DNS."""
        detail = net_guard.BLOCKED_REDIRECT_DETAIL if after_redirect else net_guard.BLOCKED_ADDRESS_DETAIL
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            raise net_guard.BlockedAddress(detail)
        host = _host_of(url)
        if not host:
            raise net_guard.BlockedAddress(detail)
        if host in _LOCAL_NAMES or host.endswith(_LOCAL_SUFFIXES):
            raise net_guard.BlockedAddress(detail)
        literal = net_guard._literal_address(host)
        if literal is not None and net_guard.is_blocked_address(literal):
            raise net_guard.BlockedAddress(detail)
        if literal is None and "." not in host:
            # A single-label name is an intranet name by definition (D-070).
            raise net_guard.BlockedAddress(detail)
        return host

    def _resolve_and_judge(self, host: str, after_redirect: bool):
        """Gate 4: every answer judged; the first is the one connected to."""
        detail = net_guard.BLOCKED_REDIRECT_DETAIL if after_redirect else net_guard.BLOCKED_ADDRESS_DETAIL
        try:
            addresses = net_guard.resolve_host(host)
        except net_guard.BlockedAddress:
            raise net_guard.BlockedAddress(
                detail if after_redirect else net_guard.UNRESOLVABLE_HOST_DETAIL
            ) from None
        if any(net_guard.is_blocked_address(ip) for ip in addresses):
            raise net_guard.BlockedAddress(detail)
        return addresses[0]

    def _judge_for_proxy(self, host: str, after_redirect: bool) -> None:
        """Gate 4 through a proxy (D-070): the name, resolved here, must not
        answer with any non-public address. A name this machine cannot look
        up is the proxy's to find, as it is for the browser on a network that
        resolves only through its proxy; its connection is still the proxy's
        to make, and the host was approved by name at gate 3."""
        detail = net_guard.BLOCKED_REDIRECT_DETAIL if after_redirect else net_guard.BLOCKED_ADDRESS_DETAIL
        try:
            addresses = net_guard.resolve_host(host)
        except net_guard.BlockedAddress:
            return
        if any(net_guard.is_blocked_address(ip) for ip in addresses):
            raise net_guard.BlockedAddress(detail)

    def check_url(self, url: str) -> str:
        """The host of ``url``, or BlockedAddress if gate 2 would refuse it.

        For a caller that must ask about several hosts at once before sending
        anything (a SERVICE query's endpoints): an address that can only be
        refused should be refused then, not put to the user as a question.
        """
        return self._judge_without_lookup(url, after_redirect=False)

    def decision_for(self, capability: str, host: str) -> str:
        """The policy's answer with no network involved. Timed by
        test_decision_overhead against the 1 ms budget."""
        if self.policy.offline:
            return "offline"
        return self.policy.decide(capability, host, presented_grants())

    # --- the request ------------------------------------------------------

    def request(
        self,
        capability: str,
        url: str,
        *,
        reason: str,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[bytes] = None,
        max_bytes: int,
        timeout: float,
        user_initiated: bool = False,
        total_timeout: Optional[float] = None,
    ) -> BrokerResponse:
        """``timeout`` is httpx's, per connect and per read. ``total_timeout``,
        when given, bounds the whole request across redirects and reads: a
        server that trickles one byte every few seconds never trips a per-read
        timeout, and a SERVICE call's 20 s is a wall-clock promise."""
        if capability not in CAPABILITIES and capability != TEST_CAPABILITY:
            raise ValueError(f"Unknown capability {capability!r}")
        deadline = None if total_timeout is None else time.monotonic() + total_timeout
        # Gate 1. Nothing is looked at, resolved or sent.
        if self.policy.offline:
            self._log(capability, url, "offline")
            raise Offline()

        first_host = _host_of(url)
        current = url
        previous_host: Optional[str] = None
        for hop in range(MAX_REDIRECTS + 1):
            after_redirect = hop > 0
            try:
                host = self._judge_without_lookup(current, after_redirect)
            except net_guard.BlockedAddress:
                self._log(capability, current, "refused")
                raise

            decision = self.policy.decide(capability, host, presented_grants())
            if decision == "ask" and user_initiated and host == first_host:
                # The typed URL is its own approval, for the host that was typed.
                decision = "allow"
            if decision == "block":
                self._log(capability, current, "blocked")
                raise HostBlocked(host)
            if decision == "ask" and capability == TEST_CAPABILITY:
                # A test that is sent elsewhere has its answer; it never asks.
                self._log(capability, current, "asked")
                raise FetchFailed(current, f"it was sent on to {host}")
            if decision == "ask":
                self._log(capability, current, "asked")
                why = reason
                if previous_host is not None:
                    why = f"{reason} {previous_host} redirected the request to this site."
                raise ApprovalRequired(
                    [
                        {
                            "capability": capability,
                            "host": host,
                            "url": current,
                            "reason": why,
                            "sends": CAPABILITIES[capability]["sends"],
                            "encrypted": current.lower().startswith("https:"),
                        }
                    ]
                )

            try:
                proxy = self._proxy_for(current)
            except FetchFailed:
                self._log(capability, current, "failed")
                raise
            try:
                if proxy is None:
                    address = self._resolve_and_judge(host, after_redirect)
                else:
                    address = None
                    self._judge_for_proxy(host, after_redirect)
            except net_guard.BlockedAddress:
                self._log(capability, current, "refused")
                raise

            response = self._send(
                capability, current, address, proxy, method, headers, body, max_bytes,
                _remaining(timeout, deadline, current), deadline,
            )
            if response.status in _REDIRECT_CODES:
                location = response.headers.get("location")
                if not location:
                    raise FetchFailed(current, "redirect without a location")
                previous_host = host
                # A Location may be relative to the URL that sent it.
                current = urljoin(response.url, location)
                # A redirect after a POST is followed as a GET, as browsers do.
                if response.status in (301, 302, 303):
                    method, body = "GET", None
                continue
            return response
        raise TooManyRedirects(url)

    def _send(
        self, capability, url, address, proxy, method, headers, body, max_bytes, timeout,
        deadline=None,
    ) -> BrokerResponse:
        parts = urlsplit(url)
        if parts.scheme == "http" and parts.port is None:
            # Open question 2: try the encrypted form first, same host, same
            # pinned address or the same proxy. Only a failure to connect falls
            # back; an HTTPS server that answers, even with an error, is the
            # answer.
            upgraded = urlunsplit(("https",) + tuple(parts[1:]))
            try:
                return self._send_once(
                    capability, upgraded, address, proxy, method, headers, body, max_bytes,
                    httpx.Timeout(timeout, connect=min(timeout, UPGRADE_CONNECT_TIMEOUT)),
                    deadline,
                )
            except FetchFailed:
                pass
            timeout = _remaining(timeout, deadline, url)
        return self._send_once(
            capability, url, address, proxy, method, headers, body, max_bytes,
            httpx.Timeout(timeout), deadline,
        )

    def _send_once(
        self, capability, url, address, proxy, method, headers, body, max_bytes, timeout,
        deadline=None,
    ) -> BrokerResponse:
        request_headers = dict(headers or {})
        extensions = {}
        if proxy is None:
            target, request_headers["Host"] = _pinned_url(url, address)
            if url.lower().startswith("https:"):
                # Certificate checking validates against this name, not against
                # the address in the URL, so pinning costs no TLS assurance.
                extensions["sni_hostname"] = _host_of(url)
        else:
            # Through a proxy the original URL goes as it is: the proxy
            # resolves and connects, and asks for `CONNECT host:443`. A pinned
            # address here would show the proxy an IP for a name, and a TLS
            # name carried by hand would be checked against nothing (D-070).
            target = url
        received = 0
        try:
            # trust_env=False: the proxy is the one chosen above, never one
            # httpx finds for itself. verify is always a context that checks.
            with httpx.Client(
                transport=self.transport if proxy is None else None,
                proxy=proxy,
                verify=self.tls_context(),
                trust_env=False,
                follow_redirects=False,
                timeout=timeout,
            ) as client:
                with client.stream(
                    method, target, headers=request_headers, content=body, extensions=extensions
                ) as response:
                    if response.status_code in _REDIRECT_CODES:
                        self._log(capability, url, "redirect", response.status_code)
                        return BrokerResponse(
                            url, response.status_code, response.headers, b"", proxy is not None
                        )
                    declared = response.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        self._log(capability, url, "too-large", response.status_code)
                        raise TooLarge(url, max_bytes)
                    chunks: list[bytes] = []
                    # With a deadline, take bytes as they arrive: a 64 KB chunk
                    # is buffered until full, so a server dripping a few bytes
                    # at a time would never reach the deadline check below.
                    pieces = (
                        response.iter_bytes()
                        if deadline is not None
                        else response.iter_bytes(64 * 1024)
                    )
                    for chunk in pieces:
                        received += len(chunk)
                        if received > max_bytes:
                            # Abandoned: the connection closes on exit and the
                            # rest is never pulled into this process.
                            self._log(capability, url, "too-large", response.status_code, received)
                            raise TooLarge(url, max_bytes)
                        chunks.append(chunk)
                        if deadline is not None and time.monotonic() > deadline:
                            self._log(capability, url, "timeout", response.status_code, received)
                            raise FetchFailed(url, "it took longer than the time allowed")
                    outcome = "ok" if response.status_code < 400 else "http-error"
                    self._log(capability, url, outcome, response.status_code, received)
                    return BrokerResponse(
                        url, response.status_code, response.headers, b"".join(chunks),
                        proxy is not None,
                    )
        except httpx.HTTPError as exc:
            self._log(capability, url, "failed", 0, received)
            raise FetchFailed(url, str(exc) or type(exc).__name__) from exc

    # --- Test connection (Stage 4, 5.5 item 5) -----------------------------

    def test_connection(self) -> dict:
        """Fetch the RDF vocabulary through the saved settings and say which
        stage failed, if one did: {ok, stage, message}."""
        site = _host_of(TEST_URL)
        try:
            response = self.request(
                TEST_CAPABILITY, TEST_URL, reason="Test connection",
                max_bytes=TEST_MAX_BYTES, timeout=TEST_TIMEOUT, user_initiated=True,
            )
        except Offline:
            return {"ok": False, "stage": "offline", "message": TEST_OFFLINE}
        except FetchFailed as exc:
            try:
                proxy = self._proxy_for(TEST_URL)
            except FetchFailed:
                # The system offers a proxy of a kind httpx cannot speak.
                return {"ok": False, "stage": "proxy", "message": f"{exc.reason[:1].upper()}{exc.reason[1:]}."}
            return _failed_stage(exc, proxy, site)
        except (NetworkDecision, net_guard.BlockedAddress, TooLarge) as exc:
            return {"ok": False, "stage": "http", "message": _site_message(site, str(exc))}
        if response.status >= 400:
            return {
                "ok": False, "stage": "http",
                "message": _site_message(site, f"it answered with status {response.status}"),
            }
        message = (
            "Connected through the proxy. Certificate trusted."
            if response.proxied
            else "Connected directly. Certificate trusted."
        )
        return {"ok": True, "stage": None, "message": message}


TEST_OFFLINE = "Semantic Studio is working offline."


def _site_message(site: str, reason: str) -> str:
    return f"Could not reach {site} ({reason.rstrip('.')}). Check that you are online."


def _causes(exc: BaseException) -> list[BaseException]:
    seen: list[BaseException] = []
    current: Optional[BaseException] = exc
    while current is not None and current not in seen:
        seen.append(current)
        current = current.__cause__ or current.__context__
    return seen


def _failed_stage(exc: FetchFailed, proxy: Optional[str], site: str) -> dict:
    """Which of 5.5 item 5's sentences a failed test earns.

    httpx folds a certificate failure into ConnectError, so the chain is read
    for the ssl error itself; a refused CONNECT is httpx's ProxyError, whose
    text starts with the proxy's status code.
    """
    chain = _causes(exc)
    if any(isinstance(e, ssl.SSLCertVerificationError) for e in chain):
        return {
            "ok": False, "stage": "tls",
            "message": (
                "The site's certificate was not trusted. Ask IT for the company's "
                "root certificate file and add it here."
            ),
        }
    refused = next((e for e in chain if isinstance(e, httpx.ProxyError)), None)
    if refused is not None:
        status = re.match(r"\s*(\d{3})", str(refused))
        said = f" (status {status.group(1)})" if status else ""
        return {"ok": False, "stage": "proxy", "message": f"The proxy refused the connection{said}."}
    if proxy is not None and any(isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)) for e in chain):
        where = proxy_label(proxy)
        return {
            "ok": False, "stage": "proxy",
            "message": f"Could not reach the proxy at {where}. Check the address and port.",
        }
    return {"ok": False, "stage": "http", "message": _site_message(site, exc.reason)}


def _remaining(timeout: float, deadline: Optional[float], url: str) -> float:
    """The per-step timeout, shortened to what is left of the deadline."""
    if deadline is None:
        return timeout
    left = deadline - time.monotonic()
    if left <= 0:
        raise FetchFailed(url, "it took longer than the time allowed")
    return min(timeout, left)


# The process-wide broker. Configured with the store's data directory by
# store.py, which is the one module that knows where that is.
broker = NetworkBroker()
