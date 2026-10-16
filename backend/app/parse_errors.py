"""
================================================================================
FILE: backend/app/parse_errors.py
================================================================================

SUMMARY
    The one place a parser's message becomes a sentence a person reads
    (load-and-shapes 5.1, D-112). A failed load used to answer with the raw
    output of five parsers in turn; this module turns those attempts into one
    plain sentence, the line it concerns and the format it was read as, and
    keeps the raw text for the Load dialog's *Technical details*.

BASIC IDEA
    store.py tries every parser and keeps each one's message. Only one of
    them can explain the failure, and it is chosen from what the file claims
    to be: the format its name (or the server's content type) suggested, else
    the attempt that got furthest -- the highest line it reports -- else
    Turtle's. A Turtle file missing a full stop also fails as RDF/XML at line
    1 and as JSON at column 1; those messages are true and say nothing.

    The line is read from the parser's own message, in the three shapes the
    parsers write it (*at line 3* from rdflib's Turtle family, *:1:98* from
    expat, *line 1 column 40* from Python's json). The messages this module
    knows are translated; any other is named by format and line, never
    quoted, because a parser's wording is written for the parser's author.

    A file that no parser reads past its first line, that shows no sign of
    RDF in its first kilobyte, and whose chosen message the table does not
    know, is not a broken RDF file but some other file, and is told so. A
    known message counts as a sign: a Turtle file whose only fault is a
    missing @prefix has no "<" in it at all. A file with a NUL byte there is binary (a
    workbook, an image) and shows no sign of RDF whatever its bytes happen
    to contain. Names ending in a table's extension get the way to bring a
    table in.

    Pure: no I/O, no rdflib. It runs only after every attempt has failed,
    over messages already collected.

INPUTS / INPUT SOURCES
    - ParseError.attempts: [(rdflib parser name, message)], in the order tried.
    - The suggested parser name, from the file name or a content type.
    - The file's first kilobyte and its name.

EXPECTED OUTPUT
    - explain(...): the 422 detail, {code: "parse_error", message, line,
      format, technical}.
    - format_from_content_type(value): a parser name or None.
    - FORMAT_NAMES / format_name: the formats as people write them, the same
      table as the frontend's statusWords.ts.
================================================================================
"""

from __future__ import annotations

import re
from typing import Optional, Sequence

# The written names, as the status bar shows them (statusWords.ts holds the
# same table; a test reads both).
FORMAT_NAMES = {
    "turtle": "Turtle",
    "xml": "RDF/XML",
    "json-ld": "JSON-LD",
    "nt": "N-Triples",
    "n3": "N3",
    "trig": "TriG",
    "nquads": "N-Quads",
}

# rdflib's parsers that share the Turtle grammar, and so its messages.
_TURTLE_FAMILY = frozenset({"turtle", "trig", "n3"})

NOT_RDF = (
    "This file does not look like RDF. Semantic Studio reads Turtle, RDF/XML, "
    "JSON-LD, N-Triples, N3, TriG and N-Quads."
)
TABLE_HINT = "To bring in a table, open a project and use its Data tab."
_TABLE_EXTENSIONS = (".csv", ".xlsx", ".xls")

# Any one of these in the first kilobyte is enough to call a file RDF that
# failed, rather than some other kind of file.
_RDF_SIGNS = (b"@prefix", b"PREFIX", b"<", b"{", b"_:")

# The three ways a parser writes where it stopped, in the order tried.
_LINE_PATTERNS = (
    re.compile(r"\bat line (\d+)\b"),          # rdflib: "at line 3 of <>"
    re.compile(r":(\d+):\d+:"),                # expat: "<unknown>:1:98: mismatched tag"
    re.compile(r"\bline (\d+) column \d+\b"),  # json: "line 1 column 40 (char 39)"
)

_PREFIX_NOT_BOUND = re.compile(r'Prefix "([^"]*)" not bound')
# Python's json messages: "Expecting value", "Expecting ',' delimiter",
# "Extra data", "Unterminated string starting at", and the like.
_JSON_MESSAGE = re.compile(
    r"^(Expecting\b|Extra data\b|Unterminated string\b|Invalid control character\b|Invalid \\escape\b)"
)

_CONTENT_TYPES = {
    "text/turtle": "turtle",
    "application/x-turtle": "turtle",
    "application/rdf+xml": "xml",
    "application/ld+json": "json-ld",
    "application/n-triples": "nt",
    "text/n3": "n3",
    "application/trig": "trig",
    "application/n-quads": "nquads",
}


