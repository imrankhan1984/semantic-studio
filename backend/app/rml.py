"""
================================================================================
FILE: backend/app/rml.py
================================================================================

SUMMARY
    The data import's mappings (csv-data-import 5.4, D-099): a mapping written
    as standard RML from the wizard's choices, a mapping read back and refused
    when it uses anything outside the subset the app runs, and the engine that
    runs one on a table's rows into a graph, with the import report.

BASIC IDEA
    The mapping is saved as RML so it is the expert's to read, edit and run in
    another engine (RMLMapper, Morph-KGC). The Python RML engines cannot be
    installed beside pySHACL (Section 1), so the app runs a documented subset
    of its own, and only that subset is written or accepted:

      one rml:TriplesMap; rml:logicalSource with rml:source and
      rml:referenceFormulation rml:CSV; rml:subjectMap with rml:template and
      rml:class; rml:predicateObjectMap with rml:predicate and an
      rml:objectMap of rml:reference, rml:template or rml:constant, with an
      optional rml:datatype or rml:language; the CSV dialect as csvw:dialect.

    Reading checks every statement of the mapping against that list, so
    anything else -- rml:function, a join, a named graph, R2RML's rr: terms
    -- is refused with its name, and the snapshot keeps its last good data.

    rml:source must name this snapshot's own source.csv, as a literal or as
    a csvw:Table's csvw:url. A path, `..`, a drive, a URL or any other file
    is refused (Section 9): this is the check that keeps an edited mapping
    from reading C:\\Users\\... or fetching from the network. The engine never
    opens a file itself; it is handed the table the snapshot read.

    The engine takes at most 2,000 rows (D-098) whatever it is handed, so the
    limit holds for the wizard, a refresh and an edited mapping alike. A value
    that does not fit its rml:datatype is written as plain text and counted
    per column (D-097), never as an ill-typed literal, so a SHACL type rule
    reports it. An empty cell writes nothing. A template value is
    percent-encoded as RML's IRI-safe rule says; a row whose subject has an
    empty reference makes no individual and is reported as skipped.

INPUTS / INPUT SOURCES
    - The wizard's choices (from snapshots.py), or a mapping's Turtle text.
    - A tabular.Table read from the snapshot's source.csv.

EXPECTED OUTPUT
    - build(...) -> the mapping as a Graph; to_turtle(graph) -> its text.
    - read(text, base) -> Mapping, or UnsupportedMapping naming the feature.
    - run(mapping, table) -> (Graph, {report, subjects, links}): the report
      as the wizard shows it, each individual's IRI with the row it came
      from, and for each template object map the rows pointing at each IRI
      (5.9's links between snapshots).
================================================================================
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS, SKOS, XSD

from . import lexical
from .tabular import MAX_ROWS, SEPARATORS, Table, listed

# The W3C community group's namespace (Section 5.4), not the older
# semweb.mmlab.be one: RMLMapper and Morph-KGC read both.
RML = Namespace("http://w3id.org/rml/")
CSVW = Namespace("http://www.w3.org/ns/csvw#")

SOURCE_NAME = "source.csv"

# An edited mapping's size. The wizard writes one map per column (at most
# 100); a hand-written one with thousands would multiply 2,000 rows into a
# graph no time limit stops growing, since the worker cannot be interrupted.
MAX_MAPS = 300

# Every predicate the subset uses. Anything else in a mapping is a feature
# the engine does not run, and is named in the refusal.
_ALLOWED = {
    RDF.type,
    RML.logicalSource, RML.source, RML.referenceFormulation,
    RML.subjectMap, RML.template, RML["class"],
    RML.predicateObjectMap, RML.predicate, RML.objectMap,
    RML.reference, RML.constant, RML.datatype, RML.language,
    CSVW.url, CSVW.dialect, CSVW.delimiter, CSVW.encoding, CSVW.header,
}
_TYPES = {
    RML.TriplesMap, RML.LogicalSource, RML.SubjectMap, RML.PredicateObjectMap,
    RML.ObjectMap, CSVW.Table, CSVW.Dialect,
}
_ENCODINGS = {"utf-8": "utf-8", "utf8": "utf-8", "windows-1252": "windows-1252", "cp1252": "windows-1252"}


class UnsupportedMapping(ValueError):
    """A mapping outside the subset, or one that cannot run; the sentence
    names what."""


@dataclass
class ObjectMap:
    kind: str                                  # reference | template | constant
    value: Union[str, URIRef, Literal]
    datatype: Optional[URIRef] = None
    language: Optional[str] = None


@dataclass
class Mapping:
    subject: str                               # the subject's rml:template
    classes: list = field(default_factory=list)
    poms: list = field(default_factory=list)   # [(predicate, ObjectMap)]
    separator: str = ","
    encoding: str = "utf-8"

    def references(self) -> list[str]:
        """Every column the mapping reads, in order of first mention."""
        found: list[str] = []
        for part in template_parts(self.subject):
            if isinstance(part, tuple) and part[1] not in found:
                found.append(part[1])
        for _, om in self.poms:
            names = (
                [om.value] if om.kind == "reference"
                else [p[1] for p in template_parts(om.value) if isinstance(p, tuple)] if om.kind == "template"
                else []
            )
            for name in names:
                if name not in found:
                    found.append(name)
        return found


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


def escape(text: str) -> str:
    """Literal text inside an rml:template: braces and backslashes escaped."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def template_parts(template: str) -> list:
    """A template as text and ("ref", column) pieces, escapes undone."""
    parts: list = []
    text: list[str] = []
    i = 0
    while i < len(template):
        ch = template[i]
        if ch == "\\" and i + 1 < len(template):
            text.append(template[i + 1])
            i += 2
            continue
        if ch == "{":
            name: list[str] = []
            i += 1
            while i < len(template) and template[i] != "}":
                if template[i] == "\\" and i + 1 < len(template):
                    i += 1
                name.append(template[i])
                i += 1
            if i >= len(template):
                raise UnsupportedMapping(f"The template {template} has a {{ that is never closed.")
            if text:
                parts.append("".join(text))
                text = []
            parts.append(("ref", "".join(name)))
            i += 1
            continue
        if ch == "}":
            raise UnsupportedMapping(f"The template {template} has a }} that was never opened.")
        text.append(ch)
        i += 1
    if text:
        parts.append("".join(text))
    return parts


