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

BASIC IDEA
    One table, frontend/src/modeling/sentences.table.json, read by both
    suites: two tables kept in step by hand is how four article rules came
    to disagree. The scan reads every module of the app as text and looks
    for what a copy would write -- a function named for the rule, the
    first-letter ternary, the verb rule's word lists -- after asserting that
    it read the files at all, since a scan over nothing passes.

INPUTS / INPUT SOURCES
    - app.sentences; the shared table; backend/app/**/*.py as text.

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
