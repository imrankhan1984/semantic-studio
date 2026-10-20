"""
================================================================================
FILE: backend/app/loads.py
================================================================================

SUMMARY
    The loads running now, each under the id the browser made for it, so a
    Cancel can mark one and the store can see the mark before it writes
    anything (load-progress 5.3, D-115).

BASIC IDEA
    A load that carries a `loadId` is registered for as long as its route
    runs and removed when it ends, whatever the outcome, so the table never
    holds more than the loads running at once and an id is forgotten the
    moment its load is over. A cancel for an id not in the table -- finished,
    or never seen -- touches nothing and says so.

    Cancel cannot stop a parse already running: a Python thread cannot be
    stopped from outside (D-013). What it can do is make sure the result is
    thrown away. `OntologyStore.add` calls `check()` after the download and
    after the parse, and `commit()` after the summary, just before the first
    write. `commit()` and `cancel()` take the same lock, so exactly one of
    them wins: either the load is marked and writes nothing, or it has
    committed and the cancel answers that it was too late. Without the lock
    a cancel landing between the last check and the write would answer
    *stopped* for a load that was then written.

INPUTS / INPUT SOURCES
    - Load ids from the upload and fetch routes, and from the cancel route.

EXPECTED OUTPUT
    - `running_loads`, the process's one table: `running(id)` registers a
      load and yields its `LoadMark` (or None for a load without an id);
      `cancel(id)` answers whether it stopped one.
    - `LoadCancelled`, raised by a mark's `check()` or `commit()`, which the
      routes answer with 409.
================================================================================
"""

from __future__ import annotations

import contextlib
import threading
from typing import Iterator, Optional


class LoadCancelled(Exception):
    """The load was cancelled before it wrote anything."""


class LoadAlreadyRunning(Exception):
    """A second load arrived under an id that is still running."""


class LoadMark:
    """One running load's cancel mark, shared with the table's lock."""

    def __init__(self, lock: threading.Lock) -> None:
        self._lock = lock
        self.cancelled = False
        self.committed = False

    def check(self) -> None:
        """Raise LoadCancelled if the load has been cancelled."""
        with self._lock:
            if self.cancelled:
                raise LoadCancelled()

    def commit(self) -> None:
        """The last check: past it, a cancel answers that it was too late."""
        with self._lock:
            if self.cancelled:
                raise LoadCancelled()
            self.committed = True


class RunningLoads:
    """The loads running now, by id."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._marks: dict[str, LoadMark] = {}

    @contextlib.contextmanager
    def running(self, load_id: Optional[str]) -> Iterator[Optional[LoadMark]]:
        """Register a load for the length of the block; None without an id."""
        if load_id is None:
            yield None
            return
        mark = LoadMark(self._lock)
        with self._lock:
            if load_id in self._marks:
                raise LoadAlreadyRunning()
            self._marks[load_id] = mark
        try:
            yield mark
        finally:
            with self._lock:
                self._marks.pop(load_id, None)

    def cancel(self, load_id: str) -> bool:
        """Mark a running load cancelled; False if it is unknown or committed."""
        with self._lock:
            mark = self._marks.get(load_id)
            if mark is None or mark.committed:
                return False
            mark.cancelled = True
            return True

    def __len__(self) -> int:
        with self._lock:
            return len(self._marks)


running_loads = RunningLoads()
