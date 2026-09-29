/*
================================================================================
FILE: frontend/src/components/NewProjectDialog.tsx
================================================================================

SUMMARY
    The New project form (authoring-foundations 5.1, relationships 5.1):
    first the kind, Ontology or Taxonomy, each with its sentence; then a
    name, a starting point (the chosen kind's two templates, or an ontology
    from the library), a base IRI and a prefix defaulted from the name, and
    the primary language.

BASIC IDEA
    The base IRI and prefix follow the name until the user edits them, and
    then stop following: a default that overwrote a typed value would be a
    trap. Create is not disabled but aria-disabled, with the first reason it
    is unavailable written beside it and joined to its accessible name, so a
    keyboard user who reaches it hears why rather than meeting a dead control
    (and the focus-loss rule never arises). Each invalid field says so inline
    once it has been touched.

    The kind is two native radio buttons in a fieldset, each labelled by its
    name and sentence, so a screen reader reads the sentence as it lands on
    the choice. Nothing is chosen at first -- the choice is the learner's to
    make, not a default to overlook -- and Create says *Choose Ontology or
    Taxonomy.* until one is. A library copy needs no choice: the server
    judges its kind from what it holds (D-089).

    The dialog does not create anything itself; it hands the fields to
    onCreate and shows the server's sentence if that fails.

INPUTS / INPUT SOURCES (props)
    - library: the ontologies a project can start from.
    - initialSource: a library ontology id to preselect ("Start a project from
      this" on a library card), or undefined to start by choosing a kind.
    - onCreate: carries out the creation; resolves when the project is open.
    - onClose: the dialog's three exits (Cancel, Escape, backdrop).

EXPECTED OUTPUT
    - The form; one onCreate call per valid submission.
================================================================================
*/

import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  CHOOSE_KIND,
  defaultBaseIri,
  defaultPrefix,
  firstReason,
  KIND_CHOICES,
  validate,
  type NewProjectFields,
} from "../projects/form";
import type { ProjectKind, ProjectTemplate } from "../types";
import { useDialogTrap } from "./useDialogTrap";

export interface NewProjectRequest {
  name: string;
  template?: ProjectTemplate;
  fromOntologyId?: string;
  baseIri: string;
  prefix: string;
  primaryLanguage: string;
}

interface Props {
  library: { id: string; name: string }[];
  initialSource?: string;
  onCreate: (request: NewProjectRequest) => Promise<void>;
  onClose: () => void;
}

