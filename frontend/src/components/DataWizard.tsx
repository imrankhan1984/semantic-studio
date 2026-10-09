/*
================================================================================
FILE: frontend/src/components/DataWizard.tsx
================================================================================

SUMMARY
    The data import wizard (csv-data-import 5.2 to 5.5), four steps and the
    report: the file and what was detected in it, what a row is and which
    column identifies it, what each column becomes, and the preview as
    sentences before Import. Also how "Change the mapping" (steps 2 to 4 on
    the copy kept) and a refresh whose headers changed (step 3 with the
    missing columns marked) are finished (5.7).

BASIC IDEA
    One decision per step, each a component of its own below, and nothing
    applied silently (Section 7): the server suggests the identifier, the
    name and each column's attribute, and the wizard shows each suggestion
    as a preselected choice marked *suggested*. The rules for choices are
    modeling/dataChoices.ts's and the words modeling/dataSentences.ts's.

    The browser holds the file and sends it again for each step; the server
    keeps nothing until Import. Step 1 shows what it detected -- separator,
    encoding, header -- and any change reads the file again. An Excel
    workbook (5.8) shows a sheet picker, each sheet with its rows, and a
    header row picker naming each of the sheet's first rows by its first
    cells; those stay on screen when a choice reads nothing (an empty
    sheet or header row: the refusal brings the sheets and rows with it),
    so the choice can be put right. The detections and the pickers stay
    mounted while the file is read again, so the control just changed
    keeps keyboard focus. Reads are numbered and only the latest reply is
    applied, and Next waits while one is on its way. A file past
    the tool's 2,000-row limit (D-098) gets the limit sentence and two
    choices, Use the first 2,000 rows or Choose another file, and Next waits
    for one.

    A new class (step 2) and a new attribute (step 3) are model changes, so
    each is one command through the project store: one undo step, announced
    like any other. Everything else here is a snapshot action, which is not
    a model change and never touches the undo history (5.7).

    The wizard is one region with a heading per step, and the heading takes
    focus when a step opens (Section 6). Next is aria-disabled, never
    disabled, with its reason in text beside it, and so is Import: a press
    while either says it cannot is ignored. Cancel asks first only once the
    columns have been mapped, where there is work to lose, and the wizard
    tells its dialog when that is, so the dialog's ✕ and its tabs ask too.

    The server's reading of the chosen class -- the identifier check, the
    class's fields and the suggestions -- is held with the class and
    identifier it was read for, and used only while they are still the
    chosen ones: a class changed on step 2 waits for its own reading rather
    than offering the old class's columns. A reading that fails says so
    with Try again, and Next waits (PR #53 review).

INPUTS / INPUT SOURCES (props)
    - projectId, modelOntologyId, taxonomy: the open project.
    - start: a new import, a snapshot's mapping to change, or a refresh to
      finish after a header mismatch.
    - onClose, onValidate, onShowData: leaving, and the report's next steps.
    - onDirtyChange: told whether leaving would lose a mapping (step 3 or 4).
    Plus api.ts and the project store.

EXPECTED OUTPUT
    - The wizard; a new or updated snapshot, announced in the live region.
================================================================================
*/

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ApiError, fetchHierarchy, importData, inspectData, previewData, refreshData, updateData } from "../api";
import type { DataSourceRef } from "../api";
import {
  NEW_ATTRIBUTE,
  NEW_TYPES,
  choiceValue,
  initialColumns,
  parseChoice,
  stepBlocked,
  suggestedType,
  withChoice,
} from "../modeling/dataChoices";
import {
  dataLabel,
  headerRowOption,
  idProblems,
  previewSentences,
  sampleWords,
  sheetOption,
  unmatchedLines,
} from "../modeling/dataSentences";
import { projectStore } from "../state/projectStore";
import type {
  ColumnChoice,
  DataChoices,
  DataField,
  DataInspection,
  DataOptions,
  DataPreview,
  Separator,
  SnapshotSummary,
  DataEncoding,
  WorkbookInspection,
} from "../types";
import ImportReport from "./ImportReport";

const CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";

export type WizardStart =
  | { kind: "new" }
  | { kind: "remap"; snapshot: SnapshotSummary }
  | {
      kind: "refresh";
      snapshot: SnapshotSummary;
      file: File;
      options: DataOptions;
      inspection: DataInspection;
      missing: string[];
      choices: DataChoices | null;
    };

