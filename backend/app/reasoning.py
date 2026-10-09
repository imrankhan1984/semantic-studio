"""
================================================================================
FILE: backend/app/reasoning.py
================================================================================

SUMMARY
    Reasoning on demand for a project (axioms-and-reasoning Stage A, 5.1 to
    5.7, D-102 to D-104): OWL 2 RL through OWL-RL in a process of its own,
    under a 30-second limit and a 200,000-statement ceiling, one run per
    project, stoppable; then, in the server, what is worth showing (5.4),
    the problems in sentences with their causes (5.5), and a one-step reason
    for every fact shown (5.6). The last result per project is held in
    memory, keyed on what it was computed from, and never written anywhere.

BASIC IDEA
    The engine boundary is one function, `reason(model_nt, data_nt, probes,
    ...) -> RawResult`, with one implementation: reasoning_worker.main in a
    multiprocessing process started with "spawn" on every platform, so Linux
    CI behaves as Windows does. The process gets N-Triples text and gives
    back the statements OWL-RL added and its messages. A run past the limit,
    or stopped, is killed rather than asked, and the parent waits on the
    pipe in short polls so a Stop is seen at once. Nothing outside this file
    and the worker imports owlrl; a later engine replaces `reason`, not the
    panel.

    OWL-RL adds bookkeeping a person does not need (Alice is an owl:Thing,
    Acme is the same as Acme). Of what it added, a fact is shown when both
    ends are named and different, the predicate is one of the six that mean
    something to a learner or a property the project or an import declares,
    and a kind or a membership does not end at a built-in. A symmetric fact
    whose other direction was stated is not new, and a pair concluded both
    ways is shown once. Facts with both ends from an import are counted in a
    group of their own. Every group carries its true total; a page is 200.

    Problems come from OWL-RL's messages, which name the terms by IRI in a
    fixed form for the four 5.5 lists; each is turned into the app's
    sentence, a pair OWL-RL reports once per direction shown once. Anything
    else keeps OWL-RL's words, its IRIs replaced by names. The probe run's
    messages name the test members, each of which stands for one class: that
    class can never have members, and its cause is looked for in the stated
    facts -- a path of *kind of* to each of the disjoint pair, and the
    disjointness itself. Probe members never reach a result: messages that
    name one are turned into a class's sentence, and a test asserts that no
    result contains the scheme.

    The explainer looks, for each fact, for one rule application whose
    premises hold in the closure (stated plus added), in the families of
    5.6, preferring one whose premises were all stated. It is indexed by
    hand rather than through rdflib: explaining 6,000 facts is a few
    hundred thousand lookups, and dictionaries keep that inside the budget.
    A premise that was itself concluded is marked inferred and can be asked
    about in turn, so a learner walks back one step at a time.

    Validity (5.3): a result belongs to the model's revision, the data
    snapshots' generation and the imports view it was computed on. Any of
    them moving makes it stale: the views stop showing its marks, and the
    panel says so. Nothing is re-run without a press.

INPUTS / INPUT SOURCES
    - The reasoning set, built by editing.py under the documents' locks:
      the model with its examples, the merged imports when the switch is on,
      and the data snapshots when asked.
    - The project's languages, for names.

EXPECTED OUTPUT
    - reason(...) -> RawResult; ReasoningService.run/stop/result/forget.
    - Outcome.summary(), .page(group, offset), .about(iri), .why(s, p, o),
      .inferred_kinds(), .inferred_members(), .never_members().
================================================================================
"""

from __future__ import annotations

import multiprocessing
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, XSD

from . import reasoning_worker
from .graph_builder import pick_label_in
from .modeling_checks import article

# Fixed, never settings (5.10, as D-098's row limit is). A test lowers the
# limit through the module attribute, which is all it reads.
TIME_LIMIT_SECONDS = 30.0
MAX_STATEMENTS = 200_000
PAGE = 200
PROBE = reasoning_worker.PROBE

# Each worker is started this way on every platform (D-102): fork on Linux
# would copy the server's threads and locks, and CI would not test what
# Windows runs.
_SPAWN = multiprocessing.get_context("spawn")
# How often a waiting run looks for a Stop.
_POLL_SECONDS = 0.05

BUILT_IN = (str(RDF), str(RDFS), str(OWL), str(XSD))
GROUPS = ("kinds", "same", "memberships", "links")
IMPORTED = "imported"
_SHOWN = {
    RDF.type: "memberships",
    RDFS.subClassOf: "kinds",
    RDFS.subPropertyOf: "kinds",
    OWL.equivalentClass: "same",
    OWL.equivalentProperty: "same",
    OWL.sameAs: "same",
}
_SYMMETRIC = (OWL.equivalentClass, OWL.equivalentProperty, OWL.sameAs)
_PROPERTY_TYPES = (
    OWL.ObjectProperty, OWL.DatatypeProperty, RDF.Property, OWL.TransitiveProperty,
    OWL.SymmetricProperty, OWL.FunctionalProperty, OWL.InverseFunctionalProperty,
    OWL.AsymmetricProperty, OWL.IrreflexiveProperty, OWL.ReflexiveProperty,
)

ENDINGS = {
    "timedOut": f"Stopped after {TIME_LIMIT_SECONDS:g} seconds. Try without the data snapshots, or with fewer imports.",
    "stopped": "Stopped. Nothing was concluded.",
}
RUNNING = "A run is already going."
NO_REASON = (
    "Concluded by the reasoner (OWL 2 RL); Semantic Studio has no plain-words reason for this one."
)


class AlreadyRunning(Exception):
    """A second Reason while one runs for the project (5.2)."""


def built_in(term) -> bool:
    return isinstance(term, URIRef) and str(term).startswith(BUILT_IN)


