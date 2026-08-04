/*
================================================================================
FILE: frontend/src/components/LoadDialog.tsx
================================================================================

SUMMARY
    The modal for adding an ontology, with three tabs: Suggested (the built-in
    catalogue), Local file (drag/drop or picker), and URL / GitHub.

BASIC IDEA
    Each tab is a different way to obtain an ontology; all three end by calling
    uploadOntology or fetchOntology and then onLoaded with the resulting
    summary. Busy/error state gives feedback while a large file downloads or
    parses. The GHE limitation is explained inline on the URL tab.

INPUTS / INPUT SOURCES (props)
    - onLoaded: called with the new ontology's summary on success.
    - onClose: dismiss the dialog.
    - initialTab: which tab to open on, so the home screen's "Open a file"
      and "Load from a URL" land on the right one. Defaults to "suggested",
      which is how the Load button in the header still opens it.
    Plus CatalogueList and the api upload/fetch functions.

EXPECTED OUTPUT
    - The rendered modal; on success, a loaded ontology reported via onLoaded.
================================================================================
*/

import { useRef, useState } from "react";
import { fetchOntology, uploadOntology } from "../api";
import type { CatalogueEntry } from "../catalogue";
import CatalogueList from "./CatalogueList";
import type { OntologySummary } from "../types";

type Tab = "file" | "url" | "suggested";

interface Props {
  onLoaded: (summary: OntologySummary) => void;
  onClose: () => void;
  initialTab?: Tab;
}

export default function LoadDialog({ onLoaded, onClose, initialTab = "suggested" }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Load ontology</h2>
          <button className="icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="tabs">
          <button
            className={tab === "suggested" ? "tab active" : "tab"}
            onClick={() => setTab("suggested")}
          >
            Suggested
          </button>
          <button className={tab === "file" ? "tab active" : "tab"} onClick={() => setTab("file")}>
            Local file
          </button>
          <button className={tab === "url" ? "tab active" : "tab"} onClick={() => setTab("url")}>
            URL / GitHub
          </button>
        </div>

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
