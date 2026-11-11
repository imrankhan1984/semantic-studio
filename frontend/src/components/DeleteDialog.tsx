/*
================================================================================
FILE: frontend/src/components/DeleteDialog.tsx
================================================================================

SUMMARY
    Delete with its impact first (visual-modeling 5.3): the tree's "Delete…",
    the form's "Delete" and the canvas's Delete key all open this. It asks the
    server what the delete would take, says so in sentences, offers what to do
    with the children when there are any, and deletes only on confirmation.
    When other project files use the term (links-between-files 5.3), it says
    which, and its first, focused answer is *Deprecate instead*; the edit
    section's *Deprecate {name}…* opens its Deprecate step directly (5.4).

BASIC IDEA
    DeleteEntity has a dry run (authoring-foundations 5.5) that changes
    nothing and returns the impact: the statements removed, the children and
    the parents they would move up to, the properties whose domain or range
    is the entity, the individuals typed with it, the mentions in read-only
    imports, and the uses in the project's other files. This renders that
    inside the existing ConfirmDialog, so the keyboard behaviour is the one
    every other question already has.

    The strategy question appears only when there are children: with none,
    reparent and orphan do the same thing and asking would be noise. The
    words follow 5.3 exactly (5.8 item 7): an object property is a
    *relationship* and a datatype property an *attribute*, and one child is
    *it* where two are *them*.

    With no uses elsewhere the dialog is the one it always was (AC-14). With
    uses, the safe answer is the first button and holds the focus (Section
    7): *Deprecate instead* opens the Deprecate step in the same dialog, with
    its own *Deprecate* focused, so Enter, then Enter again, deprecates and
    never deletes. *Delete anyway* stays (5.3 item 6): it deletes the term in
    its own file only, and the other files' statements are left as they are.
    The step offers an optional *Replaced by*, a term of the same kind
    chosen with EntityPicker; *Back* returns to the question.

    The command goes through the caller's runner, so the section that opened
    the dialog shows it busy (5.8 item 1). If the dry run cannot run at all,
    the dialog says so and offers only Cancel, rather than waiting for ever
    (item 8).

    The announcement after the delete is the spec's sentence, "Deleted class
    Invoice. Undo is available.", rather than the usual status, because the
    thing a learner most needs to hear after a delete is that it can be taken
    back; after a deprecation, "Deprecated Pump. Undo is available." (5.3
    item 4).

INPUTS / INPUT SOURCES (props)
    - iri, label: what to delete.
    - runner: the section's command runner.
    - onDone(deleted): closes the dialog; `deleted` says whether it happened.
    - start: "deprecate" opens the Deprecate step without the delete's
      question (the edit section's button); `kind`, the term's kind, picks
      what *Replaced by* offers there.
    Plus the project store (the open project and document) and api.ts.

EXPECTED OUTPUT
    - The dialog; one DeleteEntity or one Deprecate command on confirmation.
================================================================================
*/

