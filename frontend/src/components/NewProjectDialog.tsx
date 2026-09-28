/*
================================================================================
FILE: frontend/src/components/NewProjectDialog.tsx
================================================================================

SUMMARY
    The New project form (authoring-foundations 5.1): a name, a starting
    point (one of three templates, or an ontology from the library), a base
    IRI and a prefix defaulted from the name, and the primary language.

BASIC IDEA
    The base IRI and prefix follow the name until the user edits them, and
    then stop following: a default that overwrote a typed value would be a
    trap. Create is not disabled but aria-disabled, with the first reason it
    is unavailable written beside it and joined to its accessible name, so a
    keyboard user who reaches it hears why rather than meeting a dead control
    (and the focus-loss rule never arises). Each invalid field says so inline
    once it has been touched.

    The dialog does not create anything itself; it hands the fields to
    onCreate and shows the server's sentence if that fails.

INPUTS / INPUT SOURCES (props)
    - library: the ontologies a project can start from.
    - initialSource: a library ontology id to preselect ("Start a project from
      this" on a library card), or undefined for the Small ontology template.
    - onCreate: carries out the creation; resolves when the project is open.
    - onClose: the dialog's three exits (Cancel, Escape, backdrop).

EXPECTED OUTPUT
    - The form; one onCreate call per valid submission.
================================================================================
*/

import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  defaultBaseIri,
  defaultPrefix,
  firstReason,
  validate,
  type NewProjectFields,
} from "../projects/form";
import type { ProjectTemplate } from "../types";
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

const TEMPLATES: { value: ProjectTemplate; label: string }[] = [
  { value: "empty", label: "Empty ontology" },
  { value: "vocabulary", label: "Simple vocabulary (a SKOS scheme with two concepts)" },
  { value: "small", label: "Small ontology (two classes and one property)" },
];

export default function NewProjectDialog({ library, initialSource, onCreate, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  const [name, setName] = useState(() =>
    initialSource ? library.find((o) => o.id === initialSource)?.name.replace(/\.[a-z]+$/i, "") ?? "" : "",
  );
  // "template:<name>" or "library:<id>", one select for both kinds of start.
  const [source, setSource] = useState(initialSource ? `library:${initialSource}` : "template:small");
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
  const reason = firstReason(errors);
  const touch = (field: string) => setTouched((prev) => new Set(prev).add(field));
  const shown = (field: keyof NewProjectFields) => (touched.has(field) ? errors[field] : undefined);

  const submit = async () => {
    setTouched(new Set(["name", "baseIri", "prefix", "primaryLanguage"]));
    if (reason || busy) return;
    const [kind, value] = source.split(/:(.*)/s);
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: fields.name.trim(),
        ...(kind === "library" ? { fromOntologyId: value } : { template: value as ProjectTemplate }),
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
          {field("name", "Name", name, setName)}
          <div className="form-field">
            <label htmlFor="new-project-source">Start from</label>
            <select id="new-project-source" value={source} onChange={(e) => setSource(e.target.value)}>
              <optgroup label="Templates">
                {TEMPLATES.map((t) => (
                  <option key={t.value} value={`template:${t.value}`}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
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
