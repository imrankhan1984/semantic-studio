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


def prepare_select(query: str):
    """Parse ``query`` and reject anything that is not a SELECT.

    Returns the prepared query object on success; raises QueryError otherwise.
    This is the security gate: only read-only SELECT is allowed through.
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
