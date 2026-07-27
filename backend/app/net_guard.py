"""
================================================================================
FILE: backend/app/net_guard.py
================================================================================

SUMMARY
    Decides whether the server is allowed to make an outbound HTTP request to a
    URL the user supplied. The rule is a deny rule on address ranges, not an
    allowlist of hosts: the application's whole purpose is fetching arbitrary
    public ontology URLs, so anything host-based would break the product.

BASIC IDEA
    Two functions, deliberately separable so the judgement can be unit-tested
    without HTTP. `is_blocked_address` judges one already-resolved address.
    `assert_url_fetchable` takes a URL, resolves its host to *every* address the
    system resolver returns, and refuses if any single one of them is blocked --
    checking one address and then connecting to another is a hole.

    Two details carry most of the weight, and both are easy to get wrong:

      * An address that is not "blocked" by any of the six named flags may still
        not be a public destination. 100.64.0.0/10 (carrier-grade NAT) trips
        none of them. So a public address must ALSO be `is_global`. The reverse
        also holds: multicast reports `is_global` as true, so `is_global` on its
        own is not sufficient either. Both checks are required.
      * An IPv4 address embedded in an IPv6 one must be judged as the IPv4
        address it really is. On Python before 3.11.10 `::ffff:127.0.0.1`
        reports `is_loopback` as False; newer versions unwrap it themselves.
        Unwrapping here makes the answer the same on every supported version.

    Redirects are not followed automatically anywhere in the application. The
    caller follows them in a loop and calls back in for each new location, which
    is what makes "checked again after every hop" true rather than aspirational.

INPUTS / INPUT SOURCES
    - A URL string supplied by the user, via POST /api/ontologies/fetch.
    - The system resolver, through socket.getaddrinfo.

EXPECTED OUTPUT
    - None, when the URL may be fetched.
    - Raises BlockedAddress, carrying a message written for the person who
      typed the URL, which the router turns into an HTTP 400 detail.
================================================================================
"""

from __future__ import annotations

import ipaddress
import os
import socket
import urllib.request
from io import BytesIO
from typing import Union
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse
from urllib.response import addinfourl

IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

# How many redirect hops the fetch loop will follow before giving up. Five is
# enough for the raw.githubusercontent -> CDN hops the application relies on.
MAX_REDIRECTS = 5

# The three refusal messages. They are module constants rather than inline
# strings so a test can enumerate every message this module can produce and
# assert none of them talks about attacks -- see MSG-1 in the specification.
# Each one names what was refused and what to do instead.
BLOCKED_ADDRESS_DETAIL = (
    "That address is not reachable from Semantic Studio. Only public web "
    "addresses can be fetched. To load a file from a local or internal server, "
    "download it and use the Local file tab."
)

BLOCKED_REDIRECT_DETAIL = (
    "That URL redirected to an address Semantic Studio will not fetch."
)

UNRESOLVABLE_HOST_DETAIL = (
    "That host name could not be looked up, so Semantic Studio did not try to "
    "reach it. Check the address for a typo, or download the file and use the "
    "Local file tab."
)

ALL_REFUSAL_MESSAGES = (
    BLOCKED_ADDRESS_DETAIL,
    BLOCKED_REDIRECT_DETAIL,
    UNRESOLVABLE_HOST_DETAIL,
)


class BlockedAddress(Exception):
    """The URL may not be fetched. Carries the message shown to the user."""


def is_blocked_address(ip: IPAddress) -> bool:
    """True if ``ip`` is not a public unicast address we will connect to.

    Refuses loopback, private, link-local, multicast, reserved and unspecified
    ranges in both families, and anything the standard library does not
    consider globally routable.
    """
    # Judge an IPv4 address embedded in an IPv6 one as the IPv4 address it is.
    # ::ffff:127.0.0.1 is loopback no matter which family it is written in.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # 6to4 (2002::/16) and Teredo (2001::/32) also carry an IPv4 address that
    # decides where the packet really goes. Python already reports both as
    # non-global, but judging the embedded address keeps the reason honest.
    sixtofour = getattr(ip, "sixtofour", None)
    if sixtofour is not None:
        ip = sixtofour
    teredo = getattr(ip, "teredo", None)
    if teredo is not None:
        # (server, client) -- the server address is the one connected to.
        ip = teredo[0]

    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    # Catches ranges that trip none of the flags above but are still not public
    # destinations, 100.64.0.0/10 being the one that actually turns up.
    return not ip.is_global


