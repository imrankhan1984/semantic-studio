"""
================================================================================
FILE: backend/app/tabular.py
================================================================================

SUMMARY
    Reading a CSV file for the data import (csv-data-import 5.2, Section 9):
    its encoding, separator and header detected, header names made usable,
    the tool's limits enforced while reading, and the rows kept -- never more
    than 2,000 (D-098). Also what the wizard's first two steps show: the
    first rows, each column's make-up, the identifier and name suggestions.

BASIC IDEA
    A file is bytes from the browser and untrusted. It is refused past 5 MB
    before anything decodes it, and while the rows are read: more than 100
    columns, or a cell over 32,767 characters (Excel's own limit), stops the
    read with a sentence naming the row and column. Rows are counted to the
    end, so the limit sentence can say how many there are, but only the
    first 2,000 are kept. That number is fixed, not a setting (D-098): the
    feature teaches how data is mapped to a model and is not a loader.

    Encoding: a UTF-8 byte-order mark says so; otherwise strict UTF-8 is
    tried, then Windows-1252, the encoding French Excel writes. A byte
    neither can read, or a NUL byte, means the file is not CSV text at all.
    The separator is the one of comma, semicolon and tab that splits the
    first lines into the most consistent number of columns, a judgement
    csv.Sniffer makes badly on short files. All three are shown and can be
    changed, and the table is read again with the choice.

    Header names are what a mapping references, so they must be usable:
    an empty one becomes "column 4" and a repeated one "name (2)", and each
    renaming is listed so the wizard can say so. A file without a header
    row gets "column 1", "column 2", ... A data row wider than the header
    adds named columns rather than losing its cells.

    Values are trimmed of surrounding whitespace here (5.5), once, so the
    preview, the engine and the copy written into the project see the same
    text.

INPUTS / INPUT SOURCES
    - The file's bytes; optionally the separator, encoding and header flag
      the user chose instead of the detected ones.

EXPECTED OUTPUT
    - read_table(...) -> Table: columns, at most 2,000 rows, the true total,
      the dialect used and the renamings.
    - inspect(table) -> the JSON the wizard's first step shows.
    - write_csv(table, ...) -> the bytes of the copy kept in the project.
    - TabularError, a sentence, for anything refused; its `kind` says which
      state the wizard shows (too-large, not-text, empty).
================================================================================
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Optional

from . import lexical

# D-098: fixed, never a setting or an environment variable. A test asserts
# the module reads no environment for it.
MAX_ROWS = 2_000
MAX_BYTES = 5 * 1024 * 1024
MAX_COLUMNS = 100
# Excel's own limit for one cell.
MAX_CELL = 32_767
# The rows step 1 shows.
SHOWN_ROWS = 20
# Rows listed by number in a sentence before "and 11 more".
LISTED_ROWS = 20

SEPARATORS = {",": "comma", ";": "semicolon", "\t": "tab"}
ENCODINGS = ("utf-8", "utf-8-sig", "windows-1252")

WHY = "it is for learning how data is mapped to a model, not for loading whole datasets"


class TabularError(ValueError):
    """A file refused, with the sentence saying why and the wizard's state."""

    def __init__(self, message: str, kind: str = "not-text") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class Table:
    columns: list[str]
    rows: list[list[str]]          # at most MAX_ROWS, each len(columns) long
    total: int                     # data rows in the whole file
    separator: str
    encoding: str
    header: bool
    renamed: list[dict] = field(default_factory=list)

    @property
    def sample(self) -> bool:
        """More rows than the tool takes: only the first MAX_ROWS are here."""
        return self.total > MAX_ROWS

    def column(self, name: str) -> int:
        return self.columns.index(name)


def rows_sentence(total: int) -> str:
    """The 5.2 sentence for a file past the row limit."""
    return (
        f"This file has {total:,} rows. Semantic Studio imports at most {MAX_ROWS:,} rows: {WHY}."
    )


def _megabytes(size: int) -> str:
    # "5.0 MB" beside "at most 5 MB" reads as a contradiction.
    shown = f"{size / (1024 * 1024):.1f}"
    return f"{shown} MB" if float(shown) * 1024 * 1024 > MAX_BYTES else f"just over {MAX_BYTES // (1024 * 1024)} MB"


def check_size(size: int) -> None:
    if size > MAX_BYTES:
        raise TabularError(
            f"This file is {_megabytes(size)}. Semantic Studio imports files of at most "
            f"{MAX_BYTES // (1024 * 1024)} MB: {WHY}.",
            "too-large",
        )