# ---------------------------------------------------------------------------
# The engine (5.2): one interface, one implementation
# ---------------------------------------------------------------------------


@dataclass
class RawResult:
    status: str                     # done, stopped, timedOut, failed
    added: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    probe_errors: list = field(default_factory=list)
    message: Optional[str] = None   # a failure's first line
    duration_ms: float = 0.0
    probe_ms: float = 0.0           # the probe run's share, measured in the worker


class RunHandle:
    """What Stop reaches: the run's process, once it has one."""

    def __init__(self) -> None:
        self.stop_requested = threading.Event()
        self.process = None

    def stop(self) -> None:
        self.stop_requested.set()
        process = self.process
        if process is not None and process.is_alive():
            process.kill()


def reason(
    model_nt: str,
    data_nt: str,
    probes: list[str],
    *,
    handle: Optional[RunHandle] = None,
    limit: Optional[float] = None,
) -> RawResult:
    """Run OWL-RL over the set in a spawned process, and the probe run after
    it; killed at the limit or on Stop."""
    handle = handle or RunHandle()
    limit = TIME_LIMIT_SECONDS if limit is None else limit
    started = time.perf_counter()
    elapsed = lambda: (time.perf_counter() - started) * 1000  # noqa: E731
    if handle.stop_requested.is_set():
        return RawResult("stopped", duration_ms=elapsed())
    receiver, sender = _SPAWN.Pipe(duplex=False)
    process = _SPAWN.Process(
        target=reasoning_worker.main, args=(sender, model_nt, data_nt, probes), daemon=True,
    )
    try:
        process.start()
    except (OSError, RuntimeError) as exc:
        sender.close()
        receiver.close()
        return RawResult("failed", message=str(exc).strip().splitlines()[0][:300], duration_ms=elapsed())
    handle.process = process
    try:
        sender.close()
        deadline = started + limit
        answer = None
        while answer is None:
            if handle.stop_requested.is_set():
                return RawResult("stopped", duration_ms=elapsed())
            if time.perf_counter() >= deadline:
                return RawResult("timedOut", duration_ms=elapsed())
            if receiver.poll(_POLL_SECONDS):
                try:
                    answer = receiver.recv()
                except (EOFError, OSError):
                    # The pipe closed with nothing on it: a Stop that killed
                    # the process mid-wait, or a process that died.
                    return _ended(handle, process, elapsed())
            elif not process.is_alive():
                if receiver.poll(0):
                    continue
                return _ended(handle, process, elapsed())
        if "failed" in answer:
            return RawResult("failed", message=answer["failed"], duration_ms=elapsed())
        added = Graph()
        # Blank nodes keep the labels the worker was sent (and gave back), so
        # they are the server's own: see reasoning_worker.run.
        added.parse(data=answer["added"], format="nt", bnode_context=_SameLabels())
        return RawResult(
            "done", added=list(added), errors=answer["errors"], probe_errors=answer["probeErrors"],
            duration_ms=elapsed(), probe_ms=answer["probeMs"],
        )
    finally:
        if process.is_alive():
            process.kill()
        process.join(timeout=5)
        receiver.close()


def _ended(handle: RunHandle, process, ms: float) -> RawResult:
    """A process gone without an answer: stopped if Stop killed it -- the
    kill can land between two polls -- else failed."""
    if handle.stop_requested.is_set():
        return RawResult("stopped", duration_ms=ms)
    return RawResult("failed", message=_exit_message(process), duration_ms=ms)


class _SameLabels(dict):
    """A blank-node context that maps every label to itself: rdflib's
    N-Triples parser asks it with get()."""

    def get(self, key, default=None):
        return key


def _exit_message(process) -> str:
    process.join(timeout=1)
    return f"the process ended with exit code {process.exitcode}"


# ---------------------------------------------------------------------------
# An index of the closure, for the filter and the explainer
# ---------------------------------------------------------------------------


class Index:
    """Triples by (s, p), (p, o) and p. `objects` matches rdflib's, so the
    label picker reads names from it."""

    def __init__(self, triples: Iterable[tuple]) -> None:
        self.all: set = set()
        self.sp: dict = {}
        self.po: dict = {}
        self.p: dict = {}
        for t in triples:
            self.add(t)

    def copy(self) -> "Index":
        """The same triples, in sets of their own: cheaper than adding each."""
        other = Index(())
        other.all = set(self.all)
        other.sp = {k: set(v) for k, v in self.sp.items()}
        other.po = {k: set(v) for k, v in self.po.items()}
        other.p = {k: set(v) for k, v in self.p.items()}
        return other

    def add(self, t: tuple) -> None:
        if t in self.all:
            return
        s, p, o = t
        self.all.add(t)
        self.sp.setdefault((s, p), set()).add(o)
        self.po.setdefault((p, o), set()).add(s)
        self.p.setdefault(p, set()).add((s, o))

    def __contains__(self, t) -> bool:
        return t in self.all

    def objects(self, s, p) -> set:
        return self.sp.get((s, p), set())

    def subjects(self, p, o) -> set:
        return self.po.get((p, o), set())

    def pairs(self, p) -> set:
        return self.p.get(p, set())

    def first(self, s, p):
        for o in self.objects(s, p):
            return o
        return None

    def items(self, head) -> list:
        """An RDF list's members, a loop or a broken list cut short."""
        out, seen = [], set()
        while isinstance(head, (BNode, URIRef)) and head != RDF.nil and head not in seen:
            seen.add(head)
            value = self.first(head, RDF.first)
            if value is None:
                break
            out.append(value)
            head = self.first(head, RDF.rest)
        return out


