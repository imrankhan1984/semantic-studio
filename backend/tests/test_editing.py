"""
================================================================================
FILE: backend/tests/test_editing.py
================================================================================

SUMMARY
    Editing a project document (authoring-foundations): every command's delta,
    label and revision; typed annotation values; refusals that change nothing;
    IRI minting; rename and delete with its dry run; undo and redo checked by
    isomorphism up to the 200-step cap; the Turtle apply and its parse errors;
    the save format rule and the one-time comments backup; autosave off the
    request path; recovery; saved queries in a project; the Section 10 budgets.
    And the nine shape commands of shacl-authoring Stage A on shapes.ttl:
    exact triples, refusals that change nothing, one undo step each, save
    and reload (row S20), and the first one creating the file.

BASIC IDEA
    Through the HTTP API, as the frontend drives it, with the service's state
    read directly where the API has no window onto it (the graph itself, for
    isomorphism). "Changes nothing" is asserted as an isomorphic graph and an
    unmoved revision, not as a status code alone.

INPUTS / INPUT SOURCES
    - The conftest temp data directory; the small template; inline Turtle; a
      generated 10,000-triple document for the budgets (rdf-fixture: scale is
      generated, never committed).

EXPECTED OUTPUT
    - Pass/fail for AC-6, AC-6a, AC-7 to AC-15 and AC-18, and four budgets.
    - visual-modeling-canvas Stage 1: AC-8 (undo or redo to the save point is
      clean, nothing to recover) and AC-9 (apply, undo, save writes the file
      byte for byte), and what the form needs from the server: the created
      IRI, plain literals, search by kind, kinds in project details.
    - shacl-authoring Stage A: AC-2 as the server sees it, row S20.
================================================================================
"""

from __future__ import annotations

import gc
import json
import time

import pytest
from fastapi.testclient import TestClient
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.compare import isomorphic
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS, SKOS, XSD

from app import editing
from app.editing import editing_service, has_comments, project_store
from app.main import app

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

EX = "http://example.org/shop#"


def U(local: str) -> URIRef:
    return URIRef(EX + local)


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


@pytest.fixture
def pid() -> str:
    """A fresh small-template project, open."""
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": "small", "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    return project


@pytest.fixture
def bare() -> str:
    """A small-template project as Stage A knew it, open: no shapes.ttl yet.
    Stage B's starter shapes (5.8, row S23) would make the first shape
    command a second one, which is not what these tests are about."""
    response = client.post(
        "/api/projects", json={"name": "Shop", "template": "small", "baseIri": EX, "prefix": "shop"}
    )
    assert response.status_code == 200, response.text
    project = response.json()["id"]
    manifest = project_store.manifest(project)
    manifest["documents"] = [d for d in manifest["documents"] if d["role"] != "shapes"]
    project_store.write_manifest(project, manifest)
    (project_store.folder(project) / "shapes.ttl").unlink()
    assert client.post(f"/api/projects/{project}/open").status_code == 200
    return project


def run(pid: str, command: str, dry_run: bool = False, **args):
    return client.post(
        f"/api/projects/{pid}/documents/model/commands",
        json={"command": command, "args": args, "dryRun": dry_run},
    )


def ok(pid: str, command: str, **args) -> dict:
    response = run(pid, command, **args)
    assert response.status_code == 200, response.text
    return response.json()


def doc(pid: str):
    return editing_service.document(pid, "model")


def graph_copy(pid: str) -> Graph:
    copy = Graph()
    for t in doc(pid).graph:
        copy.add(t)
    return copy


def revision(pid: str) -> int:
    return doc(pid).ontology.revision


def apply(pid: str, text: str):
    return client.put(f"/api/projects/{pid}/documents/model/source", json={"text": text})


def save(pid: str, **body):
    return client.post(f"/api/projects/{pid}/documents/model/save", json=body)


def model_text(pid: str) -> str:
    return (project_store.folder(pid) / "model.ttl").read_text(encoding="utf-8")


# --- AC-6: every command's delta, label and revision --------------------------------

# (command, args, triples that must be present afterwards, triples that must be
# gone, the label). Run in order on one project, so later rows use earlier ones.
COMMAND_CASES = [
    ("CreateClass", {"label": "Invoice", "parent": "shop:Organization"},
     [(U("Invoice"), RDF.type, OWL.Class), (U("Invoice"), RDFS.label, Literal("Invoice", lang="en")),
      (U("Invoice"), RDFS.subClassOf, U("Organization"))], [], "Created class Invoice"),
    ("CreateObjectProperty", {"label": "billed to", "domain": "shop:Invoice", "range": "shop:Person"},
     [(U("billedTo"), RDF.type, OWL.ObjectProperty), (U("billedTo"), RDFS.domain, U("Invoice")),
      (U("billedTo"), RDFS.range, U("Person"))], [], "Created object property billed to"),
    ("CreateDatatypeProperty", {"label": "total", "domain": "shop:Invoice", "datatype": "xsd:decimal"},
     [(U("total"), RDF.type, OWL.DatatypeProperty), (U("total"), RDFS.range, XSD.decimal)], [],
     "Created datatype property total"),
    ("CreateConcept", {"prefLabel": "Paid", "broader": None},
     [(U("Paid"), RDF.type, SKOS.Concept), (U("Paid"), SKOS.prefLabel, Literal("Paid", lang="en"))], [],
     "Created concept Paid"),
    ("CreateConcept", {"prefLabel": "Paid late", "broader": "shop:Paid"},
     [(U("PaidLate"), SKOS.broader, U("Paid"))], [], "Created concept Paid late"),
    ("SetLabel", {"iri": "shop:Invoice", "value": "Bill"},
     [(U("Invoice"), RDFS.label, Literal("Bill", lang="en"))],
     [(U("Invoice"), RDFS.label, Literal("Invoice", lang="en"))], "Set label of Invoice (en)"),
    ("SetComment", {"iri": "shop:Invoice", "value": "A request for payment."},
     [(U("Invoice"), RDFS.comment, Literal("A request for payment.", lang="en"))], [],
     "Set comment of Bill (en)"),
    ("AddSubClassOf", {"child": "shop:Invoice", "parent": "shop:Person"},
     [(U("Invoice"), RDFS.subClassOf, U("Person"))], [], "Made Bill a subclass of Person"),
    ("RemoveSubClassOf", {"child": "shop:Invoice", "parent": "shop:Person"},
     [], [(U("Invoice"), RDFS.subClassOf, U("Person"))], "Removed Bill as a subclass of Person"),
    ("SetDomain", {"property": "shop:billedTo", "target": "shop:Organization"},
     [(U("billedTo"), RDFS.domain, U("Organization"))], [(U("billedTo"), RDFS.domain, U("Invoice"))],
     "Set domain of billed to to Organization"),
    ("SetRange", {"property": "shop:billedTo", "target": "shop:Organization"},
     [(U("billedTo"), RDFS.range, U("Organization"))], [(U("billedTo"), RDFS.range, U("Person"))],
     "Set range of billed to to Organization"),
    ("SetEnds", {"property": "shop:billedTo", "domain": "shop:Invoice", "range": "shop:Person"},
     [(U("billedTo"), RDFS.domain, U("Invoice")), (U("billedTo"), RDFS.range, U("Person"))],
     [(U("billedTo"), RDFS.domain, U("Organization")), (U("billedTo"), RDFS.range, U("Organization"))],
     "Set the ends of billed to: from Bill to Person"),
    ("SwapEnds", {"property": "shop:billedTo"},
     [(U("billedTo"), RDFS.domain, U("Person")), (U("billedTo"), RDFS.range, U("Invoice"))],
     [(U("billedTo"), RDFS.domain, U("Invoice")), (U("billedTo"), RDFS.range, U("Person"))],
     "Swapped the ends of billed to"),
    # Relationships Stage B (Section 8): ends cleared, the other way round,
    # a characteristic, a more general relationship.
    ("ClearRange", {"property": "shop:billedTo"},
     [], [(U("billedTo"), RDFS.range, U("Invoice"))], "Cleared the end of billed to"),
    ("ClearDomain", {"property": "shop:billedTo"},
     [], [(U("billedTo"), RDFS.domain, U("Person"))], "Cleared the start of billed to"),
    ("SetInverse", {"property": "shop:memberOf", "label": "has member"},
     [(U("hasMember"), RDF.type, OWL.ObjectProperty), (U("hasMember"), OWL.inverseOf, U("memberOf")),
      (U("hasMember"), RDFS.domain, U("Organization")), (U("hasMember"), RDFS.range, U("Person"))], [],
     "Made has member the other way round of member of"),
    ("ClearInverse", {"property": "shop:memberOf"},
     [], [(U("hasMember"), OWL.inverseOf, U("memberOf"))], "Removed the other way round of member of"),
    ("SetCharacteristic", {"property": "shop:memberOf", "characteristic": "transitive", "on": True},
     [(U("memberOf"), RDF.type, OWL.TransitiveProperty)], [], 'Marked member of as "chains"'),
    ("AddSubPropertyOf", {"child": "shop:billedTo", "parent": "shop:memberOf"},
     [(U("billedTo"), RDFS.subPropertyOf, U("memberOf"))], [], "Made billed to a more specific kind of member of"),
    ("RemoveSubPropertyOf", {"child": "shop:billedTo", "parent": "shop:memberOf"},
     [], [(U("billedTo"), RDFS.subPropertyOf, U("memberOf"))], "Removed member of as more general than billed to"),
    ("CreateConcept", {"prefLabel": "Open"},
     [(U("Open"), RDF.type, SKOS.Concept)], [], "Created concept Open"),
    # Paid late is already narrower than Paid, so the broader row uses Open:
    # Paid under Paid late would now be refused as a loop (5.9).
    ("AddBroader", {"concept": "shop:Paid", "broader": "shop:Open"},
     [(U("Paid"), SKOS.broader, U("Open"))], [], "Made Paid narrower than Open"),
    ("RemoveBroader", {"concept": "shop:Paid", "broader": "shop:Open"},
     [], [(U("Paid"), SKOS.broader, U("Open"))], "Removed Open as broader of Paid"),
    ("AddRelated", {"concept": "shop:Paid", "related": "shop:Open"},
     [(U("Paid"), SKOS.related, U("Open")), (U("Open"), SKOS.related, U("Paid"))], [],
     "Related Paid to Open"),
    ("RemoveRelated", {"concept": "shop:Open", "related": "shop:Paid"},
     [], [(U("Paid"), SKOS.related, U("Open")), (U("Open"), SKOS.related, U("Paid"))],
     "Removed Paid as related to Open"),
    ("AddMapping", {"concept": "shop:Paid", "kind": "exactMatch", "target": "https://example.org/terms#Paid"},
     [(U("Paid"), SKOS.exactMatch, URIRef("https://example.org/terms#Paid"))], [],
     "Added an exact match of Paid: https://example.org/terms#Paid"),
    ("RemoveMapping", {"concept": "shop:Paid", "kind": "exactMatch", "target": "https://example.org/terms#Paid"},
     [], [(U("Paid"), SKOS.exactMatch, URIRef("https://example.org/terms#Paid"))],
     "Removed an exact match of Paid: https://example.org/terms#Paid"),
    ("AddAnnotation", {"iri": "shop:Invoice", "property": "skos:definition",
                       "value": {"kind": "text", "value": "An itemised bill."}},
     [(U("Invoice"), SKOS.definition, Literal("An itemised bill.", lang="en"))], [],
     "Added skos:definition to Bill"),
    ("ReplaceAnnotation", {"iri": "shop:Invoice", "property": "skos:definition",
                           "oldValue": {"kind": "text", "value": "An itemised bill."},
                           "newValue": {"kind": "text", "value": "A bill.", "lang": "en"}},
     [(U("Invoice"), SKOS.definition, Literal("A bill.", lang="en"))],
     [(U("Invoice"), SKOS.definition, Literal("An itemised bill.", lang="en"))],
     "Changed skos:definition of Bill"),
    ("RemoveAnnotation", {"iri": "shop:Invoice", "property": "skos:definition",
                          "value": {"kind": "text", "value": "A bill.", "lang": "en"}},
     [], [(U("Invoice"), SKOS.definition, Literal("A bill.", lang="en"))], "Removed skos:definition from Bill"),
    ("CreateAnnotationProperty", {"label": "reviewed on", "valueType": {"kind": "typed", "datatype": "xsd:date"}},
     [(U("reviewedOn"), RDF.type, OWL.AnnotationProperty), (U("reviewedOn"), RDFS.range, XSD.date)], [],
     "Created annotation property reviewed on"),
    ("RenameIri", {"old": "shop:total", "new": "shop:amount"},
     [(U("amount"), RDF.type, OWL.DatatypeProperty), (U("amount"), RDFS.domain, U("Invoice"))],
     [(U("total"), RDF.type, OWL.DatatypeProperty)], "Renamed shop:total to shop:amount"),
    ("DeleteEntity", {"iri": "shop:amount", "strategy": "orphan"},
     [], [(U("amount"), RDF.type, OWL.DatatypeProperty)], "Deleted datatype property total"),
    # shacl-authoring Stage B (5.8): an example of a class, filled in. The
    # small template brings Alice and Acme; Bob is made here (row S21).
    ("CreateExample", {"class": "shop:Person", "label": "Bob"},
     [(U("bob"), RDF.type, U("Person")), (U("bob"), RDF.type, OWL.NamedIndividual),
      (U("bob"), RDFS.label, Literal("Bob", lang="en"))], [], "Created example Bob of Person"),
    ("CreateDatatypeProperty", {"label": "birth date", "domain": "shop:Person", "datatype": "xsd:date"},
     [(U("birthDate"), RDFS.range, XSD.date)], [], "Created datatype property birth date"),
    ("SetExampleValue", {"iri": "shop:bob", "property": "shop:birthDate",
                         "value": {"kind": "typed", "value": "1990-05-01", "datatype": "xsd:date"}},
     [(U("bob"), U("birthDate"), Literal("1990-05-01", datatype=XSD.date))], [], "Set birth date of Bob"),
    ("AddExampleValue", {"iri": "shop:bob", "property": "shop:memberOf",
                         "value": {"kind": "link", "value": "shop:acme"}},
     [(U("bob"), U("memberOf"), U("acme"))], [], "Linked Bob to Acme by member of"),
    ("RemoveExampleValue", {"iri": "shop:bob", "property": "shop:memberOf",
                            "value": {"kind": "link", "value": "shop:acme"}},
     [], [(U("bob"), U("memberOf"), U("acme"))], "Removed the link from Bob to Acme by member of"),
]


