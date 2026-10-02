/*
================================================================================
FILE: frontend/src/components/ResultPanels.tsx
================================================================================

SUMMARY
    Validation's results (shacl-authoring 5.6, 5.7): the Validate button,
    the line that says a result is stale, and one collapsible panel per
    shape -- red when it fails, green when it passes, amber for warnings
    only, grey when there was nothing to check, a red outline when the shape
    could not run -- each opening onto its problems as sentences, grouped by
    rule, with the individual's name as a link that selects it.

BASIC IDEA
    Shown in the Shapes view and under the Turtle editor of shapes.ttl,
    reading one result from the project store, so both places show the same
    check. Nothing validates on its own: only the button runs a check
    (D-094). While one runs the button reads *Validating…* and the previous
    panels stay, dimmed, until the new ones replace them. When the model or
    the shapes have moved past the revisions the result checked, a line
    above the panels says so.

    A panel's header carries a sign and a word as well as a colour, so
    colour is never the only signal (5.7), and it is a button with
    aria-expanded whose name includes the state word and the counts
    (Section 6). Panels start collapsed and only headers render until one
    opens, which is what keeps 50 shapes and 10,000 problems fast to paint
    (Section 10). The server sends at most 200 problems a panel and the true
    total, and the panel says *and 870 more*.

    A problem's name is a button: following it selects the individual and
    moves focus to its form (Section 6), which App arranges.

INPUTS / INPUT SOURCES (props)
    - onSelect(iri): follow a problem's link.
    Plus the project store: the result, whether a check is running, and the
    documents' revisions for the stale line.

EXPECTED OUTPUT
    - ValidateButton and ResultPanels.
================================================================================
*/

import { useEffect, useId, useMemo, useState } from "react";
import {
  STATE_SIGNS,
  STATE_WORDS,
  panelHeader,
  panelName,
} from "../modeling/shapeSentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ProjectDocumentState, ValidationPanel, ValidationResult } from "../types";

// A shape on every class or every concept checks the model itself, where an
// example is not what is missing.
const MODEL_TARGETS = new Set([
  "http://www.w3.org/2002/07/owl#Class",
  "http://www.w3.org/2000/01/rdf-schema#Class",
  "http://www.w3.org/2004/02/skos/core#Concept",
]);

/** A result is stale when either document has moved past what it checked. */
export function isStale(result: ValidationResult | null, documents: ProjectDocumentState[]): boolean {
  if (!result) return false;
  const rev = (doc: string) => documents.find((d) => d.doc === doc)?.revision ?? null;
  return rev("model") !== result.revisions.model || rev("shapes") !== result.revisions.shapes;
}

interface ButtonProps {
  onError: (message: string) => void;
  /** Why it cannot run now (the editor's text is not applied), or null. */
  blocked?: string | null;
}

/** The one way to validate (5.6). aria-disabled while a check runs, so the
 *  focus it holds is never dropped. Why it cannot run is said in text beside
 *  it and tied to it with aria-describedby: a tooltip alone reaches neither
 *  a keyboard nor a screen reader (Stage A follow-up 7). */
export function ValidateButton({ onError, blocked = null }: ButtonProps) {
  const validating = useProjectSelector((s) => s.validating);
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className="primary validate-btn"
        aria-disabled={validating || blocked !== null}
        aria-describedby={blocked !== null ? reasonId : undefined}
        title={blocked ?? "Check the model, unsaved changes included, against every shape"}
        onClick={() => {
          if (validating || blocked !== null) return;
          projectStore.validate().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
        }}
      >
        {validating ? "Validating…" : "Validate"}
      </button>
      {blocked !== null && (
        <span id={reasonId} className="detail-note validate-reason">
          {blocked}
        </span>
      )}
    </>
  );
}

interface Props {
  onSelect: (iri: string) => void;
}

