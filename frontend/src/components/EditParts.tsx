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

    InlineText shows a value with an Edit button. Editing shows a field with
    Save and Cancel; Enter saves (Ctrl+Enter in a text area), Escape cancels,
    and focus returns to Edit either way, so a keyboard user is never left on
    the body when the field goes away.

INPUTS / INPUT SOURCES
    - The project store, for commands.

EXPECTED OUTPUT
    - useRunner, Runner, Block, InlineText.
================================================================================
*/

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { projectStore } from "../state/projectStore";
import type { ChangeResult } from "../types";

/** Run one command for one field: its busy flag and its refusal. */
export interface Runner {
  busy: boolean;
  errors: Record<string, string>;
  run: (field: string, command: string, args: Record<string, unknown>) => Promise<ChangeResult | null>;
  clear: (field: string) => void;
}

export function useRunner(): Runner {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A ref as well as the state: two submits in one tick both see busy as
  // false, and the second command would be sent (found in review).
  const inFlight = useRef(false);
  const run = useCallback(async (field: string, command: string, args: Record<string, unknown>) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    setErrors((e) => ({ ...e, [field]: "" }));
    try {
      return await projectStore.command(command, args);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [field]: e instanceof Error ? e.message : String(e) }));
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  const clear = useCallback((field: string) => setErrors((e) => ({ ...e, [field]: "" })), []);
  return { busy, errors, run, clear };
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
