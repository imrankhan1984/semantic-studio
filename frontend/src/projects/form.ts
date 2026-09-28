/*
================================================================================
FILE: frontend/src/projects/form.ts
================================================================================

SUMMARY
    The New project form's rules, kept out of the component so they can be
    tested without rendering: the defaults a name implies (base IRI and
    prefix), and what makes each field invalid, in a sentence.

BASIC IDEA
    The same rules the server applies in projects.py, restated so the form can
    say what is wrong before anything is sent: Create is disabled with its
    reason until the form is valid (Section 6). The server still checks; this
    is the explanation, not the control.

    Open question 2 closed as recommended: the base IRI defaults to
    http://example.org/<slug>#, editable, and the prefix to the slug.

INPUTS / INPUT SOURCES
    - The form's field values.

EXPECTED OUTPUT
    - Defaults, and a map of field -> sentence for whatever is invalid.
================================================================================
*/

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

export interface NewProjectFields {
  name: string;
  baseIri: string;
  prefix: string;
  primaryLanguage: string;
}

export type FieldErrors = Partial<Record<keyof NewProjectFields, string>>;

export function validate(fields: NewProjectFields): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.name.trim()) errors.name = "Give the project a name.";
  else if (fields.name.trim().length > 120) errors.name = "A name can be at most 120 characters.";
  if (!BASE_IRI.test(fields.baseIri.trim())) {
    errors.baseIri =
      "The base IRI must be an absolute IRI ending in # or /, for example http://example.org/invoices#.";
  }
  if (!PREFIX.test(fields.prefix.trim())) {
    errors.prefix = "The prefix must start with a letter and use only letters, digits, - and _.";
  }
  if (!validLanguageTag(fields.primaryLanguage.trim())) {
    errors.primaryLanguage = "Use a language tag such as en, en-US or fr.";
  }
  return errors;
}

/** The first reason Create is unavailable, in field order, or null. */
export function firstReason(errors: FieldErrors): string | null {
  for (const key of ["name", "baseIri", "prefix", "primaryLanguage"] as const) {
    if (errors[key]) return errors[key]!;
  }
  return null;
}
