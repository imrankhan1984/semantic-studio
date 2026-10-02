/*
================================================================================
FILE: frontend/src/components/SnapshotList.tsx
================================================================================

SUMMARY
    The project's Data section (csv-data-import 5.7): one row per snapshot
    with its name, where it came from (a sample's words included), its
    rows, a word for its report and the switch that takes its data in and
    out of every view; and its actions -- the report, Refresh…, Change the
    mapping, Edit as RML, Remove… -- with Import data from CSV at the top.

BASIC IDEA
    Every action here is a snapshot action, not a model change: none is in
    the undo history or makes the model unsaved (5.7). Each says what it
    did in the project's live region (projectStore.dataChanged), which also
    refetches the list, whose generation every view's fetch key carries.

    Refresh asks for the new file and runs step 1's checks on it first: a
    file past the 2,000-row limit gets the limit sentence and the same two
    choices as the wizard (5.2). If the headers still match the mapping it
    imports at once and the report opens; if not, the wizard opens on step
    3 with the missing columns marked, which App arranges through onWizard.

    Remove says how many statements will leave before it asks, and moves
    the folder to the project's own trash. A mapping edited outside what
    the app runs shows its reason in the row, with the last good data kept.

INPUTS / INPUT SOURCES (props)
    - projectId: the open project. onWizard: open the wizard on a start.
    - onValidate, onShowData: the report's next steps.
    Plus the project store's `data`, and api.ts.

EXPECTED OUTPUT
    - The list; snapshot actions through api.ts.
================================================================================
*/

import { useId, useRef, useState } from "react";
import { inspectData, refreshData, removeData, updateData } from "../api";
import { dataLabel, reportWord } from "../modeling/dataSentences";
import { plural } from "../modeling/shapeSentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { DataInspection, SnapshotSummary } from "../types";
import type { WizardStart } from "./DataWizard";
import ImportReport from "./ImportReport";
import RmlEditor from "./RmlEditor";

