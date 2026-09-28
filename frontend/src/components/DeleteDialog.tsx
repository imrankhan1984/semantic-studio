/*
================================================================================
FILE: frontend/src/components/DeleteDialog.tsx
================================================================================

SUMMARY
    Delete with its impact first (visual-modeling 5.3): the tree's "Delete…"
    and the form's "Delete" both open this. It asks the server what the delete
    would take, says so in sentences, offers what to do with the children when
    there are any, and deletes only on confirmation.

BASIC IDEA
    DeleteEntity has a dry run (authoring-foundations 5.5) that changes
    nothing and returns the impact: the statements removed, the children and
    the parents they would move up to, the properties whose domain or range
    is the entity, the individuals typed with it, and the mentions in
    read-only imports. This renders that inside the existing ConfirmDialog,
    so the keyboard behaviour is the one every other question already has.

    The strategy question appears only when there are children: with none,
    reparent and orphan do the same thing and asking would be noise.

    The announcement after the delete is the spec's sentence, "Deleted class
    Invoice. Undo is available.", rather than the usual status, because the
    thing a learner most needs to hear after a delete is that it can be taken
    back.

INPUTS / INPUT SOURCES (props)
    - iri, label: what to delete.
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

interface Props {
  iri: string;
  label: string;
  onDone: (deleted: boolean) => void;
}

const CHILD_WORDS: Record<string, [string, string]> = {
  class: ["subclass", "subclasses"],
  concept: ["narrower concept", "narrower concepts"],
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(refs: { label: string }[]): string {
  return refs.map((r) => r.label).join(", ");
}

export default function DeleteDialog({ iri, label, onDone }: Props) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [strategy, setStrategy] = useState<"reparent" | "orphan">("reparent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const state = projectStore.getSnapshot();
    if (!state.project) return;
    let cancelled = false;
    previewDelete(state.project.id, state.activeDoc, iri, "reparent")
      .then((r) => !cancelled && setImpact(r.impact))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [iri]);

  const answer = async (id: string) => {
    if (id !== "delete" || !impact) {
      onDone(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await projectStore.command(
        "DeleteEntity",
        { iri, strategy },
        (result) => `${result.label}. Undo is available.`,
      );
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const [one, many] = CHILD_WORDS[impact?.kind ?? ""] ?? ["subproperty", "subproperties"];
  const name = impact?.label ?? label;
  const parents = impact?.reparentedTo ?? [];
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
                {parents.length
                  ? `Move them up to ${list(parents)}`
                  : "Move them up to the top level"}
              </label>
              <label>
                <input
                  type="radio"
                  name="delete-strategy"
                  checked={strategy === "orphan"}
                  onChange={() => setStrategy("orphan")}
                />{" "}
                Leave them without a parent
              </label>
            </fieldset>
          )}
          {impact.properties.length > 0 && (
            <p>
              {impact.properties.length === 1
                ? "1 property points to it"
                : `${impact.properties.length} properties point to it`}{" "}
              ({impact.properties.map((p) => `${p.label}, as its ${p.role}`).join("; ")}).{" "}
              {impact.properties.length === 1 ? "It is kept, without" : "They are kept, without"}{" "}
              {impact.properties.length === 1 ? `a ${impact.properties[0].role}` : "it"}.
            </p>
          )}
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
