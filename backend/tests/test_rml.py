"""
================================================================================
FILE: backend/tests/test_rml.py
================================================================================

SUMMARY
    The data import's RML (csv-data-import 5.4, 5.5, Section 9, D-099): the
    mapping written, read back, refused outside the subset with the feature
    named, refused when rml:source names anything but source.csv, and the
    engine's rules -- the type rule, empty cells, IRI-safe templates and the
    2,000-row stop.

BASIC IDEA
    The engine is exercised directly on tables built here. The path checks
    are the security controls of Section 9: each is asserted to refuse, and
    the engine is asserted never to open a file at all -- it is handed the
    table the snapshot read.

INPUTS / INPUT SOURCES
    - app.rml and app.tabular, on mappings and tables built in the test.

EXPECTED OUTPUT
    - Pass/fail; one `perf` budget (Section 10: 2,000 rows x 20 columns in 1 s).
================================================================================
"""

from __future__ import annotations

import builtins
import gc
import time

import pytest
from rdflib import Literal, URIRef
from rdflib.namespace import RDF, RDFS, XSD

from app import rml, tabular
from tests.budget import limit_ms

EX = "http://example.org/p#"
BASE = EX


def table(text: str) -> tabular.Table:
    return tabular.read_table(text.encode())


def mapping_text(subject="http://example.org/p#data/person/{id}", source='csvw:url "source.csv"', extra_pom="",
                 extra=""):
    return f"""
@prefix rml: <http://w3id.org/rml/> .
@prefix csvw: <http://www.w3.org/ns/csvw#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<#map> a rml:TriplesMap ;
  rml:logicalSource [ a rml:LogicalSource ; rml:referenceFormulation rml:CSV ;
    rml:source [ a csvw:Table ; {source} ;
      csvw:dialect [ a csvw:Dialect ; csvw:delimiter "," ; csvw:encoding "utf-8" ; csvw:header true ] ] ] ;
  rml:subjectMap [ rml:template "{subject}" ; rml:class <{EX}Person> ] ;
  rml:predicateObjectMap [ rml:predicate rdfs:label ; rml:objectMap [ rml:reference "name" ; rml:language "en" ] ] ;
  rml:predicateObjectMap [ rml:predicate <{EX}born> ; rml:objectMap [ rml:reference "born" ; rml:datatype xsd:date ] ]
  {extra_pom} .
{extra}
"""


PEOPLE = "id,name,born\n1,Ann,1990-01-02\n2,Bob,yesterday\n3,Cy,\n,Dee,2000-01-01\n"


def test_a_written_mapping_reads_back_and_runs():
    poms = [
        (RDFS.label, rml.ObjectMap("reference", "name", language="en")),
        (URIRef(EX + "born"), rml.ObjectMap("reference", "born", datatype=XSD.date)),
    ]
    graph = rml.build(
        map_iri=EX + "mapping/x", subject_template=rml.escape(EX + "data/person/") + "{id}",
        classes=[URIRef(EX + "Person")], poms=poms, separator=";", encoding="windows-1252",
    )
    mapping = rml.read(rml.to_turtle(graph), BASE)
    assert (mapping.separator, mapping.encoding) == (";", "windows-1252")
    assert set(mapping.references()) == {"id", "name", "born"}
    assert mapping.references()[0] == "id"  # the subject's first


def test_the_type_rule_and_empty_cells():
    # D-097 and 5.5: a value that is not a date is plain text and counted;
    # an empty cell writes nothing; a row without an id makes nothing.
    mapping = rml.read(mapping_text(), BASE)
    graph, out = rml.run(mapping, table(PEOPLE))
    ann, bob, cy = (URIRef(EX + f"data/person/{i}") for i in (1, 2, 3))
    assert (ann, URIRef(EX + "born"), Literal("1990-01-02", datatype=XSD.date)) in graph
    assert (bob, URIRef(EX + "born"), Literal("yesterday")) in graph
    # Never an ill-typed literal.
    assert not any(o.ill_typed for o in graph.objects() if isinstance(o, Literal))
    assert list(graph.objects(cy, URIRef(EX + "born"))) == []
    assert (ann, RDFS.label, Literal("Ann", lang="en")) in graph
    assert (ann, RDF.type, URIRef(EX + "Person")) in graph
    report = out["report"]
    assert report["keptAsText"] == [{"column": "born", "datatype": "date", "count": 1, "rows": [2]}]
    assert report["empty"] == [{"column": "born", "count": 1}]
    assert report["skipped"] == {"count": 1, "rows": [4]}
    assert report["individuals"] == 3 and report["rowsRead"] == 4 and not report["clean"]
    assert out["subjects"] == {str(ann): 1, str(bob): 2, str(cy): 3}


def test_template_values_are_iri_safe():
    mapping = rml.read(mapping_text(), BASE)
    graph, _ = rml.run(mapping, table("id,name,born\nA 1/é?,Ann,\n"))
    assert URIRef(EX + "data/person/A%201%2F%C3%A9%3F") in set(graph.subjects())


def test_the_engine_stops_at_two_thousand_rows_whatever_it_is_handed():
    # D-098 in the engine itself, not only in the reader or the wizard.
    big = tabular.Table(["id", "name", "born"], [[str(i), f"P{i}", ""] for i in range(1, 2501)],
                        2500, ",", "utf-8", True)
    graph, out = rml.run(rml.read(mapping_text(), BASE), big)
    assert out["report"]["rowsRead"] == 2000 and out["report"]["individuals"] == 2000
    assert URIRef(EX + "data/person/2000") in set(graph.subjects())
    assert URIRef(EX + "data/person/2001") not in set(graph.subjects())


