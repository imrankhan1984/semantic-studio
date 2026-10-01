/*
================================================================================
FILE: frontend/src/components/EditParts.tsx
================================================================================

SUMMARY
    The pieces the editing form's blocks share (visual-modeling 5.1): the
    command runner, a titled block, and a value edited in place.

BASIC IDEA
    useRunner is the form's one path to the server: it runs a command through
    projectStore.command and keeps, per field, the server's sentence when it
    refuses, so the sentence appears under the field that caused it. One busy
    flag for the whole form, because the commands of one document are applied
    one at a time on the server anyway, and the status line says "Saving
    change…" while it is set. A second command while one is in flight is
    not sent at all.

    The runner is shared (visual-modeling 5.8 item 1): the annotation adder,
    the delete dialog and the tree's forms take the one their section made,
    so any command in flight shows as busy everywhere in it. `alive()` says
    whether the form that started a command is still on screen when it
    answers, so a create does not move the selection away from something the
    user picked meanwhile (item 4).

    useReturnFocus gives focus back to the control that opened a small form
    once the form has gone (item 2). useCopy copies and says "Copied" in a
    polite live region it renders itself (item 11).

    InlineText shows a value with an Edit button. Editing shows a field with
    Save and Cancel; Enter saves (Ctrl+Enter in a text area), Escape cancels,
    and focus returns to Edit either way, so a keyboard user is never left on
    the body when the field goes away.

INPUTS / INPUT SOURCES
    - The project store, for commands.

EXPECTED OUTPUT
    - useRunner, Runner, useReturnFocus, useCopy, Block, InlineText.
================================================================================
*/

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { projectStore } from "../state/projectStore";
import type { ChangeResult, ProjectDocName } from "../types";

/** Run one command for one field: its busy flag and its refusal. */
export interface Runner {
  busy: boolean;
  errors: Record<string, string>;
  run: (
    field: string,
    command: string,
    args: Record<string, unknown>,
    announcement?: (result: ChangeResult) => string,
  ) => Promise<ChangeResult | null>;
  clear: (field: string) => void;
  /** The form that made this runner is still mounted. */
  alive: () => boolean;
}

/** `doc` names the document the commands go to; the open one by default.
 *  The Shapes view passes "shapes" (shacl-authoring 5.3). */
export function useRunner(doc?: ProjectDocName): Runner {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A ref as well as the state: two submits in one tick both see busy as
  // false, and the second command would be sent (found in review).
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (
      field: string,
      command: string,
      args: Record<string, unknown>,
      announcement?: (result: ChangeResult) => string,
    ) => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(true);
      setErrors((e) => ({ ...e, [field]: "" }));
      try {
        return await projectStore.command(command, args, announcement, doc);
      } catch (e) {
        if (mounted.current) {
          setErrors((prev) => ({ ...prev, [field]: e instanceof Error ? e.message : String(e) }));
        }
        return null;
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [doc],
  );
  const clear = useCallback((field: string) => setErrors((e) => ({ ...e, [field]: "" })), []);
  const alive = useCallback(() => mounted.current, []);
  return { busy, errors, run, clear, alive };
}

/** A ref for the control that opens a small form, and a function that gives
 *  it focus back once the form has closed and the control is drawn again. */
export function useReturnFocus<T extends HTMLElement = HTMLButtonElement>() {
  const ref = useRef<T>(null);
  const restore = useCallback(() => {
    window.setTimeout(() => ref.current?.focus(), 0);
  }, []);
  return [ref, restore] as const;
}

/** Copy to the clipboard, and say so in a polite live region: the button
 *  gave no sign it had done anything (5.8 item 11). The region is rendered
 *  while empty, because one added with its text is not reliably read. */
export function useCopy() {
  const [said, setSaid] = useState("");
  const copy = useCallback((text: string) => {
    void Promise.resolve(navigator.clipboard?.writeText(text))
      .then(() => setSaid(`Copied ${text}.`))
      .catch(() => setSaid("It could not be copied."));
  }, []);
  const region = (
    <span className="visually-hidden" role="status">
      {said}
    </span>
  );
  return [copy, region] as const;
}

// ---------------------------------------------------------------------------
// One value edited in place
// ---------------------------------------------------------------------------

interface InlineTextProps {
  label: string;
  value: string | null;
  missing?: string;
  multiline?: boolean;
  busy: boolean;
  error?: string;
  /** Resolves true when the change was made, so the field closes. */
  onSave: (value: string) => Promise<boolean>;
}

/** A value with an Edit button; editing shows a field, Save and Cancel.
 *  Enter saves (Ctrl+Enter in a text area), Escape cancels, and focus goes
 *  back to Edit either way. */
export function InlineText({ label, value, missing = "none", multiline, busy, error, onSave }: InlineTextProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setDraft(null);
    // After the field unmounts, so there is something to focus.
    window.setTimeout(() => editRef.current?.focus(), 0);
  };
  const save = async () => {
    if (draft === null || busy) return;
    if (draft === (value ?? "")) return close();
    if (await onSave(draft)) close();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  };
  if (draft === null) {
    return (
      <div className="edit-value">
        <span className={value === null ? "detail-name-missing" : undefined}>{value ?? missing}</span>
        <button
          ref={editRef}
          type="button"
          className="ghost edit-btn"
          aria-label={`${value === null ? "Add" : "Edit"} ${label}`}
          onClick={() => setDraft(value ?? "")}
        >
          {value === null ? "Add" : "Edit"}
        </button>
      </div>
    );
  }
  const common = {
    id,
    autoFocus: true,
    value: draft,
    readOnly: busy,
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
    onKeyDown,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
  };
  return (
    <div className="edit-value editing">
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      <div className="edit-actions">
        <button type="button" className="primary" aria-disabled={busy} onClick={() => void save()}>
          {busy ? "Saving change…" : "Save"}
        </button>
        <button type="button" className="ghost" onClick={close}>
          Cancel
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className="edit-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="edit-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
