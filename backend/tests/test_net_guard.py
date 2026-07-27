"""
================================================================================
FILE: backend/tests/test_net_guard.py
================================================================================

SUMMARY
    Unit tests for the address judgement in app/net_guard.py. Covers UNIT-1 of
    the network-and-resource-limits specification: a table of roughly twenty
    addresses across both families, plus the host resolution helper.

BASIC IDEA
    The judgement is deliberately separable from HTTP so it can be tested
    without a socket. Everything here is a pure function call. The interesting
    cases are the ones that do not follow from a single flag: carrier-grade NAT
    trips none of the six named ranges, multicast reports itself as global, and
    an IPv4 address embedded in an IPv6 one has to be judged as the IPv4
    address it really is.

INPUTS / INPUT SOURCES
    - Address literals, as strings, parsed with ipaddress.
    - A stubbed socket.getaddrinfo for the resolution cases.

EXPECTED OUTPUT
    - Pass/fail per assertion. A failure here means the deny rule has a hole,
      which is the whole of AC-1 and AC-3.
================================================================================
"""

import ipaddress
import socket

import pytest

from app.net_guard import (
    ALL_REFUSAL_MESSAGES,
    BlockedAddress,
    assert_url_fetchable,
    is_blocked_address,
    resolve_host,
)

# Every address the deny rule must refuse, with the reason it exists in the
# table. Grouped by family so a gap in one is visible against the other.
BLOCKED = [
    ("127.0.0.1", "IPv4 loopback"),
    ("127.1.2.3", "the rest of 127/8, not just .0.1"),
    ("10.0.0.1", "RFC1918 private"),
    ("172.16.0.1", "RFC1918 private, the range people forget"),
    ("192.168.1.1", "RFC1918 private"),
    ("169.254.169.254", "cloud metadata, the one that returns credentials"),
    ("169.254.0.1", "IPv4 link-local generally"),
    ("224.0.0.1", "IPv4 multicast: reports is_global as True"),
    ("239.255.255.250", "SSDP multicast"),
    ("240.0.0.1", "reserved"),
    ("255.255.255.255", "broadcast"),
    ("0.0.0.0", "unspecified"),
    ("100.64.0.1", "carrier-grade NAT: trips none of the six named flags"),
    ("::1", "IPv6 loopback"),
    ("fe80::1", "IPv6 link-local"),
    ("fc00::1", "IPv6 unique local"),
    ("fd00::abcd", "IPv6 unique local, the fd half"),
    ("ff02::1", "IPv6 multicast: also reports is_global as True"),
    ("::", "IPv6 unspecified"),
    ("::ffff:127.0.0.1", "IPv4-mapped loopback, the unwrap case"),
    ("::ffff:10.0.0.1", "IPv4-mapped private"),
    ("::ffff:169.254.169.254", "IPv4-mapped metadata address"),
    ("2002:7f00:1::", "6to4 wrapping 127.0.0.1"),
]

# Addresses that must keep working, because refusing these would break the
# application's actual purpose.
ALLOWED = [
    ("8.8.8.8", "public DNS"),
    ("93.184.216.34", "a plain public web server"),
    ("140.82.121.4", "github.com"),
    ("2001:4860:4860::8888", "public IPv6"),
    ("2606:2800:220:1:248:1893:25c8:1946", "public IPv6 web server"),
]


@pytest.mark.parametrize("address,reason", BLOCKED, ids=[a for a, _ in BLOCKED])
def test_blocked_addresses_are_refused(address, reason):
    assert is_blocked_address(ipaddress.ip_address(address)), reason


@pytest.mark.parametrize("address,reason", ALLOWED, ids=[a for a, _ in ALLOWED])
def test_public_addresses_are_allowed(address, reason):
    assert not is_blocked_address(ipaddress.ip_address(address)), reason


def test_integer_form_host_is_refused_without_the_resolver():
    """http://2130706433/ is 127.0.0.1 written as an integer.

    glibc resolves it; the Windows resolver refuses it outright. Decoding it
    here rather than leaving it to getaddrinfo is what makes the answer the
    same on both.
    """
    with pytest.raises(BlockedAddress):
        assert_url_fetchable("http://2130706433/onto.ttl")


def test_literal_address_does_not_touch_the_resolver(monkeypatch):
    def explode(*args, **kwargs):
        raise AssertionError("getaddrinfo called for an address literal")

    monkeypatch.setattr(socket, "getaddrinfo", explode)
    assert resolve_host("127.0.0.1") == [ipaddress.ip_address("127.0.0.1")]
    assert resolve_host("[::1]") == [ipaddress.ip_address("::1")]


def test_resolution_failure_is_a_refusal(monkeypatch):
    """A name that does not resolve is refused, not attempted anyway."""

    def fail(*args, **kwargs):
        raise socket.gaierror(-2, "Name or service not known")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with pytest.raises(BlockedAddress):
        resolve_host("no-such-host.invalid")


def test_every_resolved_address_is_judged(monkeypatch):
    """AC-4: one blocked address among several blocks the whole URL.

    Judging only the first result and connecting to another is the hole this
    closes, so the private address is deliberately second.
    """
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [
            ipaddress.ip_address("93.184.216.34"),
            ipaddress.ip_address("10.0.0.5"),
        ],
    )
    with pytest.raises(BlockedAddress):
        assert_url_fetchable("https://split-horizon.example/onto.ttl")


def test_all_public_addresses_pass(monkeypatch):
    monkeypatch.setattr(
        "app.net_guard.resolve_host",
        lambda host: [
            ipaddress.ip_address("93.184.216.34"),
            ipaddress.ip_address("2606:2800:220:1:248:1893:25c8:1946"),
        ],
    )
    assert assert_url_fetchable("https://example.org/onto.ttl") is None


def test_non_http_scheme_is_refused():
    for url in ("ftp://example.org/f.ttl", "file:///etc/passwd", "gopher://example.org/"):
        with pytest.raises(BlockedAddress):
            assert_url_fetchable(url)


def test_refusal_messages_are_actionable_and_calm():
    """MSG-1, applied to the messages this module owns.

    Every refusal names a next step, and none of them talks to the user about
    security. A newcomer meets these by accident, not by intent.
    """
    forbidden = ("vulnerability", "attack", "forgery", "ssrf", "malicious")
    for message in ALL_REFUSAL_MESSAGES:
        lowered = message.lower()
        for word in forbidden:
            assert word not in lowered, f"{word!r} appears in: {message}"
        assert "semantic studio" in lowered
    # The two the user is most likely to hit point at the way forward.
    assert "Local file tab" in ALL_REFUSAL_MESSAGES[0]
    assert "Local file tab" in ALL_REFUSAL_MESSAGES[2]
