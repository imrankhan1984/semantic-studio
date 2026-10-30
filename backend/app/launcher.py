"""
================================================================================
FILE: backend/app/launcher.py
================================================================================

SUMMARY
    The Windows release's entry point (release-packaging 5.2, D-119).
    `Start Semantic Studio.cmd` runs `python\\python.exe -B -m app.launcher`
    from the unzipped folder; this module points the server at the bundled
    frontend, finds a port, reuses a Semantic Studio already running there,
    serves on 127.0.0.1 only, opens the browser once the server answers, and
    tells the person in three sentences where it is and how to stop it.
    `uvicorn app.main:app` and Docker do not use it.

BASIC IDEA
    Ports 8000 to 8019 are each bound once on 127.0.0.1, which says at no cost
    which are taken. Only a taken port is asked `/api/health`: on Windows a
    connection to a closed port takes about two seconds to be refused, so
    asking all twenty would make a start wait forty. A taken port that
    answers as Semantic Studio means it is already running on this data
    folder, and a second server would share it, so the browser is sent there
    and the launcher exits. Otherwise the first free port's own socket is
    handed to uvicorn: nothing can take the port between the check and the
    start, and the bound address is the one place the binding is decided.

    The launcher's requests to its own server go through `http.client`
    straight to 127.0.0.1, never `urllib`: urllib reads Windows' proxy, whose
    `<local>` exception covers only names without a dot, so behind a manual
    proxy a request to 127.0.0.1 would go to the proxy and the launcher would
    wait for ever (AC-9). These are not outbound connections, so the broker
    is not involved; test_no_direct_network.py names this file and checks
    every connection it makes is to 127.0.0.1.

    The release never writes inside its own folder: work is kept in the data
    folder (store.default_data_dir), and no bytecode is written (`-B` in the
    start file, and `sys.dont_write_bytecode` here as well, for anyone who
    starts the module by hand). The reasoner's spawned process starts the
    same python.exe, which reads the same `._pth`, and `-B` is passed on to
    it by multiprocessing; importing this module starts nothing, so the
    spawned child, which imports it as `__mp_main__`, does not start a
    second server.

INPUTS / INPUT SOURCES
    - The command line: `--no-browser`, used by the release's smoke test.
    - The folder this file is in: `static` beside `app` is the built frontend.
    - Ports 8000 to 8019 on 127.0.0.1, and `/api/health` on a taken one.
    - SEMANTIC_STUDIO_DATA_DIR, through store.py, as everywhere else.

EXPECTED OUTPUT
    - A server on 127.0.0.1 and the browser opened on it, with the address,
      the data folder and how to stop it printed in the console; exit 0 when
      the window is closed or Ctrl+C is pressed.
    - Exit 0 after opening the browser on a Semantic Studio already running.
    - Exit 1, after a sentence and a key press, when 8000 to 8019 are taken;
      exit 2, after the traceback and a key press, on any other failure.
================================================================================
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Optional

# The one address the release serves on and asks (requirement 7). Every bind
# and every connection in this file names it; test_deployment_binding.py
# scans for anything else.
LOOPBACK = "127.0.0.1"
PORTS = range(8000, 8020)
# What /api/health says to tell this application from another one on 8000.
APP_ID = "semantic-studio"

# A taken port answers at once or not at all; a server starting for the first
# time parses QUDT before it answers (3.9 s on Imran's machine), so the wait
# for our own is long and the probe of someone else's is short.
PROBE_TIMEOUT_S = 2.0
START_TIMEOUT_S = 120.0

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

ALL_TAKEN = (
    "Semantic Studio could not start: ports 8000 to 8019 on this computer are all in use. "
    "Close a program that uses one of them and start Semantic Studio again."
)


def url(port: int) -> str:
    return f"http://{LOOPBACK}:{port}/"


def bind(port: int) -> Optional[socket.socket]:
    """The port's listening socket on 127.0.0.1, or None when it is taken.

    No SO_REUSEADDR: on Windows it lets a socket share a port another program
    is listening on, which is the opposite of the question asked here.
    SO_EXCLUSIVEADDRUSE, Windows only, keeps another program off ours."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((LOOPBACK, port))
        sock.listen(128)
    except OSError:
        sock.close()
        return None
    return sock


