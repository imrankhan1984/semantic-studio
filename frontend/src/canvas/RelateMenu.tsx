/*
================================================================================
FILE: frontend/src/canvas/RelateMenu.tsx
================================================================================

SUMMARY
    The small menu that opens at the end of a line drawn between two boxes
    (visual-modeling 5.4, Relating): *is a kind of*, *new relationship…*
    with its name field, *narrower than*, or an existing relationship the
    line would complete; the notes on those it will not offer; and the
    server's sentence if the command is refused.

BASIC IDEA
    A WAI-ARIA menu, as the tree's row menu is: focus goes to the first item,
    the arrow keys, Home and End move it, Escape closes it and gives focus
    back. *New relationship…* turns the menu into a one-field form, because a
    relationship needs a name, and the name is all it asks (names first,
    5.1). The choices come from relate.ts; this only draws them and says
    which was chosen.

INPUTS / INPUT SOURCES (props)
    - title: "Invoice Item to Invoice".
    - choices, notes: from relateChoices.
    - anchor: where the line ended, in the canvas's own coordinates.
    - busy, error: the command in flight, and its refusal.
    - onChoose(choice, name?), onClose.

EXPECTED OUTPUT
    - The menu; one onChoose per choice.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { keep } from "./ClassNode";
import type { RelateChoice } from "./relate";

interface Props {
  title: string;
  choices: RelateChoice[];
  notes: string[];
  anchor: { x: number; y: number };
  busy: boolean;
  error: string | null;
  onChoose: (choice: RelateChoice, name?: string) => void;
  onClose: () => void;
}

export default function RelateMenu({ title, choices, notes, anchor, busy, error, onChoose, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!naming) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [naming]);

  const move = (step: number | "first" | "last") => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = step === "first" ? 0 : step === "last" ? all.length - 1 : (at + step + all.length) % all.length;
    all[next]?.focus();
  };

  const newRelationship = choices.find((c) => c.kind === "newRelationship");
  return (
    <div
      ref={ref}
      className="relate-menu nodrag"
      style={{ left: anchor.x, top: anchor.y }}
      onKeyDown={(e) => {
        keep(e);
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (!naming && e.key === "ArrowDown") move(1);
        else if (!naming && e.key === "ArrowUp") move(-1);
        else if (!naming && e.key === "Home") move("first");
        else if (!naming && e.key === "End") move("last");
      }}
    >
      <p className="relate-title" id="relate-title">
        {title}
      </p>
      {naming && newRelationship ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && name.trim()) onChoose(newRelationship, name.trim());
          }}
        >
          <label className="edit-field-label" htmlFor="relate-name">
            Name of the new relationship
          </label>
          <input id="relate-name" autoFocus value={name} readOnly={busy} onChange={(e) => setName(e.target.value)} />
          <div className="edit-actions">
            <button type="submit" className="primary" aria-disabled={busy || !name.trim()}>
              {busy ? "Saving change…" : "Create"}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <ul role="menu" aria-labelledby="relate-title">
          {choices.map((choice) => (
            <li key={choice.kind === "existing" ? choice.property : choice.kind} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return;
                  if (choice.kind === "newRelationship") setNaming(true);
                  else onChoose(choice);
                }}
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notes.map((note) => (
        <p key={note} className="detail-note">
          {note}
        </p>
      ))}
      {error && (
        <p className="edit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
