/*
================================================================================
FILE: frontend/src/projects/form.ts
================================================================================

SUMMARY
    The New project form's rules, kept out of the component so they can be
    tested without rendering: the two kinds of project and the templates each
    offers (relationships 5.1, D-089), the defaults a name implies (base IRI
    and prefix), and what makes each field invalid, in a sentence.

BASIC IDEA
    The same rules the server applies in projects.py, restated so the form can
    say what is wrong before anything is sent: Create is disabled with its
    reason until the form is valid (Section 6). The server still checks; this
    is the explanation, not the control.

    Open question 2 closed as recommended: the base IRI defaults to
    http://example.org/<slug>#, editable, and the prefix to the slug.

    With a namespace set in Settings → Naming (design-checks 5.2) the base
    IRI comes from the Address group instead: a layer, its area, a subject
    following the name, a type by kind, and a data domain following the
    area. addressLines gives the three lines the group shows; the base IRI
    still follows the Model line until edited, and an edited base keeps the
    pattern's Shapes and Data lines only while it ends in -<type>#. The
    names are naming/address.ts's rule, the server's naming.py restated.

    The description (reference-ontologies 5.4 item 3) defaults to a
    sentence about the name and one per reference ontology chosen, and the
    project's prefix may not be a chosen reference's (item 4): the server's
    words, so the form and a refusal say the same thing.

INPUTS / INPUT SOURCES
    - The form's field values; the reference ontologies chosen.

EXPECTED OUTPUT
    - KIND_CHOICES; defaults, and a map of field -> sentence for whatever is
      invalid; the first reason Create is unavailable; defaultDescription.
================================================================================
*/

import {
  projectAddresses,
  segmentError,
  slug,
  type ArtifactType,
  type Layer,
} from "../naming/address";
import type { ProjectKind, ProjectTemplate, ReferenceOntology } from "../types";

/** The two kinds a project can be, asked first (relationships 5.1). The
 *  sentences are the spec's, word for word: they are what a learner reads to
 *  choose, so a paraphrase here is a change to the product. */
export const KIND_CHOICES: {
  kind: ProjectKind;
  label: string;
  sentence: string;
  templates: { value: ProjectTemplate; label: string }[];
}[] = [
  {
    kind: "ontology",
    label: "Ontology",
    sentence:
      "Classes of things, their attributes and the relationships between them. For example: a Person works for an Organization.",
    templates: [
      { value: "empty", label: "Empty ontology" },
      { value: "small", label: "Small ontology (two classes, one relationship)" },
    ],
  },
  {
    kind: "taxonomy",
    label: "Taxonomy",
    sentence:
      "A vocabulary of concepts arranged from broad to narrow, with related terms. For example: Apple is narrower than Fruit.",
    templates: [
      { value: "taxonomy-empty", label: "Empty taxonomy (one concept scheme)" },
      { value: "taxonomy-small", label: "Small taxonomy (a scheme with a few concepts)" },
    ],
  },
];

export const CHOOSE_KIND = "Choose Ontology or Taxonomy.";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function defaultBaseIri(name: string): string {
  return `http://example.org/${slugify(name)}#`;
}

export function defaultPrefix(name: string): string {
  let letters = slugify(name).replace(/[^a-z0-9]/g, "");
  if (!letters || !/^[a-z]/.test(letters)) letters = "p" + letters;
  return letters.slice(0, 20);
}

// The server's patterns (projects.py), restated.
const BASE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]*[#/]$/;
const PREFIX = /^[A-Za-z]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;
const LANG_TAG =
  /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/;

export function validLanguageTag(tag: string): boolean {
  return LANG_TAG.test(tag);
}

/** The description's limit, the server's (projects.DESCRIPTION_MAX). */
export const DESCRIPTION_MAX = 2000;

/** What the description says until the person edits it (5.4 item 3): the
 *  name, then each chosen reference's sentence, in the order offered. */
export function defaultDescription(name: string, chosen: ReferenceOntology[]): string {
  const parts = name.trim() ? [`An ontology for ${name.trim()}.`] : [];
  return [...parts, ...chosen.map((r) => r.sentence)].join(" ");
}

export interface NewProjectFields {
  name: string;
  baseIri: string;
  prefix: string;
  primaryLanguage: string;
  description?: string;
}

export type FieldErrors = Partial<Record<keyof NewProjectFields, string>>;

export function validate(fields: NewProjectFields, chosen: ReferenceOntology[] = []): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.name.trim()) errors.name = "Give the project a name.";
  else if (fields.name.trim().length > 120) errors.name = "A name can be at most 120 characters.";
  if (!BASE_IRI.test(fields.baseIri.trim())) {
    errors.baseIri =
      "The base IRI must be an absolute IRI ending in # or /, for example http://example.org/invoices#.";
  }
  if (!PREFIX.test(fields.prefix.trim())) {
    errors.prefix = "The prefix must start with a letter and use only letters, digits, - and _.";
  } else {
    const clash = chosen.find((r) => Object.prototype.hasOwnProperty.call(r.prefixes, fields.prefix.trim()));
    if (clash) errors.prefix = `${fields.prefix.trim()} is ${clash.title}'s prefix. Choose another for your project.`;
  }
  if (!validLanguageTag(fields.primaryLanguage.trim())) {
    errors.primaryLanguage = "Use a language tag such as en, en-US or fr.";
  }
  if ((fields.description ?? "").trim().length > DESCRIPTION_MAX) {
    errors.description = `A description can be at most ${DESCRIPTION_MAX.toLocaleString("en")} characters.`;
  }
  return errors;
}

