/*
================================================================================
FILE: frontend/src/components/LimitsSettings.tsx
================================================================================

SUMMARY
    Settings → Limits (home-and-settings 5.4, D-120): the largest file to
    load, the longest time to read a file and the items drawn when a graph
    opens, each a field with its unit, default, range and what it changes;
    Save, Cancel and Reset to defaults. A limit an administrator's variable
    owns is shown read-only, with the variable named.

BASIC IDEA
    The fields hold text; limitWords.ts says which text is a value. A refused
    value stands under its field with the range, tied by aria-describedby,
    and Save waits: aria-disabled, never disabled, so focus is never dropped
    from the button a person is on (a load-bearing rule). Save also waits
    while nothing has changed, and while it is on its way.

    Nothing applies until Save, which sends only the limits no variable owns
    and that differ from the saved ones; the server checks the range again.
    Cancel drops what was typed, saves nothing and closes Settings without
    the unsaved-changes question: pressing Cancel is the answer (AC-12).
    Reset to defaults puts the defaults in the fields, to be saved. Closing
    Settings any other way (the ✕, Escape, the backdrop) discards too, and
    asks once first: the dialog asks, since it holds those ways out, so this
    file only says whether there is anything to lose (onDirtyChange).

    A refused Save (a range the server holds, or a variable set since the
    dialog opened) is said under the buttons and changes nothing.

INPUTS / INPUT SOURCES (props)
    - settings: GET /api/settings's answer, or null while it is on its way.
    - failed: the sentence for a read that failed.
    - onSaved: the answer of a Save, for the dialog to hold.
    - onDirtyChange: whether a field differs from its saved value.
    - onCancel: Cancel pressed; the dialog closes, asking nothing.

EXPECTED OUTPUT
    - The tab's body.
================================================================================
*/

import { useEffect, useState } from "react";
import { saveLimits, type AppSettings, type LimitKey, type LimitSetting } from "../api";
import {
  SAVED,
  WHAT_IT_CHANGES,
  administratorLine,
  editable,
  fieldLabel,
  hasUnsaved,
  limitChanges,
  limitError,
  rangeLine,
  shownValue,
} from "../limitWords";

interface Props {
  settings: AppSettings | null;
  failed: string | null;
  onSaved: (settings: AppSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
}

type Drafts = Partial<Record<LimitKey, string>>;

export default function LimitsSettings({ settings, failed, onSaved, onDirtyChange, onCancel }: Props) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const limits = settings?.limits ?? [];

  const dirty = hasUnsaved(limits, drafts);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const changes = limitChanges(limits, drafts);
  const canSave = !saving && changes !== null && Object.keys(changes).length > 0;
  const anyEditable = limits.some(editable);

  const edit = (key: LimitKey, text: string) => {
    setDrafts((d) => ({ ...d, [key]: text }));
    setStatus("");
    setRefused(null);
  };

  const save = async () => {
    if (!canSave || !changes) return;
    setSaving(true);
    setRefused(null);
    try {
      const answer = await saveLimits(changes);
      onSaved(answer);
      setDrafts({});
      setStatus(SAVED);
    } catch (e: unknown) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Nothing typed is kept for a later opening: the dialog unmounts this
  // panel as it closes, and the next one reads the saved values again.
  const cancel = () => {
    setDrafts({});
    setStatus("");
    setRefused(null);
    onCancel();
  };

  const resetToDefaults = () => {
    const next: Drafts = {};
    for (const limit of limits) if (editable(limit)) next[limit.key] = String(limit.default);
    setDrafts(next);
    setStatus("");
    setRefused(null);
  };

  if (!settings) {
    return (
      <div className="settings-limits">
        <p className={failed ? "detail-error" : "hint"}>{failed ?? "Reading the limits…"}</p>
      </div>
    );
  }

  return (
    <div className="settings-limits">
      <p className="hint">
        Changes apply to the next file you load and the next graph you open. The query limits stay fixed.
      </p>
      {limits.map((limit) => (
        <LimitField key={limit.key} limit={limit} text={drafts[limit.key]} onEdit={edit} />
      ))}

      {anyEditable && (
        <div className="modal-actions settings-limit-actions">
          <button type="button" className="ghost" onClick={resetToDefaults}>
            Reset to defaults
          </button>
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="primary" aria-disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {refused && <p className="form-error">{refused}</p>}
      {/* In the page while empty: a live region added with its text is
          unreliably announced. */}
      <p className="hint settings-limit-status" role="status">
        {status}
      </p>
    </div>
  );
}

function LimitField({
  limit,
  text,
  onEdit,
}: {
  limit: LimitSetting;
  text: string | undefined;
  onEdit: (key: LimitKey, text: string) => void;
}) {
  const id = `limit-${limit.key}`;
  if (!editable(limit)) {
    return (
      <div className="settings-limit" role="group" aria-labelledby={`${id}-name`}>
        <p id={`${id}-name`} className="settings-limit-name">
          {limit.name}
        </p>
        <p className="settings-limit-value">{shownValue(limit)}</p>
        <p className="hint">{administratorLine(limit)}</p>
        <p className="hint">{WHAT_IT_CHANGES[limit.key]}</p>
      </div>
    );
  }
  const value = text ?? String(limit.value);
  const error = limitError(value, limit);
  const described = [`${id}-what`, `${id}-range`, ...(error ? [`${id}-error`] : [])].join(" ");
  return (
    <div className="settings-limit">
      <label htmlFor={id} className="settings-limit-name">
        {fieldLabel(limit)}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className="settings-limit-input"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(e) => onEdit(limit.key, e.target.value)}
      />
      <p id={`${id}-what`} className="hint">
        {WHAT_IT_CHANGES[limit.key]}
      </p>
      <p id={`${id}-range`} className="hint">
        {rangeLine(limit)}
      </p>
      {error && (
        <p id={`${id}-error`} className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
