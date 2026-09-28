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

EXPECTED OUTPUT
    - The form; one onSubmit per Create.
================================================================================
*/

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DATATYPES } from "../modeling/values";

export interface NewEntity {
  name: string;
  iri?: string;
  datatype?: string;
}

interface Props {
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
}: Props) {
  const id = useId();
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [iri, setIri] = useState("");
  const [datatype, setDatatype] = useState("xsd:string");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const blocked = busy || !name.trim() || missing !== null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    onSubmit({
      name: name.trim(),
      ...(iri.trim() ? { iri: iri.trim() } : {}),
      ...(datatypes ? { datatype } : {}),
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
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      {error && (
        <p id={`${id}-error`} className="edit-error">
          {error}
        </p>
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
          onChange={(e) => setIri(e.target.value)}
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
              onChange={(e) => !busy && setDatatype(e.target.value)}
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
