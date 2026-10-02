/*
================================================================================
FILE: frontend/src/components/RuleEditor.tsx
================================================================================

SUMMARY
    One rule at a time (shacl-authoring 5.3): first what the rule is about --
    a name, the definition, or one of the target class's own and inherited
    attributes and relationships -- then what is checked on it, offering only
    the kinds that fit: how many, type of value, points to, text length,
    text pattern, number or date range, allowed values and languages. The
    rule reads as a sentence before it is added.

BASIC IDEA
    The editor builds a ShapeRule and nothing else; the shape form sends it
    as AddRule or ReplaceRule, one undo step. Which kinds are offered follows
    5.3's table: a type of value for attributes, *points to* for
    relationships, length and pattern for text, a range for numbers and
    dates, allowed values for text, numbers and relationships, languages for
    names, definitions and text in a language.

    *Points to* is a class picker, the relationship's end class by default
    and available when it has none (Stage B follow-up 2); a date-and-time
    range is entered in a date-and-time field, its seconds added when the
    field leaves them out (follow-up 1).

    Invalid values keep Add aria-disabled with the sentence that says why
    (Section 6, ruleProblem), rather than sending a rule the server would
    refuse; the server checks again, and its refusal shows under the editor.
    aria-disabled, not disabled, so a keyboard user standing on Add is never
    dropped to the page.

    The three pattern examples fill the field with a regular expression the
    learner can read and change; the pattern is the learner's own input,
    checked by building a RegExp, never ontology text.

INPUTS / INPUT SOURCES (props)
    - modelOntologyId: the model, which the class picker searches.
    - paths: what a rule can be about, from the suggestions route.
    - initial: the rule being edited, or null for a new one.
    - languages: the project's languages, primary first.
    - busy, error: the command in flight and the server's refusal.
    - onSubmit(rule), onCancel.

EXPECTED OUTPUT
    - The editor; onSubmit with one complete rule.
================================================================================
*/

import { useId, useMemo, useRef, useState } from "react";
import { OFFERED_TYPES, article, dateTimeBound, languageName, ruleProblem, ruleSentence } from "../modeling/shapeSentences";
import type { ShapeBound, ShapePath, ShapeRule, ShapeValue } from "../types";
import EntityPicker from "./EntityPicker";

interface Props {
  /** The model's ontology id, which the *points to* class picker searches. */
  modelOntologyId: string;
  paths: ShapePath[];
  initial: ShapeRule | null;
  languages: string[];
  busy: boolean;
  error?: string;
  onSubmit: (rule: ShapeRule) => void;
  onCancel: () => void;
}

type Count = "none" | "required" | "atMostOne" | "exactlyOne" | "atLeast" | "atMost" | "between";

