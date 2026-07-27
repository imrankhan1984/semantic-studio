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
import socket
from typing import Union
from urllib.parse import urlparse

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