_UNRESERVED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def iri_safe(value: str) -> str:
    """RML's IRI-safe form of a value: every ASCII character outside the
    unreserved set percent-encoded, as UTF-8 bytes. Other characters too,
    so the IRI is the same whichever engine wrote it."""
    out = []
    for ch in value:
        if ch in _UNRESERVED:
            out.append(ch)
        else:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8"))
    return "".join(out)


# ---------------------------------------------------------------------------
# Writing a mapping from the wizard's choices
# ---------------------------------------------------------------------------


def build(
    *,
    map_iri: str,
    subject_template: str,
    classes: list,
    poms: list,
    separator: str,
    encoding: str,
) -> Graph:
    """The mapping as RML. `poms` is [(predicate, ObjectMap)]."""
    g = Graph()
    g.bind("rml", RML)
    g.bind("csvw", CSVW)
    g.bind("xsd", XSD)
    g.bind("rdfs", RDFS)
    g.bind("skos", SKOS)
    tm = URIRef(map_iri)
    g.add((tm, RDF.type, RML.TriplesMap))
    ls, source, dialect = BNode(), BNode(), BNode()
    g.add((tm, RML.logicalSource, ls))
    g.add((ls, RDF.type, RML.LogicalSource))
    g.add((ls, RML.source, source))
    g.add((ls, RML.referenceFormulation, RML.CSV))
    # RMLMapper reads the dialect from the source, a csvw:Table.
    g.add((source, RDF.type, CSVW.Table))
    g.add((source, CSVW.url, Literal(SOURCE_NAME)))
    g.add((source, CSVW.dialect, dialect))
    g.add((dialect, RDF.type, CSVW.Dialect))
    g.add((dialect, CSVW.delimiter, Literal(separator)))
    g.add((dialect, CSVW.encoding, Literal("utf-8" if encoding == "utf-8-sig" else encoding)))
    g.add((dialect, CSVW.header, Literal(True)))
    sm = BNode()
    g.add((tm, RML.subjectMap, sm))
    g.add((sm, RML.template, Literal(subject_template)))
    for cls in classes:
        g.add((sm, RML["class"], cls))
    for predicate, om in poms:
        pom, node = BNode(), BNode()
        g.add((tm, RML.predicateObjectMap, pom))
        g.add((pom, RML.predicate, predicate))
        g.add((pom, RML.objectMap, node))
        if om.kind == "constant":
            g.add((node, RML.constant, om.value))
        else:
            g.add((node, RML[om.kind], Literal(om.value)))
        if om.datatype is not None:
            g.add((node, RML.datatype, om.datatype))
        if om.language:
            g.add((node, RML.language, Literal(om.language)))
    return g


