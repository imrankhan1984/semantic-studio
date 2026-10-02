"""
================================================================================
FILE: backend/app/editing.py
================================================================================

SUMMARY
    The open project documents and every way one can change: typed commands
    producing triple deltas, a whole-document Turtle apply, undo and redo,
    save under formatting option A, autosave to a draft, and recovery from it
    (D-082, D-083). This is the only module that mutates a project document's
    graph; test_no_direct_mutation.py holds the rest of the code to that.

BASIC IDEA
    A document, once its project is opened, is an Ontology registered in the
    store under prj-<hex>-<doc>, so every read endpoint serves it unchanged.
    Every change goes through one path: work out a delta (triples to add,
    triples to remove, both restricted to what would really change), apply it,
    bump the revision -- which is what every cached view is keyed on -- and push
    the inverse onto the undo stack with a human label, capped at 200 steps.

    Each step also remembers the editor text and the save rule's flag on both
    of its sides, so undoing a Turtle apply puts the text back as it was and a
    save after it writes the file byte for byte (visual-modeling 5.7). And the
    document remembers which step it was saved at -- the save point -- so an
    undo or redo that lands on it leaves the document clean: Saved, nothing to
    recover, no question on close.

    A command is checked before anything moves: its IRIs are absolute (or a
    prefixed name the document or the well-known vocabularies define), its
    targets exist, a new IRI is not taken, a value is valid for its datatype.
    A refusal is a CommandError carrying a sentence, and the graph is untouched.
    The modeling checks of relationships 5.9 -- contradicting characteristics,
    the OWL 2 rule for chaining relationships (SetCharacteristic,
    AddSubPropertyOf and SetInverse), a relationship as its own inverse, related concepts one broader than the
    other, a loop of broader or sub-relationship links -- are modeling_checks'
    sentences, raised the same way.

    Examples (shacl-authoring 5.8) are individuals of the model's classes,
    made so a shape has something to check: CreateExample types one with its
    class and owl:NamedIndividual, and SetExampleValue, AddExampleValue and
    RemoveExampleValue fill its attributes and relationships, an attribute's
    value checked against its type of value as an annotation's is, so a
    wrong one is refused with the type's sentence (row S22). What counts as
    an example is examples.py's to say.

    A concept's place at the top of its scheme is kept by the commands, never
    by hand (D-091): CreateConcept joins the scheme and is a top concept when
    nothing above it is in the scheme, and AddBroader, RemoveBroader and a
    concept's delete move skos:hasTopConcept in the same undo step.

    Turtle is parsed with the project's base IRI, so a relative IRI such as
    <owns> is base + "owns" and never a path on this machine (CF-8).

    Formatting option A decides what Save writes. While every change since the
    last save came from the editor, the file gets the text last applied,
    comments and layout included. Once any change came from a command, an undo
    or a redo, it gets rdflib's longturtle -- measured identical across repeated
    parses, sorted by subject, so it diffs well. Before the first such save of a
    file that has comments, the caller is told once, and on confirmation the
    file is copied to <doc>.original.ttl.

    The modeling canvas reads the document through canvas_view: canvas.py's
    boxes and lines, cached by revision and display language like every other
    view, then cut to the shown set and given the saved layout on each
    request. The layout itself is projects.py's file, outside the model: a
    rename is the one command that touches it, moving the entry to the new
    IRI, and its undo and redo move it back and forth (D-087). A position
    whose IRI is gone is kept until the project is next opened, so undoing a
    delete puts the box back where it was.

    A project's data snapshots (csv-data-import, D-096) are not documents
    and nothing here changes them: the SnapshotService the editing service
    holds loads them when the project opens and drops them when it closes,
    the model's Ontology is given them for its views, and Validate checks
    them with the model. model_reader lends the data wizard the model, its
    imports and names, under the model's lock.

    Autosave never runs on the request path. A change arms a timer (two seconds,
    reset by every later change); the timer thread snapshots the document under
    its lock and writes .draft/<doc>.ttl outside it. Recovery reads that draft
    back as unsaved content: the undo history is not recovered, which is simpler
    than replaying a journal and survives blank nodes, which a triple journal
    would not.

INPUTS / INPUT SOURCES
    - Project folders and manifests, through projects.ProjectStore.
    - Command names and arguments, and Turtle text, from routers/projects.py.
    - The project's base IRI, from its manifest, for every Turtle parse.
    - The imports merged view, read only, for targets defined in an import and
      for the delete impact's import mentions.

EXPECTED OUTPUT
    - Mutated document graphs, new revisions, undo labels; a create (an
      example's too) or rename
      command's result names the entity's IRI (`created`), so the interface
      can select it.
    - Files: <doc>.ttl on save, <doc>.original.ttl once, .draft/<doc>.ttl and
      .draft/<doc>.json while unsaved.
    - The canvas view, and layout entries moved by a rename or pruned on open.
    - CommandError (422, a sentence), TurtleSyntaxError (422, line and column),
      NotOpen and Dirty (409).
================================================================================
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS, SKOS, XSD

from .graph_builder import (
    lang_matches,
    name_in,
    pick_label_in,
    prefixed,
)
from .projects import (
    DRAFT_DIR,
    ProjectStore,
    UnknownDocument,
    document_id,
    graph_counts,
    valid_lang,
)
from . import examples, lexical, modeling_checks, shacl, shapes_form
from .canvas import build_canvas, restrict
from .imports import imports_service, load_state
from .snapshots import SnapshotService
from .store import Ontology, OntologyStore, ParseTimeout
from .store import store as _default_store

Triple = tuple

UNDO_LIMIT = 200
# Read at arm time, so a test can shorten it without re-importing.
AUTOSAVE_DELAY = 2.0

WELL_KNOWN = {
    "rdf": str(RDF),
    "rdfs": str(RDFS),
    "owl": str(OWL),
    "xsd": str(XSD),
    "skos": str(SKOS),
    "dcterms": str(DCTERMS),
}

# An absolute IRI: a scheme, then no character that would end an IRI in Turtle.
ABSOLUTE_IRI = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:[^\s<>\"{}|\\^`]+")
# Schemes whose IRIs have no "//". Anything else written prefix:local with an
# unknown prefix is far likelier a mistyped prefixed name than an IRI in an
# unregistered scheme, so it is refused rather than minted.
OPAQUE_SCHEMES = {"urn", "mailto", "tag", "info", "doi", "did", "data", "tel"}
CURIE = re.compile(r"([A-Za-z][A-Za-z0-9_.-]*)?:([^\s<>\"{}|\\^`:]*)")


class CommandError(ValueError):
    """A command refused, with the sentence the user reads."""


class TurtleSyntaxError(ValueError):
    def __init__(self, message: str, line: Optional[int], column: Optional[int], detail: str):
        super().__init__(message)
        self.line = line
        self.column = column
        self.detail = detail


class NotOpen(LookupError):
    """A document whose project is not open."""


class Dirty(RuntimeError):
    """Closing a project with unsaved changes, without saying to discard them."""


# ---------------------------------------------------------------------------
# Typed annotation values (5.4.1)
# ---------------------------------------------------------------------------

OFFERED_DATATYPES = {
    "string": XSD.string,
    "integer": XSD.integer,
    "decimal": XSD.decimal,
    "boolean": XSD.boolean,
    "date": XSD.date,
    "dateTime": XSD.dateTime,
    "anyURI": XSD.anyURI,
}
_DATATYPE_BY_IRI = {v: k for k, v in OFFERED_DATATYPES.items()}


def check_lexical(value: str, datatype: str) -> None:
    """Refuse a value that is not valid for its datatype, naming the type."""
    if datatype == "string":
        return
    if datatype == "anyURI":
        if re.search(r"\s", value) or not value:
            raise CommandError(f'"{value}" is not a valid URI (it is empty or contains a space).')
        return
    # The rules are lexical.py's, shared with the data import's engine, so
    # what the form refuses is exactly what an import keeps as text.
    if not lexical.valid(value, datatype):
        _, name, expected = lexical.LEXICAL[datatype]
        raise CommandError(f'"{value}" is not a valid {name} (expected {expected}).')


def parse_value(spec, primary: str, resolve: Callable[[str], URIRef]):
    """A value object {kind, value, lang?, datatype?} as an RDF term.

    Text is a language-tagged string, the primary language by default. A typed
    value is one of the seven offered datatypes, checked lexically. A link is
    an IRI. RDF forbids a literal with both a language and a datatype, and so
    does this.
    """
    if not isinstance(spec, dict):
        raise CommandError("A value needs a kind: text, typed or link.")
    kind = spec.get("kind")
    raw = spec.get("value")
    if not isinstance(raw, str):
        raise CommandError("A value needs its text.")
    lang = spec.get("lang")
    datatype = spec.get("datatype")
    if lang and datatype:
        raise CommandError(
            "A value cannot carry both a language and a datatype; RDF allows one or the other."
        )
    if kind == "text":
        lang = lang or primary
        if not valid_lang(lang):
            raise CommandError(f'"{lang}" is not a well-formed language tag (for example en or fr).')
        if not raw.strip():
            raise CommandError("A text value cannot be empty.")
        return Literal(raw, lang=lang)
    if kind == "typed":
        if lang:
            raise CommandError(
                "A value cannot carry both a language and a datatype; RDF allows one or the other."
            )
        name = _datatype_name(datatype)
        check_lexical(raw, name)
        return Literal(raw, datatype=OFFERED_DATATYPES[name])
    if kind == "link":
        return resolve(raw)
    raise CommandError("A value's kind is text, typed or link.")


def _datatype_name(datatype) -> str:
    if not isinstance(datatype, str) or not datatype:
        raise CommandError("A typed value needs a datatype.")
    for name, iri in OFFERED_DATATYPES.items():
        if datatype in (name, f"xsd:{name}", str(iri)):
            return name
    offered = ", ".join(f"xsd:{n}" for n in OFFERED_DATATYPES)
    raise CommandError(f"{datatype} is not one of the offered datatypes ({offered}).")


def value_json(term) -> dict:
    if isinstance(term, Literal):
        if term.language:
            return {"kind": "text", "value": str(term), "lang": term.language}
        name = _DATATYPE_BY_IRI.get(term.datatype, None)
        return {
            "kind": "typed",
            "value": str(term),
            "datatype": f"xsd:{name}" if name else (str(term.datatype) if term.datatype else "xsd:string"),
        }
    return {"kind": "link", "value": str(term)}


# The suggested annotation properties (5.4.1), with the value type the form
# offers first. The user can change the type; this is only the default.
_TEXT = {"kind": "text"}
_LINK = {"kind": "link"}
SUGGESTED_ANNOTATIONS = [
    *[
        (p, _TEXT)
        for p in (
            RDFS.label, RDFS.comment, SKOS.prefLabel, SKOS.altLabel, SKOS.hiddenLabel,
            SKOS.definition, SKOS.example, SKOS.scopeNote, SKOS.note, SKOS.editorialNote,
            SKOS.changeNote, SKOS.historyNote, DCTERMS.title, DCTERMS.description,
        )
    ],
    (RDFS.seeAlso, _LINK),
    (RDFS.isDefinedBy, _LINK),
    (DCTERMS.source, _LINK),
    (DCTERMS.created, {"kind": "typed", "datatype": "xsd:date"}),
    (DCTERMS.modified, {"kind": "typed", "datatype": "xsd:date"}),
    (OWL.deprecated, {"kind": "typed", "datatype": "xsd:boolean"}),
    (OWL.versionInfo, {"kind": "typed", "datatype": "xsd:string"}),
    (DCTERMS.creator, {"kind": "typed", "datatype": "xsd:string"}),
]


def value_type_from_range(rng) -> dict:
    """A declared annotation property's rdfs:range as the form's default type."""
    if rng == RDF.langString:
        return _TEXT
    if rng in (RDFS.Resource, OWL.Thing):
        return _LINK
    if rng in _DATATYPE_BY_IRI:
        return {"kind": "typed", "datatype": f"xsd:{_DATATYPE_BY_IRI[rng]}"}
    return _TEXT


def range_for_value_type(spec) -> Optional[URIRef]:
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise CommandError("A value type is {kind: text | typed | link}.")
    kind = spec.get("kind")
    if kind == "text":
        return RDF.langString
    if kind == "link":
        return RDFS.Resource
    if kind == "typed":
        return OFFERED_DATATYPES[_datatype_name(spec.get("datatype"))]
    raise CommandError("A value type's kind is text, typed or link.")


# ---------------------------------------------------------------------------
# Comments, parse errors and IRI minting
# ---------------------------------------------------------------------------


def has_comments(text: str) -> bool:
    """True when Turtle text has a # outside strings and IRIs.

    A small scanner rather than a regex: a # inside <http://x#y> or inside
    "a # b" is not a comment, and long strings may span lines.
    """
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "#":
            return True
        if c == "<":
            end = text.find(">", i + 1)
            # A "<" that never closes is not an IRI; treat the rest as code.
            if end == -1 or "\n" in text[i:end]:
                i += 1
                continue
            i = end + 1
            continue
        if c in "\"'":
            triple = text[i : i + 3]
            if triple in ('"""', "'''"):
                end = text.find(triple, i + 3)
                while end != -1 and _escaped(text, end):
                    end = text.find(triple, end + 1)
                i = n if end == -1 else end + 3
                continue
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        i += 1
    return False


def _escaped(text: str, index: int) -> bool:
    backslashes = 0
    while index - 1 - backslashes >= 0 and text[index - 1 - backslashes] == "\\":
        backslashes += 1
    return backslashes % 2 == 1


def local_name_from(label: str, lower_first: bool) -> str:
    """Invoice item -> InvoiceItem (classes, concepts) or invoiceItem (properties)."""
    words = re.findall(r"[^\W_]+", label, flags=re.UNICODE)
    if not words:
        return ""
    joined = "".join(w[:1].upper() + w[1:] for w in words)
    if lower_first:
        joined = joined[:1].lower() + joined[1:]
    if joined[0].isdigit():
        joined = "_" + joined
    return joined


# Where a relative IRI lands while the text is parsed, before it is moved
# onto the project's base. A reserved name (RFC 2606), so no real IRI starts
# with it.
_RELATIVE = "http://relative.invalid/"


def parse_turtle(text: str, timeout: Optional[float], base: Optional[str] = None) -> Graph:
    """Turtle only, under the upload path's wall-clock limit.

    Not store.parse_rdf: that tries every format in turn, and an editor error
    has to be Turtle's error, with the line and column where it happened.

    With `base`, a relative IRI is the project's: `<owns>` is base + "owns"
    (CF-8). Without one rdflib resolved it against the server's working
    folder, so the model gained file:///C:/... and the machine's path went
    out in every save and export. (A file saved as the editor's text keeps
    `<owns>` as typed; the model it holds never names a folder again.) It is
    written onto the base rather than
    resolved against it, because the default base ends in "#": RFC 3986 would
    turn <owns> under http://example.org/shop# into http://example.org/owns,
    which is not what a learner who typed it means. An @base in the text
    still wins, as Turtle says.
    """
    def work() -> Graph:
        parsed = Graph()
        try:
            parsed.parse(data=text, format="turtle", publicID=_RELATIVE if base else None)
        except Exception as exc:  # rdflib raises BadSyntax and friends
            raise _syntax_error(text, exc) from exc
        return _onto_base(parsed, base) if base else parsed

    if timeout is None:
        return work()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(contextvars.copy_context().run, work)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeout as exc:
            pool.shutdown(wait=False, cancel_futures=True)
            raise ParseTimeout(
                f"This text took longer than {timeout:g} seconds to parse and was stopped."
            ) from exc


