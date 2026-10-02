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
    name; a document is one of a fixed set of names. Anything else is an
    UnknownProject or UnknownDocument, which the router answers 404 -- the same
    refusal whether the id is malformed, traverses (`../`, a backslash, an
    absolute path) or simply does not exist, so nothing is learnt from probing.

    Templates are Turtle with {{base}}, {{prefix}}, {{ontology}}, {{name}} and
    {{lang}} placeholders, substituted before parsing. The name is the one
    free-text value and is escaped as a Turtle string; base and prefix are
    validated first, so neither can close the IRI or the prefix declaration
    they sit in. Every template is written in the project's primary language.
    A template may ship starter shapes beside it, <template>.shapes.ttl,
    rendered the same way and written as the project's shapes.ttl: the Small
    one does, with two examples in its model, so a learner's first Validate
    already shows red and green (shacl-authoring 5.8, row S23).

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
    - Raises ProjectError (400, a sentence), UnknownProject and UnknownDocument
      (404).
================================================================================
"""

from __future__ import annotations

import copy
import io
import json
import math
import re
import shutil
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

from .queries_store import SavedQueryStore

# What create() mints. fullmatch, never match: `$` also matches before a
# trailing newline, the hole CF-5 closed for query ids.
PROJECT_ID = re.compile(r"prj-[0-9a-f]{12}")

# The only document names there are. The key is what the API and the
# ontology id carry (prj-<hex>-model); the value is the file.
DOCUMENTS = {"model": "model.ttl", "shapes": "shapes.ttl"}
DOCUMENT_ROLES = {"model": "model", "shapes": "shapes"}

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
    return {"version": LAYOUT_VERSION, "generation": 0, "positions": {}, "shown": None, "viewport": None}


def _finite(value) -> bool:
    # bool is an int to Python; true is not a coordinate.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _key(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= LAYOUT_KEY_MAX


def validate_layout(data) -> dict:
    """A layout from the browser, checked and normalised, or ProjectError.

    {version: 1, positions: {iri: [x, y]}, shown: [iri, ...] | null,
    viewport: {x, y, zoom} | null}. Nothing else is kept. A `generation`
    is kept when it is a whole number, which is how the file's own counter
    is read back; one sent by the browser is replaced by write_layout.
    """
    if not isinstance(data, dict):
        raise ProjectError("A layout is an object with positions, shown and viewport.")
    positions = data.get("positions", {})
    if not isinstance(positions, dict):
        raise ProjectError("A layout's positions are an object of IRI to [x, y].")
    shown = data.get("shown")
    count = len(positions) + (len(shown) if isinstance(shown, list) else 0)
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
    }


class ProjectError(ValueError):
    """A request that cannot be carried out, with the sentence saying why."""


class UnknownProject(LookupError):
    """An id this store did not issue, or one that is no longer here."""


class UnknownDocument(LookupError):
    """A document name outside the fixed set, or one not created yet."""


def valid_lang(tag: str) -> bool:
    return isinstance(tag, str) and LANG_TAG.fullmatch(tag) is not None


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "project"


def default_base_iri(name: str) -> str:
    """Open question 2, closed as recommended: http://example.org/<slug>#."""
    return f"http://example.org/{slugify(name)}#"


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


def template_shapes(template: str) -> Optional[Path]:
    """The starter shapes a template ships, or None: the Small template has
    them, so a first Validate already shows a mix of results (S23)."""
    path = TEMPLATE_DIR / f"{template}.shapes.ttl"
    return path if template in TEMPLATES and path.is_file() else None


def render_template(
    template: str, *, name: str, base_iri: str, prefix: str, lang: str, part: str = ""
) -> str:
    """A template's model, or with part=".shapes" its starter shapes."""
    if template not in TEMPLATES:
        raise ProjectError(f"There is no template called {template!r}.")
    text = (TEMPLATE_DIR / f"{template}{part}.ttl").read_text(encoding="utf-8")
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
    def document_file(doc: str) -> str:
        if not isinstance(doc, str) or doc not in DOCUMENTS:
            raise UnknownDocument(doc)
        return DOCUMENTS[doc]

    def document_path(self, pid: str, doc: str) -> Path:
        path = self.folder(pid) / self.document_file(doc)
        if not path.is_file():
            raise UnknownDocument(doc)
        return path

    # --- layouts (visual-modeling 5.5) ------------------------------------------

    def layout_path(self, pid: str, doc: str) -> Path:
        """<doc>.layout.json beside the document: a fixed name, a known doc."""
        self.document_file(doc)  # UnknownDocument for a name not issued
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
            "documents": manifest["documents"],
            "counts": manifest.get("counts", {}),
            # The data snapshots, for the card's line (csv-data-import 5.7);
            # written by snapshots.py whenever one changes.
            "data": manifest.get("data", []),
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
    ) -> dict:
        """A new project with model.ttl written, from a template or a library copy.

        `source_text` is a library file that was Turtle already, copied
        verbatim so its comments and layout survive; `source_graph` is any
        other format, written as clean Turtle.
        """
        name = (name or "").strip()
        if not name:
            raise ProjectError("A project needs a name.")
        if len(name) > NAME_MAX:
            raise ProjectError(f"A project name can be at most {NAME_MAX} characters.")
        base_iri = (base_iri or default_base_iri(name)).strip()
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

        if source_text is not None:
            text = source_text
            graph = Graph()
            graph.parse(data=text, format="turtle")
        elif source_graph is not None:
            graph = source_graph
            text = graph.serialize(format="longturtle")
        else:
            text = render_template(
                template or "empty", name=name, base_iri=base_iri, prefix=prefix, lang=primary_language
            )
            graph = Graph()
            graph.parse(data=text, format="turtle")

        copied = source_text is not None or source_graph is not None
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
        }
        (folder / MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return self.summary(manifest)

    def add_document(self, pid: str, role: str) -> dict:
        """Create shapes.ttl, empty. SHACL itself arrives with V-6."""
        if role != "shapes":
            raise ProjectError("Only a shapes document can be added.")
        folder = self.folder(pid)
        path = folder / DOCUMENTS["shapes"]
        with self._lock:
            manifest = self.manifest(pid)
            if any(d["role"] == "shapes" for d in manifest["documents"]):
                raise ProjectError("This project already has a shapes document.")
            path.write_text(
                f"@prefix {manifest['prefix']}: <{manifest['baseIri']}> .\n"
                "@prefix sh: <http://www.w3.org/ns/shacl#> .\n",
                encoding="utf-8",
            )
            manifest["documents"].append({"file": "shapes.ttl", "role": "shapes"})
            manifest["updatedAt"] = _now()
            self.write_manifest(pid, manifest)
        return self.summary(manifest)

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
        shutil.copytree(source, target, ignore=shutil.ignore_patterns(DRAFT_DIR, TRASH_DIR))
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
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(folder.rglob("*")):
                relative = path.relative_to(folder)
                if relative.parts and relative.parts[0] in (DRAFT_DIR, TRASH_DIR):
                    continue
                if path.is_file():
                    zf.write(path, relative.as_posix())
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
    """prj-<hex>-model -> ("prj-<hex>", "model"), or None for anything else."""
    match = re.fullmatch(r"(prj-[0-9a-f]{12})-(model|shapes)", oid or "")
    return (match.group(1), match.group(2)) if match else None


def document_id(pid: str, doc: str) -> str:
    return f"{pid}-{doc}"
