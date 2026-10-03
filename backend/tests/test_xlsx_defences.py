"""
================================================================================
FILE: backend/tests/test_xlsx_defences.py
================================================================================

SUMMARY
    The Excel defences of csv-data-import Section 9 (row X2, AC-9): a
    decompression bomb, a ZIP entry that lies about its size, an XXE
    workbook and an entity-expansion one, a macro-enabled workbook in three
    disguises, and a password-protected file -- each refused, and refused
    before openpyxl is asked to open anything.

BASIC IDEA
    A refusal with a 4xx proves little; what matters is that the work never
    started (verify-security-fix). So every case runs with openpyxl's
    load_workbook replaced by a recorder, and asserts it was never called:
    nothing in the workbook was parsed. The bomb also asserts that no entry
    was unpacked at all (the sizes are judged from the ZIP's directory) and
    that memory stayed far below what the bomb would unpack to.

    The XXE workbooks point an external entity at a recording HTTP server
    and at a file of secret text. The first defence, the byte scan for a
    document type declaration, refuses them unparsed; then the scan is
    switched off to prove the second, defusedxml under openpyxl, refuses
    them too. Both times the server must see zero requests and the secret
    must appear in no answer.

    Every workbook is built in the test: with openpyxl where Excel could
    have saved it, by hand where only an attacker would write it.

INPUTS / INPUT SOURCES
    - app.tabular directly, and the data routes through TestClient with the
      client header; conftest's recording HTTP server.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

from __future__ import annotations

import io
import struct
import tracemalloc
import zipfile

import openpyxl
import pytest
from fastapi.testclient import TestClient

from app import tabular
from app.editing import editing_service, project_store
from app.main import app

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


@pytest.fixture(autouse=True)
def _closed():
    yield
    editing_service.close_all()


@pytest.fixture
def opened(monkeypatch) -> list:
    """Every call to openpyxl.load_workbook, which then fails the read."""
    calls: list = []

    def recorder(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("openpyxl was asked to open a workbook that should have been refused")

    monkeypatch.setattr(openpyxl, "load_workbook", recorder)
    return calls


def book_bytes() -> bytes:
    book = openpyxl.Workbook()
    book.active.append(["id", "name"])
    book.active.append(["acme", "Acme"])
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def rezip(data: bytes, replace: dict | None = None, add: dict | None = None) -> bytes:
    """The workbook's entries, some replaced or added, zipped again."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        parts = {n: zf.read(n) for n in zf.namelist()}
    parts.update(replace or {})
    parts.update(add or {})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, raw in parts.items():
            zf.writestr(name, raw)
    return out.getvalue()


