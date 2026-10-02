"""
================================================================================
FILE: backend/tests/test_tabular.py
================================================================================

SUMMARY
    Reading a CSV file for the data import (csv-data-import 5.2, Section 9):
    encoding, separator and header detection, header names made usable, the
    fixed limits, and what step 1 and step 2 suggest.

BASIC IDEA
    Every file is generated in the test, never committed (rdf-fixture). The
    limits are asserted at their edges -- 2,000 rows kept and 2,001 not,
    5 MB and one byte more, 100 columns and 101, 32,767 characters and
    40,000 -- because an off-by-one there is exactly the defect a limit
    test exists to catch. The 2,000-row limit is asserted not to be a
    setting at all (D-098).

INPUTS / INPUT SOURCES
    - app.tabular, on bytes built here.

EXPECTED OUTPUT
    - Pass/fail; one `perf` budget (Section 10: inspect a 5 MB file in 1 s).
================================================================================
"""

from __future__ import annotations

import gc
import inspect as pyinspect
import time

import pytest

from app import tabular
from tests.budget import limit_ms


def csv(rows: list[list[str]], sep: str = ",") -> str:
    return "\n".join(sep.join(r) for r in rows) + "\n"


def people(n: int) -> bytes:
    lines = [["id", "name", "born"]] + [[str(i), f"Person {i}", "2000-01-01"] for i in range(1, n + 1)]
    return csv(lines).encode()


# --- detection (5.2) -------------------------------------------------------------


def test_comma_utf8_with_header():
    table = tabular.read_table(b"id,name\n1,Ann\n2,Bob\n")
    assert (table.separator, table.encoding, table.header) == (",", "utf-8", True)
    assert table.columns == ["id", "name"]
    assert table.rows == [["1", "Ann"], ["2", "Bob"]]
    assert table.total == 2 and not table.sample


def test_semicolon_windows_1252_accented_names():
    # D2: what French Excel writes.
    data = "id;nom\n1;Hélène\n2;François\n".encode("windows-1252")
    table = tabular.read_table(data)
    assert table.separator == ";"
    assert table.encoding == "windows-1252"
    assert [r[1] for r in table.rows] == ["Hélène", "François"]


def test_tab_and_utf8_bom():
    data = "﻿id\tname\n1\tÅsa\n".encode("utf-8")
    table = tabular.read_table(data)
    assert (table.separator, table.encoding) == ("\t", "utf-8-sig")
    # The mark is not part of the first column's name.
    assert table.columns == ["id", "name"]


def test_a_semicolon_inside_quoted_commas_does_not_fool_the_separator():
    data = b'id,note\n1,"a; b; c"\n2,"d; e"\n'
    assert tabular.read_table(data).separator == ","


def test_choices_replace_the_detections():
    data = b"a;b\n1;2\n"
    table = tabular.read_table(data, separator=",", encoding="utf-8", header=False)
    assert table.columns == ["column 1"]
    assert table.rows == [["a;b"], ["1;2"]]
    assert table.total == 2
    # Nothing was named, so nothing is said to be renamed.
    assert table.renamed == []


def test_a_wrong_encoding_choice_is_said():
    with pytest.raises(tabular.TabularError, match="cannot be read as utf-8"):
        tabular.read_table("é".encode("windows-1252"), encoding="utf-8")


def test_binary_is_not_csv_text():
    with pytest.raises(tabular.TabularError, match="not CSV text") as caught:
        tabular.read_table(b"PK\x03\x04\x00\x00binary")
    assert caught.value.kind == "not-text"


def test_an_empty_file_is_said():
    with pytest.raises(tabular.TabularError, match="empty"):
        tabular.read_table(b"\n\n")


def test_values_are_trimmed_and_blank_lines_are_no_rows():
    table = tabular.read_table(b"id,name\n 1 ,  Ann  \n\n2,Bob\n")
    assert table.rows == [["1", "Ann"], ["2", "Bob"]]
    assert table.total == 2


# --- header names (5.2) --------------------------------------------------------------


def test_empty_and_duplicate_headers_are_named_and_said():
    table = tabular.read_table(b"id,name,,name,name\n1,a,b,c,d\n")
    assert table.columns == ["id", "name", "column 3", "name (2)", "name (3)"]
    assert table.renamed == [
        {"index": 2, "from": "", "to": "column 3"},
        {"index": 3, "from": "name", "to": "name (2)"},
        {"index": 4, "from": "name", "to": "name (3)"},
    ]


def test_a_row_wider_than_the_header_keeps_its_cells():
    table = tabular.read_table(b"id,name\n1,Ann,extra\n2,Bob\n")
    assert table.columns == ["id", "name", "column 3"]
    assert table.rows == [["1", "Ann", "extra"], ["2", "Bob", ""]]


# --- the limits (5.2, Section 9, D-098) ---------------------------------------------


def test_exactly_two_thousand_rows_are_all_kept():
    table = tabular.read_table(people(2000))
    assert len(table.rows) == 2000 and table.total == 2000 and not table.sample


def test_one_row_more_is_a_sample_of_the_first_two_thousand():
    table = tabular.read_table(people(2001))
    assert table.total == 2001 and table.sample
    assert len(table.rows) == 2000
    assert table.rows[-1][0] == "2000"


