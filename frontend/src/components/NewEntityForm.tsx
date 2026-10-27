/*
================================================================================
FILE: frontend/src/components/NewEntityForm.tsx
================================================================================

SUMMARY
    The one small form behind every "New …" and "Add …" action of the tree and
    the editing form (visual-modeling 5.1, 5.2): a name in the project's
    primary language, and nothing else unless asked for.

BASIC IDEA
    Names first (5.1). A learner types "Invoice item" and the server mints the
    IRI from it, as it always has. An expert who wants to choose the IRI opens
    More options and types it there; an attribute's datatype is offered there
    too. Anything a caller needs besides (a relationship's range) comes in as
    `children` and is the caller's to hold.

    Create is aria-disabled, not disabled, while the name is empty, so focus
    is never dropped from it (CLAUDE.md, authoring foundations). Enter
    creates, Escape cancels, and a refusal is the server's sentence under the
    name field with nothing changed.

INPUTS / INPUT SOURCES (props)
    - title: what is being made ("New subclass of Invoice").
    - primaryLanguage: named in the field's label.
    - datatypes: offer a datatype under More options (an attribute).
    - busy, error: the command in flight, and its refusal.
    - missing: what else Create waits for, said beside it (a relationship's
      range, 5.8 item 10); null when nothing.
    - onSubmit({name, iri?, datatype?}), onCancel.
    - name, onNameChange: the name held outside, for the side panel's form,
      whose name is the canvas draft box's too (edit-page-rework 5.5).
    - focusName: whether the name field takes focus when the form opens;
      not when the canvas's draft box already has it.
    - onNameBlur: the name field lost focus, with where it went.
    - onMoreChange: More options' identifier and type of value as they
      change, for a caller that keeps them (the side panel's draft).
    - suggest: for *Add attribute* and *Add relationship* (attribute-reuse
      5.1), the project's own properties of that kind offered while the
      name is typed, each with *Use it on* the class; existing: the same
      choice after Create was refused because the name exists. Enter in
      the name field still creates; the suggestions are buttons between the
      name and More options, and a polite live region says how many match,
      never the list.
    - classKind: for a new class (attribute-reuse 5.6), the *Kind of
      class* radio group under the name, its default the project's last
      choice; onSubmit then carries `type`. NewClassForm is the form with
      its own choice, mounted when it opens, so a cancelled choice or a
      default changed meanwhile never carries over (code review).

EXPECTED OUTPUT
    - The form; one onSubmit per Create.
================================================================================
*/

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ALREADY_HERE, useOn } from "../modeling/sentences";
import { DATATYPES } from "../modeling/values";
import type { ClassType } from "../types";
import ClassKindChoice, { useClassKind, type ClassKind } from "./ClassKindChoice";
import { useSuggestions } from "./useSuggestions";

export interface NewEntity {
  name: string;
  iri?: string;
  datatype?: string;
  /** A class's kind (5.6), when the form offers the choice. */
  type?: ClassType;
}

export interface NewEntityFormProps {
  title: string;
  primaryLanguage: string;
  datatypes?: boolean;
  busy?: boolean;
  error?: string | null;
  submitLabel?: string;
  missing?: string | null;
  children?: ReactNode;
  onSubmit: (entity: NewEntity) => void;
  onCancel: () => void;
  name?: string;
  onNameChange?: (name: string) => void;
  focusName?: boolean;
  onNameBlur?: (to: EventTarget | null) => void;
  onMoreChange?: (more: { iri?: string; datatype?: string }) => void;
  /** Offer the project's own properties of this kind while the name is
   *  typed (attribute-reuse 5.1); onUse opens the reuse plan for one. */
  suggest?: {
    ontologyId: string;
    kind: "datatypeProperty" | "objectProperty";
    className: string;
    onUse: (property: { iri: string; label: string }) => void;
  };
  /** A create refused because the name is a property already (5.1's 409):
   *  its sentence, and the same choice the suggestions give. */
  existing?: { sentence: string; className: string; onUse: () => void; onAnother: () => void } | null;
  /** A new class: OWL or RDFS (attribute-reuse 5.6). */
  classKind?: ClassKind;
}

