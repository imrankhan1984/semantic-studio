"""
================================================================================
FILE: backend/tests/test_parse_errors.py
================================================================================

SUMMARY
    A failed load explained in one sentence (load-and-shapes 5.1, AC-1, AC-2):
    parse_errors.py's table row by row from the parser messages it names, the
    line read from each of the three shapes parsers write it in, no sentence
    carrying a backtick, the choice of which attempt to explain, the *not RDF* sentence and its table hint; and
    the seven broken files of 5.1 uploaded through the API.

BASIC IDEA
    The unit tests feed explain() messages copied from rdflib, expat and
    Python's json as they read on 2026-10-16. The integration tests do not
    copy anything: they upload the seven files and compare the answer with
    the spec's last table, sentence for sentence, and `technical` with the
    text the route answered before (the same string ParseError carries).

    The fixtures are inline and each defect is the one its name says, per
    the rdf-fixture skill.

INPUTS / INPUT SOURCES
    - The FastAPI app through TestClient; httpx.MockTransport as the broker's
      transport for the URL route.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

import ast
import inspect
import io
import ipaddress
import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import parse_errors
from app.main import app
from app.network_broker import broker
from app.parse_errors import NOT_RDF, TABLE_HINT, explain, line_of
from app.store import ParseError, parse_rdf

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

# The seven files of 5.1, as the spec measured them.
FILES = {
    "missing-dot.ttl": b"@prefix ex: <http://example.org/> .\nex:a a ex:Thing\nex:b a ex:Thing .\n",
    "no-prefix.ttl": b"ex:a a ex:Thing .\n",
    "open-string.ttl": b'@prefix ex: <http://example.org/> .\nex:a ex:label "not closed .\nex:b ex:label "b" .\n',
    "broken.rdf": (
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description rdf:about="http://example.org/a"></rdf:RDF>\n'
    ),
    "broken.jsonld": b'{"@id": "http://example.org/a" "http://example.org/p": "x"}\n',
    "notrdf.ttl": b"name,age\nAlice,30\nBob,41\n",
    "empty.ttl": b"",
}

# The spec's last table of 5.1: (sentence, line, format).
EXPECTED = {
    "missing-dot.ttl": (
        "Line 3: the statement before this line is not finished. It probably needs a full stop (.) at its end.",
        3, "Turtle"),
    "no-prefix.ttl": (
        "Line 1: the prefix ex: is used but never declared. Add @prefix ex: <…> . near the top of the file.",
        1, "Turtle"),
    "open-string.ttl": (
        "Line 2: a text value in quotes is not closed before the end of the line.", 2, "Turtle"),
    "broken.rdf": (
        "Line 1: the XML is not well formed: an element is not closed, or a character is out of place.",
        1, "RDF/XML"),
    "broken.jsonld": ("Line 1: the JSON is not valid.", 1, "JSON-LD"),
    "notrdf.ttl": (
        "This file does not look like RDF. Semantic Studio reads Turtle, RDF/XML, JSON-LD, "
        "N-Triples, N3, TriG and N-Quads.",
        None, None),
}

TURTLE_FULL_STOP = (
    "at line 3 of <>:\nBad syntax (expected '.' or '}' or ']' at end of statement) at ^ in:\n"
    "\"b'@prefix ex: <http://example.org/> .\\nex:a a ex:Thing\\n'^b'ex:b a ex:Thing .\\n'\""
)
TURTLE_PREFIX = 'at line 1 of <>:\nBad syntax (Prefix "ex:" not bound) at ^ in:\n"b\'\'^b\'ex:a a ex:Thing .\\n\'"'
TURTLE_STRING = "at line 2 of <>:\nBad syntax (newline found in string literal) at ^ in:\n\"...\""
TURTLE_EOF = "at line 2 of <>:\nBad syntax (EOF found after object) at ^ in:\n\"...\""
TURTLE_OTHER = "at line 1 of <>:\nBad syntax (expected directive or statement) at ^ in:\n\"...\""
XML_MISMATCHED = "<unknown>:1:117: mismatched tag"
XML_NOT_WELL_FORMED = "<unknown>:4:0: not well-formed (invalid token)"
XML_SYNTAX = "<unknown>:1:0: syntax error"
JSON_COMMA = "Expecting ',' delimiter: line 1 column 32 (char 31)"
JSON_VALUE = "Expecting value: line 5 column 1 (char 40)"
JSON_NAME = "Expecting property name enclosed in double quotes: line 2 column 3 (char 4)"
NT_INVALID = "Invalid line: ex:a a ex:Thing ."

RDF_HEAD = b"@prefix ex: <http://example.org/> ."


def say(attempts, suggested=None, head=RDF_HEAD, filename="file.ttl"):
    return explain(attempts, suggested, head=head, filename=filename, technical="raw")


# ---------------------------------------------------------------------------
# The table of 5.1, row by row
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fmt,message,sentence", [
    ("turtle", TURTLE_FULL_STOP,
     "Line 3: the statement before this line is not finished. It probably needs a full stop (.) at its end."),
    ("turtle", TURTLE_PREFIX,
     "Line 1: the prefix ex: is used but never declared. Add @prefix ex: <…> . near the top of the file."),
    ("turtle", TURTLE_STRING, "Line 2: a text value in quotes is not closed before the end of the line."),
    ("turtle", TURTLE_EOF, "The file ends in the middle of a statement."),
    # TriG reads the same grammar and says the same things.
    ("trig", TURTLE_STRING, "Line 2: a text value in quotes is not closed before the end of the line."),
    ("xml", XML_MISMATCHED,
     "Line 1: the XML is not well formed: an element is not closed, or a character is out of place."),
    ("xml", XML_NOT_WELL_FORMED,
     "Line 4: the XML is not well formed: an element is not closed, or a character is out of place."),
    ("json-ld", JSON_COMMA, "Line 1: the JSON is not valid."),
    ("json-ld", JSON_VALUE, "Line 5: the JSON is not valid."),
    ("json-ld", JSON_NAME, "Line 2: the JSON is not valid."),
    # Anything else is named by its format and line, never quoted.
    ("turtle", TURTLE_OTHER, "The file could not be read as Turtle, line 1."),
    ("xml", XML_SYNTAX, "The file could not be read as RDF/XML, line 1."),
    ("nt", NT_INVALID, "The file could not be read as N-Triples."),
])
def test_each_row_of_the_table(fmt, message, sentence):
    detail = say([(fmt, message)], suggested=fmt)
    assert detail["message"] == sentence
    assert detail["code"] == "parse_error"
    assert detail["technical"] == "raw"


def test_no_sentence_carries_a_backtick():
    # A person reads the sentence as plain text: a backtick is shown as a
    # character, not code (load-and-shapes v1.2). Every string the module
    # writes, docstrings aside, is read from its source, so a sentence added
    # later is covered without a row here.
    tree = ast.parse(inspect.getsource(parse_errors))
    docstrings = {
        id(node.body[0].value) for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef))
        and node.body and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    strings = [
        node.value for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and id(node) not in docstrings
    ]
    assert any("never declared" in text for text in strings)
    assert [text for text in strings if "`" in text] == []
    for fmt, message in [("turtle", TURTLE_PREFIX), ("turtle", TURTLE_OTHER), ("json-ld", JSON_COMMA)]:
        assert "`" not in say([(fmt, message)], suggested=fmt)["message"]


def test_the_sentence_never_quotes_the_parser():
    for fmt, message in [("turtle", TURTLE_OTHER), ("xml", XML_SYNTAX), ("nt", NT_INVALID)]:
        sentence = say([(fmt, message)], suggested=fmt)["message"]
        assert "Bad syntax" not in sentence and "Invalid line" not in sentence
        assert "b'" not in sentence


# ---------------------------------------------------------------------------
# The line, from each of the three shapes
# ---------------------------------------------------------------------------


def test_the_line_is_read_from_each_shape():
    assert line_of(TURTLE_FULL_STOP) == 3                       # "at line 3"
    assert line_of("<unknown>:12:98: mismatched tag") == 12     # ":12:98"
    assert line_of("Expecting value: line 7 column 40 (char 99)") == 7  # "line 7 column 40"
    assert line_of(NT_INVALID) is None


# ---------------------------------------------------------------------------
# Which attempt is explained
# ---------------------------------------------------------------------------


def test_the_suggested_format_is_explained_first():
    attempts = [("turtle", TURTLE_FULL_STOP), ("xml", XML_MISMATCHED), ("json-ld", JSON_COMMA)]
    # Turtle got furthest; the name said JSON-LD, so JSON-LD is explained.
    detail = say(attempts, suggested="json-ld", filename="data.jsonld")
    assert detail["format"] == "JSON-LD" and detail["line"] == 1


def test_without_a_suggestion_the_furthest_attempt_is_explained():
    attempts = [("turtle", TURTLE_PREFIX), ("xml", XML_NOT_WELL_FORMED), ("json-ld", JSON_COMMA)]
    detail = say(attempts, suggested=None)
    assert detail["format"] == "RDF/XML" and detail["line"] == 4


def test_with_no_line_anywhere_turtles_attempt_is_explained():
    attempts = [("nt", NT_INVALID), ("turtle", "Bad syntax, somewhere")]
    detail = say(attempts, suggested=None)
    assert detail["format"] == "Turtle" and detail["line"] is None
    assert detail["message"] == "The file could not be read as Turtle."


def test_a_suggestion_with_no_attempt_falls_back_to_the_furthest():
    detail = say([("turtle", TURTLE_STRING), ("xml", XML_SYNTAX)], suggested="nquads")
    assert detail["format"] == "Turtle" and detail["line"] == 2


# ---------------------------------------------------------------------------
# Not RDF at all
# ---------------------------------------------------------------------------


def test_a_file_with_no_sign_of_rdf_is_said_to_be_no_rdf():
    attempts = [("turtle", TURTLE_OTHER), ("xml", XML_SYNTAX), ("nt", NT_INVALID)]
    detail = say(attempts, suggested="turtle", head=b"name,age\nAlice,30\n", filename="people.ttl")
    assert detail["message"] == NOT_RDF
    assert detail["line"] is None and detail["format"] is None
    assert detail["technical"] == "raw"


@pytest.mark.parametrize("name", ["people.csv", "people.xlsx", "PEOPLE.XLS"])
def test_a_table_is_told_where_tables_go(name):
    attempts = [("turtle", TURTLE_OTHER)]
    detail = say(attempts, head=b"name,age\nAlice,30\n", filename=name)
    assert detail["message"] == f"{NOT_RDF} {TABLE_HINT}"
    assert TABLE_HINT == "To bring in a table, open a project and use its Data tab."


@pytest.mark.parametrize("sign", [b"@prefix", b"PREFIX", b"<", b"{", b"_:"])
def test_any_sign_of_rdf_keeps_the_parsers_sentence(sign):
    detail = say([("turtle", TURTLE_OTHER)], suggested="turtle", head=b"junk " + sign + b" junk")
    assert detail["message"] == "The file could not be read as Turtle, line 1."


def test_a_known_message_is_itself_a_sign_of_rdf():
    # no-prefix.ttl has no "<" and no "@prefix": its fault is exactly that.
    detail = say([("turtle", TURTLE_PREFIX), ("xml", XML_SYNTAX)], suggested="turtle",
                 head=b"ex:a a ex:Thing .\n")
    assert detail["message"].startswith("Line 1: the prefix ex: is used but never declared.")


def test_a_parser_past_line_one_keeps_the_parsers_sentence():
    detail = say([("turtle", TURTLE_STRING)], suggested="turtle", head=b"no signs here\nat all\n")
    assert detail["line"] == 2 and detail["message"] != NOT_RDF


def test_only_the_first_kilobyte_is_looked_at():
    head = b"a" * 1024 + b"@prefix"
    assert say([("turtle", TURTLE_OTHER)], head=head)["message"] == NOT_RDF


def test_a_binary_file_is_no_rdf_whatever_its_bytes():
    # A workbook is a zip: stray newlines and "<" bytes are noise, not RDF.
    head = b"PK\x03\x04\x14\x00\x06\x00<\n\n\n{"
    attempts = [("turtle", "at line 4 of <>:\nBad syntax (expected directive or statement)")]
    detail = say(attempts, head=head, filename="people.xlsx")
    assert detail["message"] == f"{NOT_RDF} {TABLE_HINT}"


# ---------------------------------------------------------------------------
# Format names and content types
# ---------------------------------------------------------------------------


def test_format_names_match_the_status_bar():
    words = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "statusWords.ts").read_text(encoding="utf-8")
    table = words[words.index("const FORMAT_NAMES"):]
    table = table[: table.index("};")]
    frontend = dict(re.findall(r'^\s*"?([\w-]+)"?: "([^"]+)",', table, re.M))
    assert frontend, "statusWords.ts's table was not found"
    assert frontend == parse_errors.FORMAT_NAMES
    assert parse_errors.format_name("hext") == "hext"


def test_a_content_type_names_a_format():
    assert parse_errors.format_from_content_type("text/turtle; charset=utf-8") == "turtle"
    assert parse_errors.format_from_content_type("application/ld+json") == "json-ld"
    assert parse_errors.format_from_content_type("text/plain") is None
    assert parse_errors.format_from_content_type(None) is None


def test_a_refusal_with_no_attempts_keeps_its_own_sentence():
    detail = explain([], None, head=b"", filename="x.ttl",
                     technical="This address is on a private network.")
    assert detail == {"code": "parse_error", "message": "This address is on a private network.",
                      "line": None, "format": None, "technical": None}


# ---------------------------------------------------------------------------
# ParseError keeps its attempts
# ---------------------------------------------------------------------------


def test_parse_error_keeps_every_attempt_and_the_suggestion():
    with pytest.raises(ParseError) as caught:
        parse_rdf(FILES["missing-dot.ttl"], "turtle")
    error = caught.value
    assert error.suggested == "turtle"
    assert [fmt for fmt, _ in error.attempts] == ["turtle", "xml", "json-ld", "nt", "trig"]
    # str() is the text the route answered before, untouched.
    assert str(error) == "Could not parse the file as RDF. Attempts:\n" + "\n".join(
        f"{fmt}: {message}" for fmt, message in error.attempts
    )


# ---------------------------------------------------------------------------
# The seven files, through the API (AC-1, AC-2)
# ---------------------------------------------------------------------------


def upload(name: str):
    return client.post("/api/ontologies/upload", files={"file": (name, io.BytesIO(FILES[name]), "text/plain")})


@pytest.mark.parametrize("name", list(EXPECTED))
def test_the_seven_files_say_what_the_spec_says(name):
    response = upload(name)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    sentence, line, fmt = EXPECTED[name]
    assert detail["code"] == "parse_error"
    assert detail["message"] == sentence
    assert detail["line"] == line
    assert detail["format"] == fmt
    # The technical text is today's whole answer, every parser named.
    with pytest.raises(ParseError) as caught:
        from app.store import detect_format
        parse_rdf(FILES[name], detect_format(name))
    assert detail["technical"] == str(caught.value)
    assert detail["technical"].startswith("Could not parse the file as RDF. Attempts:\n")


def test_the_empty_file_keeps_its_sentence():
    response = upload("empty.ttl")
    assert response.status_code == 400
    assert response.json()["detail"] == "The uploaded file is empty."


@pytest.fixture
def public_fetch(monkeypatch):
    monkeypatch.setattr(
        "app.net_guard.resolve_host", lambda host: [ipaddress.ip_address("93.184.216.34")]
    )

    def serve(body: bytes, content_type: str):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body, headers={"content-type": content_type})
        monkeypatch.setattr(broker, "transport", httpx.MockTransport(handler))
    return serve


def test_the_url_route_answers_the_same_shape(public_fetch):
    public_fetch(FILES["missing-dot.ttl"], "text/turtle")
    response = client.post("/api/ontologies/fetch", json={"url": "https://public.example/missing-dot.ttl"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["message"] == EXPECTED["missing-dot.ttl"][0]
    assert detail["line"] == 3 and detail["format"] == "Turtle"
    assert detail["technical"].startswith("Could not parse the file as RDF. Attempts:\n")


def test_a_nameless_address_is_explained_by_its_content_type(public_fetch):
    # No extension in the name, so the parse sniffs (Turtle first); the server
    # said JSON-LD, and JSON-LD is the attempt explained.
    public_fetch(FILES["broken.jsonld"], "application/ld+json")
    response = client.post("/api/ontologies/fetch", json={"url": "https://public.example/data"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["format"] == "JSON-LD"
    assert detail["message"] == "Line 1: the JSON is not valid."
