"""
================================================================================
FILE: backend/app/reasoning_worker.py
================================================================================

SUMMARY
    The reasoner process's body (axioms-and-reasoning 5.2, D-102): OWL 2 RL
    through OWL-RL over a set of statements sent as N-Triples text, then the
    probe run (5.5, D-104), and the answer sent back down the pipe it was
    given. Nothing else runs here.

BASIC IDEA
    The server starts this in a process of its own, with "spawn" on every
    platform, so a run can be stopped -- killed, not asked -- and a heavy
    one never holds the server's interpreter. What crosses the pipe is text
    and plain lists: N-Triples in, N-Triples and messages out.

    OWL-RL runs as the spec measured it: OWLRL_Semantics, no axiomatic
    triples, no datatype axioms. It writes what it found wrong into the
    graph as blank nodes of its own error vocabulary; those are taken out
    of the added statements and returned as messages.

    The probe run gives each class it is told about one temporary member,
    `urn:semantic-studio:probe:<n>`, and reasons once more over the model
    without the data (a class's being empty does not depend on rows). Only
    its messages come back: the probe members and what was concluded about
    them never leave this process, and the server keeps none of it either.

    Imports: rdflib and owlrl only, never a network client
    (test_no_direct_network.py). The set arrives already built from
    resolved imports; OWL-RL follows no owl:imports.

INPUTS / INPUT SOURCES
    - The model part and the data part of the reasoning set as N-Triples
      text, and the IRIs of the classes to probe.

EXPECTED OUTPUT
    - main(conn, ...) sends one dict: {added (N-Triples), errors,
      probeErrors, ms, probeMs}, or {failed: first line of the error}.
================================================================================
"""

from __future__ import annotations

import time

import owlrl
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF

PROBE = "urn:semantic-studio:probe:"
# Where OWL-RL writes the problems it found (owlrl Closure.py).
ERR = Namespace("http://www.daml.org/2002/03/agents/agent-ont#")


def _closure(graph: Graph) -> list[str]:
    """Expand `graph` in place and take OWL-RL's messages back out of it."""
    owlrl.DeductiveClosure(
        owlrl.OWLRL_Semantics, axiomatic_triples=False, datatype_axioms=False,
    ).expand(graph)
    errors = []
    for message in list(graph.subjects(RDF.type, ERR.ErrorMessage)):
        for text in graph.objects(message, ERR.error):
            if isinstance(text, Literal):
                errors.append(str(text))
        graph.remove((message, None, None))
    return errors


def run(model_nt: str, data_nt: str, probes: list[str]) -> dict:
    started = time.perf_counter()
    graph = Graph()
    # rdflib gives every blank node a fresh id on parse. The ids the server
    # sent are kept here and given back on the way out, so a conclusion
    # about a restriction (order 7 is one of [only Order lines]) names the
    # same blank node the server holds, and the explainer can follow it.
    labels: dict = {}
    graph.parse(data=model_nt, format="nt", bnode_context=labels)
    if data_nt:
        graph.parse(data=data_nt, format="nt", bnode_context=labels)
    sent = {str(fresh): BNode(label) for label, fresh in labels.items()}
    stated = set(graph)
    errors = _closure(graph)
    added = Graph()
    for triple in graph:
        # OWL-RL reasons in generalized RDF: a literal can be a subject
        # ("Manager"@en sameAs itself). N-Triples cannot carry that, and no
        # such statement is ever shown, so it stays here.
        if triple not in stated and not isinstance(triple[0], Literal):
            added.add(tuple(sent.get(str(term), term) if isinstance(term, BNode) else term for term in triple))
    ms = (time.perf_counter() - started) * 1000

    probe_started = time.perf_counter()
    probe_errors: list[str] = []
    if probes:
        probed = Graph()
        probed.parse(data=model_nt, format="nt")
        for n, cls in enumerate(probes):
            probed.add((URIRef(f"{PROBE}{n}"), RDF.type, URIRef(cls)))
        probe_errors = _closure(probed)
    return {
        "added": added.serialize(format="nt"),
        "errors": errors,
        "probeErrors": probe_errors,
        "ms": ms,
        "probeMs": (time.perf_counter() - probe_started) * 1000,
    }


def main(conn, model_nt: str, data_nt: str, probes: list[str]) -> None:
    """The process target. Any failure goes back as its first line, so the
    server can say it in a sentence and carry on."""
    try:
        answer = run(model_nt, data_nt, probes)
    except BaseException as exc:  # noqa: BLE001 - everything is reported, nothing escapes
        text = str(exc).strip().splitlines()
        answer = {"failed": (text[0] if text else type(exc).__name__)[:300]}
    try:
        conn.send(answer)
    finally:
        conn.close()