def to_turtle(graph: Graph) -> str:
    return graph.serialize(format="turtle")


# ---------------------------------------------------------------------------
# Reading a mapping, and refusing what is outside the subset
# ---------------------------------------------------------------------------


def _name(graph: Graph, term) -> str:
    try:
        return graph.namespace_manager.normalizeUri(term)
    except Exception:  # noqa: BLE001 - any failure to shorten just keeps the IRI
        return f"<{term}>"


def _one(graph: Graph, node, predicate, what: str, required: bool = True):
    values = list(graph.objects(node, predicate))
    if len(values) > 1:
        raise UnsupportedMapping(f"A mapping here has one {what}; this one has {len(values)}.")
    if not values:
        if required:
            raise UnsupportedMapping(f"This mapping has no {what}.")
        return None
    return values[0]


def check_source(value) -> None:
    """rml:source names this snapshot's source.csv and nothing else (Section 9)."""
    text = str(value)
    if not isinstance(value, Literal) or text != SOURCE_NAME:
        raise UnsupportedMapping(
            f"rml:source must name this snapshot's own {SOURCE_NAME}; this mapping names {text}. "
            "A mapping here reads only the copy kept with it, never another file or a URL."
        )


def read(text: str, base: str) -> Mapping:
    """The mapping in `text`, checked against the subset, or UnsupportedMapping."""
    graph = Graph()
    graph.bind("rml", RML)
    graph.bind("csvw", CSVW)
    try:
        # The project's base, never the server's folder, for a relative IRI
        # (CF-8): <#map> must not become file:///C:/...
        graph.parse(data=text, format="turtle", publicID=base)
    except Exception as exc:  # noqa: BLE001 - rdflib raises many kinds
        raise UnsupportedMapping(f"This mapping is not valid Turtle: {str(exc).splitlines()[0]}") from exc
    return read_graph(graph)


