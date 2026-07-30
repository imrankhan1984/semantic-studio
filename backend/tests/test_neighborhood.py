"""
================================================================================
FILE: backend/tests/test_neighborhood.py
================================================================================

SUMMARY
    Tests GET /{oid}/neighborhood: what one entity's neighbourhood contains,
    how its neighbours are ranked when there are more than the limit, what it
    reports about the ones it left out, what it does with an IRI that is not a
    node, and the two performance limits the endpoint has to hold.

BASIC IDEA
    Two fixtures. A hub-and-spokes ontology gives one entity a known,
    constructed degree distribution, so "the highest-degree neighbours are
    returned" is an assertion about ranking rather than about whichever nodes
    happened to win. A 40,000-node one exercises the performance rows, because
    the cost this endpoint has to stay inside is a cost per edge and only
    appears at that scale.

    The dense fixture is the one that binds. A binary tree gives every node
    degree 3, so nothing about neighbour truncation or ranking can be measured
    on it — the lesson stage 1 recorded in Section 10 of the spec, applied here
    before it could be re-learned. It is still timed, because it is the fixture
    the spec's Section 11 names, but the dense one is the honest measurement.

INPUTS / INPUT SOURCES
    - Generated Turtle and N-Triples fixtures, built in-process. Nothing is
      committed: a 40,000-class file has no business in the repository.
    - The FastAPI app through fastapi.testclient.

EXPECTED OUTPUT
    - Pass/fail per assertion, covering AC-15 to AC-19 of
      partial-graph-rendering.md.
================================================================================
"""

import gc
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.graph_builder import neighborhood_viz
from app.routers import ontologies

EX = "http://example.org/neighborhood#"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(main.app)


def _hub_ntriples(spokes: int) -> bytes:
    """One hub every spoke subclasses, and a chain joining the spokes to it.

    Two properties are constructed on purpose. The hub's degree is `spokes`,
    far above anything else, so it is an unambiguous centre. And every spoke i
    also subclasses spoke i-1, which gives the spokes graded degrees — spoke 0
    is joined to the hub and to spoke 1, later spokes to fewer things — so a
    ranking test has something to rank. Without that second edge every spoke
    would tie and only the id tie-break would be under test.
    """
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    sub = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    owl_class = "http://www.w3.org/2002/07/owl#Class"
    out = [
        f"<{EX}Hub> <{type_}> <{owl_class}> .",
        f'<{EX}Hub> <{label}> "Hub" .',
    ]
    for i in range(spokes):
        iri = f"{EX}S{i:04d}"
        out.append(f"<{iri}> <{type_}> <{owl_class}> .")
        out.append(f'<{iri}> <{label}> "Spoke {i}" .')
        out.append(f"<{iri}> <{sub}> <{EX}Hub> .")
        if i > 0:
            out.append(f"<{iri}> <{sub}> <{EX}S{i - 1:04d}> .")
    return ("\n".join(out) + "\n").encode("utf-8")


