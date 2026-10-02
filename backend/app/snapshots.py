"""
================================================================================
FILE: backend/app/snapshots.py
================================================================================

SUMMARY
    Data snapshots in a project (csv-data-import 5.3 to 5.7, D-096): what the
    wizard's steps 2 to 4 offer and preview, the import itself, and each
    snapshot's folder -- refresh, switch, change the mapping, edit it as RML,
    remove. Also the snapshot graphs the project's views join.

BASIC IDEA
    A snapshot is a folder data/<sid>/ in the project: source.csv (the data
    imported), mapping.rml.ttl (standard RML), data.ttl (the statements it
    produced, so a project opens without running anything) and
    snapshot.json (source name, date, both row counts, the wizard's
    choices, the report, and which row each individual came from). The
    folder's name is the server's: the file name's slug and six hex
    digits, matched in full before it is ever a path.

    Every import takes one path, whichever door it came through: the copy
    is written, the mapping is read back from its text, and the engine runs
    it on the copy. So the wizard, a refresh, a changed mapping and an
    edited one all produce data the same way, and the engine's 2,000-row
    stop (D-098) holds for each. The copy is written by tabular.write_csv:
    the rows imported, under the header names the mapping reads, in the
    dialect the mapping declares, so another RML engine given the folder
    produces the same statements (row D13).

    A snapshot is not part of the model. Nothing here touches a project
    document: no revision, no dirty flag, no undo step, as with the canvas
    layout (D-087). Its own counter, the generation, moves on every change,
    and the views are cached on it beside the revision (imports.py).
    Switched off, a snapshot stays on disk and leaves every view and
    validation.

    Step 3's choices for a column are the attributes and relationships of
    the row's class, its own and inherited, exactly as a shape's rule is
    offered them (shapes_form.paths_for); in a taxonomy, the concept's
    alternative names, definition and notation. A column whose header
    matches a choice's name -- case, spaces, _ and - ignored, in any
    project language, or the local name -- is suggested, never applied.

INPUTS / INPUT SOURCES
    - The project folder and manifest, through projects.ProjectStore.
    - The model with its imports, read under the model's lock by the caller.
    - A file's bytes and the user's dialect, sample and mapping choices.

EXPECTED OUTPUT
    - data/<sid>/ folders; the manifest's `data` list for the project card.
    - active(pid) -> (generation, [(graph, info)]) for the views.
    - JSON for the wizard: preview rows, the identifier check, the fields
      and suggestions, the report.
    - SnapshotError (422, a sentence) and UnknownSnapshot (404).
================================================================================
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF, RDFS, SKOS, XSD

from . import lexical, rml, tabular
from .examples import is_class
from .projects import ProjectStore, _replace
from .shapes_form import paths_for

DATA_DIR = "data"
TRASH_DIR = ".trash"
SOURCE = "source.csv"
MAPPING = "mapping.rml.ttl"
DATA = "data.ttl"
META = "snapshot.json"

# What the server names a snapshot folder. fullmatch, never match.
SNAPSHOT_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?-[0-9a-f]{6}")
# The rows step 4 previews as sentences.
PREVIEW_ROWS = 10
NAME_MAX = 120

Names = Callable[[URIRef], str]


class SnapshotError(ValueError):
    """A request that cannot be carried out, with the sentence saying why."""


class UnknownSnapshot(LookupError):
    """A snapshot id this project did not issue."""


@dataclass
class Loaded:
    meta: dict
    graph: Graph


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(text: str, limit: int = 30) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-")
    return slug or "data"


def display_name(filename: str) -> str:
    """The browser's file name, without any folder it claims, as text only."""
    name = re.split(r"[\\/]", filename or "")[-1].strip()
    return (name or "data.csv")[:NAME_MAX]


def local_name(iri: str) -> str:
    return re.split(r"[#/]", iri.rstrip("#/"))[-1] or iri


def class_slug(iri) -> str:
    """{class} in the IRI pattern {base}data/{class}/{id}: Person -> person."""
    return _slug(local_name(str(iri)), 60)


def _simple(text: str) -> str:
    return re.sub(r"[\s_-]+", "", text).casefold()


def _info(meta: dict) -> dict:
    """What a view needs to say where data came from."""
    return {
        "id": meta["id"],
        "source": meta["source"],
        "importedAt": meta["importedAt"],
        "rows": meta["rows"]["kept"],
        "total": meta["rows"]["total"],
        "sample": meta["rows"]["total"] > meta["rows"]["kept"],
    }