import { useEffect, useState } from "react";
import { previewDelete } from "../api";
import { deleteUses } from "../modeling/usesWords";
import { projectStore } from "../state/projectStore";
import type { DeleteImpact, SearchKind } from "../types";
import ConfirmDialog, { type DialogAction } from "./ConfirmDialog";
import type { Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";

interface Props {
  iri: string;
  label: string;
  runner: Runner;
  onDone: (deleted: boolean) => void;
  start?: "delete" | "deprecate";
  kind?: string;
}

const CHILD_WORDS: Record<string, [string, string]> = {
  class: ["subclass", "subclasses"],
  concept: ["narrower concept", "narrower concepts"],
};

const PROPERTY_WORDS: Record<string, [string, string]> = {
  "object property": ["relationship", "relationships"],
  "datatype property": ["attribute", "attributes"],
};

/** What *Replaced by* offers: a term of the same kind (5.3 item 4). */
const PICKER_KIND: Record<string, SearchKind> = {
  class: "class",
  concept: "concept",
  "object property": "objectProperty",
  "datatype property": "datatypeProperty",
  "annotation property": "annotationProperty",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(refs: { label: string }[]): string {
  return refs.map((r) => r.label).join(", ");
}

/** "1 relationship points to it (belongs to, as its range). It is kept,
 *  without a range." -- 5.3's sentence, for any mix of property kinds. */
function propertySentence(properties: DeleteImpact["properties"]): string {
  const kinds = new Set(properties.map((p) => p.kind ?? ""));
  const [one, many] = kinds.size === 1 ? (PROPERTY_WORDS[[...kinds][0]] ?? ["property", "properties"]) : ["property", "properties"];
  const n = properties.length;
  const which = properties.map((p) => `${p.label}, as its ${p.role}`).join("; ");
  const kept =
    n === 1 ? `It is kept, without a ${properties[0].role}.` : "They are kept, without it.";
  return `${plural(n, one, many)} ${n === 1 ? "points" : "point"} to it (${which}). ${kept}`;
}

export default function DeleteDialog({ iri, label, runner, onDone, start = "delete", kind }: Props) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [strategy, setStrategy] = useState<"reparent" | "orphan">("reparent");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<"delete" | "deprecate">(start);
  const [replacement, setReplacement] = useState<{ iri: string; label: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const { busy, errors, run } = runner;

  useEffect(() => {
    if (start === "deprecate") return; // the Deprecate step needs no plan
    const state = projectStore.getSnapshot();
    if (!state.project) {
      setLoadError("The delete cannot be checked: no project is open.");
      return;
    }
    let cancelled = false;
    previewDelete(state.project.id, state.activeDoc, iri, "reparent")
      .then((r) => !cancelled && setImpact(r.impact))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setLoadError(`What deleting ${label} would take could not be worked out: ${e instanceof Error ? e.message : String(e)}`),
      );
    return () => {
      cancelled = true;
    };
  }, [iri, label, start]);

  const deprecate = async () => {
    const args: Record<string, unknown> = { iri };
    if (replacement) args.replacedBy = replacement.iri;
    const result = await run("deprecate", "Deprecate", args, (r) => `${r.label}. Undo is available.`);
    if (result) onDone(false);
  };

  const answer = async (id: string) => {
    if (id === "deprecate-instead") {
      setStep("deprecate");
      return;
    }
    if (id === "back") {
      setStep("delete");
      setPicking(false);
      return;
    }
    if (id === "deprecate") {
      await deprecate();
      return;
    }
    if (id !== "delete" || !impact) {
      onDone(false);
      return;
    }
    const result = await run("delete", "DeleteEntity", { iri, strategy }, (r) => `${r.label}. Undo is available.`);
    if (result) onDone(true);
  };

  const [one, many] = CHILD_WORDS[impact?.kind ?? ""] ?? ["subproperty", "subproperties"];
  const name = impact?.label ?? label;
  const parents = impact?.reparentedTo ?? [];
  const them = impact?.children.length === 1 ? "it" : "them";
  const uses = impact?.uses ?? [];
  const elsewhere = uses.length > 0;
  const error =
    loadError || (step === "deprecate" ? errors.deprecate : errors.delete || errors.deprecate) || null;

  let actions: DialogAction[];
  let focus: string | undefined;
  if (step === "deprecate") {
    actions = [
      { id: "deprecate", label: busy ? "Deprecating…" : "Deprecate", primary: true },
      start === "deprecate" ? { id: "cancel", label: "Cancel" } : { id: "back", label: "Back" },
    ];
    focus = picking ? undefined : "deprecate";
  } else if (impact && elsewhere) {
    // The safe answer first, and focused (5.3 item 3, Section 7).
    actions = [
      { id: "deprecate-instead", label: "Deprecate instead", primary: true },
      { id: "delete", label: busy ? "Deleting…" : "Delete anyway", danger: true },
      { id: "cancel", label: "Cancel" },
    ];
    focus = "deprecate-instead";
  } else {
    actions = [
      ...(impact ? [{ id: "delete", label: busy ? "Deleting…" : "Delete", danger: true }] : []),
      { id: "cancel", label: "Cancel", primary: true },
    ];
  }

  const project = projectStore.getSnapshot();
  const ontologyId = project.project ? `${project.project.id}-${project.activeDoc}` : null;
  const pickerKind = PICKER_KIND[impact?.kind ?? kind ?? ""];
  const words = elsewhere ? deleteUses(uses, name) : null;

  return (
    <ConfirmDialog
      title={step === "deprecate" ? `Deprecate ${name}?` : `Delete ${name}?`}
      escape="cancel"
      busy={busy}
      actions={actions}
      focus={focus}
      onAnswer={(id) => void answer(id)}
    >
      {step === "deprecate" ? (
        <>
          <p>
            {name} stays, marked as deprecated, so every statement that uses it still points to it.
          </p>
          <p className="deprecate-replacement">
            Replaced by: {replacement ? replacement.label : "nothing chosen (optional)"}{" "}
            {replacement && !picking && (
              <button type="button" className="link-btn" onClick={() => setReplacement(null)}>
                Clear
              </button>
            )}
          </p>
          {picking && ontologyId && pickerKind ? (
            <EntityPicker
              ontologyId={ontologyId}
              kind={pickerKind}
              label="Replaced by"
              exclude={[iri]}
              onPick={(picked, pickedLabel) => {
                setReplacement({ iri: picked, label: pickedLabel });
                setPicking(false);
              }}
              onCancel={() => setPicking(false)}
            />
          ) : (
            ontologyId &&
            pickerKind && (
              <button type="button" className="ghost" onClick={() => setPicking(true)}>
                {replacement ? "Choose another replacement…" : "Choose a replacement…"}
              </button>
            )
          )}
        </>
      ) : (
        <>
          {!impact && !error && <p role="status">Working out what deleting {label} takes…</p>}
          {impact && (
            <>
              {words && (
                <div className="delete-uses">
                  <p>{words.lead}</p>
                  <ul>
                    {words.rows.map((row) => (
                      <li key={row}>{row}</li>
                    ))}
                  </ul>
                  <p>{words.ending}</p>
                </div>
              )}
              <p>
                Deleting {name} removes {plural(impact.statements, "statement", "statements")}
                {elsewhere ? " in this file" : ""}.
              </p>
              {impact.children.length > 0 && (
                <fieldset className="delete-strategy">
                  <legend>
                    Its {plural(impact.children.length, one, many)} ({list(impact.children)}):
                  </legend>
                  <label>
                    <input
                      type="radio"
                      name="delete-strategy"
                      checked={strategy === "reparent"}
                      onChange={() => setStrategy("reparent")}
                    />{" "}
                    {parents.length ? `Move ${them} up to ${list(parents)}` : `Move ${them} up to the top level`}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="delete-strategy"
                      checked={strategy === "orphan"}
                      onChange={() => setStrategy("orphan")}
                    />{" "}
                    Leave {them} without a parent
                  </label>
                </fieldset>
              )}
              {impact.properties.length > 0 && <p>{propertySentence(impact.properties)}</p>}
              {impact.individuals.length > 0 && (
                <p>
                  {plural(impact.individuals.length, "individual", "individuals")} in this document{" "}
                  {impact.individuals.length === 1 ? "is" : "are"} typed with it (
                  {list(impact.individuals)}); {impact.individuals.length === 1 ? "it keeps" : "they keep"} everything
                  else.
                </p>
              )}
              {impact.importMentions > 0 && (
                <p>
                  It is used {plural(impact.importMentions, "time", "times")} in read-only imports, which are not
                  changed.
                </p>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p className="edit-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