const PATTERN_EXAMPLES = [
  { label: "Email", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
  { label: "Code (three capitals and digits)", pattern: "^[A-Z]{3}[0-9]+$" },
  { label: "Year", pattern: "^[0-9]{4}$" },
];

function countOf(rule: ShapeRule | null): Count {
  if (!rule) return "none";
  const { minCount: min, maxCount: max } = rule;
  if (min === undefined && max === undefined) return "none";
  if (min === 1 && max === undefined) return "required";
  if (min === undefined && max === 1) return "atMostOne";
  if (min === 1 && max === 1) return "exactlyOne";
  // One end only stays one end: reading "at least 2" as "between 2 and 3"
  // wrote a maximum nobody chose (found in review).
  if (max === undefined) return "atLeast";
  if (min === undefined) return "atMost";
  return "between";
}

/** Each field the editor shows for a path; any other field a rule carries
 *  (written in Turtle, say) is kept as it was when the rule is saved. */
function shownFields(pathKind: string | undefined, kind: string, offersLanguages: boolean): Set<keyof ShapeRule> {
  const out = new Set<keyof ShapeRule>(["minCount", "maxCount"]);
  if (pathKind === "attribute") out.add("datatype");
  if (pathKind === "relationship") out.add("class");
  if (kind === "text") ["minLength", "maxLength", "pattern"].forEach((k) => out.add(k as keyof ShapeRule));
  if (kind === "number" || kind === "date") ["minInclusive", "maxInclusive"].forEach((k) => out.add(k as keyof ShapeRule));
  if (kind === "text" || kind === "number" || pathKind === "relationship") out.add("in");
  if (offersLanguages) ["languageIn", "uniqueLang", "requiredLanguages"].forEach((k) => out.add(k as keyof ShapeRule));
  return out;
}

const CHECKS: (keyof ShapeRule)[] = [
  "minCount", "maxCount", "datatype", "class", "classLabel", "minLength", "maxLength", "pattern",
  "minInclusive", "maxInclusive", "in", "languageIn", "uniqueLang", "requiredLanguages",
];

const key = (path: string[]) => path.join(" ");

/** What a value of this path is, for which kinds to offer. */
function valueKind(path: ShapePath | undefined, datatype: string): "text" | "number" | "date" | "other" {
  if (!path) return "other";
  if (path.kind === "name" || path.kind === "definition") return "text";
  if (path.kind !== "attribute") return "other";
  const type = datatype || path.datatype || "xsd:string";
  if (type === "xsd:string" || type === "rdf:langString") return "text";
  if (type === "xsd:integer" || type === "xsd:decimal") return "number";
  if (type === "xsd:date" || type === "xsd:dateTime") return "date";
  return "other";
}

function boundOf(value: string, datatype: string): ShapeBound | undefined {
  if (value.trim() === "") return undefined;
  // A date-and-time field gives no seconds when they are zero; the server
  // rightly wants them (Stage A follow-up 1).
  return { value: datatype === "xsd:dateTime" ? dateTimeBound(value.trim()) : value.trim(), datatype };
}

/** What a datetime-local field can show: no timezone, no fraction. Anything
 *  else a rule says (written in Turtle) stays in a text field, as typed. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function parseList(text: string, kind: "text" | "number" | "link"): ShapeValue[] {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((value) =>
      kind === "link"
        ? { kind: "link", value }
        : kind === "number"
          ? { kind: "typed", value, datatype: /^[+-]?\d+$/.test(value) ? "xsd:integer" : "xsd:decimal" }
          : { kind: "typed", value, datatype: "xsd:string" },
    );
}

export default function RuleEditor({ modelOntologyId, paths, initial, languages, busy, error, onSubmit, onCancel }: Props) {
  const id = useId();
  const [pathKey, setPathKey] = useState(initial ? key(initial.path) : "");
  const path = paths.find((p) => key(p.path) === pathKey);
  const [count, setCount] = useState<Count>(countOf(initial));
  const [min, setMin] = useState(String(initial?.minCount ?? 1));
  const [max, setMax] = useState(String(initial?.maxCount ?? (initial?.minCount !== undefined ? initial.minCount + 2 : 3)));
  const [datatype, setDatatype] = useState(initial?.datatype ?? "");
  // The class each value must be (5.3, follow-up 2): a rule's own, else the
  // relationship's end class, else none until one is chosen.
  const [pointsTo, setPointsTo] = useState<{ iri: string; label: string } | null>(
    initial?.class ? { iri: initial.class, label: initial.classLabel ?? initial.class } : null,
  );
  const [pickingClass, setPickingClass] = useState(false);
  const classButton = useRef<HTMLButtonElement>(null);
  const [minLength, setMinLength] = useState(initial?.minLength !== undefined ? String(initial.minLength) : "");
  const [maxLength, setMaxLength] = useState(initial?.maxLength !== undefined ? String(initial.maxLength) : "");
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const [low, setLow] = useState(initial?.minInclusive?.value ?? "");
  const [high, setHigh] = useState(initial?.maxInclusive?.value ?? "");
  const initialAllowed = initial?.in ? initial.in.map((v) => v.value).join(", ") : "";
  const [allowed, setAllowed] = useState(initialAllowed);
  const [onlyLangs, setOnlyLangs] = useState<string[]>(initial?.languageIn ?? []);
  const [unique, setUnique] = useState(initial?.uniqueLang ?? false);
  const [required, setRequired] = useState<string[]>(initial?.requiredLanguages ?? []);
  const [more, setMore] = useState(Boolean(initial?.pattern));

  const kind = valueKind(path, datatype);
  const dateTime = kind === "date" && (datatype || path?.datatype) === "xsd:dateTime";
  /** The input a bound is typed in: a date, a date and time (follow-up 1),
   *  or text -- for a number, and for a value a local field cannot show. */
  const boundField = (value: string) => {
    if (kind !== "date") return { type: "text" };
    if (!dateTime) return { type: "date" };
    return value === "" || LOCAL_DATE_TIME.test(value)
      ? { type: "datetime-local", step: 1 }
      : { type: "text", placeholder: "YYYY-MM-DDThh:mm:ss" };
  };
  const offersLanguages = path?.kind === "name" || path?.kind === "definition" || datatype === "rdf:langString";

  const rule: ShapeRule | null = useMemo(() => {
    if (!path) return null;
    const out: ShapeRule = { path: path.path, pathLabel: path.label, pathKind: path.kind };
    const n = (text: string) => (text.trim() === "" ? NaN : Number(text));
    const same = initial !== null && key(initial.path) === pathKey;
    if (same) {
      // What this editor does not show for the path is not the editor's to
      // drop: an edit of the count keeps a datatype on a name, a class, a
      // pattern (found in review).
      const shown = shownFields(path.kind, kind, offersLanguages);
      for (const field of CHECKS) {
        const value = initial[field];
        if (value !== undefined && !shown.has(field === "classLabel" ? "class" : field)) {
          (out as unknown as Record<string, unknown>)[field] = value;
        }
      }
    }
    if (count === "required") out.minCount = 1;
    if (count === "atMostOne") out.maxCount = 1;
    if (count === "exactlyOne") {
      out.minCount = 1;
      out.maxCount = 1;
    }
    if (count === "atLeast" || count === "between") out.minCount = n(min);
    if (count === "atMost" || count === "between") out.maxCount = n(max);
    if (path.kind === "attribute" && datatype) out.datatype = datatype;
    if (path.kind === "relationship" && pointsTo) {
      out.class = pointsTo.iri;
      out.classLabel = pointsTo.label;
    }
    if (kind === "text") {
      if (minLength.trim() !== "") out.minLength = n(minLength);
      if (maxLength.trim() !== "") out.maxLength = n(maxLength);
      if (pattern !== "") out.pattern = pattern;
    }
    if (kind === "number" || kind === "date") {
      const type = kind === "date" ? (datatype || path.datatype || "xsd:date") : (datatype || path.datatype || "xsd:decimal");
      out.minInclusive = boundOf(low, type);
      out.maxInclusive = boundOf(high, type);
      if (!out.minInclusive) delete out.minInclusive;
      if (!out.maxInclusive) delete out.maxInclusive;
    }
    if ((kind === "text" || kind === "number" || path.kind === "relationship") && allowed.trim() !== "") {
      // An untouched list goes back exactly as it came, language tags,
      // types and commas inside values included (found in review).
      out.in = same && initial.in && allowed === initialAllowed
        ? initial.in
        : parseList(allowed, path.kind === "relationship" ? "link" : kind === "number" ? "number" : "text");
    }
    if (offersLanguages) {
      if (onlyLangs.length) out.languageIn = onlyLangs;
      if (unique) out.uniqueLang = true;
      if (required.length) out.requiredLanguages = required;
    }
    return out;
  }, [path, pathKey, initial, count, min, max, datatype, pointsTo, kind, minLength, maxLength, pattern, low, high, allowed,
      offersLanguages, onlyLangs, unique, required, initialAllowed]);

  const problem = !path ? "Choose what the rule is about." : rule ? ruleProblem(rule) : null;
  const submit = () => {
    if (busy || problem || !rule) return;
    onSubmit(rule);
  };
  const toggle = (list: string[], set: (v: string[]) => void, tag: string) =>
    set(list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag]);

  const choosePath = (next: string) => {
    setPathKey(next);
    const chosen = paths.find((p) => key(p.path) === next);
    // A new rule starts from what the model says about the path: an
    // attribute's type of value, a relationship's end.
    if (!initial && chosen) {
      setDatatype(chosen.kind === "attribute" ? chosen.datatype ?? "" : "");
      setPointsTo(
        chosen.kind === "relationship" && chosen.range
          ? { iri: chosen.range, label: chosen.rangeLabel ?? chosen.range }
          : null,
      );
    }
  };

  return (
    <div
      className="rule-editor"
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h5 id={`${id}-title`}>{initial ? "Change the rule" : "Add a rule"}</h5>
      <label className="edit-field-label" htmlFor={`${id}-path`}>
        What is the rule about?
      </label>
      <select id={`${id}-path`} value={pathKey} autoFocus onChange={(e) => choosePath(e.target.value)}>
        <option value="">Choose…</option>
        {paths.map((p) => (
          <option key={key(p.path)} value={key(p.path)}>
            {p.label}
            {p.kind === "relationship" ? " (relationship)" : p.kind === "attribute" ? " (attribute)" : ""}
          </option>
        ))}
      </select>

      {path && (
        <>
          <fieldset className="rule-kind">
            <legend>How many</legend>
            <select aria-label="How many" value={count} onChange={(e) => setCount(e.target.value as Count)}>
              <option value="none">Any number</option>
              <option value="required">Required (at least one)</option>
              <option value="atMostOne">At most one</option>
              <option value="exactlyOne">Exactly one</option>
              <option value="atLeast">At least…</option>
              <option value="atMost">At most…</option>
              <option value="between">Between…</option>
            </select>
            {(count === "atLeast" || count === "between") && (
              <span className="rule-range">
                <label>
                  {count === "between" ? "from" : "at least"}{" "}
                  <input type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />
                </label>
              </span>
            )}
            {(count === "atMost" || count === "between") && (
              <span className="rule-range">
                <label>
                  {count === "between" ? "to" : "at most"}{" "}
                  <input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
                </label>
              </span>
            )}
          </fieldset>

          {path.kind === "attribute" && (
            <fieldset className="rule-kind">
              <legend>Type of value</legend>
              <select aria-label="Type of value" value={datatype} onChange={(e) => setDatatype(e.target.value)}>
                <option value="">Do not check</option>
                {OFFERED_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </fieldset>
          )}

          {path.kind === "relationship" && (
            <fieldset className="rule-kind">
              <legend>Points to</legend>
              {pickingClass ? (
                <EntityPicker
                  ontologyId={modelOntologyId}
                  kind="class"
                  label="Each value must be of the class"
                  onPick={(iri, label) => {
                    setPointsTo({ iri, label });
                    setPickingClass(false);
                    window.setTimeout(() => classButton.current?.focus(), 0);
                  }}
                  onCancel={() => {
                    setPickingClass(false);
                    window.setTimeout(() => classButton.current?.focus(), 0);
                  }}
                />
              ) : (
                <div className="edit-value">
                  <span>
                    {pointsTo
                      ? `Each value must be ${article(pointsTo.label)} ${pointsTo.label}`
                      : path.range
                        ? "Not checked"
                        : "Not checked: this relationship has no end class, so choose one here if you want it checked."}
                  </span>
                  <button ref={classButton} type="button" className="ghost edit-btn" onClick={() => setPickingClass(true)}>
                    {pointsTo ? "Change class" : "Choose a class"}
                  </button>
                  {pointsTo && (
                    <button type="button" className="ghost edit-btn" onClick={() => setPointsTo(null)}>
                      Do not check
                    </button>
                  )}
                </div>
              )}
            </fieldset>
          )}

          {kind === "text" && (
            <fieldset className="rule-kind">
              <legend>Text length</legend>
              <span className="rule-range">
                <label>
                  at least <input type="number" min={0} value={minLength} onChange={(e) => setMinLength(e.target.value)} />
                </label>
                <label>
                  at most <input type="number" min={0} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} />
                </label>
                characters
              </span>
            </fieldset>
          )}

          {(kind === "number" || kind === "date") && (
            <fieldset className="rule-kind">
              <legend>{kind === "date" ? (dateTime ? "Date and time range" : "Date range") : "Number range"}</legend>
              <span className="rule-range">
                {([["at least", low, setLow], ["at most", high, setHigh]] as const).map(([word, value, set]) => (
                  <label key={word}>
                    {word}{" "}
                    <input
                      {...boundField(value)}
                      inputMode={kind === "number" ? "decimal" : undefined}
                      value={value}
                      onChange={(e) => set(e.target.value)}
                    />
                  </label>
                ))}
              </span>
            </fieldset>
          )}

          {(kind === "text" || kind === "number" || path.kind === "relationship") && (
            <fieldset className="rule-kind">
              <legend>Allowed values</legend>
              <input
                type="text"
                aria-label="Allowed values, separated by commas"
                aria-describedby={`${id}-allowed-help`}
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
              />
              <p id={`${id}-allowed-help`} className="detail-note">
                {path.kind === "relationship"
                  ? "Individuals, by prefixed name or IRI, separated by commas. Leave empty to allow any."
                  : "Separate the values with commas. Leave empty to allow any."}
              </p>
            </fieldset>
          )}

          {offersLanguages && (
            <fieldset className="rule-kind">
              <legend>Languages</legend>
              <p className="detail-note">Required in:</p>
              {languages.map((tag) => (
                <label key={`req-${tag}`} className="rule-check">
                  <input type="checkbox" checked={required.includes(tag)} onChange={() => toggle(required, setRequired, tag)} />
                  {languageName(tag)} ({tag})
                </label>
              ))}
              <p className="detail-note">Only in:</p>
              {languages.map((tag) => (
                <label key={`only-${tag}`} className="rule-check">
                  <input type="checkbox" checked={onlyLangs.includes(tag)} onChange={() => toggle(onlyLangs, setOnlyLangs, tag)} />
                  {languageName(tag)} ({tag})
                </label>
              ))}
              <label className="rule-check">
                <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
                One per language
              </label>
            </fieldset>
          )}

          {kind === "text" && (
            <div className="rule-more">
              <button type="button" className="ghost" aria-expanded={more} onClick={() => setMore((m) => !m)}>
                More
              </button>
              {more && (
                <fieldset className="rule-kind">
                  <legend>Text pattern</legend>
                  <input
                    type="text"
                    aria-label="Pattern, a regular expression"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                  />
                  <div className="rule-examples">
                    {PATTERN_EXAMPLES.map((ex) => (
                      <button key={ex.label} type="button" className="ghost edit-btn" onClick={() => setPattern(ex.pattern)}>
                        {ex.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}
        </>
      )}

      {rule && !problem && <p className="rule-preview">Reads: {ruleSentence(rule)}.</p>}
      {problem && path && (
        <p id={`${id}-problem`} className="detail-note">
          {problem}
        </p>
      )}
      <div className="edit-actions">
        <button
          type="button"
          className="primary"
          aria-disabled={busy || Boolean(problem)}
          aria-describedby={problem && path ? `${id}-problem` : undefined}
          onClick={submit}
        >
          {busy ? "Saving change…" : initial ? "Save rule" : "Add rule"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="edit-error">{error}</p>}
    </div>
  );
}
