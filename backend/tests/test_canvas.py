"""
================================================================================
FILE: backend/tests/test_canvas.py
================================================================================

SUMMARY
    The modeling canvas's server half (visual-modeling Stage 2): the canvas
    view -- boxes and lines of each kind, imported boxes, the undrawn list, the
    language fallback, the shown set past 300 boxes, the revision cache -- and
    the layout file: validation, the size refusal declared and while reading,
    a rename moving the entry through undo and redo, pruning on open, the
    export, and that a layout is never a change to the model. Two Section 10
    budgets.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, on small-template
    projects extended with Turtle applies. Scale fixtures are generated, never
    committed (rdf-fixture). "Not a model change" is asserted as an unmoved
    revision, a clean document and an unchanged undo label.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-10 (the server half), AC-11, AC-13 and AC-15, and the
      two backend budgets of Section 10.
================================================================================
"""

from __future__ import annotations

import gc
import io
import json
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import canvas as canvas_mod
from app.editing import editing_service, project_store
from app.main import app

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
"""

MODEL = PREFIXES + """
shop:Document a owl:Class ; rdfs:label "Document"@en , "Document"@fr .
shop:Invoice a owl:Class ; rdfs:label "Invoice"@en ; rdfs:subClassOf shop:Document .
shop:Customer a owl:Class ; rdfs:label "Customer"@en ; rdfs:subClassOf foaf:Agent .
shop:total a owl:DatatypeProperty ; rdfs:label "total"@en ; rdfs:domain shop:Invoice ; rdfs:range xsd:decimal .
shop:note a owl:DatatypeProperty ; rdfs:label "note"@en .
shop:billedTo a owl:ObjectProperty ; rdfs:label "billed to"@en ; rdfs:domain shop:Invoice ; rdfs:range shop:Customer .
shop:mentions a owl:ObjectProperty ; rdfs:label "mentions"@en ; rdfs:domain shop:Invoice .
shop:Status a skos:Concept ; skos:prefLabel "Status"@en .
shop:Paid a skos:Concept ; skos:prefLabel "Paid"@en ; skos:broader shop:Status .
shop:Late a skos:Concept ; skos:prefLabel "Late"@en .
shop:Status skos:narrower shop:Late .
"""


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _project(text: str = MODEL, languages=("fr",)) -> str:
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": "small", "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    if languages:
        client.patch(f"/api/projects/{pid}", json={"languages": list(languages)})
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    assert client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text}).status_code == 200
    return pid


@pytest.fixture
def pid() -> str:
    return _project()


def canvas(pid: str, **params) -> dict:
    response = client.get(f"/api/projects/{pid}/documents/model/canvas", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def put_layout(pid: str, layout, **kw):
    return client.put(f"/api/projects/{pid}/documents/model/layout", json=layout, **kw)


def run(pid: str, command: str, **args) -> dict:
    response = client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": command, "args": args})
    assert response.status_code == 200, response.text
    return response.json()


def state(pid: str) -> dict:
    return editing_service.document(pid, "model").state()


# --- AC-11: what is drawn ---------------------------------------------------------------


def test_boxes_are_the_document_classes_and_concepts_with_attributes(pid):
    view = canvas(pid)
    by = {n["iri"]: n for n in view["nodes"]}
    assert {i for i, n in by.items() if "imported" not in n} == {
        EX + x for x in ("Document", "Invoice", "Customer", "Status", "Paid", "Late")
    }
    assert by[EX + "Invoice"]["kind"] == "class" and by[EX + "Paid"]["kind"] == "concept"
    assert by[EX + "Invoice"]["attributes"] == [{"iri": EX + "total", "label": "total", "datatype": "xsd:decimal"}]
    assert view["total"] == 6


def test_lines_for_subclass_relationships_and_broader_in_both_spellings(pid):
    edges = {(e["kind"], e["source"], e["target"], e.get("label")) for e in canvas(pid)["edges"]}
    assert ("subClassOf", EX + "Invoice", EX + "Document", None) in edges
    assert ("relationship", EX + "Invoice", EX + "Customer", "billed to") in edges
    assert ("broader", EX + "Paid", EX + "Status", None) in edges
    # skos:narrower is drawn as the broader it implies.
    assert ("broader", EX + "Late", EX + "Status", None) in edges


def test_a_link_outside_the_document_draws_a_read_only_box(pid):
    by = {n["iri"]: n for n in canvas(pid)["nodes"]}
    agent = by["http://xmlns.com/foaf/0.1/Agent"]
    assert agent["kind"] == "class" and agent["imported"] == "outside"
    # A datatype is a range, not a box.
    assert not any(n["iri"].startswith("http://www.w3.org/2001/XMLSchema#") for n in by.values())


def test_relationships_and_attributes_without_both_ends_are_listed_not_drawn(pid):
    view = canvas(pid)
    assert {(u["label"], u["missing"]) for u in view["undrawn"]} == {("note", "domain"), ("mentions", "range")}
    assert not any(e.get("label") == "mentions" for e in view["edges"])
    mentions = next(u for u in view["undrawn"] if u["label"] == "mentions")
    assert mentions["domain"] == EX + "Invoice" and mentions["range"] is None


def test_a_missing_name_falls_back_to_the_primary_one_marked(pid):
    by = {n["iri"]: n for n in canvas(pid, lang="fr")["nodes"]}
    assert by[EX + "Document"]["label"] == "Document" and by[EX + "Document"]["fallback"] is False
    assert by[EX + "Invoice"]["label"] == "Invoice (en)" and by[EX + "Invoice"]["fallback"] is True


def test_the_view_is_cached_by_revision_and_rebuilt_after_a_command(pid, monkeypatch):
    builds = []
    real = canvas_mod.build_canvas

    def counting(*a, **k):
        builds.append(1)
        return real(*a, **k)

    monkeypatch.setattr("app.editing.build_canvas", counting)
    first = canvas(pid)
    canvas(pid)
    put_layout(pid, {"positions": {EX + "Invoice": [10, 20]}})
    canvas(pid)
    assert len(builds) == 1, "the same revision, and a layout write, reuse the view"
    run(pid, "CreateClass", label="Receipt")
    second = canvas(pid)
    assert len(builds) == 2 and second["revision"] == first["revision"] + 1
    assert EX + "Receipt" in {n["iri"] for n in second["nodes"]}


# --- AC-15: past 300 boxes, the chosen set ------------------------------------------------


def _big_model(classes: int) -> str:
    lines = [PREFIXES]
    for i in range(classes):
        parent = f" ; rdfs:subClassOf shop:C{(i - 1) // 2}" if i else ""
        lines.append(f'shop:C{i} a owl:Class ; rdfs:label "Class {i}"@en{parent} .')
    return "\n".join(lines) + "\n"


def test_past_the_limit_only_the_shown_set_and_its_direct_links_are_returned(monkeypatch):
    monkeypatch.setattr(canvas_mod, "CANVAS_MAX_BOXES", 10)
    pid = _project(_big_model(15), languages=())
    empty = canvas(pid)
    assert empty["limited"] is True and empty["total"] == 15 and empty["nodes"] == []
    put_layout(pid, {"shown": [EX + "C1"]})
    shown = canvas(pid)
    # C1, its parent C0 and its children C3 and C4.
    assert {n["iri"] for n in shown["nodes"]} == {EX + "C0", EX + "C1", EX + "C3", EX + "C4"}
    assert all(e["source"] in {n["iri"] for n in shown["nodes"]} for e in shown["edges"])


def test_at_the_limit_everything_is_drawn_whatever_shown_says(pid):
    put_layout(pid, {"shown": [EX + "Invoice"]})
    view = canvas(pid)
    assert view["limited"] is False and len([n for n in view["nodes"] if "imported" not in n]) == 6


def test_the_constant_is_three_hundred():
    assert canvas_mod.CANVAS_MAX_BOXES == 300


# --- AC-13: the layout file ----------------------------------------------------------------


def test_a_layout_round_trips_and_never_changes_the_model(pid):
    client.post(f"/api/projects/{pid}/documents/model/save")
    before = state(pid)
    layout = {"positions": {EX + "Invoice": [12.5, -40]}, "shown": None, "viewport": {"x": 1, "y": 2, "zoom": 0.8}}
    saved = put_layout(pid, layout)
    assert saved.status_code == 200, saved.text
    after = state(pid)
    assert after == before, "no revision, no dirty flag, no undo step"
    got = client.get(f"/api/projects/{pid}/documents/model/layout").json()
    assert got == {"version": 1, "generation": 1, "positions": {EX + "Invoice": [12.5, -40.0]}, "shown": None,
                   "viewport": {"x": 1.0, "y": 2.0, "zoom": 0.8}}
    assert canvas(pid)["layout"] == got
    # On disk, beside the document, under a fixed name.
    assert (project_store.folder(pid) / "model.layout.json").is_file()


def test_a_layout_survives_closing_and_reopening(pid):
    put_layout(pid, {"positions": {EX + "Invoice": [1, 2]}})
    # Saved first: a discarded model has no Invoice, and pruning would rightly
    # drop its position on the next open.
    client.post(f"/api/projects/{pid}/documents/model/save")
    client.post(f"/api/projects/{pid}/close")
    # A restart: nothing of the project left in memory.
    editing_service.close_all()
    client.post(f"/api/projects/{pid}/open")
    assert client.get(f"/api/projects/{pid}/documents/model/layout").json()["positions"] == {EX + "Invoice": [1.0, 2.0]}


@pytest.mark.parametrize(
    "layout, fragment",
    [
        ([1, 2], "is an object"),
        ({"positions": [1]}, "positions are an object"),
        ({"positions": {EX + "A": [1]}}, "two finite numbers"),
        ({"positions": {EX + "A": [1, "2"]}}, "two finite numbers"),
        ({"positions": {EX + "A": [True, 2]}}, "two finite numbers"),
        ({"positions": {"x" * 2049: [1, 2]}}, "2,048 characters"),
        ({"positions": {"": [1, 2]}}, "2,048 characters"),
        ({"shown": "all"}, "shown set"),
        ({"shown": [1]}, "shown set"),
        ({"viewport": {"x": 1, "y": 2}}, "viewport"),
        ({"positions": {f"{EX}N{i}": [i, i] for i in range(20_001)}}, "20,000"),
    ],
)
def test_an_invalid_layout_is_refused_with_a_sentence_and_nothing_written(pid, layout, fragment):
    put_layout(pid, {"positions": {EX + "Invoice": [5, 5]}})
    response = put_layout(pid, layout)
    assert response.status_code == 422
    assert fragment in response.json()["detail"]
    assert client.get(f"/api/projects/{pid}/documents/model/layout").json()["positions"] == {EX + "Invoice": [5.0, 5.0]}


def test_non_finite_numbers_are_refused(pid):
    body = '{"positions": {"http://example.org/shop#A": [NaN, 1]}}'
    response = client.put(
        f"/api/projects/{pid}/documents/model/layout", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422


def test_an_oversized_layout_is_refused_declared_and_while_reading(pid, monkeypatch):
    big = json.dumps({"positions": {f"{EX}{'x' * 1000}{i}": [1, 2] for i in range(1100)}}).encode()
    assert len(big) > 1024 * 1024
    declared = client.put(f"/api/projects/{pid}/documents/model/layout", content=big,
                          headers={"Content-Type": "application/json"})
    assert declared.status_code == 413

    # No Content-Length: the router's reading loop is what refuses it.
    def chunks():
        for i in range(0, len(big), 64 * 1024):
            yield big[i:i + 64 * 1024]

    streamed = client.put(f"/api/projects/{pid}/documents/model/layout", content=chunks(),
                          headers={"Content-Type": "application/json"})
    assert streamed.status_code == 413
    assert not (project_store.folder(pid) / "model.layout.json").exists()


def test_a_rename_moves_the_entry_and_undo_and_redo_move_it_back_and_forth(pid):
    put_layout(pid, {"positions": {EX + "Invoice": [7, 8]}, "shown": [EX + "Invoice"]})
    layout = lambda: client.get(f"/api/projects/{pid}/documents/model/layout").json()  # noqa: E731
    run(pid, "RenameIri", old="shop:Invoice", new="shop:Bill")
    assert layout()["positions"] == {EX + "Bill": [7.0, 8.0]} and layout()["shown"] == [EX + "Bill"]
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert layout()["positions"] == {EX + "Invoice": [7.0, 8.0]}
    client.post(f"/api/projects/{pid}/documents/model/redo")
    assert layout()["positions"] == {EX + "Bill": [7.0, 8.0]}


def test_a_deleted_box_keeps_its_place_until_the_project_is_next_opened(pid):
    put_layout(pid, {"positions": {EX + "Paid": [3, 4], EX + "Invoice": [1, 1]}, "shown": [EX + "Paid"]})
    run(pid, "DeleteEntity", iri="shop:Paid", strategy="orphan")
    layout = lambda: client.get(f"/api/projects/{pid}/documents/model/layout").json()  # noqa: E731
    assert EX + "Paid" in layout()["positions"], "kept, so an undo finds its place"
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert layout()["positions"][EX + "Paid"] == [3.0, 4.0]
    run(pid, "DeleteEntity", iri="shop:Paid", strategy="orphan")
    client.post(f"/api/projects/{pid}/documents/model/save")
    client.post(f"/api/projects/{pid}/close")
    client.post(f"/api/projects/{pid}/open")
    assert layout()["positions"] == {EX + "Invoice": [1.0, 1.0]} and layout()["shown"] == []


def test_the_export_includes_the_layout(pid):
    put_layout(pid, {"positions": {EX + "Invoice": [1, 2]}})
    data = client.get(f"/api/projects/{pid}/export").content
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert "model.layout.json" in names


def test_a_hand_broken_layout_file_reads_as_empty(pid):
    (project_store.folder(pid) / "model.layout.json").write_text("{not json", encoding="utf-8")
    assert canvas(pid)["layout"]["positions"] == {}


# --- Section 10 budgets ------------------------------------------------------------------


def _median_ms(action, setup=None, samples: int = 5) -> float:
    times = []
    gc.disable()
    try:
        for _ in range(samples):
            if setup:
                setup()
            start = time.perf_counter()
            action()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return sorted(times)[samples // 2]


@pytest.mark.perf
def test_canvas_budget():
    """GET canvas on the 10,000-triple fixture, first call for a revision, <= 150 ms."""
    pid = _project(_big_model(3334), languages=())
    assert len(editing_service.document(pid, "model").graph) >= 10_000
    document = editing_service.document(pid, "model")

    def invalidate():
        document._canvas = None

    canvas(pid)  # warm-up: imports, first allocation
    median = _median_ms(lambda: canvas(pid), setup=invalidate)
    assert median <= limit_ms(150), f"the canvas view took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_layout_budget(pid):
    """PUT layout with 300 positions <= 20 ms."""
    layout = {"positions": {f"{EX}C{i}": [i * 10.0, i * 5.0] for i in range(300)}, "shown": None}
    put_layout(pid, layout)
    median = _median_ms(lambda: put_layout(pid, layout))
    assert median <= limit_ms(20), f"a 300-position layout took {median:.1f} ms (median of 5)"


# --- found in the code review of the branch ---------------------------------------------


def test_resolving_imports_refreshes_the_view_without_an_edit():
    lib = client.post(
        "/api/ontologies/upload",
        files={"file": ("agents.ttl", b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/agents> a owl:Ontology .
<http://example.org/agents#Agent> a owl:Class ; rdfs:label "Agent"@en .
""")},
    ).json()["id"]
    pid = _project(PREFIXES + """
<http://example.org/shop> a owl:Ontology ; owl:imports <http://example.org/agents> .
shop:Customer a owl:Class ; rdfs:label "Customer"@en ; rdfs:subClassOf <http://example.org/agents#Agent> .
""", languages=())
    before = {n["iri"]: n for n in canvas(pid)["nodes"]}["http://example.org/agents#Agent"]
    assert before["imported"] == "outside"
    revision = state(pid)["revision"]
    client.post(f"/api/ontologies/{pid}-model/imports/mapping", json={"iri": "http://example.org/agents", "ontologyId": lib})
    assert state(pid)["revision"] == revision, "the mapping is not an edit"
    after = {n["iri"]: n for n in canvas(pid)["nodes"]}["http://example.org/agents#Agent"]
    assert after["imported"] != "outside" and after["label"] == "Agent"


