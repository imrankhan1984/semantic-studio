"""
================================================================================
FILE: backend/tests/test_graph_budget.py
================================================================================

SUMMARY
    Tests the graph node budget: the `limit` parameter on GET /{oid}/graph, the
    ranking that decides which nodes survive it, the stats that report the true
    totals, and the performance limits the budget exists to hold.

BASIC IDEA
    Two fixtures do the work. A small generated ontology exercises the ranking
    and the edge filtering, where exact node identities can be asserted because
    the degrees are constructed deliberately. A 40,000-node one exercises the
    endpoint and the performance rows, because the defect being fixed only
    appears at that scale.

    The ranking assertions are written against constructed degrees rather than
    against whichever nodes happen to win, so a change to build_viz_graph that
    alters degree counting fails here loudly instead of silently reordering
    what a user sees.

INPUTS / INPUT SOURCES
    - Generated Turtle and N-Triples fixtures, built in-process. Nothing is
      committed: a 40,000-class file has no business in the repository.
    - The FastAPI app through fastapi.testclient.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-1 to AC-13 of
      partial-graph-rendering.md.
================================================================================
"""

import gc
import json
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph

from app import main
from app.graph_builder import budget_viz, build_viz_graph
from app.routers import ontologies

EX = "http://example.org/budget#"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(main.app)


def _hub_and_spokes_turtle(spokes: int = 40) -> str:
    """One hub class every spoke subclasses, so degree is known by construction.

    The hub ends with `spokes` edges, each spoke with exactly one. That gap is
    what makes "the highest-degree nodes are kept" an assertion about ranking
    rather than an accident of the fixture.
    """
    lines = [
        f"@prefix ex: <{EX}> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "",
        'ex:Hub a owl:Class ; rdfs:label "Hub" .',
    ]
    for i in range(spokes):
        # Zero-padded so the id tiebreak has a predictable lexical order.
        lines.append(
            f'ex:Spoke{i:03d} a owl:Class ; rdfs:label "Spoke {i}" ; rdfs:subClassOf ex:Hub .'
        )
    return "\n".join(lines) + "\n"


@pytest.fixture(scope="module")
def hub_viz() -> dict:
    graph = Graph()
    graph.parse(data=_hub_and_spokes_turtle(), format="turtle")
    return build_viz_graph(graph)


def _binary_tree_ntriples(classes: int) -> bytes:
    """`classes` owl:Class entities in a binary rdfs:subClassOf tree, labelled.

    N-Triples rather than Turtle because it parses fastest at this size, and
    the 40,000-class fixture is parsed once per test session.
    """
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    sub = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    owl_class = "http://www.w3.org/2002/07/owl#Class"
    out = []
    for i in range(classes):
        iri = f"{EX}C{i}"
        out.append(f"<{iri}> <{type_}> <{owl_class}> .")
        out.append(f'<{iri}> <{label}> "Generated class number {i}" .')
        if i > 0:
            out.append(f"<{iri}> <{sub}> <{EX}C{(i - 1) // 2}> .")
    return ("\n".join(out) + "\n").encode("utf-8")


def _dense_ntriples(classes: int) -> bytes:
    """`classes` entities whose low indices accumulate most of the edges.

    The binary tree above gives every internal node the same degree 3, so the
    id tie-break decides the whole ranking and — because ids sort as strings —
    the survivors are scattered across the tree and almost no edge keeps both
    ends. That makes the tree fixture measure a body with no edges in it, which
    is not what a real ontology does.

    Attaching each class to three earlier ones concentrates degree on the low
    indices, so the highest-degree nodes are also connected to each other. The
    result is roughly 3 edges per node, close to the 2.75 measured on FIBO, and
    it is what makes the one-megabyte limit bind rather than pass by default.
    """
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    sub = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    owl_class = "http://www.w3.org/2002/07/owl#Class"
    out = []
    for i in range(classes):
        iri = f"{EX}D{i}"
        out.append(f"<{iri}> <{type_}> <{owl_class}> .")
        out.append(f'<{iri}> <{label}> "Generated class number {i}" .')
        for divisor in (2, 7, 13):
            parent = i // divisor
            if i > 0 and parent != i:
                out.append(f"<{iri}> <{sub}> <{EX}D{parent}> .")
    return ("\n".join(out) + "\n").encode("utf-8")


