/*
================================================================================
FILE: frontend/src/modeling/values.ts
================================================================================

SUMMARY
    Annotation values in the editing form (visual-modeling 5.1.1): the value
    types offered, the default type for a property, and the check that refuses
    an invalid value before anything is sent (AC-2).

BASIC IDEA
    The command layer already refuses an invalid value with a sentence
    (authoring-foundations 5.4.1), and it stays the authority. This is the same
    rule run in the browser, so that "Add" can be unavailable while the value
    is wrong and the sentence can appear as the user types, rather than after
    a round trip. The patterns and the sentences are the server's, copied
    from editing.py's _LEXICAL and check_lexical; if they drift apart, the
    server still refuses and the form shows its sentence instead.

    A value type is what the user chooses ("Date"); a value is what the
    command takes ({kind: "typed", value, datatype: "xsd:date"}). The seven
    datatypes are the command layer's; text in a language and a link are the
    other two kinds.

INPUTS / INPUT SOURCES
    - What the user typed, the chosen type, and a language tag.

EXPECTED OUTPUT
    - VALUE_TYPES, typeKey/typeFromKey, valueProblem (a sentence or null),
      toValue, describeValue (the kind shown beside an existing value).
================================================================================
*/

import { validLanguageTag } from "../projects/form";
import type { AnnotationValue, ValueType } from "../types";

/** The seven datatypes the command layer offers, by local name. */
export const DATATYPES = ["string", "integer", "decimal", "boolean", "date", "dateTime", "anyURI"] as const;
export type Datatype = (typeof DATATYPES)[number];

/** Every type the form offers, keyed for a <select>, with the words it shows. */
export const VALUE_TYPES: { key: string; label: string; type: ValueType }[] = [
  { key: "text", label: "Text in a language", type: { kind: "text" } },
  { key: "xsd:string", label: "Text without a language", type: { kind: "typed", datatype: "xsd:string" } },
  { key: "xsd:integer", label: "Whole number", type: { kind: "typed", datatype: "xsd:integer" } },
  { key: "xsd:decimal", label: "Decimal number", type: { kind: "typed", datatype: "xsd:decimal" } },
  { key: "xsd:boolean", label: "Yes or no", type: { kind: "typed", datatype: "xsd:boolean" } },
  { key: "xsd:date", label: "Date", type: { kind: "typed", datatype: "xsd:date" } },
  { key: "xsd:dateTime", label: "Date and time", type: { kind: "typed", datatype: "xsd:dateTime" } },
  { key: "xsd:anyURI", label: "Web address, as text", type: { kind: "typed", datatype: "xsd:anyURI" } },
  { key: "link", label: "Link to a resource", type: { kind: "link" } },
];

const XSD = "http://www.w3.org/2001/XMLSchema#";

/** The datatype's local name, from xsd:date, the full IRI or date; else null. */
export function datatypeName(datatype: string | null | undefined): Datatype | null {
  if (!datatype) return null;
  const local = datatype.startsWith("xsd:")
    ? datatype.slice(4)
    : datatype.startsWith(XSD)
      ? datatype.slice(XSD.length)
      : datatype;
  return (DATATYPES as readonly string[]).includes(local) ? (local as Datatype) : null;
}

/** The <select> key for a type. */
export function typeKey(type: ValueType): string {
  if (type.kind !== "typed") return type.kind;
  return `xsd:${datatypeName(type.datatype) ?? "string"}`;
}

export function typeFromKey(key: string): ValueType {
  return (VALUE_TYPES.find((t) => t.key === key) ?? VALUE_TYPES[0]).type;
}

// editing.py's _LEXICAL, pattern for pattern.
const TZ = "(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?";
const DATE = "(-?[0-9]{4,})-([0-9]{2})-([0-9]{2})";
const LEXICAL: Record<string, { pattern: RegExp; name: string; expected: string }> = {
  integer: { pattern: /^[+-]?[0-9]+$/, name: "integer", expected: "a whole number such as 42" },
  decimal: {
    pattern: /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/,
    name: "decimal",
    expected: "a number such as 4.5",
  },
  boolean: { pattern: /^(true|false|1|0)$/, name: "boolean", expected: "true or false" },
  date: { pattern: new RegExp(`^${DATE}${TZ}$`), name: "date", expected: "YYYY-MM-DD" },
  dateTime: {
    pattern: new RegExp(`^${DATE}T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?${TZ}$`),
    name: "date and time",
    expected: "YYYY-MM-DDThh:mm:ss",
  },
};

function realDate(year: string, month: string, day: string): boolean {
  // As the server: a year Date cannot hold is checked against a leap year.
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const safe = y >= 1 && y <= 9999 ? y : 2000;
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(safe, m, 0)).getUTCDate();
  return d <= days;
}

/** Why a value cannot be sent as this type, in the server's words; null if it can. */
export function valueProblem(type: ValueType, raw: string, lang?: string): string | null {
  if (type.kind === "text") {
    if (!raw.trim()) return "A text value cannot be empty.";
    if (lang !== undefined && !validLanguageTag(lang)) {
      return `"${lang}" is not a well-formed language tag (for example en or fr).`;
    }
    return null;
  }
  if (type.kind === "link") {
    if (!raw.trim()) return "A link cannot be empty.";
    if (/\s/.test(raw.trim())) return "A link cannot contain a space.";
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw.trim())) {
      return `"${raw.trim()}" is not a full address (for example https://example.org/page).`;
    }
    return null;
  }
  const name = datatypeName(type.datatype) ?? "string";
  if (name === "string") return null;
  if (name === "anyURI") {
    return !raw || /\s/.test(raw) ? `"${raw}" is not a valid URI (it is empty or contains a space).` : null;
  }
  const rule = LEXICAL[name];
  const match = rule.pattern.exec(raw);
  let ok = match !== null;
  if (ok && (name === "date" || name === "dateTime")) ok = realDate(match![1], match![2], match![3]);
  if (ok && name === "dateTime") {
    const [h, m, s] = [Number(match![4]), Number(match![5]), Number(match![6])];
    ok = (h < 24 && m < 60 && s < 60) || (h === 24 && m === 0 && s === 0);
  }
  return ok ? null : `"${raw}" is not a valid ${rule.name} (expected ${rule.expected}).`;
}

/** The value the command takes. Text keeps its language; a link and a typed
 *  value are sent as typed, trimmed only where spaces cannot be meant. */
export function toValue(type: ValueType, raw: string, lang?: string): AnnotationValue {
  if (type.kind === "text") return { kind: "text", value: raw, ...(lang ? { lang } : {}) };
  if (type.kind === "link") return { kind: "link", value: raw.trim() };
  const name = datatypeName(type.datatype) ?? "string";
  return { kind: "typed", value: name === "string" ? raw : raw.trim(), datatype: `xsd:${name}` };
}

/** The type of an existing value, for editing it in place. */
export function typeOfValue(value: AnnotationValue): ValueType {
  if (value.kind === "typed") return { kind: "typed", datatype: value.datatype ?? "xsd:string" };
  return { kind: value.kind };
}

const KIND_WORDS: Record<Datatype, string> = {
  string: "text",
  integer: "whole number",
  decimal: "number",
  boolean: "yes or no",
  date: "date",
  dateTime: "date and time",
  anyURI: "web address",
};

/** What kind of value this is, in words: "text (fr)", "date", "link". */
export function describeValue(value: AnnotationValue): string {
  if (value.kind === "text") return value.lang ? `text (${value.lang})` : "text";
  if (value.kind === "link") return "link";
  const name = datatypeName(value.datatype);
  return name ? KIND_WORDS[name] : (value.datatype ?? "text");
}
