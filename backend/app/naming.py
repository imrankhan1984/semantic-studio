"""
================================================================================
FILE: backend/app/naming.py
================================================================================

SUMMARY
    The one address rule (design-checks 5.1, D-124): how an artifact, a term
    and a data item are addressed under an organization's namespace, built
    from their parts and read back into them. New project builds a project's
    three addresses with it, editing.py and snapshots.py mint under the bases
    it gave, and the design checks DC-26 and DC-28 judge an address with it.
    frontend/src/naming/address.ts holds the same rule, and both are tested
    with one table (frontend/src/naming/address.table.json).

BASIC IDEA
    Every address starts at https://w3id.org/ followed by the namespace a
    person types in Settings → Naming: one to three segments, each lowercase
    letters, digits and hyphens, never starting or ending with a hyphen, and
    never a version or a year, since both change and an IRI must not.

      artifact  {ns}/{layer}/{subject}-{type}
                layer: core | domain/{domain} | app/{application}
                type:  ontology | taxonomy | vocabulary | shapes | mapping
      term      {artifact}#{Name}
      data      {ns}/data/{data-domain}/{class}/{id}

    Building checks each part by a full match before it touches an address,
    so nothing typed can close the IRI it is written into; a part refused is
    a NamingError carrying the sentence the form shows. Reading is the other
    direction: an address and its role give back its parts and the list of
    ways it departs from the pattern, each a code with the part that
    departs. Two kinds of departure are told apart because two checks
    report them: the pattern's own (outside the namespace, the layer, the
    type, the term, the data address and its class: DC-26, which needs the
    namespace), and the path's spelling (a capital, an underscore, a
    version: DC-28, which needs none).

    A data item's {id} is its identifier from the system of record,
    lowercased with anything outside a-z, 0-9 and the hyphen turned into a
    hyphen; runs of hyphens are one, and none starts or ends it, or
    INV/10442 would give a segment the rule itself refuses.

    The rule never renames anything. It proposes addresses for what is new;
    an address already written stays as it is, and the checks only say
    where it departs (Section 4, out of scope).

INPUTS / INPUT SOURCES
    - The namespace from settings.py; a project's address group from
      projects.py; addresses from the checks.

EXPECTED OUTPUT
    - namespace_error / segment_error: the refusal sentence, or None.
    - artifact_iri, term_iri, data_base, data_iri, project_addresses: the
      addresses, or NamingError; slug and class_slug for an identifier and
      a class as data address segments.
    - read(address, role, namespace, ...): {"parts": ..., "departures":
      [(code, detail), ...]}; path_departures(address) alone for DC-28.
================================================================================
"""

from __future__ import annotations

import re
from typing import Optional

PREFIX = "https://w3id.org/"

LAYERS = ("core", "domain", "app")
TYPES = ("ontology", "taxonomy", "vocabulary", "shapes", "mapping")
# What a project may be (5.2): shapes and mapping are its companions' types,
# never its own.
PROJECT_TYPES = {"ontology": ("ontology",), "taxonomy": ("taxonomy", "vocabulary")}

# fullmatch, never match: `$` also matches before a trailing newline.
SEGMENT = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
# A segment that is a version or a year: v2, v1-3, 2026. Only whole segments
# for the namespace; a path's spelling is judged by _PATH_VERSION below.
_VERSIONISH = re.compile(r"v[0-9]+(?:-[0-9]+)*|(?:19|20)[0-9]{2}")
# A version inside a path segment, as DC-28 reads it: v2, V2, v1.2, 1.2.0,
# alone or after a hyphen or underscore (invoice-v2, invoice_1.0).
_PATH_VERSION = re.compile(r"(?:^|[-_])(?:[vV][0-9]+(?:[._][0-9]+)*|[0-9]+\.[0-9]+(?:\.[0-9]+)*)(?:$|[-_])")
_ARTIFACT_NAME = re.compile(r"(?P<subject>.+)-(?P<type>" + "|".join(TYPES) + r")")

NAMESPACE_MAX_SEGMENTS = 3

NAMESPACE_REFUSED = (
    "Use lowercase letters, digits and hyphens, with / between parts, "
    "for example acme or acme/research."
)
NAMESPACE_VERSION = "A namespace never holds a version or a date: those change, and an IRI must not."
SEGMENT_REFUSED = "Use lowercase letters, digits and hyphens, for example finance."
SEGMENT_VERSION = "A name in an address never holds a version or a date: those change, and an IRI must not."

