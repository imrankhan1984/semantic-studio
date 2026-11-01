/*
================================================================================
FILE: frontend/src/components/NamingSettings.tsx
================================================================================

SUMMARY
    Settings → Naming (design-checks 5.1, D-124): the organization's
    namespace after the fixed text https://w3id.org/, the sentence to follow
    the organization's IRI guidelines, the address pattern with the typed
    namespace in place, and Show examples with the good and the bad. Save,
    Cancel and Clear.

BASIC IDEA
    The field holds text; naming/address.ts says which text is a namespace.
    A refused value stands under the field, tied by aria-describedby, as
    Limits does, and Save waits: aria-disabled, never disabled, so focus is
    never dropped from the button a person is on. Save also waits while
    nothing has changed. While a save is on its way the field is disabled
    and the group aria-busy (Section 6): the button keeps focus.

    Clear asks once, in the panel (*New projects will start under
    example.org again...*), then empties it. Cancel drops what was typed and
    closes Settings without asking, as Limits' Cancel does (AC-12 of
    home-and-settings). Closing any other way asks, through the dialog,
    which is told whether anything is typed (onDirtyChange).

    Nothing here changes an address already written: the setting is read
    at each New project, and nothing else follows it.

INPUTS / INPUT SOURCES (props)
    - settings: GET /api/settings's answer, or null while it is on its way.
    - failed: the sentence for a read that failed.
    - onSaved / onDirtyChange / onCancel: as LimitsSettings.

EXPECTED OUTPUT
    - The tab's body.
================================================================================
*/

import { useEffect, useState } from "react";
import { saveNamespace, type AppSettings } from "../api";
import { PREFIX } from "../naming/address";
import {
  CLEARED,
  CLEAR_QUESTION,
  EMPTY_LINE,
  FIELD_LABEL,
  GUIDELINES,
  NOT_REGISTERED,
  SAVED,
  W3ID_LINE,
  avoidRows,
  exampleRows,
  fieldError,
  namespaceToSave,
  patternLines,
} from "../naming/words";

interface Props {
  settings: AppSettings | null;
  failed: string | null;
  onSaved: (settings: AppSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
}

export default function NamingSettings({ settings, failed, onSaved, onDirtyChange, onCancel }: Props) {
  const saved = settings?.naming?.namespace ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState("");
  const [refused, setRefused] = useState<string | null>(null);

  const typed = draft ?? saved ?? "";
  const dirty = draft !== null && draft !== (saved ?? "");
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const error = fieldError(typed);
  const toSave = namespaceToSave(typed, saved);
  const canSave = !saving && toSave !== null;

  const run = async (value: string | null, done: string) => {
    setSaving(true);
    setRefused(null);
    try {
      const answer = await saveNamespace(value);
      onSaved(answer);
      setDraft(null);
      setStatus(done);
    } catch (e: unknown) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (canSave) void run(toSave, SAVED);
  };

  const clear = () => {
    setAsking(false);
    void run(null, CLEARED);
  };

  const cancel = () => {
    setDraft(null);
    setStatus("");
    setRefused(null);
    onCancel();
  };

  if (!settings) {
    return (
      <div className="settings-naming">
        <p className={failed ? "detail-error" : "hint"}>{failed ?? "Reading the settings…"}</p>
      </div>
    );
  }

  const described = ["naming-guidelines", ...(error ? ["naming-error"] : [])].join(" ");
  return (
    <div className="settings-naming" aria-busy={saving || undefined}>
      <label htmlFor="naming-namespace" className="settings-limit-name">
        {FIELD_LABEL}
      </label>
      <div className="naming-field">
        <span className="naming-prefix" aria-hidden="true">
          {PREFIX}
        </span>
        <input
          id="naming-namespace"
          type="text"
          className="settings-limit-input naming-input"
          value={typed}
          disabled={saving}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(e) => {
            setDraft(e.target.value);
            setStatus("");
            setRefused(null);
          }}
        />
      </div>
      {error && (
        <p id="naming-error" className="form-error">
          {error}
        </p>
      )}
      <p id="naming-guidelines" className="hint">
        {GUIDELINES} {NOT_REGISTERED}
      </p>
      <p className="hint">{W3ID_LINE}</p>
      {!typed && <p className="hint">{EMPTY_LINE}</p>}

      <section className="naming-pattern" aria-labelledby="naming-pattern-heading">
        <h3 id="naming-pattern-heading">How addresses are built</h3>
        <dl className="naming-lines">
          {patternLines(typed).map((line) => (
            <div key={line.text}>
              <dt>{line.what}</dt>
              <dd>
                <code>{line.text}</code>
              </dd>
            </div>
          ))}
        </dl>
        <details className="naming-examples">
          <summary>Show examples</summary>
          <table className="naming-table">
            <caption>Examples</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Address</th>
              </tr>
            </thead>
            <tbody>
              {exampleRows(typed).map((row) => (
                <tr key={row.what}>
                  <td>{row.what}</td>
                  <td>
                    <code>{row.address}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="naming-table">
            <caption>Avoid</caption>
            <thead>
              <tr>
                <th scope="col">Avoid</th>
                <th scope="col">Instead</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {avoidRows(typed).map((row) => (
                <tr key={row.avoid}>
                  <td>
                    <code>{row.avoid}</code>
                  </td>
                  <td>
                    <code>{row.instead}</code>
                  </td>
                  <td>{row.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      {asking && (
        <div className="wizard-actions wizard-leave" role="group" aria-label="Clear the namespace?">
          <span>{CLEAR_QUESTION}</span>
          <button type="button" onClick={clear}>
            Clear
          </button>
          <button type="button" className="primary" autoFocus onClick={() => setAsking(false)}>
            Keep it
          </button>
        </div>
      )}
      <div className="modal-actions settings-limit-actions">
        {saved !== null && !asking && (
          <button type="button" className="ghost" onClick={() => setAsking(true)}>
            Clear
          </button>
        )}
        <button type="button" className="ghost" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="primary" aria-disabled={!canSave} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {refused && <p className="form-error">{refused}</p>}
      <p className="hint settings-limit-status" role="status">
        {status}
      </p>
    </div>
  );
}
