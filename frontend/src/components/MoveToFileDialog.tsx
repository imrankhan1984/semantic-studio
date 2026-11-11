/*
================================================================================
FILE: frontend/src/components/MoveToFileDialog.tsx
================================================================================

SUMMARY
    *Move {name} to file…* (links-between-files 5.8): one picker, the
    project's other ontology and vocabulary files by path, and *Move*. The
    entity's own statements leave the file it is defined in for the chosen
    one as one grouped undo step; its address does not change, so nothing
    that points to it breaks.

BASIC IDEA
    A ConfirmDialog, so it has the house dialog's focus trap, Escape and
    focus back where it was. The picker is a labelled select, which takes
    the focus first; *Move* is the primary action. The command is
    MoveToFile, run in the open file through the edit section's runner, so
    a refusal is the server's sentence, shown under the picker with nothing
    changed. A shapes file is never offered: shapes follow a class by its
    address (5.8 item 2).

    The announcement is the spec's sentence, *Moved Pump to equipment.ttl.
    Undo is available.*, as a delete's and a deprecation's are. The detail
    panel stays on the entity, which the refetch now marks *Defined in
    equipment.ttl* (5.8 item 6).

INPUTS / INPUT SOURCES (props)
    - iri, label: what to move.
    - runner: the edit section's command runner.
    - onDone(moved): closes the dialog; `moved` says whether it happened.
    Plus the project store: the open file and the project's files.

EXPECTED OUTPUT
    - The dialog; one MoveToFile command on *Move*.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { isShapesDoc, useProjectSelector } from "../state/projectStore";
import ConfirmDialog from "./ConfirmDialog";
import type { Runner } from "./EditParts";

interface Props {
  iri: string;
  label: string;
  runner: Runner;
  onDone: (moved: boolean) => void;
}

export default function MoveToFileDialog({ iri, label, runner, onDone }: Props) {
  const activeDoc = useProjectSelector((s) => s.activeDoc);
  const documents = useProjectSelector((s) => s.documents);
  // The project's ontology and vocabulary files other than this one, by
  // path, in the manifest's order (5.8 item 5).
  const targets = documents.filter((d) => d.doc !== activeDoc && !isShapesDoc(d));
  const [target, setTarget] = useState(targets[0]?.doc ?? "");
  const { busy, errors, run } = runner;
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);

  // The picker takes the focus once the dialog has drawn: it is the one
  // choice to make, and Enter on it then moves (ConfirmDialog's heading
  // takes the focus first, so this waits a tick).
  useEffect(() => {
    const timer = window.setTimeout(() => select.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const answer = async (choice: string) => {
    if (choice !== "move" || !target) {
      onDone(false);
      return;
    }
    const result = await run("move", "MoveToFile", { iri, target }, (r) => `${r.label}. Undo is available.`);
    if (result) onDone(true);
  };

  return (
    <ConfirmDialog
      title={`Move ${label} to another file?`}
      escape="cancel"
      busy={busy}
      actions={[
        { id: "move", label: busy ? "Moving…" : "Move", primary: true },
        { id: "cancel", label: "Cancel" },
      ]}
      onAnswer={(choice) => void answer(choice)}
    >
      <p>
        {label} and what this file says about it move to the file you choose. Its address stays the same, so
        everything that points to it still does.
      </p>
      <label htmlFor={id}>Move to</label>{" "}
      <select
        id={id}
        ref={select}
        value={target}
        aria-describedby={errors.move ? `${id}-error` : undefined}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!busy) void answer("move");
          }
        }}
      >
        {targets.map((d) => (
          <option key={d.doc} value={d.doc}>
            {d.file}
          </option>
        ))}
      </select>
      {errors.move && (
        <p id={`${id}-error`} className="edit-error" role="alert">
          {errors.move}
        </p>
      )}
    </ConfirmDialog>
  );
}
