/*
================================================================================
FILE: frontend/src/components/ReasoningPanel.tsx
================================================================================

SUMMARY
    Reasoning in the Hierarchy view (axioms-and-reasoning 5.1 to 5.7,
    Section 6): **Reason**, which becomes **Stop** while a run goes, and
    **Show inferred**, both in the view's toolbar; under them **Include data
    snapshots**, the line saying what the reasoner does, the status line and
    the results panel -- problems first, then the four groups with their
    true counts, each fact with **Why?** and its subject a link.

BASIC IDEA
    The run and its result live in the project store (D-084); this reads
    them by selector and asks the store to act. Reason and Stop are one
    button whose name changes, so focus stays on it from start to end; the
    start and the end are announced through the store's live region, the
    seconds counted on the status line are not.

    A result belongs to the revision, the snapshot generation and the
    imports switch it was computed on (5.3). Once any of them moves the
    panel says *The model changed after this run.* with **Reason again**,
    and Show inferred is hidden: App stops passing the marks to the tree,
    the canvas and the detail panel at the same moment, from the same rule.

    A group shows its first 200 facts with the true total in its heading;
    **Show more** asks the server for the next 200. Facts about imported
    terms alone are one line, collapsed until opened. Nothing is an href:
    a subject is selected as a tree row selects it.

INPUTS / INPUT SOURCES (props)
    - projectId, kind: the open project; a taxonomy is told reasoning is
      for ontology projects.
    - hasData: a snapshot is switched on, so the data checkbox shows.
    - now: the model's revision, the data generation and the imports switch.
    - onSelect: select an entity in the app's shared selection.

EXPECTED OUTPUT
    - ReasonControls (toolbar) and ReasoningPanel (below it).
================================================================================
*/

import { useEffect, useId, useState } from "react";
import { getReasoningPage } from "../api";
import {
  DATA_SLOWER,
  EMPTY,
  INTRO,
  NOTHING,
  NOT_SAVED,
  STALE,
  TAXONOMY,
  VALUES_FOOTER,
  finishedLine,
  groupHeading,
  importedLine,
  isStale,
  panelHeading,
  premiseMark,
  runningLine,
  type ReasoningNow,
} from "../reasoning/reasonSentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ProjectKind, ReasoningFact, ReasoningGroup, ReasoningProblem, ReasoningResult } from "../types";
import WhyDisclosure from "./WhyDisclosure";

interface Props {
  projectId: string;
  kind: ProjectKind | null | undefined;
  hasData: boolean;
  now: ReasoningNow;
  onSelect: (iri: string) => void;
}

function useRunning() {
  const since = useProjectSelector((s) => s.reasoningSince);
  return since;
}

/** Reason / Stop and Show inferred, for the Hierarchy toolbar. */
export function ReasonControls({ kind, now, hasData }: Pick<Props, "kind" | "now" | "hasData">) {
  const since = useRunning();
  const result = useProjectSelector((s) => s.reasoning);
  const showInferred = useProjectSelector((s) => s.showInferred);
  const includeData = useProjectSelector((s) => s.reasoningData);
  if (kind === "taxonomy") return null;
  const running = since !== null;
  const current = result !== null && result.status === "done" && !isStale(result, now);
  return (
    <>
      <button
        type="button"
        className="ghost reason-button"
        onClick={() => {
          if (running) void projectStore.stopReasoning();
          else void projectStore.reason(includeData && hasData, now.imports);
        }}
      >
        {running ? "Stop" : "Reason"}
      </button>
      {/* Hidden before a run and while the result is stale (Section 6). */}
      {current && (
        <button
          type="button"
          className="ghost"
          aria-pressed={showInferred}
          onClick={() => projectStore.setShowInferred(!showInferred)}
        >
          <span aria-hidden="true">{showInferred ? "✓ " : ""}</span>
          Show inferred
        </button>
      )}
    </>
  );
}

