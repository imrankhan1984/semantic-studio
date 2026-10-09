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
    Stage B (5.8): an Excel workbook's chosen sheet, from a chosen header
    row, read into the same table under the same limits, after Section 9's
    defences have judged the workbook without parsing any of it.

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

    A workbook is a ZIP of XML and untrusted in new ways (Section 9), so
    before openpyxl opens it: a macro-enabled or password-protected file,
    an Excel 97 one and anything that is not a ZIP are refused by name and
    first bytes; the ZIP's directory is refused past 100 MB unpacked or a
    100:1 ratio (a decompression bomb); every entry is then read to its end
    in bounded chunks, so its CRC proves its declared size, and refused if
    it holds a document type declaration, which Excel never writes and an
    entity attack needs. Only then does openpyxl read it, read-only and
    data_only (a formula gives its last saved value, never run), its XML
    through defusedxml, lxml switched off before openpyxl is imported -- and
    if any parser openpyxl would use is not defusedxml's, the workbook is
    refused rather than parsed.

    A sheet becomes the same Table a CSV file does: rows above the header
    row skipped, empty rows not counted, each cell as the text the type
    rule reads (a whole number without ".0", a date as xsd:date, with a
    time as xsd:dateTime), at most 100 columns and 32,767 characters a
    cell, 2,000 rows kept per sheet and all counted. Its rows come from
    openpyxl's parser rather than its row iterator, which pads every row to
    the sheet's widest column and fills every missing row.

INPUTS / INPUT SOURCES
    - The file's bytes and the name the browser gave it; optionally the
      separator, encoding and header flag the user chose instead of the
      detected ones, or a workbook's sheet and header row.

EXPECTED OUTPUT
    - read_table(...) -> Table: columns, at most 2,000 rows, the true total,
      the dialect used and the renamings.
    - read_workbook(...) -> the same Table for a sheet, with the workbook's
      sheets and first rows; read_file(...) picks CSV or workbook.
    - inspect(table) -> the JSON the wizard's first step shows.
    - write_csv(table, ...) -> the bytes of the copy kept in the project.
    - TabularError, a sentence, for anything refused; its `kind` says which
      state the wizard shows (too-large, not-text, empty).
