/*
================================================================================
FILE: frontend/src/components/NewProjectDialog.tsx
================================================================================

SUMMARY
    The New project form (authoring-foundations 5.1, relationships 5.1):
    first the kind, Ontology or Taxonomy, each with its sentence; then a
    name, a description, a starting point (the chosen kind's two templates,
    or an ontology from the library), for a template the reference
    ontologies to reuse terms from (reference-ontologies 5.4), a base IRI
    and a prefix defaulted from the name, and the primary language.

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

    *Reuse terms from* is a fieldset of checkboxes, one per reference
    ontology GET /api/references lists, each labelled by its title and
    purpose; nothing is ticked at first, and a library copy, which keeps
    its own file, is not offered it. The description is prefilled -- *An
    ontology for {name}.* and each ticked reference's sentence -- and follows
    the name and the boxes until the person types in it, as the base IRI
    follows the name. Its counter is said only once the limit is passed,
    through a live region rendered while empty. A prefix equal to a ticked
    reference's is refused under the field, in the server's words.

    With a namespace set in Settings → Naming (design-checks 5.2), an
    **Address** group stands above the base IRI: Layer as native radios in
    a fieldset (Domain first, arrow keys move between them), the area
    named by the layer (Domain or Application; Core asks for none), the
    subject following the name, the type by kind, the data domain
    following the area, and the three lines the pattern gives. The base IRI
    field holds the Model line and may still be written by hand; the group
    then says so, and keeps its Shapes and Data lines only while the base
    ends in -<type>#. Each name is refused inline, its sentence the field's
    description, and Create's reason names the first. With no namespace
    the group is absent and one line under the base IRI points to Settings
    → Naming; its button opens Settings over this form, which stays mounted
    (`covered`, hidden and out of the modal stack) so what was typed is
    there when Settings closes, focus back on that button. The namespace
    is read once, when the form opens: a Save while it is open changes
    nothing here until the form is opened again (5.11).

    The dialog does not create anything itself; it hands the fields to
    onCreate and shows the server's sentence if that fails.

INPUTS / INPUT SOURCES (props)
    - library: the ontologies a project can start from.
    - initialSource: a library ontology id to preselect ("Start a project from
      this" on a library card), or undefined to start by choosing a kind.
    - onCreate: carries out the creation; resolves when the project is open.
    - onClose: the dialog's three exits (Cancel, Escape, backdrop).
    - onOpenNaming: opens Settings on Naming over the form.
    - covered: Settings is open over the form; it hides and lets go of the
      keyboard until it is not.

EXPECTED OUTPUT
    - The form; one onCreate call per valid submission.
================================================================================
*/

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getSettings, listReferences } from "../api";
import { GUIDELINES } from "../naming/words";
import type { ArtifactType, Layer } from "../naming/address";
import {
  CHOOSE_KIND,
  DESCRIPTION_MAX,
  EXAMPLE_ADDRESS,
  LAYERS,
  OWN_ADDRESS,
  addressErrors,
  addressLines,
  areaLabel,
  defaultBaseIri,
  defaultDescription,
  defaultPrefix,
  defaultSubject,
  firstReason,
  KIND_CHOICES,
  typeChoices,
  validate,
  type AddressFields,
  type NewProjectFields,
} from "../projects/form";
import type { ProjectKind, ProjectNaming, ProjectTemplate, ReferenceOntology } from "../types";
import { useDialogTrap } from "./useDialogTrap";

export interface NewProjectRequest {
  name: string;
  template?: ProjectTemplate;
  fromOntologyId?: string;
  baseIri: string;
  prefix: string;
  primaryLanguage: string;
  /** The reference ontologies a template reuses; absent for a copy. */
  references?: string[];
  /** The header's rdfs:comment; "" when cleared, which writes none. */
  description: string;
  /** The Address group (design-checks 5.2), sent while the pattern applies. */
  address?: Omit<ProjectNaming, "namespace">;
}

interface Props {
  library: { id: string; name: string }[];
  initialSource?: string;
  onCreate: (request: NewProjectRequest) => Promise<void>;
  onClose: () => void;
  onOpenNaming?: () => void;
  covered?: boolean;
}

