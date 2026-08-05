"""
================================================================================
FILE: backend/app/sparql_exec.py
================================================================================

SUMMARY
    Safe execution of the SPARQL queries produced by the visual query builder.
    Parses a query, refuses anything that is not a read-only SELECT, runs it
    against an ontology's graph under a hard time limit, caps the number of
    rows, and serializes the results to JSON.

BASIC IDEA
    The query builder only ever generates SELECT queries, but the /sparql
    endpoint is a real HTTP surface that could receive anything, so the safety
    rails are enforced here rather than assumed:
      * only SELECT is accepted (CONSTRUCT/DESCRIBE/ASK are rejected, and
        UPDATE syntax fails to parse as a query at all);
      * a SERVICE clause is refused at any nesting depth, because it is legal
        inside a SELECT and would make the server call out to an address the
        query names; the walk fails closed, so a query nested too deeply to
        verify is refused rather than passed (CF-1);
      * results are capped independently of whatever LIMIT the query carries;
      * evaluation runs in a worker thread with a wall-clock timeout, because
        rdflib itself offers no way to interrupt a running query.

INPUTS / INPUT SOURCES
    - A raw SPARQL query string (from the frontend via the /sparql endpoint).
    - The target ontology's rdflib.Graph (from store.Ontology.ensure_loaded).
    - Optional max_rows / timeout overrides (tests use small values).

EXPECTED OUTPUT
    - A JSON-ready dict: {"vars", "rows", "rowCount", "truncated", "durationMs"}
      where each cell is a serialized term (uri/literal/bnode) or None for an
      unbound OPTIONAL variable.
    - Raises QueryError (bad/forbidden query) or QueryTimeout (too slow), which
      the router maps to HTTP 400 / 504.
================================================================================
"""

from __future__ import annotations

# time         - measure query duration and drive the timeout.
# ThreadPoolExecutor / TimeoutError - run the query off the request thread so a
#                slow query can be timed out (rdflib cannot self-interrupt).
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

# rdflib term types for serialization, plus prepareQuery to parse/validate.
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.plugins.sparql import prepareQuery

# Reuse the shared label/prefix helpers so URI cells carry a readable label.
from .graph_builder import pick_label, prefixed

# Server-side result cap, independent of the query's own LIMIT.
MAX_ROWS = 1000
# Longest a single query may run before it is abandoned.
DEFAULT_TIMEOUT_SECONDS = 30.0


class QueryError(Exception):
    """The query is malformed or not permitted (maps to HTTP 400)."""


class QueryTimeout(Exception):
    """The query took longer than the allowed wall-clock time (maps to HTTP 504)."""


# The algebra node rdflib 7.6.0 produces for a SERVICE clause. Verified to be
# this name for a plain SERVICE, for SERVICE SILENT, and when nested inside
# UNION, OPTIONAL or a subselect.
SERVICE_NODE_NAME = "ServiceGraphPattern"

# The deepest the algebra walk descends before it gives up and refuses. Named
# rather than a literal so the bound is visible and testable, and kept generous
# so a normal query (a plain SELECT sits around depth 10, and rdflib's own
# parser gives out well before this on hand-written nesting) never approaches
# it. Only a pathological, machine-built input reaches the bound.
MAX_ALGEBRA_DEPTH = 64

# Shown when a query asks the server to call another endpoint. It describes a
# product boundary that the README already states, rather than announcing a
# security control, because that is what it is: federated query is backlog Q-3.
SERVICE_REFUSED_DETAIL = (
    "Semantic Studio runs queries against the ontology loaded in the app. "
    "Federated queries using SERVICE are not supported."
)

# Shown when the algebra is nested past MAX_ALGEBRA_DEPTH. The walk cannot prove
# such a query free of a SERVICE call, so it refuses it: a check that answers
# "safe" when it means "I could not tell" is not a check. See CF-1.
DEEP_QUERY_REFUSED_DETAIL = (
    "This query is nested too deeply to verify as free of federated SERVICE "
    "calls, so it is refused."
)


