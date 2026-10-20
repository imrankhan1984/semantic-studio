/*
================================================================================
FILE: frontend/src/components/LoadDialog.tsx
================================================================================

SUMMARY
    The modal for adding an ontology, with three tabs: Suggested (the built-in
    catalogue, and *Add the examples back* when a bundled example has been
    removed, home-and-examples 5.8), Local file (drag/drop or picker), and
    URL / GitHub. While a
    project is open it is also the project's Load area, with a fourth tab,
    Data (csv-data-import 5.1, 5.7): the project's snapshots and the import
    wizard.

BASIC IDEA
    Each tab is a different way to obtain an ontology; all three end by calling
    uploadOntology or fetchOntology and then onLoaded with the resulting
    summary. *Add the examples back* is the one exception: it opens nothing
    and downloads nothing, the server adds its own bundled files again, and
    the dialog stays open on its tab, focus on the tab, saying what came back.
    The GHE limitation is explained inline on the URL tab.

    While a load runs (load-progress 5.2 to 5.4) a status stands under the
    control it started from -- the drop area, the address box, or the
    suggested entry's row -- saying which step it is on (loadWords.ts): the
    bytes sent, with a bar that has a value, then the seconds while it is
    read or downloaded, with a bar that has none. Its Cancel aborts the
    request and asks the server to throw the result away, then says whether
    it was in time, and focus goes back to where the load started. The ✕,
    Escape and a click outside do the same and close; nothing opens after
    the dialog has gone. Every answer is applied only while its load is
    still the current one. A live region speaks each step once, never the
    seconds.

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
      and "Load from a URL" land on the right one. Defaults to "suggested",
      which is how the Load button in the header still opens it.
    - examplesMissing / onExamplesRestored: how many bundled examples are
      not in the library, and what to do with the library the restore
      answers; with none missing, or no handler, the button is absent.
    - onLibraryChanged: a cancelled load had already finished, so the
      library has a new entry to read.
    - project: the open project, which adds the Data tab; startImport opens
      it with the wizard started; onValidate and onShowData are the import
      report's next steps.
    Plus CatalogueList and the api upload/fetch functions.

EXPECTED OUTPUT
    - The rendered modal; on success, a loaded ontology reported via onLoaded.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelLoad,
  fetchOntology,
  restoreExamples,
  uploadOntology,
  type ExamplesRestored,
  type LoadOptions,
} from "../api";
import type { CatalogueEntry } from "../catalogue";
import {
  STOPPED,
  TOO_LATE,
  newLoadId,
  stepAnnouncement,
  stepSentence,
  type LoadStep,
} from "../loadWords";
import CatalogueList from "./CatalogueList";
import DataWizard, { type WizardStart } from "./DataWizard";
import SnapshotList from "./SnapshotList";
import { wrapTab } from "./useDialogTrap";
import type { OntologySummary } from "../types";

export type LoadTab = "file" | "url" | "suggested" | "data";

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
  /** Bundled examples not in the library (home-and-examples 5.8). */
  examplesMissing?: number;
  onExamplesRestored?: (result: ExamplesRestored) => void;
  /** A cancelled load had already finished: the library has a new entry. */
  onLibraryChanged?: () => void;
}

/** Where a load started: the status stands there, and focus goes back there. */
type LoadOrigin = { tab: "file" } | { tab: "url" } | { tab: "suggested"; entryId: string };

function sameOrigin(a: LoadOrigin, b: LoadOrigin): boolean {
  return a.tab === b.tab && (a.tab !== "suggested" || a.entryId === (b as { entryId: string }).entryId);
}

/** The load running now. `size` is a file's; null for a web address. */
interface LoadRun {
  id: string;
  origin: LoadOrigin;
  controller: AbortController;
  started: number;
  name: string;
  size: number | null;
  sending: boolean;
  sent: number;
  total: number;
}

/** What went wrong, and for a file no parser read, the parsers' own text. */
interface LoadError {
  message: string;
  technical: string | null;
}

/** A failed load's `parse_error` carries the raw text apart from its
 *  sentence (load-and-shapes 5.1); anything else is its message alone. */
function loadError(e: unknown): LoadError {
  const message = e instanceof Error ? e.message : String(e);
  const detail = e instanceof ApiError ? e.detail : null;
  if (detail && typeof detail === "object") {
    const { code, technical } = detail as { code?: unknown; technical?: unknown };
    if (code === "parse_error" && typeof technical === "string" && technical) return { message, technical };
  }
  return { message, technical: null };
}