interface Props {
  projectId: string;
  onWizard: (start: WizardStart) => void;
  onValidate?: () => void;
  onShowData?: () => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function SnapshotList({ projectId, onWizard, onValidate, onShowData }: Props) {
  const data = useProjectSelector((s) => s.data);
  const headingId = useId();
  if (data === null) {
    return (
      <p className="detail-note" role="status">
        Reading the project's data…
      </p>
    );
  }
  return (
    <section className="snapshot-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Data</h3>
      <p>
        <button type="button" className="primary" onClick={() => onWizard({ kind: "new" })}>
          Import data from CSV…
        </button>
      </p>
      {data.snapshots.length === 0 ? (
        <p className="detail-note">
          No data yet. Import a CSV file of up to 2,000 rows to see how its rows map to the model.
        </p>
      ) : (
        <ul className="snapshot-list">
          {data.snapshots.map((snapshot) => (
            <SnapshotRow
              key={snapshot.id}
              projectId={projectId}
              snapshot={snapshot}
              onWizard={onWizard}
              onValidate={onValidate}
              onShowData={onShowData}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type Panel = "report" | "rml" | "remove" | null;

function SnapshotRow({
  projectId,
  snapshot,
  onWizard,
  onValidate,
  onShowData,
}: {
  projectId: string;
  snapshot: SnapshotSummary;
  onWizard: (start: WizardStart) => void;
  onValidate?: () => void;
  onShowData?: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file: File; inspection: DataInspection } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const outside = snapshot.mapping.status === "outside";
  const made =
    snapshot.individuals === 1 ? `1 ${snapshot.className ?? "row"}` : `${snapshot.individuals.toLocaleString("en-US")} ${plural(snapshot.className ?? "row")}`;

  const run = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (enabled: boolean) =>
    run("switch", async () => {
      await updateData(projectId, snapshot.id, { enabled });
      await projectStore.dataChanged(
        enabled
          ? `Switched on ${snapshot.source}: its data is back in every view.`
          : `Switched off ${snapshot.source}: its data has left every view and validation.`,
      );
    });

  const refresh = (file: File, sample: boolean) =>
    run("refresh", async () => {
      const result = await refreshData(projectId, snapshot.id, file, { sample });
      setPending(null);
      if (result.status === "mismatch") {
        onWizard({
          kind: "refresh",
          snapshot,
          file,
          options: { sample },
          inspection: result.inspection,
          missing: result.missing,
          choices: result.choices,
        });
        return;
      }
      setPanel("report");
      await projectStore.dataChanged(`Refreshed ${snapshot.source} from ${result.snapshot.source}.`);
    });

  const chooseRefresh = (file: File) =>
    run("refresh", async () => {
      // Step 1's checks first, the 2,000-row limit and its two choices included.
      const inspection = await inspectData(projectId, { file });
      if (inspection.sample) setPending({ file, inspection });
      else await refresh(file, false);
    });

  const remove = () =>
    run("remove", async () => {
      const result = await removeData(projectId, snapshot.id);
      await projectStore.dataChanged(
        `Removed ${snapshot.source}: ${result.statements.toLocaleString("en-US")} statements left the views. ` +
          "Its folder is in the project's trash.",
      );
    });

  return (
    <li className={snapshot.enabled ? "snapshot-row" : "snapshot-row off"}>
      <div className="snapshot-head">
        <span className="snapshot-name">
          {snapshot.source}
        </span>
        <span className="data-label">{dataLabel(snapshot)}</span>
        <span className="snapshot-facts">
          {made} · {reportWord(snapshot.report)}
          {busy === "refresh" ? " · Refreshing…" : ""}
        </span>
        <label className="snapshot-switch">
          <input
            type="checkbox"
            checked={snapshot.enabled}
            aria-disabled={busy !== null}
            onChange={(e) => busy === null && void toggle(e.target.checked)}
          />{" "}
          {snapshot.enabled ? "On: in every view" : "Off: in no view"}
        </label>
      </div>
      {outside && (
        <p className="detail-error">
          Mapping outside the engine: {snapshot.mapping.message}
        </p>
      )}
      <div className="snapshot-actions">
        <button type="button" aria-expanded={panel === "report"} onClick={() => setPanel(panel === "report" ? null : "report")}>
          Report
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void chooseRefresh(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-disabled={busy !== null || outside}
          title={outside ? "Change the mapping, or edit it within what the app runs, before refreshing" : undefined}
          onClick={() => busy === null && !outside && fileInput.current?.click()}
        >
          Refresh…
        </button>
        <button type="button" onClick={() => onWizard({ kind: "remap", snapshot })}>
          Change the mapping
        </button>
        <button type="button" aria-expanded={panel === "rml"} onClick={() => setPanel(panel === "rml" ? null : "rml")}>
          Edit as RML
        </button>
        <button type="button" aria-expanded={panel === "remove"} onClick={() => setPanel(panel === "remove" ? null : "remove")}>
          Remove…
        </button>
      </div>
      {pending && (
        <div className="wizard-limit" role="group" aria-label="More rows than the tool takes">
          <p>{pending.inspection.limitSentence}</p>
          <p>
            <button type="button" className="primary" onClick={() => void refresh(pending.file, true)}>
              Use the first {pending.inspection.limit.toLocaleString("en-US")} rows
            </button>{" "}
            <button type="button" onClick={() => fileInput.current?.click()}>
              Choose another file
            </button>{" "}
            <button type="button" onClick={() => setPending(null)}>
              Cancel
            </button>
          </p>
        </div>
      )}
      {panel === "report" && <ImportReport snapshot={snapshot} onValidate={onValidate} onShowData={onShowData} />}
      {panel === "rml" && (
        <RmlEditor
          projectId={projectId}
          snapshot={snapshot}
          onCancel={() => setPanel(null)}
          onApplied={(applied) => {
            setPanel(applied.mapping.status === "ok" ? "report" : null);
            void projectStore.dataChanged(
              applied.mapping.status === "ok"
                ? `Applied the mapping of ${snapshot.source}: the data was produced again.`
                : `Kept the mapping of ${snapshot.source} as written; the last good data stays. ${applied.mapping.message ?? ""}`,
            );
          }}
        />
      )}
      {panel === "remove" && (
        <div className="snapshot-remove" role="group" aria-label={`Remove ${snapshot.source}?`}>
          <p>
            Remove {snapshot.source}? Its {snapshot.statements.toLocaleString("en-US")} statements leave every view and
            validation, and its folder goes to the project's trash. The model is not changed.
          </p>
          <button type="button" className="danger" aria-disabled={busy !== null} onClick={() => busy === null && void remove()}>
            Remove
          </button>{" "}
          <button type="button" onClick={() => setPanel(null)}>
            Keep
          </button>
        </div>
      )}
      {error && (
        <p className="detail-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
