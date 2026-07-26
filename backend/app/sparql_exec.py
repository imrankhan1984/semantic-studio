"""Safe execution of the queries produced by the visual query builder.

The builder only ever generates SELECT queries, but the endpoint is a real
HTTP surface, so the rails are enforced here rather than assumed:

* only SELECT is accepted (no CONSTRUCT/DESCRIBE/ASK, and UPDATE syntax
  fails to parse as a query at all);
* results are capped independently of whatever LIMIT the query carries;
* evaluation runs in a worker thread with a hard wall-clock timeout,
  because rdflib itself offers no way to interrupt a running query.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.plugins.sparql import prepareQuery

from .graph_builder import pick_label, prefixed

MAX_ROWS = 1000
DEFAULT_TIMEOUT_SECONDS = 30.0


class QueryError(Exception):
    """The query is malformed or not permitted."""


class QueryTimeout(Exception):
    """The query took longer than the allowed wall-clock time."""


def prepare_select(query: str):
    """Parse ``query`` and reject anything that is not a SELECT."""
    try:
        prepared = prepareQuery(query)
    except Exception as exc:  # rdflib raises parser-specific errors
        raise QueryError(f"Could not parse the SPARQL query: {exc}") from exc
    name = getattr(prepared.algebra, "name", "")
    if name != "SelectQuery":
        raise QueryError(
            "Only SELECT queries can be executed here. "
            "Updates and other query forms are not supported."
        )
    return prepared


def _term_json(graph: Graph, term, cache: dict[str, dict]):
    if term is None:
        return None  # unbound variable (OPTIONAL that did not match)
    if isinstance(term, URIRef):
        key = str(term)
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
    """Run a SELECT query and return JSON-serializable results."""
    prepared = prepare_select(query)
    started = time.perf_counter()

    def run():
        result = graph.query(prepared)
        variables = [str(var) for var in (result.vars or [])]
        rows = []
        hit_cap = False
        for row in result:
            if len(rows) >= max_rows:
                hit_cap = True
                break
            rows.append(tuple(row))
        return variables, rows, hit_cap

    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(run)
        try:
            variables, rows, truncated = future.result(timeout=timeout)
        except FuturesTimeout as exc:
            raise QueryTimeout(
                f"The query exceeded the {timeout:.0f}s time limit. "
                "Try adding filters, reducing LIMIT, or avoiding unbounded "
                "path modifiers such as * and +."
            ) from exc
        except QueryError:
            raise
        except Exception as exc:
            raise QueryError(f"The query could not be evaluated: {exc}") from exc
    finally:
        # Never block on a timed-out query; the thread is abandoned to finish
        # (or not) on its own.
        executor.shutdown(wait=False)

    cache: dict[str, dict] = {}
    serialized = [[_term_json(graph, term, cache) for term in row] for row in rows]
    return {
        "vars": variables,
        "rows": serialized,
        "rowCount": len(serialized),
        "truncated": truncated,
        "durationMs": round((time.perf_counter() - started) * 1000, 1),
    }
