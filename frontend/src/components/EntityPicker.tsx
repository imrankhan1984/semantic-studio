/*
================================================================================
FILE: frontend/src/components/EntityPicker.tsx
================================================================================

SUMMARY
    A search field that picks one class, property or concept (visual-modeling
    5.1): the parent of a class, the range of a relationship, a broader
    concept. Matches come from the document and its resolved imports, one kind
    only, and an imported match says so in text ("Person, from FOAF").

BASIC IDEA
    The WAI-ARIA combobox pattern with a listbox popup: the input keeps focus
    throughout, the arrow keys move an active option announced through
    aria-activedescendant, Enter picks it, Escape closes the list and then
    cancels. Search is the existing endpoint with the new `kind` filter,
    which is applied before its limit so twenty-five properties never crowd
    out the one class wanted. The merged view is always asked for: without
    resolved imports it is the document itself.

    Typing waits a moment before asking, and a stale answer is dropped when a
    newer question has been sent, so a fast typist sees the list for what is
    in the field now.

INPUTS / INPUT SOURCES (props)
    - ontologyId, kind: where to search and for what.
    - label: the field's accessible name ("Parent class").
    - exclude: IRIs not to offer (the entity itself, parents it already has).
    - onPick(iri, label), onCancel.
    - error: the server's sentence when the pick was refused.

EXPECTED OUTPUT
    - The field and its list; onPick once per choice.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { searchNodes } from "../api";
import type { SearchKind, VizNode } from "../types";

interface Props {
  ontologyId: string;
  kind: SearchKind;
  label: string;
  exclude?: string[];
  busy?: boolean;
  error?: string | null;
  onPick: (iri: string, label: string) => void;
  onCancel: () => void;
}

/** How long typing rests before a search is sent. */
const DEBOUNCE_MS = 150;

export default function EntityPicker({
  ontologyId,
  kind,
  label,
  exclude = [],
  busy = false,
  error = null,
  onPick,
  onCancel,
}: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VizNode[]>([]);
  const [active, setActive] = useState(-1);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActive(-1);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchNodes(ontologyId, q, true, kind)
        .then((found) => {
          if (cancelled) return;
          const shown = found.filter((n) => !exclude.includes(n.id));
          setResults(shown);
          setActive(shown.length ? 0 : -1);
          setSearchError(null);
        })
        .catch((e: unknown) => !cancelled && setSearchError(e instanceof Error ? e.message : String(e)));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // exclude is a fresh array on every render of the caller; its content is
    // what matters and it only changes with the entity, which remounts this.
  }, [query, ontologyId, kind]);

  const open = results.length > 0;
  const pick = (node: VizNode) => {
    if (!busy) onPick(node.id, node.label);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0) pick(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (open) {
        setResults([]);
        setActive(-1);
      } else {
        onCancel();
      }
    }
  };

  const errorId = `${id}-error`;
  const shownError = error ?? searchError;
  return (
    <div className="entity-picker">
      <label htmlFor={`${id}-input`} className="edit-field-label">
        {label}
      </label>
      <div className="entity-picker-row">
        <input
          id={`${id}-input`}
          ref={inputRef}
          type="search"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={shownError ? errorId : undefined}
          aria-invalid={shownError ? true : undefined}
          readOnly={busy}
          placeholder="Type to search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label={label} className="entity-picker-list" hidden={!open}>
        {results.map((node, i) => (
          <li
            key={node.id}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? "active" : undefined}
            // mousedown, not click: a click would blur the input first.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(node);
            }}
          >
            {node.label}
            {node.importedFrom && <span className="entity-picker-from">, from {node.importedFrom}</span>}
          </li>
        ))}
      </ul>
      {query.trim() && !open && !searchError && (
        <p className="detail-note" role="status">
          No match yet.
        </p>
      )}
      {shownError && (
        <p id={errorId} className="edit-error">
          {shownError}
        </p>
      )}
    </div>
  );
}
