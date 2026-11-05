"""
================================================================================
FILE: backend/tests/test_standard_terms.py
================================================================================

SUMMARY
    The standard-term catalogue and its matching rule (V-8, D-126): every
    entry is a real term of rdflib's closed namespaces, every term of the
    four W3C namespaces has an entry, every SKOS label is among its term's
    names, and no name is at both levels (AC-1); and the matching table of
    5.2 -- exact after normalizing, by label or local name, own terms only,
    the name deciding the level (AC-2).

INPUTS / INPUT SOURCES
    - app/standard_terms.py and standard_terms.json.
    - app/vocab/skos.rdf, for the SKOS labels.
    - rdflib's closed namespaces RDF, RDFS, OWL, SKOS, DCTERMS.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

from pathlib import Path

import pytest
from rdflib import Graph, RDFS
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS as RDFS_NS, SKOS

from app import standard_terms as st

APP = Path(__file__).resolve().parent.parent / "app"
NS = {"rdf": RDF, "rdfs": RDFS_NS, "owl": OWL, "skos": SKOS, "dcterms": DCTERMS}
CLOSED = {"rdf": RDF, "rdfs": RDFS_NS, "owl": OWL, "skos": SKOS}


def _closed_uris(ns) -> set[str]:
    """Every URI the namespace defines (rdflib lists them through dir())."""
    return {str(u) for u in dir(ns)}


def _local(curie: str) -> str:
    return curie.split(":", 1)[1]


# --- AC-1: the catalogue is complete and sound -------------------------------------


def test_every_iri_is_a_term_rdflib_defines():
    """A closed namespace raises on an unknown name, so resolving each entry's
    local name proves no invented term entered (5.1)."""
    for entry in st.terms():
        prefix, local = entry["curie"].split(":", 1)
        resolved = getattr(NS[prefix], local)  # AttributeError if undefined
        assert str(resolved) == entry["iri"], entry["curie"]


@pytest.mark.parametrize("prefix", list(CLOSED))
def test_every_term_of_the_four_namespaces_has_an_entry(prefix):
    covered = {e["iri"] for e in st.terms() if e["curie"].startswith(prefix + ":")}
    assert _closed_uris(CLOSED[prefix]) <= covered


def test_the_catalogue_counts_match_the_namespace_documents():
    # RDF 22, RDFS 15, OWL 79, SKOS 32 (checked 2026-11-04 against rdflib).
    assert len(_closed_uris(RDF)) == 22
    assert len(_closed_uris(RDFS_NS)) == 15
    assert len(_closed_uris(OWL)) == 79
    assert len(_closed_uris(SKOS)) == 32


def test_every_skos_label_is_among_its_terms_names():
    g = Graph().parse(APP / "vocab" / "skos.rdf")
    by_iri: dict[str, list[dict]] = {}
    for e in st.terms():
        by_iri.setdefault(e["iri"], []).append(e)
    for subject in set(g.subjects()):
        if not str(subject).startswith(str(SKOS)):
            continue
        for label in g.objects(subject, RDFS.label):
            entries = by_iri.get(str(subject))
            assert entries, f"no entry for {subject}"
            names = {st.normalize(n) for e in entries for n in e["names"]}
            assert st.normalize(str(label)) in names, (subject, str(label))


def test_no_name_is_at_both_levels():
    """5.1/AC-1: when a name is at two levels the name decides, so a name is
    at one level only -- `type` warns, `rdfType` refuses, neither is both."""
    levels: dict[str, set] = {}
    for e in st.terms():
        for n in e["names"]:
            levels.setdefault(st.normalize(n), set()).add(e["level"])
    both = {n: lv for n, lv in levels.items() if len(lv) > 1}
    assert both == {}


def test_only_the_two_axioms_carry_an_offer():
    offers = {e["curie"]: e["offer"] for e in st.terms() if e["offer"]}
    assert set(offers) == {"owl:disjointWith", "owl:equivalentClass"}
    assert offers["owl:disjointWith"] == "AddDisjointWith"
    assert offers["owl:equivalentClass"] == "AddEquivalentClass"


# --- AC-2: the matching rule -------------------------------------------------------

REFUSE_PROPERTY = ["Disjoint with", "disjoint_with", "isDisjointWith", "DISJOINTWITH", "is a", "has broader", "someValuesFrom"]
WARN_PROPERTY = ["type", "range", "hasValue", "member"]
NO_MATCH = ["disjointness", "parent", "name", "hasName"]


@pytest.mark.parametrize("name", REFUSE_PROPERTY)
def test_refuse_names_refuse(name):
    entry = st.match([name], "property")
    assert entry is not None and entry["level"] == "refuse", name


@pytest.mark.parametrize("name", WARN_PROPERTY)
def test_warn_names_warn(name):
    entry = st.match([name], "property")
    assert entry is not None and entry["level"] == "warn", name


@pytest.mark.parametrize("name", NO_MATCH)
def test_ordinary_names_match_nothing(name):
    assert st.match([name], "property") is None
    assert st.match([name], "class") is None


def test_the_name_decides_the_level_not_the_term():
    # rdf:type: `type` warns, `rdfType` refuses (5.2).
    assert st.match(["type"], "property")["level"] == "warn"
    assert st.match(["rdfType"], "property")["level"] == "refuse"
    # A refuse match by either form wins over a warn match.
    assert st.match(["type", "rdfType"], "property")["level"] == "refuse"


def test_kind_decides_what_is_compared():
    # owl:disjointWith is a property; a class named disjointWith is no copy.
    assert st.match(["disjointWith"], "property")["curie"] == "owl:disjointWith"
    assert st.match(["disjointWith"], "class") is None
    # owl:Thing is a class; a property named Thing is no copy.
    assert st.match(["Thing"], "class")["curie"] == "owl:Thing"
    assert st.match(["Thing"], "property") is None


def test_either_form_matches():
    # The label matches though the local name would not, and the reverse.
    assert st.match(["kind of", "weird"], "property")["curie"] == "rdfs:subClassOf"
    assert st.match(["weird", "subClassOf"], "property")["curie"] == "rdfs:subClassOf"