def _onto_base(parsed: Graph, base: str) -> Graph:
    """Every IRI parsed under _RELATIVE, moved onto the project's base."""
    def rebase(value: str) -> str:
        rest = value[len(_RELATIVE):]
        # <#x> under a base ending in "#" is base + "x", not base + "#x".
        if rest.startswith("#") and base.endswith("#"):
            rest = rest[1:]
        return base + rest

    def term(t):
        if isinstance(t, URIRef) and str(t).startswith(_RELATIVE):
            return URIRef(rebase(str(t)))
        if isinstance(t, Literal) and t.datatype is not None and str(t.datatype).startswith(_RELATIVE):
            return Literal(str(t), datatype=URIRef(rebase(str(t.datatype))))
        return t

    namespaces = list(parsed.namespaces())
    touched = any(str(ns).startswith(_RELATIVE) for _, ns in namespaces) or any(
        term(t) is not t for triple in parsed for t in triple
    )
    if not touched:
        return parsed
    moved = Graph()
    for prefix, namespace in namespaces:
        moved.bind(prefix, term(URIRef(namespace)), override=True, replace=True)
    for s, p, o in parsed:
        moved.add((term(s), term(p), term(o)))
    return moved


def _syntax_error(text: str, exc: Exception) -> TurtleSyntaxError:
    detail = str(exc)
    index = getattr(exc, "_i", None)
    source = getattr(exc, "_str", None)
    why = getattr(exc, "_why", None) or (detail.splitlines()[0] if detail else "Not valid Turtle.")
    if isinstance(index, int) and isinstance(source, (bytes, bytearray)):
        before = bytes(source[:index])
        line = before.count(b"\n") + 1
        line_start = before.rfind(b"\n") + 1
        column = len(before[line_start:].decode("utf-8", errors="replace")) + 1
        return TurtleSyntaxError(
            f"Line {line}, column {column}: {why}", line, column, detail
        )
    return TurtleSyntaxError(f"Not valid Turtle: {why}", None, None, detail)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_turtle(graph: Graph) -> str:
    return graph.serialize(format="longturtle")


# ---------------------------------------------------------------------------
# The command layer
# ---------------------------------------------------------------------------


@dataclass(eq=False)
class Step:
    """One undo step. Compared by identity: the save point is a step, and two
    steps with the same label and delta are still two points in the history.

    `before` and `after` are (editor text, visual since save) on each side of
    the step. Undo restores `before` and redo `after`, so the text an apply
    replaced comes back with its comments and layout, and the save rule
    (D-083) holds across undo."""

    label: str
    added: list
    removed: list
    before: tuple = (None, True)
    after: tuple = (None, True)
    # (old, new) for a RenameIri: undo and redo move the layout entry too.
    renamed: Optional[tuple] = None


@dataclass
class Change:
    """What a command computed: a delta and the label the undo stack shows."""

    label: str
    added: list
    removed: list
    # The IRI a create command minted, or a rename moved the entity to, so
    # the interface can select it.
    created: Optional[URIRef] = None
    renamed: Optional[tuple] = None


class Context:
    """What a command reads: the graph, the project, and name resolution."""

    def __init__(
        self,
        graph: Graph,
        manifest: dict,
        imported: Callable[[], Optional[Graph]],
        doc: str = "model",
        model: Optional[Callable[[], Graph]] = None,
    ):
        self.graph = graph
        self.manifest = manifest
        self.primary = manifest.get("primaryLanguage", "en")
        self.languages = [self.primary, *manifest.get("languages", [])]
        self.base = manifest["baseIri"]
        self.doc = doc
        self._imported = imported
        self._imported_view: Optional[Graph] = None
        self._imported_read = False
        self._model = model
        self._model_view: Optional[Graph] = None

    @property
    def model(self) -> Graph:
        """What a shape is about (shacl-authoring 5.3): the model document
        with its resolved imports, for target classes, paths and names. The
        document itself when it is the model."""
        if self._model_view is None:
            self._model_view = self._model() if self._model is not None else self.graph
        return self._model_view

    @property
    def imported(self) -> Optional[Graph]:
        """The merged imports view, built only when a command asks: most
        targets are in the document itself, and the view is rebuilt for every
        revision (found in review)."""
        if not self._imported_read:
            self._imported_view = self._imported()
            self._imported_read = True
        return self._imported_view

    # --- names --------------------------------------------------------------

    def iri(self, value, what: str = "IRI") -> URIRef:
        """An absolute IRI, or a prefixed name this document or a well-known
        vocabulary defines. Anything else is refused with a sentence."""
        if isinstance(value, URIRef):
            return value
        if not isinstance(value, str) or not value.strip():
            raise CommandError(f"A {what} is required.")
        value = value.strip()
        curie = CURIE.fullmatch(value)
        if curie and "//" not in value:
            namespace = self._namespace(curie.group(1) or "")
            if namespace:
                return URIRef(namespace + curie.group(2))
        if ABSOLUTE_IRI.fullmatch(value) and (
            "//" in value or value.split(":", 1)[0].lower() in OPAQUE_SCHEMES
        ):
            return URIRef(value)
        raise CommandError(f'"{value}" is not an absolute IRI or a known prefixed name.')

    def _namespace(self, prefix: str) -> Optional[str]:
        # The project's own prefix first: it names the base IRI even before
        # the document has bound it.
        if prefix == self.manifest.get("prefix"):
            return self.base
        for bound, namespace in self.graph.namespace_manager.namespaces():
            if bound == prefix:
                return str(namespace)
        return WELL_KNOWN.get(prefix)

    def mentioned(self, iri: URIRef) -> bool:
        g = self.graph
        return (iri, None, None) in g or (None, None, iri) in g or (None, iri, None) in g

    def exists(self, iri: URIRef) -> bool:
        """Mentioned in the document, defined by a resolved import, or a term
        of a well-known vocabulary (owl:Thing, xsd:string ...)."""
        if self.mentioned(iri):
            return True
        if self.imported is not None and (iri, None, None) in self.imported:
            return True
        return any(str(iri).startswith(ns) for ns in WELL_KNOWN.values())

    def require(self, iri: URIRef, what: str) -> None:
        if not self.exists(iri):
            raise CommandError(f"There is no {what} {self.short(iri)} in this document or its imports.")

    def require_new(self, iri: URIRef) -> None:
        if self.mentioned(iri):
            raise CommandError(
                f"{self.short(iri)} is already used in this document; choose another IRI."
            )

    def short(self, iri: URIRef) -> str:
        return prefixed(self.graph, iri)

    def name(self, iri: URIRef) -> str:
        return pick_label_in(self.graph, iri, [self.primary])[0]

    def minted(self, args: dict, label: str, lower_first: bool) -> URIRef:
        """The IRI a create command gives: the one sent, else base + the
        primary-language name, never changed when the label changes later."""
        if args.get("iri"):
            return self.iri(args["iri"])
        local = local_name_from(label, lower_first)
        if not local:
            raise CommandError("An IRI cannot be made from that name; give the IRI as well.")
        return URIRef(self.base + local)

    def primary_label(self, args: dict, key: str = "label") -> str:
        label = args.get(key)
        if not isinstance(label, str) or not label.strip():
            raise CommandError(
                f"A new entity needs a name in the project's primary language ({self.primary})."
            )
        return label.strip()

    def kind(self, iri: URIRef) -> str:
        types = set(self.graph.objects(iri, RDF.type))
        if types & {OWL.Class, RDFS.Class}:
            return "class"
        if OWL.ObjectProperty in types:
            return "object property"
        if OWL.DatatypeProperty in types:
            return "datatype property"
        if OWL.AnnotationProperty in types:
            return "annotation property"
        if RDF.Property in types:
            return "property"
        if SKOS.Concept in types:
            return "concept"
        if SKOS.ConceptScheme in types:
            return "concept scheme"
        if examples.is_example(self.graph, iri):
            return "example"
        return "entity"


def _change(graph: Graph, label: str, adds: Iterable = (), removes: Iterable = ()) -> Change:
    """Only what would really change, so the inverse restores exactly.

    A triple both removed and added is no change at all, and stays where it
    is: setting a label to the value it already has must leave the label,
    not delete it (the first version did, found in review).
    """
    removing = {t for t in removes if t in graph}
    adding = {t for t in adds if t not in graph or t in removing}
    both = adding & removing
    added = [t for t in dict.fromkeys(adds) if t in adding and t not in both]
    removed = [t for t in dict.fromkeys(removes) if t in removing and t not in both]
    return Change(label, added, removed)


def _created(change: Change, iri: URIRef) -> Change:
    change.created = iri
    return change


def _label_triples(ctx: Context, iri: URIRef, predicate: URIRef, lang: str) -> list:
    return [
        (iri, predicate, o)
        for o in ctx.graph.objects(iri, predicate)
        if isinstance(o, Literal) and o.language and o.language.lower() == lang.lower()
    ]


def cmd_create_class(ctx: Context, a: dict) -> Change:
    label = ctx.primary_label(a)
    iri = ctx.minted(a, label, lower_first=False)
    ctx.require_new(iri)
    adds = [(iri, RDF.type, OWL.Class), (iri, RDFS.label, Literal(label, lang=ctx.primary))]
    if a.get("parent"):
        parent = ctx.iri(a["parent"], "parent class")
        ctx.require(parent, "class")
        adds.append((iri, RDFS.subClassOf, parent))
    return _created(_change(ctx.graph, f"Created class {label}", adds), iri)


def cmd_create_object_property(ctx: Context, a: dict) -> Change:
    label = ctx.primary_label(a)
    iri = ctx.minted(a, label, lower_first=True)
    ctx.require_new(iri)
    adds = [(iri, RDF.type, OWL.ObjectProperty), (iri, RDFS.label, Literal(label, lang=ctx.primary))]
    for key, predicate in (("domain", RDFS.domain), ("range", RDFS.range)):
        if a.get(key):
            target = ctx.iri(a[key], key)
            ctx.require(target, "class")
            adds.append((iri, predicate, target))
    return _created(_change(ctx.graph, f"Created object property {label}", adds), iri)


def cmd_create_datatype_property(ctx: Context, a: dict) -> Change:
    label = ctx.primary_label(a)
    iri = ctx.minted(a, label, lower_first=True)
    ctx.require_new(iri)
    adds = [(iri, RDF.type, OWL.DatatypeProperty), (iri, RDFS.label, Literal(label, lang=ctx.primary))]
    if a.get("domain"):
        domain = ctx.iri(a["domain"], "domain")
        ctx.require(domain, "class")
        adds.append((iri, RDFS.domain, domain))
    if a.get("datatype"):
        datatype = ctx.iri(a["datatype"], "datatype")
        if not str(datatype).startswith(str(XSD)) and datatype != RDF.langString:
            raise CommandError(f"{ctx.short(datatype)} is not an XML Schema datatype.")
        adds.append((iri, RDFS.range, datatype))
    return _created(_change(ctx.graph, f"Created datatype property {label}", adds), iri)


def cmd_create_concept(ctx: Context, a: dict) -> Change:
    label = ctx.primary_label(a, "prefLabel")
    lang = a.get("lang") or ctx.primary
    if not lang_matches(lang, ctx.primary) and not lang_matches(ctx.primary, lang):
        raise CommandError(
            f"A new concept is named in the project's primary language ({ctx.primary}) first; "
            "add other languages with SetLabel."
        )
    iri = ctx.minted(a, label, lower_first=False)
    ctx.require_new(iri)
    adds = [(iri, RDF.type, SKOS.Concept), (iri, SKOS.prefLabel, Literal(label, lang=ctx.primary))]
    broader = None
    if a.get("broader"):
        broader = ctx.iri(a["broader"], "broader concept")
        ctx.require(broader, "concept")
        adds.append((iri, SKOS.broader, broader))
    if a.get("scheme"):
        scheme = ctx.iri(a["scheme"], "concept scheme")
        ctx.require(scheme, "concept scheme")
    else:
        # A new concept joins the scheme (relationships 5.8): its broader
        # concept's, or the document's own. A taxonomy has one; with several,
        # written in Turtle, the first by IRI, and none adds none.
        candidates = sorted(_schemes(ctx.graph, broader)) if broader is not None else []
        candidates = candidates or sorted(
            s for s in ctx.graph.subjects(RDF.type, SKOS.ConceptScheme) if isinstance(s, URIRef)
        )
        scheme = candidates[0] if candidates else None
    if scheme is not None:
        adds.append((iri, SKOS.inScheme, scheme))
        # A top concept exactly when nothing above it is in the scheme (D-091).
        if broader is None or not _in_scheme(ctx.graph, broader, scheme):
            adds.append((scheme, SKOS.hasTopConcept, iri))
    return _created(_change(ctx.graph, f"Created concept {label}", adds), iri)


def _set_text(ctx: Context, a: dict, predicate_for: Callable[[URIRef], URIRef], what: str) -> Change:
    iri = ctx.iri(a.get("iri"))
    if not ctx.mentioned(iri):
        raise CommandError(f"There is no {ctx.short(iri)} in this document to change.")
    value = a.get("value")
    if not isinstance(value, str) or not value.strip():
        raise CommandError(f"A {what} cannot be empty.")
    lang = a.get("lang") or ctx.primary
    if not valid_lang(lang):
        raise CommandError(f'"{lang}" is not a well-formed language tag (for example en or fr).')
    predicate = predicate_for(iri)
    old = _label_triples(ctx, iri, predicate, lang)
    change = _change(ctx.graph, "", [(iri, predicate, Literal(value.strip(), lang=lang))], old)
    change.label = f"Set {what} of {ctx.name(iri)} ({lang})"
    return change


def cmd_set_label(ctx: Context, a: dict) -> Change:
    # A concept's name is its skos:prefLabel; anything else is named by
    # rdfs:label. One prefLabel per language holds because this replaces.
    return _set_text(
        ctx,
        a,
        lambda iri: SKOS.prefLabel if (iri, RDF.type, SKOS.Concept) in ctx.graph else RDFS.label,
        "label",
    )


def cmd_set_comment(ctx: Context, a: dict) -> Change:
    return _set_text(ctx, a, lambda _iri: RDFS.comment, "comment")


def _annotation_target(ctx: Context, a: dict) -> tuple[URIRef, URIRef]:
    iri = ctx.iri(a.get("iri"))
    if not ctx.mentioned(iri):
        raise CommandError(f"There is no {ctx.short(iri)} in this document to annotate.")
    prop = ctx.iri(a.get("property"), "annotation property")
    return iri, prop