def test_every_command_produces_its_triples_label_and_a_new_revision(pid):
    seen = set()
    for command, args, present, gone, label in COMMAND_CASES:
        args = {k: v for k, v in args.items() if v is not None}
        before_rev = revision(pid)
        before = graph_copy(pid)
        result = ok(pid, command, **args)
        seen.add(command)
        assert result["label"] == label, command
        assert result["revision"] == before_rev + 1, command
        graph = doc(pid).graph
        for t in present:
            assert t in graph, (command, t)
        for t in gone:
            assert t not in graph, (command, t)
        # The delta names exactly what changed, and the undo restores it.
        assert result["delta"]["addedTotal"] == len(set(graph) - set(before))
        assert result["delta"]["removedTotal"] == len(set(before) - set(graph))
    # The shape commands act on shapes.ttl and have their own cases below
    # (shacl-authoring Stage A).
    assert seen == set(editing.COMMANDS) - set(editing.SHAPE_COMMANDS), "a command in 5.4 has no case"


@pytest.mark.parametrize(
    "command,args,fragment",
    [
        ("CreateClass", {"label": "Person"}, "already used"),
        ("CreateClass", {"label": "X", "parent": "shop:Nothing"}, "no class shop:Nothing"),
        ("CreateClass", {}, "name in the project's primary language (en)"),
        ("CreateClass", {"label": "  "}, "primary language"),
        ("CreateClass", {"label": "X", "iri": "not an iri"}, "not an absolute IRI"),
        ("CreateClass", {"label": "X", "iri": "nope:X"}, "not an absolute IRI or a known prefixed name"),
        ("CreateObjectProperty", {"label": "p", "domain": "shop:Ghost"}, "no class shop:Ghost"),
        ("CreateDatatypeProperty", {"label": "d", "datatype": "shop:Person"}, "not an XML Schema datatype"),
        ("SetLabel", {"iri": "shop:Ghost", "value": "x"}, "no shop:Ghost"),
        ("SetLabel", {"iri": "shop:Person", "value": ""}, "cannot be empty"),
        ("SetLabel", {"iri": "shop:Person", "value": "x", "lang": "en_US"}, "well-formed language tag"),
        ("AddSubClassOf", {"child": "shop:Person", "parent": "shop:Person"}, "linked to itself"),
        ("RemoveSubClassOf", {"child": "shop:Person", "parent": "shop:Organization"}, "is not a subclass"),
        ("RenameIri", {"old": "shop:Person", "new": "shop:Organization"}, "already used"),
        ("RenameIri", {"old": "shop:Ghost", "new": "shop:Ghost2"}, "no shop:Ghost"),
        ("DeleteEntity", {"iri": "shop:Person", "strategy": "shred"}, "reparent"),
        ("SwapEnds", {"property": "shop:Ghost"}, "no relationship shop:Ghost"),
        ("SwapEnds", {"property": "shop:Person"}, "not a relationship"),
        ("SetEnds", {"property": "shop:memberOf"}, "Say which end to set"),
        ("SetEnds", {"property": "shop:memberOf", "domain": "shop:Ghost"}, "no class shop:Ghost"),
        ("ClearDomain", {"property": "shop:Person"}, "not a relationship or an attribute"),
        ("ClearInverse", {"property": "shop:memberOf"}, "no other way round"),
        ("SetInverse", {"property": "shop:memberOf", "inverse": "shop:memberOf"}, 'Use "Works both ways" instead'),
        ("SetInverse", {"property": "shop:memberOf", "inverse": "shop:Person"}, "not a relationship"),
        ("SetCharacteristic", {"property": "shop:memberOf", "characteristic": "sometimes", "on": True}, "is one of"),
        ("SetCharacteristic", {"property": "shop:memberOf", "characteristic": "functional"}, "on or off"),
        ("SetCharacteristic", {"property": "shop:memberOf", "characteristic": "functional", "on": False},
         'is not "at most one"'),
        ("AddSubPropertyOf", {"child": "shop:memberOf", "parent": "shop:memberOf"}, "more specific kind of itself"),
        ("AddSubPropertyOf", {"child": "shop:memberOf", "parent": "shop:Ghost"}, "no relationship shop:Ghost"),
        ("AddRelated", {"concept": "shop:Person", "related": "shop:Organization"}, "not a concept"),
        ("AddMapping", {"concept": "shop:Person", "kind": "exactMatch", "target": "https://x.org/a"}, "no concept"),
        ("NoSuchCommand", {}, "no command called NoSuchCommand"),
    ],
)
def test_an_invalid_command_is_refused_with_a_sentence_and_changes_nothing(pid, command, args, fragment):
    before, before_rev = graph_copy(pid), revision(pid)
    response = run(pid, command, **args)
    assert response.status_code == 422, response.text
    assert fragment in response.json()["detail"]
    assert revision(pid) == before_rev
    assert isomorphic(doc(pid).graph, before)


