/*
================================================================================
FILE: frontend/src/components/EditSection.tsx
================================================================================

SUMMARY
    The detail panel's Edit section (visual-modeling 5.1): for an entity of the
    open project's model.ttl, a form over its names in each project language,
    its definition, its other annotations, its structure, its identifier, and
    Delete. Each change is one E-6 command, so one labelled undo step.

BASIC IDEA
    The panel has already fetched the entity's statements; modeling/entity.ts
    reads the form's blocks out of them, and the panel refetches them on each
    new revision, so the form always shows what the server holds. Nothing is
    kept here but what is being typed.

    Every change goes through projectStore.command, which records the new
    revision and announces it in the project's polite live region. A refusal
    is the server's sentence, shown under the field that caused it, with
    nothing changed; the field stays open so it can be corrected. While a
    command is in flight the section says "Saving change…" and its fields are
    read-only -- not disabled, which would drop the focus they hold.

    Read-only cases say why in text (5.1, AC-4). An entity with no rdf:type
    in this document -- a parent from an import, a class only mentioned -- is
    not this document's to change, and the one thing offered for a class is
    to add a subclass of it here. The library and shapes.ttl are decided by
    DetailPanel, which does not render this at all for them.

    The structure blocks are in EditStructure.tsx, the annotation adder in
    AnnotationAdder.tsx, the delete flow in DeleteDialog.tsx, and the pieces
    they share in EditParts.tsx: the spec's "split by block if it grows past
    400 lines".

INPUTS / INPUT SOURCES (props)
    - ontologyId, details: the document and the entity's statements.
    - primaryLanguage, languages: the project's.
    - onSelect: select another entity (a created one, a renamed one, a link).
    - onDeleted: the entity is gone; the caller clears the selection.
    - canvas: past 300 boxes, *Show on canvas* and *Hide from canvas* (5.6).

    Stage 2's follow-ups (5.8) are here too: one runner for the section, the
    annotation adder and the delete dialog; focus back to whatever opened a
    small form; a refusal kept under its own statement, not its place in the
    list; a create that does not move the selection if the section has gone;
    *Copy* that says *Copied*; and a link value that is a link only when it is
    http or https, with *Copy* when it is not (D-088).

EXPECTED OUTPUT
    - Commands through the project store; the section's markup.
================================================================================
*/

import { useMemo, useState } from "react";
import { linkTarget } from "../links";
import { entityModel, type Annotation } from "../modeling/entity";
import { describeValue, typeOfValue, valueProblem, toValue } from "../modeling/values";
import type { CanvasSet, NodeDetails } from "../types";
import AnnotationAdder, { ValueInput } from "./AnnotationAdder";
import DeleteDialog from "./DeleteDialog";
import { Block, InlineText, useCopy, useReturnFocus, useRunner, type Runner } from "./EditParts";
import EditStructure from "./EditStructure";
import NewEntityForm from "./NewEntityForm";

interface Props {
  ontologyId: string;
  details: NodeDetails;
  primaryLanguage: string;
  languages: string[];
  onSelect: (iri: string) => void;
  onDeleted: (iri: string) => void;
  canvas?: CanvasSet | null;
}

/** The key a refusal is kept under: the statement, which survives the list
 *  re-ordering after a refetch, where a position does not (5.8 item 3). */
export function annotationKey(a: Annotation): string {
  const v = a.value;
  return `annotation:${a.property.iri}|${v.kind}|${v.datatype ?? ""}|${v.lang ?? ""}|${v.value}`;
}

