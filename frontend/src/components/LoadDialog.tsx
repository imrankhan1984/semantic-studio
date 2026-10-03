/*
================================================================================
FILE: frontend/src/components/LoadDialog.tsx
================================================================================

SUMMARY
    The modal for adding an ontology, with three tabs: Suggested (the built-in
    catalogue), Local file (drag/drop or picker), and URL / GitHub. While a
    project is open it is also the project's Load area, with a fourth tab,
    Data (csv-data-import 5.1, 5.7): the project's snapshots and the import
    wizard.

BASIC IDEA
    Each tab is a different way to obtain an ontology; all three end by calling
    uploadOntology or fetchOntology and then onLoaded with the resulting
    summary. Busy/error state gives feedback while a large file downloads or
    parses. The GHE limitation is explained inline on the URL tab.

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

INPUTS / INPUT SOURCES (props)
    - onLoaded: called with the new ontology's summary on success.
    - onClose: dismiss the dialog.
    - initialTab: which tab to open on, so the home screen's "Open a file"
      and "Load from a URL" land on the right one. Defaults to "suggested",
      which is how the Load button in the header still opens it.
    - project: the open project, which adds the Data tab; startImport opens
      it with the wizard started; onValidate and onShowData are the import
      report's next steps.
    Plus CatalogueList and the api upload/fetch functions.

EXPECTED OUTPUT
    - The rendered modal; on success, a loaded ontology reported via onLoaded.
================================================================================
*/

import { useRef, useState } from "react";
import { fetchOntology, uploadOntology } from "../api";
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
}

export default function LoadDialog({
  onLoaded,
  onClose,
  initialTab = "suggested",
  project = null,
  startImport = false,
  onValidate,
  onShowData,
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
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const submitFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      onLoaded(await uploadOntology(file));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setFetching(null);
    }
  };

  return (
    // A click outside does not drop a wizard half way: Cancel does, and asks.
    <div className="modal-backdrop" onClick={() => !(tab === "data" && wizard) && onClose()}>
      <div className={tab === "data" ? "modal modal-wide" : "modal"} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tab === "data" && project ? `Data for ${project.name}` : "Load ontology"}</h2>
          <button className="icon-btn" onClick={() => guard(onClose)} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs">
          <button
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
            <p className="hint">
              Well-known public ontologies — nothing is downloaded until you pick one.
            </p>
            {/* The same component the home screen renders. Two copies of this
                markup would drift the moment either screen's wording or the
                catalogue's order changed. */}
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
        {error && <p className="detail-error">{error}</p>}
      </div>
    </div>
  );
}
