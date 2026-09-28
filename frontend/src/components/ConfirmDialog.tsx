/*
================================================================================
FILE: frontend/src/components/ConfirmDialog.tsx
================================================================================

SUMMARY
    A modal question with two or three named answers. Authoring asks four:
    recover unsaved changes, the one-time comments warning, leaving the Turtle
    editor with unapplied text, and closing a project with unsaved changes.

BASIC IDEA
    One component for the four, because they differ only in words: a heading,
    one or two paragraphs, and a row of buttons. The keyboard behaviour is
    useDialogTrap's (the About panel's pattern, which the spec names): the
    heading takes focus on open, Tab stays inside, Escape answers with the
    `escape` choice, and focus goes back where it was on close.

    The backdrop is the dialog's sibling, not its parent, for the reason
    AboutPanel records: aria-hidden on an ancestor would take the dialog out of
    the accessibility tree. Clicking it answers like Escape.

INPUTS / INPUT SOURCES (props)
    - title, body: the words.
    - actions: the answers, in reading order, one marked primary.
    - onAnswer: called with the chosen action's id; `escape` names the id
      Escape and the backdrop give.

EXPECTED OUTPUT
    - The dialog, and one onAnswer call per answer.
================================================================================
*/

import { useCallback, useRef, type ReactNode } from "react";
import { useDialogTrap } from "./useDialogTrap";

export interface DialogAction {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

interface Props {
  title: string;
  children: ReactNode;
  actions: DialogAction[];
  escape: string;
  busy?: boolean;
  onAnswer: (id: string) => void;
}

export default function ConfirmDialog({ title, children, actions, escape, busy = false, onAnswer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onEscape = useCallback(() => {
    if (!busy) onAnswer(escape);
  }, [busy, escape, onAnswer]);
  useDialogTrap(panelRef, headingRef, onEscape);

  return (
    <>
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={onEscape} />
      <div
        ref={panelRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-busy={busy}
      >
        <h2 id="confirm-dialog-title" ref={headingRef} tabIndex={-1} className="confirm-title">
          {title}
        </h2>
        <div className="confirm-body">{children}</div>
        <div className="modal-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              className={action.primary ? "primary" : action.danger ? "ghost danger" : "ghost"}
              // aria-disabled rather than disabled while an answer is being
              // carried out: a disabled button drops the focus it holds.
              aria-disabled={busy}
              onClick={() => !busy && onAnswer(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
