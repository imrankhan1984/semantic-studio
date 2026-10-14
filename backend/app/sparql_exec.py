"""
================================================================================
FILE: backend/app/sparql_exec.py
================================================================================

SUMMARY
    Safe execution of SPARQL SELECT queries, built visually or typed. Parses a
    query, refuses anything that is not a read-only SELECT, classifies its
    SERVICE blocks, runs it against an ontology's graph under a hard time
    limit, caps the number of rows, and serializes the results to JSON.

BASIC IDEA
    The /sparql endpoint is a real HTTP surface that could receive anything,
    so the safety rails are enforced here rather than assumed:
      * only SELECT is accepted (CONSTRUCT/DESCRIBE/ASK are rejected, and
        UPDATE syntax fails to parse as a query at all);
      * every SERVICE block is found at any nesting depth and handed to
        sparql_service, which refuses a variable endpoint, a non-public one or
        more than five blocks, and asks the user about every host before
        anything is sent (D-069, which replaced the outright refusal S-2
        introduced); the walk fails closed, so a query nested too deeply to
        verify is refused rather than passed (CF-1);
      * results are capped independently of whatever LIMIT the query carries;
      * evaluation runs on a thread of its own with a wall-clock timeout,
        holding the ontology's read lock itself. The worker runs in a copy of
        the request's context, which is how the just-once grant and the
        SERVICE run's one-call memo reach it;
      * rdflib offers no way to interrupt a query, so at the timeout the
        worker is stopped from outside: QueryStopped is raised in it, only
        while it is still inside the query. A worker still alive two seconds
        later (inside a C call or a network wait) keeps its ontology's key,
        and a new query on that ontology is refused until it ends (D-108).

INPUTS / INPUT SOURCES
    - A raw SPARQL query string (from the frontend via the /sparql endpoint).
    - The target ontology's rdflib.Graph (from store.Ontology.ensure_loaded).
    - Optional max_rows / timeout overrides (tests use small values).

EXPECTED OUTPUT
    - A JSON-ready dict: {"vars", "rows", "rowCount", "truncated", "durationMs"}
      where each cell is a serialized term (uri/literal/bnode) or None for an
      unbound OPTIONAL variable, plus "services" -- one entry per endpoint
      called -- when the query has SERVICE blocks.
    - Raises QueryError (bad/forbidden query), QueryTimeout (too slow) or
      QueryBusy (the last query is still stopping), which the router maps to
      HTTP 400 / 504 / 409, and lets the broker's ApprovalRequired,
      HostBlocked and Offline through for main.py to map to 409 / 403 / 503.
================================================================================
"""

from __future__ import annotations

# time         - measure query duration and drive the timeout.
# threading    - run the query off the request thread so a slow query can be
#                timed out; ctypes raises the stop in it (rdflib cannot
#                self-interrupt).
import contextlib
import contextvars
import ctypes
import threading
import time
from typing import Callable, Optional

# rdflib term types for serialization. parseQuery and translateQuery are the
# two halves of prepareQuery, called apart because the SERVICE blocks have to
# be read from the parse tree before translation reorders it.
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.plugins.sparql.algebra import translateQuery
from rdflib.plugins.sparql.parser import expandUnicodeEscapes, parseQuery

# Reuse the shared label/prefix helpers so URI cells carry a readable label.
from . import sparql_service
from .graph_builder import pick_label, prefixed
from .network_broker import NetworkDecision

# Server-side result cap, independent of the query's own LIMIT.
MAX_ROWS = 1000
# Longest a single query may run before it is abandoned.
DEFAULT_TIMEOUT_SECONDS = 30.0


class QueryError(Exception):
    """The query is malformed or not permitted (maps to HTTP 400)."""


class QueryTimeout(Exception):
    """The query took longer than the allowed wall-clock time (maps to HTTP 504)."""


class QueryBusy(Exception):
    """A timed-out query of the same ontology is still stopping (maps to HTTP 409)."""


class QueryStopped(BaseException):
    """Raised inside a timed-out query's worker to end it.

    A BaseException, as KeyboardInterrupt is, so an ``except Exception``
    somewhere in rdflib's evaluation cannot swallow it and carry on."""


BUSY_DETAIL = "The last query is still stopping. Try again in a few seconds."

# How long the request waits for a stopped worker to end before giving up on
# it. The stop lands at the worker's next Python instruction, which for an
# rdflib query is within milliseconds (0.04 s measured on a three-way join
# under ORDER BY); only a C call or a network wait outlasts it.
STOP_GRACE_SECONDS = 2.0