export default function NewEntityForm({
  title,
  primaryLanguage,
  datatypes = false,
  busy = false,
  error = null,
  submitLabel = "Create",
  missing = null,
  children,
  onSubmit,
  onCancel,
  name: heldName,
  onNameChange,
  focusName = true,
  onNameBlur,
  onMoreChange,
  suggest,
  existing = null,
  classKind,
}: NewEntityFormProps) {
  const id = useId();
  const [ownName, setOwnName] = useState("");
  // Held outside when the caller shares it (the side panel and the canvas).
  const name = heldName ?? ownName;
  const setName = onNameChange ?? setOwnName;
  const [more, setMore] = useState(false);
  const [iri, setIri] = useState("");
  const [datatype, setDatatype] = useState("xsd:string");
  const nameRef = useRef<HTMLInputElement>(null);
  // Suggestions (5.1): what the project already has of this kind.
  const { suggestions, said } = useSuggestions(suggest?.ontologyId ?? null, suggest?.kind ?? "datatypeProperty", name);

  useEffect(() => {
    if (focusName) nameRef.current?.focus();
    // Once, as the form opens.
  }, []);

  const blocked = busy || !name.trim() || missing !== null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    onSubmit({
      name: name.trim(),
      ...(iri.trim() ? { iri: iri.trim() } : {}),
      ...(datatypes ? { datatype } : {}),
      ...(classKind ? { type: classKind.value } : {}),
    });
  };

  return (
    <form
      className="new-entity-form"
      aria-labelledby={`${id}-title`}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-title`} className="new-entity-title">
        {title}
      </p>
      <label htmlFor={`${id}-name`} className="edit-field-label">
        Name ({primaryLanguage})
      </label>
      <input
        id={`${id}-name`}
        ref={nameRef}
        value={name}
        readOnly={busy}
        aria-invalid={error || existing ? true : undefined}
        aria-describedby={error || existing ? `${id}-error` : undefined}
        onChange={(e) => setName(e.target.value)}
        onBlur={onNameBlur ? (e) => onNameBlur(e.relatedTarget) : undefined}
      />
      {existing ? (
        <div className="reuse-existing">
          <p id={`${id}-error`}>{existing.sentence}</p>
          <div className="edit-actions">
            <button type="button" aria-disabled={busy} onClick={() => !busy && existing.onUse()}>
              {useOn(existing.className)}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                existing.onAnother();
                nameRef.current?.focus();
              }}
            >
              Choose another name
            </button>
          </div>
        </div>
      ) : (
        error && (
          <p id={`${id}-error`} className="edit-error">
            {error}
          </p>
        )
      )}
      {classKind && <ClassKindChoice {...classKind} busy={busy} />}
      {suggest && suggestions.length > 0 && !existing && (
        <div className="reuse-suggestions">
          <p className="edit-field-label">{ALREADY_HERE}</p>
          <ul className="edit-list">
            {suggestions.map((s) => (
              <li key={s.iri}>
                <span>{s.line}</span>{" "}
                <button
                  type="button"
                  className="ghost edit-btn"
                  aria-label={`${useOn(suggest.className)} (${s.label})`}
                  aria-disabled={busy}
                  onClick={() => !busy && suggest.onUse({ iri: s.iri, label: s.label })}
                >
                  {useOn(suggest.className)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {suggest && (
        <span className="visually-hidden" role="status">
          {said}
        </span>
      )}
      {children}
      <button
        type="button"
        className="link-btn"
        aria-expanded={more}
        aria-controls={`${id}-more`}
        onClick={() => setMore((m) => !m)}
      >
        More options
      </button>
      <div id={`${id}-more`} hidden={!more} className="new-entity-more">
        <label htmlFor={`${id}-iri`} className="edit-field-label">
          Identifier (optional; made from the name when empty)
        </label>
        <input
          id={`${id}-iri`}
          value={iri}
          readOnly={busy}
          placeholder="https://example.org/model#InvoiceItem"
          onChange={(e) => {
            setIri(e.target.value);
            onMoreChange?.({ iri: e.target.value.trim() || undefined });
          }}
        />
        {datatypes && (
          <>
            <label htmlFor={`${id}-datatype`} className="edit-field-label">
              Type of value
            </label>
            <select
              id={`${id}-datatype`}
              value={datatype}
              aria-disabled={busy}
              onChange={(e) => {
                if (busy) return;
                setDatatype(e.target.value);
                onMoreChange?.({ datatype: e.target.value });
              }}
            >
              {DATATYPES.map((d) => (
                <option key={d} value={`xsd:${d}`}>
                  xsd:{d}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {missing && <p className="detail-note">{missing}</p>}
      <div className="edit-actions">
        <button type="submit" className="primary" aria-disabled={blocked}>
          {busy ? "Saving change…" : submitLabel}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The form for a new class, holding its own *Kind of class*: mounted when
 *  it opens, so it starts on the project's default every time. */
export function NewClassForm(props: Omit<NewEntityFormProps, "classKind">) {
  const classKind = useClassKind();
  return <NewEntityForm {...props} classKind={classKind} />;
}