# ---------------------------------------------------------------------------
# The result: what is shown, the problems, and why
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Key:
    """What a result was computed on (5.3). `view` is the imports view the
    set was built from, compared by identity, as the canvas's cache does."""

    revision: int
    generation: int
    imports: bool
    include_data: bool
    view: object = None

    def text(self) -> str:
        return f"{self.revision}+{self.generation}|{'imports' if self.imports else 'model'}|{'data' if self.include_data else 'no-data'}"

    def same_model(self, other: "Key") -> bool:
        return (
            self.revision == other.revision and self.generation == other.generation
            and self.imports == other.imports and self.view is other.view
        )


class Outcome:
    """One finished run, kept in memory for its project until the next run
    or the project's close."""

    def __init__(
        self,
        status: str,
        key: Key,
        *,
        statements: int = 0,
        duration_ms: float = 0.0,
        message: Optional[str] = None,
        stated: Optional[Index] = None,
        closure: Optional[Index] = None,
        names: Optional[Callable] = None,
        facts: Optional[dict] = None,
        problems: Optional[list] = None,
        never: Optional[set] = None,
    ) -> None:
        self.status = status
        self.key = key
        self.statements = statements
        self.duration_ms = duration_ms
        self.message = message
        self.stated = stated
        self.closure = closure
        self.names = names
        self.facts = facts or {g: [] for g in (*GROUPS, IMPORTED)}
        self.problems = problems or []
        self.never = never or set()
        self.shown = {f["t"] for listed in self.facts.values() for f in listed}

    # --- what the routes answer ---

    def sentence(self) -> Optional[str]:
        if self.status == "done":
            return None
        if self.status == "failed":
            return f"The reasoner stopped with an error: {self.message}"
        if self.status == "tooLarge":
            return (
                f"This project has {self.statements:,} statements to reason over. Semantic Studio "
                f"reasons over at most {MAX_STATEMENTS:,}: try without the data snapshots, or "
                "with fewer imports."
            )
        return ENDINGS.get(self.status)

    def summary(self, current: Optional[Key] = None) -> dict:
        return {
            "status": self.status,
            "key": self.key.text(),
            # What the browser compares with its own revision, generation and
            # switch, so the marks go the moment the model moves (5.3).
            "basis": {"revision": self.key.revision, "generation": self.key.generation, "imports": self.key.imports},
            "includeData": self.key.include_data,
            "imports": self.key.imports,
            "durationMs": round(self.duration_ms),
            "statements": self.statements,
            "sentence": self.sentence(),
            "problems": self.problems,
            "groups": [self._group(kind, 0) for kind in GROUPS],
            "importedFacts": self._group(IMPORTED, 0),
            "stale": self.stale(current),
        }

    def stale(self, current: Optional[Key]) -> bool:
        return current is not None and not self.key.same_model(current)

    def _group(self, kind: str, offset: int) -> dict:
        listed = self.facts.get(kind, [])
        return {
            "kind": kind,
            "total": len(listed),
            "offset": offset,
            "items": [_public(f) for f in listed[offset:offset + PAGE]],
        }

    def page(self, kind: str, offset: int, current: Optional[Key] = None) -> dict:
        if kind not in self.facts:
            raise KeyError(kind)
        return {**self._group(kind, max(offset, 0)), "stale": self.stale(current)}

    def about(self, iri: str, current: Optional[Key] = None) -> dict:
        """The facts that start or end at one entity, for the detail panel."""
        node = URIRef(iri)
        facts = [
            _public(f) for kind in (*GROUPS, IMPORTED) for f in self.facts.get(kind, [])
            if f["t"][0] == node or f["t"][2] == node
        ]
        return {
            "iri": iri,
            "facts": facts,
            "neverMembers": node in self.never,
            "stale": self.stale(current),
        }

    def why(self, s: str, p: str, o: str) -> Optional[dict]:
        """The one-step reason for a fact this result holds: a shown one, or
        a premise of one (which may itself have been concluded)."""
        if self.closure is None:
            return None
        t = (_term(s), URIRef(p), _term(o))
        if t not in self.closure:
            return None
        if t in self.stated:
            return {"family": "stated", "sentence": f"{fact_sentence(t, self.names)} (stated).", "premises": []}
        return Explainer(self.stated, self.closure, self.names).explain(t)

    # --- what the tree and the canvas draw (5.7) ---

    def inferred_kinds(self) -> list[tuple]:
        return [f["t"] for f in self.facts["kinds"] + self.facts[IMPORTED] if f["t"][1] == RDFS.subClassOf]

    def inferred_members(self) -> list[tuple]:
        return [f["t"] for f in self.facts["memberships"] + self.facts[IMPORTED] if f["t"][1] == RDF.type]

    def never_members(self) -> set:
        return set(self.never)


def _term(text: str):
    """An IRI from the request, or a plain literal for a value premise."""
    return URIRef(text) if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", text) else Literal(text)


def _public(fact: dict) -> dict:
    return {k: v for k, v in fact.items() if k != "t"}


def triple_json(t: tuple, names: Callable) -> dict:
    s, p, o = t
    return {
        "s": str(s), "p": str(p), "o": str(o),
        "sLabel": names(s), "pLabel": names(p), "oLabel": names(o),
    }


# ---------------------------------------------------------------------------
# Sentences (5.4 to 5.6), in the learner's words and E-8's
# ---------------------------------------------------------------------------


def a(name: str) -> str:
    return f"{article(name)} {name}"


