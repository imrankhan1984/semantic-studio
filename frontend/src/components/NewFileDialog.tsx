/*
================================================================================
FILE: frontend/src/components/NewFileDialog.tsx
================================================================================

SUMMARY
    New file (multi-file-projects 5.5 item 5): a name, a folder and a role,
    each role with its one sentence, in a modal dialog.

BASIC IDEA
    The role preselected is the project's kind: an ontology project's new
    file is an ontology, a taxonomy's a vocabulary. The name is checked by
    files/names.ts before it is sent, and again by the server, whose refusal
    comes back with the field it concerns; either way the sentence stands
    under that field, never in a banner (5.5 item 8). Nothing else of the
    page changes until Create succeeds.

    The keyboard is useDialogTrap's, as every dialog's: the heading takes
    focus on open, Tab stays inside, Escape cancels, and Cancel returns focus
    to the control that opened it. The role is a radio group, so arrow keys
    move between the three.

INPUTS / INPUT SOURCES (props)
    - kind: the project's kind, for the preselected role.
    - folders: the project's folders, for the picker; folder: the one chosen
      first (the folder a *New file here* was asked in).
    - onCreate: makes the file, or throws the server's ApiError.
    - onCancel.

EXPECTED OUTPUT
    - The dialog, one onCreate per Create that passes the checks.
================================================================================
*/

import { useCallback, useId, useRef, useState } from "react";
import { pathRefusal } from "../api";
import { fileName, folderError } from "../files/names";
import { folderChoices } from "../files/tree";
import type { FileRole, ProjectKind } from "../types";
import { useDialogTrap } from "./useDialogTrap";

interface Props {
  kind: ProjectKind | null;
  folders: string[];
  folder?: string;
  onCreate: (role: FileRole, name: string, folder: string) => Promise<void>;
  onCancel: () => void;
}

export const ROLE_CHOICES: { role: FileRole; label: string; sentence: string }[] = [
  { role: "ontology", label: "Ontology", sentence: "Classes and the relationships between them." },
  { role: "vocabulary", label: "Vocabulary", sentence: "Concepts arranged in a hierarchy, for tagging and lookup." },
  { role: "shapes", label: "Shapes", sentence: "Rules that check data against your model." },
];

type Field = "name" | "folder" | "role" | "form";

export default function NewFileDialog({ kind, folders, folder = "", onCreate, onCancel }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState("");
  const [where, setWhere] = useState(folder);
  const [role, setRole] = useState<FileRole>(kind === "taxonomy" ? "vocabulary" : "ontology");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const id = useId();
  const escape = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useDialogTrap(panelRef, headingRef, escape);

  const create = async () => {
    if (busy) return;
    const named = fileName(name);
    const folderProblem = folderError(where);
    if ("error" in named || folderProblem) {
      setErrors({ ...("error" in named ? { name: named.error } : {}), ...(folderProblem ? { folder: folderProblem } : {}) });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await onCreate(role, named.name, where);
    } catch (e: unknown) {
      const refusal = pathRefusal(e);
      const message = e instanceof Error ? e.message : String(e);
      setErrors({ [refusal?.field ?? "form"]: refusal?.message ?? message });
      setBusy(false);
    }
  };

  const described = (field: Field) => (errors[field] ? `${id}-${field}-error` : undefined);

  return (
    <>
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={escape} />
      <div
        ref={panelRef}
        className="confirm-dialog new-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-busy={busy}
      >
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="confirm-title">
          New file
        </h2>
        <form
          className="confirm-body new-file-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described("name") ?? `${id}-name-hint`}
            autoComplete="off"
            spellCheck={false}
          />
          {errors.name ? (
            <p id={`${id}-name-error`} className="form-error" role="alert">{errors.name}</p>
          ) : (
            <p id={`${id}-name-hint`} className="hint">.ttl is added if you leave it off.</p>
          )}

          <label htmlFor={`${id}-folder`}>Folder</label>
          <select
            id={`${id}-folder`}
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            aria-invalid={errors.folder ? true : undefined}
            aria-describedby={described("folder")}
          >
            {folderChoices(folders).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {errors.folder && (
            <p id={`${id}-folder-error`} className="form-error" role="alert">{errors.folder}</p>
          )}

          <fieldset className="new-file-roles" aria-describedby={described("role")}>
            <legend>What the file holds</legend>
            {ROLE_CHOICES.map((choice) => (
              <label key={choice.role} className="new-file-role">
                <input
                  type="radio"
                  name={`${id}-role`}
                  value={choice.role}
                  checked={role === choice.role}
                  onChange={() => setRole(choice.role)}
                  aria-describedby={`${id}-role-${choice.role}`}
                />
                <span className="new-file-role-label">{choice.label}</span>
                <span id={`${id}-role-${choice.role}`} className="hint">{choice.sentence}</span>
              </label>
            ))}
          </fieldset>
          {errors.role && <p id={`${id}-role-error`} className="form-error" role="alert">{errors.role}</p>}
          {errors.form && <p className="form-error" role="alert">{errors.form}</p>}

          <div className="modal-actions">
            <button type="submit" className="primary" aria-disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button type="button" className="ghost" aria-disabled={busy} onClick={escape}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
