"""
================================================================================
FILE: backend/tests/test_sparql_service.py
================================================================================

SUMMARY
    Proves SPARQL SERVICE runs isolated (external-access Stage 3, backlog Q-10,
    decision D-069): every block is listed and checked before any request, no
    grant means a 409 carrying the exact text and zero requests, a granted call
    carries exactly that text and nothing local, each distinct block is one
    call however many local rows there are, every call is capped, SILENT turns
    a failure into the join identity, and the handler that makes all of this
    true is installed -- with the mutation that removes it shown to leak.

BASIC IDEA
    A recording HTTP server on 127.0.0.1 plays the endpoint, with conftest's
    `loopback_is_public` making exactly that address count as public. The
    decisive assertions are on what the recorder saw -- how many requests,
    and the bytes of each body -- never on a status code alone, which would
    also pass against an application that sent the query and threw the
    answer away.

    The local ontology holds two markers, a literal and an IRI, that appear
    nowhere in any query. rdflib's native SERVICE sends local bindings as a
    VALUES clause, so a marker in a recorded request is proof that local data
    left; the mutation test removes the handler and shows exactly that.

INPUTS / INPUT SOURCES
    - Inline Turtle fixtures, uploaded through the HTTP layer.
    - conftest.py's `http_server` and `loopback_is_public` fixtures.

EXPECTED OUTPUT
    - Pass/fail per acceptance criterion AC-26 to AC-33.
================================================================================
"""

import json
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote_plus

import httpx
import pytest
from fastapi.testclient import TestClient
from rdflib.plugins.sparql import CUSTOM_EVALS

from app import sparql_exec, sparql_service
from app.main import app
from app.network_broker import FetchFailed, broker
from app.sparql_service import (
    HANDLER_KEY,
    MAX_SERVICE_BLOCKS,
    NESTED_DETAIL,
    NOT_PUBLIC_DETAIL,
    TOO_MANY_BLOCKS_DETAIL,
    VARIABLE_ENDPOINT_DETAIL,
    evaluate_service,
)
from app.store import default_data_dir

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/"
MARKER_LITERAL = "MARKER-LITERAL-7f3a91"
MARKER_IRI = "http://example.org/private/MARKER-IRI-9c1e44"
REMOTE_ONLY = "REMOTE-ONLY-VALUE-5b20d8"
LOCAL_ROWS = 100


def _turtle() -> str:
    lines = [
        "@prefix ex: <http://example.org/> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        f'<{MARKER_IRI}> a ex:Item ; rdfs:label "{MARKER_LITERAL}" .',
    ]
    # LOCAL_ROWS - 1 more items, so the local side has LOCAL_ROWS rows.
    for i in range(1, LOCAL_ROWS):
        lines.append(f'ex:item{i} a ex:Item ; rdfs:label "item {i}" .')
    return "\n".join(lines) + "\n"


