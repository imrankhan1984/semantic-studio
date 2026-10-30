"""
================================================================================
FILE: backend/tests/test_deployment_binding.py
================================================================================

SUMMARY
    Proves the Docker deployment publishes its port on the loopback interface
    only, so a machine running the container on a shared network does not serve
    its whole ontology library to that network. Covers backlog S-5 / decision
    D-028 (the application is single-user and localhost-only, and the *binding*
    is what enforces it rather than a sentence in a document).

BASIC IDEA
    The defect this file guards against is a configuration one — a port mapping
    of "8000:8000" carries no host interface, and Docker reads a missing
    interface as 0.0.0.0, publishing on every interface. So these assertions are
    deliberately configuration assertions, read straight from docker-compose.yml:
    they fail the moment the mapping is loosened back to an all-interfaces bind,
    which no runtime test could catch on a developer laptop that has no second
    interface to probe.

    Every *published* mapping of the semantic-studio service must begin with
    "127.0.0.1:". A mapping is "published" when it maps a host port at all
    (host:container or host_ip:host:container); the long-form equivalent is
    accepted too, for the same interface. The runtime half of AC-1/AC-3 — that
    the port answers on 127.0.0.1 and refuses on the host's LAN address — is
    proved with the run-semantic-viewer harness, not here, because it needs a
    running container.

    The Windows release (release-packaging 5.2, D-119) joins the scan: its
    launcher is the one place the release's binding is decided, so its source
    must name 127.0.0.1 as the one address, bind and hand uvicorn nothing
    else, and take no option that could change it; and the start file and
    the release workflow must start it without a --host. The runtime half,
    that the zip's server refuses a connection on the runner's other
    address, is smoke step 5 in release.yml.

INPUTS / INPUT SOURCES
    - The repository's docker-compose.yml, located relative to this file.
    - backend/app/launcher.py, release/Start Semantic Studio.cmd,
      release/smoke.py and .github/workflows/release.yml.

EXPECTED OUTPUT
    - Pass/fail per assertion. A failure means the compose file or the
      release would serve on an interface other than loopback, re-exposing the
      library to the network.
================================================================================
"""

import re
from pathlib import Path

import yaml

# docker-compose.yml lives at the repository root: this file is
# backend/tests/test_deployment_binding.py, so the root is three parents up.
ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = ROOT / "docker-compose.yml"
LAUNCHER_PATH = ROOT / "backend" / "app" / "launcher.py"
START_FILE = ROOT / "release" / "Start Semantic Studio.cmd"
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"

SMOKE = ROOT / "release" / "smoke.py"

# The spellings of "all interfaces" that can appear anywhere in a file. The
# empty string, the third, is caught where it would matter: every bind and
# every host= in the launcher must name LOOPBACK.
ALL_INTERFACES = re.compile(r"""["'](?:0\.0\.0\.0|::)["']|INADDR_ANY|\bin6addr_any\b""", re.I)
BIND_ARGS = re.compile(r"\.bind\(\(([^,)]*)")
HOST_ARGS = re.compile(r"\bhost=([^,)]*)")


def _published_host_bindings() -> list[str]:
    """Return the host-interface prefix of every published port mapping of the
    semantic-studio service.

    Compose accepts a short string form ("host:container",
    "host_ip:host:container") and a long mapping form ({published, target,
    host_ip, ...}). Both are normalised here to the host interface the port is
    published on: the explicit host_ip when present, or the empty string when
    the mapping names none — which is exactly the defect, because Docker reads a
    missing interface as every interface.
    """
    compose = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    service = compose["services"]["semantic-studio"]
    bindings: list[str] = []
    for entry in service.get("ports", []):
        if isinstance(entry, dict):
            # Long form. A mapping with no "published" is container-internal
            # only and publishes nothing; skip it. Otherwise the interface is
            # host_ip, defaulting to "" (every interface) when absent.
            if "published" not in entry:
                continue
            bindings.append(str(entry.get("host_ip", "")))
        else:
            # Short form "a:b" is host:container (no interface, every
            # interface); "a:b:c" is host_ip:host:container. Three or more
            # colon-separated fields means the first is the host interface.
            parts = str(entry).split(":")
            bindings.append(parts[0] if len(parts) >= 3 else "")
    return bindings


def test_compose_publishes_loopback_only():
    """AC-1 / AC-2: every published mapping binds the loopback interface."""
    bindings = _published_host_bindings()
    assert bindings, "expected the semantic-studio service to publish a port"
    for host_ip in bindings:
        assert host_ip == "127.0.0.1", (
            "docker-compose.yml must publish the port on loopback only; found a "
            f"mapping bound to {host_ip!r} instead of '127.0.0.1'"
        )


def test_compose_has_no_all_interfaces_binding():
    """AC-2 regression: no published mapping binds every interface.

    Guards specifically against the two shapes that mean "0.0.0.0": a mapping
    with no host interface at all, and one that names 0.0.0.0 explicitly.
    """
    for host_ip in _published_host_bindings():
        assert host_ip not in ("", "0.0.0.0", "::"), (
            "docker-compose.yml publishes the port on every interface "
            f"(host interface {host_ip!r}); this re-exposes the library to the "
            "network — see D-028"
        )


# ---------------------------------------------------------------------------
# The Windows release (release-packaging 5.2, AC-5).
# ---------------------------------------------------------------------------


def test_the_scan_sees_an_all_interfaces_binding():
    for planted in ("host='0.0.0.0'", 'host="::"', "socket.INADDR_ANY"):
        assert ALL_INTERFACES.search(planted), planted
    assert not ALL_INTERFACES.search('LOOPBACK = "127.0.0.1"')
    assert BIND_ARGS.findall('sock.bind(("", port))') == ['""']
    assert HOST_ARGS.findall('uvicorn.Config(app, host="", port=1)') == ['""']


def test_the_launcher_names_loopback_as_its_one_address():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    assert re.search(r'^LOOPBACK = "127\.0\.0\.1"$', source, re.M)
    hits = [m.group(0) for m in ALL_INTERFACES.finditer(source)]
    assert hits == [], f"launcher.py names an all-interfaces address: {hits}"
    # The two places the binding is decided both name the constant.
    assert BIND_ARGS.findall(source) == ["LOOPBACK"]
    assert HOST_ARGS.findall(source) == ["LOOPBACK"]


def test_the_launcher_takes_no_host_option():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    options = re.findall(r'add_argument\(\s*"(--[a-z-]+)"', source)
    assert options == ["--no-browser"]
    assert "--host" not in source and "environ.get(" not in source


def test_the_start_file_the_smoke_test_and_the_workflow_pass_no_host():
    start = START_FILE.read_text(encoding="utf-8")
    smoke = SMOKE.read_text(encoding="utf-8")
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    assert "-m app.launcher" in start and '"app.launcher"' in smoke and "release/smoke.py" in workflow
    for text in (start, smoke, workflow):
        assert "--host" not in text and "0.0.0.0" not in text