def _check_pref_label(ctx: Context, iri: URIRef, prop: URIRef, term, ignoring=None) -> None:
    if prop != SKOS.prefLabel or not isinstance(term, Literal):
        return
    lang = (term.language or "").lower()
    for existing in ctx.graph.objects(iri, SKOS.prefLabel):
        if existing == ignoring or not isinstance(existing, Literal):
            continue
        if (existing.language or "").lower() == lang:
            where = f"in {term.language}" if term.language else "without a language"
            raise CommandError(
                f"{ctx.name(iri)} already has a skos:prefLabel {where}; a concept has at most one "
                "per language. Use ReplaceAnnotation to change it."
            )


def cmd_add_annotation(ctx: Context, a: dict) -> Change:
    iri, prop = _annotation_target(ctx, a)
    term = parse_value(a.get("value"), ctx.primary, lambda v: ctx.iri(v, "link"))
    _check_pref_label(ctx, iri, prop, term)
    if (iri, prop, term) in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} already has that {ctx.short(prop)}.")
    return _change(ctx.graph, f"Added {ctx.short(prop)} to {ctx.name(iri)}", [(iri, prop, term)])


def _stored(ctx: Context, iri: URIRef, prop: URIRef, term):
    """The statement's object as the graph holds it.

    Turtle's `"1.0"` is a plain literal, which rdflib keeps apart from
    `"1.0"^^xsd:string` although RDF 1.1 says they are one value. The form
    sends every untagged text as xsd:string, so an existing plain literal is
    found under either spelling, or it could never be edited or removed.
    """
    if (iri, prop, term) not in ctx.graph and isinstance(term, Literal) and term.datatype == XSD.string:
        plain = Literal(str(term))
        if (iri, prop, plain) in ctx.graph:
            return plain
    return term


def cmd_remove_annotation(ctx: Context, a: dict) -> Change:
    iri, prop = _annotation_target(ctx, a)
    term = parse_value(a.get("value"), ctx.primary, lambda v: ctx.iri(v, "link"))
    term = _stored(ctx, iri, prop, term)
    if (iri, prop, term) not in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} has no such {ctx.short(prop)} to remove.")
    return _change(ctx.graph, f"Removed {ctx.short(prop)} from {ctx.name(iri)}", removes=[(iri, prop, term)])


def cmd_replace_annotation(ctx: Context, a: dict) -> Change:
    iri, prop = _annotation_target(ctx, a)
    resolve = lambda v: ctx.iri(v, "link")  # noqa: E731
    old = _stored(ctx, iri, prop, parse_value(a.get("oldValue"), ctx.primary, resolve))
    new = parse_value(a.get("newValue"), ctx.primary, resolve)
    if (iri, prop, old) not in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} has no such {ctx.short(prop)} to replace.")
    _check_pref_label(ctx, iri, prop, new, ignoring=old)
    return _change(
        ctx.graph, f"Changed {ctx.short(prop)} of {ctx.name(iri)}", [(iri, prop, new)], [(iri, prop, old)]
    )


def cmd_create_annotation_property(ctx: Context, a: dict) -> Change:
    label = a.get("label")
    if not a.get("iri") and not (isinstance(label, str) and label.strip()):
        raise CommandError("A new annotation property needs a name or an IRI.")
    iri = ctx.minted(a, (label or "").strip(), lower_first=True)
    ctx.require_new(iri)
    adds = [(iri, RDF.type, OWL.AnnotationProperty)]
    if isinstance(label, str) and label.strip():
        adds.append((iri, RDFS.label, Literal(label.strip(), lang=ctx.primary)))
    rng = range_for_value_type(a.get("valueType"))
    if rng is not None:
        adds.append((iri, RDFS.range, rng))
    return _created(
        _change(ctx.graph, f"Created annotation property {(label or '').strip() or ctx.short(iri)}", adds),
        iri,
    )


def _pair(ctx: Context, a: dict, first: str, second: str, what: str) -> tuple[URIRef, URIRef]:
    x = ctx.iri(a.get(first), first)
    y = ctx.iri(a.get(second), second)
    if not ctx.mentioned(x):
        raise CommandError(f"There is no {what} {ctx.short(x)} in this document.")
    ctx.require(y, what)
    if x == y:
        raise CommandError(f"A {what} cannot be linked to itself.")
    return x, y


def cmd_add_subclass(ctx: Context, a: dict) -> Change:
    child, parent = _pair(ctx, a, "child", "parent", "class")
    if (child, RDFS.subClassOf, parent) in ctx.graph:
        raise CommandError(f"{ctx.name(child)} is already a subclass of {ctx.name(parent)}.")
    return _change(
        ctx.graph, f"Made {ctx.name(child)} a subclass of {ctx.name(parent)}",
        [(child, RDFS.subClassOf, parent)],
    )


def cmd_remove_subclass(ctx: Context, a: dict) -> Change:
    child, parent = _pair(ctx, a, "child", "parent", "class")
    if (child, RDFS.subClassOf, parent) not in ctx.graph:
        raise CommandError(f"{ctx.name(child)} is not a subclass of {ctx.name(parent)}.")
    return _change(
        ctx.graph, f"Removed {ctx.name(child)} as a subclass of {ctx.name(parent)}",
        removes=[(child, RDFS.subClassOf, parent)],
    )


def _set_single(ctx: Context, a: dict, predicate: URIRef, what: str) -> Change:
    prop = ctx.iri(a.get("property"), "property")
    if not ctx.mentioned(prop):
        raise CommandError(f"There is no property {ctx.short(prop)} in this document.")
    target = ctx.iri(a.get("target"), what)
    ctx.require(target, what)
    old = [(prop, predicate, o) for o in ctx.graph.objects(prop, predicate)]
    return _change(
        ctx.graph, f"Set {what} of {ctx.name(prop)} to {ctx.name(target)}",
        [(prop, predicate, target)], old,
    )


def cmd_set_domain(ctx: Context, a: dict) -> Change:
    return _set_single(ctx, a, RDFS.domain, "domain")


def cmd_set_range(ctx: Context, a: dict) -> Change:
    return _set_single(ctx, a, RDFS.range, "range")


def _relationship(ctx: Context, a: dict) -> URIRef:
    prop = ctx.iri(a.get("property"), "relationship")
    if not ctx.mentioned(prop):
        raise CommandError(f"There is no relationship {ctx.short(prop)} in this document.")
    if (prop, RDF.type, OWL.DatatypeProperty) in ctx.graph:
        raise CommandError(
            f"{ctx.name(prop)} is an attribute: its range is a type of value, not a class at the other end."
        )
    if (prop, RDF.type, OWL.ObjectProperty) not in ctx.graph:
        raise CommandError(f"{ctx.name(prop)} is not a relationship of this document.")
    return prop


def cmd_swap_ends(ctx: Context, a: dict) -> Change:
    """Domain and range exchanged, as one undo step (relationships 5.6, 8).

    Every domain becomes a range and every range a domain, so a relationship
    with one end set keeps that end at the other side.
    """
    prop = _relationship(ctx, a)
    domains = [o for o in ctx.graph.objects(prop, RDFS.domain)]
    ranges = [o for o in ctx.graph.objects(prop, RDFS.range)]
    if not domains and not ranges:
        raise CommandError(f"{ctx.name(prop)} has no start or end to swap yet.")
    if set(domains) == set(ranges):
        # Person knows Person: the refusal says why, not only that nothing changed.
        raise CommandError(f"{ctx.name(prop)} starts and ends at the same class, so swapping changes nothing.")
    removes = [(prop, RDFS.domain, d) for d in domains] + [(prop, RDFS.range, r) for r in ranges]
    adds = [(prop, RDFS.range, d) for d in domains] + [(prop, RDFS.domain, r) for r in ranges]
    return _change(ctx.graph, f"Swapped the ends of {ctx.name(prop)}", adds, removes)


def cmd_set_ends(ctx: Context, a: dict) -> Change:
    """A relationship's domain and range set together, as one undo step: a
    line drawn to complete an existing relationship sets both at once (the
    E-7 note, relationships R6). Either may be left out; each replaces."""
    prop = _relationship(ctx, a)
    if not a.get("domain") and not a.get("range"):
        raise CommandError("Say which end to set: a domain, a range, or both.")
    adds, removes, parts = [], [], []
    for key, predicate, word in (("domain", RDFS.domain, "from"), ("range", RDFS.range, "to")):
        if not a.get(key):
            continue
        target = ctx.iri(a[key], key)
        ctx.require(target, "class")
        removes += [(prop, predicate, o) for o in ctx.graph.objects(prop, predicate)]
        adds.append((prop, predicate, target))
        parts.append(f"{word} {ctx.name(target)}")
    return _change(ctx.graph, f"Set the ends of {ctx.name(prop)}: {' '.join(parts)}", adds, removes)


# --- relationship Stage B: ends, inverse, characteristics, parent (5.6, 5.7) ------------


def _property(ctx: Context, a: dict, key: str = "property") -> URIRef:
    """A relationship or an attribute defined in this document."""
    prop = ctx.iri(a.get(key), "property")
    types = set(ctx.graph.objects(prop, RDF.type))
    if not types & {OWL.ObjectProperty, OWL.DatatypeProperty}:
        raise CommandError(f"{ctx.short(prop)} is not a relationship or an attribute of this document.")
    return prop


def _clear_end(ctx: Context, a: dict, predicate: URIRef, word: str) -> Change:
    prop = _property(ctx, a)
    removes = [(prop, predicate, o) for o in ctx.graph.objects(prop, predicate)]
    if not removes:
        raise CommandError(f"{ctx.name(prop)} has no {word} to clear.")
    return _change(ctx.graph, f"Cleared the {word} of {ctx.name(prop)}", removes=removes)


def cmd_clear_domain(ctx: Context, a: dict) -> Change:
    return _clear_end(ctx, a, RDFS.domain, "start")


def cmd_clear_range(ctx: Context, a: dict) -> Change:
    return _clear_end(ctx, a, RDFS.range, "end")


def _inverse_triples(ctx: Context, prop: URIRef) -> list:
    """Every statement that says `prop` has an inverse, read either way."""
    g = ctx.graph
    return [(prop, OWL.inverseOf, o) for o in g.objects(prop, OWL.inverseOf)] + [
        (s, OWL.inverseOf, prop) for s in g.subjects(OWL.inverseOf, prop)
    ]


def cmd_set_inverse(ctx: Context, a: dict) -> Change:
    """The other way round (5.6): an existing relationship, or a new one made
    from a name with this one's ends swapped, as one undo step. Any inverse
    it had is replaced, and a relationship picked leaves the one it was the
    other way round of, so each has one (found in review: picking one that
    already had an inverse gave it two).
    """
    prop = _relationship(ctx, a)
    removes = _inverse_triples(ctx, prop)
    adds: list = []
    created = None
    if a.get("inverse"):
        inverse = ctx.iri(a["inverse"], "relationship")
        refusal = modeling_checks.own_inverse_refusal(prop, inverse, ctx.name(prop))
        if refusal:
            raise CommandError(refusal)
        ctx.require(inverse, "relationship")
        kinds = set(ctx.graph.objects(inverse, RDF.type))
        if ctx.imported is not None:
            kinds |= set(ctx.imported.objects(inverse, RDF.type))
        if OWL.DatatypeProperty in kinds or (kinds and OWL.ObjectProperty not in kinds):
            raise CommandError(f"{ctx.name(inverse)} is not a relationship, so it cannot be the other way round.")
        if (inverse, OWL.inverseOf, prop) in ctx.graph or (prop, OWL.inverseOf, inverse) in ctx.graph:
            raise CommandError(f"{ctx.name(inverse)} is already the other way round of {ctx.name(prop)}.")
        # The other way round of a chaining relationship is not simple either
        # (5.9). One made from a name has no characteristics, so it is fine.
        refusal = modeling_checks.inverse_chaining_refusal(ctx.graph, prop, inverse, ctx.name)
        if refusal:
            raise CommandError(refusal)
        removes += _inverse_triples(ctx, inverse)
        adds.append((inverse, OWL.inverseOf, prop))
        target_name = ctx.name(inverse)
    else:
        label = ctx.primary_label(a)
        inverse = ctx.minted(a, label, lower_first=True)
        ctx.require_new(inverse)
        adds += [
            (inverse, RDF.type, OWL.ObjectProperty),
            (inverse, RDFS.label, Literal(label, lang=ctx.primary)),
            (inverse, OWL.inverseOf, prop),
        ]
        # Swapped ends: *An Organization employs a Person*.
        adds += [(inverse, RDFS.domain, r) for r in ctx.graph.objects(prop, RDFS.range)]
        adds += [(inverse, RDFS.range, d) for d in ctx.graph.objects(prop, RDFS.domain)]
        created = inverse
        target_name = label
    change = _change(ctx.graph, f"Made {target_name} the other way round of {ctx.name(prop)}", adds, removes)
    change.created = created
    return change


def cmd_clear_inverse(ctx: Context, a: dict) -> Change:
    """Every other way round, or with `inverse` only that one: Turtle can give
    a relationship two, and Remove on one row must not take both (review)."""
    prop = _relationship(ctx, a)
    removes = _inverse_triples(ctx, prop)
    if a.get("inverse"):
        other = ctx.iri(a["inverse"], "relationship")
        removes = [t for t in removes if other in (t[0], t[2])]
    if not removes:
        raise CommandError(f"{ctx.name(prop)} has no other way round to remove.")
    return _change(ctx.graph, f"Removed the other way round of {ctx.name(prop)}", removes=removes)


def cmd_set_characteristic(ctx: Context, a: dict) -> Change:
    """One of the seven characteristics on or off (5.6); an attribute takes
    only *one value only* (5.7). A contradiction is refused (5.9)."""
    prop = _property(ctx, a)
    name = a.get("characteristic")
    if name not in modeling_checks.CHARACTERISTICS:
        offered = ", ".join(modeling_checks.CHARACTERISTICS)
        raise CommandError(f"The characteristic is one of {offered}.")
    on = a.get("on")
    if not isinstance(on, bool):
        raise CommandError("Say whether the characteristic is on or off.")
    if (prop, RDF.type, OWL.DatatypeProperty) in ctx.graph and name != "functional":
        raise CommandError(
            f'{ctx.name(prop)} is an attribute; an attribute can only be "one value only". '
            "The others describe links between things."
        )
    refusal = modeling_checks.characteristic_refusal(ctx.graph, prop, name, on, ctx.name)
    if refusal:
        raise CommandError(refusal)
    triple = (prop, RDF.type, modeling_checks.CHARACTERISTICS[name])
    attribute = (prop, RDF.type, OWL.DatatypeProperty) in ctx.graph
    words = "one value only" if attribute else modeling_checks.WORDS[name]
    if on:
        if triple in ctx.graph:
            raise CommandError(f'{ctx.name(prop)} is already "{words}".')
        return _change(ctx.graph, f'Marked {ctx.name(prop)} as "{words}"', [triple])
    if triple not in ctx.graph:
        raise CommandError(f'{ctx.name(prop)} is not "{words}".')
    return _change(ctx.graph, f'Unmarked {ctx.name(prop)} as "{words}"', removes=[triple])