@pytest.fixture(scope="module")
def ontology_id() -> str:
    response = client.post(
        "/api/ontologies/upload",
        files={"file": ("service-fixture.ttl", _turtle().encode(), "text/turtle")},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _bindings_for_every_item(extra: int = 0) -> bytes:
    """A SPARQL JSON answer naming every local item, so the join has work."""
    items = [MARKER_IRI] + [f"{EX}item{i}" for i in range(1, LOCAL_ROWS)]
    rows = [
        {"s": {"type": "uri", "value": iri},
         "n": {"type": "literal", "value": f"{REMOTE_ONLY} {k}"}}
        for k, iri in enumerate(items)
    ]
    rows += [
        {"s": {"type": "uri", "value": f"{EX}remoteOnly{k}"},
         "n": {"type": "literal", "value": "unjoined"}}
        for k in range(extra)
    ]
    return json.dumps({"head": {"vars": ["s", "n"]}, "results": {"bindings": rows}}).encode()


def _json_route(body: bytes, status: int = 200, delay: float = 0.0):
    def route(_path):
        if delay:
            time.sleep(delay)
        return status, {"Content-Type": "application/sparql-results+json"}, body
    return route


@pytest.fixture
def endpoint(http_server, loopback_is_public):
    """A recording endpoint answering with every item. Returns (url, server)."""
    server = http_server(_json_route(_bindings_for_every_item()))
    return f"http://127.0.0.1:{server.server_address[1]}/sparql", server


def _allow(host: str = "127.0.0.1") -> None:
    broker.policy.grant("sparql:service", host, "allow", remember=True)


def _run(oid: str, query: str, headers=None):
    return client.post(f"/api/ontologies/{oid}/sparql", json={"query": query}, headers=headers or {})


def _join_query(url: str, shape: str = "join") -> str:
    service = f"SERVICE <{url}> {{ ?s ex:name ?n }}"
    if shape == "optional":
        service = f"OPTIONAL {{ {service} }}"
    return (
        "PREFIX ex: <http://example.org/>\n"
        "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n"
        f"SELECT ?s ?label ?n WHERE {{\n  ?s a ex:Item ; rdfs:label ?label .\n  {service}\n}}"
    )


EXPECTED_TEXT = "PREFIX ex: <http://example.org/>\nSELECT * WHERE {\n  ?s ex:name ?n\n}"


def _sent_query(body: bytes) -> str:
    """The query a recorded POST carried, from its only form field."""
    fields = parse_qs(body.decode("ascii"), strict_parsing=True)
    assert list(fields) == ["query"], fields
    assert len(fields["query"]) == 1
    return fields["query"][0]


def _leaks(server) -> bool:
    """True if any recorded request carried local data or a VALUES clause."""
    for path, body in zip(server.requests, server.bodies):
        seen = unquote_plus(path) + unquote_plus(body.decode("latin-1"))
        if MARKER_LITERAL in seen or MARKER_IRI in seen or "VALUES" in seen:
            return True
    return False


# ---------------------------------------------------------------------------
# AC-26. Every block is listed before any request, and the unsupported shapes
# are refused with a sentence.
# ---------------------------------------------------------------------------


def test_endpoints_and_texts_are_listed_before_any_request(endpoint):
    url, server = endpoint
    other = "https://other.example.org/sparql"
    query = (
        "PREFIX ex: <http://example.org/>\n"
        "PREFIX private: <http://corp.example.org/secret#>\n"
        "SELECT * WHERE {\n"
        "  ?s a private:Thing .\n"
        f"  SERVICE <{url}> {{ ?s ex:name ?n }}\n"
        f"  OPTIONAL {{ SERVICE SILENT <{other}> {{ ?s ?p ?o }} }}\n"
        f"  FILTER EXISTS {{ SERVICE <{url}> {{ ?s ex:name ?n }} }}\n"
        "}"
    )
    _prepared, plan = sparql_exec._prepare(query)
    # Text order, the repeated block counted once.
    assert [b.endpoint for b in plan.blocks] == [url, other]
    assert plan.blocks[0].text == EXPECTED_TEXT
    # A prefix the block does not use is not sent: the local part's private
    # namespace stays here.
    assert "corp.example.org" not in plan.blocks[0].text
    assert plan.blocks[1].text == "SELECT * WHERE {\n  ?s ?p ?o\n}"
    assert sorted(silent for _b, silent in plan.by_node.values()) == [False, False, True]
    assert server.requests == []


def test_variable_endpoint_is_refused(ontology_id, endpoint):
    _url, server = endpoint
    response = _run(ontology_id, "SELECT * WHERE { BIND(<http://x.org/> AS ?e) SERVICE ?e { ?a ?b ?c } }")
    assert server.requests == []
    assert response.status_code == 400
    assert response.json()["detail"] == VARIABLE_ENDPOINT_DETAIL


def test_more_than_five_distinct_blocks_is_refused(ontology_id, endpoint):
    url, server = endpoint
    blocks = " ".join(f"SERVICE <{url}?b={i}> {{ ?s ?p ?o }}" for i in range(MAX_SERVICE_BLOCKS + 1))
    response = _run(ontology_id, f"SELECT * WHERE {{ {blocks} }}")
    assert server.requests == []
    assert response.status_code == 400
    assert response.json()["detail"] == TOO_MANY_BLOCKS_DETAIL

    # Five is allowed: the run goes on to ask about them.
    five = " ".join(f"SERVICE <{url}?b={i}> {{ ?s ?p ?o }}" for i in range(MAX_SERVICE_BLOCKS))
    response = _run(ontology_id, f"SELECT * WHERE {{ {five} }}")
    assert response.status_code == 409
    assert len(response.json()["detail"]["requests"]) == MAX_SERVICE_BLOCKS
    assert server.requests == []


def test_the_same_block_repeated_is_one_block(ontology_id, endpoint):
    url, _server = endpoint
    blocks = " ".join(f"SERVICE <{url}> {{ ?s ?p ?o }}" for _ in range(MAX_SERVICE_BLOCKS + 3))
    _prepared, plan = sparql_exec._prepare(f"SELECT * WHERE {{ {blocks} }}")
    assert len(plan.blocks) == 1


def test_non_public_and_non_http_endpoints_are_refused_by_name(ontology_id, http_server):
    # No loopback_is_public here: 127.0.0.1 is what it really is.
    server = http_server(_json_route(_bindings_for_every_item()))
    for url in (
        f"http://127.0.0.1:{server.server_address[1]}/sparql",
        "http://localhost/sparql",
        "http://169.254.169.254/latest",
        "file:///etc/passwd",
    ):
        response = _run(ontology_id, f"SELECT * WHERE {{ SERVICE <{url}> {{ ?s ?p ?o }} }}")
        assert response.status_code == 400, url
        assert response.json()["detail"] == NOT_PUBLIC_DETAIL.format(endpoint=url)
    assert server.requests == []


def test_nested_service_is_refused_with_a_sentence(ontology_id, endpoint):
    url, server = endpoint
    query = f"SELECT * WHERE {{ SERVICE <{url}> {{ SERVICE <{url}> {{ ?s ?p ?o }} }} }}"
    response = _run(ontology_id, query)
    assert server.requests == []
    assert response.status_code == 400
    assert response.json()["detail"] == NESTED_DETAIL


def test_the_word_service_in_strings_and_comments_is_not_a_block(endpoint):
    url, _server = endpoint
    query = (
        "PREFIX ex: <http://example.org/>\n"
        "SELECT * WHERE {\n"
        f"  SERVICE <{url}> # the {{ in this comment is not the block\n"
        '  { ?s ex:name ?n FILTER(?n != "SERVICE <http://x.org/> { }") }\n'
        '  BIND("SERVICE <http://y.org/> { ?a ?b ?c }" AS ?decoy)\n'
        "}"
    )
    _prepared, plan = sparql_exec._prepare(query)
    assert [b.endpoint for b in plan.blocks] == [url]
    assert plan.blocks[0].text == (
        "PREFIX ex: <http://example.org/>\nSELECT * WHERE {\n"
        '  ?s ex:name ?n FILTER(?n != "SERVICE <http://x.org/> { }")\n}'
    )


def test_two_blocks_each_send_their_own_text(endpoint):
    """rdflib's own service_string gives every block the first block's text;
    the plan must not."""
    url, _server = endpoint
    query = (
        f"SELECT * WHERE {{ SERVICE <{url}?one> {{ ?a ?b ?c }} "
        f"SERVICE <{url}?two> {{ ?x ?y ?z }} }}"
    )
    _prepared, plan = sparql_exec._prepare(query)
    assert [b.text for b in plan.blocks] == [
        "SELECT * WHERE {\n  ?a ?b ?c\n}",
        "SELECT * WHERE {\n  ?x ?y ?z\n}",
    ]


# ---------------------------------------------------------------------------
# AC-27. No grant: 409 with the exact text, and nothing sent.
# ---------------------------------------------------------------------------


def test_no_grant_returns_409_with_the_exact_text_and_sends_nothing(ontology_id, endpoint):
    url, server = endpoint
    response = _run(ontology_id, _join_query(url))
    # The decisive assertion first.
    assert server.requests == []
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "approval_required"
    [request] = detail["requests"]
    assert request["capability"] == "sparql:service"
    assert request["host"] == "127.0.0.1"
    assert request["url"] == url
    assert request["text"] == EXPECTED_TEXT


def test_just_once_grant_runs_once_and_then_asks_again(ontology_id, endpoint):
    url, server = endpoint
    assert _run(ontology_id, _join_query(url)).status_code == 409
    grant = client.post(
        "/api/network/grants",
        json={"capability": "sparql:service", "host": "127.0.0.1", "decision": "allow", "remember": False},
    ).json()
    retried = _run(ontology_id, _join_query(url), headers={"X-Semantic-Studio-Grant": grant["id"]})
    assert retried.status_code == 200, retried.text
    assert len(server.requests) == 1
    # Spent by the retry: the next run asks again and sends nothing more.
    assert _run(ontology_id, _join_query(url)).status_code == 409
    assert len(server.requests) == 1


# ---------------------------------------------------------------------------
# AC-28 and AC-31. Exactly the approved text leaves; the handler is why.
# ---------------------------------------------------------------------------


def test_request_carries_exactly_the_approved_text(ontology_id, endpoint):
    url, server = endpoint
    asked = _run(ontology_id, _join_query(url)).json()["detail"]["requests"][0]["text"]
    _allow()
    response = _run(ontology_id, _join_query(url))
    assert response.status_code == 200, response.text
    [body] = server.bodies
    assert _sent_query(body) == asked == EXPECTED_TEXT
    assert not _leaks(server)
    # And the join happened here: every local row met its remote partner.
    rows = response.json()["rows"]
    assert len(rows) == LOCAL_ROWS
    by_subject = {row[0]["value"]: row for row in rows}
    assert by_subject[MARKER_IRI][1]["value"] == MARKER_LITERAL
    assert by_subject[MARKER_IRI][2]["value"].startswith(REMOTE_ONLY)


def test_handler_is_installed_at_import():
    assert CUSTOM_EVALS.get(HANDLER_KEY) is evaluate_service


def test_mutation_without_the_handler_leaks_local_data(ontology_id, endpoint, monkeypatch):
    """AC-31. Remove the handler and rdflib's native SERVICE runs: the same
    run that sent exactly the approved text now sends local bindings, so the
    assertion in test_request_carries_exactly_the_approved_text would fail."""
    url, server = endpoint
    _allow()
    monkeypatch.delitem(CUSTOM_EVALS, HANDLER_KEY)
    _run(ontology_id, _join_query(url, shape="optional"))
    assert server.requests, "rdflib's native SERVICE made no request at all"
    assert _leaks(server), "without the handler the request should carry local data"


# ---------------------------------------------------------------------------
# AC-29. One call per distinct block per run, whatever the local rows.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("shape", ["join", "optional"])
def test_one_call_per_block(ontology_id, endpoint, shape):
    """The Section 10 row: a count, not a timing. OPTIONAL evaluates the block
    once per local row, which is what rdflib's native code turned into one
    request per row."""
    url, server = endpoint
    _allow()
    response = _run(ontology_id, _join_query(url, shape))
    assert response.status_code == 200, response.text
    assert len(response.json()["rows"]) == LOCAL_ROWS
    assert len(server.requests) == 1


def test_distinct_blocks_are_one_call_each_and_repeats_share_one(ontology_id, endpoint):
    url, server = endpoint
    _allow()
    query = (
        "PREFIX ex: <http://example.org/>\n"
        "SELECT ?s WHERE { ?s a ex:Item .\n"
        f"  OPTIONAL {{ SERVICE <{url}> {{ ?s ex:name ?n }} }}\n"
        f"  OPTIONAL {{ SERVICE <{url}> {{ ?s ex:name ?n }} }}\n"
        f"  OPTIONAL {{ SERVICE <{url}> {{ ?s ex:other ?m }} }}\n"
        "}"
    )
    assert _run(ontology_id, query).status_code == 200
    assert len(server.requests) == 2
    # And a second run is a second run: the memo does not outlive the query.
    assert _run(ontology_id, query).status_code == 200
    assert len(server.requests) == 4


# ---------------------------------------------------------------------------
# AC-30. Caps per call; SILENT.
# ---------------------------------------------------------------------------


def test_cap_values_are_the_specified_ones():
    assert sparql_service.MAX_ROWS_PER_CALL == 10_000
    assert sparql_service.MAX_BYTES_PER_CALL == 10 * 1024 * 1024
    assert sparql_service.CALL_TIMEOUT_SECONDS == 20.0


def test_caps_rows(ontology_id, http_server, loopback_is_public):
    server = http_server(_json_route(_bindings_for_every_item(extra=10_000)))
    url = f"http://127.0.0.1:{server.server_address[1]}/sparql"
    _allow()
    response = _run(ontology_id, f"SELECT * WHERE {{ SERVICE <{url}> {{ ?s ?p ?o }} }}")
    assert response.status_code == 200, response.text
    body = response.json()
    [service] = body["services"]
    assert service["rows"] == 10_000
    assert service["truncated"] is True
    # The whole query keeps its own 1,000-row cap on top (AC-33).
    assert body["rowCount"] == sparql_exec.MAX_ROWS
    assert body["truncated"] is True


def test_caps_bytes(ontology_id, http_server, loopback_is_public, monkeypatch):
    monkeypatch.setattr(sparql_service, "MAX_BYTES_PER_CALL", 4096)
    server = http_server(_json_route(_bindings_for_every_item()))
    url = f"http://127.0.0.1:{server.server_address[1]}/sparql"
    _allow()
    response = _run(ontology_id, f"SELECT * WHERE {{ SERVICE <{url}> {{ ?s ?p ?o }} }}")
    assert response.status_code == 400
    assert "127.0.0.1 sent more than" in response.json()["detail"]


def test_caps_time(ontology_id, http_server, loopback_is_public, monkeypatch):
    monkeypatch.setattr(sparql_service, "CALL_TIMEOUT_SECONDS", 0.5)
    server = http_server(_json_route(_bindings_for_every_item(), delay=3.0))
    url = f"http://127.0.0.1:{server.server_address[1]}/sparql"
    _allow()
    started = time.perf_counter()
    response = _run(ontology_id, f"SELECT * WHERE {{ SERVICE <{url}> {{ ?s ?p ?o }} }}")
    assert time.perf_counter() - started < 2.5
    assert response.status_code == 400
    assert "could not be reached" in response.json()["detail"]


def test_per_call_time_is_wall_clock_not_per_read(loopback_is_public, monkeypatch):
    """A server trickling a byte every 0.2 s never trips a per-read timeout;
    the call's deadline still ends it."""

    def trickle():
        for _ in range(20):
            time.sleep(0.2)
            yield b" "

    monkeypatch.setattr(
        broker, "transport",
        httpx.MockTransport(lambda _req: httpx.Response(200, content=trickle())),
    )
    _allow()
    started = time.perf_counter()
    with pytest.raises(FetchFailed):
        broker.request(
            "sparql:service", "http://127.0.0.1:9/sparql", reason="test", method="POST",
            body=b"query=x", max_bytes=1024, timeout=1.0, total_timeout=0.5,
        )
    assert time.perf_counter() - started < 1.5


def test_silent_failure_is_the_join_identity(ontology_id, http_server, loopback_is_public):
    server = http_server(_json_route(b"broken", status=500))
    url = f"http://127.0.0.1:{server.server_address[1]}/sparql"
    _allow()
    query = _join_query(url).replace("SERVICE <", "SERVICE SILENT <")
    response = _run(ontology_id, query)
    assert response.status_code == 200, response.text
    body = response.json()
    # Every local row, unchanged, with the service's variable unbound.
    assert body["rowCount"] == LOCAL_ROWS
    assert all(row[2] is None for row in body["rows"])
    [service] = body["services"]
    assert "HTTP 500" in service["error"]
    assert len(server.requests) == 1

    # The same failure without SILENT is an error naming the host.
    response = _run(ontology_id, _join_query(url))
    assert response.status_code == 400
    assert response.json()["detail"] == "127.0.0.1 answered with HTTP 500."


def test_blocked_and_offline(ontology_id, endpoint):
    url, server = endpoint
    broker.policy.grant("sparql:service", "127.0.0.1", "block", remember=True)
    assert _run(ontology_id, _join_query(url)).status_code == 403
    # SILENT turns a refusal into the empty result, and still sends nothing.
    silent = _join_query(url).replace("SERVICE <", "SERVICE SILENT <")
    response = _run(ontology_id, silent)
    assert response.status_code == 200
    assert response.json()["rowCount"] == LOCAL_ROWS

    broker.reset()
    broker.policy.set_offline(True)
    assert _run(ontology_id, _join_query(url)).status_code == 503
    assert server.requests == []


# ---------------------------------------------------------------------------
# AC-32 and AC-33.
# ---------------------------------------------------------------------------


def test_results_name_the_endpoints_and_nothing_is_stored(ontology_id, endpoint):
    url, _server = endpoint
    _allow()
    response = _run(ontology_id, _join_query(url))
    [service] = response.json()["services"]
    assert service["endpoint"] == url
    assert service["host"] == "127.0.0.1"
    assert service["rows"] == LOCAL_ROWS
    assert service["error"] is None
    # No file the server keeps holds a value only the endpoint returned.
    for path in Path(default_data_dir()).rglob("*"):
        if path.is_file():
            assert REMOTE_ONLY.encode() not in path.read_bytes(), path


def test_queries_without_service_report_no_services(ontology_id):
    body = _run(ontology_id, "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1").json()
    assert "services" not in body


def test_select_only_still_holds_with_service(ontology_id, endpoint):
    url, server = endpoint
    _allow()
    response = _run(ontology_id, f"CONSTRUCT {{ ?s ?p ?o }} WHERE {{ SERVICE <{url}> {{ ?s ?p ?o }} }}")
    assert response.status_code == 400
    assert server.requests == []