def _contains_service(node, depth: int = 0) -> bool:
    """True if ``node`` or anything beneath it is a service call.

    Walks the parsed algebra rather than the query text. Text matching is
    defeated by comments, casing and whitespace, and it would refuse a perfectly
    good query that merely has a variable named ``?service``.

    A SERVICE nested inside a UNION, an OPTIONAL or a subselect is still a
    SERVICE, so the whole tree is walked and not only the top level.

    Raises QueryError past MAX_ALGEBRA_DEPTH rather than returning False. The
    depth bound is a guard against a pathological query, but a guard that
    reported *no service here* on overflow would fail open — a SERVICE buried
    below the bound would be accepted, the exact defect CF-1 records. Failing
    closed makes the one case the walk cannot verify a refusal, not a pass.
    """
    if depth > MAX_ALGEBRA_DEPTH:
        raise QueryError(DEEP_QUERY_REFUSED_DETAIL)
    if getattr(node, "name", None) == SERVICE_NODE_NAME:
        return True
    # CompValue is a dict subclass, so its values are the child nodes.
    if isinstance(node, dict):
        return any(_contains_service(child, depth + 1) for child in node.values())
    # Lists and tuples hold sibling patterns (a UNION's branches, for instance).
    if isinstance(node, (list, tuple)) and not isinstance(node, str):
        return any(_contains_service(child, depth + 1) for child in node)
    return False


def prepare_select(query: str):
    """Parse ``query`` and reject anything that is not a plain, local SELECT.

    Returns the prepared query object on success; raises QueryError otherwise.
    This is the security gate: only read-only SELECT is allowed through, and
    only against the graph loaded in this process.
    """
    try:
        prepared = prepareQuery(query)
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
    # SELECT and makes rdflib POST to whatever address the query names, which
    # turns this endpoint into a way to reach hosts the user could not.
    if _contains_service(prepared.algebra):
        raise QueryError(SERVICE_REFUSED_DETAIL)
    return prepared


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
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """Run a SELECT query and return JSON-serializable results.

    Validates the query, evaluates it on a worker thread under a timeout,
    truncates at max_rows, and serializes each cell.
    """
    # Validate/parse first so a bad query fails before we spin up a thread.
    prepared = prepare_select(query)
    started = time.perf_counter()

    # The actual evaluation. Defined as a closure so it can run on the worker
    # thread and return everything the caller needs in one tuple.
    def run():
        result = graph.query(prepared)
        variables = [str(var) for var in (result.vars or [])]
        rows = []
        hit_cap = False
        for row in result:
            # Stop collecting once we reach the server cap; flag truncation.
            if len(rows) >= max_rows:
                hit_cap = True
                break
            rows.append(tuple(row))
        return variables, rows, hit_cap

    # A single-worker pool lets us apply a wall-clock timeout to run().
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(run)
        try:
            variables, rows, truncated = future.result(timeout=timeout)
        except FuturesTimeout as exc:
            # Query ran too long; surface actionable advice to the user.
            raise QueryTimeout(
                f"The query exceeded the {timeout:.0f}s time limit. "
                "Try adding filters, reducing LIMIT, or avoiding unbounded "
                "path modifiers such as * and +."
            ) from exc
        except QueryError:
            # Already the right exception type; let it propagate unchanged.
            raise
        except Exception as exc:
            # Any other evaluation error becomes a QueryError (HTTP 400).
            raise QueryError(f"The query could not be evaluated: {exc}") from exc
    finally:
        # Never block on a timed-out query; the thread is abandoned to finish
        # (or not) on its own.
        executor.shutdown(wait=False)

    # Serialize every cell; the cache dedupes label lookups across rows.
    cache: dict[str, dict] = {}
    serialized = [[_term_json(graph, term, cache) for term in row] for row in rows]
    return {
        "vars": variables,
        "rows": serialized,
        "rowCount": len(serialized),
        "truncated": truncated,
        "durationMs": round((time.perf_counter() - started) * 1000, 1),
    }
