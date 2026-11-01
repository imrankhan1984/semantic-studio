/*
================================================================================
FILE: frontend/src/naming/address.ts
================================================================================

SUMMARY
    The one address rule (design-checks 5.1, D-124), as the page needs it:
    the namespace's refusal for Settings → Naming, a name's refusal for New
    project's Address group, the identifier slug, and the addresses built
    from their parts. backend/app/naming.py holds the same rule; both are
    tested with one table, address.table.json beside this file.

BASIC IDEA
    The page says what is wrong before anything is sent, so Save and Create
    can wait with their reason; the server checks again with naming.py, as
    the page is not the control. Kept out of the components so the rule is
    tested without rendering, as projects/form.ts is.

      artifact  https://w3id.org/{ns}/{layer}/{subject}-{type}
      term      {artifact}#{Name}
      data      https://w3id.org/{ns}/data/{data-domain}/{class}/{id}

    Reading an address back (naming.read) is the server's alone: only the
    checks need it, and they run there.

INPUTS / INPUT SOURCES
    - Typed text: a namespace, a name, an identifier.

EXPECTED OUTPUT
    - Sentences or null; addresses; the three lines of New project.
================================================================================
*/

export const PREFIX = "https://w3id.org/";

export type Layer = "core" | "domain" | "app";
export type ArtifactType = "ontology" | "taxonomy" | "vocabulary" | "shapes" | "mapping";

export const TYPES: ArtifactType[] = ["ontology", "taxonomy", "vocabulary", "shapes", "mapping"];

// The server's patterns (naming.py), restated; anchored, so a trailing
// newline is no match either.
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSIONISH = /^(?:v[0-9]+(?:-[0-9]+)*|(?:19|20)[0-9]{2})$/;
const NAMESPACE_MAX_SEGMENTS = 3;

export const NAMESPACE_REFUSED =
  "Use lowercase letters, digits and hyphens, with / between parts, for example acme or acme/research.";
export const NAMESPACE_VERSION = "A namespace never holds a version or a date: those change, and an IRI must not.";
export const SEGMENT_REFUSED = "Use lowercase letters, digits and hyphens, for example finance.";
export const SEGMENT_VERSION =
  "A name in an address never holds a version or a date: those change, and an IRI must not.";

/** Settings → Naming's refusal for a typed namespace, or null. */
export function namespaceError(value: string): string | null {
  const segments = value.split("/");
  if (segments.length < 1 || segments.length > NAMESPACE_MAX_SEGMENTS) return NAMESPACE_REFUSED;
  if (!segments.every((s) => SEGMENT.test(s))) return NAMESPACE_REFUSED;
  if (segments.some((s) => VERSIONISH.test(s))) return NAMESPACE_VERSION;
  return null;
}

/** The refusal for one name in an address (a domain, an application, a
 *  subject, a data domain), or null. */
export function segmentError(value: string): string | null {
  if (!SEGMENT.test(value)) return SEGMENT_REFUSED;
  if (VERSIONISH.test(value)) return SEGMENT_VERSION;
  return null;
}

/** An identifier as a data address's last segment: INV/10442 -> inv-10442. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function namespaceIri(namespace: string): string {
  return `${PREFIX}${namespace}/`;
}

export function layerPath(layer: Layer, area: string): string {
  return layer === "core" ? "core" : `${layer}/${area}`;
}

/** The address as typed, checked or not: New project shows its lines while
 *  a name is still being typed. Valid parts are the caller's to check. */
export function artifactIri(namespace: string, layer: Layer, area: string, subject: string, type: ArtifactType): string {
  return `${namespaceIri(namespace)}${layerPath(layer, area)}/${subject}-${type}`;
}

export function termIri(artifact: string, name: string): string {
  return `${artifact}#${name}`;
}

export function dataBase(namespace: string, dataDomain: string): string {
  return `${namespaceIri(namespace)}data/${dataDomain}/`;
}

export function dataIri(namespace: string, dataDomain: string, cls: string, id: string): string {
  return `${dataBase(namespace, dataDomain)}${cls}/${slug(id)}`;
}

export interface AddressParts {
  layer: Layer;
  area: string;
  subject: string;
  type: ArtifactType;
  dataDomain: string;
}

/** New project's three lines (5.2): the model, the shapes, the data. */
export function projectAddresses(namespace: string, p: AddressParts): { model: string; shapes: string; data: string } {
  return {
    model: artifactIri(namespace, p.layer, p.area, p.subject, p.type) + "#",
    shapes: artifactIri(namespace, p.layer, p.area, p.subject, "shapes") + "#",
    data: `${dataBase(namespace, p.dataDomain)}{class}/{id}`,
  };
}