# --- AC-6a: typed annotation values --------------------------------------------------

TYPED = [
    ("xsd:string", "Imran"), ("xsd:integer", "42"), ("xsd:decimal", "4.5"),
    ("xsd:boolean", "true"), ("xsd:date", "2026-09-28"), ("xsd:dateTime", "2026-09-28T09:30:00Z"),
    ("xsd:anyURI", "https://example.org/spec"),
]


def test_each_offered_datatype_round_trips_through_save_and_reload(pid):
    props = []
    for i, (datatype, value) in enumerate(TYPED):
        prop = f"shop:note{i}"
        ok(pid, "CreateAnnotationProperty", iri=prop)
        ok(pid, "AddAnnotation", iri="shop:Person", property=prop,
           value={"kind": "typed", "value": value, "datatype": datatype})
        props.append((U(f"note{i}"), datatype, value))
    ok(pid, "AddAnnotation", iri="shop:Person", property="rdfs:seeAlso",
       value={"kind": "link", "value": "https://example.org/people"})
    ok(pid, "AddAnnotation", iri="shop:Person", property="skos:altLabel",
       value={"kind": "text", "value": "Personne", "lang": "fr"})
    # What the command stored. rdflib normalises some lexical forms as the
    # literal is made (a dateTime's Z becomes +00:00, the same instant), so the
    # round trip is measured from the stored term, not from the typed text.
    stored_before = {prop: list(doc(pid).graph.objects(U("Person"), prop)) for prop, _, _ in props}
    assert save(pid).status_code == 200
    client.post(f"/api/projects/{pid}/close")
    client.post(f"/api/projects/{pid}/open")
    graph = doc(pid).graph
    for prop, datatype, value in props:
        stored = list(graph.objects(U("Person"), prop))
        expected = Literal(value, datatype=editing.OFFERED_DATATYPES[datatype.split(":")[1]])
        assert stored == stored_before[prop], (datatype, stored, stored_before[prop])
        assert stored == [expected] and stored[0].datatype == expected.datatype, datatype
        assert stored[0].eq(expected), datatype
    assert (U("Person"), RDFS.seeAlso, URIRef("https://example.org/people")) in graph
    assert (U("Person"), SKOS.altLabel, Literal("Personne", lang="fr")) in graph


@pytest.mark.parametrize(
    "value,fragment",
    [
        ({"kind": "typed", "value": "2026-13-01", "datatype": "xsd:date"},
         '"2026-13-01" is not a valid date (expected YYYY-MM-DD)'),
        ({"kind": "typed", "value": "2026-02-30", "datatype": "xsd:date"}, "not a valid date"),
        ({"kind": "typed", "value": "4.5", "datatype": "xsd:integer"}, '"4.5" is not a valid integer'),
        ({"kind": "typed", "value": "yes", "datatype": "xsd:boolean"}, '"yes" is not a valid boolean'),
        ({"kind": "typed", "value": "4,5", "datatype": "xsd:decimal"}, "not a valid decimal"),
        ({"kind": "typed", "value": "2026-09-28 10:00", "datatype": "xsd:dateTime"}, "not a valid date and time"),
        ({"kind": "typed", "value": "a b", "datatype": "xsd:anyURI"}, "not a valid URI"),
        ({"kind": "typed", "value": "1", "datatype": "xsd:float"}, "not one of the offered datatypes"),
        ({"kind": "text", "value": "x", "lang": "english"}, "well-formed language tag"),
        ({"kind": "text", "value": "x", "lang": "en", "datatype": "xsd:string"}, "both a language and a datatype"),
        ({"kind": "typed", "value": "x", "lang": "en", "datatype": "xsd:string"}, "both a language and a datatype"),
        ({"kind": "link", "value": "not a link"}, "not an absolute IRI"),
        ({"kind": "colour", "value": "red"}, "text, typed or link"),
    ],
)
def test_an_invalid_value_is_refused_and_changes_nothing(pid, value, fragment):
    before, before_rev = graph_copy(pid), revision(pid)
    response = run(pid, "AddAnnotation", iri="shop:Person", property="rdfs:comment", value=value)
    assert response.status_code == 422
    assert fragment in response.json()["detail"]
    assert revision(pid) == before_rev and isomorphic(doc(pid).graph, before)


def test_a_second_pref_label_in_one_language_is_refused(pid):
    ok(pid, "CreateConcept", prefLabel="Open")
    response = run(pid, "AddAnnotation", iri="shop:Open", property="skos:prefLabel",
                   value={"kind": "text", "value": "Ouvert-en", "lang": "en"})
    assert response.status_code == 422
    assert "at most one per language" in response.json()["detail"]
    assert "ReplaceAnnotation" in response.json()["detail"]
    # Another language is fine, and replacing in place is one step.
    ok(pid, "AddAnnotation", iri="shop:Open", property="skos:prefLabel",
       value={"kind": "text", "value": "Ouvert", "lang": "fr"})
    ok(pid, "ReplaceAnnotation", iri="shop:Open", property="skos:prefLabel",
       oldValue={"kind": "text", "value": "Open", "lang": "en"},
       newValue={"kind": "text", "value": "Opened", "lang": "en"})
    labels = set(doc(pid).graph.objects(U("Open"), SKOS.prefLabel))
    assert labels == {Literal("Opened", lang="en"), Literal("Ouvert", lang="fr")}


