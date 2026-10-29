"""
================================================================================
FILE: backend/tests/test_settings.py
================================================================================

SUMMARY
    Settings → Limits on the server (home-and-settings Stage B, D-120): the
    three limits read and saved through /api/settings, applied to the next
    load or graph, held to their ranges, never changed over an environment
    variable, and the route's own guards. AC-7 and AC-8.

BASIC IDEA
    The security claim is that no limit can be loosened past its ceiling or
    around an administrator's variable (Section 9), so each refusal is proved
    by what it leaves, not only by its status: settings.json unwritten and the
    limit in force unchanged. "Applied" is proved by the path itself: a 60 MB
    upload refused at 50 MB and stored at 100 MB, the parse handed the new
    timeout, a graph drawn at the new budget.

    The 60 MB file is mostly comment lines, so it is 60 MB on the wire and in
    the cap's count but parses in a moment: the size is what is under test.

INPUTS / INPUT SOURCES
    - The FastAPI app through TestClient, with the client header.
    - The test data folder conftest.py makes; conftest resets the saved
      limits around every test.
    - N-Triples generated in the test, in example.org.

EXPECTED OUTPUT
    - Pass/fail per assertion. A failure means a limit can be pushed past its
      range, set over an environment variable, or does not reach its path.
================================================================================
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import settings
from app.main import app
from app.store import store

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/settings/"
MB = 1024 * 1024


def _get() -> dict:
    response = client.get("/api/settings")
    assert response.status_code == 200
    return response.json()


def _limit(body: dict, key: str) -> dict:
    return next(item for item in body["limits"] if item["key"] == key)


def _put(limits) -> "object":
    return client.put("/api/settings", json={"limits": limits})


def _file() -> Path:
    return store.data_dir / "settings.json"


def _padded_ntriples(size: int) -> bytes:
    """`size` bytes of N-Triples: three statements and comment lines."""
    head = "".join(
        f"<{EX}C{i}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
        f"<http://www.w3.org/2002/07/owl#Class> .\n"
        for i in range(3)
    ).encode()
    line = b"# " + b"x" * 1021 + b"\n"
    body = head + line * ((size - len(head)) // len(line) + 1)
    return body[:size - 1] + b"\n"


def _upload(data: bytes, name: str = "big.nt"):
    return client.post(
        "/api/ontologies/upload",
        files={"file": (name, data, "application/n-triples")},
    )


# --- GET -----------------------------------------------------------------------


def test_get_gives_the_three_limits_with_their_ranges():
    body = _get()
    assert [item["key"] for item in body["limits"]] == ["largestFile", "readTime", "firstDrawing"]
    assert _limit(body, "largestFile") == {
        "key": "largestFile", "name": "Largest file to load", "unit": "MB",
        "value": 50, "default": 50, "min": 1, "max": 200,
        "source": "default", "variables": [],
    }
    read = _limit(body, "readTime")
    assert (read["value"], read["default"], read["min"], read["max"]) == (60, 60, 10, 600)
    draw = _limit(body, "firstDrawing")
    assert (draw["value"], draw["default"], draw["min"], draw["max"]) == (2000, 2000, 100, 20000)


def test_get_answers_where_the_work_is_kept():
    """AC-6: Library shows the data folder's full path."""
    assert _get()["dataDir"] == str(store.data_dir.resolve())


# --- PUT within range: saved, and applied at once -------------------------------


def test_a_change_is_saved_to_settings_json_in_the_data_folder():
    response = _put({"largestFile": 100, "readTime": 120, "firstDrawing": 5000})
    assert response.status_code == 200
    assert _limit(response.json(), "largestFile")["value"] == 100
    assert _limit(response.json(), "largestFile")["source"] == "settings"
    assert json.loads(_file().read_text(encoding="utf-8")) == {
        "limits": {"largestFile": 100, "readTime": 120, "firstDrawing": 5000}
    }


def test_a_partial_change_keeps_the_others():
    _put({"readTime": 90})
    _put({"firstDrawing": 300})
    body = _get()
    assert _limit(body, "readTime")["value"] == 90
    assert _limit(body, "firstDrawing")["value"] == 300
    assert _limit(body, "largestFile")["source"] == "default"


def test_a_saved_change_survives_a_restart():
    _put({"largestFile": 120})
    settings.configure(store.data_dir)  # drops the memory, as a new process would
    assert settings.upload_bytes() == 120 * MB