/** The seconds a run has taken, counted on the status line only. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, (now - since) / 1000);
}

export default function ReasoningPanel({ projectId, kind, hasData, now, onSelect }: Props) {
  const since = useRunning();
  const result = useProjectSelector((s) => s.reasoning);
  const token = useProjectSelector((s) => s.reasoningToken);
  const error = useProjectSelector((s) => s.reasoningError);
  const includeData = useProjectSelector((s) => s.reasoningData);
  const [open, setOpen] = useState(true);
  const elapsed = useElapsed(since);
  const headingId = useId();
  const dataId = useId();

  // A new result opens the panel again after it was closed.
  useEffect(() => {
    if (result) setOpen(true);
  }, [result]);

  if (kind === "taxonomy") {
    return <p className="detail-note reasoning-intro">{TAXONOMY}</p>;
  }
  const running = since !== null;
  const stale = result !== null && isStale(result, now);

  return (
    <div className="reasoning">
      {hasData && (
        <p className="wizard-field reasoning-data">
          <input
            id={dataId}
            type="checkbox"
            checked={includeData}
            onChange={(e) => projectStore.setReasoningData(e.target.checked)}
          />{" "}
          <label htmlFor={dataId}>Include data snapshots</label> <span className="detail-note">({DATA_SLOWER})</span>
        </p>
      )}
      <p className="detail-note reasoning-intro">{INTRO}</p>
      <p className="detail-note reasoning-status">
        {running ? runningLine(elapsed) : result && !stale ? finishedLine(result) : ""}
      </p>
      {open && (
        <section className="reasoning-results" aria-labelledby={headingId}>
          <div className="reasoning-results-head">
            <h3 id={headingId}>{panelHeading(stale ? null : result)}</h3>
            <button type="button" className="ghost icon-button" aria-label="Close the results" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          {error && (
            <p className="edit-error" role="alert">
              {error}
            </p>
          )}
          {!result && !error && <p className="detail-note">{EMPTY}</p>}
          {result && stale && (
            <p className="detail-note reasoning-stale">
              {STALE}{" "}
              <button
                type="button"
                className="ghost"
                aria-disabled={running}
                onClick={() => {
                  if (!running) void projectStore.reason(includeData && hasData, now.imports);
                }}
              >
                Reason again
              </button>
            </p>
          )}
          {result && <Results projectId={projectId} result={result} token={token} imports={now.imports} onSelect={onSelect} />}
          <p className="detail-note reasoning-footer">
            {VALUES_FOOTER} {NOT_SAVED}
          </p>
        </section>
      )}
    </div>
  );
}

function Results({
  projectId,
  result,
  token,
  imports,
  onSelect,
}: {
  projectId: string;
  result: ReasoningResult;
  // Which run: a group's pages belong to one, so a new one starts them
  // again even when its key reads the same (code review).
  token: number;
  imports: boolean;
  onSelect: (iri: string) => void;
}) {
  if (result.status !== "done") {
    return <p className="detail-note reasoning-ending">{result.sentence}</p>;
  }
  const facts = result.groups.reduce((sum, g) => sum + g.total, 0) + result.importedFacts.total;
  if (result.problems.length === 0 && facts === 0) {
    return <p className="detail-note">{NOTHING}</p>;
  }
  return (
    <>
      {result.problems.length > 0 && (
        <section className="reasoning-group">
          <h4>Problems ({result.problems.length.toLocaleString("en-US")})</h4>
          <ul>
            {result.problems.map((problem, i) => (
              <Problem key={`${problem.kind}|${problem.subject}|${i}`} projectId={projectId} problem={problem} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      )}
      {result.groups.map((group) =>
        group.total > 0 ? (
          <Group
            key={`${token}|${group.kind}`}
            projectId={projectId}
            group={group}
            imports={imports}
            heading={groupHeading(group.kind as Exclude<typeof group.kind, "imported">, group.total)}
            onSelect={onSelect}
          />
        ) : null,
      )}
      {result.importedFacts.total > 0 && (
        <Imported key={`${token}|imported`} projectId={projectId} group={result.importedFacts} imports={imports} onSelect={onSelect} />
      )}
    </>
  );
}

function Problem({
  projectId,
  problem,
  onSelect,
}: {
  projectId: string;
  problem: ReasoningProblem;
  onSelect: (iri: string) => void;
}) {
  const [why, setWhy] = useState(false);
  const whyId = useId();
  return (
    <li className="reasoning-problem">
      {problem.subject ? (
        <button type="button" className="term-link" onClick={() => onSelect(problem.subject!)}>
          {problem.sentence}
        </button>
      ) : (
        <span>{problem.sentence}</span>
      )}
      {problem.reasoner && (
        <>
          {" "}
          <button
            type="button"
            className="term-link why-button"
            aria-expanded={why}
            aria-controls={whyId}
            onClick={() => setWhy(!why)}
          >
            Why?
          </button>
          {why && (
            <p id={whyId} className="detail-note why-reason">
              {problem.reasoner}
            </p>
          )}
        </>
      )}
      {problem.causes.length > 0 && (
        <ul className="reasoning-causes" aria-label="Caused by">
          {problem.causes.map((cause, i) => (
            <li key={`${cause.s}|${cause.p}|${cause.o}|${i}`}>
              <button type="button" className="term-link" onClick={() => onSelect(cause.s)}>
                {cause.sentence}
              </button>{" "}
              <span className="why-mark">{premiseMark(cause.inferred)}</span>
              {cause.inferred && cause.o !== null && (
                <>
                  {" "}
                  <WhyDisclosure
                    projectId={projectId}
                    fact={{ s: cause.s, p: cause.p, o: cause.o }}
                    label={cause.sentence}
                    onSelect={onSelect}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The pages of one group: the first came with the result, Show more asks
 *  for the next 200. */
