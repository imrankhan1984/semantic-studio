import { useRef, useState } from "react";
import { fetchOntology, uploadOntology } from "../api";
import type { OntologySummary } from "../types";

interface Props {
  onLoaded: (summary: OntologySummary) => void;
  onClose: () => void;
}

export default function LoadDialog({ onLoaded, onClose }: Props) {
  const [tab, setTab] = useState<"file" | "url">("file");
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Load ontology</h2>
          <button className="icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="tabs">
          <button className={tab === "file" ? "tab active" : "tab"} onClick={() => setTab("file")}>
            Local file
          </button>
          <button className={tab === "url" ? "tab active" : "tab"} onClick={() => setTab("url")}>
            URL / GitHub
          </button>
        </div>

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
              GitHub “blob” links are converted to raw file URLs automatically. Public repositories only.
            </p>
          </div>
        )}

        {busy && <p className="detail-note">Parsing ontology…</p>}
        {error && <p className="detail-error">{error}</p>}
      </div>
    </div>
  );
}