def test_a_60_mb_file_is_refused_before_raising_and_loaded_after():
    """AC-7, the path itself: the cap the upload holds to is the saved one."""
    data = _padded_ntriples(60 * MB)
    refused = _upload(data)
    assert refused.status_code == 413
    assert "50 MB limit" in refused.json()["detail"]["message"]

    assert _put({"largestFile": 100}).status_code == 200
    accepted = _upload(data)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["triples"] == 3
    client.delete(f"/api/ontologies/{accepted.json()['id']}")


def test_the_fetch_cap_and_the_context_cap_read_the_saved_value():
    _put({"largestFile": 7})
    assert settings.fetch_bytes() == 7 * MB
    assert settings.upload_bytes() == 7 * MB


def test_the_parse_is_handed_the_saved_timeout(monkeypatch):
    seen = {}
    real_add = store.add

    def spy(**kwargs):
        seen["timeout"] = kwargs["parse_timeout"]
        return real_add(**kwargs)

    monkeypatch.setattr(store, "add", spy)
    _put({"readTime": 15})
    response = _upload(_padded_ntriples(4096), name="small.nt")
    assert response.status_code == 200
    assert seen["timeout"] == 15.0
    client.delete(f"/api/ontologies/{response.json()['id']}")


def test_the_graph_opens_with_the_saved_budget():
    lines = []
    for i in range(400):
        lines.append(f"<{EX}N{i}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
                     f"<http://www.w3.org/2002/07/owl#Class> .")
        if i:
            lines.append(f"<{EX}N{i}> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <{EX}N{i - 1}> .")
    oid = _upload(("\n".join(lines) + "\n").encode(), name="tree.nt").json()["id"]
    try:
        assert _put({"firstDrawing": 150}).status_code == 200
        stats = client.get(f"/api/ontologies/{oid}/graph").json()["stats"]
        assert stats["budget"] == 150 and stats["nodeCount"] == 150
        # Show more still climbs to the fixed ceiling, which is no setting.
        stats = client.get(f"/api/ontologies/{oid}/graph", params={"limit": 99999}).json()["stats"]
        assert stats["budget"] == 20000
    finally:
        client.delete(f"/api/ontologies/{oid}")


# --- out of range: 422 with the range, nothing written ---------------------------


@pytest.mark.parametrize(
    "key,value",
    [
        ("largestFile", 0), ("largestFile", 201), ("largestFile", -5),
        ("largestFile", 10 ** 12), ("largestFile", 50.5), ("largestFile", "100"),
        ("largestFile", True), ("largestFile", None),
        ("readTime", 9), ("readTime", 601), ("readTime", 1e9),
        ("firstDrawing", 99), ("firstDrawing", 20001),
    ],
)
def test_out_of_range_is_422_with_the_range_and_writes_nothing(key, value):
    """AC-8: a limit cannot be set past its ceiling, below its floor, or removed."""
    before = (settings.upload_bytes(), settings.parse_timeout(), settings.graph_budget())
    response = _put({key: value})
    assert response.status_code == 422
    detail = response.json()["detail"]
    limit = settings.LIMITS[key]
    assert detail["code"] == "out_of_range" and detail["key"] == key
    assert (detail["min"], detail["max"]) == (limit.minimum, limit.maximum)
    assert f"from {limit.minimum:,} to {limit.maximum:,}" in detail["message"]
    assert not _file().exists()
    assert (settings.upload_bytes(), settings.parse_timeout(), settings.graph_budget()) == before


def test_one_bad_value_keeps_the_good_ones_out_too():
    assert _put({"readTime": 120, "largestFile": 500}).status_code == 422
    assert settings.parse_timeout() == 60.0
    assert not _file().exists()


@pytest.mark.parametrize(
    "body",
    [
        {"limits": {"queryRows": 5000}},
        {"limits": {"queryTimeout": 300}},
        {"limits": {"maxGraphNodeBudget": 100000}},
        {"limits": []},
        {"limits": None},
        {},
        [],
        "largestFile",
    ],
)
def test_anything_but_the_three_limits_is_refused(body):
    """AC-8: the query limits are no setting, nor is the graph's ceiling."""
    response = client.put("/api/settings", json=body)
    assert response.status_code == 422
    assert not _file().exists()


def test_the_query_limits_are_not_offered():
    keys = {item["key"] for item in _get()["limits"]}
    assert keys == {"largestFile", "readTime", "firstDrawing"}


# --- an environment variable wins: read-only, 409 --------------------------------


