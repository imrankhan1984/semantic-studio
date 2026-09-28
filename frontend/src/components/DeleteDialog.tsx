/*
================================================================================
FILE: frontend/src/components/DeleteDialog.tsx
================================================================================

SUMMARY
    Delete with its impact first (visual-modeling 5.3): the tree's "Delete…",
    the form's "Delete" and the canvas's Delete key all open this. It asks the
    server what the delete would take, says so in sentences, offers what to do
    with the children when there are any, and deletes only on confirmation.

BASIC IDEA
    DeleteEntity has a dry run (authoring-foundations 5.5) that changes
    nothing and returns the impact: the statements removed, the children and
    the parents they would move up to, the properties whose domain or range
    is the entity, the individuals typed with it, and the mentions in
    read-only imports. This renders that inside the existing ConfirmDialog,
    so the keyboard behaviour is the one every other question already has.

    The strategy question appears only when there are children: with none,
    reparent and orphan do the same thing and asking would be noise. The
    words follow 5.3 exactly (5.8 item 7): an object property is a
    *relationship* and a datatype property an *attribute*, and one child is
    *it* where two are *them*.

    The command goes through the caller's runner, so the section that opened
    the dialog shows it busy (5.8 item 1). If the dry run cannot run at all,
    the dialog says so and offers only Cancel, rather than waiting for ever
    (item 8).

    The announcement after the delete is the spec's sentence, "Deleted class
    Invoice. Undo is available.", rather than the usual status, because the
    thing a learner most needs to hear after a delete is that it can be taken
    back.

INPUTS / INPUT SOURCES (props)
    - iri, label: what to delete.
    - runner: the section's command runner.
    - onDone(deleted): closes the dialog; `deleted` says whether it happened.
    Plus the project store (the open project and document) and api.ts.

EXPECTED OUTPUT
    - The dialog; one DeleteEntity command on confirmation.
================================================================================
*/

import { useEffect, useState } from "react";
import { previewDelete } from "../api";
import { projectStore } from "../state/projectStore";
import type { DeleteImpact } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import type { Runner } from "./EditParts";

interface Props {
  iri: string;
  label: string;
  runner: Runner;
  onDone: (deleted: boolean) => void;
}

const CHILD_WORDS: Record<string, [string, string]> = {
  class: ["subclass", "subclasses"],
  concept: ["narrower concept", "narrower concepts"],
};

const PROPERTY_WORDS: Record<string, [string, string]> = {
  "object property": ["relationship", "relationships"],
  "datatype property": ["attribute", "attributes"],
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

export default function DeleteDialog({ iri, label, runner, onDone }: Props) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [strategy, setStrategy] = useState<"reparent" | "orphan">("reparent");
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, errors, run } = runner;

  useEffect(() => {
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
  }, [iri, label]);

  const answer = async (id: string) => {
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
  const error = loadError || errors.delete || null;
  return (
    <ConfirmDialog
      title={`Delete ${name}?`}
      escape="cancel"
      busy={busy}
      actions={[
        ...(impact ? [{ id: "delete", label: busy ? "Deleting…" : "Delete", danger: true }] : []),
        { id: "cancel", label: "Cancel", primary: true },
      ]}
      onAnswer={(id) => void answer(id)}
    >
      {!impact && !error && <p role="status">Working out what deleting {label} takes…</p>}
      {impact && (
        <>
          <p>
            Deleting {name} removes {plural(impact.statements, "statement", "statements")}.
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
      {error && (
        <p className="edit-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
