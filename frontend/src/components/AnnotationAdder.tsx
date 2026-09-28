/*
================================================================================
FILE: frontend/src/components/AnnotationAdder.tsx
================================================================================

SUMMARY
    Adding an annotation (visual-modeling 5.1.1): choose a property, a value
    type, then a value in an input that matches the type, and Add. Also the
    ValueInput it is built on, which the form reuses to edit a value in place.

BASIC IDEA
    Four steps that read top to bottom as one small form. The property list is
    the server's (GET …/annotation-properties): the suggested properties under
    Common, then those this model declares, then those its imports declare,
    and "New annotation property…", which declares one (with the value type it
    takes, stored as its range so the form suggests it next time) and selects
    it. Choosing a property preselects its default type; the user can change
    it.

    The value is checked as it is typed, by the server's own rule
    (modeling/values.ts). While it is invalid, Add is unavailable and the
    type's sentence says why -- so nothing invalid is ever sent (AC-2). The
    server still checks, and its refusal (a second skos:prefLabel in one
    language, say) is shown under the value with nothing changed.

INPUTS / INPUT SOURCES (props)
    - iri: the entity annotated.
    - primaryLanguage, languages: offered first in the language menu.
    - runner: the section's command runner, so a command in flight shows
      the whole section busy (5.8 item 1).
    - onDone: the adder closes (after Add, or Cancel).
    Plus api.ts for the list.

    While busy, every field is read-only and every select aria-disabled and
    deaf to changes: a disabled select would drop the focus it holds.

EXPECTED OUTPUT
    - AddAnnotation, and CreateAnnotationProperty for a new property.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { getAnnotationProperties } from "../api";
import { typeFromKey, typeKey, valueProblem, VALUE_TYPES, toValue } from "../modeling/values";
import { projectStore } from "../state/projectStore";
import type { Runner } from "./EditParts";
import type { AnnotationPropertyOption, AnnotationValue, ValueType } from "../types";

// ---------------------------------------------------------------------------
// ValueInput: one value, entered as its type
// ---------------------------------------------------------------------------

interface ValueInputProps {
  type: ValueType;
  value: string;
  lang: string;
  languages: string[];
  label: string;
  busy?: boolean;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  onChange: (value: string, lang: string) => void;
}

/** The input a type asks for: text and a language, a date, a number, a
 *  yes-or-no switch, or a link. */
