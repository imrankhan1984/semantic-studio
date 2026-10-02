"""
================================================================================
FILE: backend/app/shapes_form.py
================================================================================

SUMMARY
    SHACL shapes as the learner's form sees them (shacl-authoring 5.3 to
    5.5): which node shapes a shapes document lists, each one read into the
    form's structure -- target, name, severity, message and one rule per
    path -- or marked read-only with the parts the form cannot edit, and the
    rules the ontology suggests for a target class (5.4). Reads only; the
    commands that write shapes are editing.py's.

BASIC IDEA
    A rule is one path and what is checked on it: the form's unit, written
    as one property shape (`sh:property [ sh:path ... ]`) carrying every kind
    the learner chose for that path. The one exception is *a name in each
    of these languages*: SHACL Core can only say "at least one value in
    French" with a qualified value shape, and a property shape holds one, so
    each language required is its own property shape on the same path,
    `[ sh:qualifiedValueShape [ sh:languageIn ("fr") ] ; sh:qualifiedMinCount
    1 ]`. The reader folds those back into the rule as `requiredLanguages`.

    A path is one IRI, or an alternative of IRIs: a definition is
    skos:definition or rdfs:comment, because the small template describes
    its classes with rdfs:comment and the form writes skos:definition, and a
    model check that failed every template class would teach the wrong
    thing.

    Anything else a shape may say in SHACL -- sh:or, a SPARQL constraint, a
    node target, a nested shape, a sequence path, a severity on one rule --
    is legal and validated (5.5), but the form does not edit it: the shape
    comes back `editable: false` with one phrase per part it cannot edit
    ("uses sh:or"), and the commands refuse to touch it, so an expert's
    Turtle is never rewritten by a form that did not understand it.

    Which shapes are listed: every node shape that has a target, and every
    sh:NodeShape no other shape refers to. A shape only reached through
    another (`sh:node ex:AddressShape`) is part of that shape, not a row.

    rdfs:label reads *name*, or *name (label)* when the model has an
    attribute or relationship itself called "name", so the rule editor
    never offers two paths with one word (Stage B, follow-up 4).

    Suggestions read the model with its resolved imports: the attributes and
    relationships whose start is the class or one of its parents, their
    *one value only*, and names and definitions. A suggestion whose every
    part an existing rule on its path already says is not offered again.

INPUTS / INPUT SOURCES
    - The shapes document's graph, and the model's graph (with its imports
      merged when they are resolved) for names, classes and properties.
    - The project's languages, primary first.

EXPECTED OUTPUT
    - listed_shapes(shapes) -> node shapes in list order.
    - read_shape(shapes, node, names) -> the form's structure for one shape.
    - suggestions(model, shapes, target, shape, ...) -> {paths, suggestions}.
================================================================================
"""

from __future__ import annotations

import re
from typing import Callable, Optional

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

from .graph_builder import pick_label_in, prefixed

SH = Namespace("http://www.w3.org/ns/shacl#")

TARGETS = (SH.targetClass, SH.targetNode, SH.targetSubjectsOf, SH.targetObjectsOf)

# What the form writes on a node shape, and on one rule's property shape.
NODE_PREDICATES = {RDF.type, RDFS.label, SH.targetClass, SH.severity, SH.message, SH.property}
RULE_PREDICATES = {
    SH.path, SH.minCount, SH.maxCount, SH.datatype, SH["class"], SH.minLength, SH.maxLength,
    SH.pattern, SH.minInclusive, SH.maxInclusive, SH["in"], SH.languageIn, SH.uniqueLang,
    SH.severity,
}
# A required language's property shape: its path, the qualified shape, the count.
QUALIFIED_PREDICATES = {SH.path, SH.qualifiedValueShape, SH.qualifiedMinCount, SH.severity}

# Shapes refer to shapes through these; a shape reached only so is not a row.
NESTING = (SH.node, SH.property, SH.qualifiedValueShape, SH["not"], SH["and"], SH["or"], SH.xone)

