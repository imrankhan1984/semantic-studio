"""
================================================================================
FILE: backend/app/modeling_checks.py
================================================================================

SUMMARY
    The modeling checks of relationships-and-project-kinds 5.9: the
    combinations a learner meets in practice that make no sense, each
    answered in plain words. A refusal is a sentence the command layer raises
    before anything changes; a warning is a sentence the form shows on the
    relationship until what it describes is resolved.

BASIC IDEA
    The checks read the document's graph and nothing else, so the same
    function serves a command before it runs (editing.py) and the form after
    (the node route, through warnings()). Every sentence is built from the
    learner's own names, never from OWL terms.

    Refusals: two characteristics that contradict each other, a relationship
    made its own inverse, *related to* between two concepts one of which is
    already broader than the other (directly or through others) and, the
    same rule read the other way, *narrower than* between two concepts that
    are already related, and a
    broader or sub-relationship link that would make a loop. Each check
    reads its hierarchy once, one scan of the predicate, and walks up from
    the one or two nodes it is about (the 20 ms budget of Section 10).

    Warnings are what the model may say but rarely means: *works both ways*
    between two different classes, *always to itself* on a relationship that
    has a start class, and an inverse whose ends are not this relationship's
    ends swapped, which carries a Fix (the SetEnds that sets them). Turtle
    accepts everything (D-089), so a combination a command would refuse can
    still arrive by the editor; it is shown as a warning too, so it stays
    visible until it is resolved rather than surfacing only at the next
    click.

    This is not an OWL 2 DL profile check; that is V-7's reasoner.

INPUTS / INPUT SOURCES
    - An rdflib Graph (a project document), IRIs, and a naming function that
      gives an entity's display name.

EXPECTED OUTPUT
    - *_refusal(...) -> the sentence, or None.
    - warnings(graph, prop, name) -> [{"text", "fix"?}] for one property.
================================================================================
"""

from __future__ import annotations

from typing import Callable, Iterable, Optional

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

Name = Callable[[URIRef], str]

# The seven characteristics a learner is offered (5.6), by the name the
# command takes, with the words the form shows.
CHARACTERISTICS: dict[str, URIRef] = {
    "functional": OWL.FunctionalProperty,
    "inverseFunctional": OWL.InverseFunctionalProperty,
    "symmetric": OWL.SymmetricProperty,
    "transitive": OWL.TransitiveProperty,
    "asymmetric": OWL.AsymmetricProperty,
    "irreflexive": OWL.IrreflexiveProperty,
    "reflexive": OWL.ReflexiveProperty,
}

WORDS = {
    "functional": "at most one",
    "inverseFunctional": "identifies its start",
    "symmetric": "works both ways",
    "transitive": "chains",
    "asymmetric": "never both ways",
    "irreflexive": "never to itself",
    "reflexive": "always to itself",
}

# The pairs that contradict each other, and what the learner reads (5.9).
# Chains with the four that need a simple relationship is the chaining rule
# below, which also sees relationships under this one and its other way round.
CONFLICTS = [
    ("symmetric", "asymmetric", '"Works both ways" and "never both ways" contradict each other.'),
    ("reflexive", "irreflexive", '"Always to itself" and "never to itself" contradict each other.'),
]


def article(name: str) -> str:
    """*a* or *an* by the first letter, as the frontend's sentences.ts does."""
    return "an" if name.strip()[:1].lower() in "aeiou" and name.strip() else "a"


def characteristics(graph: Graph, prop: URIRef) -> set[str]:
    types = set(graph.objects(prop, RDF.type))
    return {name for name, iri in CHARACTERISTICS.items() if iri in types}


def characteristic_refusal(
    graph: Graph, prop: URIRef, name: str, on: bool, label: Name = str
) -> Optional[str]:
    """Turning `name` on next to the one it contradicts is refused, and so is
    anything the chaining rule forbids; turning anything off never is."""
    if not on:
        return None
    has = characteristics(graph, prop)
    for a, b, sentence in CONFLICTS:
        if (name == a and b in has) or (name == b and a in has):
            return sentence
    return _Facts(graph).refusal(prop, label, lambda f: f.chars.setdefault(prop, set()).add(name))


# --- the OWL 2 rule for chaining relationships (5.9, the first three rows) --------------
#
# OWL 2 DL lets these four apply only to a *simple* relationship: one that
# does not chain, has no chaining relationship under it, and whose other way
# round is simple too (the structural specification, Section 11.2). A file
# that breaks it is not OWL 2 DL, and reasoners such as HermiT reject it.

SIMPLE_ONLY = ("functional", "inverseFunctional", "asymmetric", "irreflexive")


