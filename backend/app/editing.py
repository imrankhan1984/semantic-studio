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

    A command is checked before anything moves: its IRIs are absolute (or a
    prefixed name the document or the well-known vocabularies define), its
    targets exist, a new IRI is not taken, a value is valid for its datatype.
    A refusal is a CommandError carrying a sentence, and the graph is untouched.

    Formatting option A decides what Save writes. While every change since the
    last save came from the editor, the file gets the text last applied,
    comments and layout included. Once any change came from a command, an undo
    or a redo, it gets rdflib's longturtle -- measured identical across repeated
    parses, sorted by subject, so it diffs well. Before the first such save of a
    file that has comments, the caller is told once, and on confirmation the
    file is copied to <doc>.original.ttl.

    Autosave never runs on the request path. A change arms a timer (two seconds,
    reset by every later change); the timer thread snapshots the document under
    its lock and writes .draft/<doc>.ttl outside it. Recovery reads that draft
    back as unsaved content: the undo history is not recovered, which is simpler
    than replaying a journal and survives blank nodes, which a triple journal
    would not.

INPUTS / INPUT SOURCES
    - Project folders and manifests, through projects.ProjectStore.
    - Command names and arguments, and Turtle text, from routers/projects.py.
    - The imports merged view, read only, for targets defined in an import and
      for the delete impact's import mentions.

EXPECTED OUTPUT
    - Mutated document graphs, new revisions, undo labels.
    - Files: <doc>.ttl on save, <doc>.original.ttl once, .draft/<doc>.ttl and
      .draft/<doc>.json while unsaved.
    - CommandError (422, a sentence), TurtleSyntaxError (422, line and column),
      NotOpen and Dirty (409).
