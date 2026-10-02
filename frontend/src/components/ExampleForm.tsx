/*
================================================================================
FILE: frontend/src/components/ExampleForm.tsx
================================================================================

SUMMARY
    The blocks of an example's form (shacl-authoring 5.8): which classes it
    is an example of, and one field per attribute and relationship those
    classes have, their own and inherited -- an attribute entered as its
    type of value, a relationship chosen from the examples of its end
    class. EditSection shows them in place of a class's structure.

BASIC IDEA
    The fields come from the server with the entity's statements, so the
    form costs no request of its own and refreshes with the panel on each
    revision. Every change is one command (modeling/examples.ts says which),
    one undo step, through the section's runner.

    A wrong value is refused before it is sent (row S22): Add stays
    aria-disabled with the type's sentence under the field, the same check
    and the same words the server would answer with. aria-disabled rather
    than disabled, so a keyboard user standing on it keeps their place.

    After Remove the focus goes to the field's input, which is still there,
    rather than to the page: the value's own button has gone.

INPUTS / INPUT SOURCES (props)
    - iri, name, example: the example and its classes and fields.
    - primaryLanguage, languages: for text in a language.
    - runner: the section's command runner; onSelect: follow a link.

EXPECTED OUTPUT
    - The Example of and Values blocks; commands through the runner.
================================================================================
*/

import { useId, useRef, useState } from "react";
import { fieldCommand, fieldProblem, fieldType, fieldValue, typeWords } from "../modeling/examples";
import type { ExampleField, ExampleInfo } from "../types";
import { ValueInput } from "./AnnotationAdder";
import { Block, type Runner } from "./EditParts";

interface Props {
  iri: string;
  name: string;
  example: ExampleInfo;
  primaryLanguage: string;
  languages: string[];
  runner: Runner;
  onSelect: (iri: string) => void;
}

