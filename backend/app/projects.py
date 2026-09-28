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

    Delete never destroys: the folder moves into projects/.trash/, and the
    trash is emptied by hand (open question 3, closed as recommended).

INPUTS / INPUT SOURCES
    - The data directory from the ontology store (SEMANTIC_STUDIO_DATA_DIR).
    - Templates in app/templates/.
    - A library ontology's graph, for "Start a project from this".

EXPECTED OUTPUT
    - Project folders and manifests on disk, and manifest dicts for the API.
    - Raises ProjectError (400, a sentence), UnknownProject and UnknownDocument
      (404).
================================================================================
"""

from __future__ import annotations

import io
import json
import re
import shutil
import threading
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

TEMPLATES = {"empty", "vocabulary", "small"}
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


def render_template(
    template: str, *, name: str, base_iri: str, prefix: str, lang: str
) -> str:
    if template not in TEMPLATES:
        raise ProjectError(f"There is no template called {template!r}.")
    text = (TEMPLATE_DIR / f"{template}.ttl").read_text(encoding="utf-8")
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
            "documents": manifest["documents"],
            "counts": manifest.get("counts", {}),
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

        pid = "prj-" + uuid.uuid4().hex[:12]
        folder = self.dir / pid
        folder.mkdir()
        (folder / "model.ttl").write_text(text, encoding="utf-8")
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
            "documents": [{"file": "model.ttl", "role": "model"}],
            "counts": graph_counts(graph),
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
        shutil.copytree(source, target, ignore=shutil.ignore_patterns(DRAFT_DIR))
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
        """The folder as a zip, without the autosave draft."""
        folder = self.folder(pid)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(folder.rglob("*")):
                relative = path.relative_to(folder)
                if relative.parts and relative.parts[0] == DRAFT_DIR:
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