def decode(data: bytes, encoding: Optional[str] = None) -> tuple[str, str]:
    """The text and the encoding it was read with."""
    if b"\x00" in data:
        raise TabularError("This file is not CSV text: it holds binary data.")
    if encoding is not None:
        if encoding not in ENCODINGS:
            raise TabularError(f"{encoding} is not one of the encodings offered.", "not-text")
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError as exc:
            raise TabularError(
                f"This file cannot be read as {encoding}: the byte at position "
                f"{exc.start:,} is not valid there. Try another encoding."
            ) from exc
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig", errors="strict"), "utf-8-sig"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("windows-1252"), "windows-1252"
    except UnicodeDecodeError as exc:
        raise TabularError(
            "This file is not CSV text: it is neither UTF-8 nor Windows-1252."
        ) from exc


def detect_separator(text: str) -> str:
    """The separator giving the first lines the most consistent width.

    Each candidate splits the first 20 lines; the winner has a header wider
    than one column, the most lines as wide as the header, then the widest
    header. A file of one column is read with a comma."""
    head = "\n".join(text.splitlines()[:20])
    best, best_score = ",", None
    for sep in SEPARATORS:
        try:
            widths = [len(r) for r in csv.reader(io.StringIO(head, newline=""), delimiter=sep) if r]
        except csv.Error:
            continue
        if not widths:
            continue
        same = sum(1 for w in widths if w == widths[0])
        score = (widths[0] > 1, same, widths[0])
        if best_score is None or score > best_score:
            best, best_score = sep, score
    return best


def _named(header: list[str], width: int) -> tuple[list[str], list[dict]]:
    """Usable column names: empty ones numbered, repeats suffixed, each said."""
    names: list[str] = []
    renamed: list[dict] = []
    for index in range(width):
        raw = header[index].strip() if index < len(header) else ""
        name = unique_name(raw or f"column {index + 1}", names)
        if name != raw:
            renamed.append({"index": index, "from": raw, "to": name})
        names.append(name)
    return names, renamed


def read_table(
    data: bytes,
    *,
    separator: Optional[str] = None,
    encoding: Optional[str] = None,
    header: bool = True,
) -> Table:
    """The file read under the limits: at most MAX_ROWS rows kept, all counted."""
    check_size(len(data))
    text, used = decode(data, encoding)
    if separator is not None and separator not in SEPARATORS:
        raise TabularError("The separator is a comma, a semicolon or a tab.", "not-text")
    sep = separator or detect_separator(text)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=sep)
    head: Optional[list[str]] = None
    kept: list[list[str]] = []
    total = 0
    width = 0
    line = 0
    try:
        for row in reader:
            line += 1
            if not row:
                continue  # a blank line is no row, and is not numbered
            if len(row) > MAX_COLUMNS:
                raise TabularError(
                    f"This file has {len(row):,} columns. Semantic Studio imports at most "
                    f"{MAX_COLUMNS} columns: {WHY}.",
                    "too-large",
                )
            for index, cell in enumerate(row):
                if len(cell) > MAX_CELL:
                    raise TabularError(
                        f"Line {line:,}, column {index + 1} holds {len(cell):,} characters. A cell "
                        f"can hold at most {MAX_CELL:,} characters, as in Excel.",
                        "too-large",
                    )
            if header and head is None:
                head = row
                width = len(row)
                continue
            total += 1
            if total <= MAX_ROWS:
                kept.append([cell.strip() for cell in row])
                width = max(width, len(row))
    except csv.Error as exc:
        # csv's own field limit (128 KB) is above MAX_CELL, so meeting it
        # means a cell far past ours: the same refusal.
        if "field larger than field limit" in str(exc):
            raise TabularError(
                f"Line {line + 1:,} holds a cell of more than {MAX_CELL:,} characters. A cell "
                f"can hold at most {MAX_CELL:,} characters, as in Excel.",
                "too-large",
            ) from exc
        raise TabularError(f"This file is not CSV text: {exc} (line {line + 1:,}).") from exc
    if head is None and not kept:
        raise TabularError("This file is empty.", "empty")
    columns, renamed = _named(head or [], width)
    if not header:
        renamed = []  # nothing was named, so nothing was renamed
    rows = [row + [""] * (width - len(row)) for row in kept]
    return Table(columns, rows, total, sep, used, header, renamed)


# ---------------------------------------------------------------------------
# What the wizard shows
# ---------------------------------------------------------------------------