export default function ExampleForm({ iri, name, example, primaryLanguage, languages, runner, onSelect }: Props) {
  const langs = [primaryLanguage, ...languages.filter((l) => l !== primaryLanguage)];
  const classes = example.classes;
  return (
    <>
      <Block title="Example of">
        {classes.length === 0 ? (
          <p className="detail-note">No class yet: give it one in Turtle, and its fields appear here.</p>
        ) : (
          <ul className="edit-list">
            {classes.map((c) => (
              <li key={c.iri}>
                <button type="button" className="link-btn" onClick={() => onSelect(c.iri)}>
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block title="Values">
        {example.fields.length === 0 ? (
          <p className="detail-note">
            {classes.length
              ? `${classes.map((c) => c.label).join(" and ")} has no attributes or relationships yet. Add them on the class's form, and they appear here.`
              : "Nothing to fill in yet."}
          </p>
        ) : (
          example.fields.map((field) => (
            <FieldEditor
              key={field.property}
              iri={iri}
              name={name}
              field={field}
              primaryLanguage={primaryLanguage}
              languages={langs}
              runner={runner}
              onSelect={onSelect}
            />
          ))
        )}
      </Block>
    </>
  );
}

interface FieldProps {
  iri: string;
  name: string;
  field: ExampleField;
  primaryLanguage: string;
  languages: string[];
  runner: Runner;
  onSelect: (iri: string) => void;
}

function FieldEditor({ iri, name, field, primaryLanguage, languages, runner, onSelect }: FieldProps) {
  const id = useId();
  const { busy, errors, run } = runner;
  const key = `example:${field.property}`;
  const [raw, setRaw] = useState("");
  const [lang, setLang] = useState(primaryLanguage);
  // What the learner has typed is judged once they have typed something; an
  // empty field is not yet wrong, only not ready.
  const problem = fieldProblem(field, raw, lang);
  const shown = raw !== "" && field.kind === "attribute" ? problem : null;
  const inputArea = useRef<HTMLDivElement>(null);
  const relationship = field.kind === "relationship";
  const command = fieldCommand(field);
  const verb = command === "SetExampleValue" && field.values.length ? "Change" : relationship ? "Link" : "Add";
  const options = (field.options ?? []).filter((o) => !field.values.some((v) => v.value === o.iri));

  const focusInput = () =>
    window.setTimeout(() => inputArea.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus(), 0);

  const submit = async () => {
    if (busy || problem) return;
    const result = await run(key, command, { iri, property: field.property, value: fieldValue(field, raw, lang) });
    if (result) setRaw("");
  };

  return (
    <div className="example-field" role="group" aria-labelledby={`${id}-name`}>
      <h5 id={`${id}-name`}>
        {field.label}
        <span className="detail-note">
          {" "}
          ({relationship ? `${field.rangeLabel ? `to ${field.rangeLabel}` : "to any example"}` : typeWords(field)}
          {field.functional ? ", one value" : ""})
        </span>
      </h5>
      {field.values.length > 0 && (
        <ul className="edit-list">
          {field.values.map((v) => (
            <li key={`${v.kind}|${v.datatype ?? ""}|${v.lang ?? ""}|${v.value}`} className="edit-value">
              {v.kind === "link" ? (
                <button type="button" className="link-btn" onClick={() => onSelect(v.value)}>
                  {v.label ?? v.value}
                </button>
              ) : (
                <span>
                  {v.value}
                  {v.lang ? ` (${v.lang})` : ""}
                </span>
              )}
              <button
                type="button"
                className="ghost edit-btn"
                aria-label={`Remove ${v.label ?? v.value} from ${field.label} of ${name}`}
                aria-disabled={busy}
                onClick={async () => {
                  if (busy) return;
                  const value = v.kind === "link" ? { kind: "link", value: v.value } : v;
                  if (await run(key, "RemoveExampleValue", { iri, property: field.property, value })) focusInput();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={inputArea} className="example-field-input">
        {relationship ? (
          options.length === 0 && !raw ? (
            <p className="detail-note">
              {field.values.length
                ? `No other ${field.rangeLabel ?? "example"} to link.`
                : `No ${field.rangeLabel ?? "example"} yet. Add one from the ${field.rangeLabel ?? "class"} form, then link it here.`}
            </p>
          ) : (
            <>
              <label htmlFor={`${id}-choice`} className="edit-field-label">
                {verb === "Change" ? `Change ${field.label}` : `Link to`}
              </label>
              <select id={`${id}-choice`} value={raw} aria-disabled={busy} onChange={(e) => !busy && setRaw(e.target.value)}>
                <option value="">Choose {field.rangeLabel ? `${/^[aeiou]/i.test(field.rangeLabel) ? "an" : "a"} ${field.rangeLabel}` : "an example"}…</option>
                {options.map((o) => (
                  <option key={o.iri} value={o.iri}>
                    {o.label}
                  </option>
                ))}
              </select>
              {(field.optionsTotal ?? 0) > (field.options?.length ?? 0) && (
                <p className="detail-note">
                  The first {field.options?.length} of {field.optionsTotal} are listed.
                </p>
              )}
            </>
          )
        ) : (
          <ValueInput
            type={fieldType(field)}
            value={raw}
            lang={lang}
            languages={languages}
            label={verb === "Change" ? `New ${field.label}` : `${field.label}`}
            busy={busy}
            describedBy={shown ? `${id}-problem` : undefined}
            invalid={Boolean(shown)}
            onChange={(value, nextLang) => {
              setRaw(value);
              setLang(nextLang);
            }}
          />
        )}
        {shown && (
          <p id={`${id}-problem`} className="edit-error">
            {shown}
          </p>
        )}
        {(options.length > 0 || raw || !relationship) && (
          <div className="edit-actions">
            <button
              type="button"
              className="primary"
              aria-disabled={busy || Boolean(problem)}
              aria-describedby={shown ? `${id}-problem` : undefined}
              onClick={() => void submit()}
            >
              {verb} {field.label}
            </button>
          </div>
        )}
        {errors[key] && <p className="edit-error">{errors[key]}</p>}
      </div>
    </div>
  );
}