# A definition, either way it is written (see BASIC IDEA).
DEFINITION_PATH = (SKOS.definition, RDFS.comment)

# The seven value types of E-6, by the name the form uses.
DATATYPES = {
    "string": XSD.string,
    "integer": XSD.integer,
    "decimal": XSD.decimal,
    "boolean": XSD.boolean,
    "date": XSD.date,
    "dateTime": XSD.dateTime,
    "anyURI": XSD.anyURI,
}
_DATATYPE_NAMES = {v: k for k, v in DATATYPES.items()}

# The types a number or date range is written in by the form.
_BOUND_TYPES = {XSD.integer, XSD.decimal, XSD.date, XSD.dateTime}

SEVERITIES = {SH.Violation: "violation", SH.Warning: "warning", SH.Info: "info"}

Names = Callable[[URIRef], str]


def shape_id(node) -> str:
    """How the interface names a shape: its IRI, or _:id for a blank node,
    which is stable while the document is open and not re-parsed."""
    return f"_:{node}" if isinstance(node, BNode) else str(node)


def find_shape(shapes: Graph, ident: str):
    """The node a shape id names, or None when the document has no such shape."""
    if not isinstance(ident, str) or not ident:
        return None
    node = BNode(ident[2:]) if ident.startswith("_:") else URIRef(ident)
    return node if node in set(listed_shapes(shapes)) else None


def _referenced(shapes: Graph) -> set:
    """Every node another shape refers to: nested shapes and list members."""
    found = set()
    for predicate in NESTING:
        for _, value in shapes.subject_objects(predicate):
            if predicate in (SH["and"], SH["or"], SH.xone) and isinstance(value, BNode):
                try:
                    found.update(Collection(shapes, value))
                except Exception:  # a malformed list: nothing to add
                    pass
            else:
                found.add(value)
    return found


def listed_shapes(shapes: Graph) -> list:
    """The node shapes the Shapes view lists, ordered by name then id."""
    candidates = set(shapes.subjects(RDF.type, SH.NodeShape))
    targeted = {s for p in TARGETS for s in shapes.subjects(p, None)}
    candidates |= targeted
    referenced = _referenced(shapes)
    listed = [
        s for s in candidates
        if (s, SH.path, None) not in shapes and (s in targeted or s not in referenced)
    ]

    def order(node):
        label = shapes.value(node, RDFS.label)
        return (str(label).casefold() if label is not None else "~", shape_id(node))

    return sorted(listed, key=order)


def _list(shapes: Graph, node) -> Optional[list]:
    try:
        return list(Collection(shapes, node)) if isinstance(node, BNode) or node == RDF.nil else None
    except Exception:
        return None


def path_of(shapes: Graph, node) -> Optional[tuple]:
    """A path the form edits, as a tuple of IRIs: one IRI, or the IRIs of an
    sh:alternativePath. None for any other path (a sequence, an inverse)."""
    if isinstance(node, URIRef):
        return (node,)
    if isinstance(node, BNode):
        props = set(shapes.predicates(node, None))
        if props == {SH.alternativePath}:
            members = _list(shapes, shapes.value(node, SH.alternativePath))
            if members and all(isinstance(m, URIRef) for m in members):
                return tuple(members)
    return None


def _name_taken(model: Graph, languages: list) -> bool:
    """True when an attribute or relationship of the model is itself called
    "name": then rdfs:label reads *name (label)*, or the rule editor and the
    sentences would offer two paths both called "name" (Stage A follow-up 4).
    Index lookups on the label, never a scan of every property."""
    for text in ("name", "Name"):
        for literal in (Literal(text), *(Literal(text, lang=tag) for tag in languages)):
            for subject in model.subjects(RDFS.label, literal):
                types = set(model.objects(subject, RDF.type))
                if types & {OWL.DatatypeProperty, OWL.ObjectProperty}:
                    return True
    return False