def _property_kind(ctx: Context, iri: URIRef) -> Optional[URIRef]:
    kinds = set(ctx.graph.objects(iri, RDF.type))
    if ctx.imported is not None:
        kinds |= set(ctx.imported.objects(iri, RDF.type))
    for kind in (OWL.ObjectProperty, OWL.DatatypeProperty):
        if kind in kinds:
            return kind
    return None


def _sub_pair(ctx: Context, a: dict) -> tuple[URIRef, URIRef]:
    child = _property(ctx, a, "child")
    parent = ctx.iri(a.get("parent"), "parent")
    ctx.require(parent, "relationship")
    if _property_kind(ctx, parent) != _property_kind(ctx, child):
        word = "relationship" if (child, RDF.type, OWL.ObjectProperty) in ctx.graph else "attribute"
        raise CommandError(
            f"{ctx.name(child)} is {'a' if word == 'relationship' else 'an'} {word}; "
            f"its more general one must be {'a' if word == 'relationship' else 'an'} {word} too."
        )
    return child, parent


def cmd_add_subproperty(ctx: Context, a: dict) -> Change:
    child, parent = _sub_pair(ctx, a)
    refusal = modeling_checks.subproperty_loop_refusal(ctx.graph, child, parent, ctx.name)
    # A chaining relationship under one that must stay simple (5.9).
    refusal = refusal or modeling_checks.subproperty_chaining_refusal(ctx.graph, child, parent, ctx.name)
    if refusal:
        raise CommandError(refusal)
    if (child, RDFS.subPropertyOf, parent) in ctx.graph:
        raise CommandError(f"{ctx.name(child)} is already a more specific kind of {ctx.name(parent)}.")
    return _change(
        ctx.graph, f"Made {ctx.name(child)} a more specific kind of {ctx.name(parent)}",
        [(child, RDFS.subPropertyOf, parent)],
    )


def cmd_remove_subproperty(ctx: Context, a: dict) -> Change:
    child = _property(ctx, a, "child")
    parent = ctx.iri(a.get("parent"), "parent")
    if (child, RDFS.subPropertyOf, parent) not in ctx.graph:
        raise CommandError(f"{ctx.name(child)} is not a more specific kind of {ctx.name(parent)}.")
    return _change(
        ctx.graph, f"Removed {ctx.name(parent)} as more general than {ctx.name(child)}",
        removes=[(child, RDFS.subPropertyOf, parent)],
    )


# --- concepts: broader, related, mappings, and top concepts kept right (5.8, D-091) -----


def _in_scheme(g: Graph, concept, scheme) -> bool:
    return (
        (concept, SKOS.inScheme, scheme) in g
        or (concept, SKOS.topConceptOf, scheme) in g
        or (scheme, SKOS.hasTopConcept, concept) in g
    )


def _schemes(g: Graph, concept) -> set:
    return (
        set(g.objects(concept, SKOS.inScheme))
        | set(g.objects(concept, SKOS.topConceptOf))
        | set(g.subjects(SKOS.hasTopConcept, concept))
    )


def _broaders(g: Graph, concept) -> set:
    return set(g.objects(concept, SKOS.broader)) | set(g.subjects(SKOS.narrower, concept))


def _top_delta(g: Graph, concept, broaders_after: set) -> tuple[list, list]:
    """What keeps `concept` a top concept exactly where it should be, once its
    broader concepts are `broaders_after` (D-091): in each of its schemes it
    is a top concept when none of those is in the same scheme."""
    adds, removes = [], []
    for scheme in _schemes(g, concept):
        under = any(_in_scheme(g, b, scheme) for b in broaders_after)
        marked = [
            t for t in ((scheme, SKOS.hasTopConcept, concept), (concept, SKOS.topConceptOf, scheme)) if t in g
        ]
        if under:
            removes += marked
        elif not marked:
            adds.append((scheme, SKOS.hasTopConcept, concept))
    return adds, removes


def cmd_add_broader(ctx: Context, a: dict) -> Change:
    concept = ctx.iri(a.get("concept"), "concept")
    broader = ctx.iri(a.get("broader"), "broader")
    # A loop is named as one, whether it is one step or many (5.9).
    refusal = modeling_checks.broader_loop_refusal(ctx.graph, concept, broader, ctx.name)
    refusal = refusal or modeling_checks.broader_related_refusal(ctx.graph, concept, broader, ctx.name)
    if refusal:
        raise CommandError(refusal)
    concept, broader = _pair(ctx, a, "concept", "broader", "concept")
    if (concept, SKOS.broader, broader) in ctx.graph:
        raise CommandError(f"{ctx.name(concept)} is already narrower than {ctx.name(broader)}.")
    adds, removes = _top_delta(ctx.graph, concept, _broaders(ctx.graph, concept) | {broader})
    return _change(
        ctx.graph, f"Made {ctx.name(concept)} narrower than {ctx.name(broader)}",
        [(concept, SKOS.broader, broader), *adds], removes,
    )


def cmd_remove_broader(ctx: Context, a: dict) -> Change:
    concept, broader = _pair(ctx, a, "concept", "broader", "concept")
    removes = [(concept, SKOS.broader, broader), (broader, SKOS.narrower, concept)]
    if not any(t in ctx.graph for t in removes):
        raise CommandError(f"{ctx.name(concept)} is not narrower than {ctx.name(broader)}.")
    adds, top_removes = _top_delta(ctx.graph, concept, _broaders(ctx.graph, concept) - {broader})
    return _change(
        ctx.graph, f"Removed {ctx.name(broader)} as broader of {ctx.name(concept)}", adds, removes + top_removes
    )


def _concepts(ctx: Context, a: dict, first: str, second: str) -> tuple[URIRef, URIRef]:
    x, y = _pair(ctx, a, first, second, "concept")
    for c in (x, y):
        if (c, RDF.type, SKOS.Concept) not in ctx.graph and not (
            ctx.imported is not None and (c, RDF.type, SKOS.Concept) in ctx.imported
        ):
            raise CommandError(f"{ctx.name(c)} is not a concept.")
    return x, y


def cmd_add_related(ctx: Context, a: dict) -> Change:
    """*Related to*, written both ways, since SKOS defines it as symmetric (5.8)."""
    concept, related = _concepts(ctx, a, "concept", "related")
    refusal = modeling_checks.related_refusal(ctx.graph, concept, related, ctx.name)
    if refusal:
        raise CommandError(refusal)
    both = [(concept, SKOS.related, related), (related, SKOS.related, concept)]
    if all(t in ctx.graph for t in both):
        raise CommandError(f"{ctx.name(concept)} is already related to {ctx.name(related)}.")
    return _change(ctx.graph, f"Related {ctx.name(concept)} to {ctx.name(related)}", both)


def cmd_remove_related(ctx: Context, a: dict) -> Change:
    concept, related = _pair(ctx, a, "concept", "related", "concept")
    both = [(concept, SKOS.related, related), (related, SKOS.related, concept)]
    if not any(t in ctx.graph for t in both):
        raise CommandError(f"{ctx.name(concept)} is not related to {ctx.name(related)}.")
    return _change(ctx.graph, f"Removed {ctx.name(related)} as related to {ctx.name(concept)}", removes=both)


MAPPINGS = {
    "exactMatch": (SKOS.exactMatch, "an exact match"),
    "closeMatch": (SKOS.closeMatch, "a close match"),
    "broadMatch": (SKOS.broadMatch, "a broader match"),
    "narrowMatch": (SKOS.narrowMatch, "a narrower match"),
    "relatedMatch": (SKOS.relatedMatch, "a related match"),
}


def _mapping(ctx: Context, a: dict) -> tuple[URIRef, URIRef, URIRef, str]:
    concept = ctx.iri(a.get("concept"), "concept")
    if (concept, RDF.type, SKOS.Concept) not in ctx.graph:
        raise CommandError(f"There is no concept {ctx.short(concept)} in this document.")
    kind = a.get("kind")
    if kind not in MAPPINGS:
        raise CommandError(f"The mapping is one of {', '.join(MAPPINGS)}.")
    # A mapping points outside the project; the IRI is checked like any link.
    target = ctx.iri(a.get("target"), "mapping target")
    if target == concept:
        raise CommandError(f"{ctx.name(concept)} cannot be mapped to itself.")
    predicate, words = MAPPINGS[kind]
    return concept, predicate, target, words


def cmd_add_mapping(ctx: Context, a: dict) -> Change:
    concept, predicate, target, words = _mapping(ctx, a)
    if (concept, predicate, target) in ctx.graph:
        raise CommandError(f"{ctx.name(concept)} already has that mapping.")
    return _change(
        ctx.graph, f"Added {words} of {ctx.name(concept)}: {target}", [(concept, predicate, target)]
    )


def cmd_remove_mapping(ctx: Context, a: dict) -> Change:
    concept, predicate, target, words = _mapping(ctx, a)
    if (concept, predicate, target) not in ctx.graph:
        raise CommandError(f"{ctx.name(concept)} has no such mapping to remove.")
    return _change(
        ctx.graph, f"Removed {words} of {ctx.name(concept)}: {target}",
        removes=[(concept, predicate, target)],
    )


def cmd_rename_iri(ctx: Context, a: dict) -> Change:
    old = ctx.iri(a.get("old"), "IRI to rename")
    new = ctx.iri(a.get("new"), "new IRI")
    if not ctx.mentioned(old):
        raise CommandError(f"There is no {ctx.short(old)} in this document to rename.")
    if old == new:
        raise CommandError("The new IRI is the same as the old one.")
    ctx.require_new(new)
    swap = lambda term: new if term == old else term  # noqa: E731
    touched = set(ctx.graph.triples((old, None, None)))
    touched |= set(ctx.graph.triples((None, old, None)))
    touched |= set(ctx.graph.triples((None, None, old)))
    adds = [(swap(s), swap(p), swap(o)) for s, p, o in touched]
    change = _created(_change(ctx.graph, f"Renamed {ctx.short(old)} to {ctx.short(new)}", adds, touched), new)
    change.renamed = (str(old), str(new))
    return change


# --- delete, with its impact summary (5.5) -----------------------------------

_HIERARCHY = {
    "class": (RDFS.subClassOf, None),
    "concept": (SKOS.broader, SKOS.narrower),
    "object property": (RDFS.subPropertyOf, None),
    "datatype property": (RDFS.subPropertyOf, None),
    "annotation property": (RDFS.subPropertyOf, None),
    "property": (RDFS.subPropertyOf, None),
}


def _bnode_closure(graph: Graph, roots: Iterable, removing: set) -> set:
    """Blank nodes only the removed statements reached, and their triples.

    Deleting a class must take its restrictions with it; leaving
    `[ a owl:Restriction ... ]` behind with nothing pointing at it would be
    debris the user cannot see or select.
    """
    extra: set = set()
    queue = [b for b in roots if isinstance(b, BNode)]
    seen = set()
    while queue:
        node = queue.pop()
        if node in seen:
            continue
        seen.add(node)
        referrers = set(graph.triples((None, None, node)))
        if referrers - removing - extra:
            continue  # something else still points here; keep it
        for t in graph.triples((node, None, None)):
            extra.add(t)
            if isinstance(t[2], BNode):
                queue.append(t[2])
    return extra


def _expressions_mentioning(graph: Graph, iri: URIRef) -> set:
    """Every anonymous expression that mentions the entity, whole.

    `:Order rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLine ;
    owl:someValuesFrom :Invoice ]`: deleting :Invoice must take the whole
    restriction and the statement pointing at it, or a restriction with no
    filler is left behind. So from each blank node that mentions the entity
    the walk goes up to the first named node (through list cells and nested
    expressions alike), taking every statement on the way and each blank
    node's whole description below.
    """
    extra: set = set()
    queue = [s for s, _, _ in graph.triples((None, None, iri)) if isinstance(s, BNode)]
    queue += [s for s, _, _ in graph.triples((None, iri, None)) if isinstance(s, BNode)]
    seen: set = set()
    while queue:
        node = queue.pop()
        if node in seen:
            continue
        seen.add(node)
        for t in graph.triples((None, None, node)):
            extra.add(t)
            if isinstance(t[0], BNode):
                queue.append(t[0])
        below = [node]
        while below:
            current = below.pop()
            for t in graph.triples((current, None, None)):
                if t not in extra:
                    extra.add(t)
                    if isinstance(t[2], BNode):
                        below.append(t[2])
    return extra


def delete_plan(ctx: Context, a: dict) -> tuple[Change, dict]:
    iri = ctx.iri(a.get("iri"), "entity")
    if not ctx.mentioned(iri):
        raise CommandError(f"There is no {ctx.short(iri)} in this document to delete.")
    strategy = a.get("strategy") or "reparent"
    if strategy not in ("reparent", "orphan"):
        raise CommandError("The strategy is reparent (children move up) or orphan.")
    g = ctx.graph
    kind = ctx.kind(iri)

    removing = set(g.triples((iri, None, None)))
    removing |= set(g.triples((None, iri, None)))
    removing |= set(g.triples((None, None, iri)))
    removing |= _bnode_closure(g, [o for _, _, o in g.triples((iri, None, None))], removing)
    removing |= _expressions_mentioning(g, iri)

    children: list[URIRef] = []
    parents: list[URIRef] = []
    relation = _HIERARCHY.get(kind)
    adds = []
    if relation:
        up, down = relation
        children = sorted({s for s in g.subjects(up, iri) if isinstance(s, URIRef)})
        parents = sorted({o for o in g.objects(iri, up) if isinstance(o, URIRef)})
        if down is not None:
            children = sorted(set(children) | {o for o in g.objects(iri, down) if isinstance(o, URIRef)})
            parents = sorted(set(parents) | {s for s in g.subjects(down, iri) if isinstance(s, URIRef)})
        if strategy == "reparent":
            adds = [(child, up, parent) for child in children for parent in parents if child != parent]
        if kind == "concept":
            # A narrower concept left with nothing above it in its scheme is a
            # top concept now; the commands keep that, not the user (D-091).
            moved_to = set(parents) if strategy == "reparent" else set()
            for child in children:
                top_adds, top_removes = _top_delta(g, child, (_broaders(g, child) - {iri}) | moved_to)
                adds += top_adds
                removing |= set(top_removes)

    ref = lambda node: {"iri": str(node), "label": ctx.name(node)}  # noqa: E731
    properties = [
        # The kind lets the dialog say "relationship" for an object property
        # and "attribute" for a datatype one, as 5.3 words it.
        {**ref(p), "role": "domain" if pred == RDFS.domain else "range", "kind": ctx.kind(p)}
        for p, pred in sorted(
            {(s, p) for s, p in g.subject_predicates(iri) if p in (RDFS.domain, RDFS.range)},
        )
        if isinstance(p, URIRef)
    ]
    individuals = sorted(
        s for s in g.subjects(RDF.type, iri)
        if isinstance(s, URIRef) and ctx.kind(s) in ("entity", "example")
    )
    import_mentions = 0
    if ctx.imported is not None:
        own = set()
        for graph in getattr(ctx.imported, "graphs", [])[1:]:
            own |= set(graph.triples((iri, None, None))) | set(graph.triples((None, None, iri)))
        import_mentions = len(own)

    impact = {
        "iri": str(iri),
        "label": ctx.name(iri),
        "kind": kind,
        "statements": len(removing),
        "strategy": strategy,
        "children": [ref(c) for c in children],
        "reparentedTo": [ref(p) for p in parents] if strategy == "reparent" else [],
        "properties": properties,
        "individuals": [ref(i) for i in individuals],
        "importMentions": import_mentions,
    }
    change = _change(g, f"Deleted {kind} {ctx.name(iri)}", adds, removing)
    return change, impact


