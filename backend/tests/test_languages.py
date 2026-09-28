"""
================================================================================
FILE: backend/tests/test_languages.py
================================================================================

SUMMARY
    Multilingual names (authoring-foundations 5.4.2, AC-6b, D-085): the
    primary-language requirement on create, names set per language, BCP 47
    prefix matching in the label picker, the display language across graph,
    tree, detail and search with a visible fallback, search across every
    language, the missing-translation count, and the library's label choice
    left as it was.

BASIC IDEA
    A project with English primary and French added, a French name on one
    class and none on the other, read through the same endpoints the
    interface reads with ?lang=. The library half uploads an ordinary file and
    checks that ?lang= changes nothing for it.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small template; inline Turtle.

EXPECTED OUTPUT
    - Pass/fail for AC-6b.
================================================================================
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDFS, SKOS

from app.editing import editing_service
from app.graph_builder import labeler, lang_matches, pick_label
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/lang#"
PERSON = EX + "Person"
ORG = EX + "Organization"


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


def _project(primary: str = "en") -> str:
    project = client.post(
        "/api/projects",
        json={"name": "Lang", "template": "small", "baseIri": EX, "prefix": "lang", "primaryLanguage": primary},
    ).json()
    client.post(f"/api/projects/{project['id']}/open")
    return project["id"]


def _command(pid: str, command: str, **args):
    return client.post(f"/api/projects/{pid}/documents/model/commands", json={"command": command, "args": args})


@pytest.fixture
def bilingual() -> str:
    pid = _project()
    assert client.patch(f"/api/projects/{pid}", json={"languages": ["fr"]}).status_code == 200
    assert _command(pid, "SetLabel", iri=PERSON, value="Personne", lang="fr").status_code == 200
    return pid


def _graph_labels(oid: str, lang: str | None) -> dict:
    params = {"lang": lang} if lang else {}
    return {n["id"]: n["label"] for n in client.get(f"/api/ontologies/{oid}/graph", params=params).json()["nodes"]}


# --- the primary language on create -------------------------------------------------


def test_every_create_command_needs_a_primary_language_name():
    pid = _project()
    for command in ("CreateClass", "CreateObjectProperty", "CreateDatatypeProperty"):
        response = _command(pid, command)
        assert response.status_code == 422
        assert "primary language (en)" in response.json()["detail"]
    assert _command(pid, "CreateConcept").status_code == 422


def test_create_tags_the_name_with_the_primary_language():
    pid = _project("en-US")
    assert _command(pid, "CreateClass", label="Color").status_code == 200
    assert _command(pid, "CreateConcept", prefLabel="Gray").status_code == 200
    graph = editing_service.document(pid, "model").graph
    assert (URIRef(EX + "Color"), RDFS.label, Literal("Color", lang="en-US")) in graph
    assert (URIRef(EX + "Gray"), SKOS.prefLabel, Literal("Gray", lang="en-US")) in graph
    # The template is written in the primary language too.
    assert (URIRef(PERSON), RDFS.label, Literal("Person", lang="en-US")) in graph


def test_a_concept_cannot_be_created_in_another_language_first():
    pid = _project()
    response = _command(pid, "CreateConcept", prefLabel="Chien", lang="fr")
    assert response.status_code == 422
    assert "primary language (en) first" in response.json()["detail"]


def test_set_label_sets_or_replaces_one_language():
    pid = _project()
    _command(pid, "SetLabel", iri=PERSON, value="Personne", lang="fr")
    _command(pid, "SetLabel", iri=PERSON, value="Individu", lang="fr")
    labels = set(editing_service.document(pid, "model").graph.objects(URIRef(PERSON), RDFS.label))
    assert labels == {Literal("Person", lang="en"), Literal("Individu", lang="fr")}


def test_project_languages_are_validated_and_exclude_the_primary():
    pid = _project()
    bad = client.patch(f"/api/projects/{pid}", json={"languages": ["fr", "not a tag"]})
    assert bad.status_code == 422 and "well-formed language tag" in bad.json()["detail"]
    good = client.patch(f"/api/projects/{pid}", json={"languages": ["fr", "es", "en", "fr"]}).json()
    assert good["primaryLanguage"] == "en" and good["languages"] == ["fr", "es"]


# --- the label picker ------------------------------------------------------------------


def test_tags_match_by_prefix():
    assert lang_matches("en-US", "en") and lang_matches("EN-gb", "en") and lang_matches("en", "en")
    assert not lang_matches("eng", "en") and not lang_matches("fr", "en") and not lang_matches(None, "en")


def test_pick_label_prefers_an_en_us_name_under_english():
    graph = Graph().parse(
        data=f'<{PERSON}> <{RDFS.label}> "Personne"@fr , "Person"@en-US .', format="turtle"
    )
    assert pick_label(graph, URIRef(PERSON)) == "Person"


def test_the_library_label_choice_is_unchanged():
    """English or untagged first, in the order met; then the first other."""
    cases = [
        ('"Chien"@fr , "Dog"', "Dog"),
        ('"Chien"@fr , "Dog"@en', "Dog"),
        ('"Chien"@fr', "Chien"),
    ]
    for objects, expected in cases:
        graph = Graph().parse(data=f"<{PERSON}> <{RDFS.label}> {objects} .", format="turtle")
        assert pick_label(graph, URIRef(PERSON)) == expected
        assert labeler(graph, None)(URIRef(PERSON)) == expected
    # A prefLabel in any language still outranks an English rdfs:label.
    graph = Graph().parse(
        data=f'<{PERSON}> <{SKOS.prefLabel}> "Chien"@fr ; <{RDFS.label}> "Dog"@en .', format="turtle"
    )
    assert pick_label(graph, URIRef(PERSON)) == "Chien"


def test_lang_is_ignored_for_a_library_ontology():
    oid = client.post(
        "/api/ontologies/upload",
        files={"file": ("lib-lang.ttl", f'<{PERSON}> a <http://www.w3.org/2002/07/owl#Class> ; <{RDFS.label}> "Person"@en , "Personne"@fr .'.encode())},
    ).json()["id"]
    assert _graph_labels(oid, "fr") == _graph_labels(oid, None) == {PERSON: "Person"}


# --- the display language ------------------------------------------------------------------


def test_the_graph_shows_the_display_language_with_a_marked_fallback(bilingual):
    oid = f"{bilingual}-model"
    english = _graph_labels(oid, None)
    assert english[PERSON] == "Person" and english[ORG] == "Organization"
    french = _graph_labels(oid, "fr")
    assert french[PERSON] == "Personne"
    assert french[ORG] == "Organization (en)"
    # A language the project does not carry falls back to the primary, unmarked.
    assert _graph_labels(oid, "de") == english


def test_the_tree_shows_the_display_language(bilingual):
    tree = client.get(f"/api/ontologies/{bilingual}-model/hierarchy", params={"lang": "fr"}).json()
    labels = {n: v["label"] for n, v in tree["classes"]["nodes"].items()}
    assert labels[PERSON] == "Personne" and labels[ORG] == "Organization (en)"


def test_the_detail_title_and_names_block(bilingual):
    details = client.get(
        f"/api/ontologies/{bilingual}-model/node", params={"iri": ORG, "lang": "fr"}
    ).json()
    assert details["label"] == "Organization (en)"
    assert details["names"] == [{"lang": "en", "value": "Organization"}, {"lang": "fr", "value": None}]
    person = client.get(f"/api/ontologies/{bilingual}-model/node", params={"iri": PERSON}).json()
    assert person["names"] == [{"lang": "en", "value": "Person"}, {"lang": "fr", "value": "Personne"}]


def test_search_matches_every_language_whatever_the_display(bilingual):
    oid = f"{bilingual}-model"
    found = client.get(f"/api/ontologies/{oid}/search", params={"q": "personne"}).json()
    assert [n["id"] for n in found] == [PERSON]
    assert found[0]["label"] == "Person"
    in_french = client.get(f"/api/ontologies/{oid}/search", params={"q": "person", "lang": "fr"}).json()
    assert in_french[0]["label"] == "Personne"


def test_the_missing_translation_count(bilingual):
    counted = client.get(f"/api/projects/{bilingual}/documents/model/languages").json()
    # Person, Organization, memberOf and the ontology itself are named in English;
    # only Person has French.
    assert counted["languages"] == ["en", "fr"]
    assert counted["missing"]["en"] == 0
    assert counted["missing"]["fr"] == counted["entities"] - 1