def path_label(model: Graph, path: tuple, languages: list) -> str:
    """The path in the learner's words: "definition", "name", or its label."""
    if tuple(path) == DEFINITION_PATH:
        return "definition"
    if len(path) == 1:
        iri = path[0]
        if iri == RDFS.label:
            return "name (label)" if _name_taken(model, languages) else "name"
        if iri == SKOS.prefLabel:
            return "preferred name"
        if iri == SKOS.definition:
            return "definition"
        if iri == RDFS.comment:
            return "description"
        return pick_label_in(model, iri, languages)[0]
    return " or ".join(path_label(model, (p,), languages) for p in path)


def path_kind(model: Graph, path: tuple) -> str:
    """What the rule editor offers for a path (5.3): its kind in the model."""
    if tuple(path) == DEFINITION_PATH or path == (SKOS.definition,) or path == (RDFS.comment,):
        return "definition"
    if path in ((RDFS.label,), (SKOS.prefLabel,), (SKOS.altLabel,)):
        return "name"
    if len(path) == 1:
        types = set(model.objects(path[0], RDF.type))
        if OWL.ObjectProperty in types:
            return "relationship"
        if OWL.DatatypeProperty in types:
            return "attribute"
    return "other"


def _literal_number(value) -> Optional[int]:
    if isinstance(value, Literal):
        try:
            number = value.toPython()
        except Exception:
            return None
        if isinstance(number, int) and not isinstance(number, bool):
            return number
    return None


def value_json(term, names: Names) -> dict:
    """A value of an sh:in list as the form shows and sends it."""
    if isinstance(term, Literal):
        if term.language:
            return {"kind": "text", "value": str(term), "lang": term.language}
        name = _DATATYPE_NAMES.get(term.datatype)
        if term.datatype is None or name == "string":
            return {"kind": "typed", "value": str(term), "datatype": "xsd:string"}
        return {"kind": "typed", "value": str(term), "datatype": f"xsd:{name}" if name else str(term.datatype)}
    return {"kind": "link", "value": str(term), "label": names(term) if isinstance(term, URIRef) else str(term)}


def datatype_json(iri) -> Optional[str]:
    if iri is None:
        return None
    if iri in _DATATYPE_NAMES:
        return f"xsd:{_DATATYPE_NAMES[iri]}"
    if iri == RDF.langString:
        return "rdf:langString"
    return str(iri)


def _bound_json(term) -> Optional[dict]:
    if not isinstance(term, Literal):
        return None
    return {"value": str(term), "datatype": datatype_json(term.datatype) or "xsd:string"}


def _required_language(shapes: Graph, prop) -> Optional[str]:
    """The language a qualified property shape requires, when it is exactly
    the form's pattern: one qualified shape saying only sh:languageIn (one
    tag), and a qualified minimum of 1."""
    if set(shapes.predicates(prop, None)) - QUALIFIED_PREDICATES:
        return None
    inner = shapes.value(prop, SH.qualifiedValueShape)
    if not isinstance(inner, BNode) or set(shapes.predicates(inner, None)) != {SH.languageIn}:
        return None
    tags = _list(shapes, shapes.value(inner, SH.languageIn))
    if not tags or len(tags) != 1 or not isinstance(tags[0], Literal):
        return None
    if _literal_number(shapes.value(prop, SH.qualifiedMinCount)) != 1:
        return None
    return str(tags[0])


def _phrase(shapes: Graph, predicate) -> str:
    return f"uses {prefixed(shapes, predicate)}"


