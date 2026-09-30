/*
================================================================================
FILE: frontend/src/canvas/RelateMenu.tsx
================================================================================

SUMMARY
    The small menu that opens at the end of a line drawn between two boxes
    (visual-modeling 5.4, Relating; relationships 5.3): headed *Person …
    Organization* with a Swap button that reverses the line before anything
    is made; each choice read as the sentence it makes (*Person is a kind of
    Organization*, *Person works for Organization (existing relationship)*);
    *new relationship…* with its name field and the sentence as typed, *A
    Person works for an Organization.*; the notes on what it will not offer;
    and the server's sentence if the command is refused.

BASIC IDEA
    A WAI-ARIA menu, as the tree's row menu is: focus goes to the first item,
    the arrow keys, Home and End move it, Escape closes it and gives focus
    back. *New relationship…* turns the menu into a one-field form, because a
    relationship needs a name, and the name is all it asks (names first,
    5.1). The sentence under the field describes it rather than announcing
    each key, which would talk over the typing. The choices come from
    relate.ts and the sentences from modeling/sentences.ts; this only draws
    them and says which was chosen.

    Swap is a plain button beside the heading, outside the menu's arrow-key
    order: it changes what every item says, so it is reached by Tab from the
    menu, and focus goes back to the first item after it, which now reads
    the other way round.

INPUTS / INPUT SOURCES (props)
    - from, to: the two boxes' names, in the line's direction.
    - choices, notes: from relateChoices; refusal: the swapped direction's,
      when it cannot mean anything.
    - loop: the line runs from a box to itself, so there is no Swap
      (relationships 5.10 item 4).
    - onSwap: ask again the other way round.
    - anchor: where the line ended, in the canvas's own coordinates.
    - busy, error: the command in flight, and its refusal.
    - onChoose(choice, name?), onClose.

EXPECTED OUTPUT
    - The menu; one onChoose per choice.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { relationshipSentence } from "../modeling/sentences";
import { keep } from "./ClassNode";
import type { RelateChoice } from "./relate";

interface Props {
  from: string;
  to: string;
  choices: RelateChoice[];
  notes: string[];
  refusal?: string | null;
  /** A line from a box to itself: there is no other way round to swap to. */
  loop?: boolean;
  onSwap: () => void;
  anchor: { x: number; y: number };
  busy: boolean;
  error: string | null;
  onChoose: (choice: RelateChoice, name?: string) => void;
  onClose: () => void;
}

export default function RelateMenu({
  from,
  to,
  choices,
  notes,
  refusal = null,
  loop = false,
  onSwap,
  anchor,
  busy,
  error,
  onChoose,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const sentenceId = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  // On open, and after a swap: the first item, which now reads the other way.
  useEffect(() => {
    if (!naming) (ref.current?.querySelector<HTMLElement>('[role="menuitem"]') ?? ref.current?.querySelector<HTMLElement>(".relate-swap"))?.focus();
  }, [naming, from, to]);

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
      <div className="relate-head">
        <p className="relate-title" id="relate-title">
          {from} <span aria-hidden="true">…</span>
          <span className="visually-hidden">to</span> {to}
        </p>
        {!loop && (
          <button
            type="button"
            className="ghost relate-swap"
            aria-disabled={busy}
            onClick={() => !busy && onSwap()}
            aria-label={`Swap: from ${to} to ${from}`}
            title="Swap the direction"
          >
            <span aria-hidden="true">⇄</span> Swap
          </button>
        )}
      </div>
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
          <input
            id="relate-name"
            autoFocus
            value={name}
            readOnly={busy}
            aria-describedby={sentenceId}
            onChange={(e) => setName(e.target.value)}
          />
          <p id={sentenceId} className="relate-sentence">
            {relationshipSentence(from, name, to)}
          </p>
          <div className="edit-actions">
            <button type="submit" className="primary" aria-disabled={busy || !name.trim()}>
              {busy ? "Saving change…" : "Create"}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : refusal ? (
        <p className="detail-note relate-refusal">{refusal}</p>
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