def test_the_suggested_list_has_the_fixed_entries_and_every_declared_property(pid):
    ok(pid, "CreateAnnotationProperty", label="audited", valueType={"kind": "typed", "datatype": "xsd:boolean"})
    # An import that declares an annotation property: a library ontology the
    # model imports, mapped locally so nothing connects.
    lib = client.post(
        "/api/ontologies/upload",
        files={"file": ("lib.ttl", b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/lib> a owl:Ontology .
<http://example.org/lib#source> a owl:AnnotationProperty ; rdfs:range rdfs:Resource .
""")},
    ).json()["id"]
    current = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    apply(pid, current + "\n<http://example.org/shop> <http://www.w3.org/2002/07/owl#imports> <http://example.org/lib> .\n")
    oid = f"{pid}-model"
    mapped = client.post(f"/api/ontologies/{oid}/imports/mapping", json={"iri": "http://example.org/lib", "ontologyId": lib})
    assert mapped.status_code == 200, mapped.text

    listed = client.get(f"/api/projects/{pid}/documents/model/annotation-properties").json()
    by_iri = {p["iri"]: p for p in listed}
    fixed = {
        str(SKOS.definition): {"kind": "text"},
        str(SKOS.example): {"kind": "text"},
        str(RDFS.seeAlso): {"kind": "link"},
        str(DCTERMS.created): {"kind": "typed", "datatype": "xsd:date"},
        str(OWL.deprecated): {"kind": "typed", "datatype": "xsd:boolean"},
        str(OWL.versionInfo): {"kind": "typed", "datatype": "xsd:string"},
    }
    for iri, default in fixed.items():
        assert by_iri[iri]["defaultType"] == default and by_iri[iri]["source"] == "suggested"
    assert len([p for p in listed if p["source"] == "suggested"]) == 22
    assert by_iri[EX + "audited"]["defaultType"] == {"kind": "typed", "datatype": "xsd:boolean"}
    assert by_iri[EX + "audited"]["source"] == "document"
    assert by_iri["http://example.org/lib#source"] == {
        "iri": "http://example.org/lib#source", "prefixed": by_iri["http://example.org/lib#source"]["prefixed"],
        "defaultType": {"kind": "link"}, "source": "import",
    }


# --- AC-15: IRIs minted from labels ----------------------------------------------------


def test_iris_are_minted_from_labels_editable_and_never_follow_a_label(pid):
    ok(pid, "CreateClass", label="Invoice item")
    ok(pid, "CreateObjectProperty", label="has part")
    ok(pid, "CreateClass", label="Custom", iri="http://example.org/other#Chosen")
    graph = doc(pid).graph
    assert (U("InvoiceItem"), RDF.type, OWL.Class) in graph
    assert (U("hasPart"), RDF.type, OWL.ObjectProperty) in graph
    assert (URIRef("http://example.org/other#Chosen"), RDF.type, OWL.Class) in graph
    ok(pid, "SetLabel", iri="shop:InvoiceItem", value="Line item")
    assert (U("InvoiceItem"), RDFS.label, Literal("Line item", lang="en")) in graph
    assert not list(graph.triples((U("LineItem"), None, None)))


# --- rename and delete (AC-7) ------------------------------------------------------------


def test_rename_rewrites_every_mention_as_one_undo(pid):
    before = graph_copy(pid)
    ok(pid, "RenameIri", old="shop:Person", new="shop:Human")
    graph = doc(pid).graph
    assert not list(graph.triples((U("Person"), None, None)))
    assert (U("memberOf"), RDFS.domain, U("Human")) in graph
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert isomorphic(doc(pid).graph, before)


@pytest.fixture
def tree(pid) -> str:
    """Animal > Mammal > Dog, Cat; a property ranging over Mammal; Rex a Mammal."""
    apply(pid, f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
shop:Animal a owl:Class ; rdfs:label "Animal"@en .
shop:Mammal a owl:Class ; rdfs:label "Mammal"@en ; rdfs:subClassOf shop:Animal ,
    [ a owl:Restriction ; owl:onProperty shop:eats ; owl:someValuesFrom shop:Animal ] .
shop:Dog a owl:Class ; rdfs:label "Dog"@en ; rdfs:subClassOf shop:Mammal .
shop:Cat a owl:Class ; rdfs:label "Cat"@en ; rdfs:subClassOf shop:Mammal .
shop:feeds a owl:ObjectProperty ; rdfs:label "feeds"@en ; rdfs:range shop:Mammal .
shop:eats a owl:ObjectProperty ; rdfs:label "eats"@en .
shop:rex a shop:Mammal ; rdfs:label "Rex"@en .
""")
    return pid


def test_delete_dry_run_returns_the_impact_and_changes_nothing(tree):
    before, before_rev = graph_copy(tree), revision(tree)
    response = run(tree, "DeleteEntity", dry_run=True, iri="shop:Mammal", strategy="reparent")
    assert response.status_code == 200
    impact = response.json()["impact"]
    assert impact["kind"] == "class"
    assert [c["label"] for c in impact["children"]] == ["Cat", "Dog"]
    assert [p["label"] for p in impact["reparentedTo"]] == ["Animal"]
    assert impact["properties"] == [{"iri": EX + "feeds", "label": "feeds", "role": "range", "kind": "object property"}]
    assert [i["label"] for i in impact["individuals"]] == ["Rex"]
    # label, type, subClassOf x2 (Animal and the restriction), the restriction's
    # three triples, Dog and Cat's subClassOf, feeds' range, Rex's type.
    assert impact["statements"] == 11
    assert impact["importMentions"] == 0
    assert revision(tree) == before_rev and isomorphic(doc(tree).graph, before)


def test_delete_with_reparent_moves_the_children_up(tree):
    ok(tree, "DeleteEntity", iri="shop:Mammal", strategy="reparent")
    graph = doc(tree).graph
    assert (U("Dog"), RDFS.subClassOf, U("Animal")) in graph
    assert (U("Cat"), RDFS.subClassOf, U("Animal")) in graph
    assert not list(graph.triples((U("Mammal"), None, None)))
    assert not list(graph.triples((None, None, U("Mammal"))))
    # The restriction went with it rather than being left as debris.
    assert not [s for s in graph.subjects(RDF.type, OWL.Restriction)]


def test_delete_with_orphan_leaves_the_children_as_roots(tree):
    ok(tree, "DeleteEntity", iri="shop:Mammal", strategy="orphan")
    graph = doc(tree).graph
    assert not list(graph.objects(U("Dog"), RDFS.subClassOf))
    assert (U("Dog"), RDF.type, OWL.Class) in graph


def test_delete_counts_mentions_in_a_read_only_import(pid):
    lib = client.post(
        "/api/ontologies/upload",
        files={"file": ("lib2.ttl", f"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/lib2> a owl:Ontology .
<http://example.org/lib2#Staff> rdfs:subClassOf <{EX}Person> .
""".encode())},
    ).json()["id"]
    apply(pid, model_text(pid) + "\n<http://example.org/shop> <http://www.w3.org/2002/07/owl#imports> <http://example.org/lib2> .\n")
    client.post(f"/api/ontologies/{pid}-model/imports/mapping", json={"iri": "http://example.org/lib2", "ontologyId": lib})
    impact = run(pid, "DeleteEntity", dry_run=True, iri="shop:Person").json()["impact"]
    assert impact["importMentions"] == 1


# --- AC-10: undo and redo ---------------------------------------------------------------


def test_undo_and_redo_restore_the_exact_graph_for_every_command_and_an_apply(pid):
    snapshots = [graph_copy(pid)]
    for command, args, *_ in COMMAND_CASES:
        ok(pid, command, **{k: v for k, v in args.items() if v is not None})
        snapshots.append(graph_copy(pid))
    assert apply(pid, model_text(pid)).status_code == 200  # the file, as a whole replacement
    snapshots.append(graph_copy(pid))

    for expected in reversed(snapshots[:-1]):
        response = client.post(f"/api/projects/{pid}/documents/model/undo")
        assert response.status_code == 200
        assert isomorphic(doc(pid).graph, expected)
    assert client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 422
    for expected in snapshots[1:]:
        response = client.post(f"/api/projects/{pid}/documents/model/redo")
        assert response.status_code == 200
        assert isomorphic(doc(pid).graph, expected)


def test_undo_answers_what_was_undone_and_what_comes_next(pid):
    ok(pid, "CreateClass", label="First")
    ok(pid, "CreateClass", label="Second")
    undone = client.post(f"/api/projects/{pid}/documents/model/undo").json()
    assert undone["label"] == "Created class Second"
    assert undone["state"]["undoLabel"] == "Created class First"
    assert undone["state"]["redoLabel"] == "Created class Second"
    # A new change clears the redo stack.
    ok(pid, "CreateClass", label="Third")
    assert doc(pid).state()["canRedo"] is False


def test_the_undo_stack_is_capped_at_200(pid):
    for i in range(205):
        ok(pid, "CreateClass", label=f"Class {i}")
    count = 0
    while client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200:
        count += 1
    assert count == 200
    graph = doc(pid).graph
    # The first five changes are beyond the cap and stay applied.
    assert all((U(f"Class{i}"), RDF.type, OWL.Class) in graph for i in range(5))
    assert (U("Class5"), RDF.type, OWL.Class) not in graph


def test_every_change_bumps_the_revision_once(pid):
    start = revision(pid)
    ok(pid, "CreateClass", label="A")
    apply(pid, model_text(pid))
    client.post(f"/api/projects/{pid}/documents/model/undo")
    client.post(f"/api/projects/{pid}/documents/model/redo")
    assert revision(pid) == start + 4


# --- AC-8: the Turtle apply ---------------------------------------------------------------


def test_valid_turtle_replaces_the_document_as_one_undoable_step(pid):
    before = graph_copy(pid)
    text = f"@prefix shop: <{EX}> .\n# typed by hand\nshop:Only a <http://www.w3.org/2002/07/owl#Class> .\n"
    response = apply(pid, text)
    assert response.status_code == 200
    assert len(doc(pid).graph) == 1
    source = client.get(f"/api/projects/{pid}/documents/model/source").json()
    assert source["text"] == text and source["fromEditor"] is True
    client.post(f"/api/projects/{pid}/documents/model/undo")
    assert isomorphic(doc(pid).graph, before)


def test_invalid_turtle_changes_nothing_and_reports_line_and_column(pid):
    before, before_rev = graph_copy(pid), revision(pid)
    response = apply(pid, f"@prefix shop: <{EX}> .\nshop:A a shop:B .\nshop:C shop:d \n  shop:e shop:f .\n")
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["line"] == 4 and detail["column"] == 10
    assert detail["message"].startswith("Line 4, column 10:")
    assert "Bad syntax" in detail["detail"]
    assert revision(pid) == before_rev and isomorphic(doc(pid).graph, before)


def test_the_apply_body_is_capped_while_reading(pid, monkeypatch):
    from app.routers import ontologies

    monkeypatch.setattr(ontologies, "MAX_UPLOAD_BYTES", 1000)
    before_rev = revision(pid)
    big = "# " + "x" * 5000
    # Declared: refused by the middleware before the body is read.
    declared = client.put(f"/api/projects/{pid}/documents/model/source", json={"text": big})
    assert declared.status_code == 413
    # Undeclared (chunked): refused by the read cap in the route.
    def body():
        yield json.dumps({"text": big}).encode()

    chunked = client.put(
        f"/api/projects/{pid}/documents/model/source", content=body(),
        headers={"Content-Type": "application/json"},
    )
    assert chunked.status_code == 413
    assert revision(pid) == before_rev


# --- AC-11 and AC-12: saving ---------------------------------------------------------------


def test_after_only_editor_changes_save_writes_the_text_exactly(pid):
    text = f"@prefix shop: <{EX}> .\n\n# my own layout\nshop:A   a   <http://www.w3.org/2002/07/owl#Class> .   # trailing\n"
    apply(pid, text)
    assert save(pid).json()["savedAt"]
    assert model_text(pid) == text
    assert not doc(pid).dirty


def test_after_a_command_save_writes_longturtle_identical_for_identical_graphs(pid):
    ok(pid, "CreateClass", label="Zebra")
    save(pid)
    first = model_text(pid)
    reparsed = Graph().parse(data=first, format="turtle")
    assert first == reparsed.serialize(format="longturtle")
    # Undo then redo: the same graph, so the same bytes.
    client.post(f"/api/projects/{pid}/documents/model/undo")
    client.post(f"/api/projects/{pid}/documents/model/redo")
    save(pid)
    assert model_text(pid) == first


def test_the_first_visual_save_of_a_commented_file_warns_once_and_keeps_the_original(pid):
    folder = project_store.folder(pid)
    commented = f"@prefix shop: <{EX}> .\n# keep me\nshop:A a <http://www.w3.org/2002/07/owl#Class> .\n"
    apply(pid, commented)
    save(pid)
    assert model_text(pid) == commented
    ok(pid, "CreateClass", label="Visual")
    warned = save(pid).json()
    assert warned == {"needsCommentsWarning": True, "backup": "model.original.ttl"}
    assert model_text(pid) == commented, "nothing is written before confirmation"
    assert not (folder / "model.original.ttl").exists()
    confirmed = save(pid, confirmRewrite=True).json()
    assert "savedAt" in confirmed
    assert (folder / "model.original.ttl").read_text(encoding="utf-8") == commented
    assert "# keep me" not in model_text(pid)
    assert json.loads((folder / "project.json").read_text(encoding="utf-8"))["commentsWarned"] is True
    # Once per project: a later commented file is rewritten without asking.
    apply(pid, commented)
    save(pid)
    ok(pid, "CreateClass", label="Again")
    assert "savedAt" in save(pid).json()


def test_save_refreshes_the_manifest_counts(pid):
    ok(pid, "CreateClass", label="Counted")
    save(pid)
    listed = {p["id"]: p for p in client.get("/api/projects").json()}[pid]
    assert listed["counts"]["classes"] == 3


def test_save_a_copy_follows_the_format_rule_and_touches_nothing(pid):
    ok(pid, "CreateClass", label="Copied")
    before_file = model_text(pid)
    response = client.get(f"/api/projects/{pid}/documents/model/download")
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/turtle")
    assert b"Copied" in response.content
    assert response.text == doc(pid).graph.serialize(format="longturtle")
    assert model_text(pid) == before_file and doc(pid).dirty


@pytest.mark.parametrize(
    "text,expected",
    [
        ("<http://a#b> <http://c> <http://d#e> .", False),
        ('<http://a> <http://b> "a # not a comment" .', False),
        ('<http://a> <http://b> """line\n# still a string\n""" .', False),
        ("<http://a> <http://b> 'x\\'#' .", False),
        ("# a comment\n<http://a> <http://b> <http://c> .", True),
        ("<http://a> <http://b> <http://c> . # trailing", True),
    ],
)
def test_has_comments_ignores_hashes_in_iris_and_strings(text, expected):
    assert has_comments(text) is expected


# --- AC-13: autosave and recovery -----------------------------------------------------------


def _wait_for(predicate, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def test_autosave_is_never_on_the_request_path(pid, monkeypatch):
    """Section 10's count test: the command returns before any draft exists."""
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.3)
    written = editing_service.drafts_written
    draft = project_store.folder(pid) / ".draft" / "model.ttl"
    ok(pid, "CreateClass", label="Drafted")
    assert editing_service.drafts_written == written, "the command wrote the draft itself"
    assert not draft.exists()
    assert _wait_for(lambda: editing_service.drafts_written == written + 1)
    assert "Drafted" in draft.read_text(encoding="utf-8")
    # Save removes it.
    save(pid)
    assert not draft.exists()


def test_autosave_waits_for_the_last_change(pid, monkeypatch):
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.3)
    written = editing_service.drafts_written
    for i in range(4):
        ok(pid, "CreateClass", label=f"Burst {i}")
    assert _wait_for(lambda: editing_service.drafts_written > written)
    time.sleep(0.4)
    assert editing_service.drafts_written == written + 1, "one draft for a burst of changes"


def _crash(pid: str) -> None:
    """What a killed server leaves: files on disk, nothing in memory."""
    documents = editing_service._open.pop(pid)
    for document in documents.values():
        editing_service._cancel(document)
        editing_service.store.unregister_document(document.ontology.id)


def test_recovery_restores_the_draft_as_unsaved_content(pid, monkeypatch):
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.05)
    ok(pid, "CreateClass", label="Survivor")
    expected = graph_copy(pid)
    draft = project_store.folder(pid) / ".draft" / "model.ttl"
    assert _wait_for(draft.exists)
    _crash(pid)

    opened = client.post(f"/api/projects/{pid}/open").json()
    assert opened["recovery"]["available"] is True and opened["recovery"]["draftTime"]
    assert (U("Survivor"), RDF.type, OWL.Class) not in doc(pid).graph
    recovered = client.post(f"/api/projects/{pid}/recover", json={"action": "recover"}).json()
    state = recovered["documents"][0]
    assert state["dirty"] is True and state["canUndo"] is False
    assert isomorphic(doc(pid).graph, expected)
    # Recovered from a visual change, so a save writes clean Turtle.
    save(pid)
    assert "Survivor" in model_text(pid) and not draft.exists()


def test_discarding_a_draft_removes_it(pid, monkeypatch):
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.05)
    ok(pid, "CreateClass", label="Forgotten")
    draft = project_store.folder(pid) / ".draft" / "model.ttl"
    assert _wait_for(draft.exists)
    _crash(pid)
    client.post(f"/api/projects/{pid}/open")
    client.post(f"/api/projects/{pid}/recover", json={"action": "discard"})
    assert not draft.exists()
    assert client.post(f"/api/projects/{pid}/open").json()["recovery"]["available"] is False