def format_name(fmt: Optional[str]) -> Optional[str]:
    """The written name; one the table does not know is shown as it comes."""
    if fmt is None:
        return None
    return FORMAT_NAMES.get(fmt, fmt)


def format_from_content_type(value: Optional[str]) -> Optional[str]:
    """The parser a server's Content-Type names, ignoring its parameters.

    Only a suggestion for the explanation: the parse itself still follows the
    name, so a server that labels everything text/plain changes nothing.
    """
    if not value:
        return None
    return _CONTENT_TYPES.get(value.split(";", 1)[0].strip().lower())


def line_of(message: str) -> Optional[int]:
    """The line a parser's message reports, or None when it reports none."""
    for pattern in _LINE_PATTERNS:
        match = pattern.search(message)
        if match:
            return int(match.group(1))
    return None


def _chosen(attempts: Sequence[tuple[str, str]], suggested: Optional[str]) -> tuple[str, str]:
    """The one attempt worth explaining (BASIC IDEA, second paragraph)."""
    for fmt, message in attempts:
        if fmt == suggested:
            return fmt, message
    furthest = None
    for fmt, message in attempts:
        line = line_of(message)
        # Strictly greater: of two that stopped on the same line, the one
        # tried first -- Turtle, in the sniff order -- is kept.
        if line is not None and (furthest is None or line > furthest[0]):
            furthest = (line, fmt, message)
    if furthest is not None:
        return furthest[1], furthest[2]
    for fmt, message in attempts:
        if fmt == "turtle":
            return fmt, message
    return attempts[0]


def _binary(head: bytes) -> bool:
    return b"\x00" in head


def _looks_like_rdf(head: bytes) -> bool:
    return not _binary(head) and any(sign in head for sign in _RDF_SIGNS)


def _known(fmt: str, message: str, line: Optional[int]) -> Optional[str]:
    """The table of 5.1: a message it knows, translated; None for any other."""
    at = f"Line {line}: " if line is not None else ""
    if fmt in _TURTLE_FAMILY:
        if "EOF found" in message:
            return "The file ends in the middle of a statement."
        if line is not None:
            if "expected '.' or '}' or ']' at end of statement" in message:
                return (
                    f"{at}the statement before this line is not finished. "
                    "It probably needs a full stop (.) at its end."
                )
            prefix = _PREFIX_NOT_BOUND.search(message)
            if prefix:
                p = prefix.group(1)
                return (
                    f"{at}the prefix {p} is used but never declared. "
                    f"Add `@prefix {p} <…> .` near the top of the file."
                )
            if "newline found in string literal" in message:
                return f"{at}a text value in quotes is not closed before the end of the line."
    elif fmt == "xml":
        if "mismatched tag" in message or "not well-formed" in message:
            return (
                f"{at}the XML is not well formed: an element is not closed, "
                "or a character is out of place."
            )
    elif fmt == "json-ld":
        if _JSON_MESSAGE.search(message):
            return f"{at}the JSON is not valid."
    return None


def _named(fmt: str, line: Optional[int]) -> str:
    """The table's last row: any other message, named by format and line."""
    name = format_name(fmt)
    if line is not None:
        return f"The file could not be read as {name}, line {line}."
    return f"The file could not be read as {name}."


def explain(
    attempts: Sequence[tuple[str, str]],
    suggested: Optional[str],
    *,
    head: bytes,
    filename: Optional[str],
    technical: str,
) -> dict:
    """The 422 detail for a load that no parser could read."""
    if not attempts:
        # A refusal raised mid-parse (a blocked address) already carries the
        # server's own sentence, not a parser's; there is nothing to choose.
        return {"code": "parse_error", "message": technical, "line": None,
                "format": None, "technical": None}
    head = head[:1024]
    fmt, raw = _chosen(attempts, suggested)
    line = line_of(raw)
    known = _known(fmt, raw, line)
    furthest = max((line_of(m) or 0 for _, m in attempts), default=0)
    # A message the table knows is itself a sign of RDF: `ex:a a ex:Thing .`
    # has no "<" or "@prefix", and is a Turtle file missing its prefix. A
    # binary file is no RDF whatever a parser made of its stray bytes.
    if _binary(head) or (known is None and furthest <= 1 and not _looks_like_rdf(head)):
        message = NOT_RDF
        if filename and filename.lower().endswith(_TABLE_EXTENSIONS):
            message = f"{message} {TABLE_HINT}"
        return {"code": "parse_error", "message": message, "line": None,
                "format": None, "technical": technical}
    return {
        "code": "parse_error",
        "message": known if known is not None else _named(fmt, line),
        "line": line,
        "format": format_name(fmt),
        "technical": technical,
    }
