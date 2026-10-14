"""
================================================================================
FILE: backend/app/sentences.py
================================================================================

SUMMARY
    The two grammar rules every sentence the server writes shares: *a* or
    *an* before a name, and a relationship's label read as a verb -- after a
    subject (*Ann uses a car*, *unit A is part of Acme*) or after *must*
    (*must use*, *must be part of*). The frontend's modeling/sentences.ts
    holds the same two rules, tested with the same table.

BASIC IDEA
    Four copies chose the article by the first letter alone and gave *an
    University*, *a hour* and *a XML file*; two verb rules guessed apart and
    one gave *must be uses* (X-12, T-18 and T-19). Now there is one of each
    per side, and test_sentences.py fails if another module defines its own.

    *an* goes before a vowel sound, judged from the first word: a vowel
    letter, except words starting *uni*, *use*, *usu*, *eu*, *one* or
    *once*; words starting *hour*, *honest*, *honor* or *heir*; and a word
    in capitals, read letter by letter, whose first letter's name starts
    with a vowel sound (*an XML file*, *an HTML page*, *a URL*).

    A label is a verb when its first word is one (*is*, *has*, *can*) or
    ends in a single *s* (*uses*, *works for*); a label ending in a
    preposition, or starting with a participle, reads after *is* or *be*
    (*part of*, *located in*, *owned by*); anything else, a bare noun such
    as *holder*, is left as written, since *is holder* would say the subject
    is the holder. No article is guessed before a label (*Ann is member of
    Team A* stays): which nouns take one cannot be told from the label.

INPUTS / INPUT SOURCES
    - Names and labels, already chosen in the display language.

EXPECTED OUTPUT
    - Strings.
================================================================================
"""

from __future__ import annotations

import re

# Letters whose names start with a vowel sound: "an F", "an H", "an X".
_VOWEL_NAMED_LETTERS = frozenset("AEFHILMNORSX")
# A vowel letter sounded as a consonant: "a university", "a one-off".
_CONSONANT_STARTS = ("uni", "use", "usu", "eu", "one", "once")
# A silent h: "an hour".
_SILENT_H = ("hour", "honest", "honor", "heir")

# First words that already read as a verb.
_AUXILIARIES = frozenset({
    "is", "are", "was", "were", "be", "been", "has", "have", "had", "can", "could",
    "may", "might", "must", "shall", "should", "will", "would", "does", "do", "did",
})
# Last words that mark a label needing *is*: "unit A part of Acme" was the
# sentence (PR #55 review).
_PREPOSITIONS = frozenset({
    "of", "to", "in", "at", "by", "for", "with", "from", "on", "into", "onto", "about",
    "above", "below", "under", "over", "inside", "near", "before", "after", "within", "than",
})

_FIRST_WORD = re.compile(r"[A-Za-z]+")
_WORDS = re.compile(r"[A-Za-z][a-z]*")


def article(word: str) -> str:
    """*a* or *an* before ``word``, by how its first word sounds."""
    m = _FIRST_WORD.match(word.strip())
    if m is None:
        return "a"
    first = m.group(0)
    # Capitals to start (XML, URLs, a lone X): read letter by letter.
    if first[:2].isupper():
        return "an" if first[0] in _VOWEL_NAMED_LETTERS else "a"
    lower = first.lower()
    if lower.startswith(_SILENT_H):
        return "an"
    if lower.startswith(_CONSONANT_STARTS):
        return "a"
    return "an" if lower[0] in "aeiou" else "a"


def a(word: str) -> str:
    """``word`` with its article: *a Person*, *an Organization*."""
    return f"{article(word)} {word}"


def _is_third_person(word: str) -> bool:
    return word.endswith("s") and not word.endswith(("ss", "us"))


def _reads_after_is(words: list[str]) -> bool:
    return words[-1] in _PREPOSITIONS or words[0].endswith("ed")


def verb(label: str) -> str:
    """A relationship's label as the verb after a subject. *employs*,
    *worksFor* and *has part* stay as they are; *part of*, *above* and
    *located in* read after *is*. A bare noun (*holder*) is left alone:
    *passport 1 is holder Ann* would say the passport holds."""
    words = [w.lower() for w in _WORDS.findall(label)]
    if not words:
        return label
    first = words[0]
    if first in _AUXILIARIES or _is_third_person(first):
        return label
    if _reads_after_is(words):
        return f"is {label}"
    return label


def must_verb(label: str) -> str:
    """The same label after *must* or *may*: *uses* -> *use*, *has part* ->
    *have part*, *is part of* and *part of* -> *be part of*; a bare noun is
    left alone, as in ``verb``."""
    found = list(_WORDS.finditer(label))
    if not found:
        return label
    words = [m.group(0).lower() for m in found]
    first, head = words[0], found[0]
    rest = label[head.end():]
    if first in ("is", "are"):
        return f"be{rest}"
    if first == "has":
        return f"have{rest}"
    if first in _AUXILIARIES:
        return label
    if _is_third_person(first):
        written = head.group(0)
        if first.endswith("ies") and len(first) > 4:
            base = written[:-3] + "y"
        elif first.endswith(("ches", "shes", "sses", "xes", "zes", "oes")):
            base = written[:-2]
        else:
            base = written[:-1]
        return f"{label[:head.start()]}{base}{rest}"
    if _reads_after_is(words):
        return f"be {label}"
    return label