def bomb(unpacked_mb: int) -> bytes:
    """A workbook-shaped ZIP whose one sheet unpacks to `unpacked_mb` MB of
    zeros, written in chunks so the test itself never holds it."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        with zf.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as entry:
            chunk = b"\0" * (1024 * 1024)
            for _ in range(unpacked_mb):
                entry.write(chunk)
    return out.getvalue()


def refused(data: bytes, filename: str, match: str, kind: str = "not-text") -> None:
    with pytest.raises(tabular.TabularError, match=match) as caught:
        tabular.read_file(data, filename, {})
    assert caught.value.kind == kind


# --- the decompression bomb -------------------------------------------------------


def test_a_bomb_past_100_mb_is_refused_from_the_directory_alone(opened, monkeypatch):
    data = bomb(150)
    assert len(data) < 1024 * 1024  # small enough to pass every upload cap
    unpacked: list = []
    real_read = zipfile.ZipFile.read
    monkeypatch.setattr(zipfile.ZipFile, "read", lambda self, *a, **k: unpacked.append(a) or real_read(self, *a, **k))
    tracemalloc.start()
    try:
        refused(data, "bomb.xlsx", r"would unpack to 150 MB\. Semantic Studio refuses a workbook that unpacks "
                                   r"past 100 MB or more than 100 times its size", "too-large")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert opened == [] and unpacked == []
    assert peak < 10 * 1024 * 1024, f"refusing the bomb peaked at {peak / 1e6:.1f} MB"


def test_a_bomb_under_100_mb_is_refused_by_its_ratio(opened):
    data = bomb(60)
    refused(data, "bomb.xlsx", r"would unpack to [\d,]+ times its size", "too-large")
    assert opened == []


def test_a_real_workbook_passes_both_measures():
    data = book_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        entries = zf.infolist()
    assert sum(e.file_size for e in entries) < tabular.XLSX_MAX_RATIO * sum(e.compress_size for e in entries)
    assert tabular.read_workbook(data).rows == [["acme", "Acme"]]


def test_an_entry_lying_about_its_size_is_never_unpacked_past_it(opened):
    # The directory says 1,000 bytes; the data inflates to 20 MB. zipfile
    # stops at the declared size and the CRC fails: a damaged ZIP.
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        zf.writestr("xl/worksheets/sheet1.xml", b"\0" * (20 * 1024 * 1024))
    data = bytearray(out.getvalue())
    for signature, offset in ((b"PK\x03\x04", 22), (b"PK\x01\x02", 24)):
        at = 0
        while (at := data.find(signature, at)) != -1:
            size = struct.unpack_from("<I", data, at + offset)[0]
            if size == 20 * 1024 * 1024:
                struct.pack_into("<I", data, at + offset, 1000)
            at += 4
    tracemalloc.start()
    try:
        refused(bytes(data), "liar.xlsx", "it is a damaged ZIP")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert opened == []
    assert peak < 10 * 1024 * 1024, f"the lying entry peaked at {peak / 1e6:.1f} MB"


# --- XML entities --------------------------------------------------------------------


def _entity_sheet(doctype: str, cell: str) -> bytes:
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>{doctype}'
        f'<worksheet xmlns="{MAIN_NS}"><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>'
        f'<row r="2"><c r="A2" t="inlineStr"><is><t>{cell}</t></is></c></row>'
        "</sheetData></worksheet>"
    ).encode()


def shared_strings(base: bytes, sst: bytes) -> bytes:
    """The workbook reading its cell A2 from a shared strings part, as Excel
    saves text."""
    with zipfile.ZipFile(io.BytesIO(base)) as zf:
        types = zf.read("[Content_Types].xml").decode()
        rels = zf.read("xl/_rels/workbook.xml.rels").decode()
    types = types.replace("</Types>", (
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'))
    rels = rels.replace("</Relationships>", (
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
        'sharedStrings" Target="sharedStrings.xml" Id="rId9"/></Relationships>'))
    sheet = (
        f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{MAIN_NS}"><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>'
        '<row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData></worksheet>'
    ).encode()
    return rezip(base, {"[Content_Types].xml": types.encode(), "xl/_rels/workbook.xml.rels": rels.encode(),
                        "xl/worksheets/sheet1.xml": sheet}, {"xl/sharedStrings.xml": sst})


def test_a_shared_strings_workbook_is_read():
    # The fixture's shape without an entity: the strings part is what is read.
    sst = f'<?xml version="1.0"?><sst xmlns="{MAIN_NS}" count="1" uniqueCount="1"><si><t>Acme</t></si></sst>'
    assert tabular.read_workbook(shared_strings(book_bytes(), sst.encode())).rows == [["Acme"]]


def xxe_books(url: str, secret_path) -> dict:
    base = book_bytes()
    secret_url = secret_path.as_uri()
    return {
        "http": rezip(base, {"xl/worksheets/sheet1.xml": _entity_sheet(
            f'<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "{url}">]>', "&xxe;")}),
        "file": rezip(base, {"xl/worksheets/sheet1.xml": _entity_sheet(
            f'<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "{secret_url}">]>', "&xxe;")}),
        "parameter": rezip(base, {"xl/worksheets/sheet1.xml": _entity_sheet(
            f'<!DOCTYPE worksheet [<!ENTITY % remote SYSTEM "{url}"> %remote;]>', "x")}),
        # In the shared strings, where Excel keeps most text (openpyxl
        # writes inline strings, so the part and its references are added).
        "strings": shared_strings(base, (
            f'<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY xxe SYSTEM "{url}">]>'
            f'<sst xmlns="{MAIN_NS}" count="1" uniqueCount="1"><si><t>&xxe;</t></si></sst>').encode()),
        "laughs": rezip(base, {"xl/worksheets/sheet1.xml": _entity_sheet(
            '<!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa">'
            + "".join(f'<!ENTITY {chr(98 + i)} "{("&" + chr(97 + i) + ";") * 10}">' for i in range(8))
            + "]>", "&i;")}),
        "utf16": rezip(base, {"xl/worksheets/sheet1.xml": _entity_sheet(
            f'<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "{url}">]>', "&xxe;"
        ).decode().replace('encoding="UTF-8"', 'encoding="UTF-16"').encode("utf-16")}),
    }


@pytest.fixture
def recorder(http_server):
    return http_server(lambda path: (200, {"Content-Type": "text/plain"}, b"FETCHED-BY-THE-PARSER"))


@pytest.fixture
def secret(tmp_path):
    path = tmp_path / "secret.txt"
    path.write_text("TOP-SECRET-CONTENT", encoding="utf-8")
    return path


def test_xxe_and_entity_expansion_are_refused_unparsed(opened, recorder, secret):
    url = f"http://127.0.0.1:{recorder.server_address[1]}/xxe"
    for name, data in xxe_books(url, secret).items():
        with pytest.raises(tabular.TabularError, match="XML document type declaration") as caught:
            tabular.read_file(data, f"{name}.xlsx", {})
        assert "TOP-SECRET" not in str(caught.value) and "FETCHED" not in str(caught.value), name
    assert opened == []
    assert recorder.requests == []


def test_with_the_scan_off_defusedxml_still_refuses_every_entity(monkeypatch, recorder, secret):
    # The second defence alone: openpyxl parses through defusedxml, which
    # refuses an entity declaration before resolving anything.
    monkeypatch.setattr(tabular, "_DTD_MARKS", ())
    url = f"http://127.0.0.1:{recorder.server_address[1]}/xxe"
    for name, data in xxe_books(url, secret).items():
        with pytest.raises(tabular.TabularError, match="This workbook cannot be read") as caught:
            table = tabular.read_file(data, f"{name}.xlsx", {})
            pytest.fail(f"{name}: read {table.rows}")  # pragma: no cover - the defect this test exists for
        message = str(caught.value)
        assert "TOP-SECRET" not in message and "FETCHED" not in message, name
        assert "forbidden" in message.lower() or "entit" in message.lower(), (name, message)
    assert recorder.requests == []


def test_a_workbook_is_not_parsed_when_defusedxml_is_off(opened, monkeypatch):
    monkeypatch.setattr(openpyxl, "DEFUSEDXML", False)
    refused(book_bytes(), "orgs.xlsx", "cannot be read safely here: defusedxml is missing or switched off")
    assert opened == []


def test_openpyxl_parses_through_defusedxml_here():
    # What the line above guards, as installed: openpyxl's own switch, and
    # the functions its readers import.
    from openpyxl.xml import functions

    assert openpyxl.DEFUSEDXML is True
    assert functions.iterparse.__module__.startswith("defusedxml")
    assert functions.fromstring.__module__.startswith("defusedxml")


# --- macros ------------------------------------------------------------------------------


def test_a_macro_enabled_workbook_is_refused_by_name_and_by_content(opened):
    base = book_bytes()
    refused(base, "book.xlsm", r"macro-enabled workbook \(\.xlsm\)")
    refused(base, "book.xltm", r"macro-enabled template \(\.xltm\)")
    with_macros = rezip(base, add={"xl/vbaProject.bin": b"\xd0\xcf\x11\xe0 not really VBA"})
    refused(with_macros, "innocent.xlsx", r"macro-enabled workbook \(\.xlsm\)")
    with zipfile.ZipFile(io.BytesIO(base)) as zf:
        types = zf.read("[Content_Types].xml").decode()
    declared = rezip(base, {"[Content_Types].xml": types.replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml").encode()})
    refused(declared, "innocent.xlsx", r"macro-enabled workbook \(\.xlsm\)")
    assert opened == []


# --- password protection and other containers ---------------------------------------------


def ole(*streams: str) -> bytes:
    """An OLE compound file's first bytes and its directory's stream names,
    as UTF-16 -- all the defence reads."""
    header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504
    return header + b"".join(name.encode("utf-16-le") + b"\0" * (64 - 2 * len(name)) for name in streams)


def test_a_password_protected_workbook_is_refused_in_words(opened):
    # Excel saves a password-protected .xlsx as an OLE container holding
    # EncryptionInfo and EncryptedPackage.
    refused(ole("EncryptionInfo", "EncryptedPackage"), "secret.xlsx",
            "This workbook is password protected. Open it in Excel, remove the password")
    # A ZIP with an encrypted entry, as some tools write.
    data = bytearray(book_bytes())
    at = 0
    while (at := data.find(b"PK\x01\x02", at)) != -1:
        struct.pack_into("<H", data, at + 8, struct.unpack_from("<H", data, at + 8)[0] | 0x1)
        at += 4
    refused(bytes(data), "secret.xlsx", "This workbook is password protected")
    # An OLE file without one is an Excel 97 workbook.
    refused(ole("Workbook"), "old.xlsx", r"Excel 97-2003 workbook \(\.xls\)")
    refused(b"id,name\n", "old.xls", r"Excel 97-2003 workbook \(\.xls\)")
    refused(b"PK\x03\x04 broken", "broken.xlsx", "damaged ZIP")
    refused(b"id,name\n1,Ann\n", "people.xlsx", r"not an Excel workbook \(\.xlsx\)")
    assert opened == []


# --- through the routes: refused, and nothing kept -----------------------------------------


def _project() -> str:
    response = client.post("/api/projects", json={
        "name": "Shop", "template": "small", "baseIri": "http://example.org/shop#", "prefix": "shop"})
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    assert client.post(f"/api/projects/{pid}/open").status_code == 200
    return pid


def test_the_routes_refuse_each_file_and_keep_nothing(opened, recorder, secret):
    pid = _project()
    url = f"http://127.0.0.1:{recorder.server_address[1]}/xxe"
    cases = [
        ("bomb.xlsx", bomb(150), 413, "would unpack to 150 MB"),
        ("xxe.xlsx", xxe_books(url, secret)["http"], 422, "XML document type declaration"),
        ("book.xlsm", book_bytes(), 422, "macro-enabled workbook"),
        ("secret.xlsx", ole("EncryptionInfo", "EncryptedPackage"), 422, "password protected"),
    ]
    choices = '{"classIri": "http://example.org/shop#Organization", "idColumn": "id", "columns": {}}'
    for name, data, status, words in cases:
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        for route, form in (("/data/inspect", {}), ("/data/preview", {"choices": choices}), ("/data", {"choices": choices})):
            response = client.post(f"/api/projects/{pid}{route}", files={"file": (name, data, mime)}, data=form)
            assert response.status_code == status, (name, route, response.text)
            assert words in response.json()["detail"]["message"], (name, route)
    assert opened == [] and recorder.requests == []
    assert not (project_store.folder(pid) / "data").exists()