# The departures read() reports, by code. The first six are the pattern's
# (DC-26), the last three the path's spelling (DC-28).
DEPARTURES = (
    "outside", "layer", "type", "term", "data", "class",
    "capital", "underscore", "version",
)
PATTERN_DEPARTURES = DEPARTURES[:6]
PATH_DEPARTURES = DEPARTURES[6:]


class NamingError(ValueError):
    """A part the rule refuses, with the sentence the form shows (422)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


# --- the parts ---------------------------------------------------------------


def namespace_error(value: object) -> Optional[str]:
    """Settings → Naming's refusal for a typed namespace, or None."""
    if not isinstance(value, str):
        return NAMESPACE_REFUSED
    segments = value.split("/")
    if not 1 <= len(segments) <= NAMESPACE_MAX_SEGMENTS:
        return NAMESPACE_REFUSED
    if not all(SEGMENT.fullmatch(s) for s in segments):
        return NAMESPACE_REFUSED
    if any(_VERSIONISH.fullmatch(s) for s in segments):
        return NAMESPACE_VERSION
    return None


def segment_error(value: object) -> Optional[str]:
    """The refusal for one name in an address (a domain, an application, a
    subject, a data domain), or None."""
    if not isinstance(value, str) or not SEGMENT.fullmatch(value):
        return SEGMENT_REFUSED
    if _VERSIONISH.fullmatch(value):
        return SEGMENT_VERSION
    return None