def cmd_delete_entity(ctx: Context, a: dict) -> Change:
    return delete_plan(ctx, a)[0]


# --- examples, so a shape has something to check (shacl-authoring 5.8) ---------


def _model_doc(ctx: Context) -> None:
    if ctx.doc != "model":
        raise CommandError("Examples live in model.ttl; run example commands on the model document.")


def _class_graph(ctx: Context) -> Graph:
    """Where a class may be defined: the imports' merged view when there is
    one (it carries the document), else the document."""
    return ctx.imported if ctx.imported is not None else ctx.graph


def cmd_create_example(ctx: Context, a: dict) -> Change:
    """An individual of a class, named in the primary language (5.8). Typed
    owl:NamedIndividual as well, so every view knows it for an example."""
    _model_doc(ctx)
    cls = ctx.iri(a.get("class"), "class")
    if not examples.is_class(_class_graph(ctx), cls):
        raise CommandError(f"{ctx.short(cls)} is not a class of this model; an example belongs to a class.")
    label = ctx.primary_label(a)
    iri = ctx.minted(a, label, lower_first=True)
    ctx.require_new(iri)
    adds = [
        (iri, RDF.type, cls),
        (iri, RDF.type, OWL.NamedIndividual),
        (iri, RDFS.label, Literal(label, lang=ctx.primary)),
    ]
    return _created(
        _change(ctx.graph, f"Created example {label} of {pick_label_in(_class_graph(ctx), cls, ctx.languages)[0]}", adds),
        iri,
    )


# A type of value as the learner reads it, the rule editor's words.
_VALUE_WORDS = {
    "string": "text",
    "integer": "a whole number",
    "decimal": "a number",
    "boolean": "true or false",
    "date": "a date",
    "dateTime": "a date and time",
    "anyURI": "a web address",
}


def _example_field(ctx: Context, a: dict) -> tuple[URIRef, URIRef, str, str]:
    """The example and the attribute or relationship a command names, with
    the field's name and which of the two it is."""
    _model_doc(ctx)
    iri = ctx.iri(a.get("iri"), "example")
    if not examples.is_example(_class_graph(ctx), iri) or not ctx.mentioned(iri):
        raise CommandError(f"There is no example {ctx.short(iri)} in this document.")
    prop = ctx.iri(a.get("property"), "attribute or relationship")
    classes = _class_graph(ctx)
    types = set(classes.objects(prop, RDF.type))
    what = ("relationship" if OWL.ObjectProperty in types
            else "attribute" if OWL.DatatypeProperty in types else None)
    if what is None:
        raise CommandError(f"{ctx.short(prop)} is not an attribute or a relationship of this model.")
    return iri, prop, pick_label_in(classes, prop, ctx.languages)[0], what


def _example_value(ctx: Context, a: dict, key: str = "value") -> tuple[URIRef, URIRef, object, str]:
    """The example, the attribute or relationship, and the value as a term,
    checked as E-6 checks an annotation: an attribute's value against its
    type of value, a relationship's against an entity that exists."""
    iri, prop, name, what = _example_field(ctx, a)
    classes = _class_graph(ctx)
    spec = a.get(key)
    if what == "relationship":
        if not isinstance(spec, dict) or spec.get("kind") != "link":
            raise CommandError(f"A value of {name} is another example, by its IRI.")
        term = parse_value(spec, ctx.primary, lambda v: ctx.iri(v, "example"))
        ctx.require(term, "example")
        # Only an individual of the end class, or of a class below it: the
        # picker offers no other, and a request that names one is refused
        # here too (PR #51 review). No end class, no check.
        end = classes.value(prop, RDFS.range)
        if isinstance(end, URIRef) and not set(classes.objects(term, RDF.type)) & examples.subclasses(classes, end):
            target = pick_label_in(classes, term, ctx.languages)[0]
            kind = pick_label_in(classes, end, ctx.languages)[0]
            article = "an" if kind[:1].lower() in "aeiou" else "a"
            raise CommandError(f"{target} is not {article} {kind}; {name} links only to {article} {kind}.")
        return iri, prop, term, name
    rng = classes.value(prop, RDFS.range)
    if isinstance(rng, URIRef) and rng not in _DATATYPE_BY_IRI and rng != RDF.langString and rng != RDFS.Literal:
        # A type outside the seven offered (xsd:float, xsd:gYear from an
        # import): the value is sent typed with that type, never as text in
        # a language, and checked where rdflib knows the type (PR #51 review).
        if not isinstance(spec, dict) or spec.get("kind") != "typed" or not isinstance(spec.get("value"), str):
            raise CommandError(f"{name} is a value of type {ctx.short(rng)}; give a value of that type.")
        if ctx.iri(spec.get("datatype") or "", "datatype") != rng:
            raise CommandError(f"{name} is a value of type {ctx.short(rng)}; give a value of that type.")
        term = Literal(spec["value"].strip(), datatype=rng)
        if not spec["value"].strip() or term.ill_typed:
            raise CommandError(f'"{spec["value"]}" is not a valid {ctx.short(rng)}.')
        return iri, prop, term, name
    term = parse_value(spec, ctx.primary, lambda v: ctx.iri(v, "link"))
    if rng in _DATATYPE_BY_IRI and rng != XSD.string:
        # A typed attribute takes a value of its type, checked lexically: the
        # form says so before sending (S22), and this says it again.
        if not isinstance(term, Literal) or term.datatype != rng:
            raise CommandError(f"{name} is {_VALUE_WORDS[_DATATYPE_BY_IRI[rng]]}; give a value of that type.")
    elif rng == RDF.langString and not (isinstance(term, Literal) and term.language):
        raise CommandError(f"{name} is text in a language; give the text with its language.")
    elif not isinstance(term, Literal):
        raise CommandError(f"{name} is an attribute; its value is text or a typed value, not a link.")
    return iri, prop, term, name


def _linked(ctx: Context, iri: URIRef, term, name: str) -> str:
    """A link as the undo list reads it: *Bob to Acme by member of*."""
    return f"{ctx.name(iri)} to {pick_label_in(_class_graph(ctx), term, ctx.languages)[0]} by {name}"


def cmd_set_example_value(ctx: Context, a: dict) -> Change:
    """The one value of an attribute or relationship, replacing any others:
    what a single field sets (5.8)."""
    iri, prop, term, name = _example_value(ctx, a)
    old = [(iri, prop, o) for o in ctx.graph.objects(iri, prop)]
    label = f"Linked {_linked(ctx, iri, term, name)}" if isinstance(term, URIRef) else f"Set {name} of {ctx.name(iri)}"
    return _change(ctx.graph, label, [(iri, prop, term)], old)


def cmd_add_example_value(ctx: Context, a: dict) -> Change:
    iri, prop, term, name = _example_value(ctx, a)
    if (iri, prop, _stored(ctx, iri, prop, term)) in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} already has that {name}.")
    label = f"Linked {_linked(ctx, iri, term, name)}" if isinstance(term, URIRef) else f"Added {name} to {ctx.name(iri)}"
    return _change(ctx.graph, label, [(iri, prop, term)])


def _stored_value(ctx: Context, spec):
    """A value as the document holds it, judged by nothing but that. A value
    of the wrong type, of a type the form does not offer, or a text under a
    relationship -- written in Turtle -- is what a shape exists to flag, and
    the form must be able to take it away (found in review)."""
    if not isinstance(spec, dict) or not isinstance(spec.get("value"), str):
        raise CommandError("A value needs its kind and its text.")
    raw, kind = spec["value"], spec.get("kind")
    if kind == "link":
        return ctx.iri(raw, "value")
    if kind == "text":
        return Literal(raw, lang=spec.get("lang") or ctx.primary)
    if kind == "typed":
        datatype = spec.get("datatype") or "xsd:string"
        return Literal(raw, datatype=ctx.iri(datatype, "datatype"))
    raise CommandError("A value's kind is text, typed or link.")


def cmd_remove_example_value(ctx: Context, a: dict) -> Change:
    iri, prop, name, _ = _example_field(ctx, a)
    term = _stored(ctx, iri, prop, _stored_value(ctx, a.get("value")))
    if (iri, prop, term) not in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} has no such {name} to remove.")
    label = (f"Removed the link from {_linked(ctx, iri, term, name)}" if isinstance(term, URIRef)
             else f"Removed {name} from {ctx.name(iri)}")
    return _change(ctx.graph, label, removes=[(iri, prop, term)])


# --- SHACL shapes, one shape and one rule at a time (shacl-authoring 5.2, 5.3, D-093) ----

SH = shapes_form.SH
SEVERITY_TERMS = {"violation": SH.Violation, "warning": SH.Warning}
_COUNTS = ("minCount", "maxCount", "minLength", "maxLength")


def _shapes_ctx(ctx: Context) -> None:
    if ctx.doc != "shapes":
        raise CommandError("Shapes live in shapes.ttl; run shape commands on the shapes document.")


def _model_name(ctx: Context, iri) -> str:
    return pick_label_in(ctx.model, iri, ctx.languages)[0]


def _closure(g: Graph, root) -> set:
    """Every triple reachable from a blank node through blank-node objects:
    one rule's property shape with its lists and qualified shapes."""
    found: set = set()
    queue = [root]
    seen = set()
    while queue:
        node = queue.pop()
        if node in seen or not isinstance(node, BNode):
            continue
        seen.add(node)
        for t in g.triples((node, None, None)):
            found.add(t)
            queue.append(t[2])
    return found


def _shape(ctx: Context, a: dict, editable: bool = True):
    """The shape a command names, refused when the form cannot edit it (5.5)."""
    _shapes_ctx(ctx)
    node = shapes_form.find_shape(ctx.graph, a.get("shape"))
    if node is None:
        raise CommandError("There is no such shape in shapes.ttl.")
    if editable:
        shape = shapes_form.read_shape(ctx.graph, node, ctx.model, lambda i: _model_name(ctx, i), ctx.languages)
        if not shape["editable"]:
            raise CommandError(
                f"{shape['name']} is written in Turtle with parts the form cannot edit "
                f"({'; '.join(shape['unsupported'])}). Change it in the Turtle editor."
            )
    return node


def _shape_label(ctx: Context, node) -> str:
    label = ctx.graph.value(node, RDFS.label)
    return str(label) if label is not None else ctx.short(node) if isinstance(node, URIRef) else "the shape"


def _rdf_list(items: list) -> tuple:
    """An RDF list's head and its triples, on fresh blank nodes."""
    if not items:
        return RDF.nil, []
    cells = [BNode() for _ in items]
    triples = []
    for i, (cell, item) in enumerate(zip(cells, items)):
        triples.append((cell, RDF.first, item))
        triples.append((cell, RDF.rest, cells[i + 1] if i + 1 < len(cells) else RDF.nil))
    return cells[0], triples


def _path_node(path: tuple) -> tuple:
    if len(path) == 1:
        return path[0], []
    head, triples = _rdf_list(list(path))
    node = BNode()
    return node, [(node, SH.alternativePath, head), *triples]


def _rule_path(ctx: Context, value) -> tuple:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        raise CommandError("A rule needs the attribute or relationship it is about.")
    return tuple(ctx.iri(v, "path") for v in value)