def test_closing_with_unsaved_changes_needs_discard(pid):
    ok(pid, "CreateClass", label="Pending")
    assert client.post(f"/api/projects/{pid}/close").status_code == 409
    assert client.post(f"/api/projects/{pid}/close", json={"discard": True}).status_code == 200
    reopened = client.post(f"/api/projects/{pid}/open").json()
    assert reopened["recovery"]["available"] is False
    assert (U("Pending"), RDF.type, OWL.Class) not in doc(pid).graph


# --- AC-18: saved queries in a project ------------------------------------------------------


def test_queries_saved_in_a_project_live_in_its_folder_and_are_listed_only_there(pid):
    oid = f"{pid}-model"
    saved = client.post(
        "/api/queries",
        json={"name": "Classes", "ontologyId": oid, "state": None, "sparql": "SELECT * WHERE { ?s ?p ?o }", "mode": "text"},
    )
    assert saved.status_code == 200, saved.text
    qid = saved.json()["id"]
    assert (project_store.folder(pid) / "queries" / f"{qid}.json").is_file()
    assert [q["id"] for q in client.get("/api/queries", params={"ontology": oid}).json()] == [qid]
    assert qid not in [q["id"] for q in client.get("/api/queries").json()]
    assert client.delete(f"/api/queries/{qid}").status_code == 200
    assert not (project_store.folder(pid) / "queries" / f"{qid}.json").exists()


# --- Section 10: budgets on a 10,000-triple document -----------------------------------------


def _big_document(pid: str, triples: int = 10_000) -> str:
    lines = [f"@prefix shop: <{EX}> .", "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
             "@prefix owl: <http://www.w3.org/2002/07/owl#> ."]
    count = 0
    i = 0
    while count < triples:
        lines.append(f'shop:C{i} a owl:Class ; rdfs:label "Class {i}"@en ; rdfs:subClassOf shop:C{i // 2} .')
        count += 3
        i += 1
    return "\n".join(lines) + "\n"


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


@pytest.fixture
def big(pid) -> str:
    text = _big_document(pid)
    assert apply(pid, text).status_code == 200
    assert len(doc(pid).graph) >= 10_000
    return pid


@pytest.mark.perf
def test_command_budget(big):
    counter = iter(range(100))
    median = _median_ms(lambda: ok(big, "CreateClass", label=f"Timed {next(counter)}", parent="shop:C7"))
    assert median <= limit_ms(50), f"a command took {median:.1f} ms (median of 5)"


@pytest.mark.perf
def test_undo_budget(big):
    for i in range(5):
        ok(big, "CreateClass", label=f"Undone {i}")
    median = _median_ms(lambda: client.post(f"/api/projects/{big}/documents/model/undo"))
    assert median <= limit_ms(50), f"an undo took {median:.1f} ms (median of 5)"


@pytest.mark.perf
def test_apply_budget(pid):
    text = _big_document(pid)
    median = _median_ms(lambda: apply(pid, text))
    assert len(doc(pid).graph) >= 10_000
    assert median <= limit_ms(1500), f"applying 10,000 triples took {median:.0f} ms (median of 5)"


@pytest.mark.perf
def test_save_budget(big):
    counter = iter(range(100))
    median = _median_ms(
        lambda: save(big),
        setup=lambda: ok(big, "CreateClass", label=f"Saved {next(counter)}"),
    )
    assert median <= limit_ms(1000), f"saving clean Turtle took {median:.0f} ms (median of 5)"


def test_autosave_off_path(big, monkeypatch):
    """Section 10 row 6, on the budget document: the command returns first."""
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.2)
    written = editing_service.drafts_written
    ok(big, "CreateClass", label="Big draft")
    assert editing_service.drafts_written == written
    assert _wait_for(lambda: editing_service.drafts_written == written + 1, 15)


# --- found in code review -------------------------------------------------------------