def fact_sentence(t: tuple, names: Callable) -> str:
    s, p, o = t
    if p == RDF.type:
        return f"{names(s)} is {a(names(o))}"
    if p in (RDFS.subClassOf, RDFS.subPropertyOf):
        return f"{names(s)} is a kind of {names(o)}"
    if p in (OWL.equivalentClass, OWL.equivalentProperty):
        return f"{names(s)} and {names(o)} mean the same thing"
    if p == OWL.sameAs:
        return f"{names(s)} and {names(o)} are the same thing"
    if p == OWL.differentFrom:
        return f"{names(s)} and {names(o)} are different things"
    if p == OWL.disjointWith:
        return f"no {names(s)} is {a(names(o))}"
    if p == OWL.inverseOf:
        return f"{names(s)} is {names(o)} the other way round"
    if p == RDFS.domain:
        return f"whoever {names(s)} something is {a(names(o))}"
    if p == RDFS.range:
        return f"whatever something {names(s)} is {a(names(o))}"
    return f"{names(s)} {names(p)} {names(o)}"


_CHARACTERISTIC = {
    OWL.TransitiveProperty: "chains",
    OWL.SymmetricProperty: "works both ways",
    OWL.FunctionalProperty: "is at most one",
    OWL.InverseFunctionalProperty: "identifies its start",
    OWL.IrreflexiveProperty: "is never to itself",
    OWL.AsymmetricProperty: "is never both ways",
}


def premise(t: tuple, stated: Index, names: Callable) -> dict:
    """One line of a reason: the fact, its sentence, and stated or inferred."""
    s, p, o = t
    if p == RDF.type and o in _CHARACTERISTIC:
        text = f"{names(s)} {_CHARACTERISTIC[o]}"
    else:
        text = fact_sentence(t, names)
    return {**triple_json(t, names), "sentence": text, "inferred": t not in stated}


def definition(cls, text: str, kind=OWL.equivalentClass) -> dict:
    """A premise that is a class's definition or rule, written with blank
    nodes: no triple of its own to link, so it is a sentence, always stated."""
    return {"s": str(cls), "p": str(kind), "o": None, "sentence": text, "inferred": False}


# ---------------------------------------------------------------------------
# The explainer (5.6, D-103)
# ---------------------------------------------------------------------------


FAMILIES = (
    "kindChain", "memberKind", "domainRange", "inverse", "symmetric", "transitive",
    "subProperty", "defining", "only", "same", "sameThing",
)


