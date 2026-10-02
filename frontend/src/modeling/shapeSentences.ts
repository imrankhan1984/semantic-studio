/*
================================================================================
FILE: frontend/src/modeling/shapeSentences.ts
================================================================================

SUMMARY
    The sentences a SHACL shape is read as (shacl-authoring 5.3, 5.4, 5.7):
    each rule (*must have exactly one name, as text*), the whole shape
    (*Every Person must have exactly one name, as text, and must have a
    birth date, as a date.*), a list row (*Every Person: 3 rules*), a
    result panel's header (*✕ Person rules: 2 of 5 people fail (3
    problems)*), the summary the live region reads after a check, and the
    checks the rule editor makes before Add is allowed.

BASIC IDEA
    Every rule and every result is a sentence in the learner's own names
    (Section 7), so the sentences are built in one place and tested without
    rendering. Names come from the server, already in the display language;
    nothing here reads ontology text as markup or as a pattern. A pattern a
    learner types is checked by constructing a RegExp from it -- their own
    input, never ontology text -- so a mistake is caught before it is sent.

    A rule's sentence is a head and its qualifiers. The head says how many
    (*must have a*, *may have at most one*, *must have between 1 and 3*); a
    relationship reads as its own words instead (*works for an
    Organization, at most once*), since a relationship's name is a verb. The
    qualifiers say what each value must be (*as a date*, *of at most 20
    characters*, *one of: active, retired*).

INPUTS / INPUT SOURCES
    - Rules and shapes as the server reads them (ShapeRule, ShapeForm), and
      panels as it reports them (ValidationPanel).

EXPECTED OUTPUT
    - ruleSentence, shapeSentence, rowSentence, panelHeader, panelName,
      validationSummary, ruleProblem, languageName, plural; and article,
      pathWords, mustPhrase and dateTimeBound, Stage B's follow-ups 1 and 5:
      a relationship read after *must* (*must work for*, *must be member
      of*), a minimum of 0 left unsaid, a type and its length one phrase,
      a rule without a label named by its path.
================================================================================
*/

import type { PanelState, ShapeForm, ShapeRule, ValidationPanel, ValidationResult } from "../types";

const DATATYPE_WORDS: Record<string, string> = {
  "xsd:string": "text",
  "rdf:langString": "text in a language",
  "xsd:integer": "a whole number",
  "xsd:decimal": "a number",
  "xsd:boolean": "true or false",
  "xsd:date": "a date",
  "xsd:dateTime": "a date and time",
  "xsd:anyURI": "a web address",
};

/** The seven value types of E-6, as the rule editor offers them. */
export const OFFERED_TYPES: { value: string; label: string }[] = [
  { value: "xsd:string", label: "Text" },
  { value: "xsd:integer", label: "Whole number" },
  { value: "xsd:decimal", label: "Number" },
  { value: "xsd:boolean", label: "True or false" },
  { value: "xsd:date", label: "Date" },
  { value: "xsd:dateTime", label: "Date and time" },
  { value: "xsd:anyURI", label: "Web address" },
];

const LANGUAGES: Record<string, string> = {
  ar: "Arabic", ca: "Catalan", cs: "Czech", da: "Danish", de: "German", el: "Greek",
  en: "English", es: "Spanish", fi: "Finnish", fr: "French", he: "Hebrew", hi: "Hindi",
  hu: "Hungarian", it: "Italian", ja: "Japanese", ko: "Korean", la: "Latin", nb: "Norwegian",
  nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sv: "Swedish", tr: "Turkish", uk: "Ukrainian", zh: "Chinese",
};

export function languageName(tag: string): string {
  return LANGUAGES[tag.split("-")[0].toLowerCase()] ?? tag;
}

const IRREGULAR: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  class: "classes",
};

/** The plural of a noun phrase's last word. A phrase that says which one in
 *  brackets, *name (label)*, is the word before them: *names (label)*. */
export function plural(phrase: string): string {
  const note = phrase.endsWith(")") ? phrase.lastIndexOf(" (") : -1;
  if (note > 0) return `${plural(phrase.slice(0, note))}${phrase.slice(note)}`;
  const at = phrase.lastIndexOf(" ");
  const head = at >= 0 ? phrase.slice(0, at + 1) : "";
  const last = phrase.slice(at + 1);
  const lower = last.toLowerCase();
  let out: string;
  if (lower in IRREGULAR) {
    out = IRREGULAR[lower];
    if (last[0] && last[0] !== last[0].toLowerCase()) out = out[0].toUpperCase() + out.slice(1);
  } else if (/[^aeiou]y$/.test(lower)) out = last.slice(0, -1) + "ies";
  else if (/(s|x|z|ch|sh)$/.test(lower)) out = last + "es";
  else out = last + "s";
  return head + out;
}