def read_rules(shapes: Graph, node, model: Graph, names: Names, languages: list) -> tuple[list, list, set]:
    """The rules of a node shape, the parts the form cannot edit, and the
    severities its property shapes carry."""
    unsupported: list[str] = []
    severities: set = set()
    rules: dict[tuple, dict] = {}
    plain: set = set()
    for prop in shapes.objects(node, SH.property):
        if not isinstance(prop, BNode):
            unsupported.append("refers to a rule written elsewhere")
            continue
        path = path_of(shapes, shapes.value(prop, SH.path))
        if path is None:
            unsupported.append("uses a path the form cannot edit")
            continue
        severity = shapes.value(prop, SH.severity)
        severities.add(severity if severity is not None else SH.Violation)
        rule = rules.setdefault(path, {
            "path": [str(p) for p in path],
            "pathLabel": path_label(model, path, languages),
            "pathKind": path_kind(model, path),
        })
        if (prop, SH.qualifiedValueShape, None) in shapes:
            lang = _required_language(shapes, prop)
            if lang is None:
                unsupported.append(_phrase(shapes, SH.qualifiedValueShape))
            else:
                rule.setdefault("requiredLanguages", []).append(lang)
            continue
        extra = set(shapes.predicates(prop, None)) - RULE_PREDICATES
        for predicate in sorted(extra):
            unsupported.append(_phrase(shapes, predicate))
        if path in plain:
            unsupported.append(f"has two rules on {rule['pathLabel']}")
            continue
        plain.add(path)
        _read_constraints(shapes, prop, rule, names, unsupported)
    for rule in rules.values():
        if "requiredLanguages" in rule:
            rule["requiredLanguages"].sort()
    ordered = sorted(rules.values(), key=lambda r: (r["pathLabel"].casefold(), r["path"]))
    return ordered, unsupported, severities


def _read_constraints(shapes: Graph, prop, rule: dict, names: Names, unsupported: list) -> None:
    for key, predicate in (("minCount", SH.minCount), ("maxCount", SH.maxCount),
                           ("minLength", SH.minLength), ("maxLength", SH.maxLength)):
        values = list(shapes.objects(prop, predicate))
        if not values:
            continue
        number = _literal_number(values[0])
        if len(values) > 1 or number is None or number < 0:
            unsupported.append(f"has a {prefixed(shapes, predicate)} the form cannot read")
            continue
        rule[key] = number
    datatype = shapes.value(prop, SH.datatype)
    if datatype is not None:
        # Only the seven types of E-6 (and text in a language): any other is
        # validated, but the form could not send it back (found in review).
        if datatype in _DATATYPE_NAMES or datatype == RDF.langString:
            rule["datatype"] = datatype_json(datatype)
        else:
            unsupported.append(f"uses the type of value {prefixed(shapes, datatype)}")
    cls = shapes.value(prop, SH["class"])
    if cls is not None:
        if isinstance(cls, URIRef):
            rule["class"] = str(cls)
            rule["classLabel"] = names(cls)
        else:
            unsupported.append("points to a class written as an expression")
    pattern = shapes.value(prop, SH.pattern)
    if pattern is not None:
        rule["pattern"] = str(pattern)
    for key, predicate in (("minInclusive", SH.minInclusive), ("maxInclusive", SH.maxInclusive)):
        term = shapes.value(prop, predicate)
        bound = _bound_json(term) if isinstance(term, Literal) and term.datatype in _BOUND_TYPES else None
        if bound is not None:
            rule[key] = bound
        elif (prop, predicate, None) in shapes:
            unsupported.append(f"has a {prefixed(shapes, predicate)} the form cannot read")
    allowed = shapes.value(prop, SH["in"])
    if allowed is not None:
        members = _list(shapes, allowed)
        if members is None:
            unsupported.append("has an sh:in the form cannot read")
        elif any(isinstance(m, Literal) and not m.language and m.datatype is not None
                 and m.datatype not in _DATATYPE_NAMES for m in members):
            unsupported.append("has an allowed value of a type the form does not offer")
        else:
            rule["in"] = [value_json(m, names) for m in members]
    tags = shapes.value(prop, SH.languageIn)
    if tags is not None:
        members = _list(shapes, tags)
        if members is None or not all(isinstance(m, Literal) for m in members):
            unsupported.append("has an sh:languageIn the form cannot read")
        else:
            rule["languageIn"] = [str(m) for m in members]
    unique = shapes.value(prop, SH.uniqueLang)
    if unique is not None:
        rule["uniqueLang"] = bool(unique.toPython()) if isinstance(unique, Literal) else False