@pytest.mark.parametrize(
    "command,args",
    [
        ("SetLabel", {"iri": "shop:Person", "value": "Person"}),
        ("SetComment", {"iri": "shop:Person", "value": "A human being."}),
        ("SetDomain", {"property": "shop:memberOf", "target": "shop:Person"}),
        ("SetRange", {"property": "shop:memberOf", "target": "shop:Organization"}),
    ],
)
def test_setting_a_value_to_what_it_already_is_deletes_nothing(pid, command, args):
    """The first _change dropped a triple that was in both adds and removes."""
    before, before_rev = graph_copy(pid), revision(pid)
    response = run(pid, command, **args)
    assert response.status_code == 422 and "change nothing" in response.json()["detail"]
    assert revision(pid) == before_rev and isomorphic(doc(pid).graph, before)


def test_replacing_an_annotation_with_itself_keeps_it(pid):
    value = {"kind": "text", "value": "A human being.", "lang": "en"}
    response = run(pid, "ReplaceAnnotation", iri="shop:Person", property="rdfs:comment", oldValue=value, newValue=value)
    assert response.status_code == 422
    assert (U("Person"), RDFS.comment, Literal("A human being.", lang="en")) in doc(pid).graph


def test_delete_takes_a_restriction_on_another_class_whole(pid):
    apply(pid, f"""@prefix shop: <{EX}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
shop:Invoice a owl:Class ; rdfs:label "Invoice"@en .
shop:hasLine a owl:ObjectProperty ; rdfs:label "has line"@en .
shop:Order a owl:Class ; rdfs:label "Order"@en ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty shop:hasLine ; owl:someValuesFrom shop:Invoice ] ;
    owl:equivalentClass [ owl:unionOf ( shop:Invoice shop:Order ) ] .
""")
    impact = run(pid, "DeleteEntity", dry_run=True, iri="shop:Invoice").json()["impact"]
    ok(pid, "DeleteEntity", iri="shop:Invoice", strategy="orphan")
    graph = doc(pid).graph
    assert not [s for s in graph.subjects(RDF.type, OWL.Restriction)], "a restriction with no filler was left"
    assert not list(graph.objects(U("Order"), RDFS.subClassOf))
    assert not list(graph.objects(U("Order"), OWL.equivalentClass))
    assert not [t for t in graph if isinstance(t[0], BNode)], "debris left behind"
    assert (U("Order"), RDFS.label, Literal("Order", lang="en")) in graph
    # Its own two, the restriction and the statement to it (4), the union and
    # the statement to it (2), and the two list cells (4).
    assert impact["statements"] == 2 + 4 + 2 + 4


def test_a_draft_serialised_during_a_save_is_not_written(pid, monkeypatch):
    """The timer serialises outside the lock; a save in that window must win."""
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 60)
    ok(pid, "CreateClass", label="Raced")
    document = doc(pid)
    generation = document.generation
    real = editing.clean_turtle
    fired = []

    def racing(graph):
        if not fired:
            fired.append(True)
            assert save(pid).status_code == 200
        return real(graph)

    monkeypatch.setattr(editing, "clean_turtle", racing)
    editing_service._write_draft(document, generation)
    assert fired
    assert not (project_store.folder(pid) / ".draft" / "model.ttl").exists()


def test_a_duplicate_owns_its_saved_queries(pid):
    oid = f"{pid}-model"
    qid = client.post(
        "/api/queries",
        json={"name": "Q", "ontologyId": oid, "state": None, "sparql": "SELECT * WHERE { ?s ?p ?o }", "mode": "text"},
    ).json()["id"]
    copy = client.post(f"/api/projects/{pid}/duplicate").json()["id"]
    copied = client.get("/api/queries", params={"ontology": f"{copy}-model"}).json()
    assert len(copied) == 1 and copied[0]["id"] != qid and copied[0]["ontologyId"] == f"{copy}-model"
    assert client.delete(f"/api/queries/{qid}").status_code == 200
    assert client.get("/api/queries", params={"ontology": oid}).json() == []
    assert [q["id"] for q in client.get("/api/queries", params={"ontology": f"{copy}-model"}).json()] == [copied[0]["id"]]


