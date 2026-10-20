"""
================================================================================
FILE: backend/app/axioms.py
================================================================================

SUMMARY
    A class's rules as the learner's form reads them (axioms-and-reasoning
    5.8, 5.9, D-105): its restrictions, in the two forms *every X ...* and
    *an X is exactly ...*, its disjoint classes and its equivalent classes,
    each read out of the graph by its content, and anything outside 5.8's
    subset kept as its Turtle text, read-only: an owl:AllDisjointClasses
    among them, though its pairs count for every disjointness check. Also the Turtle shape each
    sentence is written as, and the SHACL rule *Check it in data too*
    writes for a restriction (D-106 Q3). Reads only; the commands that
    write are editing.py's.

BASIC IDEA
    A restriction has no IRI, so it is named by what it says: `{form,
    property, kind, filler, n}`, with `with` for the named class of a
    defining form. The reader accepts a blank node only when it is exactly
    one of 5.8's shapes -- one owl:onProperty naming a property, one value
    predicate, a qualified count's one owl:onClass or owl:onDataRange,
    nothing else -- so every rule it reads back is one the form can write
    again in the same shape, and the round trip is stable (AC-9). Anything
    else under owl:subClassOf, owl:equivalentClass or owl:disjointWith (a
    union, a chain, an inverse, a nested expression, a datatype restriction
    on *some* or *only*) is shown as its Turtle with Edit in Turtle, and no
    command ever rewrites it.

    The shapes written are the ones 5.8 names: `C rdfs:subClassOf [ a
    owl:Restriction ; owl:onProperty P ; owl:someValuesFrom F ]` and its
    siblings, a qualified count with owl:onClass (owl:onDataRange for an
    attribute), the unqualified count with no filler, and for the defining
    form `C owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( W R ) ]`,
    or `C owl:equivalentClass R` with no named class. A count is typed
    xsd:nonNegativeInteger, as OWL 2 writes it; any integer is read.

    *Check it in data too* maps a restriction to the SHACL that checks the
    same thing in data: *at least* a qualified minimum, *only* sh:class, a
    count sh:minCount and sh:maxCount, a value sh:hasValue. The plain ones
    are the rule editor's own keys (`shacl_plain`), so they can join a rule
    the form already has; a qualified one is its own property shape, which
    the V-6 form reads as read-only and never rewrites (shapes_form).

INPUTS / INPUT SOURCES
    - An rdflib Graph (a project document, or the view with its imports),
      a class IRI, and a naming function.

EXPECTED OUTPUT
    - parse_restriction / parse_defining -> the content, or None.
    - content_of(form, parsed, with_) -> a parsed rule as its Content.
    - draws_line(content, boxes) -> whether the canvas and Explore draw it as a line.
    - class_rules(graph, cls, own, name) -> the form's items;
      read_only_rules(graph, cls, name) the same, none editable.
    - find(graph, cls, key) -> the (predicate, node) pairs with that content.
    - restriction_triples(...) -> (node, triples) for a new restriction.
    - shacl_plain / shacl_triples -> what Check it in data too writes.
    - choices(graph, own, name) -> what the sentence builder's selects offer.
    - disjoint_with / disjoint_pairs -> disjointness, owl:disjointWith and
      owl:AllDisjointClasses alike, for the checks and the canvas.
    - domain_of(graph, prop) -> DomainReading(form, classes, node): the one
      reader of a property's domain (attribute-reuse 5.3, D-116), and
      domains(graph) the same for every property that has one.
    - covers(reading, ancestors) and class_properties(view, cls, name):
      which properties a class has, and how (own, shared, both, through).
    - reuse_plan(view, own, prop, cls, name) -> the case of 5.2 for using a
      property on one more class, with the choices it offers.

    A property's domain is read here and nowhere else but editing.py, which
    writes it (test_axioms.py scans). Two rdfs:domain values mean *both*
    (RDF 1.1 Semantics 9.2.1), never *either*: that is `separate`, read the
    standard's way and warned of. *Either* is an owl:unionOf of named classes
    on a blank node used only there, `union`; anything else is `expression`,
    Turtle's. An RDF list is attacker-shaped input, so the walk stops at
    UNION_MAX members and on a revisit, and reads the rest as `expression`.
================================================================================
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, XSD

from . import examples

SH = Namespace("http://www.w3.org/ns/shacl#")

Name = Callable[[URIRef], str]

FORMS = ("every", "defines")
KINDS = ("some", "only", "exactly", "atLeast", "atMost", "value")
COUNT_KINDS = ("exactly", "atLeast", "atMost")
# An attribute takes a count or a value (5.8): *some* and *only* over a
# datatype are legal OWL, but outside the sentences, so Turtle's.
ATTRIBUTE_KINDS = ("exactly", "atLeast", "atMost", "value")
MAX_N = 1000

# (unqualified, qualified) per count.
_COUNTS = {
    "exactly": (OWL.cardinality, OWL.qualifiedCardinality),
    "atLeast": (OWL.minCardinality, OWL.minQualifiedCardinality),
    "atMost": (OWL.maxCardinality, OWL.maxQualifiedCardinality),
}
_COUNT_BY_PREDICATE = {p: (kind, i == 1) for kind, pair in _COUNTS.items() for i, p in enumerate(pair)}
_VALUE_PREDICATES = {OWL.someValuesFrom: "some", OWL.allValuesFrom: "only", OWL.hasValue: "value"}

# The seven value types of E-6 and text in a language: a datatype filler.
DATATYPES = (XSD.string, XSD.integer, XSD.decimal, XSD.boolean, XSD.date, XSD.dateTime, XSD.anyURI)

# The selects offer at most this many of each; the true total goes with them.
CHOICES_CAP = 1000


def is_datatype(term) -> bool:
    return isinstance(term, URIRef) and (
        str(term).startswith(str(XSD)) or term in (RDFS.Literal, RDF.langString, RDFS.Datatype)
    )


@dataclass(frozen=True)
class Content:
    """What a restriction says, the key a command names it by."""

    form: str
    property: URIRef
    kind: str
    filler: object  # URIRef (class or datatype), a value term, or None
    n: Optional[int]
    with_: Optional[URIRef] = None

    def same(self, other: "Content", with_matters: bool = True) -> bool:
        return (
            self.form == other.form
            and self.property == other.property
            and self.kind == other.kind
            and same_term(self.filler, other.filler)
            and self.n == other.n
            and (not with_matters or self.with_ == other.with_)
        )


def same_term(a, b) -> bool:
    """Turtle's "gold" and the form's "gold"^^xsd:string are one value in
    RDF 1.1, though rdflib keeps them apart (see editing._stored)."""
    return _plain(a) == _plain(b)


def _plain(term):
    if isinstance(term, Literal) and term.datatype == XSD.string and not term.language:
        return Literal(str(term))
    return term


def _one(g: Graph, node, predicate):
    values = list(g.objects(node, predicate))
    return values[0] if len(values) == 1 else None


def _count(term) -> Optional[int]:
    if not isinstance(term, Literal):
        return None
    try:
        value = term.toPython()
    except Exception:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def parse_restriction(g: Graph, node) -> Optional[tuple]:
    """(property, kind, filler, n) when `node` is exactly one of 5.8's
    restrictions, else None. Every predicate on it must be one the shape
    uses, with one value each: anything more is Turtle's to show."""
    if not isinstance(node, BNode):
        return None
    predicates = list(g.predicates(node, None))
    if len(predicates) != len(set(predicates)):
        return None  # a predicate written twice: not one sentence
    present = set(predicates)
    if RDF.type in present and set(g.objects(node, RDF.type)) != {OWL.Restriction}:
        return None
    prop = _one(g, node, OWL.onProperty)
    if not isinstance(prop, URIRef):
        return None  # an inverse, or no property
    rest = present - {RDF.type, OWL.onProperty}
    values = [p for p in rest if p in _VALUE_PREDICATES]
    counts = [p for p in rest if p in _COUNT_BY_PREDICATE]
    if len(values) + len(counts) != 1:
        return None
    if values:
        predicate = values[0]
        if rest != {predicate}:
            return None
        kind = _VALUE_PREDICATES[predicate]
        filler = _one(g, node, predicate)
        if kind == "value":
            return (prop, kind, filler, None) if isinstance(filler, (URIRef, Literal)) else None
        # A class, never a datatype or a nested expression.
        if not isinstance(filler, URIRef) or is_datatype(filler):
            return None
        return prop, kind, filler, None
    predicate = counts[0]
    kind, qualified = _COUNT_BY_PREDICATE[predicate]
    n = _count(_one(g, node, predicate))
    if n is None:
        return None
    if not qualified:
        return (prop, kind, None, n) if rest == {predicate} else None
    on = [p for p in (OWL.onClass, OWL.onDataRange) if p in rest]
    if len(on) != 1 or rest != {predicate, on[0]}:
        return None
    filler = _one(g, node, on[0])
    if not isinstance(filler, URIRef) or (on[0] == OWL.onClass) == is_datatype(filler):
        return None
    return prop, kind, filler, n