def summary(meta: dict) -> dict:
    report = meta.get("report", {})
    return {
        **_info(meta),
        "enabled": meta.get("enabled", True),
        "className": meta.get("className"),
        "classIri": meta.get("classIri"),
        "statements": meta.get("statements", 0),
        "individuals": report.get("individuals", 0),
        "report": report,
        "mapping": meta.get("mapping", {"status": "ok", "message": None}),
    }


# ---------------------------------------------------------------------------
# The wizard's choices
# ---------------------------------------------------------------------------

# A taxonomy's rows are concepts; what a column can be besides their name.
TAXONOMY_FIELDS = [
    (SKOS.altLabel, "alternative name", "text"),
    (SKOS.definition, "definition", "text"),
    (SKOS.notation, "notation", "plain"),
]


def _value_rule(rng) -> tuple[Optional[URIRef], bool]:
    """(datatype, text) for an attribute's range: a text attribute (no range,
    or rdf:langString) gets the primary language (5.4); xsd:string is text
    without a language; another XSD type is the datatype."""
    if rng is None or rng == RDF.langString:
        return None, True
    if rng == XSD.string or not str(rng).startswith(str(XSD)):
        return None, False
    return rng, False


def fields(model: Graph, cls: URIRef, kind: str, names: Names, languages: list) -> list[dict]:
    """Step 3's choices for a column besides its name and Ignore."""
    if kind == "taxonomy" or cls == SKOS.Concept:
        return [
            {"property": str(p), "label": label, "kind": "attribute",
             "datatype": None if rule == "text" else "xsd:string", "text": rule == "text"}
            for p, label, rule in TAXONOMY_FIELDS
        ]
    out = []
    for entry in paths_for(model, cls, names, languages):
        if entry["kind"] not in ("attribute", "relationship"):
            continue
        prop = URIRef(entry["path"][0])
        rng = model.value(prop, RDFS.range)
        field = {"property": str(prop), "label": entry["label"], "kind": entry["kind"]}
        if entry["kind"] == "attribute":
            datatype, text = _value_rule(rng)
            field["datatype"] = f"xsd:{str(datatype)[len(str(XSD)):]}" if datatype is not None else None
            field["text"] = text
        else:
            field["range"] = entry.get("range")
            field["rangeLabel"] = entry.get("rangeLabel")
        out.append(field)
    return out


def _names_of(model: Graph, iri: URIRef) -> set[str]:
    found = {_simple(local_name(str(iri)))}
    for predicate in (RDFS.label, SKOS.prefLabel, SKOS.altLabel):
        for value in model.objects(iri, predicate):
            if isinstance(value, Literal):
                found.add(_simple(str(value)))
    return found


def suggestions(model: Graph, table: tabular.Table, offered: list[dict], name_column: Optional[str]) -> dict:
    """column -> the choice its header matches, marked suggested (5.4)."""
    out: dict[str, dict] = {}
    if name_column is not None:
        out[name_column] = {"as": "name"}
    for column in table.columns:
        if column in out:
            continue
        simple = _simple(column)
        for field in offered:
            prop = URIRef(field["property"])
            if simple in _names_of(model, prop) | {_simple(field["label"])}:
                out[column] = {"as": field["kind"], "property": field["property"]}
                break
    return out


@dataclass
class Plan:
    graph: Graph                  # the mapping
    class_iri: URIRef
    class_name: str
    row_column: Optional[str]     # the server's row-number column, if any