def test_an_end_written_as_an_expression_is_listed_never_offered_to_complete():
    pid = _project(PREFIXES + """
shop:A a owl:Class . shop:B a owl:Class .
shop:either a owl:ObjectProperty ; rdfs:label "either"@en ;
    rdfs:domain [ owl:unionOf ( shop:A shop:B ) ] ; rdfs:range shop:B .
shop:size a owl:DatatypeProperty ; rdfs:label "size"@en ; rdfs:domain [ owl:unionOf ( shop:A shop:B ) ] .
""", languages=())
    undrawn = {u["label"]: u for u in canvas(pid)["undrawn"]}
    assert undrawn["either"]["missing"] == "expression"
    assert undrawn["size"]["missing"] == "expression"


def test_an_attribute_of_a_class_outside_the_model_is_listed_or_drawn_never_lost():
    pid = _project(PREFIXES + """
shop:Customer a owl:Class ; rdfs:subClassOf foaf:Agent .
shop:nick a owl:DatatypeProperty ; rdfs:label "nick"@en ; rdfs:domain foaf:Agent .
shop:age a owl:DatatypeProperty ; rdfs:label "age"@en ; rdfs:domain foaf:Person .
""", languages=())
    view = canvas(pid)
    agent = {n["iri"]: n for n in view["nodes"]}["http://xmlns.com/foaf/0.1/Agent"]
    # foaf:Agent is drawn (a line reaches it), so its attribute is in its box.
    assert [a["label"] for a in agent["attributes"]] == ["nick"]
    # foaf:Person is not drawn, so its attribute is listed.
    assert {(u["label"], u["missing"]) for u in view["undrawn"]} == {("age", "outside")}