def _count(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CommandError(f"The {what} is a whole number, 0 or more.")
    return value


def _bound(value, what: str) -> Literal:
    if not isinstance(value, dict) or not isinstance(value.get("value"), str) or not value["value"].strip():
        raise CommandError(f"The {what} needs a value.")
    name = _datatype_name(value.get("datatype") or "decimal")
    if name not in ("integer", "decimal", "date", "dateTime"):
        raise CommandError(f"The {what} is a number or a date.")
    raw = value["value"].strip()
    check_lexical(raw, name)
    return Literal(raw, datatype=OFFERED_DATATYPES[name])


def _languages(value, what: str) -> list:
    if not isinstance(value, list) or not value:
        raise CommandError(f"Choose at least one language for {what}.")
    out = []
    for tag in value:
        if not isinstance(tag, str) or not valid_lang(tag):
            raise CommandError(f'"{tag}" is not a well-formed language tag (for example en or fr).')
        if tag not in out:
            out.append(tag)
    return out


def _rule_triples(ctx: Context, node, rule, severity) -> tuple[tuple, list]:
    """One rule as SHACL (5.3): one property shape on the path with every
    kind chosen, and one more per language required (shapes_form)."""
    if not isinstance(rule, dict):
        raise CommandError("A rule is an object: the path and what is checked on it.")
    path = _rule_path(ctx, rule.get("path"))
    prop = BNode()
    path_node, triples = _path_node(path)
    body = [(prop, SH.path, path_node), *triples]
    counts = {key: _count(rule[key], key) for key in _COUNTS if rule.get(key) is not None}
    words = {"minCount": "at least", "maxCount": "at most"}
    if "minCount" in counts and "maxCount" in counts and counts["minCount"] > counts["maxCount"]:
        raise CommandError(
            f"{words['minCount'].capitalize()} {counts['minCount']} is more than "
            f"{words['maxCount']} {counts['maxCount']}; the rule could never be met."
        )
    if "minLength" in counts and "maxLength" in counts and counts["minLength"] > counts["maxLength"]:
        raise CommandError("The shortest length is longer than the longest; the rule could never be met.")
    for key in _COUNTS:
        if key in counts:
            body.append((prop, SH[key], Literal(counts[key], datatype=XSD.integer)))
    if rule.get("datatype"):
        value = rule["datatype"]
        datatype = RDF.langString if value in ("rdf:langString", str(RDF.langString)) else (
            OFFERED_DATATYPES[_datatype_name(value)])
        body.append((prop, SH.datatype, datatype))
    if rule.get("class"):
        cls = ctx.iri(rule["class"], "class")
        if not ((cls, None, None) in ctx.model or str(cls).startswith(tuple(WELL_KNOWN.values()))):
            raise CommandError(f"There is no class {ctx.short(cls)} in the model or its imports.")
        body.append((prop, SH["class"], cls))
    if rule.get("pattern"):
        pattern = rule["pattern"]
        if not isinstance(pattern, str):
            raise CommandError("A pattern is a regular expression.")
        try:
            re.compile(pattern)
        except re.error as exc:
            raise CommandError(f"The pattern is not a regular expression this tool can read: {exc}.") from exc
        body.append((prop, SH.pattern, Literal(pattern)))
    low = _bound(rule["minInclusive"], "minimum") if rule.get("minInclusive") else None
    high = _bound(rule["maxInclusive"], "maximum") if rule.get("maxInclusive") else None
    if low is not None and high is not None:
        try:
            if low.toPython() > high.toPython():
                raise CommandError("The minimum is above the maximum; the rule could never be met.")
        except TypeError:
            raise CommandError("The minimum and the maximum must be the same kind of value.") from None
    if low is not None:
        body.append((prop, SH.minInclusive, low))
    if high is not None:
        body.append((prop, SH.maxInclusive, high))
    if rule.get("in") is not None:
        values = rule["in"]
        if not isinstance(values, list) or not values:
            raise CommandError("List at least one allowed value.")
        terms = [parse_value(v, ctx.primary, lambda raw: ctx.iri(raw, "value")) for v in values]
        # sh:in compares terms exactly, and rdflib keeps Turtle's "active"
        # apart from "active"^^xsd:string though RDF 1.1 makes them one
        # value: a list of xsd:string refused every value typed in Turtle.
        # Written plain, as Turtle writes text.
        terms = [Literal(str(t)) if isinstance(t, Literal) and t.datatype == XSD.string else t for t in terms]
        head, cells = _rdf_list(list(dict.fromkeys(terms)))
        body += [(prop, SH["in"], head), *cells]
    if rule.get("languageIn") is not None:
        tags = _languages(rule["languageIn"], "the allowed languages")
        head, cells = _rdf_list([Literal(t) for t in tags])
        body += [(prop, SH.languageIn, head), *cells]
    if rule.get("uniqueLang"):
        body.append((prop, SH.uniqueLang, Literal(True)))
    extra: list = []
    if rule.get("requiredLanguages") is not None:
        for tag in _languages(rule["requiredLanguages"], "a name in each language"):
            q, inner = BNode(), BNode()
            q_path, q_triples = _path_node(path)
            head, cells = _rdf_list([Literal(tag)])
            extra += [
                (node, SH.property, q), (q, SH.path, q_path), *q_triples,
                (q, SH.qualifiedValueShape, inner), (inner, SH.languageIn, head), *cells,
                (q, SH.qualifiedMinCount, Literal(1, datatype=XSD.integer)),
            ]
            if severity is not None:
                extra.append((q, SH.severity, severity))
    if len(body) == 1 + len(triples) and not extra:
        raise CommandError("A rule needs at least one thing to check.")
    if len(body) > 1 + len(triples):
        body.append((node, SH.property, prop))
        if severity is not None:
            body.append((prop, SH.severity, severity))
    else:
        body = []
    return path, body + extra


def _rules_on(ctx: Context, node, path: tuple) -> list:
    """Every property shape of the shape on this path, as its triples."""
    triples = []
    for prop in ctx.graph.objects(node, SH.property):
        if shapes_form.path_of(ctx.graph, ctx.graph.value(prop, SH.path)) == path:
            triples.append((node, SH.property, prop))
            triples += _closure(ctx.graph, prop)
    return triples


def _severity_of(ctx: Context, node):
    value = ctx.graph.value(node, SH.severity)
    return value if value == SH.Warning else None


def _read_rules(ctx: Context, node) -> dict:
    rules = shapes_form.read_rules(ctx.graph, node, ctx.model, lambda i: _model_name(ctx, i), ctx.languages)[0]
    return {tuple(URIRef(p) for p in r["path"]): r for r in rules}


def _bind_shapes(ctx: Context) -> None:
    """The prefixes a shapes file reads well with. Not a statement, so not
    part of the delta; longturtle writes them on the next save."""
    for prefix, namespace in (("sh", SH), ("xsd", XSD), ("rdfs", RDFS), ("owl", OWL), ("skos", SKOS)):
        ctx.graph.bind(prefix, namespace, override=False)
    if ctx.manifest.get("prefix"):
        ctx.graph.bind(ctx.manifest["prefix"], ctx.base, override=False)


def cmd_create_shape(ctx: Context, a: dict) -> Change:
    """A shape for a class (or concepts), or the ready model check (5.2)."""
    _shapes_ctx(ctx)
    preset = a.get("preset")
    if preset not in (None, "modelCheck"):
        raise CommandError("The preset is modelCheck, or none.")
    taxonomy = ctx.manifest.get("kind") == "taxonomy"
    if preset == "modelCheck":
        target = SKOS.Concept if taxonomy else OWL.Class
    else:
        target = ctx.iri(a.get("target"), "class")
        if target not in (SKOS.Concept, OWL.Class) and (target, None, None) not in ctx.model:
            raise CommandError(f"There is no class {ctx.short(target)} in the model or its imports.")
    name = a.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip()):
        raise CommandError("A shape's name cannot be empty.")
    if name is None:
        name = ("Check my model" if preset else
                "Concept rules" if target == SKOS.Concept else f"{_model_name(ctx, target)} rules")
    name = name.strip()
    local = shapes_form.local_name(name) or "Shape"
    iri = URIRef(ctx.base + local)
    n = 2
    while ctx.mentioned(iri) or (iri, None, None) in ctx.model:
        iri = URIRef(f"{ctx.base}{local}{n}")
        n += 1
    adds = [
        (iri, RDF.type, SH.NodeShape),
        (iri, RDFS.label, Literal(name, lang=ctx.primary)),
        (iri, SH.targetClass, target),
    ]
    if preset == "modelCheck":
        definition = {"path": [str(p) for p in shapes_form.DEFINITION_PATH], "minCount": 1}
        if taxonomy:
            names = {"path": [str(SKOS.prefLabel)], "requiredLanguages": list(ctx.languages)}
        else:
            names = {"path": [str(RDFS.label)], "requiredLanguages": [ctx.primary]}
        for rule in (names, definition):
            adds += _rule_triples(ctx, iri, rule, None)[1]
    _bind_shapes(ctx)
    return _created(_change(ctx.graph, f"Created shape {name}", adds), iri)


def cmd_set_shape_target(ctx: Context, a: dict) -> Change:
    node = _shape(ctx, a)
    target = ctx.iri(a.get("target"), "class")
    if target not in (SKOS.Concept, OWL.Class) and (target, None, None) not in ctx.model:
        raise CommandError(f"There is no class {ctx.short(target)} in the model or its imports.")
    old = [(node, SH.targetClass, o) for o in ctx.graph.objects(node, SH.targetClass)]
    return _change(
        ctx.graph, f"Made {_shape_label(ctx, node)} apply to {_model_name(ctx, target)}",
        [(node, SH.targetClass, target)], old,
    )


def cmd_set_shape_name(ctx: Context, a: dict) -> Change:
    node = _shape(ctx, a)
    value = a.get("value")
    if not isinstance(value, str) or not value.strip():
        raise CommandError("A shape's name cannot be empty.")
    old = [(node, RDFS.label, o) for o in ctx.graph.objects(node, RDFS.label)]
    return _change(
        ctx.graph, f"Renamed shape {_shape_label(ctx, node)} to {value.strip()}",
        [(node, RDFS.label, Literal(value.strip(), lang=ctx.primary))], old,
    )


def cmd_set_shape_severity(ctx: Context, a: dict) -> Change:
    """Problem or Warning (5.3). SHACL reads a severity per shape, so it is
    written on the node shape and on every rule's property shape."""
    node = _shape(ctx, a)
    severity = a.get("severity")
    if severity not in SEVERITY_TERMS:
        raise CommandError("The severity is violation (a problem) or warning.")
    props = list(ctx.graph.objects(node, SH.property))
    removes = [(s, SH.severity, o) for s in (node, *props) for o in ctx.graph.objects(s, SH.severity)]
    adds = [] if severity == "violation" else [(s, SH.severity, SH.Warning) for s in (node, *props)]
    word = "a problem" if severity == "violation" else "a warning"
    return _change(ctx.graph, f"Made a failure of {_shape_label(ctx, node)} {word}", adds, removes)


def cmd_set_shape_message(ctx: Context, a: dict) -> Change:
    node = _shape(ctx, a)
    value = a.get("value")
    if value is not None and not isinstance(value, str):
        raise CommandError("A message is text.")
    old = [(node, SH.message, o) for o in ctx.graph.objects(node, SH.message)]
    if not value or not value.strip():
        if not old:
            raise CommandError(f"{_shape_label(ctx, node)} has no message to remove.")
        return _change(ctx.graph, f"Removed the message of {_shape_label(ctx, node)}", removes=old)
    return _change(
        ctx.graph, f"Set the message of {_shape_label(ctx, node)}",
        [(node, SH.message, Literal(value.strip(), lang=ctx.primary))], old,
    )


def _merged(existing: dict, rule: dict) -> dict:
    out = {k: v for k, v in existing.items() if k not in ("pathLabel", "pathKind", "classLabel")}
    for key, value in rule.items():
        if key in ("requiredLanguages", "languageIn") and out.get(key):
            out[key] = list(dict.fromkeys([*out[key], *value]))
        elif key not in ("pathLabel", "pathKind", "classLabel"):
            out[key] = value
    return out


def cmd_add_rule(ctx: Context, a: dict) -> Change:
    """One rule (5.3). With `merge`, a rule already on the path takes the new
    parts in the same step -- what Add on a suggestion does (5.4)."""
    node = _shape(ctx, a)
    rule = a.get("rule")
    if not isinstance(rule, dict):
        raise CommandError("A rule is an object: the path and what is checked on it.")
    path = _rule_path(ctx, rule.get("path"))
    existing = _read_rules(ctx, node).get(path)
    removes: list = []
    if existing is not None:
        if not a.get("merge"):
            raise CommandError(f"There is already a rule on {existing['pathLabel']}; edit that one.")
        rule = _merged(existing, rule)
        removes = _rules_on(ctx, node, path)
    _, adds = _rule_triples(ctx, node, rule, _severity_of(ctx, node))
    label = shapes_form.path_label(ctx.model, path, ctx.languages)
    return _change(ctx.graph, f"Added a rule on {label} to {_shape_label(ctx, node)}", adds, removes)


def cmd_replace_rule(ctx: Context, a: dict) -> Change:
    node = _shape(ctx, a)
    path = _rule_path(ctx, a.get("path"))
    rules = _read_rules(ctx, node)
    if path not in rules:
        raise CommandError(f"{_shape_label(ctx, node)} has no rule on that path to change.")
    new_path, adds = _rule_triples(ctx, node, a.get("rule"), _severity_of(ctx, node))
    if new_path != path and new_path in rules:
        raise CommandError(f"There is already a rule on {rules[new_path]['pathLabel']}; edit that one.")
    label = shapes_form.path_label(ctx.model, new_path, ctx.languages)
    return _change(ctx.graph, f"Changed the rule on {label} of {_shape_label(ctx, node)}",
                   adds, _rules_on(ctx, node, path))


def cmd_remove_rule(ctx: Context, a: dict) -> Change:
    node = _shape(ctx, a)
    path = _rule_path(ctx, a.get("path"))
    removes = _rules_on(ctx, node, path)
    if not removes:
        raise CommandError(f"{_shape_label(ctx, node)} has no rule on that path to remove.")
    label = shapes_form.path_label(ctx.model, path, ctx.languages)
    return _change(ctx.graph, f"Removed the rule on {label} from {_shape_label(ctx, node)}", removes=removes)


def cmd_delete_shape(ctx: Context, a: dict) -> Change:
    """The shape, its rules and what only they reached. Allowed for a shape
    written in Turtle too: deleting is not rewriting what the form cannot
    read, and the dialog has counted the rules first."""
    node = _shape(ctx, a, editable=False)
    g = ctx.graph
    removes = set(g.triples((node, None, None))) | set(g.triples((None, None, node)))
    for _, _, o in g.triples((node, None, None)):
        removes |= _closure(g, o)
    return _change(g, f"Deleted shape {_shape_label(ctx, node)}", removes=list(removes))


SHAPE_COMMANDS = {
    "CreateShape": cmd_create_shape,
    "SetShapeTarget": cmd_set_shape_target,
    "SetShapeName": cmd_set_shape_name,
    "SetShapeSeverity": cmd_set_shape_severity,
    "SetShapeMessage": cmd_set_shape_message,
    "AddRule": cmd_add_rule,
    "ReplaceRule": cmd_replace_rule,
    "RemoveRule": cmd_remove_rule,
    "DeleteShape": cmd_delete_shape,
}


COMMANDS: dict[str, Callable[[Context, dict], Change]] = {
    "CreateClass": cmd_create_class,
    "CreateObjectProperty": cmd_create_object_property,
    "CreateDatatypeProperty": cmd_create_datatype_property,
    "CreateConcept": cmd_create_concept,
    "SetLabel": cmd_set_label,
    "SetComment": cmd_set_comment,
    "AddAnnotation": cmd_add_annotation,
    "RemoveAnnotation": cmd_remove_annotation,
    "ReplaceAnnotation": cmd_replace_annotation,
    "CreateAnnotationProperty": cmd_create_annotation_property,
    "AddSubClassOf": cmd_add_subclass,
    "RemoveSubClassOf": cmd_remove_subclass,
    "SetDomain": cmd_set_domain,
    "SetRange": cmd_set_range,
    "SwapEnds": cmd_swap_ends,
    "SetEnds": cmd_set_ends,
    "ClearDomain": cmd_clear_domain,
    "ClearRange": cmd_clear_range,
    "SetInverse": cmd_set_inverse,
    "ClearInverse": cmd_clear_inverse,
    "SetCharacteristic": cmd_set_characteristic,
    "AddSubPropertyOf": cmd_add_subproperty,
    "RemoveSubPropertyOf": cmd_remove_subproperty,
    "AddBroader": cmd_add_broader,
    "RemoveBroader": cmd_remove_broader,
    "AddRelated": cmd_add_related,
    "RemoveRelated": cmd_remove_related,
    "AddMapping": cmd_add_mapping,
    "RemoveMapping": cmd_remove_mapping,
    "RenameIri": cmd_rename_iri,
    "DeleteEntity": cmd_delete_entity,
    "CreateExample": cmd_create_example,
    "SetExampleValue": cmd_set_example_value,
    "AddExampleValue": cmd_add_example_value,
    "RemoveExampleValue": cmd_remove_example_value,
    **SHAPE_COMMANDS,
}


# ---------------------------------------------------------------------------
# Open documents and the service
# ---------------------------------------------------------------------------