export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** What a rule is about, in words: its label, or the path's last name when
 *  it has none -- never "undefined" (Stage A follow-up 5). */
export function pathWords(rule: Pick<ShapeRule, "path" | "pathLabel">): string {
  if (rule.pathLabel) return rule.pathLabel;
  const names = rule.path.map((iri) => iri.slice(Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1) || iri);
  return names.join(" or ") || "value";
}

/** A date and time as the server reads one: a field that shows no seconds
 *  when they are zero gives "2020-01-01T10:00", which needs ":00". */
export function dateTimeBound(value: string): string {
  return /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

/** A relationship's name after *must*, so a shape reads as a sentence
 *  (follow-up 5): *works for* -> *work for*, *has part* -> *have part*,
 *  *is part of* -> *be part of*, and a name that is not a verb, *member
 *  of*, -> *be member of*. */
export function mustPhrase(label: string): string {
  const [first, ...rest] = label.split(" ");
  const tail = rest.length ? ` ${rest.join(" ")}` : "";
  const lower = first.toLowerCase();
  if (lower === "is" || lower === "are") return `be${tail}`;
  if (lower === "has") return `have${tail}`;
  if (rest.length && /^[a-z]+ies$/.test(lower)) return `${first.slice(0, -3)}y${tail}`;
  if (rest.length && /^[a-z]+(ch|sh|ss|x)es$/.test(lower)) return `${first.slice(0, -2)}${tail}`;
  if (rest.length && /^[a-z]{3,}[^su]s$/.test(lower)) return `${first.slice(0, -1)}${tail}`;
  return `be ${label}`;
}

function listWords(items: string[], last = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

function typeWord(datatype: string): string {
  return DATATYPE_WORDS[datatype] ?? `of the type ${datatype}`;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function valueWord(v: { value: string; label?: string; kind: string }): string {
  return v.kind === "link" ? v.label ?? v.value : v.value;
}

/** What each value must be, in the order a learner reads them. */
function qualifiers(rule: ShapeRule, relationship: boolean): string[] {
  const out: string[] = [];
  if (rule.datatype) out.push(`as ${typeWord(rule.datatype)}`);
  if (rule.class && !relationship) out.push(`pointing to ${article(rule.classLabel ?? rule.class)} ${rule.classLabel ?? rule.class}`);
  const { minLength: lo, maxLength: hi } = rule;
  if (lo !== undefined && hi !== undefined) out.push(`of ${lo} to ${hi} characters`);
  else if (lo !== undefined) out.push(`of at least ${lo} ${lo === 1 ? "character" : "characters"}`);
  else if (hi !== undefined) out.push(`of at most ${hi} ${hi === 1 ? "character" : "characters"}`);
  if (rule.pattern) out.push(`matching the pattern ${rule.pattern}`);
  const low = rule.minInclusive?.value;
  const high = rule.maxInclusive?.value;
  if (low !== undefined && high !== undefined) out.push(`between ${low} and ${high}`);
  else if (low !== undefined) out.push(`at least ${low}`);
  else if (high !== undefined) out.push(`at most ${high}`);
  if (rule.in && rule.in.length) out.push(`one of: ${rule.in.map(valueWord).join(", ")}`);
  if (rule.languageIn && rule.languageIn.length) {
    out.push(`only in ${listWords(rule.languageIn.map(languageName), "or")}`);
  }
  if (rule.uniqueLang) out.push("one per language");
  return out;
}

/** One rule, as the form lists it and the editor reads it back (5.3). */
export function ruleSentence(rule: ShapeRule): string {
  const label = pathWords(rule);
  // At least 0 says nothing: *between 0 and 3* reads *at most 3* (follow-up 5).
  const min = rule.minCount === 0 ? undefined : rule.minCount;
  const max = rule.maxCount;
  const required = rule.requiredLanguages ?? [];
  if (rule.pathKind === "relationship") {
    const to = rule.class ? ` ${article(rule.classLabel ?? rule.class)} ${rule.classLabel ?? rule.class}` : "";
    let count = "";
    if (min !== undefined && max !== undefined && min === max) count = `exactly ${times(min)}`;
    else if (min !== undefined && max !== undefined) count = `between ${min} and ${max} times`;
    else if (min !== undefined && min > 0) count = min === 1 ? "at least once" : `at least ${min} times`;
    else if (max !== undefined) count = `at most ${times(max)}`;
    const head = `${label}${to || " something"}`;
    return [head, count, ...qualifiers(rule, true)].filter(Boolean).join(", ");
  }
  let head: string;
  if (min === 1 && max === 1) head = `must have exactly one ${label}`;
  else if (min !== undefined && max !== undefined && min === max) head = `must have exactly ${min} ${plural(label)}`;
  else if (min !== undefined && max !== undefined) head = `must have between ${min} and ${max} ${plural(label)}`;
  else if (min !== undefined && min > 0) head = min === 1 ? `must have ${article(label)} ${label}` : `must have at least ${min} ${plural(label)}`;
  else if (max === 1) head = `may have at most one ${label}`;
  else if (max !== undefined) head = `may have at most ${max} ${plural(label)}`;
  else if (required.length) head = `must have ${article(label)} ${label}`;
  else head = `may have ${plural(label)}`;
  if (required.length) {
    head += ` in ${listWords(required.map(languageName))}`;
  }
  const quals = qualifiers(rule, false);
  // A type and the length after it are one phrase: *as text of at most 20
  // characters*, not *as text, of at most* (follow-up 5).
  if (rule.datatype && quals.length > 1 && quals[1].startsWith("of ")) {
    quals.splice(0, 2, `${quals[0]} ${quals[1]}`);
  }
  // "may have phone numbers, each text of at most 20 characters".
  if (quals.length && (max === undefined || max > 1) && !(min === 1 && max === 1)) {
    quals[0] = `each ${quals[0].replace(/^as /, "")}`;
  }
  return [head, ...quals].join(", ");
}

/** Who a shape is about: *Every Person*, *Every class*, *Every concept*. */
export function everyWord(shape: Pick<ShapeForm, "target">): string {
  if (!shape.target) return "Every match";
  if (shape.target.every) return shape.target.every[0].toUpperCase() + shape.target.every.slice(1);
  return `Every ${shape.target.label}`;
}

/** The whole shape read back, built from its rules (5.3). */
export function shapeSentence(shape: Pick<ShapeForm, "target" | "rules">): string {
  const who = everyWord(shape);
  if (!shape.rules.length) return `${who}: no rules yet.`;
  const parts = shape.rules.map((rule) =>
    rule.pathKind === "relationship" ? `must ${mustPhrase(ruleSentence(rule))}` : ruleSentence(rule),
  );
  // Rules carry their own commas, so the last one is joined by ", and":
  // *…exactly one name, as text, and must work for an Organization*
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts[0];
  return `${who} ${joined}.`;
}

/** A list row's short sentence (5.1): *Every Person: 3 rules*. */
export function rowSentence(shape: Pick<ShapeForm, "target" | "rules">): string {
  const n = shape.rules.length;
  return `${everyWord(shape)}: ${n === 1 ? "1 rule" : `${n} rules`}`;
}

/** The word a result is said with, beside its colour: never colour alone. */
export const STATE_WORDS: Record<PanelState, string> = {
  fails: "Fails",
  passes: "Passes",
  warnings: "Warnings",
  nothing: "Nothing to check",
  error: "Could not run",
};

export const STATE_SIGNS: Record<PanelState, string> = {
  fails: "✕",
  passes: "✓",
  warnings: "!",
  nothing: "–",
  error: "",
};

/** A panel's header text after its sign (5.7). */
export function panelHeader(panel: ValidationPanel): string {
  const one = panel.target?.one ?? "match";
  const many = panel.target?.many ?? "matches";
  switch (panel.state) {
    case "fails": {
      const problems = panel.problemCount === 1 ? "1 problem" : `${panel.problemCount.toLocaleString()} problems`;
      const of = `${panel.failingCount.toLocaleString()} of ${panel.focusCount.toLocaleString()} ${panel.focusCount === 1 ? one : many}`;
      return `${panel.name}: ${of} ${panel.failingCount === 1 ? "fails" : "fail"} (${problems})`;
    }
    case "passes":
      return panel.focusCount === 1
        ? `${panel.name}: the one ${one} passes`
        : `${panel.name}: all ${panel.focusCount.toLocaleString()} ${many} pass`;
    case "warnings":
      return `${panel.name}: ${panel.warningCount === 1 ? "1 warning" : `${panel.warningCount.toLocaleString()} warnings`}`;
    case "nothing":
      return `${panel.name}: no ${panel.target?.label ?? "match"} in the data yet`;
    case "error":
      return `${panel.name}: this shape could not be checked`;
  }
}

/** A panel's accessible name: the state word, then the header with counts. */
export function panelName(panel: ValidationPanel): string {
  return `${STATE_WORDS[panel.state]}. ${panelHeader(panel)}`;
}

/** What the live region says after a run (Section 6). */
export function validationSummary(result: ValidationResult): string {
  if (result.stopped) {
    return `The check took too long and was stopped (${result.shapeCount} shapes, ${result.statements.toLocaleString()} statements).`;
  }
  const n = result.shapes.length;
  if (n === 0) return "There are no shapes to check yet.";
  const counts: Partial<Record<PanelState, number>> = {};
  for (const p of result.shapes) counts[p.state] = (counts[p.state] ?? 0) + 1;
  const words: [PanelState, string, string][] = [
    ["passes", "passes", "pass"],
    ["fails", "fails", "fail"],
    ["warnings", "has warnings", "have warnings"],
    ["nothing", "has nothing to check", "have nothing to check"],
    ["error", "could not run", "could not run"],
  ];
  const parts = words
    .filter(([state]) => counts[state])
    .map(([state, one, many]) => `${counts[state]} ${counts[state] === 1 ? one : many}`);
  return `${n} ${n === 1 ? "shape" : "shapes"}: ${parts.join(", ")}.`;
}

/** Why a rule cannot be added yet, or null when it can (Section 6: invalid
 *  values keep Add disabled, with a sentence). */
export function ruleProblem(rule: ShapeRule): string | null {
  const { minCount: min, maxCount: max, minLength: lo, maxLength: hi } = rule;
  for (const [n, what] of [[min, "number"], [max, "number"], [lo, "length"], [hi, "length"]] as const) {
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) return `Each ${what} is a whole number, 0 or more.`;
  }
  if (min !== undefined && max !== undefined && min > max) return `At least ${min} is more than at most ${max}; the rule could never be met.`;
  if (lo !== undefined && hi !== undefined && lo > hi) return "The shortest length is longer than the longest.";
  if (rule.pattern !== undefined) {
    try {
      new RegExp(rule.pattern);
    } catch {
      return "That pattern is not a regular expression this tool can read.";
    }
  }
  const low = rule.minInclusive;
  const high = rule.maxInclusive;
  for (const bound of [low, high]) {
    if (!bound) continue;
    const isDate = bound.datatype === "xsd:date" || bound.datatype === "xsd:dateTime";
    const withTime = bound.datatype === "xsd:dateTime";
    const ok = withTime
      ? /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(bound.value)
      : isDate
        ? /^-?\d{4,}-\d{2}-\d{2}/.test(bound.value)
        : bound.value.trim() !== "" && Number.isFinite(Number(bound.value));
    if (!ok) {
      if (withTime) return `"${bound.value}" is not a date and time (YYYY-MM-DDThh:mm:ss).`;
      return isDate ? `"${bound.value}" is not a date (YYYY-MM-DD).` : `"${bound.value}" is not a number.`;
    }
  }
  if (low && high && low.datatype === high.datatype) {
    const lower = low.datatype.startsWith("xsd:date") ? low.value > high.value : Number(low.value) > Number(high.value);
    if (lower) return "The minimum is above the maximum; the rule could never be met.";
  }
  if (rule.in && rule.in.length === 0) return "List at least one allowed value.";
  if (rule.languageIn && rule.languageIn.length === 0) return "Choose at least one language.";
  const says = [
    min, max, lo, hi, rule.datatype, rule.class, rule.pattern, low, high, rule.in,
    rule.languageIn, rule.uniqueLang || undefined, rule.requiredLanguages?.length ? rule.requiredLanguages : undefined,
  ].some((v) => v !== undefined && v !== "");
  return says ? null : "Choose at least one thing to check.";
}