_ID_NAMES = {"id", "code", "key"}
_NAME_NAMES = ("name", "label", "title")


def listed(rows: list[int]) -> dict:
    """A list of row numbers for a sentence: the first few and the count."""
    return {"count": len(rows), "rows": rows[:LISTED_ROWS]}


def column_profile(table: Table, index: int) -> dict:
    values = [row[index] for row in table.rows]
    present = [v for v in values if v]
    counts: dict[str, int] = {}
    for v in present:
        counts[v] = counts.get(v, 0) + 1
    return {
        "name": table.columns[index],
        "empty": len(values) - len(present),
        "unique": len(counts) == len(present),
        "repeats": sum(1 for c in counts.values() if c > 1),
        # What a new attribute's type is suggested from (5.4).
        "wholeNumbers": bool(present) and all(lexical.valid(v, "integer") for v in present),
        "numbers": bool(present) and all(lexical.valid(v, "decimal") for v in present),
        "dates": bool(present) and all(lexical.valid(v, "date") for v in present),
        "dateTimes": bool(present) and all(lexical.valid(v, "dateTime") for v in present),
    }


def _simple(name: str) -> str:
    return re.sub(r"[\s_-]+", "", name).casefold()


def id_check(table: Table, column: Optional[str]) -> dict:
    """Step 2's check of the identifier, on every row kept (5.3)."""
    if column is None:
        return {"column": None, "ok": True, "missing": listed([]), "repeats": 0, "repeated": listed([])}
    index = table.column(column)
    missing: list[int] = []
    first: dict[str, int] = {}
    repeated: list[int] = []
    values_repeating: set[str] = set()
    for number, row in enumerate(table.rows, start=1):
        value = row[index]
        if not value:
            missing.append(number)
        elif value in first:
            repeated.append(number)
            values_repeating.add(value)
        else:
            first[value] = number
    return {
        "column": column,
        "ok": not missing and not repeated,
        "missing": listed(missing),
        "repeats": len(values_repeating),
        "repeated": listed(repeated),
    }


def suggest_id(table: Table) -> Optional[str]:
    """A column named id, code, key or ending in _id, all present and unique."""
    for index, name in enumerate(table.columns):
        simple = name.strip().casefold()
        if simple in _ID_NAMES or simple.endswith("_id"):
            if id_check(table, name)["ok"] and table.rows:
                return name
    return None


def suggest_name(table: Table) -> Optional[str]:
    for wanted in _NAME_NAMES:
        for name in table.columns:
            if _simple(name) == wanted:
                return name
    return None


def inspect(table: Table) -> dict:
    """Step 1: the detections, the first rows and each column's make-up."""
    result = {
        "separator": table.separator,
        "separatorName": SEPARATORS[table.separator],
        "encoding": table.encoding,
        "header": table.header,
        "columns": [column_profile(table, i) for i in range(len(table.columns))],
        "renamed": table.renamed,
        "rows": table.rows[:SHOWN_ROWS],
        "total": table.total,
        "kept": len(table.rows),
        "limit": MAX_ROWS,
        "sample": table.sample,
        "limitSentence": rows_sentence(table.total) if table.sample else None,
        "idSuggestion": suggest_id(table),
        "nameSuggestion": suggest_name(table),
    }
    return result


def write_csv(table: Table, encoding: str, separator: str, row_column: Optional[str] = None) -> bytes:
    """The copy kept in the project: the header as named here, the rows kept
    (never more than MAX_ROWS), values as trimmed, in the given dialect.

    Written rather than copied byte for byte, so the mapping's references,
    the dialect it declares and another RML engine reading it all meet the
    same table the app imported: a renamed header, a header-less file, a
    row number and a cut at row 2,000 are all in the file itself."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, delimiter=separator, lineterminator="\r\n")
    writer.writerow(([row_column] if row_column else []) + table.columns)
    for number, row in enumerate(table.rows, start=1):
        writer.writerow(([str(number)] if row_column else []) + row)
    # A byte-order mark is not written: another engine may read it as part
    # of the first column's name.
    name = "utf-8" if encoding == "utf-8-sig" else encoding
    return buffer.getvalue().encode(name)


def unique_name(wanted: str, taken: list[str]) -> str:
    """`wanted`, or `wanted (2)`, ... -- a name not in `taken`."""
    folded = {t.casefold() for t in taken}
    if wanted.casefold() not in folded:
        return wanted
    count = 2
    while f"{wanted} ({count})".casefold() in folded:
        count += 1
    return f"{wanted} ({count})"