================================================================================
"""

from __future__ import annotations

import os

# Section 9: openpyxl picks its XML parser once, when it is first imported.
# With lxml installed it takes lxml for fromstring, not defusedxml, while
# its DEFUSEDXML flag still says True. So lxml is switched off here, before
# anything imports openpyxl, and _open_workbook checks the functions it
# ended up with rather than the flag.
os.environ["OPENPYXL_LXML"] = "False"

import csv
import datetime
import decimal
import io
import re
import zipfile
import zlib
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

    def __init__(self, message: str, kind: str = "not-text", workbook: Optional[dict] = None) -> None:
        super().__init__(message)
        self.kind = kind
        # A workbook's sheets and the chosen sheet's first rows, when a sheet
        # was read but gave no table: step 1 keeps its pickers with them.
        self.workbook = workbook


@dataclass
class Table:
    columns: list[str]
    rows: list[list[str]]          # at most MAX_ROWS, each len(columns) long
    total: int                     # data rows in the whole file
    separator: str
    encoding: str
    header: bool
    renamed: list[dict] = field(default_factory=list)
    # A workbook's sheets, the one read and its header row (5.8); None for CSV.
    workbook: Optional[dict] = None

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
# Excel (Stage B, 5.8 and Section 9)
# ---------------------------------------------------------------------------

# Section 9: a workbook is a ZIP of XML, refused before openpyxl sees it when
# its entries would unpack past this, or pack tighter than this ratio.
XLSX_MAX_UNPACKED = 100 * 1024 * 1024
XLSX_MAX_RATIO = 100
# An entry smaller than this may pack tighter (a near-empty sheet XML does);
# the total's ratio still counts it.
_RATIO_FLOOR = 1024 * 1024
# The physical rows offered as header rows in step 1 (5.8).
HEADER_ROWS_SHOWN = 20
MAX_HEADER_ROW = 1_048_576  # Excel's last row

_ZIP = b"PK\x03\x04"
_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
# An encrypted .xlsx is an OLE container holding this stream, by its UTF-16 name.
_ENCRYPTED = "EncryptedPackage".encode("utf-16-le")
_REFUSED_SUFFIXES = {
    ".xlsm": "a macro-enabled workbook (.xlsm), which Semantic Studio does not accept: "
             "save it as an Excel workbook (.xlsx)",
    ".xltm": "a macro-enabled template (.xltm), which Semantic Studio does not accept: "
             "save it as an Excel workbook (.xlsx)",
    ".xlsb": "a binary workbook (.xlsb): save it as an Excel workbook (.xlsx) or as CSV",
    ".xls": "an Excel 97-2003 workbook (.xls): save it as an Excel workbook (.xlsx) or as CSV",
    ".ods": "an OpenDocument spreadsheet (.ods): save it as an Excel workbook (.xlsx) or as CSV",
}
# Excel never writes a document type declaration; one in a workbook is an
# entity attack. Searched as bytes in both encodings XML allows.
_DTD_MARKS = tuple(
    mark.encode(enc) for mark in ("<!DOCTYPE", "<!ENTITY") for enc in ("utf-8", "utf-16-le", "utf-16-be")
)


def _suffix(filename: str) -> str:
    name = re.split(r"[\\/]", filename or "")[-1].lower()
    return name[name.rfind("."):] if "." in name else ""


def is_workbook(data: bytes, filename: str = "") -> bool:
    """Whether the file is read as a workbook: by its name, or by its first
    bytes when the name says nothing -- a ZIP or an OLE container is never
    CSV text."""
    suffix = _suffix(filename)
    if suffix in (".csv", ".txt", ".tsv"):
        return data.startswith(_ZIP) or data.startswith(_OLE)
    return suffix in (".xlsx", ".xltx", *_REFUSED_SUFFIXES) or data.startswith((_ZIP, _OLE))


def check_workbook(data: bytes, filename: str = "") -> None:
    """Section 9's defences, all before openpyxl opens anything. Only the
    ZIP's central directory and the raw bytes of its entries are read here;
    no XML is parsed."""
    suffix = _suffix(filename)
    if suffix in _REFUSED_SUFFIXES:
        raise TabularError(f"This file is {_REFUSED_SUFFIXES[suffix]}.", "not-text")
    if data.startswith(_OLE):
        if _ENCRYPTED in data:
            raise TabularError(
                "This workbook is password protected. Open it in Excel, remove the password, "
                "and save it again.",
                "not-text",
            )
        raise TabularError(f"This file is {_REFUSED_SUFFIXES['.xls']}.", "not-text")
    if not data.startswith(_ZIP):
        raise TabularError("This file is not an Excel workbook (.xlsx).", "not-text")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        raise TabularError("This file is not an Excel workbook (.xlsx): it is a damaged ZIP.") from exc
    unpacked = sum(e.file_size for e in entries)
    packed = sum(e.compress_size for e in entries)
    bomb = (
        "This workbook would unpack to {what}. Semantic Studio refuses a workbook that unpacks "
        f"past {XLSX_MAX_UNPACKED // (1024 * 1024)} MB or more than {XLSX_MAX_RATIO} times its "
        "size: that is how a decompression bomb looks."
    )
    if unpacked > XLSX_MAX_UNPACKED:
        raise TabularError(bomb.format(what=f"{unpacked / (1024 * 1024):,.0f} MB"), "too-large")
    if unpacked > XLSX_MAX_RATIO * max(packed, 1):
        raise TabularError(bomb.format(what=f"{unpacked // max(packed, 1):,} times its size"), "too-large")
    for entry in entries:
        if entry.file_size >= _RATIO_FLOOR and entry.file_size > XLSX_MAX_RATIO * max(entry.compress_size, 1):
            raise TabularError(
                bomb.format(what=f"{entry.file_size // max(entry.compress_size, 1):,} times its size"),
                "too-large",
            )
        if entry.flag_bits & 0x1:
            raise TabularError(
                "This workbook is password protected. Open it in Excel, remove the password, "
                "and save it again.",
                "not-text",
            )
    names = {e.filename.lower() for e in entries}
    if any(n.endswith("vbaproject.bin") for n in names):
        raise TabularError(f"This file is {_REFUSED_SUFFIXES['.xlsm']}.", "not-text")
    try:
        # Every entry is read to its end before openpyxl sees any: its CRC
        # is checked there, so an entry whose data inflates past its
        # declared size -- which the checks above trusted -- fails here.
        # In chunks, never ZipFile.read: that inflates an entry's whole
        # compressed data in one call before cutting it to the declared
        # size, so a lying entry would be a bomb after all (found by
        # test_xlsx_defences).
        for entry in entries:
            if not entry.is_dir():
                _scan_entry(archive, entry)
    except (zipfile.BadZipFile, OSError, ValueError, EOFError, zlib.error, NotImplementedError) as exc:
        if isinstance(exc, TabularError):
            raise
        raise TabularError("This file is not an Excel workbook (.xlsx): it is a damaged ZIP.") from exc


_SCAN_CHUNK = 64 * 1024
_MARK_TAIL = max(len(mark) for mark in _DTD_MARKS) - 1


def _scan_entry(archive: zipfile.ZipFile, entry: zipfile.ZipInfo) -> None:
    """One entry's raw bytes, read in bounded chunks: no document type
    declaration, and no macro-enabled content type. A mark split across two
    chunks is found in the tail kept from the first."""
    contents = entry.filename.lower() == "[content_types].xml"
    tail = b""
    with archive.open(entry) as stream:
        while chunk := stream.read(_SCAN_CHUNK):
            window = tail + chunk
            if contents and b"macroenabled" in window.lower():
                raise TabularError(f"This file is {_REFUSED_SUFFIXES['.xlsm']}.", "not-text")
            if any(mark in window for mark in _DTD_MARKS):
                raise TabularError(
                    f"This workbook holds an XML document type declaration ({entry.filename}), which "
                    "Excel never writes. It is refused: declarations are how XML entity attacks work.",
                    "not-text",
                )
            tail = window[-_MARK_TAIL:]


def cell_text(value) -> str:
    """A cell as the copy's text (5.8): numbers as numbers, a date as
    xsd:date or, with a time set, xsd:dateTime, so the column's make-up and
    the engine's type rule read it as Excel showed it."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime.datetime):
        if value.time() == datetime.time(0):
            return value.date().isoformat()
        return value.isoformat(timespec="seconds" if not value.microsecond else "microseconds")
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        seconds = value.total_seconds()
        sign, seconds = ("-" if seconds < 0 else ""), abs(seconds)
        hours, rest = divmod(seconds, 3600)
        minutes, secs = divmod(rest, 60)
        return f"{sign}PT{int(hours)}H{int(minutes)}M{secs:g}S"
    if isinstance(value, float):
        # Excel holds every number as a double: 12.0 is the whole number 12,
        # and 1e-05 is written out, so xsd:decimal reads it.
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        text = repr(value)
        return format(decimal.Decimal(text), "f") if "e" in text.lower() and "inf" not in text and "nan" not in text else text
    return str(value)