def _list(g: Graph, head) -> Optional[list]:
    try:
        return list(Collection(g, head))
    except Exception:
        return None


def parse_defining(g: Graph, node) -> Optional[tuple]:
    """(with, (property, kind, filler, n)) for a defining form: a restriction
    alone, or the intersection of one named class and one restriction."""
    alone = parse_restriction(g, node)
    if alone is not None:
        return None, alone
    if not isinstance(node, BNode):
        return None
    present = set(g.predicates(node, None))
    if present - {RDF.type, OWL.intersectionOf} or OWL.intersectionOf not in present:
        return None
    if RDF.type in present and set(g.objects(node, RDF.type)) != {OWL.Class}:
        return None
    head = _one(g, node, OWL.intersectionOf)
    members = _list(g, head) if head is not None else None
    if not members or len(members) != 2:
        return None
    named = [m for m in members if isinstance(m, URIRef)]
    blank = [m for m in members if isinstance(m, BNode)]
    if len(named) != 1 or len(blank) != 1:
        return None
    inner = parse_restriction(g, blank[0])
    return (named[0], inner) if inner is not None else None


def content_of(form: str, parsed: tuple, with_=None) -> Content:
    prop, kind, filler, n = parsed
    return Content(form, prop, kind, filler, n, with_)


def contents(g: Graph, cls) -> list[tuple]:
    """Every rule of 5.8's subset on `cls`, as (predicate, node, Content)."""
    found = []
    for node in g.objects(cls, RDFS.subClassOf):
        parsed = parse_restriction(g, node)
        if parsed is not None:
            found.append((RDFS.subClassOf, node, content_of("every", parsed)))
    for node in g.objects(cls, OWL.equivalentClass):
        if isinstance(node, BNode):
            defining = parse_defining(g, node)
            if defining is not None:
                found.append((OWL.equivalentClass, node, content_of("defines", defining[1], defining[0])))
    return found