function usePages(projectId: string, group: ReasoningGroup, imports: boolean) {
  const [items, setItems] = useState<ReasoningFact[]>(group.items);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const more = () => {
    setLoading(true);
    setError(null);
    getReasoningPage(projectId, group.kind, items.length, imports)
      .then((page) => setItems((current) => [...current, ...page.items]))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  return { items, more, loading, error };
}

function FactList({
  projectId,
  group,
  imports,
  onSelect,
}: {
  projectId: string;
  group: ReasoningGroup;
  imports: boolean;
  onSelect: (iri: string) => void;
}) {
  const { items, more, loading, error } = usePages(projectId, group, imports);
  return (
    <>
      <ul>
        {items.map((fact) => (
          <li key={`${fact.s}|${fact.p}|${fact.o}`} className="reasoning-fact">
            <button type="button" className="term-link" onClick={() => onSelect(fact.s)}>
              {fact.sentence}
            </button>{" "}
            <WhyDisclosure projectId={projectId} fact={fact} label={fact.sentence} onSelect={onSelect} />
          </li>
        ))}
      </ul>
      {items.length < group.total && (
        <p>
          <button type="button" className="ghost" aria-disabled={loading} onClick={() => !loading && more()}>
            Show more
          </button>{" "}
          <span className="detail-note">
            {items.length.toLocaleString("en-US")} of {group.total.toLocaleString("en-US")} shown
          </span>
        </p>
      )}
      {error && (
        <p className="edit-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function Group({
  projectId,
  group,
  imports,
  heading,
  onSelect,
}: {
  projectId: string;
  group: ReasoningGroup;
  imports: boolean;
  heading: string;
  onSelect: (iri: string) => void;
}) {
  return (
    <section className="reasoning-group">
      <h4>{heading}</h4>
      <FactList projectId={projectId} group={group} imports={imports} onSelect={onSelect} />
    </section>
  );
}

/** *12 facts about imported terms*, collapsed by default (5.4). */
function Imported({
  projectId,
  group,
  imports,
  onSelect,
}: {
  projectId: string;
  group: ReasoningGroup;
  imports: boolean;
  onSelect: (iri: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section className="reasoning-group">
      <h4>
        <button type="button" className="term-link" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {importedLine(group.total)}
        </button>
      </h4>
      {open && (
        <div id={listId}>
          <FactList projectId={projectId} group={group} imports={imports} onSelect={onSelect} />
        </div>
      )}
    </section>
  );
}