class _Facts:
    """The property facts the rule reads, each from one scan of its predicate,
    so a command can try its change on a copy before anything moves."""

    def __init__(self, graph: Optional[Graph] = None) -> None:
        self.chars: dict = {}
        self.parents: dict = {}
        self.inverses: dict = {}
        if graph is None:
            return
        for name, iri in CHARACTERISTICS.items():
            for s in graph.subjects(RDF.type, iri):
                self.chars.setdefault(s, set()).add(name)
        for child, parent in graph.subject_objects(RDFS.subPropertyOf):
            self.parents.setdefault(child, set()).add(parent)
        for a, b in graph.subject_objects(OWL.inverseOf):
            self.inverses.setdefault(a, set()).add(b)
            self.inverses.setdefault(b, set()).add(a)

    def copy(self) -> "_Facts":
        other = _Facts()
        other.chars = {k: set(v) for k, v in self.chars.items()}
        other.parents = {k: set(v) for k, v in self.parents.items()}
        other.inverses = {k: set(v) for k, v in self.inverses.items()}
        return other

    def not_simple(self) -> dict:
        """Every relationship that is not simple, with why: the chaining one it
        comes from, and "self", "under" (a chaining one is below it) or
        "inverse" (its other way round is not simple)."""
        why: dict = {}
        queue = []
        for prop in sorted(self.chars):
            if "transitive" in self.chars[prop]:
                why[prop] = (prop, "self")
                queue.append(prop)
        while queue:
            prop = queue.pop(0)
            source = why[prop][0]
            for up in sorted(self.parents.get(prop, ())):
                if up not in why:
                    why[up] = (source, "under")
                    queue.append(up)
            for other in sorted(self.inverses.get(prop, ())):
                if other not in why:
                    why[other] = (source, "inverse")
                    queue.append(other)
        return why

    def violations(self) -> list:
        why = self.not_simple()
        return [
            (prop, name, why[prop])
            for prop in sorted(why)
            for name in SIMPLE_ONLY
            if name in self.chars.get(prop, ())
        ]

    def refusal(self, subject, label: Name, change: Callable[["_Facts"], None]) -> Optional[str]:
        """The sentence for the first violation `change` would add, one on
        `subject` itself first; None when it adds none. A violation already
        there (written in Turtle) is a warning, not a reason to refuse."""
        before = {(prop, name) for prop, name, _ in self.violations()}
        after = self.copy()
        change(after)
        new = [v for v in after.violations() if (v[0], v[1]) not in before]
        if not new:
            return None
        new.sort(key=lambda v: v[0] != subject)
        return chaining_sentence(*new[0], label, subject)


def chaining_sentence(prop, name: str, why: tuple, label: Name, subject=None) -> str:
    """5.9's three sentences, naming the checkbox that cannot stay."""
    source, how = why
    word = WORDS[name]
    if how == "self":
        return (
            f'A relationship that chains cannot also be "{word}" in OWL 2; '
            "reasoners such as HermiT reject the file. Choose one."
        )
    if subject is not None and prop != subject:
        # The change made a chaining relationship the child or the other way
        # round of one that has one of the four (the third row).
        where = "above a chaining one" if how == "under" else "that is the other way round of a chaining one"
        return f'{label(source)} chains, and {label(prop)} is "{word}"; in OWL 2 a relationship {where} cannot be.'
    if how == "under":
        return f'{label(prop)} has a relationship under it that chains, so it cannot also be "{word}" in OWL 2.'
    return f'The other way round of {label(prop)} chains, so it cannot also be "{word}" in OWL 2.'


def subproperty_chaining_refusal(graph: Graph, child: URIRef, parent: URIRef, label: Name) -> Optional[str]:
    return _Facts(graph).refusal(child, label, lambda f: f.parents.setdefault(child, set()).add(parent))


def inverse_chaining_refusal(graph: Graph, prop: URIRef, inverse: URIRef, label: Name) -> Optional[str]:
    """SetInverse replaces the inverses both sides had, so the copy does too."""
    def change(f: "_Facts") -> None:
        for side in (prop, inverse):
            for other in f.inverses.pop(side, set()):
                f.inverses.get(other, set()).discard(side)
        f.inverses.setdefault(prop, set()).add(inverse)
        f.inverses.setdefault(inverse, set()).add(prop)

    return _Facts(graph).refusal(prop, label, change)


def own_inverse_refusal(prop: URIRef, inverse: URIRef, name: str) -> Optional[str]:
    if prop == inverse:
        return f'{name} cannot be its own other way round. Use "Works both ways" instead.'
    return None


# --- walks up a hierarchy ---------------------------------------------------------


def _parents(graph: Graph, up: URIRef, down: Optional[URIRef] = None) -> dict:
    """Every node's parents under `up` (and `down` read the other way), in
    one scan of each predicate. Asking the store once per node was measured
    at 25 ms for a 2,500-deep chain in a loaded test process; one scan and a
    dictionary walk is a fraction of that, however the hierarchy is shaped."""
    parents: dict = {}
    for child, parent in graph.subject_objects(up):
        parents.setdefault(child, []).append(parent)
    if down is not None:
        for parent, child in graph.subject_objects(down):
            parents.setdefault(child, []).append(parent)
    return parents


def _above(parents: dict, start) -> set:
    """Everything above `start`; a cycle already in the data ends the walk
    rather than looping it."""
    seen: set = set()
    queue = list(parents.get(start, ()))
    while queue:
        node = queue.pop()
        if node in seen:
            continue
        seen.add(node)
        queue.extend(parents.get(node, ()))
    return seen


