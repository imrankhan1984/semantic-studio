"""
================================================================================
FILE: backend/tests/test_naming.py
================================================================================

SUMMARY
    The one address rule (design-checks 5.1, AC-15, AC-17): every row of the
    examples table built from its parts and read back into them, every Avoid
    row read with the departure it shows, the namespace's accepted and
    refused values, and the identifier slug. The table is the frontend's,
    frontend/src/naming/address.table.json, read by address.test.ts too.

BASIC IDEA
    One table, so the Python and TypeScript rules cannot drift (as
    test_sentences.py does for the grammar). Rows whose departure is about
    the name after '#' ("name:DC-04") are the design checks' to report, and
    test_checks.py runs them; here they must show no address departure, so
    the two rules never both claim one row. The one row nothing can see
    (a name in another language, "none") is asserted to stay unseen, so a
    rule that starts to see it changes the table on purpose.

INPUTS / INPUT SOURCES
    - app.naming; the shared table.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import naming

ROOT = Path(__file__).resolve().parent.parent.parent
TABLE = json.loads((ROOT / "frontend" / "src" / "naming" / "address.table.json").read_text(encoding="utf-8"))
NS = TABLE["namespace"]


def test_the_table_loaded():
    assert len(TABLE["built"]) == 11 and len(TABLE["avoid"]) == 9


def _build(row: dict) -> str:
    p = row["parts"]
    if row["role"] == "artifact":
        return naming.artifact_iri(NS, p["layer"], p["area"], p["subject"], p["type"])
    if row["role"] == "term":
        return naming.term_iri(p["artifact"], p["name"])
    return naming.data_iri(NS, p["dataDomain"], p["class"], p["id"])


@pytest.mark.parametrize("row", TABLE["built"], ids=lambda r: r["what"])
def test_every_example_is_built_from_its_parts(row):
    assert _build(row) == row["address"]


@pytest.mark.parametrize("row", TABLE["built"], ids=lambda r: r["what"])
def test_every_example_reads_back_into_its_parts_with_no_departure(row):
    artifact = row["parts"].get("artifact")
    reading = naming.read(row["address"], row["role"], NS, artifact=artifact)
    assert reading["departures"] == []
    expected = dict(row["parts"])
    if row["role"] == "data":
        expected["id"] = naming.slug(expected["id"])
    for key, value in expected.items():
        assert reading["parts"][key] == value


@pytest.mark.parametrize("row", TABLE["avoid"], ids=lambda r: r["address"].split("acme/")[1])
def test_every_avoid_row_shows_its_departure_and_its_instead_none(row):
    reported = row["reported"]
    reading = naming.read(row["address"], row["role"], NS, general_class=row.get("generalClass"))
    codes = [code for code, _ in reading["departures"]]
    if reported.startswith("name:") or reported == "none":
        # The name after '#' is the design checks' (test_checks.py), or no
        # rule's; the address itself is on the pattern.
        assert codes == []
    else:
        assert reported in codes
    instead_role = "data" if "/data/" in row["instead"] else row["role"]
    fixed = naming.read(row["instead"], instead_role, NS, general_class=row.get("generalClass"))
    assert fixed["departures"] == []


@pytest.mark.parametrize("value", TABLE["namespaces"]["accepted"])
def test_an_accepted_namespace(value):
    assert naming.namespace_error(value) is None
    assert naming.namespace_iri(value) == f"https://w3id.org/{value}/"


@pytest.mark.parametrize("value, why", TABLE["namespaces"]["refused"])
def test_a_refused_namespace_says_why(value, why):
    expected = naming.NAMESPACE_VERSION if why == "version" else naming.NAMESPACE_REFUSED
    assert naming.namespace_error(value) == expected
    with pytest.raises(naming.NamingError):
        naming.namespace_iri(value)


@pytest.mark.parametrize("text, expected", TABLE["slugs"])
def test_an_identifier_is_slugged_by_the_rule(text, expected):
    assert naming.slug(text) == expected


@pytest.mark.parametrize("value", ["Finance", "fin_ance", "", "-x", "a b", "finance\n"])
def test_a_name_in_an_address_is_one_lowercase_segment(value):
    assert naming.segment_error(value) == naming.SEGMENT_REFUSED
    with pytest.raises(naming.NamingError) as caught:
        naming.artifact_iri(NS, "domain", value, "invoice", "ontology")
    assert caught.value.field == "area"


@pytest.mark.parametrize("value", ["v2", "2026"])
def test_a_name_in_an_address_is_never_a_version_or_a_year(value):
    assert naming.segment_error(value) == naming.SEGMENT_VERSION


def test_nothing_typed_closes_the_iri():
    for bad in ("x>", 'x"', "x#y", "x/../y", "x y"):
        with pytest.raises(naming.NamingError):
            naming.artifact_iri(NS, "domain", "finance", bad, "ontology")


def test_the_three_project_addresses_ac15():
    for layer, area, model in (
        ("core", "", "https://w3id.org/acme/core/invoice-ontology#"),
        ("domain", "finance", "https://w3id.org/acme/domain/finance/invoice-ontology#"),
        ("app", "helpdesk", "https://w3id.org/acme/app/helpdesk/invoice-ontology#"),
    ):
        lines = naming.project_addresses(NS, layer, area, "invoice", "ontology", "finance")
        assert lines["model"] == model
        assert lines["shapes"].endswith("invoice-shapes#")
        assert lines["data"] == "https://w3id.org/acme/data/finance/"


def test_a_project_type_follows_its_kind():
    assert naming.project_addresses(NS, "core", "", "x", "vocabulary", "d", kind="taxonomy")
    for kind, type_ in (("ontology", "taxonomy"), ("taxonomy", "ontology"), ("ontology", "shapes")):
        with pytest.raises(naming.NamingError):
            naming.project_addresses(NS, "core", "", "x", type_, "d", kind=kind)


def test_the_path_spelling_needs_no_namespace():
    found = naming.read("https://w3id.org/acme/domain/Finance/invoice_v2-ontology#X", "artifact")
    assert [c for c, _ in found["departures"]] == ["capital", "underscore", "version"]
    assert naming.read("http://example.org/space#Planet", "term")["departures"] == []
    # The host is not read, nor the name after '#'.
    assert naming.path_departures("https://W3ID.org/acme/core/x-ontology#Invoice_V2") == []


def test_outside_the_namespace_is_one_departure():
    reading = naming.read("http://example.org/space", "artifact", NS)
    assert reading["departures"] == [("outside", "https://w3id.org/acme/")]