interface Props {
  projectId: string;
  modelOntologyId: string;
  taxonomy: boolean;
  start: WizardStart;
  onClose: () => void;
  onValidate?: () => void;
  onShowData?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type Step = 1 | 2 | 3 | 4 | "report";

const STEP_TITLES: Record<1 | 2 | 3 | 4, string> = {
  1: "the file",
  2: "what a row is",
  3: "the columns",
  4: "preview and import",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function DataWizard({
  projectId,
  modelOntologyId,
  taxonomy,
  start,
  onClose,
  onValidate,
  onShowData,
  onDirtyChange,
}: Props) {
  const [step, setStep] = useState<Step>(start.kind === "new" ? 1 : start.kind === "remap" ? 2 : 3);
  const [file, setFile] = useState<File | null>(start.kind === "refresh" ? start.file : null);
  const [options, setOptions] = useState<DataOptions>(start.kind === "refresh" ? start.options : {});
  const [inspection, setInspection] = useState<DataInspection | null>(
    start.kind === "refresh" ? start.inspection : null,
  );
  const [fileProblem, setFileProblem] = useState<{ text: string; tooLarge: boolean } | null>(null);
  // A workbook's sheets and first rows, kept when a re-read fails.
  const [workbook, setWorkbook] = useState<WorkbookInspection | null>(
    start.kind === "refresh" ? (start.inspection.workbook ?? null) : null,
  );
  const [reading, setReading] = useState(false);
  const earlier = start.kind === "refresh" ? start.choices : null;
  const [classIri, setClassIri] = useState<string | null>(
    taxonomy ? CONCEPT : (earlier?.classIri ?? (start.kind === "new" ? null : start.snapshot.classIri)),
  );
  const [idColumn, setIdColumn] = useState<string | null>(earlier ? earlier.idColumn : null);
  const [rowNumber, setRowNumber] = useState(earlier ? earlier.idColumn === null : false);
  const [previous, setPrevious] = useState<Record<string, ColumnChoice> | null>(earlier?.columns ?? null);
  // The class reading, with the class and identifier it was read for.
  const [classReading, setClassReading] = useState<{ key: string; preview: DataPreview } | null>(null);
  const [basisFailed, setBasisFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [columns, setColumns] = useState<Record<string, ColumnChoice> | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SnapshotSummary | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  const headingId = useId();

  const source: DataSourceRef | null =
    start.kind === "remap" ? { snapshot: start.snapshot.id } : file ? { file } : null;

  // The copy a snapshot keeps, for Change the mapping: its columns, rows and
  // stored choices.
  useEffect(() => {
    if (start.kind !== "remap") return;
    let live = true;
    inspectData(projectId, { snapshot: start.snapshot.id })
      .then((found) => {
        if (!live) return;
        setInspection(found);
        if (found.choices) {
          setClassIri(found.choices.classIri);
          setIdColumn(found.choices.idColumn);
          setRowNumber(found.choices.idColumn === null);
          setPrevious(found.choices.columns);
        }
      })
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [projectId, start]);

  // A new step's heading takes focus (Section 6).
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // The identifier is passed in rather than read from this render: a new
  // file resets it in the same event, and the closure would still hold the
  // last file's, which lost the new file's suggestion (PR #53 review).
  // Only the latest read's reply is applied: quick sheet changes raced, and
  // a slower reply for the earlier sheet replaced the newer one, so the
  // table showed another sheet than the picker (PR #54 review).
  const readCount = useRef(0);
  const read = async (
    chosen: File,
    nextOptions: DataOptions,
    id: { idColumn: string | null; rowNumber: boolean },
  ) => {
    const ticket = ++readCount.current;
    const latest = () => ticket === readCount.current;
    setReading(true);
    setFileProblem(null);
    setError(null);
    try {
      const found = await inspectData(projectId, { file: chosen }, nextOptions);
      if (!latest()) return;
      setInspection(found);
      setWorkbook(found.workbook ?? null);
      // Keep the identifier only while the file still has that column.
      let kept = id.idColumn;
      if (kept !== null && !found.columns.some((c) => c.name === kept)) kept = null;
      if (kept === null && !id.rowNumber) kept = found.idSuggestion;
      setIdColumn(kept);
      setColumns(null);
    } catch (e: unknown) {
      if (!latest()) return;
      setInspection(null);
      // A sheet read without a table (an empty sheet or header row) comes
      // back with the sheets and its rows, so both pickers stay. Otherwise
      // another sheet that could not be read: its rows are not known, so
      // the header row picker offers them by number only (code review).
      const listed = refusedWorkbook(e);
      setWorkbook((current) =>
        listed ??
        (current && nextOptions.sheet !== undefined && nextOptions.sheet !== current.sheet
          ? { ...current, sheet: nextOptions.sheet, headerRow: nextOptions.headerRow ?? 1, top: unreadRows() }
          : current),
      );
      setFileProblem({ text: message(e), tooLarge: e instanceof ApiError && e.status === 413 });
    } finally {
      // An earlier read finishing leaves the wizard reading the latest.
      if (latest()) setReading(false);
    }
  };

  const chooseFile = (chosen: File) => {
    setFile(chosen);
    setWorkbook(null);
    const fresh: DataOptions = {};
    setOptions(fresh);
    setIdColumn(null);
    setRowNumber(false);
    void read(chosen, fresh, { idColumn: null, rowNumber: false });
  };

  const changeOptions = (changes: DataOptions) => {
    // A changed separator, encoding or header reads a different table, so
    // the sample question is asked again of what it holds.
    const next = { ...options, ...changes, sample: changes.sample ?? false };
    setOptions(next);
    if (file) void read(file, next, { idColumn, rowNumber });
  };

  const effectiveId = rowNumber ? null : idColumn;
  const basisKey = `${classIri ?? ""}|${effectiveId ?? ""}`;
  const basis = classReading && classReading.key === basisKey ? classReading.preview : null;

  // Step 2 onwards: the identifier check, the fields of the row's class and
  // the suggestions, again whenever the class or the identifier changes.
  useEffect(() => {
    if (step === 1 || step === "report" || !source || !classIri || !inspection) return;
    let live = true;
    const key = basisKey;
    setBasisFailed(null);
    previewData(projectId, source, options, { classIri, idColumn: effectiveId, columns: {} })
      .then((found) => live && setClassReading({ key, preview: found }))
      .catch((e: unknown) => live && setBasisFailed(message(e)));
    return () => {
      live = false;
    };
    // `source` is derived from file and start; listing them keeps the key stable.
  }, [step === 1, projectId, file, start, classIri, effectiveId, inspection, options, retry]);

  // Step 3 starts from the suggestions, or the choices made before.
  useEffect(() => {
    if (step !== 3 || !basis || !inspection || columns !== null) return;
    const made = initialColumns(
      inspection.columns.map((c) => c.name),
      basis.suggestions,
      previous,
    );
    setColumns(made.columns);
    setSuggested(made.suggested);
  }, [step, basis, inspection, columns, previous]);

  const choices: DataChoices | null =
    classIri && columns ? { classIri, idColumn: effectiveId, columns } : null;

  // Step 4: the preview as sentences, and the report to expect.
  useEffect(() => {
    if (step !== 4 || !source || !choices) return;
    let live = true;
    setPreview(null);
    setPreviewFailed(false);
    previewData(projectId, source, options, choices)
      .then((found) => live && setPreview(found))
      .catch((e: unknown) => {
        if (!live) return;
        setPreviewFailed(true);
        setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [step, retry]);

  // Leaving now would lose a mapping: the dialog asks before its ✕ or a tab.
  useEffect(() => {
    onDirtyChange?.(step === 3 || step === 4);
  }, [step, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const blocked =
    typeof step === "number"
      ? stepBlocked(step, {
          inspection,
          options,
          classIri,
          basis: basis ? "ready" : basisFailed ? "failed" : "reading",
          columnsReady: choices !== null,
          reading,
        })
      : null;
  const retryShown = (step === 2 || step === 3) && basisFailed !== null && !basis;

  const goNext = () => {
    if (blocked || typeof step !== "number" || step >= 4) return;
    setError(null);
    setStep((step + 1) as Step);
  };

  const goBack = () => {
    if (typeof step !== "number") return;
    const first = start.kind === "new" ? 1 : 2;
    if (step > first) setStep((step - 1) as Step);
  };

  const doImport = async () => {
    // aria-disabled, not disabled: a press while it says so does nothing.
    if (!choices || busy || !preview) return;
    setBusy(true);
    setError(null);
    try {
      let made: SnapshotSummary;
      if (start.kind === "new") {
        made = (await importData(projectId, file!, options, choices)).snapshot;
      } else if (start.kind === "refresh") {
        const result = await refreshData(projectId, start.snapshot.id, file!, options, choices);
        if (result.status !== "imported") throw new Error(`The file still lacks ${result.missing.join(", ")}.`);
        made = result.snapshot;
      } else {
        made = (await updateData(projectId, start.snapshot.id, { choices })).snapshot;
      }
      setDone(made);
      setStep("report");
      const verb = start.kind === "remap" ? "Mapped again" : "Imported";
      await projectStore.dataChanged(`${verb} ${made.source}: ${made.report.individuals.toLocaleString("en-US")} made.`);
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (typeof step === "number" && step >= 3 && !confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    onClose();
  };

  const title =
    step === "report"
      ? start.kind === "remap"
        ? "Mapped again"
        : "Imported"
      : `Step ${step} of 4: ${STEP_TITLES[step]}`;

  return (
    <section className="data-wizard" aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        {title}
      </h3>
      {start.kind !== "new" && step !== "report" && (
        <p className="detail-note">
          {start.kind === "remap" ? "Changing the mapping of " : "Refreshing "}
          {dataLabel(start.snapshot)}
        </p>
      )}

      {step === 1 && (
        <FileStep
          file={file}
          inspection={inspection}
          workbook={workbook}
          options={options}
          reading={reading}
          problem={fileProblem}
          onFile={chooseFile}
          onOptions={changeOptions}
        />
      )}
      {step === 2 && (
        <RowStep
          inspection={inspection}
          modelOntologyId={modelOntologyId}
          taxonomy={taxonomy}
          classIri={classIri}
          idColumn={idColumn}
          rowNumber={rowNumber}
          basis={basis}
          onClass={(iri) => {
            setClassIri(iri);
            setColumns(null);
            setSuggested([]);
          }}
          onIdColumn={(column) => {
            setIdColumn(column);
            setRowNumber(false);
            setColumns(null);
          }}
          onRowNumber={(on) => {
            setRowNumber(on);
            setColumns(null);
          }}
          onError={setError}
        />
      )}
      {step === 3 && (
        <ColumnsStep
          inspection={inspection}
          basis={basis}
          columns={columns}
          suggested={suggested}
          missing={start.kind === "refresh" ? start.missing : []}
          classIri={classIri}
          taxonomy={taxonomy}
          onChange={(column, choice) => {
            setColumns((current) => (current ? withChoice(current, column, choice) : current));
            setSuggested((current) => current.filter((c) => c !== column));
          }}
          onCreated={(column, property) => {
            // The new attribute is one of the class's fields once the
            // preview is read again; until then it is chosen by IRI.
            setColumns((current) =>
              current ? withChoice(current, column, { as: "attribute", property }) : current,
            );
            setSuggested((current) => current.filter((c) => c !== column));
            if (source && classIri) {
              const key = basisKey;
              void previewData(projectId, source, options, { classIri, idColumn: effectiveId, columns: {} })
                .then((found) => setClassReading({ key, preview: found }))
                .catch((e: unknown) => setError(message(e)));
            }
          }}
          onError={setError}
        />
      )}
      {step === 4 && <PreviewStep preview={preview} inspection={inspection} busy={busy} />}
      {step === "report" && done && (
        <ImportReport snapshot={done} announce onValidate={onValidate} onShowData={onShowData} />
      )}

      {retryShown && (
        <p className="detail-error" role="alert">
          {basisFailed}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {step === 4 && previewFailed && (
        <p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setRetry((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      )}
      {error && (
        <p className="detail-error" role="alert">
          {error}
        </p>
      )}

      {confirmCancel ? (
        <div className="wizard-actions" role="group" aria-label="Leave the wizard?">
          <span>Leave without importing? The mapping chosen so far is lost.</span>
          <button type="button" onClick={onClose}>
            Leave
          </button>
          <button type="button" className="primary" onClick={() => setConfirmCancel(false)}>
            Keep going
          </button>
        </div>
      ) : step === "report" ? (
        <div className="wizard-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="wizard-actions">
          {step !== (start.kind === "new" ? 1 : 2) && (
            <button type="button" onClick={goBack}>
              Back
            </button>
          )}
          {step === 4 ? (
            <button
              type="button"
              className="primary"
              aria-disabled={busy || !preview}
              onClick={() => void doImport()}
            >
              {busy ? "Importing…" : start.kind === "new" ? "Import" : "Import again"}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              aria-disabled={blocked !== null}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={goNext}
            >
              Next
            </button>
          )}
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          {blocked && step !== 4 && (
            <span id={reasonId} className="detail-note">
              {blocked}
            </span>
          )}
        </div>
      )}
      {busy && (
        <p className="detail-note" role="status">
          Importing {(inspection?.kept ?? 0).toLocaleString("en-US")} rows…
        </p>
      )}
    </section>
  );
}

/* --- Step 1: the file ------------------------------------------------------------ */

const SEPARATOR_NAMES: [Separator, string][] = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["\t", "Tab"],
];
const ENCODING_NAMES: [DataEncoding, string][] = [
  ["utf-8", "UTF-8"],
  ["utf-8-sig", "UTF-8 with BOM"],
  ["windows-1252", "Windows-1252"],
];

// What the file chooser offers: CSV text, and Excel workbooks (5.8).
export const DATA_FILE_ACCEPT =
  ".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function FileStep({
  file,
  inspection,
  workbook,
  options,
  reading,
  problem,
  onFile,
  onOptions,
}: {
  file: File | null;
  inspection: DataInspection | null;
  workbook: WorkbookInspection | null;
  options: DataOptions;
  reading: boolean;
  problem: { text: string; tooLarge: boolean } | null;
  onFile: (file: File) => void;
  onOptions: (changes: DataOptions) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const sheetId = useId();
  const headerRowId = useId();
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    if (chosen) onFile(chosen);
    event.target.value = "";
  };
  return (
    <div className="wizard-step">
      <div
        className={over ? "dropzone over" : "dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) onFile(dropped);
        }}
      >
        <input ref={input} type="file" accept={DATA_FILE_ACCEPT} hidden onChange={pick} />
        <button type="button" onClick={() => input.current?.click()}>
          {file ? "Choose another file" : "Choose a file"}
        </button>
        <p className="hint">
          {file ? `${file.name}.` : "Or drop a CSV or Excel (.xlsx) file here."} At most 2,000 rows (per sheet in a
          workbook), 100 columns and 5 MB.
        </p>
      </div>
      {reading && (
        <p className="detail-note" role="status">
          Reading…
        </p>
      )}
      {problem && (
        <p className="detail-error" role="alert">
          {problem.tooLarge ? "Too large. " : "Not readable. "}
          {problem.text}
        </p>
      )}
      {/* The pickers stay mounted while the file is read again: one that
          unmounted on its own change dropped keyboard focus to the page
          (found by X4 in Chrome). */}
      {workbook && (
        <div className="wizard-detections" aria-busy={reading}>
          <p className="wizard-field">
            <label htmlFor={sheetId}>Sheet </label>
            <select
              id={sheetId}
              value={options.sheet ?? workbook.sheet}
              // Another sheet starts again from its first row.
              onChange={(e) => onOptions({ sheet: e.target.value, headerRow: undefined })}
            >
              {workbook.sheets.map((sheet) => (
                <option key={sheet.name} value={sheet.name}>
                  {sheetOption(sheet)}
                </option>
              ))}
            </select>
          </p>
          <p className="wizard-field">
            <label htmlFor={headerRowId}>Header row </label>
            <select
              id={headerRowId}
              value={options.headerRow ?? workbook.headerRow}
              onChange={(e) => onOptions({ headerRow: Number(e.target.value) })}
            >
              {headerRows(workbook, options.headerRow ?? workbook.headerRow).map((row) => (
                <option key={row.row} value={row.row}>
                  {headerRowOption(row)}
                </option>
              ))}
            </select>
          </p>
        </div>
      )}
      {inspection && (
        <>
          {/* Not `hidden`: .wizard-detections sets display, which beats the
              attribute, so a workbook showed a CSV file's separator (X4). */}
          {inspection.format !== "xlsx" && (
            <div className="wizard-detections" aria-busy={reading}>
              <label>
                Separator{" "}
                <select
                  value={options.separator ?? inspection.separator}
                  onChange={(e) => onOptions({ separator: e.target.value as Separator })}
                >
                  {SEPARATOR_NAMES.map(([value, name]) => (
                    <option key={name} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Encoding{" "}
                <select
                  value={options.encoding ?? inspection.encoding}
                  onChange={(e) => onOptions({ encoding: e.target.value as DataEncoding })}
                >
                  {ENCODING_NAMES.map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.header ?? inspection.header}
                  onChange={(e) => onOptions({ header: e.target.checked })}
                />{" "}
                First row is the header
              </label>
            </div>
          )}
          {inspection.renamed.length > 0 && (
            <ul className="wizard-notes">
              {inspection.renamed.map((r) => (
                <li key={r.index}>
                  {r.from
                    ? `Column ${r.index + 1} is a second "${r.from}": called "${r.to}".`
                    : `Column ${r.index + 1} has no name: called "${r.to}".`}
                </li>
              ))}
            </ul>
          )}
          {inspection.sample && (
            <div className="wizard-limit" role="group" aria-label="More rows than the tool takes">
              <p>{inspection.limitSentence}</p>
              {options.sample ? (
                <p className="detail-note">
                  Using the first {inspection.limit.toLocaleString("en-US")} rows. The data will be marked{" "}
                  <em>{sampleWords({ rows: inspection.kept, total: inspection.total, sample: true })}</em> wherever
                  it is shown.
                </p>
              ) : (
                <p>
                  <button type="button" className="primary" onClick={() => onOptions({ sample: true })}>
                    Use the first {inspection.limit.toLocaleString("en-US")} rows
                  </button>{" "}
                  <button type="button" onClick={() => input.current?.click()}>
                    Choose another file
                  </button>
                </p>
              )}
            </div>
          )}
          <p className="detail-note">
            {inspection.total.toLocaleString("en-US")} {inspection.total === 1 ? "row" : "rows"},{" "}
            {inspection.columns.length} {inspection.columns.length === 1 ? "column" : "columns"}. The first{" "}
            {Math.min(inspection.rows.length, 20)} are shown.
          </p>
          <div className="wizard-table-wrap">
            <table className="wizard-table">
              <thead>
                <tr>
                  {inspection.columns.map((c) => (
                    <th key={c.name} scope="col">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inspection.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** A sheet's first rows when they could not be read: numbers, no cells. */
/** The sheets and rows a refused workbook read came back with, if any. */
function refusedWorkbook(e: unknown): WorkbookInspection | null {
  if (!(e instanceof ApiError) || typeof e.detail !== "object" || e.detail === null) return null;
  const listed = (e.detail as { workbook?: WorkbookInspection }).workbook;
  return listed && Array.isArray(listed.sheets) && Array.isArray(listed.top) ? listed : null;
}

function unreadRows(): { row: number; cells: string[]; unread: boolean }[] {
  return Array.from({ length: 20 }, (_, i) => ({ row: i + 1, cells: [], unread: true }));
}

/** The rows the header row picker offers: the sheet's first rows, and the
 *  chosen one when it is further down (a refresh's earlier choice). */
function headerRows(workbook: WorkbookInspection, chosen: number): WorkbookInspection["top"] {
  const rows = workbook.top.length > 0 ? workbook.top : [{ row: 1, cells: [] }];
  return rows.some((r) => r.row === chosen) ? rows : [...rows, { row: chosen, cells: [] }];
}

/* --- Step 2: what a row is ----------------------------------------------------------- */

function RowStep({
  inspection,
  modelOntologyId,
  taxonomy,
  classIri,
  idColumn,
  rowNumber,
  basis,
  onClass,
  onIdColumn,
  onRowNumber,
  onError,
}: {
  inspection: DataInspection | null;
  modelOntologyId: string;
  taxonomy: boolean;
  classIri: string | null;
  idColumn: string | null;
  rowNumber: boolean;
  basis: DataPreview | null;
  onClass: (iri: string) => void;
  onIdColumn: (column: string) => void;
  onRowNumber: (on: boolean) => void;
  onError: (message: string) => void;
}) {
  const [classes, setClasses] = useState<{ iri: string; label: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [loadToken, setLoadToken] = useState(0);
  const classId = useId();
  const idId = useId();
  const newId = useId();

  useEffect(() => {
    if (taxonomy) return;
    let live = true;
    fetchHierarchy(modelOntologyId)
      .then((tree) => {
        if (!live) return;
        const found = Object.entries(tree.classes.nodes)
          .filter(([, n]) => n.kind === "class")
          .map(([iri, n]) => ({ iri, label: n.label }))
          .sort((a, b) => a.label.localeCompare(b.label));
        setClasses(found);
      })
      .catch((e: unknown) => live && onError(message(e)));
    return () => {
      live = false;
    };
  }, [modelOntologyId, taxonomy, loadToken]);

  const createClass = async () => {
    const label = newName.trim();
    if (!label) return;
    try {
      const result = await projectStore.command("CreateClass", { label }, undefined, "model");
      setCreating(false);
      setNewName("");
      setLoadToken((t) => t + 1);
      if (result.created) onClass(result.created);
    } catch (e: unknown) {
      onError(message(e));
    }
  };

  const check = basis?.idCheck;
  const problems = check && !rowNumber && check.column ? idProblems(check) : [];
  const example = basis?.rows?.find((r) => r.subject)?.subject;

  return (
    <div className="wizard-step">
      <p className="wizard-field">
        <label htmlFor={classId}>Each row is </label>
        {taxonomy ? (
          <span id={classId}>a concept of the project's scheme</span>
        ) : (
          <select
            id={classId}
            value={creating ? "new" : (classIri ?? "")}
            onChange={(e) => {
              if (e.target.value === "new") setCreating(true);
              else {
                setCreating(false);
                onClass(e.target.value);
              }
            }}
          >
            <option value="" disabled>
              Choose a class
            </option>
            {classes.map((c) => (
              <option key={c.iri} value={c.iri}>
                a {c.label}
              </option>
            ))}
            <option value="new">A new class…</option>
          </select>
        )}
      </p>
      {creating && (
        <p className="wizard-inline">
          <label htmlFor={newId}>Name of the new class</label>{" "}
          <input id={newId} value={newName} onChange={(e) => setNewName(e.target.value)} />{" "}
          <button type="button" aria-disabled={!newName.trim()} onClick={() => void createClass()}>
            Create class
          </button>
        </p>
      )}
      {inspection && (
        <p className="wizard-field">
          <label htmlFor={idId}>Each row is identified by column </label>
          <select
            id={idId}
            value={rowNumber ? "" : (idColumn ?? "")}
            onChange={(e) => (e.target.value ? onIdColumn(e.target.value) : onRowNumber(true))}
          >
            <option value="">its row number</option>
            {inspection.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {c.name === inspection.idSuggestion ? " (suggested)" : ""}
              </option>
            ))}
          </select>
        </p>
      )}
      {problems.length > 0 && (
        <div className="wizard-problems" role="status">
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <p>
            <button type="button" onClick={() => onRowNumber(true)}>
              Use the row number instead
            </button>
          </p>
        </div>
      )}
      {check && check.ok && check.column && !rowNumber && (
        <p className="detail-note" role="status">
          Every row has a different {check.column}.
        </p>
      )}
      {example && (
        <p className="detail-note">
          Row 1 becomes <code>{example}</code>
        </p>
      )}
    </div>
  );
}

/* --- Step 3: the columns -------------------------------------------------------------- */

function fieldOptions(fields: DataField[]) {
  return fields.map((f) => (
    <option key={`${f.kind} ${f.property}`} value={choiceValue({ as: f.kind, property: f.property })}>
      {f.kind === "attribute" ? `attribute: ${f.label}` : `relationship: ${f.label} (by its id)`}
    </option>
  ));
}

function ColumnsStep({
  inspection,
  basis,
  columns,
  suggested,
  missing,
  classIri,
  taxonomy,
  onChange,
  onCreated,
  onError,
}: {
  inspection: DataInspection | null;
  basis: DataPreview | null;
  columns: Record<string, ColumnChoice> | null;
  suggested: string[];
  missing: string[];
  classIri: string | null;
  taxonomy: boolean;
  onChange: (column: string, choice: ColumnChoice) => void;
  onCreated: (column: string, property: string) => void;
  onError: (message: string) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const baseId = useId();
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const firstValues = useMemo(() => {
    const out: Record<string, string> = {};
    inspection?.columns.forEach((c, i) => {
      out[c.name] = inspection.rows.find((r) => r[i])?.[i] ?? "";
    });
    return out;
  }, [inspection]);

  if (!inspection || !basis || !columns) {
    return (
      <p className="detail-note" role="status">
        Reading what each column can become…
      </p>
    );
  }
  const fields = basis.fields;
  const create = async (column: string) => {
    const label = name.trim();
    if (!label || !classIri) return;
    const datatype = NEW_TYPES.find((t) => t.key === type)?.datatype;
    try {
      const result = await projectStore.command(
        "CreateDatatypeProperty",
        { label, domain: classIri, datatype },
        undefined,
        "model",
      );
      setAdding(null);
      if (result.created) onCreated(column, result.created);
    } catch (e: unknown) {
      onError(message(e));
    }
  };
  return (
    <div className="wizard-step">
      {missing.length > 0 && (
        <ul className="wizard-problems" role="status">
          {missing.map((m) => (
            <li key={m}>Column {m} is missing from the new file.</li>
          ))}
        </ul>
      )}
      <div className="wizard-table-wrap">
        <table className="wizard-table wizard-columns">
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">First value</th>
              <th scope="col">Becomes</th>
            </tr>
          </thead>
          <tbody>
            {inspection.columns.map((profile, index) => {
              const column = profile.name;
              // By position: a header is the file's text and may hold spaces.
              const selectId = `${baseId}-column-${index}`;
              return (
                <tr key={column}>
                  <th scope="row">
                    <label htmlFor={selectId}>{column}</label>
                  </th>
                  <td>{firstValues[column]}</td>
                  <td>
                    <select
                      id={selectId}
                      value={adding === column ? NEW_ATTRIBUTE : choiceValue(columns[column])}
                      onChange={(e) => {
                        const parsed = parseChoice(e.target.value);
                        if (parsed === NEW_ATTRIBUTE) {
                          setAdding(column);
                          setName(column);
                          setType(suggestedType(profile));
                        } else {
                          setAdding(null);
                          onChange(column, parsed);
                        }
                      }}
                    >
                      <option value="ignore">Ignore</option>
                      <option value="name">The name</option>
                      {fieldOptions(fields)}
                      {/* One the wizard made a moment ago, not yet in the fields. */}
                      {columns[column]?.property &&
                        !fields.some((f) => f.property === columns[column].property) && (
                          <option value={choiceValue(columns[column])}>attribute: {column}</option>
                        )}
                      {!taxonomy && <option value={NEW_ATTRIBUTE}>A new attribute…</option>}
                    </select>
                    {suggested.includes(column) && <span className="wizard-suggested"> suggested</span>}
                    {adding === column && (
                      <span className="wizard-inline">
                        <label>
                          Name <input value={name} onChange={(e) => setName(e.target.value)} />
                        </label>{" "}
                        <label>
                          Type{" "}
                          <select value={type} onChange={(e) => setType(e.target.value)}>
                            {NEW_TYPES.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </label>{" "}
                        <button type="button" aria-disabled={!name.trim()} onClick={() => void create(column)}>
                          Create attribute
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --- Step 4: preview and import ------------------------------------------------------- */

function PreviewStep({
  preview,
  inspection,
  busy,
}: {
  preview: DataPreview | null;
  inspection: DataInspection | null;
  busy: boolean;
}) {
  if (!preview?.rows || !preview.report) {
    return (
      <p className="detail-note" role="status">
        Preparing the preview…
      </p>
    );
  }
  const report = preview.report;
  const className = preview.className ?? "row";
  const sample = inspection?.sample
    ? sampleWords({ rows: inspection.kept, total: inspection.total, sample: true })
    : null;
  return (
    <div className="wizard-step" aria-busy={busy}>
      <p className="wizard-summary">
        {report.rowsRead.toLocaleString("en-US")} {report.rowsRead === 1 ? "row" : "rows"} →{" "}
        {report.statements.toLocaleString("en-US")} statements
        {sample ? ` (${sample})` : ""}
      </p>
      <ol className="wizard-preview">
        {preview.rows.map((row) => (
          <li key={row.row}>{previewSentences(row, className).join(" ")}</li>
        ))}
      </ol>
      {report.keptAsText.length > 0 && (
        <p className="detail-note">
          Values that do not fit their type are kept as text and listed in the report after the import.
        </p>
      )}
      {(report.unmatched ?? []).length > 0 && (
        <div className="detail-note">
          <ul className="wizard-notes">
            {unmatchedLines(report).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            These links are still written. Import the rows they point to, before or after this file, and they
            link; until then Validate reports them.
          </p>
        </div>
      )}
    </div>
  );
}