def _broader(graph: Graph) -> dict:
    """skos:broader, and skos:narrower written the other way: one hierarchy."""
    return _parents(graph, SKOS.broader, SKOS.narrower)


def broader_loop_refusal(graph: Graph, concept: URIRef, broader: URIRef, name: Name) -> Optional[str]:
    """Making `concept` narrower than `broader` closes a loop when `broader`
    is already `concept` or narrower than it."""
    if concept == broader or concept in _above(_broader(graph), broader):
        return f"That would make {name(concept)} narrower than itself."
    return None


def subproperty_loop_refusal(graph: Graph, child: URIRef, parent: URIRef, name: Name) -> Optional[str]:
    if child == parent or child in _above(_parents(graph, RDFS.subPropertyOf), parent):
        return f"That would make {name(child)} a more specific kind of itself."
    return None


def related_refusal(graph: Graph, a: URIRef, b: URIRef, name: Name) -> Optional[str]:
    """SKOS keeps *related* apart from *broader*, directly or through others
    (S27 of the SKOS reference): the narrower one is named first."""
    parents = _broader(graph)
    if b in _above(parents, a):
        narrow, broad = a, b
    elif a in _above(parents, b):
        narrow, broad = b, a
    else:
        return None
    return (
        f"{name(narrow)} is already narrower than {name(broad)}; "
        "SKOS does not allow them to be related as well."
    )


def broader_related_refusal(graph: Graph, concept: URIRef, broader: URIRef, name: Name) -> Optional[str]:
    """The same rule the other way round: once `concept` is under `broader`,
    everything at or below `concept` is under everything at or above
    `broader`, and no such pair may already be related (found in review:
    relating two concepts and then making one narrower than the other got
    through). One scan of each predicate, one walk up and one down."""
    parents = _broader(graph)
    children: dict = {}
    for child, ups in parents.items():
        for up in ups:
            children.setdefault(up, []).append(child)
    below = {concept} | _above(children, concept)
    above = {broader} | _above(parents, broader)
    for a, b in graph.subject_objects(SKOS.related):
        low, high = (a, b) if a in below else (b, a)
        if low in below and high in above:
            return (
                f"{name(low)} is related to {name(high)}; SKOS does not allow one to be "
                "narrower than the other as well."
            )
    return None


# --- warnings, read on each view of a property ---------------------------------------


def _named(values: Iterable) -> Optional[URIRef]:
    return next((v for v in values if isinstance(v, URIRef)), None)


def inverses(graph: Graph, prop: URIRef) -> list[URIRef]:
    """owl:inverseOf is one statement read both ways: either side may hold it."""
    found = {o for o in graph.objects(prop, OWL.inverseOf) if isinstance(o, URIRef)}
    found |= {s for s in graph.subjects(OWL.inverseOf, prop) if isinstance(s, URIRef)}
    found.discard(prop)
    return sorted(found)


def warnings(graph: Graph, prop: URIRef, name: Name) -> list[dict]:
    """What the form shows under a relationship or an attribute (5.9)."""
    out: list[dict] = []
    has = characteristics(graph, prop)
    # `block` is where the form shows it: under the block it concerns.
    for a, b, sentence in CONFLICTS:
        if a in has and b in has:
            out.append({"text": sentence, "block": "characteristics"})
    # The chaining rule, for a combination written in Turtle (D-089).
    for bad, what, why in _Facts(graph).violations():
        if bad == prop:
            out.append({"text": chaining_sentence(bad, what, why, name), "block": "characteristics"})
    domain = _named(graph.objects(prop, RDFS.domain))
    rng = _named(graph.objects(prop, RDFS.range))
    label = name(prop)
    if "symmetric" in has and domain is not None and rng is not None and domain != rng:
        # The spec's sentence conjugates the name (*can also work for*); this
        # one reads the name as written, as the "identifies its start"
        # example does, so no grammar is guessed.
        start, end = name(domain), name(rng)
        out.append({
            "block": "characteristics",
            "text": (
                f"Works both ways means {article(end)} {end} can also be linked by {label} "
                f"to {article(start)} {start}. Usually start and end are the same class."
            )
        })
    if "reflexive" in has and domain is not None:
        out.append({
            "block": "characteristics",
            "text": f'"Always to itself" makes every thing {article(name(domain))} {name(domain)}. '
            "This is rarely what is meant."
        })
    if domain is not None and rng is not None:
        for inverse in inverses(graph, prop):
            ends = (_named(graph.objects(inverse, RDFS.domain)), _named(graph.objects(inverse, RDFS.range)))
            if ends == (rng, domain):
                continue
            warning = {"text": f"{name(inverse)} should go from {name(rng)} to {name(domain)}.", "block": "inverse"}
            # Fixed here only when it is this document's: an imported one is
            # changed where it is defined.
            if (inverse, RDF.type, OWL.ObjectProperty) in graph:
                warning["fix"] = {
                    "command": "SetEnds",
                    "args": {"property": str(inverse), "domain": str(rng), "range": str(domain)},
                    "label": f"Set {name(inverse)} from {name(rng)} to {name(domain)}",
                }
            out.append(warning)
    return out