================================================================================
"""

from __future__ import annotations

import contextvars
import json
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
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
from .imports import imports_service, load_state
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

_TZ = r"(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?"
_DATE = r"(-?[0-9]{4,})-([0-9]{2})-([0-9]{2})"
_LEXICAL = {
    "integer": (re.compile(r"[+-]?[0-9]+"), "integer", "a whole number such as 42"),
    "decimal": (
        re.compile(r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)"),
        "decimal",
        "a number such as 4.5",
    ),
    "boolean": (re.compile(r"true|false|1|0"), "boolean", "true or false"),
    "date": (re.compile(_DATE + _TZ), "date", "YYYY-MM-DD"),
    "dateTime": (
        re.compile(_DATE + r"T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?" + _TZ),
        "date and time",
        "YYYY-MM-DDThh:mm:ss",
    ),
}


def _real_date(year: str, month: str, day: str) -> bool:
    try:
        # A year past 9999 or before 1 is lexically legal and Python cannot
        # represent it; check the month and day against a leap year instead.
        y = int(year)
        date(y if 1 <= y <= 9999 else 2000, int(month), int(day))
        return True
    except ValueError:
        return False


def check_lexical(value: str, datatype: str) -> None:
    """Refuse a value that is not valid for its datatype, naming the type."""
    if datatype == "string":
        return
    if datatype == "anyURI":
        if re.search(r"\s", value) or not value:
            raise CommandError(f'"{value}" is not a valid URI (it is empty or contains a space).')
        return
    pattern, name, expected = _LEXICAL[datatype]
    match = pattern.fullmatch(value)
    ok = match is not None
    if ok and datatype in ("date", "dateTime"):
        ok = _real_date(match.group(1), match.group(2), match.group(3))
    if ok and datatype == "dateTime":
        hour, minute, second = int(match.group(4)), int(match.group(5)), int(match.group(6))
        ok = (hour < 24 and minute < 60 and second < 60) or (hour, minute, second) == (24, 0, 0)
    if not ok:
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


def parse_turtle(text: str, timeout: Optional[float]) -> Graph:
    """Turtle only, under the upload path's wall-clock limit.

    Not store.parse_rdf: that tries every format in turn, and an editor error
    has to be Turtle's error, with the line and column where it happened.
    """
    def work() -> Graph:
        parsed = Graph()
        try:
            parsed.parse(data=text, format="turtle")
        except Exception as exc:  # rdflib raises BadSyntax and friends
            raise _syntax_error(text, exc) from exc
        return parsed

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


@dataclass
class Step:
    label: str
    added: list
    removed: list


@dataclass
class Change:
    """What a command computed: a delta and the label the undo stack shows."""

    label: str
    added: list
    removed: list


class Context:
    """What a command reads: the graph, the project, and name resolution."""

    def __init__(self, graph: Graph, manifest: dict, imported: Callable[[], Optional[Graph]]):
        self.graph = graph
        self.manifest = manifest
        self.primary = manifest.get("primaryLanguage", "en")
        self.base = manifest["baseIri"]
        self._imported = imported
        self._imported_view: Optional[Graph] = None
        self._imported_read = False

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
    return _change(ctx.graph, f"Created class {label}", adds)


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
    return _change(ctx.graph, f"Created object property {label}", adds)


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
    return _change(ctx.graph, f"Created datatype property {label}", adds)


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
    if a.get("scheme"):
        scheme = ctx.iri(a["scheme"], "concept scheme")
        ctx.require(scheme, "concept scheme")
        adds.append((iri, SKOS.inScheme, scheme))
        if not a.get("broader"):
            adds.append((scheme, SKOS.hasTopConcept, iri))
    if a.get("broader"):
        broader = ctx.iri(a["broader"], "broader concept")
        ctx.require(broader, "concept")
        adds.append((iri, SKOS.broader, broader))
    return _change(ctx.graph, f"Created concept {label}", adds)


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


def cmd_remove_annotation(ctx: Context, a: dict) -> Change:
    iri, prop = _annotation_target(ctx, a)
    term = parse_value(a.get("value"), ctx.primary, lambda v: ctx.iri(v, "link"))
    if (iri, prop, term) not in ctx.graph:
        raise CommandError(f"{ctx.name(iri)} has no such {ctx.short(prop)} to remove.")
    return _change(ctx.graph, f"Removed {ctx.short(prop)} from {ctx.name(iri)}", removes=[(iri, prop, term)])


def cmd_replace_annotation(ctx: Context, a: dict) -> Change:
    iri, prop = _annotation_target(ctx, a)
    resolve = lambda v: ctx.iri(v, "link")  # noqa: E731
    old = parse_value(a.get("oldValue"), ctx.primary, resolve)
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
    return _change(
        ctx.graph, f"Created annotation property {(label or '').strip() or ctx.short(iri)}", adds
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


def cmd_add_broader(ctx: Context, a: dict) -> Change:
    concept, broader = _pair(ctx, a, "concept", "broader", "concept")
    if (concept, SKOS.broader, broader) in ctx.graph:
        raise CommandError(f"{ctx.name(concept)} is already narrower than {ctx.name(broader)}.")
    return _change(
        ctx.graph, f"Made {ctx.name(concept)} narrower than {ctx.name(broader)}",
        [(concept, SKOS.broader, broader)],
    )


def cmd_remove_broader(ctx: Context, a: dict) -> Change:
    concept, broader = _pair(ctx, a, "concept", "broader", "concept")
    removes = [(concept, SKOS.broader, broader), (broader, SKOS.narrower, concept)]
    if not any(t in ctx.graph for t in removes):
        raise CommandError(f"{ctx.name(concept)} is not narrower than {ctx.name(broader)}.")
    return _change(
        ctx.graph, f"Removed {ctx.name(broader)} as broader of {ctx.name(concept)}", removes=removes
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
    return _change(ctx.graph, f"Renamed {ctx.short(old)} to {ctx.short(new)}", adds, touched)


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

    ref = lambda node: {"iri": str(node), "label": ctx.name(node)}  # noqa: E731
    properties = [
        {**ref(p), "role": "domain" if pred == RDFS.domain else "range"}
        for p, pred in sorted(
            {(s, p) for s, p in g.subject_predicates(iri) if p in (RDFS.domain, RDFS.range)},
        )
        if isinstance(p, URIRef)
    ]
    individuals = sorted(
        s for s in g.subjects(RDF.type, iri)
        if isinstance(s, URIRef) and ctx.kind(s) == "entity"
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
    "AddBroader": cmd_add_broader,
    "RemoveBroader": cmd_remove_broader,
    "RenameIri": cmd_rename_iri,
    "DeleteEntity": cmd_delete_entity,
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
    _clean: Optional[tuple] = None

    @property
    def graph(self) -> Graph:
        return self.ontology.graph

    def clean(self) -> str:
        """longturtle of the current graph, once per revision."""
        if self._clean is None or self._clean[0] != self.ontology.revision:
            self._clean = (self.ontology.revision, clean_turtle(self.graph))
        return self._clean[1]

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

    def configure(self, projects: ProjectStore, store: OntologyStore) -> None:
        self.close_all()
        self.projects = projects
        self.store = store

    # --- opening and closing --------------------------------------------------

    def _load(self, pid: str, doc: str, manifest: dict) -> OpenDocument:
        path = self.projects.document_path(pid, doc)
        text = path.read_text(encoding="utf-8")
        graph = parse_turtle(text, None)
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
        document = OpenDocument(pid, doc, path, ontology, last_text=text)
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

        return Context(document.graph, manifest, imported)

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
        document = self.document(pid, doc)
        handler = COMMANDS.get(name)
        if handler is None:
            raise CommandError(f"There is no command called {name}.")
        if not isinstance(args, dict):
            raise CommandError("A command's arguments are an object.")
        with document.lock:
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
            self._apply(document, change, origin="command")
            document.undo.append(Step(change.label, change.added, change.removed))
            del document.undo[:-UNDO_LIMIT]
            document.redo.clear()
            result = {
                "revision": document.ontology.revision,
                "label": change.label,
                "delta": _delta_json(change),
                "state": document.state(),
            }
            if impact is not None:
                result["impact"] = impact
            return result

    def apply_text(self, pid: str, doc: str, text: str, timeout: Optional[float]) -> dict:
        document = self.document(pid, doc)
        parsed = parse_turtle(text, timeout)  # raises before anything changes
        with document.lock:
            graph = document.graph
            old, new = set(graph), set(parsed)
            change = Change("Applied Turtle edits", list(new - old), list(old - new))
            for prefix, namespace in parsed.namespaces():
                graph.bind(prefix, namespace, override=True, replace=True)
            document.last_text = text
            self._apply(document, change, origin="editor")
            document.undo.append(Step(change.label, change.added, change.removed))
            del document.undo[:-UNDO_LIMIT]
            document.redo.clear()
            return {
                "revision": document.ontology.revision,
                "label": change.label,
                "delta": _delta_json(change),
                "state": document.state(),
            }

    def undo(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            if not document.undo:
                raise CommandError("There is nothing to undo.")
            step = document.undo.pop()
            self._apply(document, Change(step.label, step.removed, step.added), origin="undo")
            document.redo.append(step)
            return {"revision": document.ontology.revision, "label": step.label, "state": document.state()}

    def redo(self, pid: str, doc: str) -> dict:
        document = self.document(pid, doc)
        with document.lock:
            if not document.redo:
                raise CommandError("There is nothing to redo.")
            step = document.redo.pop()
            self._apply(document, Change(step.label, step.added, step.removed), origin="redo")
            document.undo.append(step)
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
                parsed = parse_turtle(text, timeout)
                graph = document.graph
                for t in list(graph):
                    graph.remove(t)
                for t in parsed:
                    graph.add(t)
                for prefix, namespace in parsed.namespaces():
                    graph.bind(prefix, namespace, override=True, replace=True)
                # Content only: the undo history is not recovered (5.7).
                document.undo.clear()
                document.redo.clear()
                document.ontology.revision += 1
                document.dirty = True
                document.last_text = text if meta.get("fromEditor") else None
                document.visual_since_save = bool(meta.get("visualSinceSave", not meta.get("fromEditor")))
        return {"documents": [d.state() for d in documents.values()]}

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