# --- PR #47 re-review: the layout's generation ---------------------------------------------


def test_every_write_of_the_layout_increases_its_generation_which_the_server_alone_sets(pid):
    first = put_layout(pid, {"positions": {EX + "Invoice": [1, 1]}}).json()
    assert first["generation"] == 1
    # A generation sent by the browser is not believed.
    second = put_layout(pid, {"generation": 99, "positions": {EX + "Invoice": [2, 2]}}).json()
    assert second["generation"] == 2
    # A rename moving the entry is a write too, and so are its undo and redo.
    run(pid, "RenameIri", old="shop:Invoice", new="shop:Bill")
    assert canvas(pid)["layout"]["generation"] == 3
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert client.get(f"/api/projects/{pid}/documents/model/layout").json()["generation"] == 4


def test_the_canvas_answers_with_the_generation_it_read(pid):
    assert canvas(pid)["layout"]["generation"] == 0
    put_layout(pid, {"positions": {EX + "Invoice": [1, 1]}})
    assert canvas(pid)["layout"]["generation"] == 1



# --- axioms-and-reasoning 5.7: inferred lines and boxes ----------------------------------


def test_a_current_reasoning_result_adds_dashed_kind_lines_and_flags_a_box_that_can_never_have_members():
    pid = _project(MODEL + """
shop:Paper a owl:Class ; rdfs:label "Paper"@en ; rdfs:subClassOf shop:Invoice .
shop:Draft a owl:Class ; rdfs:label "Draft"@en ; rdfs:subClassOf shop:Invoice , shop:Customer .
shop:Invoice owl:disjointWith shop:Customer .
""", languages=())
    assert client.post(f"/api/projects/{pid}/reasoning", json={}).status_code == 200
    drawn = canvas(pid, inferred=True)
    inferred = [(e["source"], e["target"]) for e in drawn["edges"] if e.get("inferred")]
    # Paper is a kind of Document, concluded; drawn once, flagged, and placed
    # among the lines it shares boxes with.
    assert (EX + "Paper", EX + "Document") in inferred
    assert all(e["kind"] == "subClassOf" and "pair" in e for e in drawn["edges"] if e.get("inferred"))
    boxes = {n["iri"]: n for n in drawn["nodes"]}
    assert boxes[EX + "Draft"].get("neverMembers") is True
    assert "neverMembers" not in boxes[EX + "Invoice"]
    # Without the flag, or once the result is stale, nothing inferred is drawn.
    plain = canvas(pid)
    assert not [e for e in plain["edges"] if e.get("inferred")]
    run(pid, "CreateClass", label="Receipt")
    stale = canvas(pid, inferred=True)
    assert not [e for e in stale["edges"] if e.get("inferred")]
    assert not [n for n in stale["nodes"] if n.get("neverMembers")]


def test_inferred_lines_are_laid_on_a_copy_of_the_cached_view():
    view = {
        "nodes": [{"iri": "a"}, {"iri": "b"}, {"iri": "c"}],
        "edges": [{"kind": "subClassOf", "source": "a", "target": "b"}],
        "undrawn": [], "total": 3,
    }
    out = canvas_mod.with_inferred(view, [("a", None, "c"), ("a", None, "b"), ("a", None, "zz")], {"c"})
    assert [(e["source"], e["target"], e.get("inferred")) for e in out["edges"]] == [
        ("a", "b", None), ("a", "c", True),
    ]
    assert view["edges"] == [{"kind": "subClassOf", "source": "a", "target": "b"}]
    assert [n.get("neverMembers") for n in out["nodes"]] == [None, None, True]
    assert view["nodes"][2] == {"iri": "c"}