def _binary_tree_ntriples(classes: int) -> bytes:
    """`classes` owl:Class entities in a binary rdfs:subClassOf tree, labelled.

    The same shape test_graph_budget.py uses, kept separate rather than
    imported: these two files measure different endpoints and a shared fixture
    would tie one's fixture choices to the other's.
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


"""One entity every eighth class subclasses, giving it 5,000 neighbours."""
DENSE_HUB = EX + "DHub"


def _dense_ntriples(classes: int) -> bytes:
    """`classes` entities at roughly FIBO's density, plus one real hub.

    The divisor edges give roughly 3 edges per node, close to the 2.75 measured
    on FIBO. On their own they are not enough for this file: the highest-degree
    node they produce, D0, has **12** neighbours, so a limit of 200 would never
    bind and the two performance rows would be measuring a thirteen-node
    response while appearing to validate a limit that is about truncation.
    Measured, not assumed — the first version of this fixture did exactly that.

    DHub fixes it. Every eighth class subclasses it, so it has 5,000
    neighbours, the default limit truncates hard, and the body-size row
    measures 200 nodes and the edges among them over a 40,000-node ontology,
    which is the case the number is for.
    """
    label = "http://www.w3.org/2000/01/rdf-schema#label"
    sub = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
    type_ = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    owl_class = "http://www.w3.org/2002/07/owl#Class"
    out = [
        f"<{DENSE_HUB}> <{type_}> <{owl_class}> .",
        f'<{DENSE_HUB}> <{label}> "Dense hub" .',
    ]
    for i in range(classes):
        iri = f"{EX}D{i}"
        out.append(f"<{iri}> <{type_}> <{owl_class}> .")
        out.append(f'<{iri}> <{label}> "Generated class number {i}" .')
        for divisor in (2, 7, 13):
            parent = i // divisor
            if i > 0 and parent != i:
                out.append(f"<{iri}> <{sub}> <{EX}D{parent}> .")
        if i % 8 == 0:
            out.append(f"<{iri}> <{sub}> <{DENSE_HUB}> .")
    return ("\n".join(out) + "\n").encode("utf-8")


def _median_ms(call, runs: int = 5) -> float:
    """Median wall-clock cost of `call`, in milliseconds, with the GC paused.

    Both halves earn their place. A single sample is one draw from a noisy
    distribution; and this suite holds several 40,000-node ontologies in memory
    at once, so a generational collection landing inside the timed window adds
    tens of milliseconds that have nothing to do with the code being measured.
    """
    samples = []
    gc.disable()
    try:
        for _ in range(runs):
            start = time.perf_counter()
            call()
            samples.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    return sorted(samples)[len(samples) // 2]


def _upload(client: TestClient, data: bytes, name: str) -> str:
    response = client.post(
        "/api/ontologies/upload",
        files={"file": (name, data, "application/n-triples")},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


@pytest.fixture(scope="module")
def hub_oid(client) -> str:
    """A hub with 40 graded spokes: small enough to assert exact identities."""
    return _upload(client, _hub_ntriples(40), "hub.nt")


@pytest.fixture(scope="module")
def big_oid(client) -> str:
    """The 40,000-node fixture Section 11 names for the performance rows."""
    return _upload(client, _binary_tree_ntriples(40000), "big-nb.nt")


@pytest.fixture(scope="module")
def dense_oid(client) -> str:
    """40,000 nodes at roughly FIBO's density, plus a 5,000-neighbour hub."""
    return _upload(client, _dense_ntriples(40000), "dense-nb.nt")


def _neighborhood(client: TestClient, oid: str, iri: str, **params) -> dict:
    response = client.get(
        f"/api/ontologies/{oid}/neighborhood", params={"iri": iri, **params}
    )
    assert response.status_code == 200, response.text
    return response.json()


# --- what a neighbourhood contains ------------------------------------------


def test_neighborhood_returns_center_and_neighbors(client, hub_oid):
    """AC-15. The centre, its direct connections, and no dangling edge."""
    body = _neighborhood(client, hub_oid, EX + "S0020")
    ids = {n["id"] for n in body["nodes"]}

    # The centre is in its own neighbourhood; without it the browser would be
    # asked to draw connections to a node it does not have.
    assert EX + "S0020" in ids
    # Spoke 20 is joined to the hub, to spoke 19 (its parent) and to spoke 21
    # (which subclasses it). Exactly those three, nothing further out.
    assert ids == {EX + "S0020", EX + "Hub", EX + "S0019", EX + "S0021"}
    assert body["stats"]["center"] == EX + "S0020"

    # Only edges among the returned set, and the neighbour-to-neighbour ones
    # are present too: Hub–S0019 and Hub–S0021 are part of what is drawn.
    assert body["edges"], "a neighbourhood with no edges would draw a field of dots"
    for edge in body["edges"]:
        assert edge["source"] in ids
        assert edge["target"] in ids
    pairs = {(e["source"], e["target"]) for e in body["edges"]}
    assert (EX + "S0019", EX + "Hub") in pairs, "neighbour-to-neighbour edges are kept"