def draws_line(content: Content, boxes) -> bool:
    """Whether a rule is a line between two classes: its filler a named class,
    never a value or a datatype, and owl:Thing or rdfs:Resource only when the
    document makes it one of `boxes`, as the canvas always has. The Edit
    canvas and Explore's graph both ask this, so the two pages draw one set
    (D-113)."""
    filler = content.filler
    return (
        content.kind != "value" and isinstance(filler, URIRef) and not is_datatype(filler)
        and (filler not in (OWL.Thing, RDFS.Resource) or filler in boxes)
    )


def find(g: Graph, cls, key: Content) -> list[tuple]:
    """The (predicate, node) pairs under `cls` whose content is `key`. A
    defining form's named class is compared only when the key gives one."""
    return [
        (p, node) for p, node, content in contents(g, cls)
        if content.same(key, with_matters=key.with_ is not None)
    ]


def named_pairs(g: Graph, cls, predicate) -> list[URIRef]:
    """owl:disjointWith and owl:equivalentClass between named classes, read
    either way round: either side may hold the statement."""
    found = {o for o in g.objects(cls, predicate) if isinstance(o, URIRef)}
    found |= {s for s in g.subjects(predicate, cls) if isinstance(s, URIRef)}
    found.discard(cls)
    return sorted(found)


def disjoint_groups(g: Graph) -> list[tuple]:
    """Every owl:AllDisjointClasses, as (node, its named members). Protégé
    writes disjointness of three or more classes this way, so a check that
    read owl:disjointWith alone let *Person means the same as Organization*
    through (PR #56 review). owl:AllDisjointProperties is not read (known
    state)."""
    found = []
    for node in set(g.subjects(RDF.type, OWL.AllDisjointClasses)):
        for head in g.objects(node, OWL.members):
            members = _list(g, head) or []
            found.append((node, [m for m in members if isinstance(m, URIRef)]))
    return sorted(found, key=lambda pair: [str(m) for m in pair[1]])


def disjoint_with(g: Graph, cls, groups: Optional[list] = None) -> list[URIRef]:
    """The named classes `cls` is disjoint with, by owl:disjointWith either
    way round or by sharing an owl:AllDisjointClasses. `groups` lets a
    caller asking for many classes read the groups once."""
    found = set(named_pairs(g, cls, OWL.disjointWith))
    for _, members in disjoint_groups(g) if groups is None else groups:
        if cls in members:
            found.update(members)
    found.discard(cls)
    return sorted(found)


def disjoint_pairs(g: Graph) -> set[tuple]:
    """Every pair of distinct named classes stated disjoint, either form,
    each pair once in IRI order. One scan of each."""
    pairs = set()
    for x, y in g.subject_objects(OWL.disjointWith):
        if isinstance(x, URIRef) and isinstance(y, URIRef) and x != y:
            pairs.add(tuple(sorted((x, y))))
    for _, members in disjoint_groups(g):
        for i, x in enumerate(members):
            for y in members[i + 1:]:
                if x != y:
                    pairs.add(tuple(sorted((x, y))))
    return pairs


def _statements(g: Graph, node) -> list:
    """A node's statements and every blank node under them."""
    if isinstance(node, BNode):
        return closure(g, node)
    found = list(g.triples((node, None, None)))
    for _, _, o in list(found):
        found.extend(closure(g, o))
    return found