@dataclass
class OpenDocument:
    pid: str
    doc: str
    path: Path
    ontology: Ontology
    lock: threading.RLock = field(default_factory=threading.RLock)
    undo: list = field(default_factory=list)
    redo: list = field(default_factory=list)
    dirty: bool = False
    # The editor's text while the last change came from the editor (or the
    # file as loaded); None once a command, undo or redo changed the graph.
    last_text: Optional[str] = None
    # True once any change since the last save came from a command, an undo
    # or a redo: Save then writes clean Turtle (D-083).
    visual_since_save: bool = False
    timer: Optional[threading.Timer] = None
    generation: int = 0
    # The step on top of the undo stack when the document was last saved (or
    # opened): BASE for an empty stack, None once that state cannot be reached
    # by undo or redo any more. `saved_text` is what the file holds.
    save_point: object = None
    saved_text: Optional[str] = None
    _clean: Optional[tuple] = None
    # (revision and langs, view, the imports view it was built with): the
    # canvas's boxes and lines (D-081).
    _canvas: Optional[tuple] = None

    @property
    def graph(self) -> Graph:
        return self.ontology.graph

    def clean(self) -> str:
        """longturtle of the current graph, once per revision."""
        if self._clean is None or self._clean[0] != self.ontology.revision:
            self._clean = (self.ontology.revision, clean_turtle(self.graph))
        return self._clean[1]

    def top(self) -> object:
        return self.undo[-1] if self.undo else BASE

    def editor_state(self) -> tuple:
        return (self.last_text, self.visual_since_save)

    def text(self) -> str:
        """What the editor shows and a draft holds."""
        return self.last_text if self.last_text is not None else self.clean()

    def save_text(self) -> str:
        return self.last_text if (self.last_text is not None and not self.visual_since_save) else self.clean()

    def state(self) -> dict:
        return {
            "doc": self.doc,
            "ontologyId": self.ontology.id,
            "revision": self.ontology.revision,
            "dirty": self.dirty,
            "canUndo": bool(self.undo),
            "undoLabel": self.undo[-1].label if self.undo else None,
            "canRedo": bool(self.redo),
            "redoLabel": self.redo[-1].label if self.redo else None,
            "triples": len(self.graph),
        }


# The save point of a document saved (or opened) with nothing to undo.
BASE = object()


def _draft_paths(document: OpenDocument) -> tuple[Path, Path]:
    folder = document.path.parent / DRAFT_DIR
    return folder / f"{document.doc}.ttl", folder / f"{document.doc}.json"


