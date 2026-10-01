"""
================================================================================
FILE: backend/tests/test_modeling_checks.py
================================================================================

SUMMARY
    Section 5.9 of relationships-and-project-kinds: every modeling check
    refuses or warns with its sentence (AC-10), and the checks for one
    command stay inside 20 ms on the 10,000-triple fixture (Section 10).

BASIC IDEA
    Refusals go through the command route, as the form sends them, and each
    asserts the sentence, a 422, an unmoved revision and an isomorphic graph:
    a refusal changes nothing. Matrix row R10 is here twice for each
    contradiction, by the form alone and by a Turtle apply followed by the
    form, since Turtle accepts everything (D-089) and the check must hold
    against what the editor wrote. Warnings are read from the node route,
    where the form reads them, and R8's Fix is sent back as the command it
    names and must clear its own warning.

    The budget walks the worst hierarchy for the checks: a single broader
    chain 2,500 concepts deep, each concept four triples, so the loop and
    related checks walk every one of them. Median of five with the collector
    off (D-024), through limit_ms.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-10, R8, R10, R12, R18 and R19 as the server sees them,
      and the 5.9 budget.
================================================================================
"""

from __future__ import annotations

import gc
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import OWL, RDF, RDFS, SKOS

from app import modeling_checks
from app.editing import editing_service
from app.main import app

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"
PREFIXES = f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
"""

MODEL = PREFIXES + """
shop:Person a owl:Class ; rdfs:label "Person"@en .
shop:Organization a owl:Class ; rdfs:label "Organization"@en .
shop:worksFor a owl:ObjectProperty ; rdfs:label "works for"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .
shop:employs a owl:ObjectProperty ; rdfs:label "employs"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Organization .
shop:knows a owl:ObjectProperty ; rdfs:label "knows"@en ;
    rdfs:domain shop:Person ; rdfs:range shop:Person .
shop:memberOf a owl:ObjectProperty ; rdfs:label "member of"@en .
shop:partOf a owl:ObjectProperty ; rdfs:label "part of"@en ; rdfs:subPropertyOf shop:memberOf .
shop:Fruits a skos:ConceptScheme ; skos:prefLabel "Fruits"@en ; skos:hasTopConcept shop:Fruit .
shop:Fruit a skos:Concept ; skos:prefLabel "Fruit"@en ; skos:inScheme shop:Fruits .
shop:Apple a skos:Concept ; skos:prefLabel "Apple"@en ; skos:inScheme shop:Fruits ;
    skos:broader shop:Fruit .
shop:Gala a skos:Concept ; skos:prefLabel "Gala"@en ; skos:inScheme shop:Fruits ;
    skos:broader shop:Apple .
shop:Orchard a skos:Concept ; skos:prefLabel "Orchard"@en ; skos:inScheme shop:Fruits ;
    skos:topConceptOf shop:Fruits .
