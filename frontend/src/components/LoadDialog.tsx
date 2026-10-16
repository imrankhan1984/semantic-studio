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
    the dialog stays open on its tab, focus on the tab, saying what came back. Busy/error state gives feedback while a large file downloads or
    parses. The GHE limitation is explained inline on the URL tab.

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
    labelled by its heading. Escape is the ✕, asking first past the
    wizard's third step, and closing gives focus back to what opened it.

INPUTS / INPUT SOURCES (props)
    - onLoaded: called with the new ontology's summary on success.
    - onClose: dismiss the dialog.
    - initialTab: which tab to open on, so the home screen's "Open a file"
      and "Load from a URL" land on the right one. Defaults to "suggested",
      which is how the Load button in the header still opens it.
    - examplesMissing / onExamplesRestored: how many bundled examples are
      not in the library, and what to do with the library the restore
      answers; with none missing, or no handler, the button is absent.
    - project: the open project, which adds the Data tab; startImport opens
      it with the wizard started; onValidate and onShowData are the import
      report's next steps.
    Plus CatalogueList and the api upload/fetch functions.

EXPECTED OUTPUT
    - The rendered modal; on success, a loaded ontology reported via onLoaded.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { ApiError, fetchOntology, restoreExamples, uploadOntology, type ExamplesRestored } from "../api";
import type { CatalogueEntry } from "../catalogue";
import CatalogueList from "./CatalogueList";
import DataWizard, { type WizardStart } from "./DataWizard";
import SnapshotList from "./SnapshotList";
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
  const [fetching, setFetching] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The Suggested tab, where focus goes once the examples are back: the
  // button that was pressed goes with them, and focus would fall to the page.
  const suggestedTab = useRef<HTMLButtonElement>(null);
  const [restoredNote, setRestoredNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Into the dialog on open, unless a control in it took focus already (the
  // URL field's autoFocus); back to whatever opened it on close -- the
  // header's Load, Home's two buttons, the project's data button -- if it is
  // still in the document (load-and-shapes 5.2). Taken in the effect body,
  // before any child moves focus; mount and unmount only.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (!panelRef.current?.contains(document.activeElement)) headingRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, []);
  const [dragOver, setDragOver] = useState(false);

  const submitFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      onLoaded(await uploadOntology(file));
    } catch (e: unknown) {
      setError(loadError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onLoaded(await fetchOntology(url.trim()));
    } catch (e: unknown) {
      setError(loadError(e));
    } finally {
      setBusy(false);
    }
  };

  const loadSuggested = async (entry: CatalogueEntry) => {
    setBusy(true);
    setFetching(entry.id);
    setError(null);
    try {
      onLoaded(await fetchOntology(entry.url));
    } catch (e: unknown) {
      setError(loadError(e));
    } finally {
      setBusy(false);
      setFetching(null);
    }
  };

  const addExamplesBack = async () => {
    if (!onExamplesRestored) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  // Escape is the ✕: it asks first while the wizard has a mapping, and with
  // the question showing it keeps going. On `document`, as useDialogTrap's
  // is, since a click on the dialog's prose blurs focus to <body>; a key
  // pressed in another dialog over this one (an approval) is that dialog's.
  const onEscape = useRef<() => void>(() => {});
  onEscape.current = () => {
    if (leaving) setLeaving(null);
    else guard(onClose);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as Node | null;
      if (target && target !== document.body && !panelRef.current?.contains(target)) return;
      e.preventDefault();
      onEscape.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const title = tab === "data" && project ? `Data for ${project.name}` : "Load ontology";

  return (
    // A click outside does not drop a wizard half way: Cancel does, and asks.
    <div className="modal-backdrop" onClick={() => !(tab === "data" && wizard) && onClose()}>
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
          <button className="icon-btn" onClick={() => guard(onClose)} title="Close" aria-label="Close">
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
                <button type="button" disabled={busy} onClick={() => void addExamplesBack()}>
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
              fetchingId={fetching}
              busy={busy}
              onPick={(entry) => void loadSuggested(entry)}
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
              if (file) void submitFile(file);
            }}
            onClick={() => fileInput.current?.click()}
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

        {tab === "url" && (
          <div className="url-form">
            <input
              type="text"
              placeholder="https://github.com/owner/repo/blob/main/ontology.ttl or any raw RDF URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitUrl()}
              autoFocus
            />
            <button className="primary" onClick={() => void submitUrl()} disabled={busy || !url.trim()}>
              Fetch
            </button>
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

        {busy && <p className="detail-note">Parsing ontology…</p>}
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