export default function ResultPanels({ onSelect }: Props) {
  const result = useProjectSelector((s) => s.validation);
  const validating = useProjectSelector((s) => s.validating);
  const documents = useProjectSelector((s) => s.documents);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A new result starts collapsed again: the old one's open panels may be
  // other shapes now.
  useEffect(() => setOpen(new Set()), [result]);
  const stale = isStale(result, documents);

  if (!result) {
    return (
      <p className="detail-note results-empty">
        Nothing has been checked yet. Press Validate to check the model against every shape.
      </p>
    );
  }
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className={validating ? "result-panels busy" : "result-panels"} aria-busy={validating}>
      {stale && (
        <p className="results-stale">The model or the shapes changed since this check. Validate again.</p>
      )}
      {result.stopped ? (
        <p className="results-stopped" role="alert">
          The check took too long and was stopped. It was checking {result.shapeCount}{" "}
          {result.shapeCount === 1 ? "shape" : "shapes"} against {result.statements.toLocaleString()} statements.
        </p>
      ) : result.shapes.length === 0 ? (
        <p className="detail-note">There are no shapes to check yet.</p>
      ) : (
        <>
          <div className="results-toolbar">
            <button type="button" className="ghost" onClick={() => setOpen(new Set(result.shapes.map((p) => p.id)))}>
              Expand all
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(new Set())}>
              Collapse all
            </button>
          </div>
          <ul className="result-panel-list">
            {result.shapes.map((panel) => (
              <Panel
                key={panel.id}
                panel={panel}
                expanded={open.has(panel.id)}
                onToggle={() => toggle(panel.id)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface PanelProps {
  panel: ValidationPanel;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (iri: string) => void;
}

function Panel({ panel, expanded, onToggle, onSelect }: PanelProps) {
  const id = useId();
  return (
    <li className={`result-panel result-${panel.state}`}>
      <h4 className="result-panel-heading">
        <button
          type="button"
          className="result-panel-header"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          aria-label={panelName(panel)}
          onClick={onToggle}
        >
          <span className="result-sign" aria-hidden="true">
            {STATE_SIGNS[panel.state]}
          </span>
          <span className="result-word">{STATE_WORDS[panel.state]}</span>
          <span className="result-text">{panelHeader(panel)}</span>
        </button>
      </h4>
      <div id={`${id}-body`} className="result-panel-body" hidden={!expanded}>
        {expanded && <PanelBody panel={panel} onSelect={onSelect} />}
      </div>
    </li>
  );
}

function PanelBody({ panel, onSelect }: { panel: ValidationPanel; onSelect: (iri: string) => void }) {
  const groups = useMemo(() => {
    const out = new Map<string, ValidationPanel["problems"]>();
    for (const problem of panel.problems) {
      const list = out.get(problem.group) ?? [];
      list.push(problem);
      out.set(problem.group, list);
    }
    return [...out.entries()];
  }, [panel.problems]);
  if (panel.state === "error") {
    return (
      <p className="result-error-text">
        pySHACL could not check this shape: {panel.error}
      </p>
    );
  }
  if (panel.state === "nothing") {
    // Stage B made "add one" true: a class's form has *Add an example*
    // (5.8, follow-up 8). Concepts and every class are the model itself.
    const label = panel.target?.label ?? "match";
    const ofClass = panel.target !== null && !MODEL_TARGETS.has(panel.target.iri);
    return (
      <p className="detail-note">
        No {label} is in the data yet, so there is nothing to check.{" "}
        {ofClass
          ? `Add an example from the ${label} form, then validate again.`
          : "Add one, then validate again."}
      </p>
    );
  }
  if (panel.state === "passes") {
    return <p className="detail-note">Nothing breaks this shape's rules.</p>;
  }
  const more = panel.problemsTotal - panel.problems.length;
  return (
    <>
      {groups.map(([group, problems]) => (
        <section key={group} className="result-group">
          <h5>{group}</h5>
          <ul>
            {problems.map((p, i) => (
              <li key={`${p.focus}-${i}`} className={`result-problem severity-${p.severity}`}>
                {p.focus ? (
                  <button type="button" className="link-btn result-who" onClick={() => onSelect(p.focus!)}>
                    {p.focusLabel}
                  </button>
                ) : (
                  <span className="result-who">{p.focusLabel}</span>
                )}
                <span className="result-sentence">{p.sentence}</span>
                {p.value !== null && <span className="result-value">Value: {p.value}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more > 0 && <p className="detail-note result-more">and {more.toLocaleString()} more</p>}
    </>
  );
}
