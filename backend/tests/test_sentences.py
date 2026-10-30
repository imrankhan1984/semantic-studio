"""
================================================================================
FILE: backend/tests/test_sentences.py
================================================================================

SUMMARY
    The two grammar rules every server sentence shares (X-12, T-18, T-19):
    *a* or *an* before a name, and a relationship's label read as a verb
    after a subject and after *must*. Tested against the table the
    frontend's sentences.test.ts reads too, so the two sides agree; and a
    scan that fails if any other module defines its own.

    A noun reads after *has* (wording 5.2): the table holds the spec's noun
    rows, and every property name in the bundled examples, the templates
    and FOAF that now takes *has* is listed here, so a base-form verb
    (*contain*, which would read *has contain*) cannot arrive unread.

BASIC IDEA
    One table, frontend/src/modeling/sentences.table.json, read by both
    suites: two tables kept in step by hand is how four article rules came
    to disagree. The scan reads every module of the app as text and looks
    for what a copy would write -- a function named for the rule, the
    first-letter ternary, the verb rule's word lists -- after asserting that
    it read the files at all, since a scan over nothing passes.

INPUTS / INPUT SOURCES
    - app.sentences; the shared table; backend/app/**/*.py as text.
    - app/examples/*.ttl, app/templates/*.ttl and app/vocab/foaf.rdf.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.sentences import a, article, must_verb, verb

ROOT = Path(__file__).resolve().parent.parent.parent
TABLE = json.loads((ROOT / "frontend" / "src" / "modeling" / "sentences.table.json").read_text(encoding="utf-8"))
APP = ROOT / "backend" / "app"


@pytest.mark.parametrize("word, expected", TABLE["article"])
def test_the_article_is_chosen_by_sound(word, expected):
    assert article(word) == expected
    assert a(word) == f"{expected} {word}"


@pytest.mark.parametrize("label, after, must", TABLE["verb"])
def test_a_label_reads_as_a_verb_after_a_subject_and_after_must(label, after, must):
    assert verb(label) == after
    assert must_verb(label) == must


def test_the_table_holds_the_specs_examples():
    # T-18's seven and T-19's six, so a trimmed table cannot pass quietly.
    articles = dict(map(tuple, TABLE["article"]))
    assert {w: articles[w] for w in (
        "University", "hour", "XML file", "URL", "Organization", "Person", "honest broker",
    )} == {
        "University": "a", "hour": "an", "XML file": "an", "URL": "a",
        "Organization": "an", "Person": "a", "honest broker": "an",
    }
    verbs = {row[0] for row in TABLE["verb"]}
    assert {"uses", "has part", "is part of", "part of", "located in", "holder"} <= verbs
    # wording 5.2's noun rows, the verbs beside them, and *has destination*,
    # which must not become *has has destination*.
    rows = {row[0]: (row[1], row[2]) for row in TABLE["verb"]}
    assert {k: rows[k] for k in ("crew member", "holder", "launch site", "has destination", "orbits")} == {
        "crew member": ("has crew member", "have crew member"),
        "holder": ("has holder", "have holder"),
        "launch site": ("has launch site", "have launch site"),
        "has destination": ("has destination", "have destination"),
        "orbits": ("orbits", "orbit"),
    }


# Every property name in the bundled examples, the templates and FOAF that
# reads after *has* since wording 5.2, each read by a person as a noun or a
# participle (*made*), never a verb in base form. A new name in one of those
# files that takes *has* fails here until someone reads it: *contain* would
# say *has contain*, the known limit 5.2 accepts.
NOUN_NAMES = {
    "account", "account name", "account service homepage", "acronym", "age", "AIM chat ID",
    "birthday", "born in year", "crew member", "crew size", "current project", "depiction",
    "diameter (km)", "DNA checksum", "family_name", "familyName", "firstName", "focus",
    "geekcode", "gender", "Given name", "homepage", "ICQ chat ID", "image", "in year",
    "interest", "jabber ID", "landing date", "lastName", "launch date", "logo", "made",
    "maker", "member", "membershipClass", "mission type", "MSN chat ID", "name", "nickname",
    "openid", "page", "past project", "personal mailbox", "phone", "plan", "primary topic",
    "schoolHomepage", "sha1sum (hex)", "sha1sum of a personal mailbox URI name", "Skype ID",
    "status", "Surname", "target", "theme", "thumbnail", "tipjar", "title", "topic",
    "topic_interest", "weblog", "work info homepage", "workplace homepage", "Yahoo chat ID",
    "year founded", "year of discovery",
}

_FILL = {
    "{{base}}": "http://example.org/x#", "{{ontology}}": "http://example.org/x",
    "{{prefix}}": "ex", "{{name}}": "X", "{{lang}}": "en",
}


def _bundled_graphs():
    from rdflib import Graph

    for path in sorted((APP / "examples").glob("*.ttl")) + sorted((APP / "templates").glob("*.ttl")):
        text = path.read_text(encoding="utf-8")
        for key, value in _FILL.items():
            text = text.replace(key, value)
        yield path.name, Graph().parse(data=text, format="turtle")
    yield "foaf.rdf", Graph().parse(APP / "vocab" / "foaf.rdf", format="xml")


def test_no_bundled_property_name_is_a_base_form_verb():
    from rdflib import OWL, RDF, RDFS, URIRef

    names: set[str] = set()
    read = []
    for file, graph in _bundled_graphs():
        read.append(file)
        for kind in (OWL.ObjectProperty, OWL.DatatypeProperty, RDF.Property):
            for prop in graph.subjects(RDF.type, kind):
                if not isinstance(prop, URIRef):
                    continue
                labels = [str(l) for l in graph.objects(prop, RDFS.label) if getattr(l, "language", None) in (None, "en")]
                for label in labels or [re.split(r"[#/]", str(prop))[-1]]:
                    if verb(label) == f"has {label}":
                        names.add(label)
    # The files were read: both examples, the Small template, FOAF.
    assert {"middle-earth.ttl", "space-exploration.ttl", "small.ttl", "foaf.rdf"} <= set(read)
    assert names == NOUN_NAMES


# What a copy of either rule would write.
OWN = [
    re.compile(r"^\s*def (article|a|an|with_article|verb|must_verb)\(", re.M),
    re.compile(r"""["']an["']\s+if\b"""),
    re.compile(r"""\belse\s+["']an["']"""),
    re.compile(r"\b_(AUXILIARIES|PREPOSITIONS)\b"),
]


def test_no_module_but_sentences_defines_its_own():
    sources = {path: path.read_text(encoding="utf-8") for path in APP.rglob("*.py")}
    own = APP / "sentences.py"
    # The scan read the app, the rule's own module among them.
    assert len(sources) > 30
    assert "def article(" in sources[own] and "def must_verb(" in sources[own]
    offenders = [
        f"{path.relative_to(APP)}: {pattern.pattern}"
        for path, text in sources.items()
        if path != own
        for pattern in OWN
        if pattern.search(text)
    ]
    assert offenders == []
