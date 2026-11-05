"""
================================================================================
FILE: backend/app/standard_terms.py
================================================================================

SUMMARY
    The catalogue of standard terms (V-8, D-126) and the one rule that matches
    a person's own name against it. A home-made copy of a standard axiom --
    an own property or class named `disjointWith`, `sameAs`, `isA`, `broader`
    and the like -- looks right but no reasoner, query or other tool
    understands it. This module is the only reader of standard_terms.json; the
    six create/relabel/rename commands, the Turtle apply, the design checks
    (DC-29, DC-18) and the modeling checks ask it whether a name copies a
    standard term, and at which level.

BASIC IDEA
    standard_terms.json holds one entry per standard term: its IRI, its short
    name (curie), whether it is a property or a class (which own terms it is
    compared with), its level (refuse or warn), the names people give their
    own copy, a plain sentence of what it means, a sentence of how to say it
    the standard way in Semantic Studio, and -- for the two axioms a door can
    offer both ends of -- the command that says it the standard way. The file
    covers every term of the W3C namespace documents of RDF, RDFS, OWL 2 and
    SKOS (checked against rdflib's closed namespaces by test_standard_terms),
    plus the common Dublin Core terms, so nothing is missed and no invented
    term can enter.

    Matching (5.2): a name is normalized -- Unicode NFKC, lower case, every
    character that is not a letter or digit removed -- so `Disjoint with`,
    `disjoint_with`, `isDisjointWith` and `DisjointWith` all become one listed
    name. A term is compared in two forms, the label a person typed in the
    project's primary language and the local name of its IRI; either matching
    is a match. When a name is at both levels (`type` warns, `rdfType`
    refuses) the name decides, never the term, so a refuse match always wins
    over a warn match. Only the kind asked for is compared: a property with a
    property entry, a class with a class entry.

    This module does not know whether a term is the project's own: the caller
    decides ownership (the rule checks.is_own) and asks only for own terms, so
    `owl:disjointWith` written in Turtle, or an imported term, is never
    matched.

INPUTS / INPUT SOURCES
    - standard_terms.json beside this file (read once, cached).

EXPECTED OUTPUT
    - terms() -> every catalogue entry.
    - normalize(name) -> the comparison form.
    - match(names, kind) -> the entry a name copies (refuse before warn), or None.
    - vocab_name(curie) -> the standard vocabulary's display name.
================================================================================
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Iterable, Optional

_PATH = Path(__file__).with_name("standard_terms.json")
_terms: Optional[list[dict]] = None
# normalized name -> entries that carry it (one or two, never at both levels).
_index: Optional[dict[str, list[dict]]] = None

# The vocabulary each entry belongs to, by the prefix of its curie, for the
# words DC-18 reads a warned match with (*creator matches dcterms:creator in
# Dublin Core*). The prefixes are the four W3C namespaces and Dublin Core.
VOCAB_NAMES = {
    "rdf": "RDF",
    "rdfs": "RDFS",
    "owl": "OWL",
    "skos": "SKOS",
    "dcterms": "Dublin Core",
}


def normalize(name: str) -> str:
    """The comparison form (5.2): NFKC, lower case, letters and digits only.

    So a label, a local name and an invented variant all meet on one key:
    `Disjoint with` -> `disjointwith`, `is a` -> `isa`, `rdf_type` -> `rdftype`.
    """
    folded = unicodedata.normalize("NFKC", name).lower()
    return re.sub(r"[^a-z0-9]+", "", folded)


def terms() -> list[dict]:
    """Every catalogue entry, read once. The file is data this module owns;
    no other module parses it (CLAUDE.md, [standard terms])."""
    global _terms
    if _terms is None:
        _terms = json.loads(_PATH.read_text(encoding="utf-8"))["terms"]
    return _terms


def _build_index() -> dict[str, list[dict]]:
    global _index
    if _index is None:
        index: dict[str, list[dict]] = {}
        for entry in terms():
            for name in entry["names"]:
                index.setdefault(normalize(name), []).append(entry)
        _index = index
    return _index


def match(names: Iterable[str], kind: str) -> Optional[dict]:
    """The standard term a person's name copies, or None (5.2).

    `names` are the forms to compare -- the primary-language label and the
    local name of the IRI; `kind` is "property" or "class", which decides
    which entries are eligible. A refuse match is preferred over a warn one,
    because the name decides the level, never the term: `type` as a label
    warns even when `rdfType` would refuse, and a term matching a refuse name
    by either form is refused.
    """
    index = _build_index()
    refuse_hit: Optional[dict] = None
    warn_hit: Optional[dict] = None
    for name in names:
        if not name:
            continue
        for entry in index.get(normalize(name), ()):  # noqa: B007 - small lists
            if entry["kind"] != kind:
                continue
            if entry["level"] == "refuse":
                refuse_hit = refuse_hit or entry
            else:
                warn_hit = warn_hit or entry
    return refuse_hit or warn_hit


def vocab_name(curie: str) -> str:
    """The standard vocabulary's display name for a curie (`owl:disjointWith`
    -> `OWL`), for DC-18's sentence; the prefix itself if it is unlisted."""
    prefix = curie.split(":", 1)[0]
    return VOCAB_NAMES.get(prefix, prefix)