# --- the form's items ---------------------------------------------------------------


def _ref(iri, name: Name) -> dict:
    return {"iri": str(iri), "label": name(iri)}


def value_json(term, name: Name) -> dict:
    if isinstance(term, URIRef):
        return {"kind": "link", "value": str(term), "label": name(term)}
    if term.language:
        return {"kind": "text", "value": str(term), "lang": term.language}
    datatype = term.datatype
    if datatype is None or datatype == XSD.string:
        return {"kind": "typed", "value": str(term), "datatype": "xsd:string"}
    short = f"xsd:{str(datatype)[len(str(XSD)):]}" if str(datatype).startswith(str(XSD)) else str(datatype)
    return {"kind": "typed", "value": str(term), "datatype": short}


def _filler_json(content: Content, name: Name):
    if content.filler is None:
        return None
    if content.kind == "value":
        return value_json(content.filler, name)
    filler = content.filler
    if is_datatype(filler):
        return {"iri": str(filler), "label": f"xsd:{str(filler)[len(str(XSD)):]}" if str(filler).startswith(str(XSD)) else name(filler)}
    return _ref(filler, name)


def property_kind(g: Graph, prop) -> Optional[str]:
    types = set(g.objects(prop, RDF.type))
    if OWL.ObjectProperty in types:
        return "relationship"
    if OWL.DatatypeProperty in types:
        return "attribute"
    return None


def key_json(content: Content) -> dict:
    """The key a command names the restriction by: what it says."""
    filler = content.filler
    if content.kind == "value" and isinstance(filler, Literal):
        filler_out = value_json(filler, str)
        filler_out.pop("label", None)
    elif filler is not None:
        filler_out = str(filler)
    else:
        filler_out = None
    key = {
        "form": content.form,
        "property": str(content.property),
        "kind": content.kind,
        "filler": filler_out,
        "n": content.n,
    }
    if content.with_ is not None:
        key["with"] = str(content.with_)
    return key


def restriction_json(g: Graph, content: Content, name: Name, editable: bool) -> dict:
    return {
        "type": "restriction",
        "form": content.form,
        "property": {**_ref(content.property, name), "kind": property_kind(g, content.property)},
        "kind": content.kind,
        "filler": _filler_json(content, name),
        "n": content.n,
        "with": _ref(content.with_, name) if content.with_ is not None else None,
        "key": key_json(content),
        "editable": editable,
    }


def turtle_of(g: Graph, triples: list) -> str:
    """Statements as Turtle the learner can read, without the prefix lines:
    a blank node nested as [ ... ], a list as ( ... )."""
    out = Graph()
    for prefix, namespace in g.namespaces():
        out.bind(prefix, namespace, override=True)
    for t in triples:
        out.add(t)
    text = out.serialize(format="turtle")
    lines = [line for line in text.splitlines() if not line.startswith("@prefix") and not line.startswith("PREFIX")]
    return "\n".join(lines).strip()


def closure(g: Graph, node) -> list:
    """Every statement reachable from a blank node through blank nodes."""
    found: list = []
    queue = [node]
    seen = set()
    while queue:
        current = queue.pop()
        if current in seen or not isinstance(current, BNode):
            continue
        seen.add(current)
        for t in g.triples((current, None, None)):
            found.append(t)
            queue.append(t[2])
    return found


def class_rules(g: Graph, cls: URIRef, own: Graph, name: Name) -> list[dict]:
    """The Rules block's items (5.9, Section 6): the sentences of 5.8 in a
    fixed order -- *every*, *defines*, same meaning, disjoint -- then what
    is outside them, as Turtle. An item is editable only when this document
    defines the class and holds the statement."""
    defined = examples.is_class(own, cls)

    def mine(triple) -> bool:
        return defined and triple in own

    items: list[dict] = []
    readable = set()
    for predicate, node, content in contents(g, cls):
        readable.add(node)
        items.append(restriction_json(g, content, name, mine((cls, predicate, node))))
    items.sort(key=lambda i: (i["form"] != "every", i["property"]["label"].casefold(), KINDS.index(i["kind"]), i["n"] or 0))
    for other in named_pairs(g, cls, OWL.equivalentClass):
        held = mine((cls, OWL.equivalentClass, other)) or mine((other, OWL.equivalentClass, cls))
        items.append({"type": "equivalent", "other": _ref(other, name), "editable": held})
    for other in named_pairs(g, cls, OWL.disjointWith):
        held = mine((cls, OWL.disjointWith, other)) or mine((other, OWL.disjointWith, cls))
        items.append({"type": "disjoint", "other": _ref(other, name), "editable": held})
    outside = []
    for predicate in (RDFS.subClassOf, OWL.equivalentClass, OWL.disjointWith, OWL.disjointUnionOf):
        for node in g.objects(cls, predicate):
            # A class disjoint with or the same as itself is no sentence of
            # 5.8, but it must not vanish either (code review): its Turtle.
            itself = node == cls and predicate != RDFS.subClassOf
            if node in readable or (isinstance(node, URIRef) and predicate != OWL.disjointUnionOf and not itself):
                continue
            triples = [(cls, predicate, node), *closure(g, node)]
            outside.append({"type": "turtle", "turtle": turtle_of(g, triples), "editable": False})
    # Disjointness of a group is no sentence of 5.8 and names other classes
    # than this one: its Turtle, which no command rewrites (AC-9).
    for node, members in disjoint_groups(g):
        if cls in members:
            outside.append({"type": "turtle", "turtle": turtle_of(g, _statements(g, node)), "editable": False})
    outside.sort(key=lambda i: i["turtle"])
    return items + outside