"""


def U(local: str) -> URIRef:
    return URIRef(EX + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


@pytest.fixture
def pid() -> str:
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": "empty", "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    assert apply(project, MODEL).status_code == 200
    return project


def run(pid: str, command: str, **args):
    return client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": command, "args": args})


def apply(pid: str, text: str):
    return client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})


def graph(pid: str) -> Graph:
    return editing_service.document(pid, "model").graph


def snapshot(pid: str) -> tuple[Graph, int]:
    copy = Graph()
    for t in graph(pid):
        copy.add(t)
    return copy, editing_service.document(pid, "model").ontology.revision


def refused(pid: str, command: str, sentence: str, **args) -> None:
    """A refusal says its sentence and changes nothing (5.9)."""
    before, revision = snapshot(pid)
    response = run(pid, command, **args)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == sentence
    assert editing_service.document(pid, "model").ontology.revision == revision
    assert isomorphic(graph(pid), before)


def warnings(pid: str, iri: str) -> list[dict]:
    """The warnings as the form reads them: the sentence, and its Fix; the
    block each goes under is asserted where it matters."""
    response = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": iri})
    assert response.status_code == 200, response.text
    return [{k: v for k, v in w.items() if k != "block"} for w in response.json()["warnings"]]


def blocks(pid: str, iri: str) -> dict:
    response = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": iri})
    return {w["text"]: w["block"] for w in response.json()["warnings"]}


CONTRADICTIONS = [
    ("transitive", "functional",
     'A relationship that chains cannot also be "at most one" in OWL 2; reasoners such as HermiT reject the file. Choose one.'),
    ("symmetric", "asymmetric", '"Works both ways" and "never both ways" contradict each other.'),
    ("reflexive", "irreflexive", '"Always to itself" and "never to itself" contradict each other.'),
]


# --- R10: each refused combination, by the form, and by Turtle then the form -----------------


@pytest.mark.parametrize("first,second,sentence", CONTRADICTIONS)
@pytest.mark.parametrize("reverse", [False, True])
def test_a_contradiction_is_refused_by_the_form_in_either_order(pid, first, second, sentence, reverse):
    if reverse:
        first, second = second, first
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic=first, on=True).status_code == 200
    refused(pid, "SetCharacteristic", sentence, property="shop:knows", characteristic=second, on=True)


@pytest.mark.parametrize("first,second,sentence", CONTRADICTIONS)
def test_a_contradiction_written_in_turtle_is_refused_when_the_form_adds_the_other(pid, first, second, sentence):
    word = modeling_checks.CHARACTERISTICS[first].split("#")[1]
    assert apply(pid, MODEL + f"shop:knows a owl:{word} .\n").status_code == 200
    refused(pid, "SetCharacteristic", sentence, property="shop:knows", characteristic=second, on=True)
    # Turning the one that is there off is always allowed.
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic=first, on=False).status_code == 200


@pytest.mark.parametrize("first,second,sentence", CONTRADICTIONS)
def test_both_written_in_turtle_stay_visible_as_a_warning(pid, first, second, sentence):
    a = modeling_checks.CHARACTERISTICS[first].split("#")[1]
    b = modeling_checks.CHARACTERISTICS[second].split("#")[1]
    assert apply(pid, MODEL + f"shop:knows a owl:{a}, owl:{b} .\n").status_code == 200
    assert {"text": sentence} in warnings(pid, EX + "knows")


# --- the OWL 2 rule for chaining relationships (5.9, v0.6: the first three rows) ----------

SIMPLE_ONLY = [
    ("functional", "at most one"),
    ("inverseFunctional", "identifies its start"),
    ("asymmetric", "never both ways"),
    ("irreflexive", "never to itself"),
]


def chains_sentence(word: str) -> str:
    return f'A relationship that chains cannot also be "{word}" in OWL 2; reasoners such as HermiT reject the file. Choose one.'


@pytest.mark.parametrize("name,word", SIMPLE_ONLY)
@pytest.mark.parametrize("chains_first", [True, False])
def test_chains_with_any_of_the_four_is_refused_naming_the_other_box(pid, name, word, chains_first):
    first, second = ("transitive", name) if chains_first else (name, "transitive")
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic=first, on=True).status_code == 200
    refused(pid, "SetCharacteristic", chains_sentence(word), property="shop:knows", characteristic=second, on=True)


@pytest.mark.parametrize("name", ["symmetric", "reflexive"])
def test_chains_with_the_other_two_is_allowed(pid, name):
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic="transitive", on=True).status_code == 200
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic=name, on=True).status_code == 200


@pytest.mark.parametrize("name,word", SIMPLE_ONLY)
def test_one_with_a_chaining_relationship_under_it_cannot_have_the_four(pid, name, word):
    """Second row: part of is under member of, and part of chains."""
    assert run(pid, "SetCharacteristic", property="shop:partOf", characteristic="transitive", on=True).status_code == 200
    refused(
        pid, "SetCharacteristic",
        f'member of has a relationship under it that chains, so it cannot also be "{word}" in OWL 2.',
        property="shop:memberOf", characteristic=name, on=True,
    )


def test_one_whose_other_way_round_chains_cannot_have_the_four(pid):
    """Second row, the other way round: employs is the inverse of works for."""
    assert run(pid, "SetInverse", property="shop:worksFor", inverse="shop:employs").status_code == 200
    assert run(pid, "SetCharacteristic", property="shop:worksFor", characteristic="transitive", on=True).status_code == 200
    refused(
        pid, "SetCharacteristic",
        'The other way round of employs chains, so it cannot also be "at most one" in OWL 2.',
        property="shop:employs", characteristic="functional", on=True,
    )


def test_a_chaining_one_is_not_put_under_one_that_has_the_four(pid):
    """Third row, by AddSubPropertyOf: manages chains, member of is at most one."""
    text = MODEL + 'shop:manages a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:label "manages"@en .\nshop:memberOf a owl:FunctionalProperty .\n'
    assert apply(pid, text).status_code == 200
    refused(
        pid, "AddSubPropertyOf",
        'manages chains, and member of is "at most one"; in OWL 2 a relationship above a chaining one cannot be.',
        child="shop:manages", parent="shop:memberOf",
    )


def test_a_chaining_one_is_not_made_the_other_way_round_of_one_that_has_the_four(pid):
    """Third row, by SetInverse."""
    assert run(pid, "SetCharacteristic", property="shop:employs", characteristic="functional", on=True).status_code == 200
    assert run(pid, "SetCharacteristic", property="shop:worksFor", characteristic="transitive", on=True).status_code == 200
    refused(
        pid, "SetInverse",
        'works for chains, and employs is "at most one"; in OWL 2 a relationship that is the other way round of a chaining one cannot be.',
        property="shop:worksFor", inverse="shop:employs",
    )


def test_making_one_chain_below_one_that_has_the_four_is_refused(pid):
    """Third row, by SetCharacteristic: the violation is above, not here."""
    assert run(pid, "SetCharacteristic", property="shop:memberOf", characteristic="functional", on=True).status_code == 200
    refused(
        pid, "SetCharacteristic",
        'part of chains, and member of is "at most one"; in OWL 2 a relationship above a chaining one cannot be.',
        property="shop:partOf", characteristic="transitive", on=True,
    )


def test_the_rule_written_in_turtle_is_a_warning_under_what_else_is_true(pid):
    text = MODEL + "shop:partOf a owl:TransitiveProperty .\nshop:memberOf a owl:IrreflexiveProperty .\n"
    assert apply(pid, text).status_code == 200
    sentence = 'member of has a relationship under it that chains, so it cannot also be "never to itself" in OWL 2.'
    assert {"text": sentence} in warnings(pid, EX + "memberOf")
    assert blocks(pid, EX + "memberOf")[sentence] == "characteristics"
    # And a change elsewhere is not refused because of it.
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic="functional", on=True).status_code == 200


def test_turning_a_characteristic_off_is_never_refused(pid):
    for name in modeling_checks.CHARACTERISTICS:
        assert run(pid, "SetCharacteristic", property="shop:knows", characteristic=name, on=True).status_code in (200, 422)
    for name in modeling_checks.CHARACTERISTICS:
        response = run(pid, "SetCharacteristic", property="shop:knows", characteristic=name, on=False)
        assert response.status_code in (200, 422)
        if response.status_code == 422:
            assert "is not" in response.json()["detail"]
    assert modeling_checks.characteristics(graph(pid), U("knows")) == set()


# --- the inverse ---------------------------------------------------------------------------


def test_a_relationship_made_its_own_inverse_is_refused_with_the_suggestion(pid):
    refused(
        pid, "SetInverse", 'works for cannot be its own other way round. Use "Works both ways" instead.',
        property="shop:worksFor", inverse="shop:worksFor",
    )


def test_r8_an_inverse_with_the_wrong_ends_warns_and_its_fix_sets_them(pid):
    # employs goes Person to Organization, as works for does: the wrong way.
    assert run(pid, "SetInverse", property="shop:worksFor", inverse="shop:employs").status_code == 200
    assert (U("employs"), OWL.inverseOf, U("worksFor")) in graph(pid)
    found = warnings(pid, EX + "worksFor")
    assert [w["text"] for w in found] == ["employs should go from Organization to Person."]
    # Shown under the block it concerns (v0.6).
    assert blocks(pid, EX + "worksFor") == {"employs should go from Organization to Person.": "inverse"}
    fix = found[0]["fix"]
    assert fix["command"] == "SetEnds"
    assert run(pid, fix["command"], **fix["args"]).status_code == 200
    assert (U("employs"), RDFS.domain, U("Organization")) in graph(pid)
    assert (U("employs"), RDFS.range, U("Person")) in graph(pid)
    assert warnings(pid, EX + "worksFor") == []
    # And seen from the other side, nothing is left to say either.
    assert warnings(pid, EX + "employs") == []


def test_an_inverse_with_no_ends_yet_warns_too(pid):
    assert run(pid, "SetInverse", property="shop:worksFor", inverse="shop:memberOf").status_code == 200
    assert warnings(pid, EX + "worksFor")[0]["text"] == "member of should go from Organization to Person."


def test_an_inverse_made_by_name_has_the_swapped_ends_and_no_warning(pid):
    result = run(pid, "SetInverse", property="shop:worksFor", label="has worker")
    assert result.status_code == 200
    assert result.json()["created"] == EX + "hasWorker"
    assert warnings(pid, EX + "worksFor") == []


# --- symmetric and reflexive -----------------------------------------------------------------


def test_works_both_ways_between_two_classes_warns(pid):
    assert run(pid, "SetCharacteristic", property="shop:worksFor", characteristic="symmetric", on=True).status_code == 200
    assert [w["text"] for w in warnings(pid, EX + "worksFor")] == [
        "Works both ways means an Organization can also be linked by works for to a Person. "
        "Usually start and end are the same class."
    ]


def test_works_both_ways_on_one_class_does_not_warn(pid):
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic="symmetric", on=True).status_code == 200
    assert warnings(pid, EX + "knows") == []


def test_always_to_itself_with_a_start_class_warns_until_the_start_is_cleared(pid):
    assert run(pid, "SetCharacteristic", property="shop:knows", characteristic="reflexive", on=True).status_code == 200
    assert [w["text"] for w in warnings(pid, EX + "knows")] == [
        '"Always to itself" makes every thing a Person. This is rarely what is meant.'
    ]
    assert run(pid, "ClearDomain", property="shop:knows").status_code == 200
    assert warnings(pid, EX + "knows") == []


# --- R18, R19, R12: related to, broader and sub-relationship loops ----------------------------


@pytest.mark.parametrize(
    "a,b,sentence",
    [
        ("Apple", "Fruit", "Apple is already narrower than Fruit; SKOS does not allow them to be related as well."),
        ("Fruit", "Apple", "Apple is already narrower than Fruit; SKOS does not allow them to be related as well."),
        # Through another concept: Gala is under Apple, which is under Fruit.
        ("Fruit", "Gala", "Gala is already narrower than Fruit; SKOS does not allow them to be related as well."),
    ],
)
def test_r18_related_between_broader_and_narrower_is_refused(pid, a, b, sentence):
    refused(pid, "AddRelated", sentence, concept=f"shop:{a}", related=f"shop:{b}")


def test_related_between_two_unrelated_concepts_is_allowed(pid):
    assert run(pid, "AddRelated", concept="shop:Apple", related="shop:Orchard").status_code == 200


@pytest.mark.parametrize(
    "concept,broader",
    [("Fruit", "Apple"), ("Fruit", "Gala"), ("Fruit", "Fruit")],
)
def test_r19_a_broader_link_that_makes_a_loop_is_refused(pid, concept, broader):
    refused(pid, "AddBroader", f"That would make {concept} narrower than itself.",
            concept=f"shop:{concept}", broader=f"shop:{broader}")


def test_a_loop_through_a_narrower_statement_is_seen_too(pid):
    # skos:narrower written the other way is the same hierarchy.
    assert apply(pid, MODEL + "shop:Orchard skos:narrower shop:Fruit .\n").status_code == 200
    refused(pid, "AddBroader", "That would make Orchard narrower than itself.",
            concept="shop:Orchard", broader="shop:Gala")


@pytest.mark.parametrize(
    "concept,broader,sentence",
    [
        ("Apple", "Orchard", "Apple is related to Orchard; SKOS does not allow one to be narrower than the other as well."),
        # Through others: Gala under Apple under Fruit; Fruit under Orchard puts
        # Apple, which is related to Orchard, under it.
        ("Fruit", "Orchard", "Apple is related to Orchard; SKOS does not allow one to be narrower than the other as well."),
        # The concept that would be the lower one is named first.
        ("Orchard", "Gala", "Orchard is related to Apple; SKOS does not allow one to be narrower than the other as well."),
    ],
)
def test_narrower_than_between_related_concepts_is_refused(pid, concept, broader, sentence):
    """The reverse of R18 (found in review): related first, then broader."""
    assert run(pid, "AddRelated", concept="shop:Apple", related="shop:Orchard").status_code == 200
    refused(pid, "AddBroader", sentence, concept=f"shop:{concept}", broader=f"shop:{broader}")


@pytest.mark.parametrize("child,parent", [("memberOf", "partOf"), ("memberOf", "memberOf")])
def test_r12_a_sub_relationship_loop_is_refused(pid, child, parent):
    name = {"memberOf": "member of"}[child]
    refused(pid, "AddSubPropertyOf", f"That would make {name} a more specific kind of itself.",
            child=f"shop:{child}", parent=f"shop:{parent}")


def test_an_attribute_is_not_offered_the_relationship_characteristics(pid):
    assert apply(pid, MODEL + 'shop:name a owl:DatatypeProperty ; rdfs:label "name"@en .\n').status_code == 200
    refused(
        pid, "SetCharacteristic",
        'name is an attribute; an attribute can only be "one value only". The others describe links between things.',
        property="shop:name", characteristic="transitive", on=True,
    )
    result = run(pid, "SetCharacteristic", property="shop:name", characteristic="functional", on=True)
    assert result.status_code == 200
    assert result.json()["label"] == 'Marked name as "one value only"'


# --- Section 10: the checks for one command, <= 20 ms on 10,000 triples ------------------------


def _chain(depth: int) -> Graph:
    """One broader chain, the deepest walk the checks can meet: C0 at the
    top, C{depth-1} at the bottom, four triples a concept."""
    g = Graph()
    scheme = U("Scheme")
    for i in range(depth):
        c = U(f"C{i}")
        g.add((c, RDF.type, SKOS.Concept))
        g.add((c, SKOS.prefLabel, Literal(f"C {i}", lang="en")))
        g.add((c, SKOS.inScheme, scheme))
        if i:
            g.add((c, SKOS.broader, U(f"C{i - 1}")))
    return g


@pytest.mark.perf
def test_the_checks_for_a_command_stay_inside_their_budget():
    g = _chain(2_500)
    g.add((U("p"), RDF.type, OWL.ObjectProperty))
    g.add((U("p"), RDF.type, OWL.TransitiveProperty))
    assert len(g) >= 10_000
    bottom, top, loose = U("C2499"), U("C0"), U("Loose")
    g.add((loose, RDF.type, SKOS.Concept))
    name = lambda iri: str(iri)  # noqa: E731

    # What each command checks, before it changes anything. Every walk goes
    # the whole chain: a loop found only at its top, a related pair with no
    # broader link between them at all.
    commands = {
        "AddBroader": lambda: (
            modeling_checks.broader_loop_refusal(g, top, bottom, name),
            modeling_checks.broader_related_refusal(g, top, loose, name),
        )[0],
        "AddRelated": lambda: modeling_checks.related_refusal(g, bottom, loose, name),
        "SetCharacteristic": lambda: modeling_checks.characteristic_refusal(g, U("p"), "functional", True),
        "node warnings": lambda: modeling_checks.warnings(g, U("p"), name),
    }
    assert commands["AddBroader"]() and commands["AddRelated"]() is None
    worst = {}
    for command, checks in commands.items():
        checks()  # warm
        times = []
        gc.disable()
        try:
            for _ in range(5):
                start = time.perf_counter()
                checks()
                times.append((time.perf_counter() - start) * 1000)
        finally:
            gc.enable()
        worst[command] = sorted(times)[2]
    slowest = max(worst, key=worst.get)
    assert worst[slowest] <= limit_ms(20), f"{slowest}'s checks took {worst[slowest]:.1f} ms (median of 5)"
