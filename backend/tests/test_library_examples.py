"""
================================================================================
FILE: backend/tests/test_library_examples.py
================================================================================

SUMMARY
    The library's three bundled examples (home-and-examples, U-13a, D-111):
    the manifest and its hashes, and what each new file must hold -- every
    floor of 5.2 for Space Exploration, the content of 5.3 for The Lord of the
    Rings. (test_examples.py is a project's example data, shacl-authoring
    5.8: a different thing that had the name first.)

BASIC IDEA
    The files are read straight from backend/app/examples/ with rdflib, the
    way the seeding reads them, and each floor is asserted as a count or as
    named statements rather than by eye. A floor is a minimum: the test says
    "at least", so the file can grow without the test moving, and a floor
    that slips fails by name.

INPUTS / INPUT SOURCES
    - backend/app/examples/manifest.json, the two Turtle files beside it, and
      backend/app/vocab/foaf.rdf.

EXPECTED OUTPUT
    - Pass/fail for AC-5, AC-6 and the manifest half of AC-1.
================================================================================
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from rdflib import OWL, RDF, RDFS, SKOS, XSD, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS

APP = Path(__file__).resolve().parent.parent / "app"
MANIFEST = json.loads((APP / "examples" / "manifest.json").read_text(encoding="utf-8"))
SPACE = Namespace("http://example.org/space#")
ME = Namespace("http://example.org/middle-earth#")
CC_BY_4 = URIRef("https://creativecommons.org/licenses/by/4.0/")


def _entry(key: str) -> dict:
    return next(e for e in MANIFEST["examples"] if e["key"] == key)


def _graph(key: str) -> Graph:
    entry = _entry(key)
    return Graph().parse(data=(APP / entry["file"]).read_bytes(), format=entry["format"])


@pytest.fixture(scope="module")
def space() -> Graph:
    return _graph("space")


@pytest.fixture(scope="module")
def middle_earth() -> Graph:
    return _graph("middle-earth")


# --- the manifest -----------------------------------------------------------


def test_manifest_lists_the_three_examples_in_their_order():
    assert [e["key"] for e in MANIFEST["examples"]] == ["space", "middle-earth", "foaf"]
    assert [e["name"] for e in MANIFEST["examples"]] == [
        "Space Exploration",
        "The Lord of the Rings",
        "FOAF (Friend of a Friend)",
    ]
    for entry in MANIFEST["examples"]:
        assert entry["purpose"].strip(), entry["key"]


@pytest.mark.parametrize("entry", MANIFEST["examples"], ids=lambda e: e["key"])
def test_each_file_matches_its_hash_and_is_at_most_1_mb(entry):
    data = (APP / entry["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    # Section 10: three small parses at the first start, bounded here.
    assert len(data) <= 1024 * 1024


def test_foaf_is_the_bundled_vocabulary_not_a_copy():
    entry = _entry("foaf")
    assert entry["file"] == "vocab/foaf.rdf"
    vocab = json.loads((APP / "vocab" / "manifest.json").read_text(encoding="utf-8"))
    foaf = next(v for v in vocab["vocabularies"] if v["file"] == "foaf.rdf")
    assert entry["sha256"] == foaf["sha256"]
    assert "Dan Brickley and Libby Miller, CC BY 1.0" in entry["purpose"]
    # Nothing in examples/ shadows the vocabulary.
    assert not list((APP / "examples").glob("foaf*"))


def test_the_new_files_are_binary_in_gitattributes():
    attributes = (APP.parent.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "backend/app/examples/*.ttl binary" in attributes


# --- Space Exploration: every floor of 5.2 ------------------------------------


def _named(graph: Graph, kind) -> set:
    return {s for s in graph.subjects(RDF.type, kind) if isinstance(s, URIRef)}


def _classes(graph: Graph) -> set:
    return _named(graph, OWL.Class) | _named(graph, RDFS.Class)


def _properties(graph: Graph) -> set:
    return (
        _named(graph, OWL.ObjectProperty)
        | _named(graph, OWL.DatatypeProperty)
        | _named(graph, OWL.AnnotationProperty)
    )


def test_space_has_twenty_classes_three_levels_deep(space):
    classes = _classes(space)
    assert len(classes) >= 20

    def depth(cls, seen=()) -> int:
        parents = [p for p in space.objects(cls, RDFS.subClassOf) if p in classes and p not in seen]
        return 1 + max((depth(p, seen + (cls,)) for p in parents), default=0)

    assert max(depth(c) for c in classes) >= 3
    # The examples 5.2 names.
    assert (SPACE.TerrestrialPlanet, RDFS.subClassOf, SPACE.Planet) in space
    assert (SPACE.Planet, RDFS.subClassOf, SPACE.CelestialBody) in space
    for craft in ("Probe", "CrewedSpacecraft", "Rover"):
        assert (SPACE[craft], RDFS.subClassOf, SPACE.Spacecraft) in space
    assert (SPACE.CrewedMission, RDFS.subClassOf, SPACE.Mission) in space
    assert (SPACE.SpaceAgency, RDFS.subClassOf, SPACE.Organization) in space


def test_space_labels_every_class_and_property_in_english_and_french(space):
    for term in _classes(space) | _properties(space):
        langs = {o.language for o in space.objects(term, RDFS.label) if isinstance(o, Literal)}
        assert {"en", "fr"} <= langs, term
        comments = [o for o in space.objects(term, RDFS.comment) if o.language == "en"]
        assert comments, term


def test_space_has_every_graph_kind(space):
    assert _named(space, OWL.ObjectProperty)
    assert _named(space, OWL.DatatypeProperty)
    assert _named(space, OWL.AnnotationProperty)
    assert _named(space, SKOS.ConceptScheme)
    assert _named(space, SKOS.Concept)
    assert _named(space, SKOS.Collection)
    assert _named(space, OWL.Ontology)
    # One class declared with RDFS alone, for the RDFS class colour.
    assert _named(space, RDFS.Class) - _named(space, OWL.Class)


def _individuals(graph: Graph) -> set:
    classes = _classes(graph)
    return {s for s, o in graph.subject_objects(RDF.type) if o in classes and isinstance(s, URIRef)}


def test_space_has_thirty_linked_individuals(space):
    individuals = _individuals(space)
    assert len(individuals) >= 30
    assert (SPACE.Sun, RDF.type, SPACE.Star) in space
    planets = {s for s in individuals if any(
        space.query("ASK { ?s rdf:type/rdfs:subClassOf* ?c }", initBindings={"s": s, "c": SPACE.Planet})
    )}
    assert {SPACE[p] for p in ("Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune")} == planets
    assert (SPACE.Pluto, RDF.type, SPACE.DwarfPlanet) in space
    assert (SPACE.Ceres, RDF.type, SPACE.DwarfPlanet) in space
    assert len(set(space.subjects(RDF.type, SPACE.Moon))) >= 5
    assert len(set(space.subjects(RDF.type, SPACE.SpaceAgency))) >= 6

    missions = {s for s in space.subjects(SPACE.usedSpacecraft, None)}
    complete = {
        m for m in missions
        if (m, SPACE.operatedBy, None) in space
        and ((m, SPACE.target, None) in space or (m, SPACE.landedOn, None) in space)
    }
    assert len(complete) >= 8


def test_space_has_data_values_of_every_common_type(space):
    typed = {o.datatype for o in space.objects() if isinstance(o, Literal) and o.datatype}
    for datatype in (XSD.integer, XSD.decimal, XSD.date, XSD.gYear, XSD.boolean):
        assert datatype in typed, datatype
    # A string-valued property: its range says xsd:string, and Turtle writes
    # its plain values without the type, as RDF 1.1 reads them.
    strings = [p for p in space.subjects(RDFS.range, XSD.string)]
    assert strings and any(
        isinstance(o, Literal) and o.datatype in (None, XSD.string) and not o.language
        for p in strings for o in space.objects(None, p)
    )


def test_space_has_what_the_reasoner_works_on(space):
    assert (SPACE.orbits, OWL.inverseOf, SPACE.isOrbitedBy) in space
    assert (SPACE.partOf, RDF.type, OWL.TransitiveProperty) in space
    assert _named(space, OWL.SymmetricProperty)
    assert any(p in _properties(space) for p in space.objects(None, RDFS.subPropertyOf))
    assert (SPACE.Luna, OWL.sameAs, SPACE.EarthsMoon) in space
    # A domain or range that places an individual with no stated type.
    typed = set(space.subjects(RDF.type, None))
    placed = False
    for prop, _ in space.subject_objects(RDFS.domain):
        placed |= any(s not in typed for s in space.subjects(prop, None))
    for prop, _ in space.subject_objects(RDFS.range):
        placed |= any(isinstance(o, URIRef) and o not in typed for o in space.objects(None, prop))
    assert placed


def _restrictions(graph: Graph, predicate) -> list:
    return [r for r in graph.subjects(RDF.type, OWL.Restriction) if (r, predicate, None) in graph]


def test_space_has_rules_on_classes_and_a_defined_class(space):
    assert _restrictions(space, OWL.someValuesFrom)
    assert _restrictions(space, OWL.allValuesFrom)
    qualified = [OWL.qualifiedCardinality, OWL.minQualifiedCardinality, OWL.maxQualifiedCardinality]
    assert any(_restrictions(space, q) for q in qualified)
    assert [c for c, _ in space.subject_objects(OWL.equivalentClass) if isinstance(c, URIRef)]


def test_space_has_both_kinds_of_disjointness(space):
    assert list(space.subject_objects(OWL.disjointWith))
    assert list(space.subjects(RDF.type, OWL.AllDisjointClasses))


def test_space_has_the_mission_types_scheme(space):
    scheme = SPACE.MissionTypes
    concepts = set(space.subjects(SKOS.inScheme, scheme))
    assert len(concepts) >= 8
    assert len(set(space.objects(scheme, SKOS.hasTopConcept))) == 1
    # Two levels below the top: a concept whose broader has a broader.
    assert any(
        (b, SKOS.broader, None) in space for c in concepts for b in space.objects(c, SKOS.broader)
    )
    for predicate in (SKOS.broader, SKOS.narrower, SKOS.related, SKOS.altLabel, SKOS.definition, SKOS.notation):
        assert any((c, predicate, None) in space for c in concepts), predicate
    assert len(_named(space, SKOS.Collection)) == 1


def test_space_carries_what_the_documentation_export_reads(space):
    ontology = next(iter(_named(space, OWL.Ontology)))
    for predicate in (DCTERMS.title, DCTERMS.description, DCTERMS.creator, DCTERMS.created, OWL.versionInfo):
        assert (ontology, predicate, None) in space, predicate
    assert (ontology, DCTERMS.license, CC_BY_4) in space


def test_space_is_about_six_to_nine_hundred_statements(space):
    assert 600 <= len(space) <= 900


# --- The Lord of the Rings: the content of 5.3 ------------------------------

CHARACTERS = {
    "Hobbit": ["Frodo", "Bilbo", "Samwise", "Merry", "Pippin", "RosieCotton", "Gollum"],
    "Wizard": ["Gandalf", "Saruman"],
    "Man": ["Aragorn", "Boromir", "Faramir", "Denethor", "Theoden", "Eomer", "Eowyn"],
    "Elf": ["Legolas", "Elrond", "Arwen", "Galadriel"],
    "Dwarf": ["Gimli", "Gloin"],
    "Maia": ["Sauron"],
    "Ent": ["Treebeard"],
}


def _is_a(graph: Graph, term, cls) -> bool:
    return bool(graph.query(
        "ASK { ?t rdf:type/rdfs:subClassOf* ?c }", initBindings={"t": term, "c": cls}
    ))


def test_lotr_model(middle_earth):
    g = middle_earth
    for kind in ("Hobbit", "Elf", "Dwarf", "Man", "Wizard", "Ent", "Maia"):
        assert _is_a(g, ME[kind], OWL.Class)
        assert (ME[kind], RDFS.subClassOf, ME.Character) in g or (
            ME[kind], RDFS.subClassOf, ME.Maia
        ) in g, kind
    disjoint = next(g.subjects(RDF.type, OWL.AllDisjointClasses))
    members = set(g.items(g.value(disjoint, OWL.members)))
    assert members == {ME.Hobbit, ME.Elf, ME.Dwarf, ME.Man}
    for sub, sup in [("Region", "Place"), ("Realm", "Place"), ("Settlement", "Place"),
                     ("Fortress", "Place"), ("Ring", "Artifact"), ("Weapon", "Artifact"),
                     ("Battle", "Event"), ("Council", "Event")]:
        assert (ME[sub], RDFS.subClassOf, ME[sup]) in g
    assert (ME.Group, RDF.type, OWL.Class) in g and (ME.Book, RDF.type, OWL.Class) in g
    assert (ME.parentOf, OWL.inverseOf, ME.childOf) in g
    assert (ME.spouseOf, RDF.type, OWL.SymmetricProperty) in g
    assert (ME.siblingOf, RDF.type, OWL.SymmetricProperty) in g
    assert (ME.locatedIn, RDF.type, OWL.TransitiveProperty) in g
    for prop in ("memberOf", "livesIn", "bears", "wields", "madeBy", "takesPartIn",
                 "takesPlaceIn", "appearsIn", "leaderOf"):
        assert (ME[prop], RDF.type, OWL.ObjectProperty) in g, prop
    assert (ME.bornInYear, RDFS.range, XSD.integer) in g
    assert (ME.publishedIn, RDFS.range, XSD.gYear) in g


def test_lotr_characters_and_aliases(middle_earth):
    g = middle_earth
    for kind, names in CHARACTERS.items():
        for name in names:
            assert (ME[name], RDF.type, ME[kind]) in g, name
    for who, alias in [("Aragorn", "Strider"), ("Gandalf", "Mithrandir"), ("Gollum", "Sméagol"),
                       ("Aragorn", "Elessar")]:
        assert alias in {str(o) for o in g.objects(ME[who], SKOS.altLabel)}, alias


def test_lotr_fellowship_and_family(middle_earth):
    g = middle_earth
    nine = {"Frodo", "Samwise", "Merry", "Pippin", "Gandalf", "Aragorn", "Legolas", "Gimli", "Boromir"}
    assert set(g.subjects(ME.memberOf, ME.TheFellowship)) == {ME[n] for n in nine}
    assert (ME.TheFellowship, RDF.type, ME.Group) in g
    for parent, child in [("Denethor", "Boromir"), ("Denethor", "Faramir"),
                          ("Elrond", "Arwen"), ("Gloin", "Gimli")]:
        assert (ME[parent], ME.parentOf, ME[child]) in g
    assert (ME.Eomer, ME.siblingOf, ME.Eowyn) in g
    assert (ME.Aragorn, ME.spouseOf, ME.Arwen) in g
    assert (ME.Samwise, ME.spouseOf, ME.RosieCotton) in g


def test_lotr_rings_and_weapons(middle_earth):
    g = middle_earth
    assert (ME.TheOneRing, ME.madeBy, ME.Sauron) in g
    bearers = set(g.subjects(ME.bears, ME.TheOneRing))
    assert bearers == {ME.Bilbo, ME.Frodo, ME.Gollum, ME.Samwise}
    for who, ring in [("Gandalf", "Narya"), ("Galadriel", "Nenya"), ("Elrond", "Vilya")]:
        assert (ME[who], ME.bears, ME[ring]) in g
    for who, weapon in [("Bilbo", "Sting"), ("Frodo", "Sting"), ("Aragorn", "Anduril"),
                        ("Gandalf", "Glamdring")]:
        assert (ME[who], ME.wields, ME[weapon]) in g


def test_lotr_places_nest(middle_earth):
    g = middle_earth
    nesting = [("Eriador", "MiddleEarth"), ("TheShire", "Eriador"), ("Hobbiton", "TheShire"),
               ("Rivendell", "Eriador"), ("Rohan", "MiddleEarth"), ("Edoras", "Rohan"),
               ("HelmsDeep", "Rohan"), ("Gondor", "MiddleEarth"), ("MinasTirith", "Gondor"),
               ("Mordor", "MiddleEarth"), ("MountDoom", "Mordor"), ("Lothlorien", "MiddleEarth"),
               ("Moria", "MiddleEarth"), ("Isengard", "MiddleEarth")]
    for inner, outer in nesting:
        assert (ME[inner], ME.locatedIn, ME[outer]) in g, inner
        assert _is_a(g, ME[inner], ME.Place), inner


def test_lotr_books_and_events(middle_earth):
    g = middle_earth
    for book, year in [("FellowshipOfTheRing", "1954"), ("TheTwoTowers", "1954"),
                       ("TheReturnOfTheKing", "1955")]:
        assert (ME[book], ME.publishedIn, Literal(year, datatype=XSD.gYear)) in g
        assert (ME[book], DCTERMS.creator, Literal("J. R. R. Tolkien")) in g
    for name in ("Frodo", "Samwise", "Gandalf", "Aragorn"):
        assert len(set(g.objects(ME[name], ME.appearsIn))) == 3, name
    events = [("CouncilOfElrond", "Rivendell", "Council"), ("BattleOfHelmsDeep", "HelmsDeep", "Battle"),
              ("BattleOfThePelennorFields", "MinasTirith", "Battle"),
              ("DestructionOfTheRing", "MountDoom", "Event")]
    for event, place, kind in events:
        assert (ME[event], RDF.type, ME[kind]) in g
        assert (ME[event], ME.takesPlaceIn, ME[place]) in g
        assert list(g.subjects(ME.takesPartIn, ME[event])), event


def test_lotr_birth_years(middle_earth):
    g = middle_earth
    for who, year in [("Bilbo", 2890), ("Frodo", 2968), ("Samwise", 2980), ("Merry", 2982),
                      ("Pippin", 2990), ("Aragorn", 2931)]:
        assert (ME[who], ME.bornInYear, Literal(year, datatype=XSD.integer)) in g, who


def test_lotr_says_what_it_is_and_is_not(middle_earth):
    g = middle_earth
    ontology = next(iter(_named(g, OWL.Ontology)))
    assert str(g.value(ontology, DCTERMS.description)) == (
        "An unofficial teaching dataset of facts from The Lord of the Rings. "
        "Not affiliated with or endorsed by the Tolkien Estate."
    )
    assert (ontology, DCTERMS.license, CC_BY_4) in g


# A sentence ends at . ! or ? followed by a space or the end; an initial
# such as "J. R. R." would count, which is why it is never in a comment.
_SENTENCE_END = re.compile(r"[.!?](\s|$)")


def test_lotr_comments_are_one_plain_sentence_at_most(middle_earth):
    comments = list(middle_earth.objects(None, RDFS.comment))
    assert comments
    for comment in comments:
        assert len(_SENTENCE_END.findall(str(comment).strip())) == 1, str(comment)


def test_lotr_is_about_five_to_eight_hundred_statements(middle_earth):
    assert 500 <= len(middle_earth) <= 800