def read_only_rules(g: Graph, cls: URIRef, name: Name) -> list[dict]:
    """The same items for a class no one here may change, a library
    ontology's (explore-rules 5.3): with no document of the person's, none
    is editable."""
    return class_rules(g, cls, Graph(), name)


# --- writing --------------------------------------------------------------------------


def restriction_triples(prop: URIRef, kind: str, filler, n: Optional[int], attribute: bool) -> tuple:
    """A new restriction's blank node and its statements, in 5.8's shape."""
    node = BNode()
    triples = [(node, RDF.type, OWL.Restriction), (node, OWL.onProperty, prop)]
    if kind in _COUNTS:
        unqualified, qualified = _COUNTS[kind]
        count = Literal(n, datatype=XSD.nonNegativeInteger)
        if filler is None:
            triples.append((node, unqualified, count))
        else:
            triples.append((node, qualified, count))
            triples.append((node, OWL.onDataRange if attribute else OWL.onClass, filler))
    else:
        predicate = {v: k for k, v in _VALUE_PREDICATES.items()}[kind]
        triples.append((node, predicate, filler))
    return node, triples


def defining_triples(cls: URIRef, restriction: tuple, with_: Optional[URIRef]) -> tuple:
    """`C owl:equivalentClass R`, or `[ a owl:Class ; owl:intersectionOf ( W R ) ]`."""
    node, triples = restriction
    if with_ is None:
        return node, [(cls, OWL.equivalentClass, node), *triples]
    eq, first, second = BNode(), BNode(), BNode()
    return eq, [
        (cls, OWL.equivalentClass, eq),
        (eq, RDF.type, OWL.Class),
        (eq, OWL.intersectionOf, first),
        (first, RDF.first, with_), (first, RDF.rest, second),
        (second, RDF.first, node), (second, RDF.rest, RDF.nil),
        *triples,
    ]


# --- Check it in data too (D-106 Q3) ----------------------------------------------------


def shacl_plain(content: Content, attribute: bool) -> Optional[dict]:
    """The rule editor's own keys for a restriction, when it has them: *only*
    a class is sh:class, an unqualified count sh:minCount and sh:maxCount.
    None when only a qualified shape or sh:hasValue can say it."""
    if content.kind == "only" and not attribute:
        return {"class": str(content.filler)}
    if content.kind in _COUNTS and content.filler is None:
        n = content.n
        return {"exactly": {"minCount": n, "maxCount": n}, "atLeast": {"minCount": n},
                "atMost": {"maxCount": n}}[content.kind]
    return None


def shacl_triples(content: Content, attribute: bool, severity=None) -> tuple:
    """A property shape that checks the restriction in data, on fresh blank
    nodes: (the property shape, its statements). *at least one ... that is*
    and the qualified counts are a qualified value shape; a value is
    sh:hasValue."""
    prop = BNode()
    triples = [(prop, SH.path, content.property)]
    if content.kind == "value":
        triples.append((prop, SH.hasValue, content.filler))
    elif content.kind == "only":
        triples.append((prop, SH.datatype if attribute else SH["class"], content.filler))
    else:
        n = 1 if content.kind == "some" else content.n
        low = n if content.kind in ("some", "atLeast", "exactly") else None
        high = n if content.kind in ("atMost", "exactly") else None
        if content.filler is None:
            if low is not None:
                triples.append((prop, SH.minCount, Literal(low, datatype=XSD.integer)))
            if high is not None:
                triples.append((prop, SH.maxCount, Literal(high, datatype=XSD.integer)))
        else:
            inner = BNode()
            triples.append((prop, SH.qualifiedValueShape, inner))
            triples.append((inner, SH.datatype if attribute else SH["class"], content.filler))
            if low is not None:
                triples.append((prop, SH.qualifiedMinCount, Literal(low, datatype=XSD.integer)))
            if high is not None:
                triples.append((prop, SH.qualifiedMaxCount, Literal(high, datatype=XSD.integer)))
    if severity is not None:
        triples.append((prop, SH.severity, severity))
    return prop, triples