def test_twelve_thousand_rows_are_counted_and_the_sentence_says_so():
    table = tabular.read_table(people(12_480))
    assert table.total == 12_480 and len(table.rows) == 2000
    shown = tabular.inspect(table)
    assert shown["limitSentence"] == (
        "This file has 12,480 rows. Semantic Studio imports at most 2,000 rows: it is for "
        "learning how data is mapped to a model, not for loading whole datasets."
    )
    assert shown["sample"] is True and shown["kept"] == 2000 and shown["total"] == 12_480


def test_the_row_limit_is_not_a_setting(monkeypatch):
    # D-098: fixed. No environment variable moves it, and the module reads none.
    monkeypatch.setenv("SEMANTIC_STUDIO_MAX_DATA_ROWS", "50000")
    assert tabular.MAX_ROWS == 2000
    source = pyinspect.getsource(tabular)
    assert "import os" not in source and "os.environ" not in source and "getenv(" not in source


def test_five_megabytes_are_read_and_one_byte_more_is_refused():
    header = b"id,text\n"
    line = b"1," + b"x" * 1000 + b"\n"
    body = header + line * ((tabular.MAX_BYTES - len(header)) // len(line))
    data = body + b"y" * (tabular.MAX_BYTES - len(body))
    assert len(data) == tabular.MAX_BYTES
    tabular.read_table(data)
    with pytest.raises(tabular.TabularError) as caught:
        tabular.read_table(data + b"z")
    assert caught.value.kind == "too-large"
    assert "at most 5 MB: it is for learning how data is mapped to a model" in str(caught.value)


def test_a_hundred_columns_are_read_and_a_hundred_and_one_refused():
    tabular.read_table((",".join(f"c{i}" for i in range(100)) + "\n").encode())
    with pytest.raises(tabular.TabularError, match="This file has 101 columns. Semantic Studio imports at most 100 columns"):
        tabular.read_table((",".join(f"c{i}" for i in range(101)) + "\n").encode())


def test_a_cell_at_the_excel_limit_is_read_and_forty_thousand_refused():
    tabular.read_table(b"id,text\n1," + b"x" * 32_767 + b"\n")
    with pytest.raises(tabular.TabularError, match="holds 40,000 characters. A cell can hold at most 32,767"):
        tabular.read_table(b"id,text\n1," + b"x" * 40_000 + b"\n")


def test_a_cell_past_the_csv_modules_own_limit_is_the_same_refusal():
    with pytest.raises(tabular.TabularError, match="A cell can hold at most 32,767"):
        tabular.read_table(b'id,text\n1,"' + b"x" * 200_000 + b'"\n')


# --- what steps 1 and 2 suggest (5.2, 5.3) --------------------------------------------


def test_the_identifier_and_name_are_suggested():
    table = tabular.read_table(b"person_id,Full-Name,Title\n1,Ann,Dr\n2,Bob,Mr\n")
    shown = tabular.inspect(table)
    assert shown["idSuggestion"] == "person_id"
    assert shown["nameSuggestion"] == "Title"  # name, label, title -- Full-Name is not "name"
    table = tabular.read_table(b"code,Name\n1,Ann\n")
    assert tabular.suggest_name(table) == "Name"


def test_an_identifier_with_gaps_or_repeats_is_not_suggested_and_is_reported():
    table = tabular.read_table(b"id,name\n1,a\n,b\n1,c\n2,d\n,e\n2,f\n3,g\n")
    assert tabular.suggest_id(table) is None
    check = tabular.id_check(table, "id")
    assert check["ok"] is False
    assert check["missing"] == {"count": 2, "rows": [2, 5]}
    assert check["repeats"] == 2  # "1" and "2" repeat
    assert check["repeated"] == {"count": 2, "rows": [3, 6]}


def test_column_profiles_suggest_a_new_attributes_type():
    table = tabular.read_table(b"n,d,t\n1,2026-01-02,x\n-3,2026-02-28,\n")
    n, d, t = tabular.inspect(table)["columns"]
    assert n["wholeNumbers"] and not n["dates"]
    assert d["dates"] and not d["wholeNumbers"]
    assert not t["wholeNumbers"] and not t["dates"] and t["empty"] == 1
    # A date that has the shape of one and is not: not all dates.
    assert not tabular.inspect(tabular.read_table(b"d\n2026-02-30\n"))["columns"][0]["dates"]


def test_the_copy_is_written_in_the_dialect_with_a_row_column():
    table = tabular.read_table("id;nom\n1;Hélène\n".encode("windows-1252"))
    data = tabular.write_csv(table, "windows-1252", ";", "row")
    assert data == "row;id;nom\r\n1;1;Hélène\r\n".encode("windows-1252")
    # A byte-order mark is never written.
    assert not tabular.write_csv(table, "utf-8-sig", ",").startswith(b"\xef\xbb\xbf")


@pytest.mark.perf
def test_inspect_budget():
    # Section 10: a 5 MB file -- detections, 20 rows and the row count -- in 1 s.
    header = b"id,name,born,city,note\n"
    line = b"123456,Somebody Withaname,1990-01-01,Somewhere,a note of some length here\n"
    data = header + line * ((tabular.MAX_BYTES - len(header)) // len(line))
    times = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            tabular.inspect(tabular.read_table(data))
            times.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    median = sorted(times)[2]
    assert median <= limit_ms(1000), f"inspecting a 5 MB file took {median:.0f} ms (median of 5)"
