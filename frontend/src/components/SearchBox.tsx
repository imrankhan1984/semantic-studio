import { useEffect, useRef, useState } from "react";
import { searchNodes } from "../api";
import type { Theme, VizNode } from "../types";
import { KIND_LABELS, kindColor } from "../types";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  onPick: (iri: string) => void;
  placeholder?: string;
}

export default function SearchBox({
  ontologyId,
  theme,
  onPick,
  placeholder = "Search concepts, properties…",
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VizNode[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!ontologyId || query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      searchNodes(ontologyId, query)
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 200);
  }, [query, ontologyId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="search-box" ref={wrapRef}>
      <input
        type="search"
        placeholder={placeholder}
        value={query}
        disabled={!ontologyId}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((r) => (
            <li
              key={r.id}
              onClick={() => {
                onPick(r.id);
                setOpen(false);
              }}
            >
              <span className="dot" style={{ background: kindColor(r.kind, theme) }} />
              <span className="result-label">{r.label}</span>
              <span className="result-kind">{KIND_LABELS[r.kind] ?? r.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
