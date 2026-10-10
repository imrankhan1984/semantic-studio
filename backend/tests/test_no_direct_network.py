"""
================================================================================
FILE: backend/tests/test_no_direct_network.py
================================================================================

SUMMARY
    Enforces "one door to the internet" (external-access AC-5, D-066): no
    backend module other than network_broker.py and net_guard.py imports a
    network client or opens a socket. A second egress path is how the parser's
    JSON-LD fetch went unnoticed until S-4, and a scan is the only thing that
    notices one before a reviewer has to.

BASIC IDEA
    Reads every .py file under backend/app as text and looks for imports of
    httpx, requests, urllib.request, http.client, urllib3, aiohttp or socket,
    in both `import x` and `from x import y` forms, and for the socket-opening
    calls themselves. The same model as the frontend's no-raw-html.test.ts.

    The scan is proved able to see before it is trusted: it is run over a
    planted sample of every forbidden form and must flag each one, and the
    file list must be non-empty and include the two exempt files -- a scan of
    nothing passes vacuously.

INPUTS / INPUT SOURCES
    - The source files of backend/app.

EXPECTED OUTPUT
    - Pass/fail, naming the file and line of any violation.
================================================================================
"""

from __future__ import annotations

import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"
ALLOWED = {"network_broker.py", "net_guard.py"}

_CLIENTS = r"(?:httpx|requests|urllib3|aiohttp|socket|http\.client|urllib\.request)"
FORBIDDEN = [
    re.compile(rf"^\s*import\s+{_CLIENTS}\b", re.M),
    re.compile(rf"^\s*from\s+{_CLIENTS}\b", re.M),
    re.compile(r"^\s*from\s+urllib\s+import\s+[^\n]*\brequest\b", re.M),
    re.compile(r"^\s*from\s+http\s+import\s+[^\n]*\bclient\b", re.M),
    re.compile(r"\b(?:create_connection|socket\.socket|urlopen)\s*\(", re.M),
    re.compile(r"__import__\(\s*['\"]" + _CLIENTS, re.M),
    re.compile(r"import_module\(\s*['\"]" + _CLIENTS, re.M),
]


def violations(source: str) -> list[str]:
    found = []
    for pattern in FORBIDDEN:
        for match in pattern.finditer(source):
            line = source.count("\n", 0, match.start()) + 1
            found.append(f"line {line}: {match.group(0).strip()}")
    return found


def test_the_scan_sees_every_forbidden_form():
    planted = [
        "import httpx",
        "import requests",
        "import urllib.request",
        "from urllib import request",
        "from urllib.request import urlopen",
        "import http.client",
        "from http import client",
        "import socket",
        "    from aiohttp import ClientSession",
        "conn = create_connection(('x', 80))",
        "__import__('httpx')",
        "importlib.import_module('socket')",
    ]
    for line in planted:
        assert violations(line + "\n"), f"the scan missed: {line}"
    # And it does not cry wolf at the imports the application really uses.
    for line in ("from urllib.parse import urlparse", "from urllib.error import HTTPError"):
        assert not violations(line + "\n"), line


def test_only_the_broker_and_the_guard_reach_the_network():
    files = sorted(APP_DIR.rglob("*.py"))
    names = {f.name for f in files}
    assert len(files) > 10 and ALLOWED <= names, "the scan did not find the app's source"
    offenders = []
    for path in files:
        if path.name in ALLOWED and path.parent == APP_DIR:
            continue
        for hit in violations(path.read_text(encoding="utf-8")):
            offenders.append(f"{path.relative_to(APP_DIR.parent)} {hit}")
    assert offenders == [], "\n".join(offenders)


# The reasoner (axioms-and-reasoning Section 9): its two modules are named,
# so a rename cannot drop them from the scan above unnoticed, and OWL-RL is
# imported by them alone. The worker runs in a process of its own, where the
# broker's guards are not installed, so OWL-RL's own source is scanned too:
# Section 9 says it fetches nothing, and this is where that stays true.
REASONER = ("reasoning.py", "reasoning_worker.py")


def test_the_reasoner_modules_are_scanned_and_reach_no_network():
    for name in REASONER:
        path = APP_DIR / name
        assert path.exists(), name
        source = path.read_text(encoding="utf-8")
        assert "import" in source and violations(source) == [], name


def test_only_the_reasoner_imports_owlrl():
    importing = sorted(
        path.name for path in APP_DIR.rglob("*.py")
        if re.search(r"^\s*(?:import|from)\s+owlrl\b", path.read_text(encoding="utf-8"), re.M)
    )
    assert importing == ["reasoning_worker.py"]


def test_owlrl_itself_holds_no_network_client():
    import owlrl

    files = sorted(Path(owlrl.__file__).parent.rglob("*.py"))
    assert len(files) > 5
    offenders = [f"{path.name} {hit}" for path in files for hit in violations(path.read_text(encoding="utf-8"))]
    assert offenders == []