/** The first reason Create is unavailable, in field order, or null. */
export function firstReason(errors: FieldErrors): string | null {
  for (const key of ["name", "description", "baseIri", "prefix", "primaryLanguage"] as const) {
    if (errors[key]) return errors[key]!;
  }
  return null;
}

/* --- the Address group (design-checks 5.2) ------------------------------- */

/** The layers in the order the radio group offers them, Domain first. */
export const LAYERS: { value: Layer; label: string }[] = [
  { value: "domain", label: "Domain" },
  { value: "core", label: "Core" },
  { value: "app", label: "Application" },
];

/** The area field's label by layer; Core asks for none. "Domain name",
 *  not "Domain": the radio beside it is called Domain, and two controls
 *  with one name are one too many for a screen reader. */
export function areaLabel(layer: Layer): string | null {
  return layer === "domain" ? "Domain name" : layer === "app" ? "Application name" : null;
}

/** The types a project of a kind may be: shapes and mapping never are. A
 *  library copy's kind is the server's to judge, so it is offered all three. */
export function typeChoices(kind: ProjectKind | null): { value: ArtifactType; label: string }[] {
  const all = { ontology: "Ontology", taxonomy: "Taxonomy", vocabulary: "Vocabulary" } as const;
  const values: ("ontology" | "taxonomy" | "vocabulary")[] =
    kind === "ontology" ? ["ontology"] : kind === "taxonomy" ? ["taxonomy", "vocabulary"] : ["ontology", "taxonomy", "vocabulary"];
  return values.map((value) => ({ value, label: all[value] }));
}

/** The subject a name gives until it is edited: Invoices -> invoices. */
export function defaultSubject(name: string): string {
  return slug(name);
}

export interface AddressFields {
  layer: Layer;
  area: string;
  subject: string;
  type: ArtifactType;
  dataDomain: string;
}

export type AddressErrors = Partial<Record<"area" | "subject" | "dataDomain", string>>;

/** Each name in the group under 5.1's rule, the area only where the layer
 *  asks for one. */
export function addressErrors(fields: AddressFields): AddressErrors {
  const errors: AddressErrors = {};
  if (fields.layer !== "core") {
    const e = segmentError(fields.area);
    if (e) errors.area = e;
  }
  const s = segmentError(fields.subject);
  if (s) errors.subject = s;
  const d = segmentError(fields.dataDomain);
  if (d) errors.dataDomain = d;
  return errors;
}

export const OWN_ADDRESS = "You have written your own address; the pattern no longer fills it in.";
export const EXAMPLE_ADDRESS = "Using an example address. Set your organization's namespace in Settings → Naming.";

/** The three lines under the group. `written` is a base IRI typed by hand,
 *  or null while it follows the Model line; `follows` says whether the
 *  pattern still applies (the Shapes and Data lines are then shown and the
 *  group is sent). */
export function addressLines(
  namespace: string,
  fields: AddressFields,
  written: string | null,
): { model: string; shapes: string | null; data: string | null; follows: boolean } {
  const lines = projectAddresses(namespace, fields);
  if (written === null || written === lines.model) return { ...lines, follows: true };
  const suffix = `-${fields.type}#`;
  if (written.endsWith(suffix)) {
    return { model: written, shapes: written.slice(0, -suffix.length) + "-shapes#", data: lines.data, follows: true };
  }
  return { model: written, shapes: null, data: null, follows: false };
}
