/*
================================================================================
FILE: frontend/src/components/LoadDialog.tsx
================================================================================

SUMMARY
    The modal for adding an ontology, with two tabs: Local file (drag/drop or
    picker) and URL / GitHub, opened from Home's *Open a file* and *Load from
    a URL* on the tab each names. While a project is open it is also the
    project's Load area, with a third tab, Data (csv-data-import 5.1, 5.7):
    the project's snapshots and the import wizard.

BASIC IDEA
    Each tab is a different way to obtain an ontology; both end by calling
    uploadOntology or fetchOntology and then onLoaded with the resulting
    summary. The GHE limitation is explained inline on the URL tab.

    The Suggested tab, the catalogue and *Add the examples back*, went to
    Settings → Library (home-and-settings 5.3): they are about the library,
    not about a file in hand. The load itself, its steps and its Cancel, went
    into useLoadRun.tsx, so the catalogue loads there exactly as it did here.

    While a load runs (load-progress 5.2 to 5.4) a status stands under the
    control it started from -- the drop area or the address box -- saying
    which step it is on (loadWords.ts): the bytes sent, with a bar that has a
    value, then the seconds while it is read or downloaded, with a bar that
    has none. Its Cancel aborts the request and asks the server to throw the
    result away, then says whether it was in time, and focus goes back to
    where the load started. The ✕, Escape and a click outside do the same and
    close; nothing opens after the dialog has gone. Every answer is applied
    only while its load is still the current one. A live region speaks each
    step once, never the seconds.

    A file no parser could read comes back as one sentence the server wrote
    (parse_errors.py, load-and-shapes 5.1); the parsers' own text, when the
    server sends it, sits under a closed *Technical details*, as text.

    The Data tab adds data to the open project rather than an ontology to
    the library. It shows the snapshot list, and the wizard in its place
    while one runs -- a new import, Change the mapping, or a refresh whose
    headers changed. It opens on Data when the project's tree asked for an
    import, with the wizard already started.

    Once the wizard has columns mapped (step 3 or 4) it says so, and leaving
    then asks first whichever way it is done: the wizard's own Cancel, the
    dialog's ✕, or another tab, which would unmount the wizard and lose the
    mapping as surely as closing (PR #53 review). A click outside does
    nothing while a wizard runs. When the wizard closes, the Data section's
    heading takes focus, which the unmounted wizard would otherwise drop to
    the page; a later tab switch does not take it again (X4).

    It is a dialog like the others (load-and-shapes 5.2): role, aria-modal,
    labelled by its heading, Tab kept inside (useDialogTrap's wrapTab).
    Escape is the ✕, asking first past the wizard's third step, and closing
    gives focus back to what opened it. While another modal dialog is open
    over it (an approval), every key is that dialog's.

INPUTS / INPUT SOURCES (props)
    - onLoaded: called with the new ontology's summary on success.
    - onClose: dismiss the dialog.
    - initialTab: which tab to open on, so the home screen's "Open a file"
      and "Load from a URL" land on the right one. Defaults to "file".
    - onLibraryChanged: a cancelled load had already finished, so the
      library has a new entry to read.
    - project: the open project, which adds the Data tab; startImport opens
      it with the wizard started; onValidate and onShowData are the import
      report's next steps.
    Plus useLoadRun and the api upload/fetch functions.

EXPECTED OUTPUT
    - The rendered modal; on success, a loaded ontology reported via onLoaded.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { fetchOntology, uploadOntology } from "../api";
import DataWizard, { type WizardStart } from "./DataWizard";
import SnapshotList from "./SnapshotList";
import { wrapTab } from "./useDialogTrap";
import { LoadErrorView, useLoadRun, type LoadOrigin } from "./useLoadRun";
import type { OntologySummary } from "../types";

export type LoadTab = "file" | "url" | "data";

/** The open project, for the Data tab. */
export interface LoadProject {
  id: string;
  name: string;
  modelOntologyId: string;
  taxonomy: boolean;
}