def slug(text: str) -> str:
    """An identifier as a data address's last segment: INV/10442 -> inv-10442."""
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def class_slug(iri_or_name: str) -> str:
    """A class as a data address's {class} segment: its local name, its
    words split where a capital follows a lowercase letter or a digit, then
    slugged: Invoice -> invoice, OverdueInvoice -> overdue-invoice."""
    local = re.split(r"[#/]", str(iri_or_name).rstrip("#/"))[-1]
    return slug(re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", local))


def _check(field: str, value: object) -> str:
    error = segment_error(value)
    if error:
        raise NamingError(field, error)
    return value  # type: ignore[return-value]


def namespace_iri(namespace: str) -> str:
    """https://w3id.org/acme/: every address under it starts so."""
    error = namespace_error(namespace)
    if error:
        raise NamingError("namespace", error)
    return f"{PREFIX}{namespace}/"


def layer_path(layer: str, area: str = "") -> str:
    if layer == "core":
        return "core"
    if layer in ("domain", "app"):
        return f"{layer}/{_check('area', area)}"
    raise NamingError("layer", "The layer is core, domain or app.")


# --- building ------------------------------------------------------------------


def artifact_iri(namespace: str, layer: str, area: str, subject: str, type_: str) -> str:
    """https://w3id.org/acme/domain/finance/invoice-ontology"""
    if type_ not in TYPES:
        raise NamingError("type", "The type is ontology, taxonomy, vocabulary, shapes or mapping.")
    return f"{namespace_iri(namespace)}{layer_path(layer, area)}/{_check('subject', subject)}-{type_}"


def term_iri(artifact: str, name: str) -> str:
    return f"{artifact}#{name}"


def data_base(namespace: str, data_domain: str) -> str:
    """https://w3id.org/acme/data/finance/: a row or an example adds
    {class}/{id}."""
    return f"{namespace_iri(namespace)}data/{_check('dataDomain', data_domain)}/"


def data_iri(namespace: str, data_domain: str, cls: str, identifier: str) -> str:
    local = slug(identifier)
    if not local:
        raise NamingError("id", "An identifier needs at least one letter or digit.")
    return f"{data_base(namespace, data_domain)}{_check('class', cls)}/{local}"


def project_addresses(
    namespace: str, layer: str, area: str, subject: str, type_: str, data_domain: str,
    kind: str = "ontology",
) -> dict:
    """New project's three lines (5.2): the model's base, the shapes' base and
    the data base, each checked part by part."""
    allowed = PROJECT_TYPES.get(kind, ())
    if type_ not in allowed:
        raise NamingError(
            "type",
            "An ontology project's type is ontology; a taxonomy's is taxonomy or vocabulary.",
        )
    return {
        "model": artifact_iri(namespace, layer, area, subject, type_) + "#",
        "shapes": artifact_iri(namespace, layer, area, subject, "shapes") + "#",
        "data": data_base(namespace, data_domain),
    }


# --- reading -------------------------------------------------------------------


def _path(address: str) -> str:
    """The path of an address: after the scheme and host, before '#'."""
    rest = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/#?]*", "", address)
    return rest.split("#", 1)[0]


def path_departures(address: str) -> list[tuple[str, str]]:
    """DC-28: a capital, an underscore or a version in the address's path,
    each once, with the segment that holds it. The host is not read (it is
    case-blind) and neither is the name after '#' (DC-04 and DC-05's)."""
    found: dict[str, str] = {}
    for segment in _path(address).split("/"):
        if not segment:
            continue
        if "capital" not in found and re.search(r"[A-Z]", segment):
            found["capital"] = segment
        if "underscore" not in found and "_" in segment:
            found["underscore"] = segment
        if "version" not in found and _PATH_VERSION.search(segment):
            found["version"] = segment
    return [(code, found[code]) for code in PATH_DEPARTURES if code in found]


def _read_artifact(rest: str) -> tuple[dict, list[tuple[str, str]]]:
    segments = rest.rstrip("#/").split("/")
    parts: dict = {}
    out: list[tuple[str, str]] = []
    layered = (
        (len(segments) == 2 and segments[0] == "core")
        or (len(segments) == 3 and segments[0] in ("domain", "app") and SEGMENT.fullmatch(segments[1]))
    )
    if layered:
        parts["layer"] = segments[0]
        parts["area"] = segments[1] if segments[0] != "core" else ""
    else:
        out.append(("layer", "/".join(segments[:-1])))
    named = _ARTIFACT_NAME.fullmatch(segments[-1])
    if named and SEGMENT.fullmatch(named.group("subject")):
        parts["subject"] = named.group("subject")
        parts["type"] = named.group("type")
    else:
        out.append(("type", segments[-1]))
    return parts, out


def read(
    address: str,
    role: str,
    namespace: Optional[str] = None,
    *,
    artifact: Optional[str] = None,
    general_class: Optional[str] = None,
) -> dict:
    """An address's parts and its departures from the pattern.

    `role` is what the address names: "artifact", "term" or "data".
    `namespace` is Settings → Naming's; without one only the path's spelling
    is judged, as DC-26 runs only with a namespace set. `artifact` is the
    document's own address, for a term; `general_class` the slug a data
    item's class segment should be (5.3: the most general own class, never a
    state the thing leaves).
    """
    departures: list[tuple[str, str]] = []
    parts: dict = {}
    if namespace is not None and namespace_error(namespace) is None:
        base = f"{PREFIX}{namespace}/"
        if not address.startswith(base):
            departures.append(("outside", base))
        else:
            rest = address[len(base):]
            if role == "artifact":
                parts, found = _read_artifact(rest)
                departures += found
            elif role == "term":
                artifact_part, hash_, name = address.partition("#")
                if artifact is not None:
                    if artifact_part != artifact.rstrip("#/") or not hash_ or not name:
                        departures.append(("term", artifact.rstrip("#/") + "#"))
                    else:
                        parts = {"artifact": artifact_part, "name": name}
                elif not hash_ or not name:
                    departures.append(("term", "#"))
                else:
                    found_parts, found = _read_artifact(artifact_part[len(base):])
                    if found:
                        departures.append(("term", "#"))
                    else:
                        parts = {"artifact": artifact_part, "name": name, **found_parts}
            elif role == "data":
                segments = rest.split("/")
                if (
                    "#" in rest
                    or len(segments) != 4
                    or segments[0] != "data"
                    or not all(SEGMENT.fullmatch(s) for s in segments[1:])
                ):
                    departures.append(("data", f"{base}data/"))
                else:
                    parts = {"dataDomain": segments[1], "class": segments[2], "id": segments[3]}
                    if general_class is not None and segments[2] != general_class:
                        departures.append(("class", general_class))
            else:
                raise ValueError(f"Unknown role {role!r}.")
    departures += path_departures(address)
    return {"parts": parts, "departures": departures}