def read_graph(graph: Graph) -> Mapping:
    for s, p, o in graph:
        if p not in _ALLOWED:
            raise UnsupportedMapping(
                f"{_name(graph, p)} is outside what Semantic Studio runs. The mapping is kept as "
                "written and runs in other RML tools; the data stays as it was."
            )
        if p == RDF.type and o not in _TYPES:
            raise UnsupportedMapping(
                f"{_name(graph, o)} is outside what Semantic Studio runs. The mapping is kept as "
                "written and runs in other RML tools; the data stays as it was."
            )
    maps = set(graph.subjects(RML.logicalSource, None)) | set(graph.subjects(RDF.type, RML.TriplesMap))
    if len(maps) != 1:
        raise UnsupportedMapping(
            f"A mapping here has one triples map; this one has {len(maps)}."
        )
    tm = next(iter(maps))
    ls = _one(graph, tm, RML.logicalSource, "logical source")
    formulation = _one(graph, ls, RML.referenceFormulation, "reference formulation")
    if formulation != RML.CSV:
        raise UnsupportedMapping(f"{_name(graph, formulation)} is outside what Semantic Studio runs: it reads CSV.")
    source = _one(graph, ls, RML.source, "rml:source")
    separator, encoding = ",", "utf-8"
    if isinstance(source, Literal):
        check_source(source)
    else:
        check_source(_one(graph, source, CSVW.url, "csvw:url"))
        dialect = _one(graph, source, CSVW.dialect, "csvw:dialect", required=False)
        if dialect is not None:
            delimiter = _one(graph, dialect, CSVW.delimiter, "csvw:delimiter", required=False)
            if delimiter is not None:
                separator = str(delimiter)
                if separator not in SEPARATORS:
                    raise UnsupportedMapping("csvw:delimiter is a comma, a semicolon or a tab here.")
            named = _one(graph, dialect, CSVW.encoding, "csvw:encoding", required=False)
            if named is not None:
                encoding = _ENCODINGS.get(str(named).lower(), "")
                if not encoding:
                    raise UnsupportedMapping(f"The encoding {named} is not one Semantic Studio reads.")
            header = _one(graph, dialect, CSVW.header, "csvw:header", required=False)
            if header is not None and not bool(header.toPython()):
                raise UnsupportedMapping("csvw:header false is outside what Semantic Studio runs: it reads a header row.")
    sm = _one(graph, tm, RML.subjectMap, "subject map")
    template = _one(graph, sm, RML.template, "subject template")
    template_parts(str(template))  # a malformed template is refused now, not per row
    mapping = Mapping(
        subject=str(template),
        classes=sorted(c for c in graph.objects(sm, RML["class"]) if isinstance(c, URIRef)),
        separator=separator,
        encoding=encoding,
    )
    for pom in graph.objects(tm, RML.predicateObjectMap):
        predicates = list(graph.objects(pom, RML.predicate))
        objects = list(graph.objects(pom, RML.objectMap))
        if not predicates or not objects:
            raise UnsupportedMapping("Each predicate-object map here has an rml:predicate and an rml:objectMap.")
        for node in objects:
            om = _object_map(graph, node)
            for predicate in predicates:
                if not isinstance(predicate, URIRef):
                    raise UnsupportedMapping("An rml:predicate is an IRI.")
                mapping.poms.append((predicate, om))
        if len(mapping.poms) > MAX_MAPS:
            raise UnsupportedMapping(
                f"A mapping here writes at most {MAX_MAPS} predicate-object pairs per row; this one writes more."
            )
    if len(mapping.classes) > MAX_MAPS:
        raise UnsupportedMapping(f"A mapping here gives a row at most {MAX_MAPS} classes; this one gives more.")
    mapping.poms.sort(key=lambda p: (str(p[0]), p[1].kind, str(p[1].value)))
    return mapping


def _object_map(graph: Graph, node) -> ObjectMap:
    kinds = [
        (kind, value)
        for kind in ("reference", "template", "constant")
        for value in graph.objects(node, RML[kind])
    ]
    if len(kinds) != 1:
        raise UnsupportedMapping(
            "Each object map here has exactly one of rml:reference, rml:template and rml:constant."
        )
    kind, value = kinds[0]
    datatype = _one(graph, node, RML.datatype, "rml:datatype", required=False)
    language = _one(graph, node, RML.language, "rml:language", required=False)
    if datatype is not None and language is not None:
        raise UnsupportedMapping("An object map has an rml:datatype or an rml:language, not both.")
    if kind == "template":
        template_parts(str(value))
    if kind != "constant":
        value = str(value)
    return ObjectMap(kind, value, datatype if isinstance(datatype, URIRef) else None,
                     str(language) if language is not None else None)


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------


def expand(parts: list, row: list, index: dict) -> tuple[Optional[str], Optional[str]]:
    """The template filled from a row, or (None, the empty column)."""
    out = []
    for part in parts:
        if isinstance(part, tuple):
            value = row[index[part[1]]]
            if not value:
                return None, part[1]
            out.append(iri_safe(value))
        else:
            out.append(part)
    return "".join(out), None


