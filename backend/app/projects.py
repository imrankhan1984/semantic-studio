"""
================================================================================
FILE: backend/app/projects.py
================================================================================

SUMMARY
    The user's own work: one folder per project under <data dir>/projects,
    each with a project.json manifest (D-080). Create from a template or from a
    library ontology, list at startup, rename, duplicate, move to a recoverable
    trash, and export as a zip. Also the per-project saved-query store.

BASIC IDEA
    A project is a folder, and the manifest is the only thing listing reads, so
    the home screen shows a hundred projects without opening a Turtle file:
    the counts it shows (classes, properties, concepts) are written into the
    manifest by whoever last wrote the model -- creation here, and every save
    in editing.py.

    No path from the client is ever used. A project id is "prj-" and twelve hex
    digits, minted here and checked with fullmatch before it becomes a folder
    name; a document id is `model`, `shapes` or `f` and eight hex digits,
    checked the same way and looked up in the manifest, whose path alone is
    joined to the folder (D-131). Anything else is an UnknownProject or
    UnknownDocument, which the router answers 404 -- the same refusal whether
    the id is malformed, traverses (`../`, a backslash, an absolute path) or
    simply does not exist, so nothing is learnt from probing.

    A project is a folder of Turtle files (multi-file-projects, D-131): up to
    100, in folders up to three levels deep, each with an id and a role
    (ontology, vocabulary, shapes; model.ttl's "model" is the project's
    kind). The folder is the index: `index` walks it at open, finds a file
    the manifest does not know and drops an entry whose file is gone, and
    writes the manifest only when it did either, so a project made before
    E-16 opens with project.json byte for byte as it was. A name typed or a
    path found is held to 8.3 segment by segment (`segment_error`,
    `folder_parts`), then resolved inside the folder by `inside`, which also
    refuses a link or a junction on the way. New file, Move, Remove and the
    folders are here; a removed file goes to the project's own .trash/.

    Templates are Turtle with {{base}}, {{prefix}}, {{ontology}}, {{name}} and
    {{lang}} placeholders, substituted before parsing. The name is the one
    free-text value and is escaped as a Turtle string; base and prefix are
    validated first, so neither can close the IRI or the prefix declaration
    they sit in. Every template is written in the project's primary language.
    A template may ship starter shapes beside it, <template>.shapes.ttl,
    rendered the same way and written as the project's shapes.ttl: the Small
    one does, with two examples in its model, so a learner's first Validate
    already shows red and green (shacl-authoring 5.8, row S23).

    A template project may reuse reference ontologies (reference-ontologies
    5.4): each one chosen is added as Add a vocabulary adds one, through
    vocabularies.add_lines and its rule (D-128, superseding D-121's
    *never an owl:imports*), so FOAF and QUDT, which hold rules, are
    imported, their prefixes declared. The
    description is the header's rdfs:comment in the primary language,
    added the same way, as an rdflib Literal and never assembled as text.
    A template with nothing added is written as rendered, byte for byte;
    one with additions is written as longturtle, its declared reference
    prefixes and its own prefix kept though nothing uses them yet (the own
    one or its first Turtle line fails as unbound). A library copy keeps its own
    file: it takes no references, and a description only where its header
    has none in the primary language, appended as one statement rdflib
    writes, so the copied text, comments and all, stays as it was.

    Delete never destroys: the folder moves into projects/.trash/, and the
    trash is emptied by hand (open question 3, closed as recommended).

    A project may hold data snapshots in data/<sid>/ (csv-data-import 5.6),
    which snapshots.py keeps; the manifest's `data` list, written there, is
    the card's line, so listing still opens nothing else. Export and
    duplicate carry data/ and leave the project's own .trash/ behind.

    A project is an ontology or a taxonomy (D-089), recorded as `kind` in the
    manifest. A template says which; a library copy, and a project made
    before kinds existed, is judged from its content -- concepts and no
    classes make a taxonomy, anything else an ontology -- the latter the
    first time it is opened. The kind changes the tools the interface
    offers, never the model: changing it rewrites nothing but the manifest.

    The manifest's `classType` (attribute-reuse 5.6, D-117) is the kind of
    class, OWL or RDFS, the project's last new class was made as: the next
    form's default, "owl" while it is absent. editing.py writes it, only
    when a CreateClass chooses the other kind; like `kind`, it is never the
    model and moves no revision.

    Each document may have a layout file beside it, <doc>.layout.json, holding
    where the modeling canvas draws each box (visual-modeling 5.5, D-087). It
    is not the model: writing it touches neither the revision nor the dirty
    flag nor the undo history. It arrives from the browser, so it is refused
    past a size, an entry count and a key length, and every number must be
    finite; its name is fixed, never taken from the client. Export and
    duplicate copy it with the rest of the folder.

    Every write of the file -- the browser's PUT, a rename moving an entry,
    the prune on open -- increases its `generation`, which the server alone
    sets. The browser compares it with its own last successful save, so a
    response that read the file before that save cannot put an older
    position back, whatever order the responses arrive in (PR #47
    re-review).

INPUTS / INPUT SOURCES
    - The data directory from the ontology store (SEMANTIC_STUDIO_DATA_DIR).
    - Templates in app/templates/.
    - A library ontology's graph, for "Start a project from this".

EXPECTED OUTPUT
    - Project folders and manifests on disk, and manifest dicts for the API;
      a template's starter shapes.ttl where it has one.
    - <doc>.layout.json, read, validated and written atomically.
    - Files and folders made, moved and trashed; the folder index's answer
      (entries, folders, found, missing, skipped).
    - Raises ProjectError (400, a sentence), PathRefused (422, a sentence and
      its field), UnknownProject and UnknownDocument (404).
================================================================================
"""

from __future__ import annotations

import copy
import io
import json
import math
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS, SKOS

from . import naming, references, settings, vocabularies
from .queries_store import SavedQueryStore

# What create() mints. fullmatch, never match: `$` also matches before a
# trailing newline, the hole CF-5 closed for query ids.
PROJECT_ID = re.compile(r"prj-[0-9a-f]{12}")

# The two ids a project had before E-16, and their files at the root
# (D-131): an entry without an `id` is read as one of these by its file.
# Every other file's id is minted (`f` and eight hex digits) and kept in
# the manifest. The id is what the API and the ontology id carry
# (prj-<hex>-<id>); it is looked up in the manifest and never becomes a
# path, and a path never becomes an id.
DOCUMENTS = {"model": "model.ttl", "shapes": "shapes.ttl"}
DOCUMENT_ROLES = {"model": "model", "shapes": "shapes"}
DOC_ID = re.compile(r"model|shapes|f[0-9a-f]{8}")

# A file's role decides which tools show first, never what can be changed
# (D-127 per file). model.ttl's entry keeps role "model", read as the
# project's kind, so Change kind works on it unchanged.
ROLES = ("ontology", "vocabulary", "shapes")
MODEL_ROLES = ("ontology", "vocabulary")

# Section 8.5: fixed constants, not settings.
MAX_FILES = 100
MAX_LEVELS = 3