def _sheet_cells(sheet):
    """(row number, [(column, value)]) for each row the sheet's XML holds.

    openpyxl's own row iterator pads every row to its widest column and
    fills every missing row, so one crafted cell in column XFD or row
    1,048,576 makes millions of empty values; its parser, which the
    iterator wraps, yields only what is written. Pinned at 3.1.5."""
    from openpyxl.worksheet._reader import WorkSheetParser

    book = sheet.parent
    with sheet._get_source() as source:
        parser = WorkSheetParser(
            source, sheet._shared_strings, data_only=True, epoch=book.epoch,
            date_formats=book._date_formats, timedelta_formats=book._timedelta_formats,
        )
        for number, cells in parser.parse():
            yield number, [(c["column"], c["value"]) for c in cells if c["value"] is not None]


def _sheet_row(sheet_name: str, number: int, cells: list) -> list[str]:
    """A row's cells as text by position, under the column and cell limits."""
    texts: dict[int, str] = {}
    for column, value in cells:
        text = cell_text(value)
        if not text.strip():
            continue
        if column > MAX_COLUMNS:
            raise TabularError(
                f"Sheet {sheet_name} has a value in column {column:,} (row {number:,}). Semantic Studio "
                f"imports at most {MAX_COLUMNS} columns: {WHY}.",
                "too-large",
            )
        if len(text) > MAX_CELL:
            raise TabularError(
                f"Sheet {sheet_name}, row {number:,}, column {column} holds {len(text):,} characters. "
                f"A cell can hold at most {MAX_CELL:,} characters, as in Excel.",
                "too-large",
            )
        texts[column] = text
    if not texts:
        return []
    return [texts.get(i, "") for i in range(1, max(texts) + 1)]


