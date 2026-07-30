/*
================================================================================
FILE: frontend/src/components/NextSteps.tsx
================================================================================

SUMMARY
    The "Add a step" control in the query panel: every possible continuation of
    the current path. Above three options it is a closed disclosure showing a
    count, which opens a bounded, filterable, scrolling panel of chips. At three
    or fewer it is a plain open list, so a short list still teaches.

BASIC IDEA
    Hunting for the right node in a large graph is impractical, so the panel
    offers the same moves the graph does. This is presentational over the
    options computed by the hook; clicking a chip calls onAdd, which appends
    that step — so a whole query can be built without touching the graph.

    It is closed by default because it was costing the panel most of its
    vertical height before the SPARQL preview began, which pushed the query
    text the user was building below the fold. The three-or-fewer rule is the
    learner concession: a handful of legal continuations costs almost nothing
    to show, and showing them is how the builder teaches.

INPUTS / INPUT SOURCES (props)
    - options: every available continuation (from the hook).
    - stepCount: used to decide whether to show the anchor number.
    - onAdd: append the chosen continuation.

EXPECTED OUTPUT
    - The rendered control, closed or open; onAdd on click.
================================================================================
*/

import { useEffect, useId, useMemo, useRef, useState } from "react";

// One available continuation of the path (an anchor step + a predicate + a target).
export interface NextStepOption {
  anchor: number;
  anchorLabel: string;
  predicate: string;
  predicateLabel: string;
  inverse: boolean;
  targetClass: string;
  targetLabel: string;
  count: number;
  declared: boolean;
}

interface Props {
  options: NextStepOption[];
  stepCount: number;
  onAdd: (option: NextStepOption) => void;
}

/**
 * At or below this many options the list is rendered open, with no filter and
 * no disclosure control. Short lists cost almost no vertical space, and a
 * newcomer building a first query is usually at a point in the schema with a
 * handful of continuations — so in practice they keep seeing what is possible
 * without having to ask for it.
 */
const ALWAYS_OPEN_MAX = 3;

/**
 * Every way the path can continue, listed as chips. Hunting for the right
 * node in a large graph is impractical, so the panel offers the same moves
 * the graph does — the two routes build exactly the same query.
 */
export default function NextSteps({ options, stepCount, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const panelId = useId();
  const controlRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) =>
        o.targetLabel.toLowerCase().includes(needle) ||
        o.predicateLabel.toLowerCase().includes(needle),
    );
  }, [options, filter]);

  // The filter is what the user opened the panel to use.
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  // A step added from the graph or from search changes what is legal next, so
  // an open list is showing options computed for a path that no longer exists.
  // Close it rather than invite a wrong click.
  useEffect(() => {
    setOpen(false);
  }, [options]);

  if (options.length === 0) return null;

  const chipFor = (option: NextStepOption) => (
    <button
      key={`${option.anchor}|${option.predicate}|${option.inverse}|${option.targetClass}`}
      className="chip next-chip"
      onClick={() => {
        onAdd(option);
        // A step is a single choice that changes what the next legal options
        // are. Staying open would leave a stale list on screen, so closing
        // here is correctness rather than convenience.
        setOpen(false);
        controlRef.current?.focus();
      }}
      title={
        `From step ${option.anchor + 1} (${option.anchorLabel}) via ` +
        `${option.inverse ? "reversed " : ""}${option.predicateLabel}` +
        (option.count > 0 ? ` · ${option.count.toLocaleString()} in the data` : "")
      }
    >
      {stepCount > 1 && <span className="next-anchor">{option.anchor + 1}</span>}
      <span className="next-pred">
        {option.inverse && <span className="dir-badge">^</span>}
        {option.predicateLabel}
      </span>
      <span className="next-arrow">→</span>
      <span className="next-target">{option.targetLabel}</span>
    </button>
  );

  if (options.length <= ALWAYS_OPEN_MAX) {
    return (
      <section className="next-steps">
        <div className="next-steps-head">
          <h3>Add a step</h3>
        </div>
        <div className="chip-cloud">{options.map(chipFor)}</div>
      </section>
    );
  }

  return (
    <section
      className="next-steps"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        setOpen(false);
        controlRef.current?.focus();
      }}
    >
      <button
        ref={controlRef}
        className="next-steps-toggle"
        // aria-expanded and aria-controls are what make this legible as a
        // disclosure. Without the pair it is a button that changes the page
        // for no announced reason.
        aria-expanded={open}
        aria-controls={panelId}
        // An explicit name rather than one computed from the contents, and it
        // is not belt-and-braces. Measured 2026-07-31: with a `title` on this
        // button an inspection tool announced the title instead of the
        // contents, and with the title removed it announced nothing at all.
        // The count is an acceptance criterion, so it is stated outright and
        // matches the visible text word for word.
        aria-label={`Add a step, ${options.length} options`}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">+</span>
        <span className="next-steps-label">Add a step</span>
        {/* In the accessible name, not only in the pixels: a count a screen
            reader user cannot hear is a count they do not have. */}
        <span className="next-steps-count">{options.length} options</span>
        <span className="next-steps-arrow" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {/* The panel element exists whether or not it is open, so aria-controls
          always names something real. Its contents do not: an option row that
          nobody can see should not be in the document. */}
      <div className="next-steps-panel" id={panelId} hidden={!open}>
        {open && (
          <>
            <input
              ref={filterRef}
              type="search"
              className="next-filter"
              placeholder="Filter…"
              aria-label="Filter the available steps"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="chip-cloud">{matching.map(chipFor)}</div>
            {matching.length === 0 && (
              <p className="detail-note">Nothing matches “{filter}”.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