def _absolute(iri: str) -> bool:
    scheme, colon, _ = iri.partition(":")
    return bool(colon) and scheme[:1].isalpha() and all(c.isalnum() or c in "+-." for c in scheme)


def _datatype_name(datatype: URIRef) -> Optional[str]:
    text = str(datatype)
    return text[len(str(XSD)):] if text.startswith(str(XSD)) else None


def run(mapping: Mapping, table: Table) -> tuple[Graph, dict]:
    """Run the mapping on the table: the statements, and the import report.

    At most MAX_ROWS rows, whatever the table holds (D-098)."""
    index = {name: i for i, name in enumerate(table.columns)}
    missing = [name for name in mapping.references() if name not in index]
    if missing:
        raise UnsupportedMapping(
            "The mapping reads " + " and ".join(f"column {m}" for m in missing)
            + ", which this file does not have."
        )
    subject_parts = template_parts(mapping.subject)
    compiled = []
    for predicate, om in mapping.poms:
        parts = template_parts(om.value) if om.kind == "template" else None
        column = om.value if om.kind == "reference" else None
        name = _datatype_name(om.datatype) if om.datatype is not None else None
        compiled.append((predicate, om, parts, column, name))

    graph = Graph()
    subjects: dict[str, int] = {}
    skipped: list[int] = []
    repeated: list[int] = []
    as_text: dict[str, list[int]] = {}
    empty: dict[str, int] = {}
    datatype_of: dict[str, str] = {}
    targets: dict[tuple, dict[str, list[int]]] = {}
    rows = table.rows[:MAX_ROWS]
    for number, row in enumerate(rows, start=1):
        iri, _ = expand(subject_parts, row, index)
        if iri is None:
            skipped.append(number)
            continue
        if not _absolute(iri):
            raise UnsupportedMapping(f"The subject template makes {iri}, which is not an absolute IRI.")
        subject = URIRef(iri)
        if iri in subjects:
            repeated.append(number)
        else:
            subjects[iri] = number
        for cls in mapping.classes:
            graph.add((subject, RDF.type, cls))
        for predicate, om, parts, column, name in compiled:
            if om.kind == "constant":
                graph.add((subject, predicate, om.value))
                continue
            if om.kind == "template":
                value, blank = expand(parts, row, index)
                if value is None:
                    empty[blank] = empty.get(blank, 0) + 1
                    continue
                graph.add((subject, predicate, URIRef(value)))
                # Which row points where, so a link to a row no snapshot
                # holds can be reported (5.9).
                targets.setdefault((str(predicate), om.value), {}).setdefault(value, []).append(number)
                continue
            value = row[index[column]]
            if not value:
                empty[column] = empty.get(column, 0) + 1
                continue
            if om.language:
                term = Literal(value, lang=om.language)
            elif om.datatype is not None:
                if name is not None and not lexical.valid(value, name):
                    # D-097: plain text and counted, never an ill-typed literal.
                    term = Literal(value)
                    as_text.setdefault(column, []).append(number)
                    datatype_of[column] = name
                else:
                    term = Literal(value, datatype=om.datatype)
            else:
                term = Literal(value)
            graph.add((subject, predicate, term))
    report = {
        "rowsRead": len(rows),
        "total": table.total,
        "sample": table.total > MAX_ROWS,
        "individuals": len(subjects),
        "statements": len(graph),
        "skipped": listed(skipped),
        "repeated": listed(repeated),
        "keptAsText": [
            {"column": column, "datatype": datatype_of[column], **listed(numbers)}
            for column, numbers in as_text.items()
        ],
        "empty": [{"column": column, "count": count} for column, count in empty.items()],
    }
    report["clean"] = not (skipped or repeated or as_text)
    links = [
        {"predicate": predicate, "template": template, "targets": found}
        for (predicate, template), found in targets.items()
    ]
    return graph, {"report": report, "subjects": subjects, "links": links}