def test_neighborhood_orders_by_degree(client, hub_oid):
    """AC-16. Over the limit, the connections most likely to matter come back."""
    body = _neighborhood(client, hub_oid, EX + "Hub", limit=3)
    returned = [n["id"] for n in body["nodes"]]

    # The centre first, then neighbours in descending degree.
    assert returned[0] == EX + "Hub"
    neighbors = body["nodes"][1:]
    assert len(neighbors) == 3
    degrees = [n["degree"] for n in neighbors]
    assert degrees == sorted(degrees, reverse=True)

    # And they really are the highest-degree ones, not merely sorted among
    # themselves: every neighbour left out is at most as connected.
    full = _neighborhood(client, hub_oid, EX + "Hub", limit=1000)
    kept = {n["id"] for n in neighbors}
    dropped = [n for n in full["nodes"][1:] if n["id"] not in kept]
    assert dropped, "the fixture must have more neighbours than the limit"
    assert max(n["degree"] for n in dropped) <= min(degrees)


def test_neighborhood_reports_true_neighbor_total(client, hub_oid):
    """AC-17. A partial expansion has to say what it left behind."""
    body = _neighborhood(client, hub_oid, EX + "Hub", limit=3)
    stats = body["stats"]

    # 40 spokes all subclass the hub, so the hub has exactly 40 neighbours.
    assert stats["neighborTotal"] == 40
    assert stats["truncated"] is True
    assert stats["budget"] == 3
    assert stats["nodeCount"] == 4  # the centre plus three

    # Asking for everything reports the same total and stops claiming to have
    # truncated, which is the half that proves the flag tracks the limit.
    whole = _neighborhood(client, hub_oid, EX + "Hub", limit=1000)
    assert whole["stats"]["neighborTotal"] == 40
    assert whole["stats"]["truncated"] is False
    assert whole["stats"]["nodeCount"] == 41

    # The ontology's own totals are still reported, so the interface can keep
    # saying how much of it is drawn as the drawn part grows.
    assert stats["nodeTotal"] == 41
    assert stats["edgeTotal"] == whole["stats"]["edgeTotal"]


def test_neighborhood_unknown_iri_returns_404(client, hub_oid):
    """AC-18. 404 naming the IRI, not an empty graph that looks like an answer."""
    missing = EX + "NoSuchEntity"
    response = client.get(
        f"/api/ontologies/{hub_oid}/neighborhood", params={"iri": missing}
    )
    assert response.status_code == 404
    assert missing in response.json()["detail"]

    # A predicate is the case this actually protects against: rdf:type is
    # reachable from a term link in the detail panel and is never a graph node.
    rdf_type = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    assert (
        client.get(
            f"/api/ontologies/{hub_oid}/neighborhood", params={"iri": rdf_type}
        ).status_code
        == 404
    )

    # And an unknown ontology is still a 404 about the ontology, through the
    # shared lookup, rather than a confusing message about the IRI.
    unknown = client.get(
        "/api/ontologies/no-such-id/neighborhood", params={"iri": EX + "Hub"}
    )
    assert unknown.status_code == 404
    assert "no-such-id" in unknown.json()["detail"]


def test_neighborhood_limit_is_validated_and_clamped(client, hub_oid):
    """Not an acceptance criterion, but the same two edges /graph has.

    Zero and negatives are rejected by FastAPI's own validation, and a limit
    above the maximum is clamped and the clamped value reported rather than
    refused. Written because the endpoint copies /graph's shape, and a copy
    that quietly dropped half the behaviour would be easy to miss.
    """
    for bad in (0, -5):
        response = client.get(
            f"/api/ontologies/{hub_oid}/neighborhood",
            params={"iri": EX + "Hub", "limit": bad},
        )
        assert response.status_code == 422

    body = _neighborhood(client, hub_oid, EX + "Hub", limit=999999)
    assert body["stats"]["budget"] == ontologies.MAX_NEIGHBORHOOD_LIMIT