export default function NewProjectDialog({ library, initialSource, onCreate, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  const [name, setName] = useState(() =>
    initialSource ? library.find((o) => o.id === initialSource)?.name.replace(/\.[a-z]+$/i, "") ?? "" : "",
  );
  const [kind, setKind] = useState<ProjectKind | null>(null);
  // "template:<name>" or "library:<id>", one select for both kinds of start;
  // "" until a kind is chosen or a library ontology picked.
  const [source, setSource] = useState(initialSource ? `library:${initialSource}` : "");
  const templates = KIND_CHOICES.find((c) => c.kind === kind)?.templates ?? [];
  // A library copy's kind is judged by the server from what it holds, so
  // picking one clears the kind rather than leave a choice the server will
  // not use on screen (found in review); a note says how it is judged.
  const chooseSource = (next: string) => {
    setSource(next);
    if (next.startsWith("library:")) setKind(null);
  };
  const fromLibrary = source.startsWith("library:");
  const chooseKind = (next: ProjectKind) => {
    setKind(next);
    // The kind's small template: a first project with something in it to
    // look at, as the E-6 form started from Small ontology.
    setSource(`template:${next === "ontology" ? "small" : "taxonomy-small"}`);
  };
  const [baseIri, setBaseIri] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [primaryLanguage, setPrimaryLanguage] = useState("en");
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const escape = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useDialogTrap(panelRef, headingRef, escape);

  const fields: NewProjectFields = {
    name,
    baseIri: baseIri ?? defaultBaseIri(name),
    prefix: prefix ?? defaultPrefix(name),
    primaryLanguage,
  };
  const errors = useMemo(() => validate(fields), [name, baseIri, prefix, primaryLanguage]);
  // The kind first: it is the first question the form asks (Section 6).
  const reason = source === "" ? CHOOSE_KIND : firstReason(errors);
  const touch = (field: string) => setTouched((prev) => new Set(prev).add(field));
  const shown = (field: keyof NewProjectFields) => (touched.has(field) ? errors[field] : undefined);

  const submit = async () => {
    setTouched(new Set(["name", "baseIri", "prefix", "primaryLanguage"]));
    if (reason || busy) return;
    const [from, value] = source.split(/:(.*)/s);
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: fields.name.trim(),
        ...(from === "library" ? { fromOntologyId: value } : { template: value as ProjectTemplate }),
        baseIri: fields.baseIri.trim(),
        prefix: fields.prefix.trim(),
        primaryLanguage: fields.primaryLanguage.trim(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const field = (
    id: keyof NewProjectFields,
    label: string,
    value: string,
    onChange: (v: string) => void,
    hint?: string,
  ) => {
    const message = shown(id);
    return (
      <div className="form-field">
        <label htmlFor={`new-project-${id}`}>{label}</label>
        <input
          id={`new-project-${id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => touch(id)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `new-project-${id}-error` : hint ? `new-project-${id}-hint` : undefined}
          spellCheck={false}
        />
        {message ? (
          <p id={`new-project-${id}-error`} className="form-error">
            {message}
          </p>
        ) : (
          hint && (
            <p id={`new-project-${id}-hint`} className="form-hint">
              {hint}
            </p>
          )
        )}
      </div>
    );
  };

  return (
    <>
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={escape} />
      <div
        ref={panelRef}
        className="confirm-dialog new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <h2 id="new-project-title" ref={headingRef} tabIndex={-1} className="confirm-title">
          New project
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="form-field new-project-kinds">
            <legend>What are you making?</legend>
            {KIND_CHOICES.map((choice) => (
              <label key={choice.kind} className={`new-project-kind${kind === choice.kind ? " chosen" : ""}`}>
                <input
                  type="radio"
                  name="new-project-kind"
                  value={choice.kind}
                  checked={kind === choice.kind}
                  onChange={() => chooseKind(choice.kind)}
                />
                <span className="new-project-kind-text">
                  <strong>{choice.label}</strong>
                  <span>{choice.sentence}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {field("name", "Name", name, setName)}
          <div className="form-field">
            <label htmlFor="new-project-source">Start from</label>
            <select
              id="new-project-source"
              value={source}
              onChange={(e) => chooseSource(e.target.value)}
              aria-describedby={fromLibrary ? "new-project-source-hint" : undefined}
            >
              {source === "" && (
                <option value="" disabled>
                  Choose Ontology or Taxonomy first
                </option>
              )}
              {templates.length > 0 && (
                <optgroup label="Templates">
                  {templates.map((t) => (
                    <option key={t.value} value={`template:${t.value}`}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {library.length > 0 && (
                <optgroup label="A copy of an ontology in your library">
                  {library.map((o) => (
                    <option key={o.id} value={`library:${o.id}`}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {fromLibrary && (
              <p id="new-project-source-hint" className="form-hint">
                A copy is an ontology or a taxonomy by what it holds: concepts and no classes make a taxonomy.
                Choosing a kind above starts from its template instead.
              </p>
            )}
          </div>
          {field(
            "baseIri",
            "Base IRI",
            fields.baseIri,
            setBaseIri,
            "New entities are named under this. It follows the name until you change it.",
          )}
          {field("prefix", "Prefix", fields.prefix, setPrefix)}
          {field(
            "primaryLanguage",
            "Primary language",
            primaryLanguage,
            setPrimaryLanguage,
            "Every name is required in this language. en is what published vocabularies use.",
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={escape} aria-disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              aria-disabled={reason !== null || busy}
              aria-describedby={reason ? reasonId : undefined}
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
          {reason && (
            <p id={reasonId} className="form-hint new-project-reason">
              {reason}
            </p>
          )}
        </form>
      </div>
    </>
  );
}
