"""
================================================================================
FILE: release/smoke.py
================================================================================

SUMMARY
    The release's smoke test (release-packaging 5.4, steps 1 to 8): starts the
    unzipped release the way a person does and checks, failing on any miss,
    that it answers, lists the four bundled entries, answers the Mars
    question, reasons and validates a Small project, listens on 127.0.0.1
    only, is found by a second start, wrote nothing inside its own folder,
    and trusts Windows' certificates.

BASIC IDEA
    On Windows the start file itself is run, through `cmd /c`, from another
    folder, so the path with spaces and the start file's `cd` are both
    tested; elsewhere `--python` names an interpreter that runs
    `-B -m app.launcher` in the tree (the analyst's Linux run, Section 11).
    The launcher is always given `--no-browser`, and SEMANTIC_STUDIO_DATA_DIR
    a temporary folder outside the tree.

    Every request is http.client straight to 127.0.0.1 with the client
    header, never urllib: a runner's proxy must not be able to answer for
    the server. The folder is listed, sizes and modification times, before
    the start and after the last request, and must be the same (AC-6).

    Step 5's "other address" is the one this machine would use to reach the
    outside, found by pointing a UDP socket at a documentation address,
    which sends nothing; a connection there must be refused, while
    127.0.0.1 accepts one.

INPUTS / INPUT SOURCES
    - The unzipped release's top folder; `--python` off Windows.

EXPECTED OUTPUT
    - One line per step, PASS or the reason it failed; exit 0 only when all
      eight passed. The server is stopped at the end, and step 9 checks it
      went.
================================================================================
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

LOOPBACK = "127.0.0.1"
HEADER = {"X-Semantic-Studio": "1"}
RUNNING = re.compile(r"running at http://127\.0\.0\.1:(\d+)")
EXPECTED_ENTRIES = {
    ("Space Exploration", "example"),
    ("The Lord of the Rings", "example"),
    ("FOAF (Friend of a Friend)", "reference"),
    ("QUDT", "reference"),
}
MARS = "Which missions went to Mars?"


class Failed(Exception):
    pass


def call(port: int, method: str, path: str, body=None, timeout: float = 120.0):
    conn = http.client.HTTPConnection(LOOPBACK, port, timeout=timeout)
    try:
        headers = dict(HEADER)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        text = response.read().decode("utf-8", errors="replace")
        if response.status != 200:
            raise Failed(f"{method} {path} answered {response.status}: {text[:300]}")
        return json.loads(text) if text else None
    finally:
        conn.close()


def listing(top: Path) -> dict[str, tuple[int, int]]:
    return {
        path.relative_to(top).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(top.rglob("*"))
    }


class Launch:
    """One start of the release, its output read as it comes."""

    def __init__(self, top: Path, python: str | None, env: dict, cwd: Path):
        if os.name == "nt":
            command = ["cmd", "/c", str(top / "Start Semantic Studio.cmd"), "--no-browser"]
            extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        else:
            command = [python, "-B", "-m", "app.launcher", "--no-browser"]
            cwd = top
            extra = {"start_new_session": True}
        self.process = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", **extra,
        )
        self.lines: list[str] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            self.lines.append(line.rstrip())
            print(f"    | {line.rstrip()}", flush=True)

    def wait_for(self, pattern: re.Pattern, timeout: float):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for line in self.lines:
                match = pattern.search(line)
                if match:
                    return match
            if self.process.poll() is not None and not self.lines[-1:]:
                break
            time.sleep(0.1)
        return None

    def stop(self):
        if self.process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()


def other_address() -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP connect sends nothing; it only picks the outgoing interface.
        probe.connect(("192.0.2.1", 9))
        address = probe.getsockname()[0]
    finally:
        probe.close()
    if address.startswith("127.") or not address.strip("0."):
        raise Failed(f"no address other than loopback to test against ({address})")
    return address


def refuses(address: str, port: int) -> bool:
    try:
        with socket.create_connection((address, port), timeout=5):
            return False
    except OSError:
        return True


def run(top: Path, python: str | None) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    data_dir = Path(tempfile.mkdtemp(prefix="semantic-studio-smoke-data-"))
    env = {**os.environ, "SEMANTIC_STUDIO_DATA_DIR": str(data_dir), "PYTHONUTF8": "1"}
    for name in ("PYTHONPATH", "PYTHONHOME", "STATIC_DIR"):
        env.pop(name, None)
    elsewhere = Path(tempfile.mkdtemp(prefix="semantic-studio-smoke-cwd-"))
    before = listing(top)
    first = Launch(top, python, env, elsewhere)
    port = None

    def step(number: int, title: str, check):
        try:
            outcome = check()
            results.append((f"{number}. {title}", "PASS" + (f" ({outcome})" if outcome else "")))
        except Exception as exc:  # noqa: BLE001 -- every miss is reported, then the next step runs
            results.append((f"{number}. {title}", f"FAIL: {exc}"))
        print(f"{results[-1][0]}: {results[-1][1]}", flush=True)

    try:
        def health():
            nonlocal port
            started = time.monotonic()
            match = first.wait_for(RUNNING, 30)
            if match is None:
                raise Failed("no 'running at' line within 30 s")
            port = int(match.group(1))
            answer = call(port, "GET", "/api/health")
            if answer.get("app") != "semantic-studio":
                raise Failed(f"health answered {answer}")
            return f"port {port}, {time.monotonic() - started:.1f} s"

        step(1, "/api/health answers within 30 s", health)
        if port is None:
            return results

        library: list[dict] = []

        def entries():
            library.extend(call(port, "GET", "/api/ontologies"))
            found = {(e["name"], e["example"]["group"]) for e in library if e.get("source") == "example"}
            if found != EXPECTED_ENTRIES:
                raise Failed(f"bundled entries {sorted(found)}")
            return "two examples, two references"

        step(2, "the library lists the four bundled entries", entries)

        def mars():
            space = next(e for e in library if e["name"] == "Space Exploration")
            question = next(q for q in space["example"]["questions"] if q["title"] == MARS)
            answer = call(port, "POST", f"/api/ontologies/{space['id']}/sparql", {"query": question["text"]})
            rows = answer["rows"]
            if len(rows) != 3:
                raise Failed(f"{len(rows)} rows")
            return "3 rows"

        step(3, "the Mars question returns 3 rows", mars)

        def reason_and_validate():
            project = call(port, "POST", "/api/projects", {"name": "Smoke", "template": "small"})["id"]
            call(port, "POST", f"/api/projects/{project}/open")
            reasoned = call(port, "POST", f"/api/projects/{project}/reasoning", {})
            if "groups" not in reasoned:
                raise Failed(f"reasoning answered {list(reasoned)}")
            validated = call(port, "POST", f"/api/projects/{project}/validate")
            # The Small template ships starter shapes (D-095): pySHACL ran them.
            if not validated.get("shapeCount") or validated.get("stopped"):
                raise Failed(f"validation answered {validated}")
            call(port, "POST", f"/api/projects/{project}/close")
            return f"{len(reasoned['groups'])} groups reasoned, {validated['shapeCount']} shapes validated"

        step(4, "a Small project reasons and validates", reason_and_validate)

        def loopback_only():
            with socket.create_connection((LOOPBACK, port), timeout=5):
                pass
            address = other_address()
            if not refuses(address, port):
                raise Failed(f"{address}:{port} accepted a connection")
            return f"refused on {address}"

        step(5, "listening on 127.0.0.1 only", loopback_only)

        def second_start():
            second = Launch(top, python, env, elsewhere)
            try:
                code = second.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                second.stop()
                raise Failed("the second start did not exit: it started a server") from None
            time.sleep(0.5)
            said = "\n".join(second.lines)
            if code != 0 or f"already running at http://127.0.0.1:{port}" not in said:
                raise Failed(f"exit {code}: {said[-300:]}")
            return f"exit 0, sent to port {port}"

        step(6, "a second start finds the first and exits", second_start)

        def connection():
            view = call(port, "GET", "/api/network/connection")
            if view.get("trust") != "system":
                raise Failed(f"trust is {view.get('trust')!r}")
            return "trust: system"

        # Step 8 runs before 7, so the folder is compared after the last request.
        step(8, "/api/network/connection answers trust 'system'", connection)

        def nothing_written():
            after = listing(top)
            added = sorted(set(after) - set(before))
            changed = sorted(k for k in before if k in after and after[k] != before[k])
            removed = sorted(set(before) - set(after))
            if added or changed or removed:
                raise Failed(f"added {added[:10]}, changed {changed[:10]}, removed {removed[:10]}")
            if not any(data_dir.rglob("*")):
                raise Failed("the data folder is empty: the work went somewhere else")
            return f"{len(before)} files unchanged"

        step(7, "nothing was written inside the unzipped folder", nothing_written)
    finally:
        first.stop()

    def stopped():
        time.sleep(1)
        if port is not None and not refuses(LOOPBACK, port):
            raise Failed("still answering after the window was closed")
        return None

    step(9, "stopping it stops the server", stopped)
    results.sort(key=lambda r: int(r[0].split(".")[0]))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test an unzipped Semantic Studio release.")
    parser.add_argument("top", type=Path, help="the unzipped release's top folder")
    parser.add_argument("--python", help="off Windows: the interpreter to run app.launcher with")
    args = parser.parse_args()
    if os.name != "nt" and not args.python:
        parser.error("--python is needed off Windows")
    results = run(args.top.resolve(), args.python)
    print("\nSmoke test")
    for title, outcome in results:
        print(f"  {title}: {outcome}")
    ok = len(results) == 9 and all(outcome.startswith("PASS") for _, outcome in results)
    print("All steps passed." if ok else "The smoke test failed.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