def target_json(target, names: Names) -> Optional[dict]:
    if target is None:
        return None
    word = {OWL.Class: "every class", RDFS.Class: "every class", SKOS.Concept: "every concept"}.get(target)
    return {"iri": str(target), "label": names(target), "every": word}


def read_shape(shapes: Graph, node, model: Graph, names: Names, languages: list) -> dict:
    """One listed shape as the form shows it (5.3), or read-only (5.5)."""
    unsupported: list[str] = []
    for predicate in sorted(set(shapes.predicates(node, None)) - NODE_PREDICATES):
        unsupported.append(_phrase(shapes, predicate))
    types = set(shapes.objects(node, RDF.type))
    if types - {SH.NodeShape}:
        unsupported.append("is also a class (an implicit target)")
    targets = list(shapes.objects(node, SH.targetClass))
    if len(targets) > 1:
        unsupported.append("has more than one target class")
    target = targets[0] if targets else None
    if target is not None and not isinstance(target, URIRef):
        unsupported.append("targets a class written as an expression")
        target = None
    label = shapes.value(node, RDFS.label)
    severity = shapes.value(node, SH.severity)
    message = list(shapes.objects(node, SH.message))
    if len(message) > 1:
        unsupported.append("has more than one message")
    rules, rule_unsupported, rule_severities = read_rules(shapes, node, model, names, languages)
    unsupported += rule_unsupported
    own = severity if severity is not None else SH.Violation
    if rule_severities - {own}:
        unsupported.append("has a different severity on one rule")
    if own not in (SH.Violation, SH.Warning):
        unsupported.append(f"has the severity {prefixed(shapes, own)}")
    return {
        "id": shape_id(node),
        "iri": str(node) if isinstance(node, URIRef) else None,
        "name": str(label) if label is not None else (
            prefixed(shapes, node) if isinstance(node, URIRef) else "Unnamed shape"
        ),
        "named": label is not None,
        "target": target_json(target, names),
        "severity": SEVERITIES.get(own, "violation"),
        "message": str(message[0]) if message else None,
        "rules": rules,
        "editable": not unsupported,
        # Each part once, in the order found.
        "unsupported": list(dict.fromkeys(unsupported)),
    }


# ---------------------------------------------------------------------------
# Suggestions from the ontology (5.4)
# ---------------------------------------------------------------------------


def ancestors(model: Graph, cls) -> list:
    """The class and every named superclass, nearest first; a loop is cut."""
    seen = [cls]
    queue = [cls]
    while queue:
        current = queue.pop(0)
        for parent in model.objects(current, RDFS.subClassOf):
            if isinstance(parent, URIRef) and parent not in seen:
                seen.append(parent)
                queue.append(parent)
    return seen


def _name_path(target) -> tuple:
    return (SKOS.prefLabel,) if target == SKOS.Concept else (RDFS.label,)