@pytest.mark.parametrize(
    "variable,key,value,shown",
    [
        ("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", "largestFile", str(300 * MB), 300),
        ("SEMANTIC_STUDIO_MAX_FETCH_BYTES", "largestFile", str(2 * MB), 2),
        ("SEMANTIC_STUDIO_PARSE_TIMEOUT", "readTime", "900", 900),
        ("SEMANTIC_STUDIO_GRAPH_NODE_BUDGET", "firstDrawing", "500", 500),
    ],
)
def test_a_limit_set_by_its_variable_is_read_only(monkeypatch, variable, key, value, shown):
    """AC-7: shown with the variable's value, which no range holds, and 409."""
    monkeypatch.setenv(variable, value)
    item = _limit(_get(), key)
    assert item["source"] == "environment"
    assert item["variables"] == [variable]
    assert item["value"] == shown
    limit = settings.LIMITS[key]
    for attempt in (limit.default, limit.minimum, limit.maximum):
        response = _put({key: attempt})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "set_by_environment"
        assert variable in response.json()["detail"]["message"]
    assert not _file().exists()
    assert _limit(_get(), key)["value"] == shown


def test_the_other_limits_stay_settable_beside_a_variable(monkeypatch):
    monkeypatch.setenv("SEMANTIC_STUDIO_PARSE_TIMEOUT", "900")
    assert _put({"firstDrawing": 400}).status_code == 200
    assert settings.graph_budget() == 400
    assert _put({"firstDrawing": 400, "readTime": 60}).status_code == 409
    assert settings.parse_timeout() == 900.0


def test_each_path_keeps_its_own_variable(monkeypatch):
    """5.4: either variable makes Largest file read-only, and the page's
    value governs only the path whose variable is not set."""
    assert _put({"largestFile": 100}).status_code == 200
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", str(2 * MB))
    assert settings.upload_bytes() == 2 * MB
    assert settings.fetch_bytes() == 100 * MB
    item = _limit(_get(), "largestFile")
    assert item["source"] == "environment" and item["variables"] == ["SEMANTIC_STUDIO_MAX_UPLOAD_BYTES"]

    monkeypatch.delenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES")
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_FETCH_BYTES", str(3 * MB))
    assert settings.upload_bytes() == 100 * MB
    assert settings.fetch_bytes() == 3 * MB

    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", str(2 * MB))
    assert _limit(_get(), "largestFile")["variables"] == [
        "SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", "SEMANTIC_STUDIO_MAX_FETCH_BYTES",
    ]
    assert _put({"largestFile": 50}).status_code == 409


def test_a_nonsense_variable_still_owns_its_limit(monkeypatch):
    """Set but unreadable keeps the old fallback, the default, and the page
    still cannot write over it: the administrator meant to set something."""
    _put({"readTime": 300})
    monkeypatch.setenv("SEMANTIC_STUDIO_PARSE_TIMEOUT", "soon")
    assert settings.parse_timeout() == 60.0
    assert _put({"readTime": 600}).status_code == 409


def test_a_variable_set_upload_is_still_refused_at_its_own_number(monkeypatch):
    """The page's 100 MB does not reach an upload the variable holds to 1 MB."""
    _put({"largestFile": 100})
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", str(1 * MB))
    assert _upload(_padded_ntriples(2 * MB)).status_code == 413


# --- the route's own guards ---------------------------------------------------


def test_the_put_needs_the_client_header():
    bare = TestClient(app, base_url="http://localhost")
    response = bare.put("/api/settings", json={"limits": {"largestFile": 200}})
    assert response.status_code == 403
    assert not _file().exists()