# 8.3: one segment, compared without case where folders ignore it.
SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}")
# What the app keeps in a project folder for itself (5.1 item 1), compared
# without case. `*.original.ttl` is the one-time backup Save writes beside
# a file (D-083): found as a file of its own, it would put every term in
# the project twice.
RESERVED = {"project.json", "queries", "data", ".draft", ".trash"}
RESERVED_SUFFIXES = (".layout.json", ".original.ttl")
# Windows keeps these for devices, with any extension after them.
DEVICES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}

# Each template and the kind of project it starts. "vocabulary" is the E-6
# name for a small SKOS scheme, kept so a request naming it still works.
TEMPLATE_KINDS = {
    "empty": "ontology",
    "small": "ontology",
    "taxonomy-empty": "taxonomy",
    "taxonomy-small": "taxonomy",
    "vocabulary": "taxonomy",
}
TEMPLATES = set(TEMPLATE_KINDS)
KINDS = ("ontology", "taxonomy")
TEMPLATE_DIR = Path(__file__).parent / "templates"

MANIFEST = "project.json"
DRAFT_DIR = ".draft"
TRASH_DIR = ".trash"

# A base IRI is absolute and ends where a local name can be appended. The
# character class keeps it from closing the <...> it is written into.
BASE_IRI = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:[^\s<>\"{}|\\^`]*[#/]")
# Turtle's PN_PREFIX, restricted to ASCII: a letter, then letters, digits,
# hyphens, underscores and inner dots.
PREFIX = re.compile(r"[A-Za-z]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?")
# A well-formed BCP 47 tag: language, optional script, region and variants.
# Deliberately a shape check rather than a registry lookup, which would need
# the IANA registry as a dependency.
LANG_TAG = re.compile(
    r"[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*"
)

NAME_MAX = 120
# The description's limit (reference-ontologies 5.4 item 3), checked by the
# request model and again here for any other caller.
DESCRIPTION_MAX = 2000


# The layout file (visual-modeling Section 9). The byte cap is enforced twice,
# as the upload's is: declared, in main.py's middleware, and while reading.
LAYOUT_MAX_BYTES = 1024 * 1024
LAYOUT_MAX_ENTRIES = 20_000
LAYOUT_KEY_MAX = 2048
LAYOUT_VERSION = 1


def _replace(tmp: Path, path: Path, attempts: int = 5) -> None:
    """os.replace, retried briefly on Windows's transient "access denied".

    Measured in test_layout_budget: replacing the same file many times a
    second fails now and then while another process (a virus scanner, the
    indexer) holds it for a moment. The canvas writes its layout a second
    after every move, so a user would meet it; a few tries 20 ms apart do not.
    """
    for attempt in range(attempts):
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.02)


def empty_layout() -> dict:
    return {"version": LAYOUT_VERSION, "generation": 0, "positions": {}, "shown": None, "viewport": None, "placed": []}


def _finite(value) -> bool:
    # bool is an int to Python; true is not a coordinate.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _key(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= LAYOUT_KEY_MAX


def validate_layout(data) -> dict:
    """A layout from the browser, checked and normalised, or ProjectError.

    {version: 1, positions: {iri: [x, y]}, shown: [iri, ...] | null,
    viewport: {x, y, zoom} | null, placed: [iri, ...]}. `placed` is the
    outside terms put on the canvas with no line yet (vocabularies-and-
    ontologies 5.8): a layout entry, never the model, counted under the
    same entry cap. Nothing else is kept. A `generation`
    is kept when it is a whole number, which is how the file's own counter
    is read back; one sent by the browser is replaced by write_layout.
    """
    if not isinstance(data, dict):
        raise ProjectError("A layout is an object with positions, shown and viewport.")
    positions = data.get("positions", {})
    if not isinstance(positions, dict):
        raise ProjectError("A layout's positions are an object of IRI to [x, y].")
    shown = data.get("shown")
    placed = data.get("placed") or []
    count = (
        len(positions) + (len(shown) if isinstance(shown, list) else 0)
        + (len(placed) if isinstance(placed, list) else 0)
    )
    if count > LAYOUT_MAX_ENTRIES:
        raise ProjectError(f"A layout holds at most {LAYOUT_MAX_ENTRIES:,} entries.")
    clean: dict = {}
    for iri, point in positions.items():
        if not _key(iri):
            raise ProjectError(f"A layout key is an IRI of at most {LAYOUT_KEY_MAX:,} characters.")
        if not (isinstance(point, list) and len(point) == 2 and all(_finite(v) for v in point)):
            raise ProjectError("A position is [x, y], two finite numbers.")
        clean[iri] = [float(point[0]), float(point[1])]
    if shown is not None:
        if not (isinstance(shown, list) and all(_key(i) for i in shown)):
            raise ProjectError("A layout's shown set is a list of IRIs, or null.")
        shown = list(dict.fromkeys(shown))
    if not (isinstance(placed, list) and all(_key(i) for i in placed)):
        raise ProjectError("A layout's placed terms are a list of IRIs.")
    placed = list(dict.fromkeys(placed))
    viewport = data.get("viewport")
    if viewport is not None:
        if not (isinstance(viewport, dict) and all(_finite(viewport.get(k)) for k in ("x", "y", "zoom"))):
            raise ProjectError("A layout's viewport is {x, y, zoom}, three finite numbers, or null.")
        viewport = {k: float(viewport[k]) for k in ("x", "y", "zoom")}
    generation = data.get("generation", 0)
    if not (isinstance(generation, int) and not isinstance(generation, bool) and generation >= 0):
        generation = 0
    return {
        "version": LAYOUT_VERSION,
        "generation": generation,
        "positions": clean,
        "shown": shown,
        "viewport": viewport,
        "placed": placed,
    }


class ProjectError(ValueError):
    """A request that cannot be carried out, with the sentence saying why."""


class UnknownProject(LookupError):
    """An id this store did not issue, or one that is no longer here."""


class UnknownDocument(LookupError):
    """A document id the manifest does not hold, or one not created yet."""