class Explainer:
    def __init__(self, stated: Index, closure: Index, names: Callable) -> None:
        self.stated = stated
        self.c = closure
        self.names = names

    # Each candidate is (family, premise triples, extra premises, joining
    # words); the first whose premises were all stated wins, else the first.
    def explain(self, t: tuple) -> dict:
        best = None
        for candidate in self._candidates(t):
            triples = candidate[1]
            if all(x in self.stated for x in triples):
                best = candidate
                break
            if best is None:
                best = candidate
        if best is None:
            return {"family": None, "sentence": NO_REASON, "premises": []}
        family, triples, extra, text = best
        premises = [premise(x, self.stated, self.names) for x in triples] + extra
        return {"family": family, "sentence": text, "premises": premises}

    def _n(self, term) -> str:
        return self.names(term)

    def _candidates(self, t: tuple):
        s, p, o = t
        c, n = self.c, self._n
        if p in (RDFS.subClassOf, RDFS.subPropertyOf):
            eq = OWL.equivalentClass if p == RDFS.subClassOf else OWL.equivalentProperty
            for x in ((s, eq, o), (o, eq, s)):
                if x in c:
                    yield "same", [x], [], f"{n(s)} and {n(o)} mean the same thing"
            for m in c.objects(s, p):
                if isinstance(m, URIRef) and m not in (s, o) and (m, p, o) in c:
                    yield "kindChain", [(s, p, m), (m, p, o)], [], (
                        f"{n(s)} is a kind of {n(m)}, and {n(m)} is a kind of {n(o)}"
                    )
            for m in c.objects(s, p):
                if isinstance(m, URIRef) and m not in (s, o):
                    for x in ((m, eq, o), (o, eq, m)):
                        if x in c:
                            yield "same", [(s, p, m), x], [], (
                                f"{n(s)} is a kind of {n(m)}, and {n(m)} and {n(o)} mean the same thing"
                            )
            if p == RDFS.subClassOf:
                for d in c.objects(s, OWL.equivalentClass):
                    if isinstance(d, BNode) and o in c.items(c.first(d, OWL.intersectionOf)):
                        yield "defining", [], [definition(s, self._defines(s, d))], (
                            f"{self._defines(s, d)}, so every {n(s)} is {a(n(o))}"
                        )
            return
        if p == RDF.type:
            yield from self._membership(s, o)
            return
        if p == OWL.sameAs:
            yield from self._same_thing(s, o)
            return
        if p in (OWL.equivalentClass, OWL.equivalentProperty):
            sub = RDFS.subClassOf if p == OWL.equivalentClass else RDFS.subPropertyOf
            if (s, sub, o) in c and (o, sub, s) in c:
                yield "same", [(s, sub, o), (o, sub, s)], [], (
                    f"{n(s)} is a kind of {n(o)} and {n(o)} is a kind of {n(s)}, so they mean the same thing"
                )
            for m in c.objects(s, p):
                if isinstance(m, URIRef) and m not in (s, o) and ((m, p, o) in c or (o, p, m) in c):
                    second = (m, p, o) if (m, p, o) in c else (o, p, m)
                    yield "same", [(s, p, m), second], [], (
                        f"{n(s)} and {n(m)} mean the same thing, and so do {n(m)} and {n(o)}"
                    )
            return
        yield from self._link(s, p, o)

    def _membership(self, s, o):
        c, n = self.c, self._n
        for k in c.objects(s, RDF.type):
            if isinstance(k, URIRef) and k != o and (k, RDFS.subClassOf, o) in c:
                yield "memberKind", [(s, RDF.type, k), (k, RDFS.subClassOf, o)], [], (
                    f"{n(s)} is {a(n(k))}, and every {n(k)} is {a(n(o))}"
                )
        for k in c.objects(s, RDF.type):
            if isinstance(k, URIRef) and k != o:
                for x in ((k, OWL.equivalentClass, o), (o, OWL.equivalentClass, k)):
                    if x in c:
                        yield "same", [(s, RDF.type, k), x], [], (
                            f"{n(s)} is {a(n(k))}, and {n(k)} and {n(o)} mean the same thing"
                        )
        for prop, x in c.pairs(RDFS.domain):
            if x == o:
                for y in c.objects(s, prop):
                    yield "domainRange", [(s, prop, y), (prop, RDFS.domain, o)], [], (
                        f"{n(s)} {n(prop)} {n(y)}, and whoever {n(prop)} something is {a(n(o))}"
                    )
                    break
        for prop, x in c.pairs(RDFS.range):
            if x == o:
                for y in c.subjects(prop, s):
                    yield "domainRange", [(y, prop, s), (prop, RDFS.range, o)], [], (
                        f"{n(y)} {n(prop)} {n(s)}, and whatever something {n(prop)} is {a(n(o))}"
                    )
                    break
        # A defining restriction: o is exactly something the restriction
        # (or the intersection holding it) describes.
        for d in c.objects(o, OWL.equivalentClass) | c.subjects(OWL.equivalentClass, o):
            if isinstance(d, BNode):
                met = self._meets(s, d)
                if met is not None:
                    triples, _ = met
                    words = " and ".join(fact_sentence(x, self.names) for x in triples)
                    yield "defining", triples, [definition(o, self._defines(o, d))], (
                        f"{words}, and {self._defines(o, d)}"
                    )
        # Only: something links to s through a property every one of its
        # class's values must be an o.
        for r in c.subjects(OWL.allValuesFrom, o):
            prop = c.first(r, OWL.onProperty)
            if prop is None:
                continue
            for x in c.subjects(prop, s):
                if (x, RDF.type, r) in c:
                    owner = next(
                        (k for k in c.objects(x, RDF.type)
                         if isinstance(k, URIRef) and (k, RDFS.subClassOf, r) in c),
                        None,
                    )
                    rule = (
                        f"every {n(owner)}'s {n(prop)} can only be {_plural(n(o))}"
                        if owner is not None else f"its {n(prop)} can only be {_plural(n(o))}"
                    )
                    triples = [(x, prop, s)] + ([(x, RDF.type, owner)] if owner is not None else [])
                    yield "only", triples, [definition(owner or o, rule, RDFS.subClassOf)], (
                        f"{n(x)} {n(prop)} {n(s)}, and {rule}"
                    )
        for m in c.objects(s, OWL.sameAs):
            if m != s and (m, RDF.type, o) in c:
                yield "same", [(s, OWL.sameAs, m), (m, RDF.type, o)], [], (
                    f"{n(s)} and {n(m)} are the same thing, and {n(m)} is {a(n(o))}"
                )

    def _meets(self, s, d) -> Optional[tuple]:
        """The facts by which s meets the class expression d, or None."""
        c = self.c
        members = c.items(c.first(d, OWL.intersectionOf))
        if members:
            facts: list = []
            for m in members:
                if isinstance(m, URIRef):
                    if (s, RDF.type, m) not in c:
                        return None
                    facts.append((s, RDF.type, m))
                else:
                    met = self._meets(s, m)
                    if met is None:
                        return None
                    facts += met[0]
            return facts, None
        prop = c.first(d, OWL.onProperty)
        if prop is None:
            return None
        value = c.first(d, OWL.hasValue)
        if value is not None:
            return ([(s, prop, value)], None) if (s, prop, value) in c else None
        filler = c.first(d, OWL.someValuesFrom)
        if filler is not None:
            for y in c.objects(s, prop):
                if filler == OWL.Thing:
                    return [(s, prop, y)], None
                if (y, RDF.type, filler) in c:
                    return [(s, prop, y), (y, RDF.type, filler)], None
        return None

    def _defines(self, cls, d) -> str:
        """*a Manager is exactly a Person that manages at least one Employee*."""
        return f"{a(self._n(cls))} is exactly {self._expression(d)}"

    def _expression(self, d) -> str:
        c, n = self.c, self._n
        members = c.items(c.first(d, OWL.intersectionOf))
        if members:
            named = [m for m in members if isinstance(m, URIRef)]
            rest = [self._restriction(m) for m in members if not isinstance(m, URIRef)]
            head = " and ".join(a(n(m)) for m in named) if named else "something"
            return f"{head} that {' and '.join(rest)}" if rest else head
        return f"something that {self._restriction(d)}"

    def _restriction(self, d) -> str:
        c, n = self.c, self._n
        prop = c.first(d, OWL.onProperty)
        if prop is None:
            return "meets a rule"
        value = c.first(d, OWL.hasValue)
        if value is not None:
            return f"{n(prop)} {n(value)}"
        filler = c.first(d, OWL.someValuesFrom)
        if filler is not None:
            return f"{n(prop)} at least one {n(filler)}" if filler != OWL.Thing else f"{n(prop)} something"
        return f"{n(prop)} as a rule says"

    def _same_thing(self, s, o):
        c, n = self.c, self._n
        for prop in c.subjects(RDF.type, OWL.FunctionalProperty):
            for x in c.subjects(prop, s):
                if (x, prop, o) in c:
                    yield "sameThing", [(x, prop, s), (x, prop, o), (prop, RDF.type, OWL.FunctionalProperty)], [], (
                        f"{n(x)} {n(prop)} {n(s)} and {n(o)}, and {n(prop)} is at most one, so they are the same"
                    )
        for prop in c.subjects(RDF.type, OWL.InverseFunctionalProperty):
            for y in c.objects(s, prop):
                if (o, prop, y) in c:
                    yield "sameThing", [(s, prop, y), (o, prop, y), (prop, RDF.type, OWL.InverseFunctionalProperty)], [], (
                        f"{n(s)} and {n(o)} both {n(prop)} {n(y)}, and {n(prop)} identifies its start, so they are the same"
                    )
        for kind in (OWL.maxCardinality, OWL.maxQualifiedCardinality):
            for r, value in c.pairs(kind):
                if not (isinstance(value, Literal) and str(value) == "1"):
                    continue
                prop = c.first(r, OWL.onProperty)
                for x in c.subjects(RDF.type, r):
                    if prop is not None and (x, prop, s) in c and (x, prop, o) in c:
                        yield "sameThing", [(x, prop, s), (x, prop, o)], [definition(r, f"{n(x)} {n(prop)} at most one thing", RDFS.subClassOf)], (
                            f"{n(x)} {n(prop)} {n(s)} and {n(o)}, and has at most one, so they are the same"
                        )
        for m in c.objects(s, OWL.sameAs):
            if m not in (s, o) and ((m, OWL.sameAs, o) in c):
                yield "same", [(s, OWL.sameAs, m), (m, OWL.sameAs, o)], [], (
                    f"{n(s)} and {n(m)} are the same thing, and so are {n(m)} and {n(o)}"
                )

    def _link(self, s, p, o):
        c, n = self.c, self._n
        for q in c.objects(p, OWL.inverseOf) | c.subjects(OWL.inverseOf, p):
            if (o, q, s) in c:
                rule = (p, OWL.inverseOf, q) if (p, OWL.inverseOf, q) in c else (q, OWL.inverseOf, p)
                yield "inverse", [(o, q, s), rule], [], (
                    f"{n(o)} {n(q)} {n(s)}, and {n(p)} is {n(q)} the other way round"
                )
        if (p, RDF.type, OWL.SymmetricProperty) in c and (o, p, s) in c:
            yield "symmetric", [(o, p, s), (p, RDF.type, OWL.SymmetricProperty)], [], (
                f"{n(o)} {n(p)} {n(s)}, and {n(p)} works both ways"
            )
        if (p, RDF.type, OWL.TransitiveProperty) in c:
            for m in c.objects(s, p):
                if m not in (s, o) and (m, p, o) in c:
                    yield "transitive", [(s, p, m), (m, p, o), (p, RDF.type, OWL.TransitiveProperty)], [], (
                        f"{n(s)} {n(p)} {n(m)}, {n(m)} {n(p)} {n(o)}, and {n(p)} chains"
                    )
        for q in c.subjects(RDFS.subPropertyOf, p):
            if q != p and (s, q, o) in c:
                yield "subProperty", [(s, q, o), (q, RDFS.subPropertyOf, p)], [], (
                    f"{n(s)} {n(q)} {n(o)}, and {n(q)} is a kind of {n(p)}"
                )
        for q in c.objects(p, OWL.equivalentProperty) | c.subjects(OWL.equivalentProperty, p):
            if q != p and (s, q, o) in c:
                rule = (p, OWL.equivalentProperty, q) if (p, OWL.equivalentProperty, q) in c else (q, OWL.equivalentProperty, p)
                yield "same", [(s, q, o), rule], [], (
                    f"{n(s)} {n(q)} {n(o)}, and {n(q)} and {n(p)} mean the same thing"
                )
        # *Every Gold customer has status gold*: a has-value rule on one of
        # s's classes.
        for r in c.subjects(OWL.hasValue, o):
            if c.first(r, OWL.onProperty) == p:
                for k in c.objects(s, RDF.type):
                    if isinstance(k, URIRef) and (k, RDFS.subClassOf, r) in c:
                        rule = f"every {n(k)} {n(p)} {n(o)}"
                        yield "defining", [(s, RDF.type, k)], [definition(k, rule, RDFS.subClassOf)], (
                            f"{n(s)} is {a(n(k))}, and {rule}"
                        )
        for m in c.objects(s, OWL.sameAs):
            if m != s and (m, p, o) in c:
                yield "same", [(s, OWL.sameAs, m), (m, p, o)], [], (
                    f"{n(s)} and {n(m)} are the same thing, and {n(m)} {n(p)} {n(o)}"
                )
        for m in c.objects(o, OWL.sameAs):
            if m != o and (s, p, m) in c:
                yield "same", [(o, OWL.sameAs, m), (s, p, m)], [], (
                    f"{n(o)} and {n(m)} are the same thing, and {n(s)} {n(p)} {n(m)}"
                )


