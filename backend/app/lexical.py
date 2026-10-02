"""
================================================================================
FILE: backend/app/lexical.py
================================================================================

SUMMARY
    Whether a piece of text is a valid value of an XML Schema datatype: the
    lexical rules a typed value must meet, shared by the editing commands
    (a refusal) and the data import's engine (a value kept as text).

BASIC IDEA
    One table of patterns, one per datatype the app offers, with a real
    calendar check on dates: 2026-02-30 has the shape of a date and is not
    one. editing.py refuses a value that fails, with the type's sentence;
    rml.py keeps it as plain text and counts it (D-097). Both must agree on
    what fits, or a value the form refuses would import as typed, so the
    rules live here once.

    The table is deliberately strict. rdflib parses more than XSD allows
    (it reads "2026-1-5" as a date), and a value typed by the import that
    a strict reader calls ill-typed would be a broken typed value, the one
    thing D-097 says never to write.

INPUTS / INPUT SOURCES
    - A value's text and a datatype's short name (integer, date, ...).

EXPECTED OUTPUT
    - valid(value, name) -> bool; LEXICAL, the patterns with each type's
      name and an example, for the sentences that refuse one.
================================================================================
"""

from __future__ import annotations

import re
from datetime import date

_TZ = r"(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?"
_DATE = r"(-?[0-9]{4,})-([0-9]{2})-([0-9]{2})"

# name -> (pattern, the type's name in a sentence, what is expected)
LEXICAL = {
    "integer": (re.compile(r"[+-]?[0-9]+"), "integer", "a whole number such as 42"),
    "decimal": (
        re.compile(r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)"),
        "decimal",
        "a number such as 4.5",
    ),
    "double": (
        re.compile(r"[+-]?(([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?|INF)|NaN"),
        "number",
        "a number such as 4.5 or 1E3",
    ),
    "boolean": (re.compile(r"true|false|1|0"), "boolean", "true or false"),
    "date": (re.compile(_DATE + _TZ), "date", "YYYY-MM-DD"),
    "dateTime": (
        re.compile(_DATE + r"T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?" + _TZ),
        "date and time",
        "YYYY-MM-DDThh:mm:ss",
    ),
    "gYear": (re.compile(r"-?[0-9]{4,}" + _TZ), "year", "a year such as 2026"),
}
# float is double's narrower twin; the lexical space is the same.
LEXICAL["float"] = LEXICAL["double"]


def real_date(year: str, month: str, day: str) -> bool:
    try:
        # A year past 9999 or before 1 is lexically legal and Python cannot
        # represent it; check the month and day against a leap year instead.
        y = int(year)
        date(y if 1 <= y <= 9999 else 2000, int(month), int(day))
        return True
    except ValueError:
        return False


def valid(value: str, name: str) -> bool:
    """True when `value` is in the lexical space of the datatype `name`.

    A name outside the table (string, anyURI, langString, an unknown type)
    is not judged here: the caller decides what that means."""
    entry = LEXICAL.get(name)
    if entry is None:
        return True
    match = entry[0].fullmatch(value)
    if match is None:
        return False
    if name in ("date", "dateTime") and not real_date(match.group(1), match.group(2), match.group(3)):
        return False
    if name == "dateTime":
        hour, minute, second = int(match.group(4)), int(match.group(5)), int(match.group(6))
        return (hour < 24 and minute < 60 and second < 60) or (hour, minute, second) == (24, 0, 0)
    return True