def _literal_address(host: str) -> IPAddress | None:
    """Parse ``host`` as an address literal, or return None if it is a name.

    Handles the bare-integer form (``http://2130706433/``) explicitly. Glibc
    resolves that to 127.0.0.1 while the Windows resolver refuses it outright,
    so leaving it to the resolver would make the guard's behaviour depend on
    the operating system.
    """
    # urlparse strips the brackets from an IPv6 literal, but be tolerant.
    candidate = host.strip("[]")
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        pass
    if candidate.isdigit():
        try:
            return ipaddress.ip_address(int(candidate))
        except ValueError:
            return None
    return None


def resolve_host(host: str) -> list[IPAddress]:
    """Every address ``host`` resolves to, or raise BlockedAddress if none do.

    A literal address short-circuits the resolver. For a name, every address in
    the getaddrinfo result is returned: a name can resolve to several, and
    judging only the first is the hole this function exists to close.
    """
    literal = _literal_address(host)
    if literal is not None:
        return [literal]
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        # A lookup failure is a refusal, not a reason to try connecting anyway.
        raise BlockedAddress(UNRESOLVABLE_HOST_DETAIL) from exc
    addresses: list[IPAddress] = []
    seen: set[str] = set()
    for info in infos:
        raw = info[4][0]
        if raw in seen:
            continue
        seen.add(raw)
        try:
            # A link-local IPv6 address arrives with a %scope suffix that
            # ip_address does not accept.
            addresses.append(ipaddress.ip_address(raw.split("%", 1)[0]))
        except ValueError:
            continue
    if not addresses:
        raise BlockedAddress(UNRESOLVABLE_HOST_DETAIL)
    return addresses


def assert_url_fetchable(url: str, *, after_redirect: bool = False) -> None:
    """Raise BlockedAddress unless every address ``url``'s host resolves to is public.

    ``after_redirect`` only changes the message: someone who pasted a
    legitimate public URL deserves to be told the redirect was the problem
    rather than being told their URL was wrong.
    """
    detail = BLOCKED_REDIRECT_DETAIL if after_redirect else BLOCKED_ADDRESS_DETAIL
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise BlockedAddress(detail)
    host = (parsed.hostname or "").strip()
    if not host:
        raise BlockedAddress(detail)
    try:
        addresses = resolve_host(host)
    except BlockedAddress:
        # A lookup failure after a redirect is still a redirect problem.
        raise BlockedAddress(detail if after_redirect else UNRESOLVABLE_HOST_DETAIL) from None
    # Every address, not just the first: one blocked address blocks the URL.
    if any(is_blocked_address(ip) for ip in addresses):
        raise BlockedAddress(detail)


# ---------------------------------------------------------------------------
# The guard for requests rdflib makes on its own, while parsing.
#
# A JSON-LD document can name a remote @context, and rdflib dereferences it
# during the parse. That request is made by the parser, not by the fetch
# endpoint, so nothing above ever sees it: the document decides where the
# server connects. Since the file arrives by upload as often as by URL, this
# is reachable without the user typing an address at all.
#
# The fix is placed at rdflib's single network chokepoint rather than at the
# JSON-LD plugin, so a parser nobody has examined yet is covered too.
# ---------------------------------------------------------------------------

# Shares SEMANTIC_STUDIO_MAX_FETCH_BYTES with the fetch endpoint deliberately:
# both are "bytes pulled from a URL over HTTP", and two numbers for one idea
# would drift. The default is repeated here rather than imported because the
# router imports this module, not the other way round.
_DEFAULT_MAX_BYTES = 50 * 1024 * 1024


def _max_fetch_bytes() -> int:
    raw = os.environ.get("SEMANTIC_STUDIO_MAX_FETCH_BYTES")
    if raw and raw.isdigit() and int(raw) > 0:
        return int(raw)
    return _DEFAULT_MAX_BYTES