export default function NewProjectDialog({
  library,
  initialSource,
  onCreate,
  onClose,
  onOpenNaming,
  covered = false,
}: Props) {
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
  const [references, setReferences] = useState<ReferenceOntology[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  // null while it follows the name and the boxes (5.4 item 3).
  const [description, setDescription] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Without the list there is nothing to offer, and nothing to refuse:
    // the form is the one it was before references.
    listReferences()
      .then((found) => live && setReferences(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // The organization's namespace, read once as the form opens (5.2): null
  // when none is set, undefined until the answer comes. A failed read is
  // no namespace, the form as it was before the pattern.
  const [namespace, setNamespace] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getSettings()
      .then((answer) => live && setNamespace(answer.naming?.namespace ?? null))
      .catch(() => live && setNamespace(null));
    return () => {
      live = false;
    };
  }, []);
  const [layer, setLayer] = useState<Layer>("domain");
  const [area, setArea] = useState("");
  // null while each follows: the subject the name, the data domain the area.
  const [subject, setSubject] = useState<string | null>(null);
  const [dataDomain, setDataDomain] = useState<string | null>(null);
  const [type, setType] = useState<ArtifactType | null>(null);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const escape = useCallback(() => {
    if (!busy && !covered) onClose();
  }, [busy, covered, onClose]);
  useDialogTrap(panelRef, headingRef, escape, !covered);

  // Back from Settings: focus returns to the button that opened it.
  const namingLinkRef = useRef<HTMLButtonElement>(null);
  const wasCovered = useRef(covered);
  useEffect(() => {
    if (wasCovered.current && !covered) namingLinkRef.current?.focus();
    wasCovered.current = covered;
  }, [covered]);

  // A copy keeps its own file: only a template reuses terms.
  const chosen = fromLibrary ? [] : references.filter((r) => ticked.has(r.key));
  const types = typeChoices(fromLibrary ? null : kind);
  const address: AddressFields = {
    layer,
    area: layer === "core" ? "" : area,
    subject: subject ?? defaultSubject(name),
    type: type && types.some((t) => t.value === type) ? type : types[0].value,
    dataDomain: dataDomain ?? (layer === "domain" ? area : ""),
  };
  const lines = namespace ? addressLines(namespace, address, baseIri) : null;
  const fields: NewProjectFields = {
    name,
    baseIri: baseIri ?? (lines ? lines.model : defaultBaseIri(name)),
    prefix: prefix ?? defaultPrefix(name),
    primaryLanguage,
    description: description ?? defaultDescription(name, chosen),
  };
  const errors = useMemo(
    () => validate(fields, chosen),
    [name, baseIri, prefix, primaryLanguage, description, references, ticked, fromLibrary, namespace, layer, area, subject, type],
  );
  // The group's names count only while the pattern applies.
  const groupErrors = lines?.follows ? addressErrors(address) : {};
  const groupReason = groupErrors.area ?? groupErrors.subject ?? groupErrors.dataDomain ?? null;
  const toggle = (key: string) => {
    // A clash with the prefix is said at once, under the field (5.4 item 4).
    touch("prefix");
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const descriptionLength = (fields.description ?? "").trim().length;
  const overLimit = descriptionLength > DESCRIPTION_MAX;
  // The kind first: it is the first question the form asks (Section 6).
  const reason = source === "" ? CHOOSE_KIND : (firstReason(errors) ?? groupReason);
  const touch = (field: string) => setTouched((prev) => new Set(prev).add(field));
  const shown = (field: keyof NewProjectFields) => (touched.has(field) ? errors[field] : undefined);

  const submit = async () => {
    setTouched(new Set(["name", "description", "baseIri", "prefix", "primaryLanguage", "area", "subject", "dataDomain"]));
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
        ...(from === "library" ? {} : { references: chosen.map((r) => r.key) }),
        description: (fields.description ?? "").trim(),
        ...(lines?.follows
          ? {
              address: {
                layer: address.layer,
                area: address.area,
                subject: address.subject,
                type: address.type as ProjectNaming["type"],
                dataDomain: address.dataDomain,
              },
            }
          : {}),
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
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={escape} hidden={covered} />
      {/* Covered by Settings: hidden and out of the modal stack, so
          Settings' keys are its own; mounted, so what was typed stays. */}
      <div
        ref={panelRef}
        className="confirm-dialog new-project-dialog"
        role="dialog"
        aria-modal={covered ? undefined : "true"}
        aria-labelledby="new-project-title"
        hidden={covered}
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
            <label htmlFor="new-project-description">Description</label>
            <textarea
              id="new-project-description"
              className="new-project-description"
              rows={3}
              value={fields.description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={overLimit ? true : undefined}
              aria-describedby="new-project-description-hint new-project-description-count"
            />
            <p id="new-project-description-hint" className="form-hint">
              {fromLibrary
                ? "Written into the file, where other tools read it. A copy that has a description keeps its own."
                : "Written into the file, where other tools read it. Clear it to write none."}
            </p>
            {/* Rendered while empty, so the counter is heard the moment the
                limit is passed and not before (5.8). */}
            <p id="new-project-description-count" className="form-error" aria-live="polite">
              {overLimit
                ? `${descriptionLength.toLocaleString("en")} of ${DESCRIPTION_MAX.toLocaleString("en")} characters: shorten it by ${(descriptionLength - DESCRIPTION_MAX).toLocaleString("en")}.`
                : ""}
            </p>
          </div>
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
          {!fromLibrary && source !== "" && references.length > 0 && (
            <fieldset className="form-field new-project-references">
              <legend>Reuse terms from</legend>
              {references.map((r) => (
                <label key={r.key} className="new-project-reference">
                  <input type="checkbox" checked={ticked.has(r.key)} onChange={() => toggle(r.key)} />
                  <span>
                    <strong>{r.title}</strong>: {r.purpose}
                  </span>
                </label>
              ))}
              <p className="form-hint">
                Adds their prefixes, so the Edit pickers offer their terms. Nothing is imported.
              </p>
            </fieldset>
          )}
          {lines && (
            <AddressGroup
              address={address}
              lines={lines}
              types={types}
              errors={groupErrors}
              touched={touched}
              onTouch={touch}
              onLayer={setLayer}
              onArea={setArea}
              onSubject={setSubject}
              onType={setType}
              onDataDomain={setDataDomain}
            />
          )}
          {field(
            "baseIri",
            "Base IRI",
            fields.baseIri,
            setBaseIri,
            lines
              ? "New entities are named under this. It follows the Address group until you change it."
              : "New entities are named under this. It follows the name until you change it.",
          )}
          {namespace === null && (
            <p className="form-hint new-project-example-address">
              {EXAMPLE_ADDRESS.replace(" Settings → Naming.", " ")}
              <button
                ref={namingLinkRef}
                type="button"
                className="link-btn"
                onClick={() => onOpenNaming?.()}
              >
                Settings → Naming
              </button>
              .
            </p>
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

const ADDRESS_FIELD_IDS = { area: "new-project-area", subject: "new-project-subject", dataDomain: "new-project-data-domain" };

/** The Address group of design-checks 5.2: the parts and the three lines. */
function AddressGroup({
  address,
  lines,
  types,
  errors,
  touched,
  onTouch,
  onLayer,
  onArea,
  onSubject,
  onType,
  onDataDomain,
}: {
  address: AddressFields;
  lines: { model: string; shapes: string | null; data: string | null; follows: boolean };
  types: { value: ArtifactType; label: string }[];
  errors: Partial<Record<"area" | "subject" | "dataDomain", string>>;
  touched: Set<string>;
  onTouch: (field: string) => void;
  onLayer: (layer: Layer) => void;
  onArea: (v: string) => void;
  onSubject: (v: string) => void;
  onType: (t: ArtifactType) => void;
  onDataDomain: (v: string) => void;
}) {
  const part = (key: "area" | "subject" | "dataDomain", label: string, value: string, set: (v: string) => void, hint?: string) => {
    const id = ADDRESS_FIELD_IDS[key];
    // A name is refused as soon as something is typed, or once touched.
    const message = (value !== "" || touched.has(key)) && lines.follows ? errors[key] : undefined;
    return (
      <div className="form-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => set(e.target.value)}
          onBlur={() => onTouch(key)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
        {message ? (
          <p id={`${id}-error`} className="form-error">
            {message}
          </p>
        ) : (
          hint && (
            <p id={`${id}-hint`} className="form-hint">
              {hint}
            </p>
          )
        )}
      </div>
    );
  };
  const areaName = areaLabel(address.layer);
  return (
    <fieldset className="form-field new-project-address">
      <legend>Address</legend>
      <fieldset className="new-project-layers">
        <legend>Layer</legend>
        {LAYERS.map((l) => (
          <label key={l.value} className="new-project-layer">
            <input
              type="radio"
              name="new-project-layer"
              value={l.value}
              checked={address.layer === l.value}
              onChange={() => onLayer(l.value)}
            />
            {l.label}
          </label>
        ))}
      </fieldset>
      {areaName && part("area", areaName, address.area, onArea)}
      {part("subject", "Subject", address.subject, onSubject, "Follows the project name until you edit it.")}
      <div className="form-field">
        <label htmlFor="new-project-type">Type</label>
        <select
          id="new-project-type"
          value={address.type}
          onChange={(e) => onType(e.target.value as ArtifactType)}
          aria-describedby="new-project-type-hint"
        >
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p id="new-project-type-hint" className="form-hint">
          {types.length === 2
            ? "Taxonomy for a hierarchy, Vocabulary for a flat list."
            : types.length === 1
              ? "Ontology for an ontology project."
              : "A copy's kind is judged from what it holds."}
        </p>
      </div>
      {part(
        "dataDomain",
        "Data domain",
        address.dataDomain,
        onDataDomain,
        address.layer === "domain" ? "Follows Domain until you edit it." : undefined,
      )}
      {!lines.follows && <p className="form-hint">{OWN_ADDRESS}</p>}
      <dl className="naming-lines new-project-lines" aria-label="The addresses this project will use">
        <div>
          <dt>Model</dt>
          <dd>
            <code>{lines.model}</code>
          </dd>
        </div>
        {lines.shapes && (
          <div>
            <dt>Shapes</dt>
            <dd>
              <code>{lines.shapes}</code>
            </dd>
          </div>
        )}
        {lines.data && (
          <div>
            <dt>Data</dt>
            <dd>
              <code>{lines.data}</code>
            </dd>
          </div>
        )}
      </dl>
      <p className="form-hint">{GUIDELINES}</p>
    </fieldset>
  );
}