def test_a_missing_column_is_named():
    with pytest.raises(rml.UnsupportedMapping, match="reads column born, which this file does not have"):
        rml.run(rml.read(mapping_text(), BASE), table("id,name\n1,Ann\n"))


@pytest.mark.parametrize("feature, extra_pom, named", [
    ("a function", '; rml:predicateObjectMap [ rml:predicate rdfs:comment ; rml:objectMap [ rml:function <http://ex/f> ] ]', "rml:function"),
    ("a join", '; rml:predicateObjectMap [ rml:predicate rdfs:seeAlso ; rml:objectMap [ rml:parentTriplesMap <#other> ; rml:joinCondition [ rml:child "id" ; rml:parent "id" ] ] ]', "rml:"),
    ("a graph map", '; rml:predicateObjectMap [ rml:predicate rdfs:comment ; rml:objectMap [ rml:reference "name" ] ; rml:graphMap [ rml:constant <http://ex/g> ] ]', "rml:graphMap"),
    ("R2RML's terms", '; <http://www.w3.org/ns/r2rml#predicateObjectMap> [ ]', "predicateObjectMap"),
])
def test_features_outside_the_subset_are_refused_by_name(feature, extra_pom, named):
    with pytest.raises(rml.UnsupportedMapping, match="is outside what Semantic Studio runs") as caught:
        rml.read(mapping_text(extra_pom=extra_pom), BASE)
    assert named in str(caught.value)


def test_two_triples_maps_are_refused():
    second = mapping_text().split("<#map>", 1)[1].replace("person", "other")
    text = mapping_text() + "\n<#map2>" + second.split(".\n", 1)[0] + " ."
    with pytest.raises(rml.UnsupportedMapping, match="one triples map; this one has 2"):
        rml.read(text, BASE)


@pytest.mark.parametrize("source", [
    'csvw:url "../model.ttl"',
    'csvw:url "C:\\\\x.csv"',
    'csvw:url "https://example.org/people.csv"',
    'csvw:url <https://example.org/people.csv>',
    'csvw:url "data/../source.csv"',
    'csvw:url "/etc/passwd"',
    'csvw:url "file:///C:/Users/x.csv"',
])
def test_a_source_other_than_the_snapshots_own_copy_is_refused(source):
    # Section 9: the check that keeps an edited mapping from reading another
    # file or fetching a URL.
    with pytest.raises(rml.UnsupportedMapping, match="must name this snapshot's own source.csv"):
        rml.read(mapping_text(source=source), BASE)


def test_a_literal_source_is_held_to_the_same_rule():
    text = mapping_text().replace(
        'rml:source [ a csvw:Table ; csvw:url "source.csv" ;\n      csvw:dialect [ a csvw:Dialect ; csvw:delimiter "," ; csvw:encoding "utf-8" ; csvw:header true ] ]',
        'rml:source "../model.ttl"',
    )
    assert 'rml:source "../model.ttl"' in text
    with pytest.raises(rml.UnsupportedMapping, match="must name this snapshot's own source.csv"):
        rml.read(text, BASE)
    assert rml.read(text.replace("../model.ttl", "source.csv"), BASE).separator == ","


def test_the_engine_never_opens_a_file(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the engine opened a file")

    mapping = rml.read(mapping_text(), BASE)
    data = table(PEOPLE)
    monkeypatch.setattr(builtins, "open", refuse)
    rml.run(mapping, data)


def test_a_template_that_makes_a_relative_iri_is_refused():
    with pytest.raises(rml.UnsupportedMapping, match="not an absolute IRI"):
        rml.run(rml.read(mapping_text(subject="person/{id}"), BASE), table(PEOPLE))


def test_a_malformed_template_is_refused_on_reading():
    with pytest.raises(rml.UnsupportedMapping, match="never closed"):
        rml.read(mapping_text(subject="http://ex/{id"), BASE)


def test_an_edited_mapping_is_held_to_a_size():
    # A worker cannot be interrupted, so a mapping that would multiply 2,000
    # rows into millions of statements is refused before it runs.
    poms = "".join(
        f'; rml:predicateObjectMap [ rml:predicate <{EX}p{i}> ; rml:objectMap [ rml:reference "name" ] ]'
        for i in range(rml.MAX_MAPS)
    )
    with pytest.raises(rml.UnsupportedMapping, match="at most 300 predicate-object pairs"):
        rml.read(mapping_text(extra_pom=poms), BASE)


@pytest.mark.perf
def test_import_budget():
    # Section 10: 2,000 rows x 20 columns in 1 s.
    columns = ["id"] + [f"c{i}" for i in range(19)]
    rows = [[str(n)] + [f"value {n} {i}" if i % 3 else "2020-01-01" for i in range(19)] for n in range(1, 2001)]
    data = tabular.Table(columns, rows, 2000, ",", "utf-8", True)
    poms = [
        (URIRef(EX + c), rml.ObjectMap("reference", c, datatype=XSD.date if i % 3 == 0 else None,
                                       language=None if i % 3 == 0 else "en"))
        for i, c in enumerate(columns[1:])
    ]
    graph = rml.build(map_iri=EX + "m", subject_template=EX + "data/row/{id}", classes=[URIRef(EX + "Row")],
                      poms=poms, separator=",", encoding="utf-8")
    mapping = rml.read(rml.to_turtle(graph), BASE)
    times = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            produced, _ = rml.run(mapping, data)
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    assert len(produced) == 2000 * 20
    median = sorted(times)[2]
    assert median <= limit_ms(1000), f"mapping 2,000 rows x 20 columns took {median:.0f} ms (median of 5)"