# The parser functions openpyxl reads a workbook through: its own module,
# and the names its readers bound when they were imported (openpyxl 3.1.5).
_PARSER_NAMES = (
    ("openpyxl.xml.functions", "fromstring"),
    ("openpyxl.xml.functions", "iterparse"),
    ("openpyxl.reader.excel", "fromstring"),
    ("openpyxl.reader.workbook", "fromstring"),
    ("openpyxl.reader.strings", "iterparse"),
    ("openpyxl.styles.stylesheet", "fromstring"),
    ("openpyxl.worksheet._reader", "iterparse"),
)


def parses_through_defusedxml() -> bool:
    """Whether every parser openpyxl would read a workbook with is
    defusedxml's. The DEFUSEDXML flag alone is not the answer: with lxml
    imported it stays True while fromstring is lxml's."""
    import importlib

    import openpyxl

    if not getattr(openpyxl, "DEFUSEDXML", False) or getattr(openpyxl, "LXML", False):
        return False
    for module, name in _PARSER_NAMES:
        function = getattr(importlib.import_module(module), name, None)
        if not getattr(function, "__module__", "").startswith("defusedxml"):
            return False
    return True


def _open_workbook(data: bytes):
    import openpyxl

    # Refuse rather than parse a workbook with any XML parser but
    # defusedxml's: the standard library's, or lxml's (Section 9).
    if not parses_through_defusedxml():
        raise TabularError(
            "Excel workbooks cannot be read safely here: openpyxl is not parsing through defusedxml.",
            "not-text",
        )
    return openpyxl.load_workbook(
        io.BytesIO(data), read_only=True, data_only=True, keep_vba=False, keep_links=False,
    )


def read_workbook(
    data: bytes,
    *,
    filename: str = "",
    sheet: Optional[str] = None,
    header_row: Optional[int] = None,
) -> Table:
    """A workbook's sheet read as a table under the same limits as a CSV
    file: at most MAX_ROWS rows kept and all counted, per sheet (5.8).

    Not chosen, the sheet is the first one holding a value, and the header
    row that sheet's first row holding one: a table starting at row 3, or
    behind an empty first sheet, is read as it stands rather than refused
    with no picker to change it (PR #54 review)."""
    check_size(len(data))
    if header_row is not None and (
        isinstance(header_row, bool) or not isinstance(header_row, int) or not 1 <= header_row <= MAX_HEADER_ROW
    ):
        raise TabularError("The header row is a row number, from 1.", "not-text")
    check_workbook(data, filename)
    try:
        book = _open_workbook(data)
    except TabularError:
        raise
    except Exception as exc:  # noqa: BLE001 - openpyxl and defusedxml raise many kinds
        raise TabularError(f"This workbook cannot be read: {_reason(exc)}") from exc
    try:
        from openpyxl.worksheet._read_only import ReadOnlyWorksheet

        sheets = [ws for ws in book.worksheets if isinstance(ws, ReadOnlyWorksheet)]
        if not sheets:
            raise TabularError("This workbook has no sheet of cells.", "empty")
        if sheet is None:
            chosen = next((ws for ws in sheets if _has_values(ws)), sheets[0])
        else:
            chosen = next((ws for ws in sheets if ws.title == sheet), None)
        if chosen is None:
            raise TabularError(f"This workbook has no sheet named {sheet}.", "not-text")
        listing = []
        table: Optional[Table] = None
        unread: Optional[TabularError] = None
        for ws in sheets:
            if ws is chosen:
                try:
                    table = _read_sheet(ws, header_row)
                    listing.append({"name": ws.title, "rows": table.total})
                except TabularError as exc:
                    if exc.kind != "empty":
                        raise
                    unread = exc
                    listing.append({"name": ws.title, "rows": 0})
            else:
                count = sum(1 for _, cells in _sheet_cells(ws) if any(cell_text(v).strip() for _, v in cells))
                # Below a header in its first row holding a value, as the
                # sheet would first be read.
                listing.append({"name": ws.title, "rows": max(count - 1, 0)})
        if unread is not None:
            # The sheet list and the rows that are there go with the
            # sentence, so step 1 can offer another sheet or row.
            unread.workbook = {**(unread.workbook or {}), "sheets": listing}
            raise unread
        assert table is not None
        table.workbook = {**table.workbook, "sheets": listing}
        return table
    except TabularError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise TabularError(f"This workbook cannot be read: {_reason(exc)}") from exc
    finally:
        book.close()