def _upload(client: TestClient, data: bytes, name: str) -> str:
    response = client.post(
        "/api/ontologies/upload",
        files={"file": (name, data, "application/n-triples")},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


@pytest.fixture(scope="module")
def big_oid(client) -> str:
    """A 40,000-node ontology: the scale at which the browser defect appears."""
    return _upload(client, _binary_tree_ntriples(40000), "big.nt")


@pytest.fixture(scope="module")
def dense_oid(client) -> str:
    """40,000 nodes at roughly FIBO's edge density, for the body-size limit."""
    return _upload(client, _dense_ntriples(40000), "dense.nt")


@pytest.fixture(scope="module")
def small_oid(client) -> str:
    """Well under any budget, so it must come back whole and untruncated."""
    return _upload(client, _binary_tree_ntriples(30), "small.nt")


def _graph(client: TestClient, oid: str, **params) -> dict:
    response = client.get(f"/api/ontologies/{oid}/graph", params=params)
    assert response.status_code == 200, response.text
    return response.json()


# --- the budget itself ------------------------------------------------------


def test_default_budget_caps_node_count(client, big_oid):
    """AC-1. No `limit` at all must still be bounded, or the cap is optional."""
    body = _graph(client, big_oid)
    assert body["stats"]["nodeCount"] == ontologies.DEFAULT_GRAPH_NODE_BUDGET
    assert len(body["nodes"]) == ontologies.DEFAULT_GRAPH_NODE_BUDGET
    assert body["stats"]["budget"] == ontologies.DEFAULT_GRAPH_NODE_BUDGET


def test_limit_parameter_is_honored(client, big_oid):
    """AC-2. The parameter used to be accepted and silently ignored."""
    body = _graph(client, big_oid, limit=500)
    assert body["stats"]["nodeCount"] == 500
    assert len(body["nodes"]) == 500


def test_small_ontology_not_truncated(client, small_oid):
    """AC-3. Below the budget nothing changes, and nothing claims it did."""
    body = _graph(client, small_oid)
    assert body["stats"]["truncated"] is False
    assert body["stats"]["nodeCount"] == body["stats"]["nodeTotal"]
    assert body["stats"]["edgeCount"] == body["stats"]["edgeTotal"]


def test_highest_degree_nodes_are_kept(hub_viz):
    """AC-4. The hub has 40 edges and every spoke has one, so the hub wins."""
    budgeted = budget_viz(hub_viz, 5)
    kept = [n["id"] for n in budgeted["nodes"]]
    assert kept[0] == EX + "Hub"
    assert len(kept) == 5
    # Every kept node's degree is at least every dropped node's degree.
    kept_ids = set(kept)
    lowest_kept = min(n["degree"] for n in budgeted["nodes"])
    dropped = [n for n in hub_viz["nodes"] if n["id"] not in kept_ids]
    assert all(n["degree"] <= lowest_kept for n in dropped)


def test_ranking_is_deterministic_across_calls(client, big_oid, hub_viz):
    """AC-5. Ties are broken by id; without that the view reshuffles at random."""
    first = {n["id"] for n in _graph(client, big_oid, limit=300)["nodes"]}
    second = {n["id"] for n in _graph(client, big_oid, limit=300)["nodes"]}
    assert first == second

    # The tie-break itself: every spoke has degree 1, so only the id ordering
    # decides which four survive. Asserting the exact ids proves the rule.
    spokes_only = budget_viz(hub_viz, 5)
    assert [n["id"] for n in spokes_only["nodes"]][1:] == [
        EX + f"Spoke{i:03d}" for i in range(4)
    ]


def test_edges_kept_only_when_both_ends_kept(hub_viz):
    """AC-6. A dangling edge would make Sigma draw an edge to nothing."""
    budgeted = budget_viz(hub_viz, 5)
    kept_ids = {n["id"] for n in budgeted["nodes"]}
    assert budgeted["edges"], "the fixture must retain some edges to be meaningful"
    for edge in budgeted["edges"]:
        assert edge["source"] in kept_ids
        assert edge["target"] in kept_ids
    # And the drop really happened, or the assertion above proves nothing.
    assert len(budgeted["edges"]) < len(hub_viz["edges"])


# --- what stats must report -------------------------------------------------


def test_stats_carry_true_totals(client, big_oid):
    """AC-7. The interface promises the user the real size of the ontology."""
    body = _graph(client, big_oid, limit=1000)
    stats = body["stats"]
    assert stats["truncated"] is True
    assert stats["nodeTotal"] == 40000
    assert stats["nodeCount"] == 1000
    # 39,999 subClassOf edges in a binary tree of 40,000 classes.
    assert stats["edgeTotal"] == 39999
    assert stats["edgeCount"] == len(body["edges"])
    assert stats["edgeCount"] < stats["edgeTotal"]


def test_kind_counts_cover_whole_ontology(client, big_oid):
    """AC-8. The legend describes the ontology, not the canvas. See D-017."""
    stats = _graph(client, big_oid, limit=1000)["stats"]
    assert sum(stats["kindCounts"].values()) == stats["nodeTotal"]
    assert sum(stats["kindCounts"].values()) != stats["nodeCount"]


# --- the edges of the parameter ---------------------------------------------


@pytest.mark.parametrize("limit", [0, -5])
def test_zero_and_negative_limit_rejected(client, big_oid, limit):
    """AC-9. 422 with the valid range named, not a silently empty graph."""
    response = client.get(f"/api/ontologies/{big_oid}/graph", params={"limit": limit})
    assert response.status_code == 422
    # FastAPI's own validation reports the constraint it enforced.
    assert "1" in json.dumps(response.json())


def test_limit_above_maximum_is_clamped_and_reported(client, big_oid):
    """AC-10. Clamped, not refused, and the response says what it clamped to."""
    body = _graph(client, big_oid, limit=999999)
    assert body["stats"]["nodeCount"] == ontologies.MAX_GRAPH_NODE_BUDGET
    assert body["stats"]["budget"] == ontologies.MAX_GRAPH_NODE_BUDGET
    assert body["stats"]["truncated"] is True


def test_env_var_moves_the_default(client, big_oid, monkeypatch):
    """AC-11. The whole safety argument for the number 2,000 rests on this."""
    # The constant is read from the environment at import, so read it back the
    # same way the module does: this is the half that proves the variable is
    # wired to the right name.
    monkeypatch.setenv("SEMANTIC_STUDIO_GRAPH_NODE_BUDGET", "500")
    assert ontologies._env_int("SEMANTIC_STUDIO_GRAPH_NODE_BUDGET", 2000) == 500

    # And the half that proves the resolved default is what the endpoint
    # applies. The handler reads the constant per call, so this takes effect
    # without reloading the module.
    monkeypatch.setattr(ontologies, "DEFAULT_GRAPH_NODE_BUDGET", 500)
    assert _graph(client, big_oid)["stats"]["nodeCount"] == 500


# --- the budget must not damage what it is applied to -----------------------


def test_full_viz_cache_is_unchanged_by_budgeting(client, big_oid):
    """AC-13. Search, the summary and the detail panel all read the full graph."""
    from app.store import store

    _graph(client, big_oid, limit=100)
    cached = store.get(big_oid).viz()
    assert len(cached["nodes"]) == 40000
    assert len(cached["edges"]) == 39999
    assert "truncated" not in cached["stats"]

    # Mutating a budgeted response must not reach the cache either.
    budgeted = budget_viz(cached, 10)
    budgeted["nodes"].clear()
    budgeted["stats"]["kindCounts"].clear()
    assert len(store.get(big_oid).viz()["nodes"]) == 40000
    assert store.get(big_oid).viz()["stats"]["kindCounts"]["class"] == 40000


# --- performance ------------------------------------------------------------
# The limits in Section 10 of partial-graph-rendering.md. Marked `perf` so a
# slow machine can deselect them, following the `network` marker's precedent.


@pytest.mark.perf
def test_default_budget_body_under_one_megabyte(client, big_oid, dense_oid):
    """AC-12. Unbudgeted this response was 9.25 MB, which is the defect.

    Measured against the dense fixture as well as the tree, because the tree's
    budgeted response carries no edges at all (see _dense_ntriples) and so
    would satisfy this limit however large the node payload grew.
    """
    for oid, shape in ((big_oid, "tree"), (dense_oid, "dense")):
        response = client.get(f"/api/ontologies/{oid}/graph")
        assert response.status_code == 200
        megabytes = len(response.content) / (1024 * 1024)
        assert megabytes <= 1.0, f"{shape} fixture produced {megabytes:.2f} MB"


@pytest.mark.perf
def test_dense_budget_keeps_the_graph_connected(client, dense_oid):
    """The budget must not hand back a field of unconnected dots.

    Not an acceptance criterion, but the assumption every one of them rests
    on: ranking by degree is only worth doing if the highest-degree nodes are
    connected to each other. Written after the tree fixture turned out to
    retain zero edges.
    """
    stats = _graph(client, dense_oid)["stats"]
    assert stats["truncated"] is True
    assert stats["edgeCount"] > stats["nodeCount"]


@pytest.mark.perf
def test_budget_cost_under_fifty_milliseconds(client, dense_oid):
    """AC-12. This measurement is the whole argument against a second cache.

    Timed at the maximum budget over the dense fixture, which is the worst
    case: the most nodes to rank, the most edges to filter, and the largest
    result to build. The default budget is several times cheaper. Both are
    timed after a warm-up call, because the first call through a cold
    allocator measured an order of magnitude high and is not representative
    of what the endpoint does under use.

    The median of five with the collector paused arrived later, when
    test_neighborhood.py added two more 40,000-node fixtures and this test
    started failing at **55.3 ms** without a line of the code it measures having
    changed. A generational GC pass over roughly a million resident dicts landed
    inside a single-shot timing. The single sample was measuring the rest of the
    suite. See D-024, and _median_ms in test_neighborhood.py, which carries the
    same reasoning for the same reason.
    """
    from app.store import store

    viz = store.get(dense_oid).viz()  # warm the cache; the budget is what is timed
    for budget in (ontologies.DEFAULT_GRAPH_NODE_BUDGET, ontologies.MAX_GRAPH_NODE_BUDGET):
        budget_viz(viz, budget)  # warm-up, not measured
        samples = []
        gc.disable()
        try:
            for _ in range(5):
                start = time.perf_counter()
                budget_viz(viz, budget)
                samples.append((time.perf_counter() - start) * 1000)
        finally:
            gc.enable()
        elapsed_ms = sorted(samples)[2]
        assert elapsed_ms <= 50, f"budget {budget} over 40,000 nodes took {elapsed_ms:.1f} ms"