class PathRefused(ProjectError):
    """A file or folder name, or a folder, outside 8.3's rules, or a limit
    of 8.5 reached: one sentence, and the field it concerns ("name",
    "folder", or None for the project as a whole) so the dialog shows it
    there (5.5 item 8)."""

    def __init__(self, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.field = field


def segment_error(name: str) -> Optional[str]:
    """Why one file or folder name breaks 8.3, or None. The same rule for a
    name typed in the browser and a name found on disk; files/names.ts holds
    the browser's copy, tested on the same table (files/names.table.json)."""
    if not isinstance(name, str) or not SEGMENT.fullmatch(name):
        return (
            "A name starts with a letter or a digit and uses only letters, digits, "
            "spaces, dots, hyphens and underscores, up to 64 characters."
        )
    if name.endswith((".", " ")):
        return "A name cannot end in a dot or a space."
    folded = name.casefold()
    if folded in RESERVED or folded.endswith(RESERVED_SUFFIXES):
        return f"{name} is a name Semantic Studio keeps for itself."
    if folded.split(".")[0] in DEVICES:
        return f"{name} is a name Windows keeps for a device."
    return None


def folder_parts(folder: str) -> list[str]:
    """A folder as its segments ("" is the project folder itself), or
    PathRefused. A backslash, a drive letter, an absolute path or `..` never
    passes: each is outside the segment rule."""
    if folder is None or folder == "":
        return []
    if not isinstance(folder, str) or "\\" in folder or folder.startswith("/") or folder.endswith("/"):
        raise PathRefused("A folder is written with / between its names, inside the project.", "folder")
    parts = folder.split("/")
    for part in parts:
        reason = segment_error(part)
        if reason is not None:
            raise PathRefused(reason, "folder")
    if len(parts) > MAX_LEVELS:
        raise PathRefused(f"A project's folders go at most {MAX_LEVELS} levels deep.", "folder")
    return parts


def file_name(name: str) -> str:
    """A file name as 5.5 item 5 takes it: trimmed, `.ttl` added when left
    off, then held to 8.3."""
    name = (name or "").strip() if isinstance(name, str) else ""
    if not name:
        raise PathRefused("A file needs a name.", "name")
    if not name.lower().endswith(".ttl"):
        name += ".ttl"
    reason = segment_error(name)
    if reason is not None:
        raise PathRefused(reason, "name")
    return name


def entries(manifest: dict) -> list[dict]:
    """The manifest's documents, each {id, file, role}: an entry made before
    E-16 has no id and is read as `model` or `shapes` by its file (5.1 item
    4). A copy, so a caller changing it changes nothing until it writes."""
    out = []
    for entry in manifest.get("documents", []):
        doc = entry.get("id")
        if doc is None:
            doc = "shapes" if entry.get("role") == "shapes" and entry.get("file") == "shapes.ttl" else "model"
        out.append({"id": doc, "file": entry["file"], "role": entry["role"]})
    return out


def entry_role(entry: dict, kind: Optional[str]) -> str:
    """ontology, vocabulary or shapes: model.ttl's "model" is the project's
    kind, a taxonomy's model a vocabulary file (5.1 item 3)."""
    if entry["role"] == "model":
        return "vocabulary" if kind == "taxonomy" else "ontology"
    return entry["role"]


def is_model_role(role: str) -> bool:
    """A file of terms (ontology or vocabulary), as opposed to shapes."""
    return role == "model" or role in MODEL_ROLES


def file_folder(file: str) -> str:
    return file.rsplit("/", 1)[0] if "/" in file else ""


def file_basename(file: str) -> str:
    return file.rsplit("/", 1)[-1]


def file_header_iri(base_iri: str, file: str) -> str:
    """A new ontology or vocabulary file's own header (5.1 item 6): the
    base IRI plus the file's path without .ttl, so two files never share
    one. A space is written %20, as an IRI cannot hold one."""
    from urllib.parse import quote

    return base_iri + quote(file[: -len(".ttl")], safe="/")


def _is_junction(path: Path) -> bool:
    """A Windows junction, which is_symlink() does not see: it leads out of
    the folder as a link does (5.2 item 4). Python 3.12 and later."""
    check = getattr(os.path, "isjunction", None)
    return bool(check and check(path))


def valid_lang(tag: str) -> bool:
    return isinstance(tag, str) and LANG_TAG.fullmatch(tag) is not None


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "project"


def default_base_iri(name: str, kind: str = "ontology") -> str:
    """Open question 2, closed as recommended: http://example.org/<slug>#.
    With a namespace in Settings → Naming (design-checks 5.2), the pattern's
    core address for the name and the kind: a request that sends no address
    group still gets an address under the namespace rather than
    example.org."""
    lines = pattern_addresses(name, kind, None)
    return lines["model"] if lines else f"http://example.org/{slugify(name)}#"


def pattern_addresses(name: str, kind: str, address: Optional[dict]) -> Optional[dict]:
    """The three addresses of 5.2 and the parts that made them, or None
    when no namespace is set. `address` is New project's group (layer,
    area, subject, type, dataDomain); without one, the core layer, the
    name's slug as the subject, the kind's first type and the slug as the
    data domain. Each part is held to naming.py's rule (NamingError).

    The namespace is read here, at each creation: a setting saved later
    never reaches a project already made (5.1: nothing written changes)."""
    namespace = settings.namespace()
    if namespace is None:
        return None
    subject = slugify(name)
    group = address or {}
    parts = {
        "namespace": namespace,
        "layer": group.get("layer", "core"),
        "area": group.get("area", "") or "",
        "subject": group.get("subject", subject),
        "type": group.get("type", naming.PROJECT_TYPES.get(kind, ("ontology",))[0]),
        "dataDomain": group.get("dataDomain", subject),
    }
    lines = naming.project_addresses(
        namespace, parts["layer"], parts["area"], parts["subject"], parts["type"],
        parts["dataDomain"], kind=kind,
    )
    return {**lines, "parts": parts}


def shapes_prefix(prefix: str) -> str:
    """The shapes document's prefix under the pattern (5.3): invsh for inv."""
    return f"{prefix}sh"


def default_prefix(name: str) -> str:
    # The slug without hyphens, starting with a letter, so it is a valid prefix.
    letters = re.sub(r"[^a-z0-9]", "", slugify(name))
    if not letters or not letters[0].isalpha():
        letters = "p" + letters
    return letters[:20]


def _turtle_string(text: str) -> str:
    """Escape free text for the inside of a "..." Turtle string."""
    return (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", " ")
        .replace("\r", " ")
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def graph_counts(graph: Graph) -> dict:
    """What a project card shows, counted once whenever the model is written.

    Typed entities only, by rdf:type: a manifest count is a statement about
    what the file declares, and must be cheap enough to take on every save.
    """
    def named(*types) -> int:
        found = set()
        for t in types:
            found.update(s for s in graph.subjects(RDF.type, t) if isinstance(s, URIRef))
        return len(found)

    return {
        "classes": named(OWL.Class, RDFS.Class),
        "properties": named(
            OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty, RDF.Property
        ),
        "concepts": named(SKOS.Concept),
        "triples": len(graph),
    }


def infer_kind(graph: Graph) -> str:
    """Concepts and no classes make a taxonomy; anything else, an ontology
    (D-089). A model with both is an ontology whose values are concepts,
    the commoner case, and its concepts stay visible either way."""
    counts = graph_counts(graph)
    return "taxonomy" if counts["concepts"] and not counts["classes"] else "ontology"


def header_of(graph: Graph) -> Optional[URIRef]:
    """The owl:Ontology a description is written on: the first by IRI.
    The one rule, for create here and Description… in editing.py."""
    found = sorted(s for s in graph.subjects(RDF.type, OWL.Ontology) if isinstance(s, URIRef))
    return found[0] if found else None


def _with_references(graph: Graph, header: URIRef, chosen: list[dict]) -> dict:
    """Each reference added as Add a vocabulary adds it (D-128): through
    vocabularies.add_lines, by the same rule, so FOAF and QUDT, which hold
    rules, are imported. Returns the prefixes the lines declare, which
    keep_prefixes writes, as nothing uses them yet."""
    declared: dict = {}
    for entry in chosen:
        source = vocabularies.bundled_of(entry)
        prefix, namespace = next(iter(entry["reuse"]["prefixes"].items()))
        lines, declares = vocabularies.add_lines(header, entry["reuse"]["ontology"], prefix, namespace, source.how)
        for line in lines:
            graph.add(line)
        declared.update(declares)
    return declared


def _statement(subject: URIRef, predicate: URIRef, value: Literal) -> str:
    """One statement as rdflib writes it, for appending to a copied file:
    N-Triples is Turtle, and needs no prefix the file may not declare."""
    one = Graph()
    one.add((subject, predicate, value))
    return one.serialize(format="nt")


def template_shapes(template: str) -> Optional[Path]:
    """The starter shapes a template ships, or None: the Small template has
    them, so a first Validate already shows a mix of results (S23)."""
    path = TEMPLATE_DIR / f"{template}.shapes.ttl"
    return path if template in TEMPLATES and path.is_file() else None


# A template's example individual: {{data:<class>/<id>}} (design-checks 5.3).
_DATA_PLACEHOLDER = re.compile(r"\{\{data:([a-z0-9-]+)/([a-z0-9-]+)\}\}")


def render_template(
    template: str, *, name: str, base_iri: str, prefix: str, lang: str, part: str = "",
    shapes_base: Optional[str] = None, data_base: Optional[str] = None,
) -> str:
    """A template's model, or with part=".shapes" its starter shapes.

    `shapes_base` and `data_base` are a pattern project's own bases (5.3):
    the starter shapes are named under the first, with their own prefix
    declared, and the examples at <data base><class>/<id>. Without them the
    text is today's, byte for byte: a shape at {{prefix}}:Name and an
    example at {{prefix}}:<id>."""
    if template not in TEMPLATES:
        raise ProjectError(f"There is no template called {template!r}.")
    text = (TEMPLATE_DIR / f"{template}{part}.ttl").read_text(encoding="utf-8")
    if shapes_base is not None:
        shape_prefix = shapes_prefix(prefix)
        text = text.replace("{{shapesDecl}}", f"\n@prefix {shape_prefix}: <{shapes_base}> .")
        text = text.replace("{{shape}}", shape_prefix)
    else:
        text = text.replace("{{shapesDecl}}", "").replace("{{shape}}", "{{prefix}}")
    if data_base is not None:
        text = _DATA_PLACEHOLDER.sub(lambda m: f"<{data_base}{m.group(1)}/{m.group(2)}>", text)
    else:
        text = _DATA_PLACEHOLDER.sub(lambda m: f"{{{{prefix}}}}:{m.group(2)}", text)
    # The ontology's own IRI is the base without its separator, the usual
    # shape: http://example.org/invoices# names <http://example.org/invoices>.
    replacements = {
        "{{base}}": base_iri,
        "{{ontology}}": base_iri.rstrip("#/"),
        "{{prefix}}": prefix,
        "{{name}}": _turtle_string(name),
        "{{lang}}": lang,
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def _mint_id(listed: list[dict], file: Optional[str] = None) -> str:
    """`f` and eight hex digits, minted once and kept in the manifest (5.1
    item 2), never one the project already has."""
    taken = {e["id"] for e in listed}
    while True:
        doc = "f" + uuid.uuid4().hex[:8]
        if doc not in taken:
            return doc


def _prefix_lines(manifest: dict) -> str:
    return f"@prefix {manifest['prefix']}: <{manifest['baseIri']}> .\n"


def _shapes_text(manifest: dict) -> str:
    """An empty shapes file: the model's prefix, a pattern project's own
    shapes prefix beside it (design-checks 5.3), and sh:."""
    own = (
        f"@prefix {shapes_prefix(manifest['prefix'])}: <{manifest['shapesBaseIri']}> .\n"
        if manifest.get("shapesBaseIri") else ""
    )
    return _prefix_lines(manifest) + own + "@prefix sh: <http://www.w3.org/ns/shacl#> .\n"


def _model_text(manifest: dict, file: str, role: str) -> str:
    """An empty ontology or vocabulary file with the project's prefixes and
    its own header, labelled from the file name in the primary language
    (5.1 item 6). model.ttl's header is the project's, as a template writes
    it; every other file's is the base plus its path."""
    base = manifest["baseIri"]
    header = base.rstrip("#/") if role == "model" else file_header_iri(base, file)
    label = manifest["name"] if role == "model" else file_basename(file)[: -len(".ttl")]
    lang = manifest.get("primaryLanguage", "en")
    skos = "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n" if role == "vocabulary" else ""
    return (
        _prefix_lines(manifest)
        + "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n"
        + "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n"
        + skos
        + f"\n<{header}> a owl:Ontology ;\n    rdfs:label \"{_turtle_string(label)}\"@{lang} .\n"
    )


class ProjectStore:
    """Every project on disk, and the manifests that describe them."""

    def __init__(self, data_dir: Path) -> None:
        self.configure(data_dir)

    def configure(self, data_dir: Path) -> None:
        """Point at a data directory. Tests call it with their own."""
        self.dir = Path(data_dir) / "projects"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.trash = self.dir / TRASH_DIR
        self._lock = threading.Lock()
        # Each layout as last read or written, by file. Opening a file just
        # replaced costs about 130 ms on Windows while a scanner looks at it
        # (measured when every write began reading the old generation), so
        # a layout is read from disk once and served from here after that.
        self._layouts: dict[Path, dict] = {}

    # --- identity ------------------------------------------------------------

    def folder(self, pid: str) -> Path:
        """The folder of a project this store issued, or UnknownProject.

        The id is matched in full before it touches the filesystem, so `..`, a
        backslash, a drive letter or an absolute path never becomes a path.
        """
        if not isinstance(pid, str) or not PROJECT_ID.fullmatch(pid):
            raise UnknownProject(pid)
        path = self.dir / pid
        if not (path / MANIFEST).is_file():
            raise UnknownProject(pid)
        return path

    @staticmethod
    def check_id(doc: str) -> str:
        """An id of the shape this store issues, or UnknownDocument: matched
        in full before anything else is asked, so a path-like id is refused
        the same way as one never issued."""
        if not isinstance(doc, str) or not DOC_ID.fullmatch(doc):
            raise UnknownDocument(doc)
        return doc

    def entry(self, pid: str, doc: str, manifest: Optional[dict] = None) -> dict:
        """The manifest's entry for an id, or UnknownDocument."""
        self.check_id(doc)
        for found in entries(manifest if manifest is not None else self.manifest(pid)):
            if found["id"] == doc:
                return found
        raise UnknownDocument(doc)

    def document_file(self, pid: str, doc: str, manifest: Optional[dict] = None) -> str:
        """The file an id names, from the manifest alone (5.1 item 2)."""
        return self.entry(pid, doc, manifest)["file"]

    def inside(self, pid: str, relative: str) -> Path:
        """The project folder joined with a path already held to 8.3, and
        resolved: anything resolving outside the folder (a link on the way)
        is PathRefused. The last line between a name and the filesystem."""
        folder = self.folder(pid)
        path = folder.joinpath(*relative.split("/")) if relative else folder
        root = folder.resolve()
        resolved = path.resolve()
        if resolved != root and root not in resolved.parents:
            raise PathRefused("That path leads outside the project folder.", "folder")
        for parent in [path, *path.parents]:
            if parent == folder:
                break
            if parent.is_symlink() or _is_junction(parent):
                raise PathRefused("That path leads outside the project folder.", "folder")
        return path

    def document_path(self, pid: str, doc: str, manifest: Optional[dict] = None) -> Path:
        try:
            path = self.inside(pid, self.document_file(pid, doc, manifest))
        except PathRefused as exc:
            raise UnknownDocument(doc) from exc
        if not path.is_file():
            raise UnknownDocument(doc)
        return path

    # --- layouts (visual-modeling 5.5) ------------------------------------------

    def layout_path(self, pid: str, doc: str) -> Path:
        """<id>.layout.json in the project folder, named by id (never by the
        file's path), so a rename or a move keeps it (5.5 item 6). The id is
        matched in full; the caller has found it in the manifest or among
        the open documents."""
        self.check_id(doc)
        return self.folder(pid) / f"{doc}.layout.json"

    def read_layout(self, pid: str, doc: str) -> dict:
        """The saved layout, or an empty one. A file that is not a valid
        layout (edited by hand, cut short) is treated as none rather than
        refusing to draw the canvas."""
        path = self.layout_path(pid, doc)
        held = self._layouts.get(path)
        if held is None:
            try:
                held = validate_layout(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                held = empty_layout()
            self._layouts[path] = held
        # A copy: callers change what they are given before writing it back.
        return copy.deepcopy(held)

    def write_layout(self, pid: str, doc: str, layout: dict) -> dict:
        """Validate and write, one generation after the file's own. The
        caller holds the document's lock, so reading the old generation and
        writing the new one cannot interleave with another write."""
        layout = validate_layout(layout)
        layout["generation"] = self.read_layout(pid, doc)["generation"] + 1
        path = self.layout_path(pid, doc)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(layout, ensure_ascii=False), encoding="utf-8")
        _replace(tmp, path)
        self._layouts[path] = copy.deepcopy(layout)
        return layout

    # --- manifests -------------------------------------------------------------

    def manifest(self, pid: str) -> dict:
        return json.loads((self.folder(pid) / MANIFEST).read_text(encoding="utf-8"))

    def write_manifest(self, pid: str, manifest: dict) -> None:
        path = self.folder(pid) / MANIFEST
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def update_manifest(self, pid: str, **fields) -> dict:
        with self._lock:
            manifest = self.manifest(pid)
            manifest.update(fields)
            self.write_manifest(pid, manifest)
        return manifest

    def edit_manifest(self, pid: str, change: Callable[[dict], None]) -> dict:
        """Read, change and write the manifest under the store's lock, for a
        change that depends on what is there (the read-aloud ticks, design-
        checks 5.8): two at once never lose one. `change` edits in place and
        may raise to write nothing."""
        with self._lock:
            manifest = self.manifest(pid)
            change(manifest)
            self.write_manifest(pid, manifest)
        return manifest

    @staticmethod
    def summary(manifest: dict) -> dict:
        return {
            "id": manifest["id"],
            "name": manifest["name"],
            "createdAt": manifest["createdAt"],
            "updatedAt": manifest["updatedAt"],
            "baseIri": manifest["baseIri"],
            "prefix": manifest["prefix"],
            "primaryLanguage": manifest.get("primaryLanguage", "en"),
            "languages": manifest.get("languages", []),
            # None only for a project made before kinds, until it is opened.
            "kind": manifest.get("kind"),
            # Each entry with its id, a pre-E-16 entry's read from its file.
            "documents": entries(manifest),
            "counts": manifest.get("counts", {}),
            # The data snapshots, for the card's line (csv-data-import 5.7);
            # written by snapshots.py whenever one changes.
            "data": manifest.get("data", []),
            # The kind of class the last one was made as (attribute-reuse
            # 5.6, D-117), the next form's default; None until one differs
            # from owl, as no project had it before.
            "classType": manifest.get("classType"),
            # The reference ontologies chosen at creation (reference-
            # ontologies 5.4): a record, never what puts one in use.
            "references": manifest.get("references", []),
            # The address pattern (design-checks 5.2): absent for a project
            # made before it or with its own base IRI.
            "naming": manifest.get("naming"),
            "shapesBaseIri": manifest.get("shapesBaseIri"),
            "dataBaseIri": manifest.get("dataBaseIri"),
        }

    def list(self) -> list[dict]:
        """Every project, most recently changed first, from manifests alone.

        Reads project.json and nothing else: no Turtle file is opened, which is
        what keeps a hundred projects inside the startup budget (Section 10).
        """
        found = []
        for path in self.dir.iterdir():
            if not path.is_dir() or not PROJECT_ID.fullmatch(path.name):
                continue
            try:
                manifest = json.loads((path / MANIFEST).read_text(encoding="utf-8"))
                found.append(self.summary(manifest))
            except (OSError, ValueError, KeyError):
                continue  # a damaged folder is skipped, not fatal to the list
        found.sort(key=lambda m: m["updatedAt"], reverse=True)
        return found

    # --- create ----------------------------------------------------------------

    def create(
        self,
        *,
        name: str,
        base_iri: Optional[str] = None,
        prefix: Optional[str] = None,
        primary_language: str = "en",
        template: Optional[str] = None,
        source_graph: Optional[Graph] = None,
        source_text: Optional[str] = None,
        source_name: Optional[str] = None,
        reference_keys: Optional[list[str]] = None,
        description: Optional[str] = None,
        address: Optional[dict] = None,
    ) -> dict:
        """A new project with model.ttl written, from a template or a library copy.

        `source_text` is a library file that was Turtle already, copied
        verbatim so its comments and layout survive; `source_graph` is any
        other format, written as clean Turtle. `reference_keys` are the
        reference ontologies a template reuses; `description` the header's
        rdfs:comment, none when empty.

        `address` is New project's Address group (design-checks 5.2):
        {layer, area, subject, type, dataDomain}, each part held to
        naming.py's rule. With a namespace set, the project is made under
        the pattern -- with the group, or with the defaults when none is
        sent and no base IRI either -- and its manifest records `naming`,
        `shapesBaseIri` and `dataBaseIri`. A base IRI written by hand
        keeps the pattern only while it still ends in -<type>#, the shapes
        base then following it; any other hand-written base is a project
        as before, with none of the three.
        """
        name = (name or "").strip()
        if not name:
            raise ProjectError("A project needs a name.")
        if len(name) > NAME_MAX:
            raise ProjectError(f"A project name can be at most {NAME_MAX} characters.")
        if address is not None and settings.namespace() is None:
            raise ProjectError("Set your organization's namespace in Settings → Naming to use the address pattern.")
        pattern_kind = TEMPLATE_KINDS.get(template or "empty", "ontology")
        if address is not None and (source_text is not None or source_graph is not None):
            # A copy's kind is judged from its content below; its type is
            # held to the three a project can be, whichever it turns out.
            pattern_kind = "taxonomy" if address.get("type") in ("taxonomy", "vocabulary") else "ontology"
        try:
            lines = (
                pattern_addresses(name, pattern_kind, address)
                if address is not None or not base_iri
                else None
            )
        except naming.NamingError as exc:
            raise ProjectError(str(exc)) from exc
        if lines is not None and base_iri and base_iri.strip() != lines["model"]:
            suffix = f"-{lines['parts']['type']}#"
            written = base_iri.strip()
            if written.endswith(suffix):
                lines = {**lines, "model": written, "shapes": written[: -len(suffix)] + "-shapes#"}
            else:
                lines = None
        base_iri = (base_iri or (lines["model"] if lines else default_base_iri(name))).strip()
        if not BASE_IRI.fullmatch(base_iri):
            raise ProjectError(
                "The base IRI must be an absolute IRI ending in # or /, "
                "for example http://example.org/invoices#."
            )
        prefix = (prefix or default_prefix(name)).strip()
        if not PREFIX.fullmatch(prefix):
            raise ProjectError(
                "The prefix must start with a letter and use only letters, digits, "
                "hyphens and underscores."
            )
        if not valid_lang(primary_language):
            raise ProjectError(
                f"{primary_language!r} is not a well-formed language tag (for example en or en-US)."
            )
        description = (description or "").strip()
        if len(description) > DESCRIPTION_MAX:
            raise ProjectError(f"A description can be at most {DESCRIPTION_MAX:,} characters.")
        chosen: list[dict] = []
        for key in dict.fromkeys(reference_keys or []):
            entry = references.by_key(key)
            if entry is None:
                raise ProjectError(f"There is no reference ontology called {key!r}.")
            chosen.append(entry)
        copying = source_text is not None or source_graph is not None
        if chosen and copying:
            raise ProjectError("A copy keeps its own file: reusing terms is chosen with a template.")
        for entry in chosen:
            if prefix in entry["reuse"]["prefixes"]:
                raise ProjectError(
                    f"{prefix} is {entry['reuse']['title']}'s prefix. Choose another for your project."
                )

        if source_text is not None:
            text = source_text
            graph = Graph()
            graph.parse(data=text, format="turtle")
        elif source_graph is not None:
            # A copy: the library's own graph is read, never written, and a
            # description is added below (code review).
            graph = Graph()
            for bound, namespace in source_graph.namespaces():
                graph.bind(bound, namespace, override=True, replace=True)
            for triple in source_graph:
                graph.add(triple)
            text = graph.serialize(format="longturtle")
        else:
            text = render_template(
                template or "empty", name=name, base_iri=base_iri, prefix=prefix, lang=primary_language,
                data_base=lines["data"] if lines else None,
            )
            graph = Graph()
            graph.parse(data=text, format="turtle")

        header = header_of(graph)
        comment = Literal(description, lang=primary_language) if description and header is not None else None
        if not copying and (chosen or comment is not None):
            declared = _with_references(graph, header, chosen)
            if comment is not None:
                graph.add((header, RDFS.comment, comment))
            text = references.keep_prefixes(
                graph.serialize(format="longturtle"), declared, (prefix, base_iri)
            )
        elif comment is not None and not any(
            isinstance(c, Literal) and (c.language or "").lower() == primary_language.lower()
            for c in graph.objects(header, RDFS.comment)
        ):
            # A copy's own description wins; one it lacks is added.
            graph.add((header, RDFS.comment, comment))
            if source_text is not None:
                text = text.rstrip("\n") + "\n\n" + _statement(header, RDFS.comment, comment)
            else:
                text = graph.serialize(format="longturtle")

        copied = copying
        kind = infer_kind(graph) if copied else TEMPLATE_KINDS[template or "empty"]
        pid = "prj-" + uuid.uuid4().hex[:12]
        folder = self.dir / pid
        folder.mkdir()
        (folder / "model.ttl").write_text(text, encoding="utf-8")
        documents = [{"file": "model.ttl", "role": "model"}]
        if not copied and template_shapes(template or "empty") is not None:
            shapes = render_template(
                template or "empty", name=name, base_iri=base_iri, prefix=prefix,
                lang=primary_language, part=".shapes",
                shapes_base=lines["shapes"] if lines else None,
            )
            (folder / DOCUMENTS["shapes"]).write_text(shapes, encoding="utf-8")
            documents.append({"file": "shapes.ttl", "role": "shapes"})
        now = _now()
        manifest = {
            "id": pid,
            "name": name,
            "createdAt": now,
            "updatedAt": now,
            "baseIri": base_iri,
            "prefix": prefix,
            "primaryLanguage": primary_language,
            "languages": [],
            "documents": documents,
            "counts": graph_counts(graph),
            # A template names its kind; a library copy is judged from what
            # it holds (D-089).
            "kind": kind,
            "commentsWarned": False,
            "startedFrom": source_name or template or "empty",
            # For the summary only: the file is the truth (5.4 item 5).
            "references": [e["key"] for e in chosen],
        }
        if lines is not None:
            # The address pattern this project was made under (design-checks
            # 5.2): shapes and examples mint at their own bases (5.3), and
            # the checks read it. A project without these behaves as before.
            manifest["naming"] = lines["parts"]
            manifest["shapesBaseIri"] = lines["shapes"]
            manifest["dataBaseIri"] = lines["data"]
        (folder / MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return self.summary(manifest)

    def add_document(self, pid: str, role: str) -> dict:
        """Create shapes.ttl at the root, empty, with the id `shapes`: what
        `{role: "shapes"}` alone has always meant (8.2), and what the first
        shape command makes when the project has no shapes file."""
        if role != "shapes":
            raise ProjectError("Only a shapes document can be added.")
        folder = self.folder(pid)
        path = folder / DOCUMENTS["shapes"]
        with self._lock:
            manifest = self.manifest(pid)
            listed = entries(manifest)
            if any(d["id"] == "shapes" for d in listed) or path.exists():
                raise ProjectError("This project already has a shapes document.")
            self._room(listed, folder, "", "shapes.ttl")
            path.write_text(_shapes_text(manifest), encoding="utf-8")
            listed.append({"id": "shapes", "file": "shapes.ttl", "role": "shapes"})
            manifest["documents"] = listed
            manifest["updatedAt"] = _now()
            self.write_manifest(pid, manifest)
        return self.summary(manifest)

    # --- files and folders (multi-file-projects 5.1, 5.2, 5.5) -------------------

    def _room(self, listed: list[dict], folder: Path, under: str, name: str, *, moving: Optional[str] = None) -> None:
        """A new name in a folder: under the file limit, and no file or
        folder of that name there already, compared without case (Windows
        folders ignore it). `moving` is the file being renamed or moved,
        which does not clash with itself."""
        if moving is None and len(listed) >= MAX_FILES:
            raise PathRefused(f"This project has {MAX_FILES} files, the most it can hold.")
        wanted = name.casefold()
        target = folder.joinpath(*under.split("/")) if under else folder
        for entry in listed:
            if entry["file"] != moving and file_folder(entry["file"]) == under and file_basename(entry["file"]).casefold() == wanted:
                raise PathRefused(f"There is already a file called {file_basename(entry['file'])} in this folder.", "name")
        if target.is_dir():
            for child in target.iterdir():
                own = (f"{under}/{child.name}" if under else child.name)
                if child.name.casefold() == wanted and own != moving:
                    what = "folder" if child.is_dir() else "file"
                    raise PathRefused(f"There is already a {what} called {child.name} in this folder.", "name")

    def _existing_folder(self, pid: str, under: str) -> Path:
        """A folder the project has, held to 8.3 and resolved inside it."""
        folder_parts(under)
        path = self.inside(pid, under)
        if under and not path.is_dir():
            raise PathRefused(f"There is no folder {under} in this project.", "folder")
        return path

    def add_file(self, pid: str, role: str, name: str, under: str = "") -> dict:
        """A new file of a role at a folder (5.5 item 5): the project's
        prefixes, and for ontology and vocabulary its own header (5.1 item
        6), written; the entry minted and appended. Returns the entry."""
        if role not in ROLES:
            raise PathRefused("A file is an ontology, a vocabulary or shapes.", "role")
        name = file_name(name)
        under = under or ""
        folder = self.folder(pid)
        with self._lock:
            self._existing_folder(pid, under)
            manifest = self.manifest(pid)
            listed = entries(manifest)
            self._room(listed, folder, under, name)
            file = f"{under}/{name}" if under else name
            path = self.inside(pid, file)
            if role == "shapes":
                text = _shapes_text(manifest)
            else:
                text = _model_text(manifest, file, role)
            entry = {"id": _mint_id(listed), "file": file, "role": role}
            # Exclusive: a file that appeared since the listing is never
            # written over.
            with open(path, "x", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            listed.append(entry)
            manifest["documents"] = listed
            manifest["updatedAt"] = _now()
            self.write_manifest(pid, manifest)
        return entry

    def move_file(self, pid: str, doc: str, name: Optional[str] = None, under: Optional[str] = None) -> dict:
        """Rename, move, or both (5.5 item 6): the path changes and nothing
        else -- the id, and so the layout (<id>.layout.json), the drafts and
        the undo history, stay. Returns the entry as it now is."""
        folder = self.folder(pid)
        with self._lock:
            manifest = self.manifest(pid)
            listed = entries(manifest)
            entry = self.entry(pid, doc, manifest)
            new_name = file_name(name) if name is not None else file_basename(entry["file"])
            new_under = (under or "") if under is not None else file_folder(entry["file"])
            self._existing_folder(pid, new_under)
            self._room(listed, folder, new_under, new_name, moving=entry["file"])
            file = f"{new_under}/{new_name}" if new_under else new_name
            if file == entry["file"]:
                return entry
            source = self.document_path(pid, doc, manifest)
            target = self.inside(pid, file)
            source.rename(target)
            for found in listed:
                if found["id"] == doc:
                    found["file"] = file
            manifest["documents"] = listed
            manifest["updatedAt"] = _now()
            self.write_manifest(pid, manifest)
        return {**entry, "file": file}

    def remove_file(self, pid: str, doc: str) -> str:
        """Into the project's own .trash/ (5.5 item 7), its layout beside
        it, and the entry dropped. The last ontology or vocabulary file is
        refused. Returns where it went, from the project folder."""
        folder = self.folder(pid)
        with self._lock:
            manifest = self.manifest(pid)
            listed = entries(manifest)
            entry = self.entry(pid, doc, manifest)
            if is_model_role(entry["role"]) and sum(1 for e in listed if is_model_role(e["role"])) == 1:
                raise ProjectError(
                    f"{file_basename(entry['file'])} is the project's last ontology or vocabulary file, "
                    "so it cannot be removed."
                )
            source = self.document_path(pid, doc, manifest)
            trash = folder / TRASH_DIR
            trash.mkdir(exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            target = trash / f"{stamp}-{doc}-{source.name}"
            shutil.move(str(source), str(target))
            layout = folder / f"{doc}.layout.json"
            if layout.exists():
                shutil.move(str(layout), str(trash / f"{stamp}-{doc}.layout.json"))
            self._layouts.pop(layout, None)
            manifest["documents"] = [e for e in listed if e["id"] != doc]
            manifest["updatedAt"] = _now()
            self.write_manifest(pid, manifest)
        return f"{TRASH_DIR}/{target.name}"

    def folders(self, pid: str) -> list[str]:
        """The project's folders, by path, sorted: what the index walks."""
        return self._walk(self.folder(pid))[1]

    def create_folder(self, pid: str, path: str) -> list[str]:
        parts = folder_parts(path)
        if not parts:
            raise PathRefused("A folder needs a name.", "name")
        folder = self.folder(pid)
        with self._lock:
            under = "/".join(parts[:-1])
            self._existing_folder(pid, under)
            self._room(entries(self.manifest(pid)), folder, under, parts[-1], moving="")
            self.inside(pid, path).mkdir()
        return self.folders(pid)

    def remove_folder(self, pid: str, path: str) -> list[str]:
        """An empty folder only (5.5 item 4): nothing in it at all, so no
        file the index skipped is lost with it."""
        if not folder_parts(path):
            raise PathRefused("The project folder itself cannot be removed.", "folder")
        with self._lock:
            target = self._existing_folder(pid, path)
            if any(target.iterdir()):
                raise PathRefused("Only an empty folder can be removed.", "folder")
            target.rmdir()
        return self.folders(pid)

    def _walk(self, folder: Path) -> tuple[list[str], list[str], list[dict]]:
        """(Turtle files, folders, skipped) under the project folder, up to
        three folder levels (5.2 item 1). Each name is held to 8.3 segment by
        segment; a link or a junction, which would lead out, is skipped and
        so is anything resolving outside (5.2 item 4). The app's own names
        and hidden names are passed over in silence."""
        files: list[str] = []
        folders: list[str] = []
        skipped: list[dict] = []
        root = folder.resolve()

        def visit(path: Path, prefix: str, level: int) -> None:
            try:
                children = sorted(path.iterdir(), key=lambda p: p.name.casefold())
            except OSError:
                return
            for child in children:
                name = child.name
                relative = f"{prefix}{name}"
                folded = name.casefold()
                if name.startswith(".") or (level == 0 and folded in RESERVED) or folded.endswith(RESERVED_SUFFIXES):
                    continue
                is_dir = child.is_dir()
                if not is_dir and not folded.endswith(".ttl"):
                    continue
                if child.is_symlink() or _is_junction(child):
                    skipped.append({"path": relative, "reason": f"{relative} is a link, so it was not read."})
                    continue
                try:
                    resolved = child.resolve()
                except OSError:
                    continue
                if root not in resolved.parents:
                    skipped.append({"path": relative, "reason": f"{relative} leads outside the project folder."})
                    continue
                reason = segment_error(name)
                if reason is not None:
                    skipped.append({"path": relative, "reason": f"{relative} was not read: {reason}"})
                    continue
                if is_dir:
                    if level >= MAX_LEVELS:
                        skipped.append({"path": relative, "reason": (
                            f"{relative} is more than {MAX_LEVELS} folder levels deep, so it was not read."
                        )})
                        continue
                    folders.append(relative)
                    visit(child, relative + "/", level + 1)
                else:
                    files.append(relative)

        visit(folder, "", 0)
        return files, sorted(folders, key=str.casefold), skipped

    def index(self, pid: str, role_of: Callable[[Path], Optional[str]]) -> dict:
        """The folder index (5.2), at open: the Turtle files on disk against
        the manifest's entries. A known file keeps its id and role; a file
        the manifest does not know is found, its role read by `role_of`
        (None: it could not be read, and it is skipped); an entry whose file
        is gone is dropped. The manifest is written only when something was
        found or dropped (5.1 item 4), so a project made before E-16 opens
        with project.json byte for byte as it was (AC-1).

        Returns {entries, folders, found, missing, skipped, wroteModel}."""
        folder = self.folder(pid)
        with self._lock:
            manifest = self.manifest(pid)
            listed = entries(manifest)
            files, folders, skipped = self._walk(folder)
            on_disk = {f.casefold(): f for f in files}
            kept, missing = [], []
            for entry in listed:
                found = on_disk.pop(entry["file"].casefold(), None)
                if found is None:
                    missing.append(entry["file"])
                    continue
                kept.append(entry)
            found_files = []
            for file in sorted(on_disk.values(), key=str.casefold):
                if len(kept) >= MAX_FILES:
                    skipped.append({"path": file, "reason": (
                        f"{file} was not read: a project holds at most {MAX_FILES} files."
                    )})
                    continue
                role = role_of(folder.joinpath(*file.split("/")))
                if role is None:
                    skipped.append({"path": file, "reason": f"{file} could not be read as Turtle, so it was not added."})
                    continue
                # model.ttl and shapes.ttl at the root keep their ids (5.1
                # item 2), even when their entry was lost.
                legacy = next((d for d, f in DOCUMENTS.items() if f == file and (d == "shapes") == (role == "shapes")), None)
                doc = legacy if legacy and all(e["id"] != legacy for e in kept) else _mint_id(kept)
                if doc == "model":
                    role = "model"
                kept.append({"id": doc, "file": file, "role": role})
                found_files.append(file)
            wrote_model = False
            if not any(is_model_role(e["role"]) for e in kept):
                # Never empty (Section 6): a project with no ontology or
                # vocabulary file left gets an empty model.ttl, and says so.
                path = folder / DOCUMENTS["model"]
                if not path.exists():
                    path.write_text(_model_text(manifest, "model.ttl", "model"), encoding="utf-8")
                kept.insert(0, {"id": "model", "file": "model.ttl", "role": "model"})
                wrote_model = True
            if found_files or missing or wrote_model:
                manifest["documents"] = kept
                manifest["updatedAt"] = _now()
                self.write_manifest(pid, manifest)
        return {
            "entries": kept, "folders": folders, "found": found_files,
            "missing": missing, "skipped": skipped, "wroteModel": wrote_model,
        }

    # --- rename, duplicate, trash, export --------------------------------------

    def rename(self, pid: str, name: str) -> dict:
        name = (name or "").strip()
        if not name:
            raise ProjectError("A project needs a name.")
        if len(name) > NAME_MAX:
            raise ProjectError(f"A project name can be at most {NAME_MAX} characters.")
        # The name only: the IRIs were minted from it once and never follow it.
        return self.summary(self.update_manifest(pid, name=name, updatedAt=_now()))

    def set_kind(self, pid: str, kind: str) -> dict:
        """Change the tools, not the model: only the manifest is written."""
        if kind not in KINDS:
            raise ProjectError("A project is an ontology or a taxonomy.")
        return self.summary(self.update_manifest(pid, kind=kind))

    def ensure_kind(self, pid: str, graph: Graph) -> None:
        """A project made before kinds gets one the first time it is opened,
        judged from its model the way a library copy is."""
        if self.manifest(pid).get("kind") not in KINDS:
            self.update_manifest(pid, kind=infer_kind(graph))

    def set_languages(self, pid: str, languages: list[str]) -> dict:
        manifest = self.manifest(pid)
        primary = manifest.get("primaryLanguage", "en")
        cleaned: list[str] = []
        for tag in languages:
            if not valid_lang(tag):
                raise ProjectError(f"{tag!r} is not a well-formed language tag (for example fr or es).")
            if tag.lower() != primary.lower() and tag not in cleaned:
                cleaned.append(tag)
        return self.summary(self.update_manifest(pid, languages=cleaned))

    def duplicate(self, pid: str) -> dict:
        """An independent copy: new id, its own files, no draft, no trash link."""
        source = self.folder(pid)
        new_id = "prj-" + uuid.uuid4().hex[:12]
        target = self.dir / new_id
        # Every file and folder, ids kept (5.7 item 1); never a link, which
        # would copy whatever it leads to.
        def ignored(where: str, names: list[str]) -> set[str]:
            return {
                n for n in names
                if n in (DRAFT_DIR, TRASH_DIR) or os.path.islink(os.path.join(where, n))
                or _is_junction(Path(where, n))
            }

        shutil.copytree(source, target, ignore=ignored)
        manifest = json.loads((target / MANIFEST).read_text(encoding="utf-8"))
        now = _now()
        manifest.update(id=new_id, name=f"{manifest['name']} (copy)", createdAt=now, updatedAt=now)
        # Copied queries would keep the original's ontology id, so they would
        # never list here, and share its query ids, so deleting one could
        # delete the other project's (found in review). Each gets a new id and
        # this project's document id.
        queries = target / "queries"
        if queries.is_dir():
            for path in sorted(queries.glob("q-*.json")):
                try:
                    entry = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    path.unlink(missing_ok=True)
                    continue
                entry["id"] = "q-" + uuid.uuid4().hex[:12]
                ontology_id = str(entry.get("ontologyId", ""))
                if ontology_id.startswith(pid + "-"):
                    entry["ontologyId"] = new_id + ontology_id[len(pid):]
                (queries / f"{entry['id']}.json").write_text(
                    json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                path.unlink()
        (target / MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return self.summary(manifest)

    def trash_project(self, pid: str) -> str:
        """Move the folder into .trash/ and return where it went, relative to the
        data directory, for the confirmation to name."""
        source = self.folder(pid)
        self.trash.mkdir(exist_ok=True)
        target = self.trash / pid
        if target.exists():
            # A second delete of a restored-then-deleted project keeps both.
            target = self.trash / f"{pid}-{uuid.uuid4().hex[:6]}"
        shutil.move(str(source), str(target))
        return f"projects/{TRASH_DIR}/{target.name}"

    def export_zip(self, pid: str) -> bytes:
        """The folder as a zip, without the autosave draft or the snapshots
        moved to the project's own trash."""
        folder = self.folder(pid)
        buffer = io.BytesIO()
        found: list[Path] = []
        # Walked without following a link: a link in the folder would put
        # whatever it leads to in the zip (5.7 item 2).
        for where, dirs, names in os.walk(folder, followlinks=False):
            here = Path(where)
            dirs[:] = [
                d for d in dirs
                if not (here == folder and d in (DRAFT_DIR, TRASH_DIR))
                and not os.path.islink(here / d) and not _is_junction(here / d)
            ]
            found += [here / n for n in names if not os.path.islink(here / n)]
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(found):
                if path.is_file():
                    zf.write(path, path.relative_to(folder).as_posix())
        return buffer.getvalue()

    # --- saved queries -----------------------------------------------------------

    def queries(self, pid: str) -> SavedQueryStore:
        """The project's own saved-query store, in <project>/queries/."""
        return SavedQueryStore(self.folder(pid))

    def all_query_stores(self) -> list[SavedQueryStore]:
        stores = []
        for summary in self.list():
            try:
                stores.append(self.queries(summary["id"]))
            except UnknownProject:
                continue
        return stores


def split_document_id(oid: str) -> Optional[tuple[str, str]]:
    """prj-<hex>-<id> -> ("prj-<hex>", "<id>"), or None for anything else:
    the id is model, shapes or a minted f<8 hex> (5.1 item 2), in full."""
    match = re.fullmatch(r"(prj-[0-9a-f]{12})-(model|shapes|f[0-9a-f]{8})", oid or "")
    return (match.group(1), match.group(2)) if match else None


def document_id(pid: str, doc: str) -> str:
    return f"{pid}-{doc}"