def signature(g: Graph, node) -> frozenset:
    """A property shape's statements with blank nodes read through, so two
    written separately compare equal: what makes a check a duplicate."""
    out = set()
    for p, o in g.predicate_objects(node):
        out.add((p, signature(g, o) if isinstance(o, BNode) else _plain(o)))
    return frozenset(out)


def signature_of(triples: list, node) -> frozenset:
    g = Graph()
    for t in triples:
        g.add(t)
    return signature(g, node)


# --- what the sentence builder offers ---------------------------------------------------


def choices(g: Graph, own: Graph, name: Name) -> dict:
    """The selects' options: relationships and attributes and classes from
    the view with its imports, and the things a *has value* can name -- the
    project's own examples, which the command accepts; never a snapshot's
    rows or an import's individuals (code review) -- each capped with its
    true total (CLAUDE.md rule 6)."""
    def capped(items: list) -> dict:
        items.sort(key=lambda i: (i["label"].casefold(), i["iri"]))
        return {"items": items[:CHOICES_CAP], "total": len(items)}

    properties = []
    for kind, word in ((OWL.ObjectProperty, "relationship"), (OWL.DatatypeProperty, "attribute")):
        for prop in set(g.subjects(RDF.type, kind)):
            if isinstance(prop, URIRef):
                entry = {"iri": str(prop), "label": name(prop), "kind": word}
                if word == "attribute":
                    rng = g.value(prop, RDFS.range)
                    entry["datatype"] = str(rng) if isinstance(rng, URIRef) else None
                properties.append(entry)
    classes = set()
    for t in examples.CLASS_TYPES:
        classes |= {s for s in g.subjects(RDF.type, t) if isinstance(s, URIRef)}
    things = examples.examples(g, own)
    return {
        "properties": capped(properties),
        "classes": capped([_ref(c, name) for c in classes]),
        "things": capped([_ref(t, name) for t in things]),
    }


# --- a property's domain (attribute-reuse 5.3, D-116) -----------------------------------

# An RDF list in a loaded file is attacker-shaped (Section 9): a million
# members, or a cycle. Past this many, or on a revisit, it is no union.
UNION_MAX = 100
DOMAIN_FORMS = ("none", "one", "union", "separate", "expression")
_TOP = (OWL.Thing, RDFS.Resource)


@dataclass(frozen=True)
class DomainReading:
    """A property's domain as every view reads it: `none`, `one` named class,
    a `union` of named classes (*either*), `separate` named values (*all of
    them*, the standard's reading), or an `expression` left to Turtle."""

    form: str
    classes: tuple = ()
    node: Optional[BNode] = None
    # An expression's values as written, for a view that shows its Turtle.
    terms: tuple = ()


def _union_members(g: Graph, node) -> Optional[tuple]:
    """The named classes of `[ a owl:Class ; owl:unionOf ( ... ) ]` when the
    node is exactly that and is used only once, else None. owl:Class is
    optional here, as some tools omit it; the commands always write it."""
    if not isinstance(node, BNode):
        return None
    referrers = 0
    for _ in g.triples((None, None, node)):
        referrers += 1
        if referrers > 1:
            return None  # shared with another statement: changing it would change that too
    head, typed = None, False
    for p, o in g.predicate_objects(node):
        if p == OWL.unionOf and head is None:
            head = o
        elif p == RDF.type and o == OWL.Class and not typed:
            typed = True
        else:
            return None
    if head is None:
        return None
    members: list = []
    seen: set = set()
    cell = head
    while cell != RDF.nil:
        if not isinstance(cell, BNode) or cell in seen or len(members) >= UNION_MAX:
            return None
        seen.add(cell)
        first = rest = None
        for p, o in g.predicate_objects(cell):
            if p == RDF.first and first is None:
                first = o
            elif p == RDF.rest and rest is None:
                rest = o
            else:
                return None
        # A blank member is a nested expression: the form cannot say it.
        if not isinstance(first, URIRef) or rest is None:
            return None
        members.append(first)
        cell = rest
    return tuple(dict.fromkeys(members)) or None


def domain_of(g: Graph, prop) -> DomainReading:
    """The one reader of a property's domain (5.3)."""
    values = list(dict.fromkeys(g.objects(prop, RDFS.domain)))
    if not values:
        return DomainReading("none")
    if all(isinstance(v, URIRef) for v in values):
        if len(values) == 1:
            return DomainReading("one", (values[0],))
        return DomainReading("separate", tuple(sorted(values, key=str)))
    if len(values) == 1:
        members = _union_members(g, values[0])
        if members is not None:
            return DomainReading("union", members, values[0])
    return DomainReading("expression", terms=tuple(values))