def is_semantic_studio(port: int, timeout: Optional[float] = None) -> bool:
    """Whether 127.0.0.1:port answers /api/health as this application.

    http.client, so no proxy can be read in (AC-9). Anything that is not our
    answer, a refusal, a timeout, another program's page, is a no."""
    conn = http.client.HTTPConnection(LOOPBACK, port, timeout=PROBE_TIMEOUT_S if timeout is None else timeout)
    try:
        conn.request("GET", "/api/health")
        response = conn.getresponse()
        if response.status != 200:
            return False
        body = json.loads(response.read(4096))
        return isinstance(body, dict) and body.get("app") == APP_ID
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        conn.close()


def choose(ports=None) -> tuple[str, Optional[int], Optional[socket.socket]]:
    """("running", port, None) for a Semantic Studio already serving,
    ("free", port, socket) for the first port we hold, ("full", None, None).

    A running one is looked for on every taken port before a free one is
    taken: the first start may have had to move past a program on 8000 that
    has since gone, and 8000 being free again must not start a second
    server beside it."""
    held: dict[int, socket.socket] = {}
    ports = PORTS if ports is None else ports
    taken: list[int] = []
    for port in ports:
        sock = bind(port)
        if sock is None:
            taken.append(port)
        else:
            held[port] = sock
    try:
        for port in taken:
            if is_semantic_studio(port):
                return "running", port, None
        if not held:
            return "full", None, None
        port = next(p for p in ports if p in held)
        return "free", port, held.pop(port)
    finally:
        for sock in held.values():
            sock.close()


def wait_until_up(port: int, timeout: float = START_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if is_semantic_studio(port):
            return True
        time.sleep(0.25)
    return False


def sentences(port: int, data_dir: Path) -> list[str]:
    """The console's three sentences (5.2 item 6, AC-2)."""
    return [
        f"Semantic Studio is running at {url(port).rstrip('/')}",
        f"Your work is kept in {data_dir}",
        "Close this window to stop Semantic Studio.",
    ]


def _announce(port: int, data_dir: Path, open_browser: bool) -> None:
    """Runs beside the server: once it answers, say so and open the page."""
    if not wait_until_up(port):
        print("Semantic Studio did not start. The messages above say why.", flush=True)
        return
    print("\n".join(sentences(port, data_dir)), flush=True)
    if open_browser:
        webbrowser.open(url(port))


def _wait_for_a_key() -> None:
    # The console window closes with the process, which would take the
    # sentence with it before it is read.
    try:
        input("Press Enter to close this window.")
    except (EOFError, KeyboardInterrupt):
        pass


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="app.launcher", description="Start Semantic Studio.")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args(argv)

    sys.dont_write_bytecode = True
    # Before app.main is imported: it reads STATIC_DIR once, at import.
    os.environ["STATIC_DIR"] = str(STATIC_DIR)

    state, port, sock = choose()
    if state == "full":
        print(ALL_TAKEN, flush=True)
        _wait_for_a_key()
        return 1
    if state == "running":
        print(f"Semantic Studio is already running at {url(port).rstrip('/')}. Opening it in your browser.", flush=True)
        if not args.no_browser:
            webbrowser.open(url(port))
        return 0

    import uvicorn

    from .main import app
    from .store import store

    # No reload, one worker (5.2 item 4); warnings only, so the console holds
    # the three sentences rather than a line per request.
    config = uvicorn.Config(app, host=LOOPBACK, port=port, reload=False, workers=1,
                            log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    threading.Thread(target=_announce, args=(port, store.data_dir, not args.no_browser), daemon=True).start()
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
    return 0


def _run() -> int:
    """main(), with a failure kept on screen: a double-clicked start file's
    window closes with the process, and the traceback is the only thing a
    person could send to say what went wrong."""
    try:
        return main()
    except Exception:  # noqa: BLE001 -- any failure is shown, then the window may close
        import traceback

        traceback.print_exc()
        print("Semantic Studio stopped because of the error above.", flush=True)
        _wait_for_a_key()
        return 2


if __name__ == "__main__":
    sys.exit(_run())
