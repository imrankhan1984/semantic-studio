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
    encoding, header -- and any change reads the file again. A file past
    the tool's 2,000-row limit (D-098) gets the limit sentence and two
    choices, Use the first 2,000 rows or Choose another file, and Next waits
    for one.

    A new class (step 2) and a new attribute (step 3) are model changes, so
    each is one command through the project store: one undo step, announced
    like any other. Everything else here is a snapshot action, which is not
    a model change and never touches the undo history (5.7).

    The wizard is one region with a heading per step, and the heading takes
    focus when a step opens (Section 6). Next is aria-disabled, never
    disabled, with its reason in text beside it. Cancel asks first only once
    the columns have been mapped, where there is work to lose.

INPUTS / INPUT SOURCES (props)
    - projectId, modelOntologyId, taxonomy: the open project.
    - start: a new import, a snapshot's mapping to change, or a refresh to
      finish after a header mismatch.
    - onClose, onValidate, onShowData: leaving, and the report's next steps.
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
import { dataLabel, idProblems, previewSentences, sampleWords } from "../modeling/dataSentences";
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
}: Props) {
  const [step, setStep] = useState<Step>(start.kind === "new" ? 1 : start.kind === "remap" ? 2 : 3);
  const [file, setFile] = useState<File | null>(start.kind === "refresh" ? start.file : null);
  const [options, setOptions] = useState<DataOptions>(start.kind === "refresh" ? start.options : {});
  const [inspection, setInspection] = useState<DataInspection | null>(
    start.kind === "refresh" ? start.inspection : null,
  );
  const [fileProblem, setFileProblem] = useState<{ text: string; tooLarge: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const earlier = start.kind === "refresh" ? start.choices : null;
  const [classIri, setClassIri] = useState<string | null>(
    taxonomy ? CONCEPT : (earlier?.classIri ?? (start.kind === "new" ? null : start.snapshot.classIri)),
  );
  const [idColumn, setIdColumn] = useState<string | null>(earlier ? earlier.idColumn : null);
  const [rowNumber, setRowNumber] = useState(earlier ? earlier.idColumn === null : false);
  const [previous, setPrevious] = useState<Record<string, ColumnChoice> | null>(earlier?.columns ?? null);
  const [basis, setBasis] = useState<DataPreview | null>(null);
  const [columns, setColumns] = useState<Record<string, ColumnChoice> | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [preview, setPreview] = useState<DataPreview | null>(null);
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

  const read = async (chosen: File, nextOptions: DataOptions) => {
    setReading(true);
    setFileProblem(null);
    setError(null);
    try {
      const found = await inspectData(projectId, { file: chosen }, nextOptions);
      setInspection(found);
      // Keep the identifier only while the file still has that column.
      if (idColumn !== null && !found.columns.some((c) => c.name === idColumn)) setIdColumn(null);
      if (idColumn === null && !rowNumber) setIdColumn(found.idSuggestion);
      setColumns(null);
    } catch (e: unknown) {
      setInspection(null);
      setFileProblem({ text: message(e), tooLarge: e instanceof ApiError && e.status === 413 });
    } finally {
      setReading(false);
    }
  };

  const chooseFile = (chosen: File) => {
    setFile(chosen);
    const fresh: DataOptions = {};
    setOptions(fresh);
    setIdColumn(null);
    setRowNumber(false);
    void read(chosen, fresh);
  };

  const changeOptions = (changes: DataOptions) => {
    // A changed separator, encoding or header reads a different table, so
    // the sample question is asked again of what it holds.
    const next = { ...options, ...changes, sample: changes.sample ?? false };
    setOptions(next);
    if (file) void read(file, next);
  };

  const effectiveId = rowNumber ? null : idColumn;

  // Step 2 onwards: the identifier check, the fields of the row's class and
  // the suggestions, again whenever the class or the identifier changes.
  useEffect(() => {
    if (step === 1 || step === "report" || !source || !classIri || !inspection) return;
    let live = true;
    previewData(projectId, source, options, { classIri, idColumn: effectiveId, columns: {} })
      .then((found) => live && setBasis(found))
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
    // `source` is derived from file and start; listing them keeps the key stable.
  }, [step === 1, projectId, file, start, classIri, effectiveId, inspection, options]);

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
    previewData(projectId, source, options, choices)
      .then((found) => live && setPreview(found))
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [step]);

  const blocked = typeof step === "number" ? stepBlocked(step, { inspection, options, classIri }) : null;

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
    if (!choices || busy) return;
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
          }}
          onIdColumn={(column) => {
            setIdColumn(column);
            setRowNumber(false);
          }}
          onRowNumber={setRowNumber}
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
              void previewData(projectId, source, options, { classIri, idColumn: effectiveId, columns: {} })
                .then(setBasis)
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

function FileStep({
  file,
  inspection,
  options,
  reading,
  problem,
  onFile,
  onOptions,
}: {
  file: File | null;
  inspection: DataInspection | null;
  options: DataOptions;
  reading: boolean;
  problem: { text: string; tooLarge: boolean } | null;
  onFile: (file: File) => void;
  onOptions: (changes: DataOptions) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
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
        <input ref={input} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={pick} />
        <button type="button" onClick={() => input.current?.click()}>
          {file ? "Choose another file" : "Choose a file"}
        </button>
        <p className="hint">
          {file ? `${file.name}.` : "Or drop a CSV file here."} At most 2,000 rows, 100 columns and 5 MB.
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
      {inspection && !reading && (
        <>
          <div className="wizard-detections">
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
      {!report.clean && (
        <p className="detail-note">
          Values that do not fit their type are kept as text and listed in the report after the import.
        </p>
      )}
    </div>
  );
}