def plan(
    *,
    model: Graph,
    manifest: dict,
    table: tabular.Table,
    choices: dict,
    names: Names,
    map_iri: str,
    separator: str,
    encoding: str,
) -> Plan:
    """The wizard's choices as an RML mapping, each one checked."""
    if not isinstance(choices, dict):
        raise SnapshotError("The mapping choices are an object.")
    kind = manifest.get("kind") or "ontology"
    base = manifest["baseIri"]
    primary = manifest.get("primaryLanguage", "en")
    raw_class = choices.get("classIri")
    if not isinstance(raw_class, str) or not raw_class:
        raise SnapshotError("Choose what each row is.")
    cls = URIRef(raw_class)
    taxonomy = cls == SKOS.Concept
    if not taxonomy and not is_class(model, cls):
        raise SnapshotError("Each row is one of the model's classes; choose one.")
    id_column = choices.get("idColumn")
    if id_column is not None and id_column not in table.columns:
        raise SnapshotError(f"There is no column {id_column} in this file.")
    row_column = None
    if id_column is None:
        row_column = tabular.unique_name("row", table.columns)
    reference = id_column if id_column is not None else row_column
    subject = rml.escape(f"{base}{DATA_DIR}/{class_slug(cls)}/") + "{" + rml.escape(reference) + "}"
    offered = {f["property"]: f for f in fields(model, cls, kind, names, [primary])}
    poms: list = []
    columns = choices.get("columns") or {}
    if not isinstance(columns, dict):
        raise SnapshotError("The column choices are an object.")
    named = False
    for column, choice in columns.items():
        if column not in table.columns:
            raise SnapshotError(f"There is no column {column} in this file.")
        what = (choice or {}).get("as", "ignore") if isinstance(choice, dict) else "ignore"
        if what == "ignore":
            continue
        if what == "name":
            if named:
                raise SnapshotError("Only one column is the name.")
            named = True
            predicate = SKOS.prefLabel if taxonomy else RDFS.label
            poms.append((predicate, rml.ObjectMap("reference", column, language=primary)))
            continue
        prop = choice.get("property")
        field = offered.get(prop) if isinstance(prop, str) else None
        if field is None or field["kind"] != what:
            raise SnapshotError(
                f"Column {column}: choose an attribute or relationship of the row's class."
            )
        prop_iri = URIRef(prop)
        if what == "attribute":
            if taxonomy:
                text = field["text"]
                datatype = None
            else:
                datatype, text = _value_rule(model.value(prop_iri, RDFS.range))
            poms.append((prop_iri, rml.ObjectMap(
                "reference", column, datatype=datatype, language=primary if text else None)))
        else:
            target = field.get("range")
            if not target:
                raise SnapshotError(
                    f"Column {column}: {field['label']} has no end class, so its ids cannot name rows."
                )
            template = rml.escape(f"{base}{DATA_DIR}/{class_slug(target)}/") + "{" + rml.escape(column) + "}"
            poms.append((prop_iri, rml.ObjectMap("template", template)))
    if taxonomy:
        schemes = sorted(s for s in model.subjects(RDF.type, SKOS.ConceptScheme) if isinstance(s, URIRef))
        if schemes:
            # In the scheme, and at its top: a row says nothing of broader.
            poms.append((SKOS.inScheme, rml.ObjectMap("constant", schemes[0])))
            poms.append((SKOS.topConceptOf, rml.ObjectMap("constant", schemes[0])))
    graph = rml.build(
        map_iri=map_iri, subject_template=subject, classes=[cls], poms=poms,
        separator=separator, encoding=encoding,
    )
    class_name = "concept" if taxonomy else names(cls)
    return Plan(graph, cls, class_name, row_column)


def preview_rows(
    table: tabular.Table, mapping: rml.Mapping, graph: Graph, subjects: dict,
    labels: dict, row_column: Optional[str],
) -> list[dict]:
    """The first rows as what step 4 says of them, in the model's names."""
    rows = []
    by_row = {number: iri for iri, number in subjects.items()}
    index = {name: i for i, name in enumerate(table.columns)}
    for number, row in enumerate(table.rows[:PREVIEW_ROWS], start=1):
        iri = by_row.get(number)
        entry = {"row": number, "subject": iri, "name": None, "values": []}
        if iri is None:
            entry["skipped"] = True
            rows.append(entry)
            continue
        for predicate, om in mapping.poms:
            if om.kind == "constant":
                continue
            column = om.value if om.kind == "reference" else next(
                (p[1] for p in rml.template_parts(om.value) if isinstance(p, tuple)), None)
            if column is None or column == row_column:
                continue
            value = row[index[column]]
            if not value:
                continue  # an empty cell writes nothing, so says nothing
            if predicate in (RDFS.label, SKOS.prefLabel) and om.kind == "reference":
                entry["name"] = value
                continue
            item = {"column": column, "label": labels.get(str(predicate), local_name(str(predicate))),
                    "value": value, "kind": "link" if om.kind == "template" else "value"}
            if om.kind == "template":
                target, _ = rml.expand(rml.template_parts(om.value), row, index)
                item["target"] = target
            elif value and om.datatype is not None:
                name = str(om.datatype)[len(str(XSD)):] if str(om.datatype).startswith(str(XSD)) else None
                item["datatype"] = name
                item["fits"] = name is None or lexical.valid(value, name)
            entry["values"].append(item)
        rows.append(entry)
    return rows


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------