def _plural(name: str) -> str:
    if name.endswith(("s", "x", "ch", "sh")):
        return f"{name}es"
    if name.endswith("y") and name[-2:-1] not in "aeiou":
        return f"{name[:-1]}ies"
    return f"{name}s"


# ---------------------------------------------------------------------------
# From a raw result to what is shown (5.4, 5.5)
# ---------------------------------------------------------------------------


_DISJOINT = re.compile(r"^Disjoint classes (\S+) and (\S+) have a common individual (\S+)$")
_IRREFLEXIVE = re.compile(r"^Irreflexive property used on (\S+) with (\S+)$")
_ASYMMETRIC = re.compile(r"^Erroneous usage of asymmetric property (\S+) on (\S+) and (\S+)$")
_DIFFERENT = re.compile(
    r"^'sameAs' and 'differentFrom' cannot be used on the same subject-object pair: \((\S+), (\S+)\)$"
)
_IRI = re.compile(r"(?:https?|urn|file|tag):[^\s,()'\"]+")
_PROBE_IN = re.compile(re.escape(PROBE) + r"(\d+)")


def analyse(
    stated_triples: Iterable[tuple],
    raw: RawResult,
    *,
    key: Key,
    languages: list[str],
    probes: list[str],
    imported: Optional[set] = None,
    statements: int = 0,
) -> Outcome:
    """Filter, group, explain nothing yet (Why? is asked per fact), and turn
    OWL-RL's messages into problems."""
    stated = Index(stated_triples)
    closure = stated.copy()
    for t in raw.added:
        closure.add(t)
    label_cache: dict = {}

    # Names come from the stated facts only: OWL-RL copies a label across
    # owl:sameAs, and Anne would be named Ann.
    def names(term) -> str:
        found = label_cache.get(term)
        if found is None:
            if isinstance(term, Literal):
                found = str(term)
            elif isinstance(term, URIRef):
                found = pick_label_in(stated, term, languages)[0]
            else:
                found = "something"
            label_cache[term] = found
        return found

    imported = imported or set()
    properties = {
        s for t in _PROPERTY_TYPES for s in stated.subjects(RDF.type, t)
        if isinstance(s, URIRef) and not built_in(s)
    }
    facts: dict = {g: [] for g in (*GROUPS, IMPORTED)}
    seen_pairs: set = set()
    for t in raw.added:
        s, p, o = t
        group = _SHOWN.get(p)
        if group is None:
            if p not in properties:
                continue
            group = "links"
        if not (isinstance(s, URIRef) and isinstance(o, URIRef)) or s == o:
            continue
        if str(s).startswith(PROBE) or str(o).startswith(PROBE):
            continue
        if built_in(s) or (p in (RDF.type, RDFS.subClassOf, RDFS.subPropertyOf) and built_in(o)):
            continue
        if p in _SYMMETRIC:
            if (o, p, s) in stated:
                continue  # the stated fact read backwards is not new
            pair = (p, frozenset((s, o)))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            # Concluded both ways, the pair is shown one way, the same one
            # every run: the IRIs' order, not the set's.
            if str(o) < str(s) and (o, p, s) in closure:
                s, o = o, s
                t = (s, p, o)
        if str(s) in imported and str(o) in imported:
            group = IMPORTED
        facts[group].append({**triple_json(t, names), "sentence": fact_sentence(t, names), "t": t})
    for listed in facts.values():
        listed.sort(key=lambda f: (_natural(f["sentence"]), f["s"], f["o"]))

    main_errors = set(raw.errors)
    problems: list = []
    reported: set = set()
    for message in raw.errors:
        problem = _problem(message, stated, closure, names)
        if problem is None or problem["id"] in reported:
            continue
        reported.add(problem["id"])
        problems.append(problem)
    never: set = set()
    for message in raw.probe_errors:
        found = [int(m) for m in _PROBE_IN.findall(message)]
        if not found:
            # A probe that met a contradiction through another thing (5.5),
            # once: one already in the model's own run is not new.
            if message in main_errors:
                continue
            problem = _reasoner_words(message, names)
            if problem["id"] not in reported:
                reported.add(problem["id"])
                problems.append(problem)
            continue
        for index in found:
            if index >= len(probes):
                continue
            cls = URIRef(probes[index])
            if cls in never:
                continue
            never.add(cls)
            problems.append(_never_members(cls, message, stated, names, probes))
    # A class can never have members before a thing's contradiction: it is
    # what the learner fixes first.
    problems.sort(key=lambda pr: (pr["kind"] != "neverMembers", pr["sentence"].casefold()))
    for problem in problems:
        problem.pop("id", None)
    return Outcome(
        "done", key, statements=statements, duration_ms=raw.duration_ms, stated=stated, closure=closure,
        names=names, facts=facts, problems=problems, never=never,
    )