# A worker still alive STOP_GRACE_SECONDS after its stop keeps its ontology's
# key here, holding the event the worker sets when it ends, and a new query on
# the key is refused until then. Without this, repeated slow queries piled up
# abandoned workers with nothing bounding them (CF-2, D-108). Before the stop
# from outside, a query computing its first row kept the key for as long as it
# ran, hours for a big join, refusing every query on its ontology meanwhile.
_abandoned: dict[str, threading.Event] = {}
_abandoned_lock = threading.Lock()


def _set_async_exc(ident: int, exc) -> int:
    """Raise ``exc`` in thread ``ident`` at its next Python instruction, or
    clear a pending one when ``exc`` is None. Returns the threads changed."""
    return ctypes.pythonapi.PyThreadState_SetAsyncExc(
        ctypes.c_ulong(ident), ctypes.py_object(exc) if exc is not None else None
    )


class _Stopper:
    """The one stop a worker can be sent, and only while it is in its query.

    A thread id is reused once its thread ends, and a stop raised after the
    query would land in the worker's own cleanup (end_run, the read lock), so
    it is sent only while the worker is armed, under the lock the worker takes
    to disarm. Disarming also clears a stop sent but not yet delivered: after
    it, nothing can reach the thread.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ident: Optional[int] = None
        self._armed = False

    def arm(self) -> None:
        with self._lock:
            self._ident = threading.get_ident()
            self._armed = True

    def disarm(self) -> None:
        with self._lock:
            self._armed = False
            if self._ident is not None:
                _set_async_exc(self._ident, None)

    def stop(self) -> bool:
        """Send the stop if the worker is still in its query; once at most."""
        with self._lock:
            if not self._armed:
                return False
            self._armed = False
            _set_async_exc(self._ident, QueryStopped)
            return True


# The algebra node rdflib 7.6.0 produces for a SERVICE clause. Verified to be
# this name for a plain SERVICE, for SERVICE SILENT, and when nested inside
# UNION, OPTIONAL or a subselect.
SERVICE_NODE_NAME = sparql_service.SERVICE_NODE_NAME

# The deepest the algebra walk descends before it gives up and refuses. Named
# rather than a literal so the bound is visible and testable, and kept generous
# so a normal query (a plain SELECT sits around depth 10, and rdflib's own
# parser gives out well before this on hand-written nesting) never approaches
# it. Only a pathological, machine-built input reaches the bound.
MAX_ALGEBRA_DEPTH = 64

# Shown when the algebra is nested past MAX_ALGEBRA_DEPTH. The walk cannot find
# every SERVICE call in such a query, and one it missed would never be asked
# about, so it refuses: a check that answers "found them all" when it means "I
# could not tell" is not a check. See CF-1.
DEEP_QUERY_REFUSED_DETAIL = (
    "This query is nested too deeply to verify as free of federated SERVICE "
    "calls, so it is refused."
)


def find_services(node, depth: int = 0) -> list:
    """Every service call in ``node``, outermost only.

    Walks the parsed algebra rather than the query text. Text matching is
    defeated by comments, casing and whitespace, and it would find a perfectly
    good query that merely has a variable named ``?service``.

    A SERVICE nested inside a UNION, an OPTIONAL, a FILTER EXISTS or a
    subselect is still a SERVICE, so the whole tree is walked. A SERVICE
    inside another SERVICE is not collected: it is part of the outer block's
    text and runs on the remote endpoint, never here.

    Raises QueryError past MAX_ALGEBRA_DEPTH rather than returning what it has.
    A walk that stopped quietly at the bound would fail open -- a SERVICE
    buried below it would run without anyone being asked, the exact defect
    CF-1 records. Failing closed makes the one case the walk cannot verify a
    refusal, not a pass.
    """
    if depth > MAX_ALGEBRA_DEPTH:
        raise QueryError(DEEP_QUERY_REFUSED_DETAIL)
    if getattr(node, "name", None) == SERVICE_NODE_NAME:
        return [node]
    found: list = []
    # CompValue is a dict subclass, so its values are the child nodes.
    if isinstance(node, dict):
        for child in node.values():
            found.extend(find_services(child, depth + 1))
    # Lists and tuples hold sibling patterns (a UNION's branches, for instance).
    elif isinstance(node, (list, tuple)) and not isinstance(node, str):
        for child in node:
            found.extend(find_services(child, depth + 1))
    return found


def _prepare(query: str):
    """Parse ``query``, refuse anything but a SELECT, and plan its SERVICE
    blocks. Returns (prepared query, ServicePlan or None)."""
    try:
        # The SERVICE blocks are read from the text rdflib actually parses:
        # parseQuery expands \uXXXX escapes first, so scanning the raw query
        # would let an escape show one thing in the approval dialog and mean
        # another to the endpoint. Expanded once, here, while parseQuery still
        # gets the raw query -- expanding twice would let an escaped backslash
        # followed by "u0022" become a quote the scanner never saw.
        text = expandUnicodeEscapes(query)
        sparql_service.refuse_nested(text)
        parsed = parseQuery(query)
        # Before translation: it rewrites the tree in place, and pairing the
        # SERVICE text with the SERVICE nodes needs the tree in text order and
        # each term as written.
        matched = sparql_service.match_blocks(text, parsed)
        prepared = translateQuery(parsed)
    except sparql_service.ServiceRefused as exc:
        raise QueryError(str(exc)) from exc
    except Exception as exc:  # rdflib raises parser-specific errors
        # A parse failure includes UPDATE syntax, which is not a query at all.
        raise QueryError(f"Could not parse the SPARQL query: {exc}") from exc
    # The parsed algebra names the query form; anything but SelectQuery (i.e.
    # CONSTRUCT / DESCRIBE / ASK) is refused.
    name = getattr(prepared.algebra, "name", "")
    if name != "SelectQuery":
        raise QueryError(
            "Only SELECT queries can be executed here. "
            "Updates and other query forms are not supported."
        )
    # SELECT-only is not enough on its own: a SERVICE clause is legal inside a
    # SELECT and makes the server call the address the query names. Each one
    # is found here and planned -- endpoint checked, text fixed -- so nothing
    # about what will be sent is decided after the user has been asked.
    services = find_services(prepared.algebra)
    if not services and not matched.pairs:
        return prepared, None
    try:
        return prepared, sparql_service.plan_services(matched, services)
    except sparql_service.ServiceRefused as exc:
        raise QueryError(str(exc)) from exc


def prepare_select(query: str):
    """Parse ``query`` and reject anything that is not a SELECT this
    application may run. Returns the prepared query; raises QueryError.

    This is the security gate. A SERVICE block passes it only as a fixed,
    public endpoint, and passing it sends nothing: every host is still asked
    about before the query runs.
    """
    return _prepare(query)[0]


def _term_json(graph: Graph, term, cache: dict[str, dict]):
    """Serialize one result cell to JSON.

    URIs are enriched with a label and prefixed form (and cached, since the
    same URI recurs across many rows). Literals keep their language/datatype.
    None means an unbound variable (an OPTIONAL block that did not match).
    """
    if term is None:
        return None  # unbound variable (OPTIONAL that did not match)
    if isinstance(term, URIRef):
        key = str(term)
        # Cache per URI so we do not re-run label lookup for repeated values.
        entry = cache.get(key)
        if entry is None:
            entry = {
                "type": "uri",
                "value": key,
                "label": pick_label(graph, term),
                "prefixed": prefixed(graph, term),
            }
            cache[key] = entry
        return entry
    if isinstance(term, Literal):
        return {
            "type": "literal",
            "value": str(term),
            "lang": term.language,
            "datatype": prefixed(graph, term.datatype) if term.datatype else None,
        }
    if isinstance(term, BNode):
        return {"type": "bnode", "value": str(term)}
    return {"type": "unknown", "value": str(term)}


def execute_select(
    graph: Graph,
    query: str,
    *,
    max_rows: int = MAX_ROWS,
    timeout: Optional[float] = None,
    key: Optional[str] = None,
    reading: Callable[[], contextlib.AbstractContextManager] = contextlib.nullcontext,
) -> dict:
    """Run a SELECT query and return JSON-serializable results.

    Validates the query, asks about any SERVICE hosts, evaluates it on a
    worker thread under a timeout, truncates at max_rows, and serializes each
    cell. ``key`` names the ontology for the one-abandoned-query rule;
    ``reading`` is its read lock, which the worker takes itself, so a caller
    must not hold it. The timeout is read when called, so a test can lower
    the module's default.
    """
    if timeout is None:
        timeout = DEFAULT_TIMEOUT_SECONDS
    if key is not None:
        with _abandoned_lock:
            done = _abandoned.get(key)
            if done is not None and not done.is_set():
                raise QueryBusy(BUSY_DETAIL)
            _abandoned.pop(key, None)
    # Validate/parse first so a bad query fails before we spin up a thread.
    prepared, plan = _prepare(query)
    # Every SERVICE host is asked about now, all in one 409, before a row is
    # evaluated or a byte sent.
    if plan is not None:
        sparql_service.check_before_running(plan)
    run_state: Optional[sparql_service.ServiceRun] = (
        sparql_service.ServiceRun(plan) if plan is not None else None
    )
    started = time.perf_counter()
    # Set by the request thread when the timeout fires; done by the worker
    # when it ends, however it ends.
    stop = threading.Event()
    done = threading.Event()
    stopper = _Stopper()
    # The worker's one answer: its rows, None when stopped, or the exception.
    outcome: list = []

    def evaluate():
        if stop.is_set():
            return None
        result = graph.query(prepared)
        variables = [str(var) for var in (result.vars or [])]
        rows = []
        hit_cap = False
        # rdflib yields a SELECT's rows lazily, so the flag ends a query the
        # stop could not reach (it was in C) within one row; part of the rows
        # is no answer.
        for row in result:
            if stop.is_set():
                return None
            # Stop collecting once we reach the server cap; flag truncation.
            if len(rows) >= max_rows:
                hit_cap = True
                break
            rows.append(tuple(row))
        return variables, rows, hit_cap

    # The worker holds the read lock itself, so a stopped query lets go of it
    # in its own cleanup rather than reading on after the request let go.
    def run():
        token = sparql_service.begin_run(run_state)
        try:
            with reading():
                try:
                    stopper.arm()
                    answer = evaluate()
                    # Inside the try: a stop sent before this lands in it or
                    # is cleared by it, never in the cleanup below.
                    stopper.disarm()
                except QueryStopped:
                    answer = None
            outcome.append(answer)
        except BaseException as exc:  # handed to the request thread
            outcome.append(exc)
        finally:
            sparql_service.end_run(token)
            done.set()

    # A thread of its own, never a pool's: the stop is raised in it by id, and
    # a reused worker could carry it into the next query. Run in a copy of the
    # caller's context, as store.parse_rdf does: the just-once grant the
    # request presented is a contextvar, and a bare start would run the worker
    # without it, so an approved SERVICE retry would be asked again, for ever.
    worker = threading.Thread(
        target=contextvars.copy_context().run, args=(run,), name="sparql-query", daemon=True
    )
    worker.start()
    if not done.wait(timeout):
        stop.set()
        stopper.stop()
        if not done.wait(STOP_GRACE_SECONDS) and key is not None:
            # Inside a C call or a network wait: the stop lands when it
            # returns, and until then its ontology takes no new query.
            with _abandoned_lock:
                if not done.is_set():
                    _abandoned[key] = done
    answer = outcome[0] if done.is_set() and outcome else None
    if answer is None:
        # Stopped, or still stopping. A query that finished just as the
        # timeout fired was never sent the stop and keeps its rows.
        raise QueryTimeout(
            f"The query exceeded the {timeout:.0f}s time limit. "
            "Try adding filters, reducing LIMIT, or avoiding unbounded "
            "path modifiers such as * and +."
        )
    if isinstance(answer, (QueryError, NetworkDecision)):
        # Already the right types; main.py maps the broker's decisions.
        raise answer
    if isinstance(answer, sparql_service.ServiceFailed):
        # Its sentence already names the endpoint and what went wrong.
        raise QueryError(str(answer)) from answer
    if isinstance(answer, BaseException):
        # Any other evaluation error becomes a QueryError (HTTP 400).
        raise QueryError(f"The query could not be evaluated: {answer}") from answer
    variables, rows, truncated = answer

    # Serialize every cell; the cache dedupes label lookups across rows.
    cache: dict[str, dict] = {}
    with reading():
        serialized = [[_term_json(graph, term, cache) for term in row] for row in rows]
    response = {
        "vars": variables,
        "rows": serialized,
        "rowCount": len(serialized),
        "truncated": truncated,
        "durationMs": round((time.perf_counter() - started) * 1000, 1),
    }
    if run_state is not None:
        # Returned, never stored: the server keeps no SERVICE result (D-029).
        response["services"] = run_state.report
    return response