class SnapshotService:
    """Every open project's snapshots, loaded from data.ttl on open."""

    def __init__(self, projects: ProjectStore) -> None:
        self.configure(projects)

    def configure(self, projects: ProjectStore) -> None:
        self.projects = projects
        self._loaded: dict[str, dict[str, Loaded]] = {}
        self._generation: dict[str, int] = {}
        self._locks: dict[str, threading.RLock] = {}
        self._guard = threading.Lock()

    def _lock(self, pid: str) -> threading.RLock:
        with self._guard:
            return self._locks.setdefault(pid, threading.RLock())

    # --- folders --------------------------------------------------------------

    def data_dir(self, pid: str) -> Path:
        return self.projects.folder(pid) / DATA_DIR

    def folder(self, pid: str, sid: str) -> Path:
        """A snapshot folder this project holds, or UnknownSnapshot: the id is
        matched in full before it becomes a path."""
        if not isinstance(sid, str) or not SNAPSHOT_ID.fullmatch(sid):
            raise UnknownSnapshot(sid)
        path = self.data_dir(pid) / sid
        if not (path / META).is_file():
            raise UnknownSnapshot(sid)
        return path

    @staticmethod
    def _read_meta(folder: Path) -> dict:
        return json.loads((folder / META).read_text(encoding="utf-8"))

    @staticmethod
    def _write(path: Path, data: bytes) -> None:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        _replace(tmp, path)

    def _write_meta(self, folder: Path, meta: dict) -> None:
        self._write(folder / META, json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))

    @staticmethod
    def _parse_data(path: Path) -> Graph:
        """data.ttl is written as N-Triples, which is Turtle. It is the app's
        own output, so it is read line by line here, about three times faster
        than rdflib's parser (measured: 40,000 statements in 0.64 s there),
        which is what keeps opening a project inside its budget. Any line
        this reader does not recognise -- a file edited by hand -- sends the
        whole file to rdflib as Turtle instead."""
        try:
            return read_ntriples(path.read_text(encoding="utf-8"))
        except ValueError:
            graph = Graph()
            graph.parse(path, format="turtle")
            return graph

    # --- open, close and what the views join -------------------------------

    def load(self, pid: str) -> None:
        """Read every snapshot of a project being opened."""
        loaded: dict[str, Loaded] = {}
        root = self.data_dir(pid)
        if root.is_dir():
            for folder in sorted(root.iterdir()):
                if not folder.is_dir() or not SNAPSHOT_ID.fullmatch(folder.name):
                    continue
                try:
                    meta = self._read_meta(folder)
                    graph = self._parse_data(folder / DATA)
                except (OSError, ValueError, KeyError):
                    continue  # a damaged snapshot is skipped, not fatal to the project
                loaded[folder.name] = Loaded(meta, graph)
        with self._lock(pid):
            self._loaded[pid] = loaded
            self._generation[pid] = self._generation.get(pid, 0) + 1

    def unload(self, pid: str) -> None:
        with self._lock(pid):
            self._loaded.pop(pid, None)

    def generation(self, pid: str) -> int:
        return self._generation.get(pid, 0)

    def active(self, pid: str) -> tuple[int, list]:
        """(generation, [(graph, info)]) of the switched-on snapshots."""
        with self._lock(pid):
            held = self._loaded.get(pid, {})
            return self.generation(pid), [
                (s.graph, _info(s.meta)) for _, s in sorted(held.items()) if s.meta.get("enabled", True)
            ]

    def origins(self, pid: str) -> dict:
        """Each switched-on individual's IRI -> (snapshot id, its row)."""
        out: dict = {}
        with self._lock(pid):
            for sid, s in sorted(self._loaded.get(pid, {}).items()):
                if s.meta.get("enabled", True):
                    for iri, row in s.meta.get("subjects", {}).items():
                        out.setdefault(iri, (sid, row))
        return out

    def _metas(self, pid: str) -> list[dict]:
        """Every snapshot's meta: from memory while the project is open, else
        from the folders, without parsing any data."""
        held = self._loaded.get(pid)
        if held is not None:
            return [s.meta for _, s in sorted(held.items())]
        metas = []
        root = self.data_dir(pid)
        if root.is_dir():
            for folder in sorted(root.iterdir()):
                if folder.is_dir() and SNAPSHOT_ID.fullmatch(folder.name) and (folder / META).is_file():
                    metas.append(self._read_meta(folder))
        return metas

    def listing(self, pid: str) -> dict:
        self.projects.folder(pid)
        with self._lock(pid):
            return {"generation": self.generation(pid), "snapshots": [summary(m) for m in self._metas(pid)]}

    def _changed(self, pid: str) -> None:
        """Move the generation and write the card's line into the manifest --
        from the folders when the project is closed, so a switch or a remove
        then does not empty the card (found in review)."""
        self._generation[pid] = self.generation(pid) + 1
        card = [{**_info(meta), "enabled": meta.get("enabled", True)} for meta in self._metas(pid)]
        self.projects.update_manifest(pid, data=card)

    # --- reading a file and the snapshot's own copy ----------------------------

    @staticmethod
    def read(data: bytes, options: dict) -> tabular.Table:
        options = options or {}
        return tabular.read_table(
            data,
            separator=options.get("separator"),
            encoding=options.get("encoding"),
            header=bool(options.get("header", True)),
        )

    def stored_table(self, pid: str, sid: str) -> tuple[tabular.Table, dict]:
        """The snapshot's copy as the wizard reads it: the server's row
        column left out, the original total kept."""
        folder = self.folder(pid, sid)
        meta = self._read_meta(folder)
        dialect = meta["dialect"]
        table = tabular.read_table(
            (folder / SOURCE).read_bytes(), separator=dialect["separator"],
            encoding=dialect["encoding"], header=True,
        )
        row_column = meta.get("rowColumn")
        if row_column and table.columns and table.columns[0] == row_column:
            table.columns = table.columns[1:]
            table.rows = [row[1:] for row in table.rows]
        table.total = meta["rows"]["total"]
        return table, meta

    # --- the wizard ----------------------------------------------------------------

    def _map_iri(self, manifest: dict, sid: str) -> str:
        return f"{manifest['baseIri']}mapping/{sid}"

    def preview(self, *, model: Graph, manifest: dict, names: Names, table: tabular.Table, choices: dict) -> dict:
        """Steps 2 to 4 (5.3 to 5.5): the identifier checked, the choices for
        each column with suggestions, and -- once something is mapped -- the
        first rows as sentences with the report the import would give."""
        kind = manifest.get("kind") or "ontology"
        primary = manifest.get("primaryLanguage", "en")
        languages = [primary, *manifest.get("languages", [])]
        cls_raw = (choices or {}).get("classIri")
        result: dict = {
            "idCheck": tabular.id_check(table, (choices or {}).get("idColumn")),
            "fields": [],
            "suggestions": {},
        }
        if not cls_raw:
            return result
        cls = URIRef(cls_raw)
        offered = fields(model, cls, kind, names, languages)
        result["fields"] = offered
        result["suggestions"] = suggestions(model, table, offered, tabular.suggest_name(table))
        result["className"] = "concept" if cls == SKOS.Concept else names(cls)
        made = plan(
            model=model, manifest=manifest, table=table, choices=choices, names=names,
            map_iri=self._map_iri(manifest, "preview-000000"), separator=table.separator,
            encoding=table.encoding,
        )
        mapping = rml.read_graph(made.graph)
        work = _with_row_column(table, made.row_column)
        graph, out = rml.run(mapping, work)
        labels = {f["property"]: f["label"] for f in offered}
        result["rows"] = preview_rows(work, mapping, graph, out["subjects"], labels, made.row_column)
        result["report"] = out["report"]
        return result

    def _run_into(
        self, *, table: tabular.Table, mapping_text: str, base: str,
        separator: str, encoding: str, row_column: Optional[str],
    ) -> tuple[Graph, dict, bytes]:
        """Write the copy, read it back and run the mapping on it: the one path
        every import takes. Nothing in `folder` is replaced until it ran."""
        source = tabular.write_csv(table, encoding, separator, row_column)
        mapping = rml.read(mapping_text, base)
        stored = tabular.read_table(
            source, separator=mapping.separator, encoding=mapping.encoding, header=True,
        )
        graph, out = rml.run(mapping, stored)
        return graph, out, source

    def _commit(self, pid: str, folder: Path, meta: dict, graph: Graph, files: dict) -> dict:
        for name, data in files.items():
            self._write(folder / name, data)
        self._write(folder / DATA, graph.serialize(format="nt", encoding="utf-8"))
        self._write_meta(folder, meta)
        self._loaded.setdefault(pid, {})[meta["id"]] = Loaded(meta, graph)
        self._changed(pid)
        return summary(meta)

    @staticmethod
    def _sample_check(table: tabular.Table, accept: bool) -> None:
        if table.sample and not accept:
            raise SnapshotError(
                tabular.rows_sentence(table.total)
                + f" Choose to use the first {tabular.MAX_ROWS:,} rows, or another file."
            )

    def create(
        self, pid: str, *, model: Graph, manifest: dict, names: Names, data: bytes,
        filename: str, options: dict, choices: dict,
    ) -> dict:
        """Import a file as a new snapshot, switched on (5.5)."""
        table = self.read(data, options)
        self._sample_check(table, bool((options or {}).get("sample")))
        name = display_name(filename)
        stem = name.rsplit(".", 1)[0]
        with self._lock(pid):
            root = self.data_dir(pid)
            root.mkdir(exist_ok=True)
            sid = f"{_slug(stem)}-{uuid.uuid4().hex[:6]}"
            made = plan(
                model=model, manifest=manifest, table=table, choices=choices, names=names,
                map_iri=self._map_iri(manifest, sid), separator=table.separator,
                encoding=table.encoding,
            )
            text = rml.to_turtle(made.graph)
            graph, out, source = self._run_into(
                table=table, mapping_text=text, base=manifest["baseIri"],
                separator=table.separator, encoding=table.encoding, row_column=made.row_column,
            )
            folder = root / sid
            folder.mkdir()
            report = {**out["report"], "total": table.total, "sample": table.sample}
            meta = {
                "id": sid,
                "source": name,
                "importedAt": _now(),
                "rows": {"kept": len(table.rows), "total": table.total},
                "enabled": True,
                "classIri": str(made.class_iri),
                "className": made.class_name,
                "choices": choices,
                "dialect": {"separator": table.separator,
                            "encoding": "utf-8" if table.encoding == "utf-8-sig" else table.encoding},
                "rowColumn": made.row_column,
                "statements": len(graph),
                "report": report,
                "subjects": out["subjects"],
                "mapping": {"status": "ok", "message": None},
            }
            return self._commit(pid, folder, meta, graph, {SOURCE: source, MAPPING: text.encode("utf-8")})

    def refresh(
        self, pid: str, sid: str, *, data: bytes, filename: str, options: dict,
        choices: Optional[dict] = None, model: Optional[Graph] = None,
        manifest: Optional[dict] = None, names: Optional[Names] = None,
    ) -> dict:
        """The same mapping on a new version of the file (5.7). Headers that
        no longer match leave everything as it was and say which columns are
        missing; the wizard then sends `choices` for the new file."""
        table = self.read(data, options)
        self._sample_check(table, bool((options or {}).get("sample")))
        with self._lock(pid):
            folder = self.folder(pid, sid)
            meta = self._read_meta(folder)
            manifest = manifest or self.projects.manifest(pid)
            base = manifest["baseIri"]
            files: dict = {}
            if choices is not None:
                made = plan(
                    model=model, manifest=manifest, table=table, choices=choices, names=names,
                    map_iri=self._map_iri(manifest, sid), separator=table.separator,
                    encoding=table.encoding,
                )
                text = rml.to_turtle(made.graph)
                row_column, separator, encoding = made.row_column, table.separator, table.encoding
                files[MAPPING] = text.encode("utf-8")
                meta.update(choices=choices, classIri=str(made.class_iri), className=made.class_name)
            else:
                text = (folder / MAPPING).read_text(encoding="utf-8")
                try:
                    mapping = rml.read(text, base)
                except rml.UnsupportedMapping as exc:
                    raise SnapshotError(f"{exc} Change the mapping before refreshing.") from exc
                row_column = meta.get("rowColumn")
                needed = [c for c in mapping.references() if c != row_column]
                missing = [c for c in needed if c not in table.columns]
                if missing:
                    return {
                        "status": "mismatch",
                        "missing": missing,
                        "inspection": tabular.inspect(table),
                        "choices": meta.get("choices"),
                    }
                # The copy is written in the dialect the mapping declares, so
                # an edited mapping is never rewritten by a refresh.
                separator, encoding = mapping.separator, mapping.encoding
            try:
                graph, out, source = self._run_into(
                    table=table, mapping_text=text, base=base,
                    separator=separator, encoding=encoding, row_column=row_column,
                )
            except UnicodeEncodeError as exc:
                raise SnapshotError(
                    f"The new file holds characters {encoding} cannot store. "
                    "Change the mapping, which writes the copy in the new file's encoding."
                ) from exc
            files[SOURCE] = source
            meta.update(
                source=display_name(filename),
                importedAt=_now(),
                rows={"kept": len(table.rows), "total": table.total},
                dialect={"separator": separator, "encoding": "utf-8" if encoding == "utf-8-sig" else encoding},
                rowColumn=row_column,
                statements=len(graph),
                report={**out["report"], "total": table.total, "sample": table.sample},
                subjects=out["subjects"],
                mapping={"status": "ok", "message": None},
            )
            return {"status": "imported", "snapshot": self._commit(pid, folder, meta, graph, files)}

    def remap(self, pid: str, sid: str, *, model: Graph, manifest: dict, names: Names, choices: dict) -> dict:
        """Change the mapping (5.7): steps 2 to 4 again, on the copy kept."""
        with self._lock(pid):
            table, meta = self.stored_table(pid, sid)
            folder = self.folder(pid, sid)
            made = plan(
                model=model, manifest=manifest, table=table, choices=choices, names=names,
                map_iri=self._map_iri(manifest, sid), separator=meta["dialect"]["separator"],
                encoding=meta["dialect"]["encoding"],
            )
            text = rml.to_turtle(made.graph)
            graph, out, source = self._run_into(
                table=table, mapping_text=text, base=manifest["baseIri"],
                separator=meta["dialect"]["separator"], encoding=meta["dialect"]["encoding"],
                row_column=made.row_column,
            )
            meta.update(
                choices=choices, classIri=str(made.class_iri), className=made.class_name,
                rowColumn=made.row_column, statements=len(graph),
                report={**out["report"], "total": meta["rows"]["total"],
                        "sample": meta["rows"]["total"] > meta["rows"]["kept"]},
                subjects=out["subjects"], mapping={"status": "ok", "message": None},
            )
            return self._commit(pid, folder, meta, graph, {SOURCE: source, MAPPING: text.encode("utf-8")})

    def mapping_text(self, pid: str, sid: str) -> str:
        return (self.folder(pid, sid) / MAPPING).read_text(encoding="utf-8")

    def edit_mapping(self, pid: str, sid: str, text: str) -> dict:
        """Edit as RML (5.7). A mapping within 5.4 is run at once. One that
        uses a feature outside it is kept as written -- it runs in other RML
        tools -- and the last good data stays, the row saying why. A mapping
        that is not Turtle, reads another file, or does not fit the copy is
        refused and nothing is kept (Section 9)."""
        if not isinstance(text, str) or not text.strip():
            raise SnapshotError("A mapping is Turtle text.")
        with self._lock(pid):
            folder = self.folder(pid, sid)
            meta = self._read_meta(folder)
            base = self.projects.manifest(pid)["baseIri"]
            probe = Graph()
            try:
                probe.parse(data=text, format="turtle", publicID=base)
            except Exception as exc:  # noqa: BLE001 - rdflib raises many kinds
                raise SnapshotError(f"This mapping is not valid Turtle: {str(exc).splitlines()[0]}") from exc
            # The source is checked before anything else, whatever else the
            # mapping holds: a mapping naming another file is never kept.
            for value in probe.objects(None, rml.RML.source):
                urls = [value] if isinstance(value, Literal) else list(probe.objects(value, rml.CSVW.url))
                if not urls:
                    raise SnapshotError("rml:source must name this snapshot's own source.csv.")
                for url in urls:
                    try:
                        rml.check_source(url)
                    except rml.UnsupportedMapping as exc:
                        raise SnapshotError(str(exc)) from exc
            try:
                mapping = rml.read_graph(probe)
            except rml.UnsupportedMapping as exc:
                self._write(folder / MAPPING, text.encode("utf-8"))
                meta["mapping"] = {"status": "outside", "message": str(exc)}
                self._write_meta(folder, meta)
                if sid in self._loaded.get(pid, {}):
                    self._loaded[pid][sid].meta = meta
                self._changed(pid)
                return summary(meta)
            table = tabular.read_table(
                (folder / SOURCE).read_bytes(), separator=mapping.separator,
                encoding=mapping.encoding, header=True,
            )
            table.total = meta["rows"]["total"]
            try:
                graph, out = rml.run(mapping, table)
            except rml.UnsupportedMapping as exc:
                raise SnapshotError(str(exc)) from exc
            meta.update(
                statements=len(graph),
                report={**out["report"], "total": meta["rows"]["total"],
                        "sample": meta["rows"]["total"] > meta["rows"]["kept"]},
                subjects=out["subjects"], mapping={"status": "ok", "message": None},
                dialect={"separator": mapping.separator, "encoding": mapping.encoding},
                # The expert's mapping is the wizard's no longer.
                choices=None,
            )
            return self._commit(pid, folder, meta, graph, {MAPPING: text.encode("utf-8")})

    def set_enabled(self, pid: str, sid: str, enabled: bool) -> dict:
        with self._lock(pid):
            folder = self.folder(pid, sid)
            meta = self._read_meta(folder)
            meta["enabled"] = bool(enabled)
            self._write_meta(folder, meta)
            if sid in self._loaded.get(pid, {}):
                self._loaded[pid][sid].meta = meta
            self._changed(pid)
            return summary(meta)

    def remove(self, pid: str, sid: str) -> dict:
        """Move the folder to the project's .trash/ (5.7)."""
        with self._lock(pid):
            folder = self.folder(pid, sid)
            meta = self._read_meta(folder)
            trash = self.projects.folder(pid) / TRASH_DIR
            trash.mkdir(exist_ok=True)
            target = trash / f"data-{sid}"
            if target.exists():
                target = trash / f"data-{sid}-{uuid.uuid4().hex[:6]}"
            shutil.move(str(folder), str(target))
            if pid in self._loaded:
                self._loaded[pid].pop(sid, None)
            self._changed(pid)
            return {"removed": sid, "statements": meta.get("statements", 0),
                    "location": f"{TRASH_DIR}/{target.name}"}