MAX_FETCH_BYTES = _max_fetch_bytes()

# Not configurable, and not the parse timeout. The parse timeout releases the
# *request*; it cannot stop the worker, so without a socket timeout a hanging
# context server would pin a thread indefinitely. D-013 accepted abandoned
# parse work only because the upload cap bounds it, and an unbounded network
# wait would quietly break that reasoning.
CONTEXT_SOCKET_TIMEOUT = 30.0

CONTEXT_REFUSED_DETAIL = (
    "This file asks Semantic Studio to load part of its definition from {url}, "
    "which is not a public web address. Load a copy that has the context "
    "written into it, or convert the file to Turtle."
)

CONTEXT_TOO_LARGE_DETAIL = (
    "This file asks Semantic Studio to load part of its definition from {url}, "
    "and that resource is larger than the {mb} MB limit."
)


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Makes urllib surface a redirect instead of quietly following it.

    Returning None from redirect_request leaves the 3xx unhandled, so the
    default error handler raises HTTPError and the caller can judge the new
    location before deciding to go there.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# build_opener replaces the default redirect handler with our subclass.
_opener = urllib.request.build_opener(_NoRedirects)

_REDIRECT_CODES = (301, 302, 303, 307, 308)


def guarded_urlopen(request: urllib.request.Request) -> addinfourl:
    """Drop-in replacement for ``rdflib._networking._urlopen``.

    Judges the address before every connection, follows redirects by hand so
    each hop is judged too, and reads the body under a cap. Returns the same
    kind of object rdflib expects, with the body already buffered.

    Following redirects by hand is the whole point. ``urlopen`` follows them
    internally, so checking only the URL rdflib was given lets a public context
    redirect straight to loopback -- verified, and the reason this is not a
    two-line wrapper.
    """
    url = request.full_url
    # Carry rdflib's headers (its Accept negotiation matters) across hops.
    headers = dict(request.headers)

    for hop in range(MAX_REDIRECTS + 1):
        try:
            assert_url_fetchable(url, after_redirect=hop > 0)
        except BlockedAddress as exc:
            raise BlockedAddress(CONTEXT_REFUSED_DETAIL.format(url=url)) from exc

        try:
            response = _opener.open(
                urllib.request.Request(url, None, headers),
                timeout=CONTEXT_SOCKET_TIMEOUT,
            )
        except HTTPError as error:
            if error.code in _REDIRECT_CODES:
                location = error.headers.get("Location")
                if location:
                    # A Location may be relative to the URL that sent it.
                    url = urljoin(url, location)
                    continue
            raise

        with response:
            # Read in chunks so an oversized body is abandoned rather than
            # measured after the fact.
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FETCH_BYTES:
                    raise BlockedAddress(
                        CONTEXT_TOO_LARGE_DETAIL.format(
                            url=url, mb=MAX_FETCH_BYTES // (1024 * 1024)
                        )
                    )
                chunks.append(chunk)
            body = b"".join(chunks)
            # rdflib reads the stream and asks for .geturl(), .headers and
            # .info(); addinfourl over the buffered body provides all three.
            return addinfourl(BytesIO(body), response.headers, url, response.status)

    raise BlockedAddress(
        f"That file's context URL redirected more than {MAX_REDIRECTS} times "
        "and was not followed."
    )


def install_rdflib_guard() -> None:
    """Route every request rdflib makes through ``guarded_urlopen``.

    rdflib reads the network in exactly one place, ``_networking._urlopen``,
    called from the two ``URLInputSource`` sites in ``rdflib/parser.py``. Both
    module attributes are replaced because ``parser`` imports the name directly,
    so patching only ``_networking`` would leave the live reference untouched.

    This patches a private function of a third-party library, which is a real
    cost and is recorded as decision D-016. A test asserts the attribute still
    exists, so an rdflib upgrade that moves it fails the suite rather than
    silently removing the guard.
    """
    import rdflib._networking
    import rdflib.parser

    rdflib._networking._urlopen = guarded_urlopen
    rdflib.parser._urlopen = guarded_urlopen