def paths_for(model: Graph, target, names: Names, languages: list) -> list[dict]:
    """What a rule can be about for this target (5.3): names and definitions,
    then the attributes and relationships whose start is the class or a
    parent, each with what the rule editor needs to offer its kinds."""
    out = []
    name_path = _name_path(target)
    out.append({"path": [str(p) for p in name_path], "label": path_label(model, name_path, languages),
                "kind": "name"})
    out.append({"path": [str(p) for p in DEFINITION_PATH], "label": "definition", "kind": "definition"})
    if target in (OWL.Class, RDFS.Class, SKOS.Concept) or target is None:
        return out
    starts = set(ancestors(model, target))
    seen = set()
    found = []
    for prop, domain in model.subject_objects(RDFS.domain):
        if domain not in starts or not isinstance(prop, URIRef) or prop in seen:
            continue
        types = set(model.objects(prop, RDF.type))
        kind = ("relationship" if OWL.ObjectProperty in types
                else "attribute" if OWL.DatatypeProperty in types else None)
        if kind is None:
            continue
        seen.add(prop)
        rng = model.value(prop, RDFS.range)
        entry = {
            "path": [str(prop)],
            "label": names(prop),
            "kind": kind,
            "functional": (prop, RDF.type, OWL.FunctionalProperty) in model,
        }
        if kind == "attribute":
            entry["datatype"] = datatype_json(rng) if isinstance(rng, URIRef) else None
        else:
            entry["range"] = str(rng) if isinstance(rng, URIRef) else None
            entry["rangeLabel"] = names(rng) if isinstance(rng, URIRef) else None
        found.append(entry)
    found.sort(key=lambda e: (e["kind"] != "attribute", e["label"].casefold(), e["path"]))
    return out + found


def _offered(existing: Optional[dict], rule: dict) -> bool:
    """Not offered when an existing rule on the path already says it all."""
    if existing is None:
        return True
    for key, value in rule.items():
        if key == "path":
            continue
        have = existing.get(key)
        if key in ("requiredLanguages", "languageIn"):
            if not set(value) <= set(have or []):
                return True
        elif have != value:
            return True
    return False


def suggestions(
    model: Graph,
    target,
    existing_rules: list[dict],
    names: Names,
    languages: list,
) -> dict:
    """The paths a rule can be about, and the rules the model suggests (5.4),
    without those an existing rule already says."""
    paths = paths_for(model, target, names, languages)
    primary = languages[0] if languages else "en"
    by_path = {tuple(r["path"]): r for r in existing_rules}
    out: list[dict] = []

    def offer(key: str, rule: dict) -> None:
        if _offered(by_path.get(tuple(rule["path"])), rule):
            out.append({"id": key, "rule": rule})

    name_path = [str(p) for p in _name_path(target)]
    definition = [str(p) for p in DEFINITION_PATH]
    if target == SKOS.Concept:
        offer("names-each-language", {"path": name_path, "requiredLanguages": sorted(languages)})
        offer("definition", {"path": definition, "minCount": 1})
    else:
        offer("name-primary", {"path": name_path, "requiredLanguages": [primary]})
        offer("name-per-language", {"path": name_path, "uniqueLang": True, "languageIn": list(languages)})
        if target in (OWL.Class, RDFS.Class):
            offer("definition", {"path": definition, "minCount": 1})
    for entry in paths:
        if entry["kind"] == "attribute":
            if entry.get("datatype"):
                offer(f"type:{entry['path'][0]}", {"path": entry["path"], "datatype": entry["datatype"]})
            if entry["functional"]:
                offer(f"one:{entry['path'][0]}", {"path": entry["path"], "maxCount": 1})
        elif entry["kind"] == "relationship":
            if entry.get("range"):
                offer(f"class:{entry['path'][0]}", {
                    "path": entry["path"], "class": entry["range"], "classLabel": entry["rangeLabel"],
                })
            if entry["functional"]:
                offer(f"one:{entry['path'][0]}", {"path": entry["path"], "maxCount": 1})
    # The labels the sentences need, so the interface does not ask again.
    labels = {tuple(p["path"]): p for p in paths}
    for item in out:
        known = labels.get(tuple(item["rule"]["path"]))
        item["rule"]["pathLabel"] = known["label"] if known else path_label(
            model, tuple(URIRef(p) for p in item["rule"]["path"]), languages)
        item["rule"]["pathKind"] = known["kind"] if known else "other"
    return {"paths": paths, "suggestions": out}


def local_name(label: str) -> str:
    """Person rules -> PersonRules, for a shape's IRI."""
    words = re.findall(r"[^\W_]+", label, flags=re.UNICODE)
    joined = "".join(w[:1].upper() + w[1:] for w in words)
    return ("_" + joined) if joined[:1].isdigit() else joined