def _reason(exc: BaseException) -> str:
    """The first line of what went wrong. openpyxl wraps what its parser
    raised, so the chain is searched for defusedxml's refusal, which says
    what the workbook held."""
    seen = exc
    while seen is not None:
        if type(seen).__module__.startswith("defusedxml"):
            exc = seen
            break
        seen = seen.__cause__ or seen.__context__
    text = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    return text[:200]


def _has_values(ws) -> bool:
    """Whether a sheet holds any value; stops at the first row that does."""
    return any(any(cell_text(v).strip() for _, v in cells) for _, cells in _sheet_cells(ws))


def _read_sheet(ws, header_row: Optional[int]) -> Table:
    """The sheet below its header row: the one given, or else its first
    row holding a value."""
    name = ws.title
    top: list[dict] = []
    head: Optional[list[str]] = None
    kept: list[list[str]] = []
    total = 0
    width = 0
    for number, cells in _sheet_cells(ws):
        row = _sheet_row(name, number, cells)
        if number <= HEADER_ROWS_SHOWN:
            top.append({"row": number, "cells": [c for c in row if c][:4]})
        if header_row is None:
            if not row:
                continue
            header_row = number
        if number < header_row:
            continue
        if number == header_row:
            head = row
            width = len(row)
            continue
        if head is None:
            # The chosen header row is not in the sheet's XML: it is empty.
            head = []
        if not row:
            continue  # an empty row is no row, as a blank line in CSV
        total += 1
        if total <= MAX_ROWS:
            kept.append([cell.strip() for cell in row])
            width = max(width, len(row))
    # Every physical row up to the last one shown, an empty one included,
    # so the header row picker numbers them as Excel does.
    written = {entry["row"]: entry["cells"] for entry in top}
    last = max(written, default=0)
    top = [{"row": n, "cells": written.get(n, [])} for n in range(1, last + 1)]
    workbook = {"sheet": name, "headerRow": header_row or 1, "top": top}
    if head is None or not any(head):
        # Refused with the rows that are there, so step 1 keeps its pickers.
        if header_row is None or (total == 0 and not any(entry["cells"] for entry in top)):
            raise TabularError(f"Sheet {name} is empty.", "empty", workbook)
        raise TabularError(
            f"Row {header_row:,} of sheet {name} is empty: choose the row that holds the column names.",
            "empty",
            workbook,
        )
    columns, renamed = _named(head, width)
    rows = [row + [""] * (width - len(row)) for row in kept]
    return Table(columns, rows, total, ",", "utf-8", True, renamed, workbook)


def read_file(data: bytes, filename: str, options: dict) -> Table:
    """A CSV file or a workbook, as the options for its kind say."""
    options = options or {}
    if is_workbook(data, filename):
        return read_workbook(
            data, filename=filename, sheet=options.get("sheet"), header_row=options.get("headerRow"),
        )
    return read_table(
        data,
        separator=options.get("separator"),
        encoding=options.get("encoding"),
        header=bool(options.get("header", True)),
    )


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
        "format": "xlsx" if table.workbook else "csv",
        "workbook": table.workbook,
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