def domains(g: Graph) -> dict:
    """Every named property with a domain, read by domain_of: one scan of
    the subjects, then one reading each."""
    return {
        prop: domain_of(g, prop)
        for prop in sorted({s for s in g.subjects(RDFS.domain, None) if isinstance(s, URIRef)})
    }


def domain_names(reading: DomainReading, name: Name) -> Optional[str]:
    """*Employee*, *Employee or Manager* (a union), *Employee and Manager*
    (two domain lines, which mean both), or None."""
    if not reading.classes:
        return None
    names = [name(c) for c in reading.classes]
    if len(names) == 1:
        return names[0]
    joiner = " and " if reading.form == "separate" else " or "
    return ", ".join(names[:-1]) + joiner + names[-1]


def _ancestors(g: Graph, cls) -> dict:
    """Every named class `cls` is a kind of, itself included, by its distance
    up rdfs:subClassOf. A loop is walked once."""
    found = {cls: 0}
    queue = [cls]
    while queue:
        current = queue.pop(0)
        for parent in g.objects(current, RDFS.subClassOf):
            if isinstance(parent, URIRef) and parent not in found:
                found[parent] = found[current] + 1
                queue.append(parent)
    return found


def _descendants(g: Graph, cls) -> set:
    """Every named class that is a kind of `cls`, itself included."""
    found = {cls}
    queue = [cls]
    while queue:
        current = queue.pop()
        for child in g.subjects(RDFS.subClassOf, current):
            if isinstance(child, URIRef) and child not in found:
                found.add(child)
                queue.append(child)
    return found


ancestors = _ancestors
descendants = _descendants


def covers(reading: DomainReading, lineage) -> bool:
    """Whether a class whose ancestors are `lineage` has the property: under
    one member of a union, under every value of `separate` (5.0 row 3)."""
    if reading.form in ("one", "union"):
        return any(c in lineage for c in reading.classes)
    if reading.form == "separate":
        return all(c in lineage for c in reading.classes)
    return False


def domain_json(reading: DomainReading, name: Name) -> dict:
    return {"form": reading.form, "classes": [_ref(c, name) for c in reading.classes]}


def class_type(g: Graph, cls) -> str:
    """*rdfs* for a class typed rdfs:Class and not owl:Class, else *owl*
    (5.0 row 7), as the canvas's box says it."""
    if (cls, RDF.type, RDFS.Class) in g and (cls, RDF.type, OWL.Class) not in g:
        return "rdfs"
    return "owl"


def _datatype_name(rng) -> Optional[str]:
    if not isinstance(rng, URIRef):
        return None
    return f"xsd:{str(rng)[len(str(XSD)):]}" if str(rng).startswith(str(XSD)) else str(rng)


def class_properties(view: Graph, cls, name: Name) -> list[dict]:
    """The attributes and relationships a class has, and how (5.3): its
    `own`, `shared` in a union, `both` where two domain lines list it (the
    5.4 warning's), or `through` a parent, named in `via`."""
    lineage = ancestors(view, cls)
    out = []
    for prop, reading in domains(view).items():
        if reading.form in ("none", "expression"):
            continue
        members = reading.classes
        if reading.form == "one" and members[0] == cls:
            how = "own"
        elif cls in members:
            how = "shared" if reading.form == "union" else "both"
        elif covers(reading, lineage):
            how = "through"
        else:
            continue
        kind = property_kind(view, prop)
        if kind is None:
            continue
        entry = {"iri": str(prop), "label": name(prop), "kind": kind, "how": how}
        if how in ("shared", "both"):
            entry["with"] = [_ref(c, name) for c in members if c != cls]
        if how == "through":
            via = min((c for c in members if c in lineage), key=lambda c: (lineage[c], str(c)))
            entry["via"] = _ref(via, name)
        rng = view.value(prop, RDFS.range)
        if kind == "attribute":
            entry["datatype"] = _datatype_name(rng)
        else:
            entry["range"] = _ref(rng, name) if isinstance(rng, URIRef) else None
        out.append(entry)
    order = {"own": 0, "shared": 1, "both": 1, "through": 2}
    out.sort(key=lambda e: (order[e["how"]], e["kind"] != "attribute", e["label"].casefold(), e["iri"]))
    return out


def union_triples(prop, members) -> tuple:
    """`prop rdfs:domain [ a owl:Class ; owl:unionOf ( ... ) ]` on fresh
    blank nodes (5.0 row 5): (the node, its statements). Never one member."""
    if len(members) < 2:
        raise ValueError("a union is never left with one member")
    node = BNode()
    cells = [BNode() for _ in members]
    triples = [(prop, RDFS.domain, node), (node, RDF.type, OWL.Class), (node, OWL.unionOf, cells[0])]
    for i, (cell, member) in enumerate(zip(cells, members)):
        triples.append((cell, RDF.first, member))
        triples.append((cell, RDF.rest, cells[i + 1] if i + 1 < len(cells) else RDF.nil))
    return node, triples