_IRI = r'<([^<>"{}|^`\\\s]*)>'
_TRIPLE = re.compile(
    _IRI + " " + _IRI + " "
    + r'(?:' + _IRI + r'|"((?:[^"\\]|\\.)*)"(?:@([A-Za-z]+(?:-[A-Za-z0-9]+)*)|\^\^' + _IRI + r')?) \.'
)
_ESCAPE = re.compile(r"""\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[tbnrf"'\\])""")
_SIMPLE = {"t": "\t", "b": "\b", "n": "\n", "r": "\r", "f": "\f", '"': '"', "'": "'", "\\": "\\"}


def _unescape(text: str) -> str:
    if "\\" not in text:
        return text
    return _ESCAPE.sub(lambda m: _SIMPLE.get(m.group(1)) or chr(int(m.group(1)[1:], 16)), text)


def read_ntriples(text: str) -> Graph:
    """N-Triples without blank nodes, as rdflib writes them, or ValueError."""
    graph = Graph()
    iris: dict[str, URIRef] = {}

    def iri(value: str) -> URIRef:
        held = iris.get(value)
        if held is None:
            held = iris[value] = URIRef(value)
        return held

    def triples():
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = _TRIPLE.fullmatch(line)
            if m is None:
                raise ValueError(line[:80])
            s, p, o, lexical, lang, datatype = m.groups()
            if o is not None:
                obj = iri(o)
            else:
                obj = Literal(_unescape(lexical), lang=lang, datatype=iri(datatype) if datatype else None)
            yield iri(s), iri(p), obj, graph

    graph.addN(triples())
    return graph


def _with_row_column(table: tabular.Table, row_column: Optional[str]) -> tabular.Table:
    """The table as the copy will hold it: the row number first, if used."""
    if row_column is None:
        return table
    return tabular.Table(
        [row_column, *table.columns],
        [[str(n), *row] for n, row in enumerate(table.rows, start=1)],
        table.total, table.separator, table.encoding, table.header, table.renamed,
    )

