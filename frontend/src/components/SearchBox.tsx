/*
================================================================================
FILE: frontend/src/components/SearchBox.tsx
================================================================================

SUMMARY
    The header search box. Debounced type-ahead over the loaded ontology's
    nodes; picking a result calls onPick (which centres the graph on it, and in
    Query mode also adds it to the path).

BASIC IDEA
    On each keystroke (debounced, min 2 chars) it queries /search and shows a
    dropdown. A document mousedown listener closes the dropdown on outside
    click. The placeholder changes in Query mode to signal that picking adds a
    step.

    A text input with a list beneath it is a combobox, and since 2026-07-31 it
    says so: the input carries role="combobox" with aria-expanded and
    aria-activedescendant, and the list is a listbox of options with stable ids.
    Up and Down move the ACTIVE option without moving focus, which is the one
    place in this application where a roving aria-activedescendant is used
    rather than real focus — focus has to stay in the field or typing stops
    working. Enter picks the active option; Escape closes the list and leaves
    the typed text alone.

    Search covers the whole ontology while the graph draws only the highest-
    degree nodes the server's budget allows, so a result is regularly an entity
    that is not on the canvas. Those rows say so: picking one draws it and opens
    its detail panel, and silence there would read as the application ignoring
    the click.

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology to search (disabled when null).
    - theme: for the result swatches.
    - onPick: called with the chosen node's IRI.
    - drawnIds: the entities currently on the canvas, or null when unknown.
    - placeholder: prompt text (differs per mode).

EXPECTED OUTPUT
    - The rendered search box and dropdown; onPick on selection.
    - A polite announcement of how many results a completed search found.
================================================================================
*/

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { searchNodes } from "../api";
import type { Theme, VizNode } from "../types";
import { KIND_LABELS, kindColor } from "../types";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  onPick: (iri: string) => void;
  /** Entities on the canvas. null while no graph is loaded: mark nothing then. */
  drawnIds?: Set<string> | null;
  placeholder?: string;
}

/** The listbox's id, and the stem every option id is built from. Constants
 *  because aria-controls and aria-activedescendant are references: they have to
 *  name the exact same strings the elements carry. */
const LIST_ID = "search-results-list";
const optionId = (index: number) => `search-result-${index}`;

export default function SearchBox({
  ontologyId,
  theme,
  onPick,
  drawnIds = null,
  placeholder = "Search concepts, properties…",
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VizNode[]>([]);
  const [open, setOpen] = useState(false);
  // Which option the arrow keys have moved to, as an index into `results`.
  // -1 means "none active", which is the state every fresh set of results
  // starts in: pre-selecting the first row would make Enter pick something the
  // user never chose.
  const [active, setActive] = useState(-1);
  // What the polite region says. Set only when a search COMPLETES, so it never
  // announces a count for a query the user is still in the middle of typing.
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!ontologyId || query.trim().length < 2) {
      setResults([]);
      setActive(-1);
      setAnnouncement("");
      return;
    }
    timer.current = window.setTimeout(() => {
      searchNodes(ontologyId, query)
        .then((r) => {
          setResults(r);
          setActive(-1);
          setOpen(true);
          setAnnouncement(
            r.length === 0 ? "No results" : r.length === 1 ? "1 result" : `${r.length} results`,
          );
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

  const expanded = open && results.length > 0;

  // Keep the active option on screen. The list is bounded at 50vh and scrolls,
  // so arrowing past the fold moves an aria-activedescendant nobody can see —
  // which for a sighted keyboard user is the whole affordance gone. `?.` on the
  // method as well as the element: jsdom does not implement scrollIntoView at
  // all, and this is a convenience rather than something to guard the app on.
  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const pick = (iri: string) => {
    onPick(iri);
    setOpen(false);
    setActive(-1);
  };

  /**
   * The keyboard half of the combobox.
   *
   * Every branch calls preventDefault for a reason worth stating: Up and Down
   * would otherwise move the caret to the ends of the text, and Enter in a
   * type="search" input submits and clears it in some browsers. Escape does not
   * call it — a native search input clears itself on Escape, and the
   * specification asks for the typed text to survive, so the handler stops the
   * list instead and lets a second Escape do whatever the browser does.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
      return;
    }
    if (!expanded) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      // Only when an option is active. With none, Enter belongs to the input.
      if (active >= 0 && active < results.length) {
        e.preventDefault();
        pick(results[active].id);
      }
    }
  };

  return (
    <div className="search-box" ref={wrapRef}>
      <input
        type="search"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        value={query}
        disabled={!ontologyId}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {/* Rendered whether or not it has anything to say. A live region added to
          the DOM in the same commit as its text is unreliably announced — the
          same finding HomeScreen and App's notice region both record. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {expanded && (
        <ul className="search-results" id={LIST_ID} role="listbox" aria-label="Search results">
          {results.map((r, index) => {
            const notDrawn = drawnIds !== null && !drawnIds.has(r.id);
            return (
              <li
                key={r.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={index === active ? "active" : undefined}
                onClick={() => pick(r.id)}
              >
                <span className="dot" style={{ background: kindColor(r.kind, theme) }} />
                <span className="result-label">{r.label}</span>
                {/* Words, not a colour or an opacity: the fact that an entity is
                    off the canvas has to survive being read aloud. */}
                {notDrawn && (
                  <span
                    className="result-undrawn"
                    title="This entity is outside the drawn part of the graph"
                  >
                    not drawn
                  </span>
                )}
                <span className="result-kind">{KIND_LABELS[r.kind] ?? r.kind}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