def shared_members(view: Graph, reading: DomainReading, cls) -> list:
    """What a domain's classes become when `cls` joins them: those that are
    not a kind of `cls`, then `cls`. A member under it is covered by it
    already, and listing both would say the same thing twice."""
    kept = [c for c in reading.classes if cls not in ancestors(view, c)]
    return [*kept, cls]


def defined(own: Graph, cls) -> bool:
    """Defined in this document: typed a class here, not only mentioned."""
    return isinstance(cls, URIRef) and any((cls, RDF.type, t) in own for t in (OWL.Class, RDFS.Class))


def _nearest(lineage: dict, members) -> URIRef:
    return min((c for c in members if c in lineage), key=lambda c: (lineage[c], str(c)))


def reuse_plan(view: Graph, own: Graph, prop, cls, name: Name, imported_from: Optional[dict] = None) -> dict:
    """The case of 5.2 for using `prop` on `cls`, and what it offers. The
    domain is the document's own statement; parents are read from the
    view, so an imported parent counts (case B). With no case to offer,
    `case` is None and `refused` says why."""
    reading = domain_of(own, prop)
    imported_from = imported_from or {}
    members = list(reading.classes)
    # One walk per class for the whole plan: case D asks the same classes'
    # ancestors many times over.
    up_cache: dict = {}
    down_cache: dict = {}

    def up(c) -> dict:
        if c not in up_cache:
            up_cache[c] = _ancestors(view, c)
        return up_cache[c]

    def down(c) -> set:
        if c not in down_cache:
            down_cache[c] = _descendants(view, c)
        return down_cache[c]

    plan = {
        "property": {**_ref(prop, name), "kind": property_kind(own, prop)},
        "class": {**_ref(cls, name), "type": class_type(view, cls)},
        "domain": {
            "form": reading.form,
            "classes": [{**_ref(c, name), "type": class_type(view, c)} for c in members],
        },
    }
    if reading.form == "expression":
        return {**plan, "case": None, "refused": (
            f"The class {name(prop)} belongs to is written as an expression in Turtle; change it there."
        )}
    if reading.form == "none":
        return {**plan, "case": "A"}
    lineage = up(cls)
    if covers(reading, lineage):
        return {**plan, "case": "B", "via": _ref(_nearest(up(cls), members), name)}
    if reading.form == "separate":
        return {**plan, "case": None, "refused": (
            f"{name(prop)} lists {domain_names(reading, name)} separately, which means both. "
            "Share it from its warning first."
        )}
    if all(cls in up(c) for c in members):
        return {**plan, "case": "C"}

    # Case D: neither is a kind of the other.
    everyone = [*members, cls]
    outside = [c for c in everyone if not defined(own, c)]
    all_owl = all(class_type(view, c) == "owl" for c in everyone)
    common: Optional[set] = None
    for c in everyone:
        above = set(up(c)) - {c}
        common = above if common is None else common & above
    common = {s for s in (common or set()) if s not in _TOP}
    # The nearest shared parents: none of them a parent of another.
    nearest = sorted((s for s in common if not any(t != s and s in up(t) for t in common)), key=str)
    # What has the property already, or will under the union: the members'
    # kinds and the class's own.
    covered: set = set()
    for c in everyone:
        covered |= down(c)
    moves = []
    for s in nearest:
        gains = sorted(
            (d for d in down(s) - covered - {s, cls} if _is_class(view, d)),
            key=lambda d: (name(d).casefold(), str(d)),
        )
        moves.append({**_ref(s, name), "gains": [_ref(d, name) for d in gains[:10]], "gainsTotal": len(gains)})
    union = [c for c in members if cls not in up(c)] + [cls]
    turtle = turtle_of(own, union_triples(prop, union)[1]) if all_owl and len(union) >= 2 else None
    return {
        **plan,
        "case": "D",
        "choices": {
            # Make C a kind of D: for one class only, and never a parent
            # added to an import's class.
            "subclass": reading.form == "one" and defined(own, cls),
            "union": all_owl,
            "parent": not outside,
            "up": moves,
        },
        "imported": [{**_ref(c, name), "from": imported_from.get(str(c))} for c in outside],
        "union": [_ref(c, name) for c in union],
        "turtle": turtle,
    }


def _is_class(g: Graph, cls) -> bool:
    return isinstance(cls, URIRef) and any((cls, RDF.type, t) in g for t in (OWL.Class, RDFS.Class))