export function ValueInput({
  type,
  value,
  lang,
  languages,
  label,
  busy = false,
  describedBy,
  invalid,
  autoFocus,
  onChange,
}: ValueInputProps) {
  const id = useId();
  const [other, setOther] = useState(!languages.includes(lang));
  const common = {
    id: `${id}-value`,
    readOnly: busy,
    autoFocus,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
  };
  const datatype = type.kind === "typed" ? type.datatype : undefined;

  let input;
  if (type.kind === "text") {
    input = <textarea {...common} rows={2} value={value} onChange={(e) => onChange(e.target.value, lang)} />;
  } else if (datatype === "xsd:boolean") {
    const on = value === "true";
    input = (
      <button
        id={`${id}-value`}
        type="button"
        role="switch"
        aria-checked={on}
        className="ghost value-switch"
        onClick={() => !busy && onChange(on ? "false" : "true", lang)}
      >
        {on ? "Yes" : "No"}
      </button>
    );
  } else {
    const placeholder =
      datatype === "xsd:date"
        ? "YYYY-MM-DD"
        : datatype === "xsd:dateTime"
          ? "YYYY-MM-DDThh:mm:ss"
          : type.kind === "link"
            ? "https://example.org/page"
            : undefined;
    input = (
      <input
        {...common}
        // Not type="date": it blanks what it cannot represent, and xsd:date
        // allows a timezone (2024-01-01Z) and years outside 1-9999, so an
        // existing value would open empty (found in review). The pattern in
        // the placeholder and the check under the field do the job instead.
        type={type.kind === "link" ? "url" : "text"}
        inputMode={datatype === "xsd:integer" || datatype === "xsd:decimal" ? "decimal" : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value, lang)}
      />
    );
  }

  return (
    <div className="value-input">
      <label htmlFor={`${id}-value`} className="edit-field-label">
        {label}
      </label>
      {input}
      {type.kind === "text" && (
        <div className="value-lang">
          <label htmlFor={`${id}-lang`} className="edit-field-label">
            Language
          </label>
          <select
            id={`${id}-lang`}
            value={other ? "__other" : lang}
            aria-disabled={busy}
            onChange={(e) => {
              if (busy) return;
              if (e.target.value === "__other") {
                setOther(true);
              } else {
                setOther(false);
                onChange(value, e.target.value);
              }
            }}
          >
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
            <option value="__other">Other…</option>
          </select>
          {other && (
            <input
              aria-label="Language tag (BCP 47, for example de or pt-BR)"
              value={lang}
              readOnly={busy}
              onChange={(e) => onChange(value, e.target.value.trim())}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnnotationAdder
// ---------------------------------------------------------------------------

interface Props {
  iri: string;
  primaryLanguage: string;
  languages: string[];
  runner: Runner;
  onDone: () => void;
}

const NEW = "__new";
const FIELD = "adder";

export default function AnnotationAdder({ iri, primaryLanguage, languages, runner, onDone }: Props) {
  const id = useId();
  const langs = [primaryLanguage, ...languages.filter((l) => l !== primaryLanguage)];
  const [options, setOptions] = useState<AnnotationPropertyOption[] | null>(null);
  const [property, setProperty] = useState("");
  const [type, setType] = useState<ValueType>({ kind: "text" });
  const [value, setValue] = useState("");
  const [lang, setLang] = useState(primaryLanguage);
  const { busy, errors, run, clear } = runner;
  const [loadError, setLoadError] = useState<string | null>(null);
  const error = loadError || errors[FIELD] || null;
  const setError = (_: null) => {
    setLoadError(null);
    clear(FIELD);
  };
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ValueType>({ kind: "text" });
  const propertyRef = useRef<HTMLSelectElement>(null);

  const load = (select?: string) => {
    const state = projectStore.getSnapshot();
    if (!state.project) return;
    getAnnotationProperties(state.project.id, state.activeDoc)
      .then((list) => {
        setOptions(list);
        if (select) choose(select, list);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    load();
    propertyRef.current?.focus();
  }, []);

  function choose(iri: string, list = options ?? []) {
    setProperty(iri);
    setError(null);
    const option = list.find((o) => o.iri === iri);
    if (option) {
      setType(option.defaultType);
      // A yes-or-no starts on yes; any other type starts empty, not on the
      // "true" a boolean property left behind (found in review).
      setValue(option.defaultType.kind === "typed" && option.defaultType.datatype === "xsd:boolean" ? "true" : "");
    }
  }

  const creating = property === NEW;
  const problem = !creating && property && value !== "" ? valueProblem(type, value, lang) : null;
  const blocked =
    busy ||
    !property ||
    (creating ? !newName.trim() : valueProblem(type, value, type.kind === "text" ? lang : undefined) !== null);

  const add = async () => {
    if (blocked) return;
    if (creating) {
      const result = await run(FIELD, "CreateAnnotationProperty", { label: newName.trim(), valueType: newType });
      if (result) {
        setNewName("");
        load(result.created);
      }
    } else {
      const sent: AnnotationValue = toValue(type, value, type.kind === "text" ? lang : undefined);
      if (await run(FIELD, "AddAnnotation", { iri, property, value: sent })) onDone();
    }
  };

  const groups: [string, AnnotationPropertyOption["source"]][] = [
    ["Common", "suggested"],
    ["In this model", "document"],
    ["From imports", "import"],
  ];
  const errorId = `${id}-error`;
  return (
    <form
      className="annotation-adder"
      aria-label="Add an annotation"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <label htmlFor={`${id}-property`} className="edit-field-label">
        Property
      </label>
      <select
        id={`${id}-property`}
        ref={propertyRef}
        value={property}
        aria-disabled={busy}
        onChange={(e) => !busy && choose(e.target.value)}
      >
        <option value="" disabled>
          {options ? "Choose a property…" : "Loading…"}
        </option>
        {groups.map(([title, source]) => {
          const inGroup = (options ?? []).filter((o) => o.source === source);
          return inGroup.length ? (
            <optgroup key={source} label={title}>
              {inGroup.map((o) => (
                <option key={o.iri} value={o.iri}>
                  {o.prefixed}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        <option value={NEW}>New annotation property…</option>
      </select>

      {creating ? (
        <div className="new-annotation-property">
          <label htmlFor={`${id}-new-name`} className="edit-field-label">
            Name of the new property ({primaryLanguage})
          </label>
          <input id={`${id}-new-name`} value={newName} readOnly={busy} onChange={(e) => setNewName(e.target.value)} />
          <label htmlFor={`${id}-new-type`} className="edit-field-label">
            Its values are
          </label>
          <select
            id={`${id}-new-type`}
            value={typeKey(newType)}
            aria-disabled={busy}
            onChange={(e) => !busy && setNewType(typeFromKey(e.target.value))}
          >
            {VALUE_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        property && (
          <>
            <label htmlFor={`${id}-type`} className="edit-field-label">
              Value type
            </label>
            <select
              id={`${id}-type`}
              value={typeKey(type)}
              aria-disabled={busy}
              onChange={(e) => {
                if (busy) return;
                const next = typeFromKey(e.target.value);
                setType(next);
                setValue(next.kind === "typed" && next.datatype === "xsd:boolean" ? "true" : "");
              }}
            >
              {VALUE_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <ValueInput
              key={typeKey(type)}
              type={type}
              value={value}
              lang={lang}
              languages={langs}
              label="Value"
              busy={busy}
              invalid={problem !== null || error !== null}
              describedBy={problem || error ? errorId : undefined}
              onChange={(v, l) => {
                setValue(v);
                setLang(l);
                setError(null);
              }}
            />
          </>
        )
      )}
      {(problem || error) && (
        <p id={errorId} className="edit-error">
          {error ?? problem}
        </p>
      )}
      <div className="edit-actions">
        <button type="submit" className="primary" aria-disabled={blocked}>
          {busy ? "Saving change…" : creating ? "Create property" : "Add"}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