def test_a_command_builds_the_imports_view_only_when_it_needs_it(pid, monkeypatch):
    from app.imports import imports_service

    lib = client.post(
        "/api/ontologies/upload",
        files={"file": ("lib3.ttl", b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<http://example.org/lib3> a owl:Ontology .
<http://example.org/lib3#Party> a owl:Class .
""")},
    ).json()["id"]
    current = client.get(f"/api/projects/{pid}/documents/model/source").json()["text"]
    apply(pid, current + "\n<http://example.org/shop> <http://www.w3.org/2002/07/owl#imports> <http://example.org/lib3> .\n")
    client.post(f"/api/ontologies/{pid}-model/imports/mapping", json={"iri": "http://example.org/lib3", "ontologyId": lib})
    calls = []
    real = imports_service.merged
    monkeypatch.setattr(imports_service, "merged", lambda *a, **k: calls.append(1) or real(*a, **k))
    ok(pid, "CreateClass", label="Local", parent="shop:Person")
    assert calls == []
    ok(pid, "CreateClass", label="Imported child", parent="http://example.org/lib3#Party")
    assert calls, "a target only an import defines was not looked up there"


# --- visual-modeling Stage 1: the save point (AC-8) and apply keeping its text (AC-9) ------


def _state(pid: str) -> dict:
    return doc(pid).state()


def undo(pid: str) -> dict:
    response = client.post(f"/api/projects/{pid}/documents/model/undo")
    assert response.status_code == 200, response.text
    return response.json()


def redo(pid: str) -> dict:
    response = client.post(f"/api/projects/{pid}/documents/model/redo")
    assert response.status_code == 200, response.text
    return response.json()


def test_undoing_back_to_the_saved_state_is_clean(pid):
    ok(pid, "CreateClass", label="Kept")
    save(pid)
    ok(pid, "CreateClass", label="Extra")
    assert _state(pid)["dirty"] is True
    assert undo(pid)["state"]["dirty"] is False
    # Redo leaves the save point, and undo returns to it.
    assert redo(pid)["state"]["dirty"] is True
    assert undo(pid)["state"]["dirty"] is False
    # Clean means clean: closing needs no discard.
    assert client.post(f"/api/projects/{pid}/close").status_code == 200


def test_redoing_back_to_the_saved_state_is_clean(pid):
    ok(pid, "CreateClass", label="Saved here")
    save(pid)
    assert undo(pid)["state"]["dirty"] is True
    assert redo(pid)["state"]["dirty"] is False


def test_undoing_everything_since_opening_is_clean(pid):
    ok(pid, "CreateClass", label="One")
    ok(pid, "CreateClass", label="Two")
    undo(pid)
    assert undo(pid)["state"]["dirty"] is False
    assert client.post(f"/api/projects/{pid}/close").status_code == 200


def test_the_save_point_leaves_nothing_to_recover(pid, monkeypatch):
    monkeypatch.setattr(editing, "AUTOSAVE_DELAY", 0.05)
    ok(pid, "CreateClass", label="Drafted")
    draft = project_store.folder(pid) / ".draft" / "model.ttl"
    assert _wait_for(draft.exists)
    undo(pid)
    assert not draft.exists()
    time.sleep(0.2)
    assert not draft.exists(), "no timer left armed writes it back"
    _crash(pid)
    assert client.post(f"/api/projects/{pid}/open").json()["recovery"]["available"] is False


def test_a_new_change_after_an_undo_drops_a_save_point_on_the_redo_branch(pid):
    ok(pid, "CreateClass", label="Saved branch")
    save(pid)
    undo(pid)
    ok(pid, "CreateClass", label="Other branch")
    # The saved state is gone with the redo branch: nothing leads back to it.
    assert undo(pid)["state"]["dirty"] is True


def test_the_undo_cap_drops_a_save_point_it_can_no_longer_reach(pid):
    for i in range(201):
        ok(pid, "CreateClass", label=f"Capped {i}")
    while client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200:
        pass
    # The opened state was one step below the 200 kept; it is not reached.
    assert _state(pid)["dirty"] is True


def test_the_undo_cap_keeps_a_save_point_at_the_new_bottom(pid):
    ok(pid, "CreateClass", label="Saved first")
    save(pid)
    for i in range(200):
        ok(pid, "CreateClass", label=f"Later {i}")
    while client.post(f"/api/projects/{pid}/documents/model/undo").status_code == 200:
        pass
    assert _state(pid)["dirty"] is False


def test_apply_undo_save_writes_the_file_byte_for_byte(pid):
    original = model_text(pid)
    typed = f"@prefix shop: <{EX}> .\n# hand-written\nshop:Only   a <http://www.w3.org/2002/07/owl#Class> .\n"
    apply(pid, typed)
    undo(pid)
    assert save(pid).status_code == 200
    assert model_text(pid) == original


def test_undoing_an_apply_after_a_save_restores_the_saved_text(pid):
    first = f"@prefix shop: <{EX}> .\n# first layout\nshop:A a <http://www.w3.org/2002/07/owl#Class> .\n"
    second = f"@prefix shop: <{EX}> .\n# second layout\nshop:B a <http://www.w3.org/2002/07/owl#Class> .\n"
    apply(pid, first)
    save(pid)
    apply(pid, second)
    undo(pid)
    source = client.get(f"/api/projects/{pid}/documents/model/source").json()
    assert source == {"text": first, "revision": revision(pid), "fromEditor": True}
    # Redo brings the second text back as the editor's, comments included.
    redo(pid)
    assert client.get(f"/api/projects/{pid}/documents/model/source").json()["text"] == second
    save(pid)
    assert model_text(pid) == second


def test_undoing_a_command_after_an_apply_keeps_the_applied_text(pid):
    typed = f"@prefix shop: <{EX}> .\n# mine\nshop:A a <http://www.w3.org/2002/07/owl#Class> .\n"
    apply(pid, typed)
    ok(pid, "CreateClass", label="Visual")
    undo(pid)
    source = client.get(f"/api/projects/{pid}/documents/model/source").json()
    assert source["text"] == typed and source["fromEditor"] is True
    save(pid)
    assert model_text(pid) == typed, "no visual change is left, so no rewrite"


# --- visual-modeling Stage 1: what the form needs from the server ---------------------------


def test_a_create_command_names_the_iri_it_minted(pid):
    assert ok(pid, "CreateClass", label="Invoice item")["created"] == EX + "InvoiceItem"
    assert ok(pid, "CreateConcept", prefLabel="Draft")["created"] == EX + "Draft"
    assert "created" not in ok(pid, "SetLabel", iri="shop:InvoiceItem", value="Line")
    # A rename typed as a prefixed name answers with the full IRI to select.
    assert ok(pid, "RenameIri", old="shop:InvoiceItem", new="shop:Line")["created"] == EX + "Line"


def test_a_plain_literal_can_be_replaced_and_removed_as_text_without_a_language(pid):
    apply(pid, model_text(pid) + f'\n<{EX}Person> <http://www.w3.org/2002/07/owl#versionInfo> "1.0" .\n')
    plain = {"kind": "typed", "value": "1.0", "datatype": "xsd:string"}
    ok(pid, "ReplaceAnnotation", iri="shop:Person", property="owl:versionInfo", oldValue=plain,
       newValue={**plain, "value": "1.1"})
    assert (U("Person"), OWL.versionInfo, Literal("1.0")) not in doc(pid).graph
    ok(pid, "RemoveAnnotation", iri="shop:Person", property="owl:versionInfo", value={**plain, "value": "1.1"})
    assert not list(doc(pid).graph.objects(U("Person"), OWL.versionInfo))


def test_search_keeps_one_kind_before_its_limit(pid):
    for i in range(30):
        ok(pid, "CreateObjectProperty", label=f"Zeta link {i}")
    # A substring match ranks after every prefix match.
    ok(pid, "CreateClass", label="Big zeta class")
    oid = f"{pid}-model"
    unfiltered = client.get(f"/api/ontologies/{oid}/search", params={"q": "zeta"}).json()
    assert "Big zeta class" not in [n["label"] for n in unfiltered], "25 properties crowd it out"
    classes = client.get(f"/api/ontologies/{oid}/search", params={"q": "zeta", "kind": "class"}).json()
    assert [n["label"] for n in classes] == ["Big zeta class"]
    assert client.get(f"/api/ontologies/{oid}/search", params={"q": "z", "kind": "bogus"}).status_code == 422


def test_project_details_carry_the_kind_of_the_entity_and_its_terms(pid):
    ok(pid, "CreateClass", label="Invoice")
    ok(pid, "CreateDatatypeProperty", label="total", domain="shop:Invoice", datatype="xsd:decimal")
    ok(pid, "CreateObjectProperty", label="billed to", domain="shop:Invoice", range="shop:Person")
    details = client.get(f"/api/ontologies/{pid}-model/node", params={"iri": EX + "Invoice"}).json()
    assert details["kind"] == "class"
    kinds = {row["subject"]["value"]: row["subject"]["kind"] for row in details["incoming"]}
    assert kinds == {EX + "total": "datatypeProperty", EX + "billedTo": "objectProperty"}


def test_the_delete_impact_names_each_property_kind(pid):
    """visual-modeling 5.8 item 7: the dialog words a relationship as one."""
    ok(pid, "CreateDatatypeProperty", label="age", domain="shop:Person")
    impact = run(pid, "DeleteEntity", dry_run=True, iri="shop:Person").json()["impact"]
    kinds = {p["label"]: (p["kind"], p["role"]) for p in impact["properties"]}
    assert kinds == {"member of": ("object property", "domain"), "age": ("datatype property", "domain")}


# --- shacl-authoring Stage A: the nine shape commands (5.2, 5.3, row S20) -------------------

SH = editing.SH


def shapes_run(pid: str, command: str, **args):
    return client.post(f"/api/projects/{pid}/documents/shapes/commands", json={"command": command, "args": args})


def shapes_ok(pid: str, command: str, **args) -> dict:
    response = shapes_run(pid, command, **args)
    assert response.status_code == 200, response.text
    return response.json()


def shapes_graph(pid: str) -> Graph:
    copy = Graph()
    for t in editing_service.document(pid, "shapes").graph:
        copy.add(t)
    return copy


def _rule_node(g: Graph, shape: URIRef, path: URIRef):
    return next(p for p in g.objects(shape, SH.property) if g.value(p, SH.path) == path)


def test_the_first_shape_command_creates_shapes_ttl(bare):
    pid = bare
    assert not (project_store.folder(pid) / "shapes.ttl").exists()
    result = shapes_ok(pid, "CreateShape", target="shop:Person")
    assert result["created"] == EX + "PersonRules"
    assert result["label"] == "Created shape Person rules"
    assert (project_store.folder(pid) / "shapes.ttl").exists()
    manifest = project_store.manifest(pid)
    assert {"file": "shapes.ttl", "role": "shapes"} in manifest["documents"]
    g = shapes_graph(pid)
    shape = U("PersonRules")
    assert (shape, RDF.type, SH.NodeShape) in g
    assert (shape, RDFS.label, Literal("Person rules", lang="en")) in g
    assert (shape, SH.targetClass, U("Person")) in g
    assert len(g) == 3


def test_a_second_shape_on_the_same_class_gets_its_own_iri(bare):
    pid = bare
    shapes_ok(pid, "CreateShape", target="shop:Person")
    assert shapes_ok(pid, "CreateShape", target="shop:Person")["created"] == EX + "PersonRules2"


def test_check_my_model_is_a_ready_shape_on_every_class(pid):
    sid = shapes_ok(pid, "CreateShape", preset="modelCheck")["created"]
    g = shapes_graph(pid)
    shape = URIRef(sid)
    assert (shape, SH.targetClass, OWL.Class) in g
    assert (shape, RDFS.label, Literal("Check my model", lang="en")) in g
    rules = list(g.objects(shape, SH.property))
    assert len(rules) == 2
    qualified = next(p for p in rules if (p, SH.qualifiedMinCount, None) in g)
    assert g.value(qualified, SH.path) == RDFS.label
    definition = next(p for p in rules if (p, SH.minCount, None) in g)
    alternatives = list(g.items(g.value(g.value(definition, SH.path), SH.alternativePath)))
    assert alternatives == [SKOS.definition, RDFS.comment]


def test_a_rule_with_several_kinds_is_one_property_shape_with_exact_triples(pid):
    sid = shapes_ok(pid, "CreateShape", target="shop:Person")["created"]
    before = shapes_graph(pid)
    result = shapes_ok(pid, "AddRule", shape=sid, rule={
        "path": ["shop:memberOf"], "minCount": 1, "maxCount": 3, "class": "shop:Organization",
    })
    assert result["label"] == "Added a rule on member of to Person rules"
    g = shapes_graph(pid)
    shape = URIRef(sid)
    prop = _rule_node(g, shape, U("memberOf"))
    assert set(g.predicate_objects(prop)) == {
        (SH.path, U("memberOf")),
        (SH.minCount, Literal(1, datatype=XSD.integer)),
        (SH.maxCount, Literal(3, datatype=XSD.integer)),
        (SH["class"], U("Organization")),
    }
    assert len(g) == len(before) + 5
    # One undo step: undo restores the graph exactly, redo puts it back.
    client.post(f"/api/projects/{pid}/documents/shapes/undo")
    assert isomorphic(shapes_graph(pid), before)
    client.post(f"/api/projects/{pid}/documents/shapes/redo")
    assert isomorphic(shapes_graph(pid), g)


def test_every_shape_command_is_one_undo_step_and_survives_save_and_reload(pid):
    sid = shapes_ok(pid, "CreateShape", target="shop:Person")["created"]
    steps = [
        ("AddRule", {"shape": sid, "rule": {"path": [str(RDFS.label)], "uniqueLang": True,
                                            "languageIn": ["en"], "requiredLanguages": ["en"]}}),
        ("AddRule", {"shape": sid, "rule": {"path": ["shop:memberOf"], "maxCount": 1}}),
        ("ReplaceRule", {"shape": sid, "path": ["shop:memberOf"],
                         "rule": {"path": ["shop:memberOf"], "minCount": 1, "class": "shop:Organization"}}),
        ("SetShapeTarget", {"shape": sid, "target": "shop:Organization"}),
        ("SetShapeName", {"shape": sid, "value": "People rules"}),
        ("SetShapeSeverity", {"shape": sid, "severity": "warning"}),
        ("SetShapeMessage", {"shape": sid, "value": "Please check."}),
        ("SetShapeMessage", {"shape": sid, "value": ""}),
        ("SetShapeSeverity", {"shape": sid, "severity": "violation"}),
        ("RemoveRule", {"shape": sid, "path": ["shop:memberOf"]}),
        ("DeleteShape", {"shape": sid}),
    ]
    assert {"CreateShape", *(c for c, _ in steps)} == set(editing.SHAPE_COMMANDS), "a shape command has no case"
    graphs = [shapes_graph(pid)]
    for command, args in steps:
        shapes_ok(pid, command, **args)
        graphs.append(shapes_graph(pid))
        assert not isomorphic(graphs[-1], graphs[-2]), command
    for expected in reversed(graphs[:-1]):
        assert client.post(f"/api/projects/{pid}/documents/shapes/undo").status_code == 200
        assert isomorphic(shapes_graph(pid), expected)
    for expected in graphs[1:]:
        assert client.post(f"/api/projects/{pid}/documents/shapes/redo").status_code == 200
        assert isomorphic(shapes_graph(pid), expected)
    # Back to the shape with its rules, then save, close and reopen: the
    # file holds exactly the same SHACL.
    for _ in range(5):
        client.post(f"/api/projects/{pid}/documents/shapes/undo")
    kept = shapes_graph(pid)
    assert client.post(f"/api/projects/{pid}/documents/shapes/save", json={}).status_code == 200
    editing_service.close(pid)
    client.post(f"/api/projects/{pid}/open")
    assert isomorphic(shapes_graph(pid), kept)
    text = (project_store.folder(pid) / "shapes.ttl").read_text(encoding="utf-8")
    assert "sh:NodeShape" in text and "sh:targetClass shop:Organization" in text


def test_severity_is_written_on_the_shape_and_every_rule(pid):
    sid = shapes_ok(pid, "CreateShape", target="shop:Person")["created"]
    shapes_ok(pid, "AddRule", shape=sid, rule={"path": ["shop:memberOf"], "maxCount": 1})
    shapes_ok(pid, "SetShapeSeverity", shape=sid, severity="warning")
    g = shapes_graph(pid)
    shape = URIRef(sid)
    assert (shape, SH.severity, SH.Warning) in g
    assert (_rule_node(g, shape, U("memberOf")), SH.severity, SH.Warning) in g
    # A rule added afterwards takes the shape's severity too.
    shapes_ok(pid, "AddRule", shape=sid, rule={"path": [str(RDFS.label)], "minCount": 1})
    g = shapes_graph(pid)
    assert (_rule_node(g, shape, RDFS.label), SH.severity, SH.Warning) in g


def test_add_rule_with_merge_joins_the_rule_on_that_path(pid):
    sid = shapes_ok(pid, "CreateShape", target="shop:Person")["created"]
    shapes_ok(pid, "AddRule", shape=sid, rule={"path": ["shop:memberOf"], "class": "shop:Organization"})
    refused = shapes_run(pid, "AddRule", shape=sid, rule={"path": ["shop:memberOf"], "maxCount": 1})
    assert refused.status_code == 422
    assert "already a rule on member of" in refused.json()["detail"]
    shapes_ok(pid, "AddRule", shape=sid, merge=True, rule={"path": ["shop:memberOf"], "maxCount": 1})
    g = shapes_graph(pid)
    props = list(g.objects(URIRef(sid), SH.property))
    assert len(props) == 1
    assert (props[0], SH["class"], U("Organization")) in g
    assert (props[0], SH.maxCount, Literal(1, datatype=XSD.integer)) in g


@pytest.mark.parametrize(
    ("command", "args", "fragment"),
    [
        ("CreateShape", {"target": "shop:Nothing"}, "no class shop:Nothing"),
        ("CreateShape", {"target": "shop:Person", "name": "  "}, "cannot be empty"),
        ("CreateShape", {"preset": "everything"}, "preset is modelCheck"),
        ("SetShapeName", {"shape": "http://example.org/none", "value": "x"}, "no such shape"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"]}}, "at least one thing to check"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "minCount": 3, "maxCount": 1}}, "could never be met"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "minCount": -1}}, "whole number"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "pattern": "("}}, "not a regular expression"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "datatype": "xsd:gYear"}}, "not one of the offered"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "class": "shop:Nothing"}}, "no class shop:Nothing"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "languageIn": ["not a tag!"]}}, "well-formed language tag"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "in": []}}, "at least one allowed value"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "minInclusive": {"value": "soon", "datatype": "xsd:date"}}},
         "not a valid date"),
        ("AddRule", {"rule": {"path": ["shop:memberOf"], "minInclusive": {"value": "5", "datatype": "xsd:integer"},
                              "maxInclusive": {"value": "2", "datatype": "xsd:integer"}}}, "minimum is above"),
        ("AddRule", {"rule": {}}, "attribute or relationship"),
        ("SetShapeSeverity", {"severity": "fatal"}, "violation (a problem) or warning"),
        ("RemoveRule", {"path": ["shop:memberOf"]}, "no rule on that path"),
        ("ReplaceRule", {"path": ["shop:memberOf"], "rule": {"path": ["shop:memberOf"], "minCount": 1}},
         "no rule on that path"),
        ("SetShapeMessage", {"value": ""}, "no message to remove"),
    ],
)
def test_a_refused_shape_command_says_why_and_changes_nothing(pid, command, args, fragment):
    sid = shapes_ok(pid, "CreateShape", target="shop:Person")["created"]
    if command != "CreateShape":
        args = {"shape": sid, **args}
    before = shapes_graph(pid)
    revision_before = editing_service.document(pid, "shapes").ontology.revision
    response = shapes_run(pid, command, **args)
    assert response.status_code == 422, response.text
    assert fragment in response.json()["detail"]
    assert isomorphic(shapes_graph(pid), before)
    assert editing_service.document(pid, "shapes").ontology.revision == revision_before


def test_shape_commands_belong_to_the_shapes_document(pid):
    response = run(pid, "CreateShape", target="shop:Person")
    assert response.status_code == 422
    assert "shapes.ttl" in response.json()["detail"]


def test_a_read_only_shape_is_refused_by_the_form_but_can_be_deleted(pid):
    client.post(f"/api/projects/{pid}/documents", json={"role": "shapes"})
    text = f"""@prefix shop: <{EX}> . @prefix sh: <http://www.w3.org/ns/shacl#> .
shop:Either a sh:NodeShape ; sh:targetClass shop:Person ;
    sh:or ( [ sh:path shop:memberOf ; sh:minCount 1 ] [ sh:path shop:name ; sh:minCount 1 ] ) .
"""
    assert client.put(f"/api/projects/{pid}/documents/shapes/source", json={"text": text}).status_code == 200
    before = shapes_graph(pid)
    refused = shapes_run(pid, "SetShapeName", shape=EX + "Either", value="Mine now")
    assert refused.status_code == 422
    assert "Turtle editor" in refused.json()["detail"] and "uses sh:or" in refused.json()["detail"]
    assert isomorphic(shapes_graph(pid), before)
    shapes_ok(pid, "DeleteShape", shape=EX + "Either")
    # The shape and everything only it reached: the sh:or list and its shapes.
    assert len(shapes_graph(pid)) == 0


def test_form_edits_rewrite_the_shapes_file_and_text_edits_stay_as_typed(pid):
    client.post(f"/api/projects/{pid}/documents", json={"role": "shapes"})
    typed = f"""@prefix shop: <{EX}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
# Written by hand.
shop:S a sh:NodeShape ; sh:targetClass shop:Person .
"""
    client.put(f"/api/projects/{pid}/documents/shapes/source", json={"text": typed})
    client.post(f"/api/projects/{pid}/documents/shapes/save", json={})
    assert (project_store.folder(pid) / "shapes.ttl").read_text(encoding="utf-8") == typed
    shapes_ok(pid, "SetShapeName", shape=EX + "S", value="Person rules")
    answer = client.post(f"/api/projects/{pid}/documents/shapes/save", json={}).json()
    # D-083 holds for shapes.ttl as for the model: a comment is warned about once.
    assert answer.get("needsCommentsWarning") is True
    client.post(f"/api/projects/{pid}/documents/shapes/save", json={"confirmRewrite": True})
    written = (project_store.folder(pid) / "shapes.ttl").read_text(encoding="utf-8")
    assert "# Written by hand." not in written and '"Person rules"@en' in written


def test_a_refused_first_shape_command_leaves_no_shapes_ttl(bare):
    pid = bare
    # Found in review: the file was made before the command was checked.
    response = shapes_run(pid, "CreateShape", target="shop:Nothing")
    assert response.status_code == 422
    assert not (project_store.folder(pid) / "shapes.ttl").exists()
    assert all(d["role"] != "shapes" for d in project_store.manifest(pid)["documents"])
    dry = client.post(f"/api/projects/{pid}/documents/shapes/commands",
                      json={"command": "CreateShape", "args": {"target": "shop:Person"}, "dryRun": True})
    assert dry.status_code == 422
    assert not (project_store.folder(pid) / "shapes.ttl").exists()


def test_two_first_shape_commands_at_once_make_shapes_ttl_once(bare):
    pid = bare
    import threading

    answers = []
    barrier = threading.Barrier(2)

    def first():
        barrier.wait()
        answers.append(shapes_run(pid, "CreateShape", target="shop:Person").status_code)

    threads = [threading.Thread(target=first) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert answers == [200, 200]
    assert [d["role"] for d in project_store.manifest(pid)["documents"]].count("shapes") == 1
    assert len(list(shapes_graph(pid).subjects(RDF.type, SH.NodeShape))) == 2