def test_neighborhood_does_not_mutate_the_cache(client, hub_oid):
    """The lists handed back must be copies, for the reason D-018 records.

    budget_viz copies for this reason and neighborhood_viz builds new lists, so
    this is a regression guard rather than a fix: a caller that mutates a
    response must not corrupt the full graph every other feature reads.
    """
    from app.store import store

    viz = store.get(hub_oid).viz()
    before_nodes = len(viz["nodes"])
    before_edges = len(viz["edges"])

    result = neighborhood_viz(viz, EX + "Hub", 5)
    result["nodes"].clear()
    result["edges"].clear()
    result["stats"]["kindCounts"].clear()

    assert len(store.get(hub_oid).viz()["nodes"]) == before_nodes
    assert len(store.get(hub_oid).viz()["edges"]) == before_edges
    assert store.get(hub_oid).viz()["stats"]["kindCounts"]["class"] == before_nodes


# --- performance ------------------------------------------------------------
# The two limits in Section 10 of partial-graph-rendering.md. Marked `perf` so a
# slow machine can deselect them, following the `network` marker's precedent.


@pytest.mark.perf
def test_neighborhood_body_size(client, big_oid, dense_oid):
    """AC-19. At most 0.2 MB at the default limit.

    Measured against the dense fixture as well as the tree, because in a binary
    tree no node has more than three neighbours, so the tree's response is a
    handful of nodes and would satisfy this limit however large the payload per
    node grew. DHub is truncated at the default limit, which is the case the
    number is about, and the assertion below refuses to accept a pass from a
    response that was not truncated at all.
    """
    for oid, shape, center in (
        (big_oid, "tree", EX + "C0"),
        (dense_oid, "dense", DENSE_HUB),
    ):
        response = client.get(
            f"/api/ontologies/{oid}/neighborhood", params={"iri": center}
        )
        assert response.status_code == 200, response.text
        megabytes = len(response.content) / (1024 * 1024)
        assert megabytes <= 0.2, f"{shape} fixture produced {megabytes:.3f} MB"
    # The dense case must be the truncated one, or this row proves nothing.
    assert response.json()["stats"]["truncated"] is True
    assert response.json()["stats"]["nodeCount"] == (
        ontologies.DEFAULT_NEIGHBORHOOD_LIMIT + 1
    )


@pytest.mark.perf
def test_neighborhood_cost(client, big_oid, dense_oid):
    """AC-19. At most 50 ms to build a neighbourhood from a cached viz.

    Timed after a warm-up call for the reason D-018 records: the first call
    through a cold allocator measured an order of magnitude high on the budget
    path and is not representative of what the endpoint does under use. The
    dense fixture is the worst case — 40,000 nodes and about 125,000 edges,
    both of which this walks.

    The median of five, with the collector paused, and both of those were
    measured rather than assumed. Alone this file reads 21 ms; run beside
    test_graph_budget.py it read **53.7 ms** and failed, because five 40,000-node
    fixtures resident is roughly a million GC-tracked dicts and a generational
    pass lands inside the timed window. What the spec's 50 ms bounds is the cost
    of walking the edges, not how many other fixtures the suite happens to hold,
    and a threshold that moves with the rest of the suite is the flakiness
    D-021 was written to end. `timeit` disables the collector for the same
    reason. See D-024.
    """
    from app.store import store

    for oid, shape, center in (
        (big_oid, "tree", EX + "C0"),
        (dense_oid, "dense", DENSE_HUB),
    ):
        viz = store.get(oid).viz()  # warm the cache; the neighbourhood is what is timed
        neighborhood_viz(viz, center, ontologies.DEFAULT_NEIGHBORHOOD_LIMIT)  # warm-up
        elapsed_ms = _median_ms(
            lambda: neighborhood_viz(viz, center, ontologies.DEFAULT_NEIGHBORHOOD_LIMIT)
        )
        assert elapsed_ms <= 50, f"{shape} fixture took {elapsed_ms:.1f} ms"