class EditingService:
    """Every open project and its documents."""

    def __init__(self, projects: ProjectStore, store: OntologyStore) -> None:
        self.projects = projects
        self.store = store
        self._open: dict[str, dict[str, OpenDocument]] = {}
        self._lock = threading.Lock()
        # How many drafts the timer has written; the autosave tests read it.
        self.drafts_written = 0
        # The open projects' data snapshots (csv-data-import 5.6): not
        # documents, so nothing here edits them, but they open and close
        # with the project and join its views and its validation.
        self.snapshots = SnapshotService(projects)

    def configure(self, projects: ProjectStore, store: OntologyStore) -> None:
        self.close_all()
        self.projects = projects
        self.store = store
        self.snapshots.configure(projects)

    # --- opening and closing --------------------------------------------------

    def _load(self, pid: str, doc: str, manifest: dict) -> OpenDocument:
        path = self.projects.document_path(pid, doc)
        text = path.read_text(encoding="utf-8")
        # The file may hold the editor's text verbatim, relative IRIs and all.
        graph = parse_turtle(text, None, manifest["baseIri"])
        languages = (manifest.get("primaryLanguage", "en"), *manifest.get("languages", []))
        ontology = Ontology(
            id=document_id(pid, doc),
            name=f"{manifest['name']} ({path.name})",
            source="project",
            format="turtle",
            meta={
                "id": document_id(pid, doc),
                "name": manifest["name"],
                "namespaces": {p: str(ns) for p, ns in graph.namespaces() if p},
                "addedAt": manifest["createdAt"],
            },
            data_path=path,
            graph=graph,
            editable=True,
            languages=languages,
        )
        document = OpenDocument(pid, doc, path, ontology, last_text=text, save_point=BASE, saved_text=text)
        ontology.source_provider = lambda: document.text().encode("utf-8")
        # Every view reads under the same lock the edits take, so a build never
        # iterates a graph an apply is changing (found in review).
        ontology.lock = document.lock
        return document

    def open(self, pid: str) -> dict:
        manifest = self.projects.manifest(pid)
        with self._lock:
            documents = self._open.get(pid)
            if documents is None:
                documents = {}
                for entry in manifest["documents"]:
                    doc = entry["role"]
                    documents[doc] = self._load(pid, doc, manifest)
                    self._prune_layout(documents[doc])
                # A project made before kinds is judged from its model (D-089).
                self.projects.ensure_kind(pid, documents["model"].graph)
                manifest = self.projects.manifest(pid)
                # data.ttl is read now, so no view ever runs a mapping.
                self.snapshots.load(pid)
                documents["model"].ontology.snapshots = lambda: self.snapshots.active(pid)
                self._open[pid] = documents
                for document in documents.values():
                    self.store.register_document(document.ontology)
        return {
            "project": self.projects.summary(manifest),
            "documents": [d.state() for d in documents.values()],
            "recovery": self._recovery(documents.values()),
        }

    def _recovery(self, documents: Iterable[OpenDocument]) -> dict:
        """A draft newer than its file, not yet recovered or discarded."""
        newest = None
        for document in documents:
            if document.dirty:
                continue
            draft, _ = _draft_paths(document)
            if draft.exists() and draft.stat().st_mtime > document.path.stat().st_mtime:
                stamp = draft.stat().st_mtime
                newest = stamp if newest is None else max(newest, stamp)
        if newest is None:
            return {"available": False, "draftTime": None}
        when = datetime.fromtimestamp(newest, tz=timezone.utc).isoformat()
        return {"available": True, "draftTime": when}

    def is_open(self, pid: str) -> bool:
        return pid in self._open

    def document(self, pid: str, doc: str) -> OpenDocument:
        self.projects.document_file(doc)  # UnknownDocument for a name not issued
        documents = self._open.get(pid)
        if documents is None:
            self.projects.folder(pid)  # UnknownProject first, if it is that
            raise NotOpen(pid)
        if doc not in documents:
            raise UnknownDocument(doc)
        return documents[doc]

    def close(self, pid: str, discard: bool = False) -> dict:
        documents = self._open.get(pid)
        if documents is None:
            # Not open is fine, but only for an id this store issued: an
            # unknown one is refused like on every other project route.
            self.projects.folder(pid)
            return {"closed": pid}
        if not discard and any(d.dirty for d in documents.values()):
            raise Dirty(pid)
        with self._lock:
            self._open.pop(pid, None)
        for document in documents.values():
            with document.lock:
                self._cancel(document)
                if discard:
                    self._remove_draft(document)
            self.store.unregister_document(document.ontology.id)
        self.snapshots.unload(pid)
        return {"closed": pid}

    def close_all(self) -> None:
        """Forget every open project, unsaved changes included. For tests."""
        for pid in list(self._open):
            self.close(pid, discard=True)

    def add_document(self, pid: str, role: str) -> dict:
        summary = self.projects.add_document(pid, role)
        if pid in self._open:
            manifest = self.projects.manifest(pid)
            document = self._load(pid, role, manifest)
            with self._lock:
                self._open[pid][role] = document
            self.store.register_document(document.ontology)
        return summary

    def refresh_manifest(self, pid: str) -> None:
        """Names and languages changed on the manifest reach the open documents."""
        documents = self._open.get(pid)
        if not documents:
            return
        manifest = self.projects.manifest(pid)
        languages = (manifest.get("primaryLanguage", "en"), *manifest.get("languages", []))
        for document in documents.values():
            document.ontology.name = f"{manifest['name']} ({document.path.name})"
            document.ontology.languages = languages

    # --- changing a document ----------------------------------------------------

    def _context(self, document: OpenDocument) -> Context:
        manifest = self.projects.manifest(document.pid)

        def imported() -> Optional[Graph]:
            if not load_state(document.ontology):
                return None
            return imports_service.merged(document.ontology)["graph"]

        model = None
        if document.doc != "model":
            model_doc = self._open[document.pid]["model"]
            model = lambda: self._model_view(model_doc)  # noqa: E731
        return Context(document.graph, manifest, imported, document.doc, model)

    @contextlib.contextmanager
    def model_reader(self, pid: str):
        """(model with its imports, manifest, names) under the model's lock,
        for the data wizard: what a row can be, and what a column can
        become, are the model's classes, attributes and relationships."""
        model_doc = self._project_documents(pid)["model"]
        manifest = self.projects.manifest(pid)
        languages = [manifest.get("primaryLanguage", "en"), *manifest.get("languages", [])]
        with model_doc.lock:
            model = self._model_view(model_doc)
            yield model, manifest, lambda iri: pick_label_in(model, iri, languages)[0]

    @staticmethod
    def _model_view(model_doc: "OpenDocument") -> Graph:
        """The model with its resolved imports, read only (D-068), or the
        model alone while none are resolved."""
        if load_state(model_doc.ontology):
            return imports_service.merged(model_doc.ontology)["graph"]
        return model_doc.graph

    def _apply(self, document: OpenDocument, change: Change, *, origin: str) -> None:
        graph = document.graph
        for t in change.removed:
            graph.remove(t)
        for t in change.added:
            graph.add(t)
        document.ontology.revision += 1
        document.dirty = True
        if origin == "editor":
            pass  # last_text was set by the caller, to the text just applied
        else:
            document.last_text = None
            document.visual_since_save = True
        self._arm(document)

    def command(self, pid: str, doc: str, name: str, args: dict, dry_run: bool = False) -> dict:
        handler = COMMANDS.get(name)
        if handler is None:
            raise CommandError(f"There is no command called {name}.")
        if not isinstance(args, dict):
            raise CommandError("A command's arguments are an object.")
        if doc == "shapes" and name in SHAPE_COMMANDS and pid in self._open and "shapes" not in self._open[pid]:
            self._first_shapes_command(pid, handler, args, dry_run)
        document = self.document(pid, doc)
        # A shape command reads the model (targets, paths, names) as well:
        # its lock too, always after the shapes document's, so a model edit
        # never changes what the command is checking against.
        model_lock = self._open[pid]["model"].lock if doc != "model" else contextlib.nullcontext()
        with document.lock, model_lock:
            ctx = self._context(document)
            if name == "DeleteEntity":
                change, impact = delete_plan(ctx, args)
                if dry_run:
                    return {"dryRun": True, "impact": impact, "revision": document.ontology.revision}
            else:
                if dry_run:
                    raise CommandError("Only DeleteEntity has a dry run.")
                change = handler(ctx, args)
                impact = None
            if not change.added and not change.removed:
                raise CommandError("That would change nothing.")
            before = document.editor_state()
            self._apply(document, change, origin="command")
            self._push(document, change, before)
            if change.renamed:
                self._move_layout(document, *change.renamed)
            result = {
                "revision": document.ontology.revision,
                "label": change.label,
                "delta": _delta_json(change),
                "state": document.state(),
            }
            if impact is not None:
                result["impact"] = impact
            if change.created is not None:
                result["created"] = str(change.created)
            return result

    def _first_shapes_command(self, pid: str, handler, args: dict, dry_run: bool) -> None:
        """The first shape command creates shapes.ttl (shacl-authoring 8) --
        only once it is known to succeed. It is checked first against an
        empty shapes document, so a refused command or a dry run leaves no
        file behind, and the file is made under the service lock, so two
        first commands at once make it once (both found in review)."""
        if dry_run:
            raise CommandError("Only DeleteEntity has a dry run.")
        model_doc = self._open[pid]["model"]
        manifest = self.projects.manifest(pid)
        with model_doc.lock:
            probe = Context(Graph(), manifest, lambda: None, "shapes", lambda: self._model_view(model_doc))
            handler(probe, args)  # raises CommandError, the sentence, before anything is made
        with self._lock:
            if "shapes" in self._open.get(pid, {}):
                return
            self.projects.add_document(pid, "shapes")
            document = self._load(pid, "shapes", self.projects.manifest(pid))
            self._open[pid]["shapes"] = document
        self.store.register_document(document.ontology)

    def apply_text(self, pid: str, doc: str, text: str, timeout: Optional[float]) -> dict:
        document = self.document(pid, doc)
        base = self.projects.manifest(pid)["baseIri"]
        parsed = parse_turtle(text, timeout, base)  # raises before anything changes
        with document.lock:
            graph = document.graph
            old, new = set(graph), set(parsed)
            change = Change("Applied Turtle edits", list(new - old), list(old - new))
            for prefix, namespace in parsed.namespaces():
                graph.bind(prefix, namespace, override=True, replace=True)
            before = document.editor_state()
            document.last_text = text
            self._apply(document, change, origin="editor")
            self._push(document, change, before)
            return {
                "revision": document.ontology.revision,
                "label": change.label,
                "delta": _delta_json(change),
                "state": document.state(),
            }

    @staticmethod
    def _push(document: OpenDocument, change: Change, before: tuple) -> None:
        """Record a new change as an undo step, dropping the redo branch."""
        document.undo.append(
            Step(change.label, change.added, change.removed, before, document.editor_state(), change.renamed)
        )
        dropped = document.undo[:-UNDO_LIMIT]
        del document.undo[:-UNDO_LIMIT]
        point = document.save_point
        if dropped:
            # The state after the last dropped step is the new bottom of the
            # stack; any state older than that can no longer be reached.
            if point is dropped[-1]:
                document.save_point = BASE
            elif point is BASE or any(point is d for d in dropped):
                document.save_point = None
        # A save point on the redo branch goes with it (5.7).
        if any(document.save_point is r for r in document.redo):
            document.save_point = None
        document.redo.clear()

    def _settle(self, document: OpenDocument) -> None:
        """After an undo or redo: back at the save point, the document is what
        its file holds, so it is clean and there is no draft to offer."""
        if document.save_point is None or document.top() is not document.save_point:
            return
        document.dirty = False
        document.last_text = document.saved_text
        document.visual_since_save = False
        self._cancel(document)
        self._remove_draft(document)

    def undo(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            if not document.undo:
                raise CommandError("There is nothing to undo.")
            step = document.undo.pop()
            self._apply(document, Change(step.label, step.removed, step.added), origin="undo")
            document.last_text, document.visual_since_save = step.before
            if step.renamed:
                self._move_layout(document, step.renamed[1], step.renamed[0])
            document.redo.append(step)
            self._settle(document)
            return {"revision": document.ontology.revision, "label": step.label, "state": document.state()}

    def redo(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            if not document.redo:
                raise CommandError("There is nothing to redo.")
            step = document.redo.pop()
            self._apply(document, Change(step.label, step.added, step.removed), origin="redo")
            document.last_text, document.visual_since_save = step.after
            if step.renamed:
                self._move_layout(document, *step.renamed)
            document.undo.append(step)
            self._settle(document)
            return {"revision": document.ontology.revision, "label": step.label, "state": document.state()}

    def source(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            return {
                "text": document.text(),
                "revision": document.ontology.revision,
                "fromEditor": document.last_text is not None,
            }

    # --- saving -------------------------------------------------------------------

    def save(self, pid: str, doc: str, confirm_rewrite: bool = False) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            text = document.save_text()
            rewriting = document.visual_since_save
            manifest = self.projects.manifest(pid)
            on_disk = document.path.read_text(encoding="utf-8")
            if rewriting and has_comments(on_disk) and not manifest.get("commentsWarned"):
                if not confirm_rewrite:
                    return {"needsCommentsWarning": True, "backup": f"{doc}.original.ttl"}
                shutil.copyfile(document.path, document.path.with_name(f"{doc}.original.ttl"))
                manifest["commentsWarned"] = True
            tmp = document.path.with_suffix(".ttl.tmp")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(document.path)
            self._cancel(document)
            self._remove_draft(document)
            document.dirty = False
            document.visual_since_save = False
            # What was written is now the text the editor holds.
            document.last_text = text
            document.save_point = document.top()
            document.saved_text = text
            saved_at = _now()
            manifest["updatedAt"] = saved_at
            if doc == "model":
                manifest["counts"] = graph_counts(document.graph)
            self.projects.write_manifest(pid, manifest)
            return {"savedAt": saved_at, "state": document.state()}

    def copy_text(self, pid: str, doc: str) -> str:
        """Save a copy as Turtle: the same format rule, the project untouched."""
        document = self.document(pid, doc)
        with document.lock:
            return document.save_text()

    # --- autosave and recovery ----------------------------------------------------

    def _arm(self, document: OpenDocument) -> None:
        self._cancel(document)
        document.generation += 1
        timer = threading.Timer(AUTOSAVE_DELAY, self._write_draft, (document, document.generation))
        timer.daemon = True
        document.timer = timer
        timer.start()

    @staticmethod
    def _cancel(document: OpenDocument) -> None:
        # Moving the generation is what stops a timer already past its wait:
        # cancel() only stops one that has not fired.
        document.generation += 1
        if document.timer is not None:
            document.timer.cancel()
            document.timer = None

    def _write_draft(self, document: OpenDocument, generation: int) -> None:
        """On the timer thread only. Snapshot under the lock, write outside it."""
        with document.lock:
            if generation != document.generation or not document.dirty:
                return
            if document.last_text is not None:
                text = document.last_text
            else:
                snapshot = Graph()
                for prefix, namespace in document.graph.namespaces():
                    snapshot.bind(prefix, namespace)
                for t in document.graph:
                    snapshot.add(t)
                text = None
            meta = {
                "revision": document.ontology.revision,
                "fromEditor": document.last_text is not None,
                "visualSinceSave": document.visual_since_save,
                "writtenAt": _now(),
            }
        if text is None:
            text = clean_turtle(snapshot)
        # Serialising ran outside the lock, so a save, a discard or a newer
        # change may have happened meanwhile: each moves the generation, and
        # a draft written now would be offered for recovery after the user
        # saved or discarded it (found in review).
        with document.lock:
            if generation != document.generation or not document.dirty:
                return
            draft, sidecar = _draft_paths(document)
            draft.parent.mkdir(exist_ok=True)
            draft.write_text(text, encoding="utf-8")
            sidecar.write_text(json.dumps(meta), encoding="utf-8")
            self.drafts_written += 1

    @staticmethod
    def _remove_draft(document: OpenDocument) -> None:
        for path in _draft_paths(document):
            path.unlink(missing_ok=True)

    def recover(self, pid: str, action: str, timeout: Optional[float]) -> dict:
        documents = self._open.get(pid)
        if documents is None:
            self.projects.folder(pid)
            raise NotOpen(pid)
        if action not in ("recover", "discard"):
            raise CommandError("Choose recover or discard.")
        for document in documents.values():
            draft, sidecar = _draft_paths(document)
            if not draft.exists():
                continue
            with document.lock:
                if action == "discard":
                    self._remove_draft(document)
                    continue
                text = draft.read_text(encoding="utf-8")
                try:
                    meta = json.loads(sidecar.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    meta = {}
                parsed = parse_turtle(text, timeout, self.projects.manifest(pid)["baseIri"])
                graph = document.graph
                for t in list(graph):
                    graph.remove(t)
                for t in parsed:
                    graph.add(t)
                for prefix, namespace in parsed.namespaces():
                    graph.bind(prefix, namespace, override=True, replace=True)
                # Content only: the undo history is not recovered (5.7), and
                # no step leads back to what the file holds.
                document.undo.clear()
                document.redo.clear()
                document.save_point = None
                document.ontology.revision += 1
                document.dirty = True
                document.last_text = text if meta.get("fromEditor") else None
                document.visual_since_save = bool(meta.get("visualSinceSave", not meta.get("fromEditor")))
        return {"documents": [d.state() for d in documents.values()]}

    # --- the modeling canvas (visual-modeling 5.4 to 5.6) ---------------------------

    def canvas_view(self, pid: str, doc: str, lang: Optional[str] = None) -> dict:
        """Boxes, lines, undrawn relationships and the saved layout.

        The boxes and lines are cached by revision and language: dragging a
        box writes the layout, not the model, and must not rebuild them. The
        shown-set cut and the layout are applied per request on top.
        """
        document = self.document(pid, doc)
        ontology = document.ontology
        langs = ontology.label_langs(lang)
        with document.lock:
            # Keyed on the imports view as well: resolving imports saves new
            # import state without moving the revision, and an imported box
            # kept "outside this model" until an unrelated edit (found in
            # review). merged() is itself cached, so the same view is the
            # same object until the imports change.
            merged = imports_service.merged(ontology) if load_state(ontology) else None
            key = (ontology.revision, langs)
            held = document._canvas
            # The view itself is kept and compared by identity, not by id(),
            # which a freed view's successor can be given.
            if held is None or held[0] != key or held[2] is not merged:
                view = build_canvas(
                    document.graph,
                    langs,
                    merged["graph"] if merged else None,
                    merged["importedFrom"] if merged else None,
                )
                document._canvas = (key, view, merged)
            view = document._canvas[1]
            layout = self.projects.read_layout(pid, doc)
            revision = ontology.revision
        # The project's kind decides what the palette offers and which boxes
        # the visual doors may change (D-089); the model is the same either way.
        kind = self.projects.manifest(pid).get("kind")
        return {"revision": revision, "kind": kind, **restrict(view, layout["shown"]), "layout": layout}

    def get_layout(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            return self.projects.read_layout(pid, doc)

    def put_layout(self, pid: str, doc: str, layout) -> dict:
        """Replace the layout. Not a change to the model: no revision, no
        dirty flag, no undo step, no Save needed (5.5)."""
        document = self.document(pid, doc)
        with document.lock:
            return self.projects.write_layout(pid, doc, layout)

    def _move_layout(self, document: OpenDocument, old: str, new: str) -> None:
        """Positions follow the IRI: a rename, its undo and its redo."""
        layout = self.projects.read_layout(document.pid, document.doc)
        moved = False
        if old in layout["positions"]:
            layout["positions"][new] = layout["positions"].pop(old)
            moved = True
        if layout["shown"] and old in layout["shown"]:
            layout["shown"] = [new if i == old else i for i in layout["shown"]]
            moved = True
        if moved:
            self.projects.write_layout(document.pid, document.doc, layout)

    def _prune_layout(self, document: OpenDocument) -> None:
        """On open only: drop positions of IRIs the document no longer
        mentions. Not on delete, so an undone delete finds its box's place."""
        path = self.projects.layout_path(document.pid, document.doc)
        if not path.exists():
            return
        layout = self.projects.read_layout(document.pid, document.doc)
        g = document.graph
        mentioned = lambda iri: (URIRef(iri), None, None) in g or (None, None, URIRef(iri)) in g  # noqa: E731
        kept = {iri: p for iri, p in layout["positions"].items() if mentioned(iri)}
        shown = [iri for iri in layout["shown"]] if layout["shown"] is not None else None
        if shown is not None:
            shown = [iri for iri in shown if mentioned(iri)]
        if kept != layout["positions"] or shown != layout["shown"]:
            layout["positions"], layout["shown"] = kept, shown
            self.projects.write_layout(document.pid, document.doc, layout)

    # --- SHACL shapes and validation (shacl-authoring 5.1 to 5.7) ---------------------

    def _project_documents(self, pid: str) -> dict:
        documents = self._open.get(pid)
        if documents is None:
            self.projects.folder(pid)  # UnknownProject first, if it is that
            raise NotOpen(pid)
        return documents

    def shapes_view(self, pid: str) -> dict:
        """Every listed shape in the form's structure (5.1, 5.5). An empty
        list, not an error, while the project has no shapes.ttl."""
        documents = self._project_documents(pid)
        manifest = self.projects.manifest(pid)
        languages = [manifest.get("primaryLanguage", "en"), *manifest.get("languages", [])]
        model_doc = documents["model"]
        shapes_doc = documents.get("shapes")
        if shapes_doc is None:
            return {"revision": None, "modelRevision": model_doc.ontology.revision,
                    "kind": manifest.get("kind"), "shapes": []}
        with shapes_doc.lock, model_doc.lock:
            model = self._model_view(model_doc)
            names = lambda iri: pick_label_in(model, iri, languages)[0]  # noqa: E731
            shapes = [
                shapes_form.read_shape(shapes_doc.graph, node, model, names, languages)
                for node in shapes_form.listed_shapes(shapes_doc.graph)
            ]
            return {
                "revision": shapes_doc.ontology.revision,
                "modelRevision": model_doc.ontology.revision,
                "kind": manifest.get("kind"),
                "shapes": shapes,
            }

    def shape_suggestions(self, pid: str, target: Optional[str], shape: Optional[str] = None) -> dict:
        """What a rule can be about for a target, and the rules the model
        suggests that the shape does not already have (5.4)."""
        documents = self._project_documents(pid)
        manifest = self.projects.manifest(pid)
        languages = [manifest.get("primaryLanguage", "en"), *manifest.get("languages", [])]
        model_doc = documents["model"]
        shapes_doc = documents.get("shapes")
        # The shapes document's lock before the model's, the order every
        # shape command takes them in.
        shapes_lock = shapes_doc.lock if shapes_doc is not None else contextlib.nullcontext()
        with shapes_lock, model_doc.lock:
            model = self._model_view(model_doc)
            ctx = Context(model_doc.graph, manifest, lambda: None)
            target_iri = ctx.iri(target, "class")
            names = lambda iri: pick_label_in(model, iri, languages)[0]  # noqa: E731
            existing: list = []
            if shape and shapes_doc is not None:
                node = shapes_form.find_shape(shapes_doc.graph, shape)
                if node is not None:
                    existing = shapes_form.read_rules(shapes_doc.graph, node, model, names, languages)[0]
            return shapes_form.suggestions(model, target_iri, existing, names, languages)

    def validate(self, pid: str, timeout: Optional[float] = None) -> dict:
        """Check the model, unsaved changes and resolved imports included,
        against every shape (5.6). Copies are taken under each document's
        lock, one at a time, and checked outside both, so a long check never
        holds up an edit and an edit never changes a check half way.

        The switched-on data snapshots are checked too (csv-data-import
        5.6), and each panel says which of them it found individuals in."""
        documents = self._project_documents(pid)
        manifest = self.projects.manifest(pid)
        languages = [manifest.get("primaryLanguage", "en"), *manifest.get("languages", [])]
        model_doc = documents["model"]
        data = Graph()
        with model_doc.lock:
            for prefix, namespace in model_doc.graph.namespaces():
                data.bind(prefix, namespace)
            for t in self._model_view(model_doc):
                data.add(t)
            model_revision = model_doc.ontology.revision
        generation, snapshots = self.snapshots.active(pid)
        for graph, _ in snapshots:
            for t in graph:
                data.add(t)
        sources = {URIRef(iri): sid for iri, (sid, _) in self.snapshots.origins(pid).items()}
        shapes = Graph()
        shapes_revision = None
        shapes_doc = documents.get("shapes")
        if shapes_doc is not None:
            with shapes_doc.lock:
                for prefix, namespace in shapes_doc.graph.namespaces():
                    shapes.bind(prefix, namespace)
                for t in shapes_doc.graph:
                    shapes.add(t)
                shapes_revision = shapes_doc.ontology.revision
        result = shacl.validate(data, shapes, languages, timeout, sources=sources)
        result["revisions"] = {"model": model_revision, "shapes": shapes_revision, "data": generation}
        result["dataSources"] = [info for _, info in snapshots]
        return result

    # --- what the forms and the language menu read --------------------------------

    def annotation_properties(self, pid: str, doc: str) -> list[dict]:
        """The suggested list, then every annotation property the document or
        its resolved imports declare, with its range as the default type."""
        document = self.document(pid, doc)
        ctx = self._context(document)
        seen = set()
        out = []
        for prop, default in SUGGESTED_ANNOTATIONS:
            seen.add(prop)
            out.append({"iri": str(prop), "prefixed": prefixed(ctx.graph, prop), "defaultType": default, "source": "suggested"})
        sources = [(document.graph, "document")]
        if ctx.imported is not None:
            sources.append((ctx.imported, "import"))
        for graph, where in sources:
            for prop in sorted(graph.subjects(RDF.type, OWL.AnnotationProperty)):
                if not isinstance(prop, URIRef) or prop in seen:
                    continue
                seen.add(prop)
                rng = next(iter(graph.objects(prop, RDFS.range)), None)
                out.append({
                    "iri": str(prop),
                    "prefixed": prefixed(ctx.graph, prop),
                    "defaultType": value_type_from_range(rng),
                    "source": where,
                })
        return out

    def missing_names(self, pid: str, doc: str) -> dict:
        """How many named entities have no name in each project language."""
        document = self.document(pid, doc)
        manifest = self.projects.manifest(pid)
        languages = [manifest.get("primaryLanguage", "en"), *manifest.get("languages", [])]
        graph = document.graph
        entity_types = (
            OWL.Class, RDFS.Class, OWL.ObjectProperty, OWL.DatatypeProperty,
            OWL.AnnotationProperty, RDF.Property, SKOS.Concept, SKOS.ConceptScheme,
            OWL.NamedIndividual,
        )
        entities = {
            s for t in entity_types for s in graph.subjects(RDF.type, t) if isinstance(s, URIRef)
        }
        missing = {
            lang: sum(1 for e in entities if name_in(graph, e, lang) is None) for lang in languages
        }
        return {"entities": len(entities), "languages": languages, "missing": missing}


def _delta_json(change: Change, cap: int = 500) -> dict:
    """The delta, each side capped with its true total beside it."""
    def n3(triples):
        return [" ".join(term.n3() for term in t) for t in triples[:cap]]

    return {
        "added": n3(change.added),
        "removed": n3(change.removed),
        "addedTotal": len(change.added),
        "removedTotal": len(change.removed),
    }



# The two singletons the router uses, beside the store they depend on. Tests
# point them at their own data directory with configure().
project_store = ProjectStore(_default_store.data_dir)
editing_service = EditingService(project_store, _default_store)