def test_a_foreign_origin_cannot_change_a_limit():
    response = client.put(
        "/api/settings", json={"limits": {"largestFile": 200}},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert not _file().exists()


def test_a_declared_body_past_16_kb_is_refused():
    padding = "x" * (17 * 1024)
    response = client.put(
        "/api/settings", json={"limits": {"readTime": 120}, "padding": padding},
    )
    assert response.status_code == 413
    assert not _file().exists()


def test_an_undeclared_body_past_16_kb_is_refused_while_reading():
    def body():
        yield b'{"limits": {"readTime": 120}, "padding": "'
        for _ in range(64):
            yield b"x" * 1024
        yield b'"}'

    response = client.put(
        "/api/settings", content=body(), headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "A settings change is at most 16 KB."
    assert not _file().exists()


# --- a damaged settings.json falls back on the defaults -----------------------------


@pytest.mark.parametrize(
    "text",
    [
        "{ not json",
        "",
        "[]",
        '{"limits": [1, 2, 3]}',
        '{"limits": {"largestFile": 100000, "readTime": 0, "firstDrawing": "lots"}}',
        '{"limits": {"largestFile": true}}',
        "\x00\x01\x02",
    ],
)
def test_a_damaged_file_falls_back_on_the_defaults(text):
    """A hand edit gets the PUT's range check: never no limit, never past one."""
    _file().write_text(text, encoding="utf-8")
    settings.configure(store.data_dir)
    assert settings.upload_bytes() == 50 * MB
    assert settings.fetch_bytes() == 50 * MB
    assert settings.parse_timeout() == 60.0
    assert settings.graph_budget() == 2000
    body = _get()
    assert all(item["source"] == "default" for item in body["limits"])
    # And the page can save over it.
    assert _put({"readTime": 30}).status_code == 200
    assert settings.parse_timeout() == 30.0


def test_a_file_keeps_its_good_values_beside_a_bad_one():
    _file().write_text('{"limits": {"largestFile": 100, "readTime": 100000}}', encoding="utf-8")
    settings.configure(store.data_dir)
    assert settings.upload_bytes() == 100 * MB
    assert settings.parse_timeout() == 60.0


# --- the load-bearing rule: read at call time, from one module ----------------------


def test_only_settings_reads_the_limit_variables():
    """Every read of the three limits goes through settings.py at call time
    (5.4). A module-level copy anywhere else would be read once at import
    and miss every change saved since."""
    app_dir = Path(settings.__file__).parent
    names = re.compile(
        r"SEMANTIC_STUDIO_(MAX_UPLOAD_BYTES|MAX_FETCH_BYTES|PARSE_TIMEOUT|GRAPH_NODE_BUDGET)"
    )
    scanned = list(app_dir.rglob("*.py"))
    assert len(scanned) > 40  # the scan found the source tree
    offenders = [
        str(path.relative_to(app_dir))
        for path in scanned
        if path.name != "settings.py" or path.parent != app_dir
        if names.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []
    old_constants = re.compile(
        r"^(MAX_UPLOAD_BYTES|MAX_FETCH_BYTES|PARSE_TIMEOUT_SECONDS|DEFAULT_GRAPH_NODE_BUDGET)\s*=",
        re.M,
    )
    assert [p.name for p in scanned if old_constants.search(p.read_text(encoding="utf-8"))] == []


# --- code review fixes ------------------------------------------------------------


def test_a_value_equal_to_its_default_is_not_kept():
    """Reset to defaults then Save means the default, not a pinned copy of it."""
    _put({"readTime": 300, "firstDrawing": 500})
    body = _put({"readTime": 60}).json()
    assert _limit(body, "readTime")["source"] == "default"
    assert json.loads(_file().read_text(encoding="utf-8")) == {"limits": {"firstDrawing": 500}}


def test_both_caps_are_shown_when_one_size_variable_leaves_them_apart(monkeypatch):
    """A read-only line showing only the variable's number would hide the
    other path's cap, which the page saved and can no longer change."""
    _put({"largestFile": 1})
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", str(300 * MB))
    item = _limit(_get(), "largestFile")
    assert item["byPath"] == {"upload": 300, "fetch": 1}
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_FETCH_BYTES", str(300 * MB))
    assert "byPath" not in _limit(_get(), "largestFile")


def test_the_refusal_names_the_administrator_only_for_its_own_variable(monkeypatch):
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_FETCH_BYTES", str(100 * MB))
    detail = settings.too_large_detail(50 * MB, "upload")
    assert detail["message"] == "This file is larger than the 50 MB limit. Only the administrator can change it."
    assert detail["settable"] is False
    detail = settings.too_large_detail(100 * MB, "fetch")
    assert detail["message"] == "This file is larger than the 100 MB limit, which the administrator set."


def test_an_odd_byte_count_never_reads_as_0_mb(monkeypatch):
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_UPLOAD_BYTES", "4000")
    assert settings.too_large_detail(4000)["message"].startswith("This file is larger than the 0.0038 MB limit")
    assert _limit(_get(), "largestFile")["value"] == 0.0038


def test_the_turtle_editors_timeout_says_where_to_raise_it(monkeypatch):
    """The editor's apply is held to the same read time, so its sentence
    says the same: where to raise it, or that the administrator set it."""
    from app.editing import parse_turtle
    from app.store import ParseTimeout

    text = "".join(f'<{EX}s{i}> <{EX}p> "{i}" .\n' for i in range(20_000))
    with pytest.raises(ParseTimeout) as caught:
        parse_turtle(text, 0.001)
    assert str(caught.value).endswith("seconds to parse and was stopped. You can raise the limit in Settings → Limits.")
    monkeypatch.setenv("SEMANTIC_STUDIO_PARSE_TIMEOUT", "30")
    with pytest.raises(ParseTimeout) as caught:
        parse_turtle(text, 0.001)
    assert str(caught.value).endswith("The administrator set this limit.")
