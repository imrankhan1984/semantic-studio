"""
================================================================================
FILE: backend/app/query_export.py
================================================================================

SUMMARY
    The saved queries of one library ontology as a zip (wording-and-query-
    export 5.12, D-122): one .rq file per query, visual and text alike, each
    opening with comment lines that say what it is, and a README.txt in plain
    words. Offered in the removal dialog, so the queries can leave before the
    ontology goes with them.

BASIC IDEA
    A visual query stores its generated SPARQL beside its builder state, so
    every saved query has text to write; the builder state stays behind
    (no restore, D-122). The file is built in memory with the standard
    library's zipfile: a query is at most 100 KB of text, so a zip of them
    is small.

    The query names are the person's own words, and the ontology name comes
    from an uploaded file: both are untrusted. An entry name is cut down to
    letters, digits, spaces, hyphens and underscores, at most 80 characters,
    so no separator, no `..` and no drive letter can reach it, and a name
    with nothing left is *query*. Repeats take *(2)*, *(3)*, compared without
    case, since a Windows or macOS folder would let one overwrite the other
    when unpacked. In the comment lines, line breaks and every other control
    character become spaces: a name cannot end its comment and start a line
    of SPARQL.

INPUTS / INPUT SOURCES
    - The saved queries of one ontology, as SavedQueryStore.list gives them
      (newest first), and the ontology's name.

EXPECTED OUTPUT
    - The zip's bytes; `zip_filename`, the ASCII name the response header
      carries.
================================================================================
"""

from __future__ import annotations

import io
import re
import zipfile
from datetime import date
from typing import Iterable, Optional

# Longest entry name before ".rq" (5.12 item 1).
MAX_NAME_CHARS = 80

README = """\
Saved queries from Semantic Studio

Each .rq file in this folder is one saved query, written in SPARQL, the
standard query language for RDF. Any SPARQL tool can open them.

The lines at the top of each file that start with # are comments: the
query's name, the ontology it was saved against, how it was made and the
day it was exported. SPARQL ignores them.

To reopen a query in Semantic Studio, open the ontology, go to Query, choose
Text, then Open .rq file..., and pick the file.

A query made with the visual builder comes back as text: the file holds its
SPARQL, not the builder's steps.
"""

# C0 and C1 control characters and the Unicode line and paragraph
# separators: anything that could end a comment line or hide in one.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")


def one_line(text: str) -> str:
    """``text`` safe inside a ``#`` comment: control characters as spaces."""
    return _CONTROL.sub(" ", text)


def entry_stem(name: str) -> str:
    """A query name as an entry name, without ``.rq``: letters, digits,
    spaces, hyphens and underscores only, spaces collapsed, at most 80."""
    kept = "".join(ch if ch.isalnum() or ch in " -_" else " " for ch in name)
    stem = " ".join(kept.split())[:MAX_NAME_CHARS].strip()
    return stem or "query"


def _unique(stem: str, taken: set[str]) -> str:
    candidate, n = stem, 1
    while candidate.casefold() in taken:
        n += 1
        candidate = f"{stem} ({n})"
    taken.add(candidate.casefold())
    return candidate


def query_file(entry: dict, ontology_name: str, today: date) -> str:
    made = "the text editor" if entry.get("mode") == "text" else "the visual builder"
    head = (
        f"# Saved query: {one_line(str(entry.get('name', '')))}\n"
        f"# Ontology: {one_line(ontology_name)}\n"
        f"# Made with: {made}\n"
        f"# Exported from Semantic Studio on {today.isoformat()}\n"
    )
    return head + "\n" + str(entry.get("sparql", "")).rstrip("\n") + "\n"


def export_zip(entries: Iterable[dict], ontology_name: str, today: Optional[date] = None) -> bytes:
    """The zip of 5.12: each entry as ``<name>.rq``, then ``README.txt``.
    No entries gives a zip of the README alone (5.13)."""
    today = today or date.today()
    # README.txt is taken first, so a query named "README" cannot shadow it
    # on a case-insensitive disk; its .rq differs anyway, but the set is
    # the one rule for every name in the archive.
    taken = {"readme.txt"}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            stem = _unique(entry_stem(str(entry.get("name", ""))), taken)
            archive.writestr(f"{stem}.rq", query_file(entry, ontology_name, today))
        archive.writestr("README.txt", README)
    return buffer.getvalue()


def zip_filename(ontology_name: str) -> str:
    """The header's file name: ASCII letters, digits, dots, hyphens and
    underscores, so no quote or line break reaches Content-Disposition. The
    browser saves under the name the page gives, the ontology's own."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", ontology_name).strip("-.")[:MAX_NAME_CHARS]
    return f"{stem or 'ontology'}-saved-queries.zip"
