"""
================================================================================
FILE: backend/app/embedded_queries.py
================================================================================

SUMMARY
    Finds the SPARQL queries an ontology carries inside itself -- SHACL's
    sh:select, sh:construct and sh:ask, and SPIN's sp:text -- for the query
    panel's "Queries in this file" list (spec sparql-text-and-query-files,
    Section 5.6).

BASIC IDEA
    Each of the four predicates is read by an indexed lookup, so the cost is
    proportional to the number of queries, not to the size of the ontology;
    a 40,000-class file with no queries costs four empty index probes. Only
    literal objects count: an IRI in object position is not query text.

    The listing is bounded twice, and both bounds are reported rather than
    hidden (the repository's honesty rule): at most MAX_ENTRIES rows, with the
    true total beside them, and each text cut at MAX_TEXT_CHARS with a
    `truncated` flag. A cut text is not the query its author wrote, so the
    panel refuses to run it.

    The form is taken from the predicate for SHACL, which names it, and read
    from the text for SPIN, whose sp:text says nothing about its form. Reading
    it is a scan for the first query-form keyword after IRIs and comments are
    removed -- enough to label a row and decide whether Run is offered. It is
    not the security control: whatever the label says, a run still goes
    through prepare_select.

INPUTS / INPUT SOURCES
    - An rdflib Graph (or the read-only MergedView over it and its imports).

EXPECTED OUTPUT
    - list_embedded_queries(graph) -> {"queries": [...], "total", "truncated"}
      where each query is {subject, label, predicate, form, text, truncated,
      shaclVariables}.
    - count_embedded_queries(graph) -> int, for the query schema, so the panel
      knows whether to show the list without making a request of its own.
================================================================================
"""

from __future__ import annotations

import re

from rdflib import BNode, Graph, Literal, URIRef

from .graph_builder import pick_label

SH = "http://www.w3.org/ns/shacl#"
SP = "http://spinrdf.org/sp#"

# Predicate -> the form it names, or None when the text has to say.
EMBEDDED_PREDICATES: dict[URIRef, str | None] = {
    URIRef(SH + "select"): "SELECT",
    URIRef(SH + "construct"): "CONSTRUCT",
    URIRef(SH + "ask"): "ASK",
    URIRef(SP + "text"): None,
}

# The same two numbers as the query endpoint's own limits: a listed text that
# fits here is a text the endpoint will accept.
MAX_ENTRIES = 200
MAX_TEXT_CHARS = 100 * 1024

# IRIs first, because `<http://x/y#z>` holds a `#` that is not a comment.
_IRI = re.compile(r"<[^<>\s]*>")
_COMMENT = re.compile(r"#[^\n]*")
_FORM = re.compile(
    r"\b(SELECT|CONSTRUCT|ASK|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b",
    re.IGNORECASE,
)
_UPDATE_WORDS = {"INSERT", "DELETE", "LOAD", "CLEAR", "CREATE", "DROP", "COPY", "MOVE", "ADD", "WITH"}

# SHACL-SPARQL pre-binds these; run standalone they are ordinary variables,
# which changes what the query means, so the row says so.
_SHACL_VARIABLES = re.compile(r"\$(this|value|PATH|currentShape|shapesGraph)\b")


def query_form(text: str) -> str:
    """SELECT, CONSTRUCT, ASK, DESCRIBE, UPDATE, or UNKNOWN, read from the text."""
    stripped = _COMMENT.sub(" ", _IRI.sub(" ", text))
    match = _FORM.search(stripped)
    if match is None:
        return "UNKNOWN"
    word = match.group(1).upper()
    return "UPDATE" if word in _UPDATE_WORDS else word


def _label(graph: Graph, subject) -> str:
    # SHACL puts the query on a blank node hanging off the shape
    # (`ex:S sh:sparql [ sh:select "..." ]`), and a blank node's own label is
    # its generated id. The shape that points at it is what a reader knows.
    if isinstance(subject, BNode):
        for parent in graph.subjects(None, subject):
            if isinstance(parent, URIRef):
                return pick_label(graph, parent)
        return "Unnamed query"
    return pick_label(graph, subject)


def count_embedded_queries(graph: Graph) -> int:
    return sum(
        1
        for predicate in EMBEDDED_PREDICATES
        for _s, value in graph.subject_objects(predicate)
        if isinstance(value, Literal)
    )


def list_embedded_queries(graph: Graph) -> dict:
    found = [
        (subject, predicate, value)
        for predicate in EMBEDDED_PREDICATES
        for subject, value in graph.subject_objects(predicate)
        if isinstance(value, Literal)
    ]
    # A stable order, so the same file lists the same way on every open; the
    # sort is over the whole set so the rows kept under the cap do not depend
    # on the store's iteration order.
    found.sort(key=lambda row: (isinstance(row[0], BNode), str(row[0]), str(row[1])))

    queries = []
    for subject, predicate, value in found[:MAX_ENTRIES]:
        text = str(value)
        truncated = len(text) > MAX_TEXT_CHARS
        if truncated:
            text = text[:MAX_TEXT_CHARS]
        queries.append(
            {
                "subject": str(subject) if isinstance(subject, URIRef) else None,
                "label": _label(graph, subject),
                "predicate": str(predicate),
                "form": EMBEDDED_PREDICATES[predicate] or query_form(text),
                "text": text,
                "truncated": truncated,
                "shaclVariables": bool(_SHACL_VARIABLES.search(text)),
            }
        )
    return {"queries": queries, "total": len(found), "truncated": len(found) > MAX_ENTRIES}