interface Props {
  onLoaded: (summary: OntologySummary) => void;
  onClose: () => void;
  initialTab?: LoadTab;
  project?: LoadProject | null;
  startImport?: boolean;
  onValidate?: () => void;
  onShowData?: () => void;
  /** A cancelled load had already finished: the library has a new entry. */
  onLibraryChanged?: () => void;
}

export default function LoadDialog({
  onLoaded,
  onClose,
  initialTab = "file",
  project = null,
  startImport = false,
  onValidate,
  onShowData,
  onLibraryChanged,
}: Props) {
  const [tab, setTab] = useState<LoadTab>(initialTab === "data" && !project ? "file" : initialTab);
  const [wizard, setWizard] = useState<WizardStart | null>(startImport && project ? { kind: "new" } : null);
  // The wizard closed: the Data section takes focus back (X4).
  const [backFromWizard, setBackFromWizard] = useState(false);
  // The wizard has a mapping to lose; and what to do once leaving is confirmed.
  const [wizardDirty, setWizardDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);

  const guard = (action: () => void) => {
    if (tab === "data" && wizard && wizardDirty) setLeaving(() => action);
    else action();
  };
  const switchTab = (next: LoadTab) => {
    if (next === tab) return;
    guard(() => {
      // Leaving the Data tab unmounts the wizard: it starts again on return.
      if (tab === "data") setWizard(null);
      // Coming back by a tab is not coming back from the wizard.
      setBackFromWizard(false);
      setTab(next);
    });
  };
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The load running now, its status and its Cancel (load-progress 5.2 to
  // 5.4), shared with Settings → Library's catalogue (useLoadRun.tsx).
  const focusOrigin = (origin: LoadOrigin) => {
    const target = origin.tab === "file" ? dropzoneRef.current : origin.tab === "url" ? urlInput.current : null;
    // On another tab than the one it started from, the control is gone.
    (target ?? headingRef.current)?.focus();
  };
  const { run, error, startLoad, cancelRun, statusAt, announcement } = useLoadRun({
    onLoaded,
    onLibraryChanged,
    focusOrigin,
  });
  const busy = run !== null;

  const close = () => {
    cancelRun(true);
    onClose();
  };

  // Into the dialog on open, unless a control in it took focus already (the
  // URL field's autoFocus); back to whatever opened it on close -- Home's two
  // buttons, the project's data button -- if it is still in the document
  // (load-and-shapes 5.2). Taken at the first render, not in the effect: by
  // then the URL field's autoFocus and the wizard's own effect have already
  // moved focus into the dialog.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!panelRef.current?.contains(document.activeElement)) headingRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, []);
  const [dragOver, setDragOver] = useState(false);

  const submitFile = (file: File) =>
    startLoad({ tab: "file" }, file.name, file.size, (options) => uploadOntology(file, options));

  const submitUrl = () => {
    const address = url.trim();
    if (!address || busy) return;
    return startLoad({ tab: "url" }, address, null, (options) => fetchOntology(address, options));
  };

  // Escape is the ✕, and like it cancels a running load: it asks first while
  // the wizard has a mapping, and with the question showing it keeps going. On `document`, as useDialogTrap's
  // is, since a click on the dialog's prose blurs focus to <body>; a key
  // pressed while another dialog is open over this one (an approval) is that
  // dialog's, even from <body>. Tab stays inside, as aria-modal promises.
  const onEscape = useRef<() => void>(() => {});
  onEscape.current = () => {
    if (leaving) setLeaving(null);
    else guard(close);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || e.defaultPrevented) return;
      const target = e.target as Node | null;
      if (target && target !== document.body && !panel.contains(target)) return;
      const over = [...document.querySelectorAll('[aria-modal="true"]')].some((d) => d !== panel);
      if (over) return;
      if (e.key !== "Escape") {
        wrapTab(panel, e);
        return;
      }
      e.preventDefault();
      onEscape.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const title = tab === "data" && project ? `Data for ${project.name}` : "Load ontology";

  return (
    // A click outside does not drop a wizard half way: Cancel does, and asks.
    // It cancels a running load, as the ✕ and Escape do (load-progress 5.3).
    <div className="modal-backdrop" onClick={() => !(tab === "data" && wizard) && close()}>
      <div
        ref={panelRef}
        className={tab === "data" ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="load-dialog-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <button className="icon-btn" onClick={() => guard(close)} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs">
          <button className={tab === "file" ? "tab active" : "tab"} onClick={() => switchTab("file")}>
            Local file
          </button>
          <button className={tab === "url" ? "tab active" : "tab"} onClick={() => switchTab("url")}>
            URL / GitHub
          </button>
          {project && (
            <button className={tab === "data" ? "tab active" : "tab"} onClick={() => switchTab("data")}>
              Data for this project
            </button>
          )}
        </div>

        {leaving && (
          <div className="wizard-actions wizard-leave" role="group" aria-label="Leave the wizard?">
            <span>Leave without importing? The mapping chosen so far is lost.</span>
            <button
              type="button"
              onClick={() => {
                const action = leaving;
                setLeaving(null);
                setWizardDirty(false);
                action();
              }}
            >
              Leave
            </button>
            <button type="button" className="primary" autoFocus onClick={() => setLeaving(null)}>
              Keep going
            </button>
          </div>
        )}

        {tab === "data" &&
          project &&
          (wizard ? (
            <DataWizard
              // A new start is a new wizard: nothing of the last one carries over.
              key={wizard.kind === "new" ? "new" : `${wizard.kind}-${wizard.snapshot.id}`}
              projectId={project.id}
              modelOntologyId={project.modelOntologyId}
              taxonomy={project.taxonomy}
              start={wizard}
              onClose={() => {
                setWizard(null);
                setBackFromWizard(true);
              }}
              onValidate={onValidate}
              onShowData={onShowData}
              onDirtyChange={setWizardDirty}
            />
          ) : (
            <SnapshotList
              projectId={project.id}
              onWizard={setWizard}
              onValidate={onValidate}
              onShowData={onShowData}
              focusOnMount={backFromWizard}
            />
          ))}

        {tab === "file" && (
          <div
            className={dragOver ? "dropzone over" : "dropzone"}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file && !busy) void submitFile(file);
            }}
            // The picker's own click bubbles back here: it is not a second ask.
            onClick={(e) => e.target !== fileInput.current && !busy && fileInput.current?.click()}
            // A control of its own, so a keyboard reaches it and a Cancel
            // can give focus back to it (load-progress 5.3).
            ref={dropzoneRef}
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              if (!busy) fileInput.current?.click();
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".ttl,.turtle,.rdf,.rdfs,.owl,.xml,.nt,.n3,.jsonld,.json,.trig,.nq"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void submitFile(file);
                e.target.value = "";
              }}
            />
            <p>Drop an ontology file here, or click to browse.</p>
            <p className="hint">Turtle, RDF/XML, OWL, N-Triples, N3, JSON-LD, TriG, N-Quads</p>
          </div>
        )}
        {tab === "file" && statusAt({ tab: "file" })}

        {tab === "url" && (
          <div className="url-form">
            <input
              ref={urlInput}
              type="text"
              aria-label="Address of an RDF file"
              placeholder="https://github.com/owner/repo/blob/main/ontology.ttl or any raw RDF URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitUrl()}
              autoFocus
            />
            {/* aria-disabled, never disabled: the button pressed keeps focus,
                and Cancel is the next stop after it (load-progress 5.3). */}
            <button className="primary" onClick={() => void submitUrl()} aria-disabled={busy || !url.trim()}>
              Fetch
            </button>
            {statusAt({ tab: "url" })}
            <p className="hint">
              Any directly reachable RDF URL works, including public <strong>github.com</strong>{" "}
              repositories — “blob” links are converted to raw file URLs automatically.
            </p>
            <p className="hint">
              <strong>GitHub Enterprise is not currently supported.</strong> To view an ontology
              hosted on a GitHub Enterprise instance, download the file to your computer and load
              it via the “Local file” tab.
            </p>
          </div>
        )}

        {/* Rendered whether or not a load runs: a live region added with
            its text is unreliably announced. It speaks each step once
            (load-progress 5.4); the seconds stay in the visible sentence. */}
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
        <LoadErrorView error={error} />
      </div>
    </div>
  );
}