def _natural(text: str) -> tuple:
    """A sort key that reads numbers as numbers: Org 2 before Org 10."""
    return tuple(int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", text))


def _cause(t: tuple, stated: Index, names: Callable) -> dict:
    return premise(t, stated, names)


def _problem(message: str, stated: Index, closure: Index, names: Callable) -> Optional[dict]:
    m = _DISJOINT.match(message)
    if m:
        c1, c2, x = (URIRef(v) for v in m.groups())
        if str(x).startswith(PROBE):
            return None
        rule = (c1, OWL.disjointWith, c2) if (c1, OWL.disjointWith, c2) in stated else (c2, OWL.disjointWith, c1)
        causes = [_cause((x, RDF.type, c1), stated, names), _cause((x, RDF.type, c2), stated, names)]
        if rule in stated:
            causes.append(_cause(rule, stated, names))
        return {
            "id": ("disjoint", x, frozenset((c1, c2))),
            "kind": "disjointMember",
            "sentence": (
                f"{names(x)} cannot be both {a(names(c1))} and {a(names(c2))}: "
                f"no {names(c1)} is {a(names(c2))}."
            ),
            "subject": str(x),
            "causes": causes,
        }
    m = _IRREFLEXIVE.match(message)
    if m:
        x, p = (URIRef(v) for v in m.groups())
        return {
            "id": ("irreflexive", x, p),
            "kind": "irreflexive",
            "sentence": f"{names(x)} is linked to itself by {names(p)}, which is never to itself.",
            "subject": str(x),
            "causes": [_cause((x, p, x), stated, names), _cause((p, RDF.type, OWL.IrreflexiveProperty), stated, names)],
        }
    m = _ASYMMETRIC.match(message)
    if m:
        p, x, y = (URIRef(v) for v in m.groups())
        first, second = sorted((x, y), key=str)
        return {
            "id": ("asymmetric", p, frozenset((x, y))),
            "kind": "asymmetric",
            "sentence": (
                f"{names(first)} {names(p)} {names(second)} and {names(second)} {names(p)} "
                f"{names(first)}, but {names(p)} is never both ways."
            ),
            "subject": str(first),
            "causes": [
                _cause((first, p, second), stated, names), _cause((second, p, first), stated, names),
                _cause((p, RDF.type, OWL.AsymmetricProperty), stated, names),
            ],
        }
    m = _DIFFERENT.match(message)
    if m:
        x, y = (URIRef(v) for v in m.groups())
        if x == y:
            # Anne different from Anne: the same contradiction carried over
            # by sameAs, reported once for the pair that was stated.
            return None
        first, second = sorted((x, y), key=str)
        same = (first, OWL.sameAs, second) if (first, OWL.sameAs, second) in closure else (second, OWL.sameAs, first)
        different = (
            (first, OWL.differentFrom, second) if (first, OWL.differentFrom, second) in stated
            else (second, OWL.differentFrom, first)
        )
        return {
            "id": ("different", frozenset((x, y))),
            "kind": "differentSame",
            "sentence": (
                f"{names(first)} and {names(second)} are stated to be different things, "
                "but the reasoner concludes they are the same thing."
            ),
            "subject": str(first),
            "causes": [_cause(different, stated, names), _cause(same, stated, names)],
        }
    return _reasoner_words(message, names)


def _reasoner_words(message: str, names: Callable, replace: Optional[Callable] = None) -> dict:
    """OWL-RL's own message, its IRIs shown by name (5.5)."""
    def name(m: re.Match) -> str:
        text = m.group(0)
        if replace is not None:
            swapped = replace(text)
            if swapped is not None:
                return swapped
        return names(URIRef(text))

    return {
        "id": ("other", message),
        "kind": "other",
        "sentence": f"{_IRI.sub(name, message)} (the reasoner's words)",
        "subject": None,
        "causes": [],
    }


def _never_members(cls, message: str, stated: Index, names: Callable, probes: list[str]) -> dict:
    """*Robot can never have members: it is a kind of Person and a kind of
    Organization, and no Person is an Organization.*"""
    def probe_name(text: str) -> Optional[str]:
        m = _PROBE_IN.fullmatch(text)
        if m is None:
            return None
        index = int(m.group(1))
        owner = probes[index] if index < len(probes) else None
        return f"a test member of {names(URIRef(owner))}" if owner else "a test member"

    words = _reasoner_words(message, names, probe_name)["sentence"]
    base = f"{names(cls)} can never have members"
    m = _DISJOINT.match(message)
    if m:
        c1, c2 = URIRef(m.group(1)), URIRef(m.group(2))
        rule = (c1, OWL.disjointWith, c2) if (c1, OWL.disjointWith, c2) in stated else (c2, OWL.disjointWith, c1)
        paths = [_kind_path(stated, cls, c) for c in (c1, c2)]
        if all(path is not None for path in paths) and rule in stated:
            causes = [_cause(t, stated, names) for path in paths for t in path] + [_cause(rule, stated, names)]
            kinds = [f"a kind of {names(c)}" for c in (c1, c2) if c != cls]
            return {
                "kind": "neverMembers",
                "sentence": f"{base}: it is {' and '.join(kinds)}, and no {names(rule[0])} is {a(names(rule[2]))}.",
                "subject": str(cls),
                "causes": causes,
                "reasoner": words,
            }
    return {"kind": "neverMembers", "sentence": f"{base}.", "subject": str(cls), "causes": [], "reasoner": words}


def _kind_path(stated: Index, start, goal) -> Optional[list]:
    """The stated *kind of* steps from start to goal, shortest first; []
    when they are the same class."""
    if start == goal:
        return []
    previous: dict = {start: None}
    queue = [start]
    while queue:
        node = queue.pop(0)
        for parent in stated.objects(node, RDFS.subClassOf):
            if isinstance(parent, URIRef) and parent not in previous:
                previous[parent] = node
                if parent == goal:
                    path, at = [], goal
                    while previous[at] is not None:
                        path.append((previous[at], RDFS.subClassOf, at))
                        at = previous[at]
                    return list(reversed(path))
                queue.append(parent)
    return None


def too_large(key: Key, statements: int) -> Outcome:
    return Outcome("tooLarge", key, statements=statements)


# ---------------------------------------------------------------------------
# One run per project, the last result held (5.2, 5.3)
# ---------------------------------------------------------------------------


class ReasoningService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running: dict[str, RunHandle] = {}
        self._results: dict[str, Outcome] = {}

    def begin(self, pid: str) -> RunHandle:
        """Claim the project's one run, or refuse with 409's sentence."""
        with self._lock:
            if pid in self._running:
                raise AlreadyRunning(RUNNING)
            handle = RunHandle()
            self._running[pid] = handle
            return handle

    def end(self, pid: str, handle: RunHandle, outcome: Optional[Outcome]) -> None:
        with self._lock:
            if self._running.get(pid) is handle:
                del self._running[pid]
            if outcome is not None:
                self._results[pid] = outcome

    def running(self, pid: str) -> bool:
        with self._lock:
            return pid in self._running

    def stop(self, pid: str) -> bool:
        with self._lock:
            handle = self._running.get(pid)
        if handle is None:
            return False
        handle.stop()
        return True

    def result(self, pid: str) -> Optional[Outcome]:
        with self._lock:
            return self._results.get(pid)

    def forget(self, pid: str) -> None:
        """The project closed: stop its run and drop its result."""
        self.stop(pid)
        with self._lock:
            self._results.pop(pid, None)


service = ReasoningService()