export default function LoadDialog({
  onLoaded,
  onClose,
  initialTab = "suggested",
  project = null,
  startImport = false,
  onValidate,
  onShowData,
  examplesMissing = 0,
  onExamplesRestored,
  onLibraryChanged,
}: Props) {
  const [tab, setTab] = useState<LoadTab>(initialTab === "data" && !project ? "suggested" : initialTab);
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
  // The examples' restore; a load's own busy state is `run`.
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  // The load running now (load-progress 5.2, 5.3). The ref is its identity:
  // an answer, a progress event or a failure is applied only while its load
  // is still the current one, so a cancelled load never opens and never
  // shows an error. The state is what the status draws.
  const runRef = useRef<LoadRun | null>(null);
  const [run, setRun] = useState<LoadRun | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // What a Cancel ended with, standing where the load started.
  const [ended, setEnded] = useState<{ origin: LoadOrigin; text: string } | null>(null);
  const busy = run !== null || restoring;

  // The seconds tick while a load runs; only the visible sentence reads them.
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runId]);

  const startLoad = async (
    origin: LoadOrigin,
    name: string,
    size: number | null,
    request: (options: LoadOptions) => Promise<OntologySummary>,
  ) => {
    if (runRef.current) return;
    const fresh: LoadRun = {
      id: newLoadId(),
      origin,
      controller: new AbortController(),
      started: Date.now(),
      name,
      size,
      sending: size !== null,
      sent: 0,
      total: size ?? 0,
    };
    runRef.current = fresh;
    setRun(fresh);
    setNow(fresh.started);
    setEnded(null);
    setError(null);
    const mine = () => runRef.current?.id === fresh.id;
    try {
      const summary = await request({
        loadId: fresh.id,
        signal: fresh.controller.signal,
        onSent: (sent, total) => {
          if (!mine()) return;
          // On the ref's own object too: Cancel reads `sending` there, and a
          // file all sent may have reached the server whole.
          Object.assign(fresh, { sent, total, sending: sent < total });
          setRun({ ...fresh });
        },
      });
      if (!mine()) return;
      runRef.current = null;
      setRun(null);
      onLoaded(summary);
    } catch (e: unknown) {
      if (!mine()) return;
      runRef.current = null;
      setRun(null);
      setError(loadError(e));
    }
  };

  const focusOrigin = (origin: LoadOrigin) => {
    const target =
      origin.tab === "file"
        ? dropzoneRef.current
        : origin.tab === "url"
          ? urlInput.current
          : [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])].find(
              (row) => row.dataset.entry === origin.entryId,
            );
    // On another tab than the one it started from, the control is gone.
    (target ?? headingRef.current)?.focus();
  };

  // Cancel, and every way of closing while a load runs (5.3, Section 15).
  // The request is aborted at once, so the dialog stops waiting; the server
  // is asked to throw the result away and says whether it was in time. A
  // file still being sent never reached the server whole, so it is stopped
  // whatever the answer. Closing shows no answer, the dialog being gone, but
  // a load that was too late still refreshes the library; nothing opens.
  const mounted = useRef(true);
  const cancelRun = (closing: boolean) => {
    const current = runRef.current;
    if (!current) return;
    runRef.current = null;
    current.controller.abort();
    setRun(null);
    if (!closing) focusOrigin(current.origin);
    const show = (text: string) => {
      if (!closing && mounted.current && !runRef.current) setEnded({ origin: current.origin, text });
    };
    cancelLoad(current.id).then(
      ({ stopped }) => {
        const inTime = stopped || current.sending;
        if (!inTime) onLibraryChanged?.();
        show(inTime ? STOPPED : TOO_LATE);
      },
      (e: unknown) => {
        // Not knowing is said as such; the library is read again either way.
        onLibraryChanged?.();
        if (!closing && mounted.current && !runRef.current) setError(loadError(e));
      },
    );
  };
  const cancelOnUnmount = useRef(cancelRun);
  cancelOnUnmount.current = cancelRun;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelOnUnmount.current(true);
    };
  }, []);

  const close = () => {
    cancelRun(true);
    onClose();
  };

  const step: LoadStep | null = run
    ? run.size === null
      ? { kind: "downloading", elapsed: Math.max(0, Math.floor((now - run.started) / 1000)) }
      : run.sending
        ? { kind: "sending", name: run.name, sent: run.sent, total: run.total }
        : {
            kind: "reading",
            name: run.name,
            size: run.size,
            elapsed: Math.max(0, Math.floor((now - run.started) / 1000)),
          }
    : null;

  // The status under the control a load started from: the step, its bar and
  // Cancel while it runs; what a Cancel ended with after. Not live: the
  // live region below speaks the step once, and never the seconds.
  const statusAt = (origin: LoadOrigin) => {
    if (run && step && sameOrigin(run.origin, origin)) {
      const share = step.kind === "sending" && step.total > 0 ? Math.min(100, Math.round((step.sent / step.total) * 100)) : null;
      return (
        <div className="load-status">
          <p className="load-step">{stepSentence(step)}</p>
          {share !== null ? (
            <div
              className="load-bar"
              role="progressbar"
              aria-label="Sending the file"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={share}
            >
              <div className="load-bar-fill" style={{ width: `${share}%` }} />
            </div>
          ) : (
            <div className="load-bar moving" role="progressbar" aria-label={step.kind === "downloading" ? "Downloading and reading" : "Reading the file"}>
              <div className="load-bar-fill" />
            </div>
          )}
          <button type="button" onClick={() => cancelRun(false)}>
            Cancel
          </button>
        </div>
      );
    }
    if (ended && !run && sameOrigin(ended.origin, origin)) {
      return (
        <div className="load-status">
          <p className="load-step">{ended.text}</p>
        </div>
      );
    }
    return null;
  };
  const announcement = step ? stepAnnouncement(step) : (ended?.text ?? "");
  const suggestedOrigin =
    run?.origin.tab === "suggested" ? run.origin : ended?.origin.tab === "suggested" ? ended.origin : null;
  // The Suggested tab, where focus goes once the examples are back: the
  // button that was pressed goes with them, and focus would fall to the page.
  const suggestedTab = useRef<HTMLButtonElement>(null);
  const [restoredNote, setRestoredNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Into the dialog on open, unless a control in it took focus already (the
  // URL field's autoFocus); back to whatever opened it on close -- the
  // header's Load, Home's two buttons, the project's data button -- if it is
  // still in the document (load-and-shapes 5.2). Taken at the first render,
  // not in the effect: by then the URL field's autoFocus and the wizard's own
  // effect have already moved focus into the dialog.
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

  const loadSuggested = (entry: CatalogueEntry) =>
    startLoad({ tab: "suggested", entryId: entry.id }, entry.name, null, (options) =>
      fetchOntology(entry.url, options),
    );

  const addExamplesBack = async () => {
    if (!onExamplesRestored) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreExamples();
      const names = result.ontologies
        .filter((o) => result.restored.includes(o.id))
        .map((o) => o.name);
      onExamplesRestored(result);
      setRestoredNote(names.length ? `Added back: ${names.join(", ")}.` : "The examples are all in your library.");
      suggestedTab.current?.focus();
    } catch (e: unknown) {
      setError(loadError(e));
    } finally {
      setRestoring(false);
    }
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
          <button
            ref={suggestedTab}
            className={tab === "suggested" ? "tab active" : "tab"}
            onClick={() => switchTab("suggested")}
          >
            Suggested
          </button>
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

        {tab === "suggested" && (
          <>
            {/* Above the list, and only while an example is missing: the
                only way one comes back (home-and-examples 5.1, 5.8). A
                secondary button; nothing is downloaded. */}
            {examplesMissing > 0 && onExamplesRestored && (
              <div className="examples-restore">
                {/* aria-disabled, never disabled, while it works: a disabled
                    button drops focus, and a failure would leave it on the
                    page (load-and-shapes 5.6). */}
                <button type="button" aria-disabled={busy} onClick={() => !busy && void addExamplesBack()}>
                  Add the examples back
                </button>
              </div>
            )}
            {/* Rendered whether or not it has anything to say: a live region
                added with its text is unreliably announced. */}
            <p className="hint examples-restored" role="status">
              {restoredNote}
            </p>
            <p className="hint">
              Well-known public ontologies — nothing is downloaded until you pick one.
            </p>
            {/* CatalogueList, a component of its own since Home and this tab
                both showed it; this tab is its one caller now. */}
            <CatalogueList
              fetchingId={run?.origin.tab === "suggested" ? run.origin.entryId : null}
              busy={busy}
              onPick={(entry) => void loadSuggested(entry)}
              status={suggestedOrigin && statusAt(suggestedOrigin)}
              statusId={suggestedOrigin?.entryId ?? null}
            />
          </>
        )}

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
        {error && (
          <div className="load-error">
            <p className="detail-error">{error.message}</p>
            {/* Closed by default; the parsers' text is text, never markup. */}
            {error.technical && (
              <details className="technical-details">
                <summary>Technical details</summary>
                <pre>{error.technical}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
