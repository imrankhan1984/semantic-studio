/*
================================================================================
FILE: frontend/src/components/ClassKindChoice.tsx
================================================================================

SUMMARY
    The *Kind of class* radio group every place that makes a class shows
    beside the name (attribute-reuse 5.6, D-117): *OWL class*, which can take
    rules and works with the reasoner, or *RDFS class*, the simpler standard
    with no rules. The default is the project's last choice, and the hint
    says so (*RDFS class, as last time.*).

BASIC IDEA
    Native radio buttons in a fieldset whose legend names the group, so a
    screen reader announces *Kind of class, group* and each choice with its
    position, and the arrow keys move between them and choose, as a browser
    gives every radio group; one tab stop, on the checked one. What each
    choice means is its description, read with it. Nothing is `disabled`
    while a command runs (CLAUDE.md, authoring foundations): the group is
    aria-disabled and ignores a change.

    useClassKind holds one form's choice, starting from the project's
    default, which the project store keeps from the server's manifest.

INPUTS / INPUT SOURCES (props)
    - value, onChange: the kind chosen.
    - remembered: the project's last choice, for the hint; null when none.
    - busy: a command in flight.

EXPECTED OUTPUT
    - The fieldset; useClassKind() -> the prop set NewEntityForm takes.
================================================================================
*/

import { useId, useState } from "react";
import { CLASS_KIND_LEGEND, CLASS_KINDS, classKindHint } from "../modeling/sentences";
import { defaultClassType, useProjectSelector } from "../state/projectStore";
import type { ClassType } from "../types";

export interface ClassKind {
  value: ClassType;
  onChange: (type: ClassType) => void;
  remembered: ClassType | null;
}

/** One form's kind of class, starting from the project's last choice. */
export function useClassKind(): ClassKind {
  const remembered = useProjectSelector((s) => s.project?.classType ?? null);
  const [value, onChange] = useState<ClassType>(() => defaultClassType());
  return { value, onChange, remembered };
}

export default function ClassKindChoice({ value, onChange, remembered, busy = false }: ClassKind & { busy?: boolean }) {
  const id = useId();
  const hint = classKindHint(remembered);
  return (
    <fieldset
      className="class-kind"
      aria-disabled={busy || undefined}
      aria-describedby={hint ? `${id}-hint` : undefined}
    >
      <legend className="edit-field-label">{CLASS_KIND_LEGEND}</legend>
      {CLASS_KINDS.map((k) => (
        <div key={k.id} className="class-kind-option">
          <input
            type="radio"
            id={`${id}-${k.id}`}
            name={`${id}-kind`}
            value={k.id}
            checked={value === k.id}
            aria-describedby={`${id}-${k.id}-means`}
            onChange={() => {
              if (!busy) onChange(k.id);
            }}
          />
          <label htmlFor={`${id}-${k.id}`}>{k.name}</label>
          <span id={`${id}-${k.id}-means`} className="detail-note">
            {" "}
            {k.means}
          </span>
        </div>
      ))}
      {hint && (
        <p id={`${id}-hint`} className="detail-note">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