export default function EditSection({
  ontologyId,
  details,
  primaryLanguage,
  languages,
  onSelect,
  onDeleted,
  canvas = null,
}: Props) {
  const model = useMemo(
    () => entityModel(details, primaryLanguage, languages),
    [details, primaryLanguage, languages],
  );
  const runner = useRunner();
  const { busy, errors, run, alive } = runner;
  const [copy, copied] = useCopy();
  const [addRef, returnToAdd] = useReturnFocus();
  const [renameRef, returnToRename] = useReturnFocus();
  const [importRef, returnToImport] = useReturnFocus();
  /** Select what a command made, unless the user went elsewhere meanwhile. */
  const follow = (created: string | undefined) => {
    if (created && alive()) onSelect(created);
  };
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [subclassOfImport, setSubclassOfImport] = useState(false);
  const iri = details.iri;
  const name = details.label;

  // 5.1: not this document's to change. The header already names the import.
  if (details.importedFrom || !model.defined) {
    return (
      <section className="edit-section read-only" aria-label="Edit">
        <p className="detail-note">
          {details.importedFrom
            ? `From ${details.importedFrom}, read-only.`
            : "Defined outside this document, read-only."}
        </p>
        {model.kind === "class" &&
          (subclassOfImport ? (
            <NewEntityForm
              title={`New subclass of ${name}`}
              primaryLanguage={primaryLanguage}
              busy={busy}
              error={errors.importSub}
              onCancel={() => {
                setSubclassOfImport(false);
                returnToImport();
              }}
              onSubmit={async ({ name: label, iri: chosen }) => {
                const result = await run("importSub", "CreateClass", { label, parent: iri, iri: chosen });
                follow(result?.created);
              }}
            />
          ) : (
            <button ref={importRef} type="button" className="ghost" onClick={() => setSubclassOfImport(true)}>
              Add a subclass in this project
            </button>
          ))}
      </section>
    );
  }

  const saveName = async (lang: string, value: string, existing: (typeof model.names)[number], primary: boolean) => {
    const field = `name:${lang}`;
    if (!value.trim() && !primary) {
      if (!existing.value || !existing.predicate) return true;
      return (
        (await run(field, "RemoveAnnotation", {
          iri,
          property: existing.predicate,
          value: { kind: "text", value: existing.value, lang: existing.tag ?? lang },
        })) !== null
      );
    }
    // Clearing the primary name is sent as it is: the server refuses it with
    // E-6's sentence, which is the one the spec asks for.
    return (await run(field, "SetLabel", { iri, value, lang: existing.tag ?? lang })) !== null;
  };

  const saveDefinition = async (value: string) => {
    const current = model.definition;
    if (!current) {
      if (!value.trim()) return true;
      const args = { iri, property: "skos:definition", value: { kind: "text", value, lang: primaryLanguage } };
      return (await run("definition", "AddAnnotation", args)) !== null;
    }
    if (!value.trim()) {
      return (await run("definition", "RemoveAnnotation", { iri, property: current.property, value: current.value })) !== null;
    }
    const lang = current.value.kind === "text" ? current.value.lang : primaryLanguage;
    const args = {
      iri,
      property: current.property,
      oldValue: current.value,
      newValue: { kind: "text", value, lang: lang ?? primaryLanguage },
    };
    return (await run("definition", "ReplaceAnnotation", args)) !== null;
  };

  const langs = [primaryLanguage, ...languages.filter((l) => l !== primaryLanguage)];
  return (
    <section className="edit-section" aria-label="Edit" aria-busy={busy}>
      <h3>Edit</h3>
      <p className="detail-note edit-status" role="status">
        {busy ? "Saving change…" : ""}
      </p>
      {canvas?.limited && (
        // 5.6: past 300 boxes the canvas draws what the user chooses.
        <div className="edit-actions">
          {canvas.shown.includes(iri) ? (
            <button type="button" className="ghost" onClick={() => void canvas.hide(iri)}>
              Hide from canvas
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => void canvas.show(iri)}>
              Show on canvas
            </button>
          )}
        </div>
      )}
      {model.partial && (
        // The house rule: a truncated view says it is truncated (found in review).
        <p className="detail-note">
          This entity has more statements than the panel loads, so the lists below may be
          incomplete. The Turtle editor (View) shows them all.
        </p>
      )}

      <Block title="Names">
        <dl className="detail-names">
          {model.names.map((n, i) => (
            <div key={n.lang}>
              <dt>
                {n.lang}
                {i === 0 ? " (required)" : ""}
              </dt>
              <dd>
                <InlineText
                  label={`name in ${n.lang}`}
                  value={n.value}
                  missing="missing"
                  busy={busy}
                  error={errors[`name:${n.lang}`]}
                  onSave={(v) => saveName(n.lang, v, n, i === 0)}
                />
              </dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block title="Definition">
        <InlineText
          label="definition"
          value={model.definition ? model.definition.value.value : null}
          multiline
          busy={busy}
          error={errors.definition}
          onSave={saveDefinition}
        />
      </Block>

      <Block title="Annotations">
        {model.annotations.length === 0 && <p className="detail-note">No other annotations.</p>}
        <ul className="edit-list">
          {model.annotations.map((a) => (
            <AnnotationRow
              key={annotationKey(a)}
              annotation={a}
              iri={iri}
              languages={langs}
              runner={runner}
              copy={copy}
            />
          ))}
        </ul>
        {adding ? (
          <AnnotationAdder
            iri={iri}
            primaryLanguage={primaryLanguage}
            languages={languages}
            runner={runner}
            onDone={() => {
              setAdding(false);
              returnToAdd();
            }}
          />
        ) : (
          <button ref={addRef} type="button" className="ghost" onClick={() => setAdding(true)}>
            Add annotation
          </button>
        )}
      </Block>

      <EditStructure
        ontologyId={ontologyId}
        iri={iri}
        name={name}
        model={model}
        primaryLanguage={primaryLanguage}
        runner={runner}
        onSelect={onSelect}
        follow={follow}
      />

      <Block title="Identifier">
        <div className="edit-value">
          <code className="edit-iri">{iri}</code>
          <button type="button" className="ghost" onClick={() => copy(iri)}>
            Copy
          </button>
          {copied}
        </div>
        {renaming === null ? (
          <button ref={renameRef} type="button" className="ghost" onClick={() => setRenaming(iri)}>
            Change identifier…
          </button>
        ) : (
          <form
            className="edit-rename"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !renaming.trim()) return;
              const result = await run("identifier", "RenameIri", { old: iri, new: renaming.trim() });
              if (result) {
                setRenaming(null);
                follow(result.created ?? renaming.trim());
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(null);
                returnToRename();
              }
            }}
          >
            <p>Other files that use the old identifier will not follow the change.</p>
            <label className="edit-field-label" htmlFor="edit-new-iri">
              New identifier
            </label>
            <input
              id="edit-new-iri"
              autoFocus
              value={renaming}
              readOnly={busy}
              aria-invalid={errors.identifier ? true : undefined}
              onChange={(e) => setRenaming(e.target.value)}
            />
            {errors.identifier && <p className="edit-error">{errors.identifier}</p>}
            <div className="edit-actions">
              <button type="submit" className="primary" aria-disabled={busy || !renaming.trim()}>
                Change identifier
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setRenaming(null);
                  returnToRename();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </Block>

      <div className="edit-delete">
        <button type="button" className="ghost danger" onClick={() => setDeleting(true)}>
          Delete {name}…
        </button>
      </div>
      {deleting && (
        <DeleteDialog
          iri={iri}
          label={name}
          runner={runner}
          onDone={(deleted) => {
            setDeleting(false);
            if (deleted) onDeleted(iri);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One annotation: shown, edited in place, removed
// ---------------------------------------------------------------------------

function AnnotationRow({
  annotation,
  iri,
  languages,
  runner,
  copy,
}: {
  annotation: Annotation;
  iri: string;
  languages: string[];
  runner: Runner;
  copy: (text: string) => void;
}) {
  const { busy, errors, run } = runner;
  const field = annotationKey(annotation);
  const [editRef, returnToEdit] = useReturnFocus();
  const close = () => {
    setDraft(null);
    returnToEdit();
  };
  // A link value is a link only when it is a web address (D-088); anything
  // else is text, with Copy (5.8 item 11).
  const href = linkTarget(annotation.value.kind === "link" ? annotation.value.value : null);
  const type = typeOfValue(annotation.value);
  const [draft, setDraft] = useState<{ value: string; lang: string } | null>(null);
  const problem = draft && draft.value !== "" ? valueProblem(type, draft.value, draft.lang) : null;
  const words = `${annotation.property.prefixed}: ${annotation.value.value}`;

  if (draft === null) {
    return (
      <li className="edit-annotation">
        <span className="edit-annotation-property">{annotation.property.prefixed}</span>{" "}
        {href ? (
          <a className="edit-annotation-value" href={href} target="_blank" rel="noreferrer">
            {annotation.value.value}
          </a>
        ) : (
          <span className="edit-annotation-value">{annotation.value.value}</span>
        )}{" "}
        <span className="edit-annotation-kind">({describeValue(annotation.value)})</span>
        {annotation.value.kind === "link" && !href && (
          <button
            type="button"
            className="ghost edit-btn"
            aria-label={`Copy ${annotation.value.value}`}
            onClick={() => copy(annotation.value.value)}
          >
            Copy
          </button>
        )}
        {annotation.editable ? (
          <>
            <button
              ref={editRef}
              type="button"
              className="ghost edit-btn"
              aria-label={`Edit ${words}`}
              onClick={() => setDraft({ value: annotation.value.value, lang: annotation.value.lang ?? languages[0] })}
            >
              Edit
            </button>
            <button
              type="button"
              className="ghost edit-btn"
              aria-label={`Remove ${words}`}
              aria-disabled={busy}
              onClick={() => !busy && void run(field, "RemoveAnnotation", { iri, property: annotation.property.iri, value: annotation.value })}
            >
              Remove
            </button>
          </>
        ) : (
          <span className="detail-note"> Edit this one in Turtle (View).</span>
        )}
        {errors[field] && <p className="edit-error">{errors[field]}</p>}
      </li>
    );
  }
  const blocked = busy || valueProblem(type, draft.value, draft.lang) !== null;
  return (
    <li className="edit-annotation editing">
      <form
        aria-label={`Edit ${annotation.property.prefixed}`}
        onSubmit={async (e) => {
          e.preventDefault();
          if (blocked) return;
          const newValue = toValue(type, draft.value, type.kind === "text" ? draft.lang : undefined);
          const result = await run(field, "ReplaceAnnotation", {
            iri,
            property: annotation.property.iri,
            oldValue: annotation.value,
            newValue,
          });
          if (result) close();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <ValueInput
          type={type}
          value={draft.value}
          lang={draft.lang}
          languages={languages}
          label={annotation.property.prefixed}
          busy={busy}
          autoFocus
          invalid={problem !== null || Boolean(errors[field])}
          onChange={(value, lang) => setDraft({ value, lang })}
        />
        {(problem || errors[field]) && <p className="edit-error">{errors[field] || problem}</p>}
        <div className="edit-actions">
          <button type="submit" className="primary" aria-disabled={blocked}>
            Save
          </button>
          <button type="button" className="ghost" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );
}
