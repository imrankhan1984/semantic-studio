/*
================================================================================
FILE: frontend/src/components/ChecksView.tsx
================================================================================

SUMMARY
    The Checks report (design-checks 5.4, D-124): View's third switch. The
    measures and the level the document reaches, then one group per design
    check -- Problems first, then Worth a look, most findings first -- each
    finding a sentence with *open* to the entity, each group its fix and
    *Open as a query*.

BASIC IDEA
    The report is asked for when this mounts and when Run again is pressed,
    never before: SourceView mounts it only once Checks is chosen, so
    reading the file pays nothing (Section 10). A request on its way is
    aborted when another replaces it or the view goes, and only the latest
    answer is applied.

    Groups are <details> with the heading inside the summary, so the
    browser gives each its keyboard and its expanded state. A group with
    findings opens; one that passed is listed closed with (0) and a tick,
    so a learner sees what good looks like as well as what failed (5.4,
    Section 7). The level is a word and a mark, never a colour alone
    (AC-11). A group shows its first 100 findings and says *Showing 100 of
    N* with the true total (house rule 6).

    When the document's revision moves after a run, the old findings stay
    under a sentence saying the model has changed, until Run again (AC-8).
    Every name in a finding is text React renders, never markup (house rule
    5): ontology content is untrusted.

INPUTS / INPUT SOURCES (props)
    - ontologyId, name: what is checked and what the summary calls it.
    - revision / generation: the document's now, for the stale line.
    - ownBase: a project's base IRI (its own terms open in Edit), or null.
    - shapesDoc: the document is a project's shapes.ttl.
    - onOpen(finding, destination): *open* pressed.
    - onOpenQuery(text, name): *Open as a query* pressed.

EXPECTED OUTPUT
    - The report; GET /checks once per mount and per Run again, GET
      /api/checks once, when Open as a query is first pressed.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { getChecks, listChecks, type CheckEntry, type CheckFinding, type CheckGroup, type ChecksReport } from "../api";
import {
  FAILED,
  LEVEL_MARK,
  PASSED_MARK,
  RUNNING,
  STALE,
  destination,
  isStale,
  lastRun,
  levelLines,
  measureLines,
  orderGroups,
  showingLine,
  summaryLine,
  type Destination,
} from "../checks/report";

interface Props {
  ontologyId: string;
  name: string;
  revision: number;
  generation?: number;
  ownBase: string | null;
  shapesDoc?: boolean;
  onOpen: (finding: CheckFinding, to: Destination) => void;
  onOpenQuery: (text: string, name: string) => void;
}

export default function ChecksView({
  ontologyId,
  name,
  revision,
  generation,
  ownBase,
  shapesDoc = false,
  onOpen,
  onOpenQuery,
}: Props) {
  const [report, setReport] = useState<ChecksReport | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const catalogue = useRef<Promise<CheckEntry[]> | null>(null);

  const check = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const mine = ++run.current;
    setRunning(true);
    setFailed(null);
    getChecks(ontologyId, controller.signal).then(
      (answer) => {
        if (run.current !== mine) return;
        setReport(answer);
        setRunning(false);
      },
      (e: unknown) => {
        if (run.current !== mine || controller.signal.aborted) return;
        setFailed(e instanceof Error ? e.message : String(e));
        setRunning(false);
      },
    );
  }, [ontologyId]);

  useEffect(() => {
    setReport(null);
    check();
    return () => abort.current?.abort();
  }, [check]);

  const openAsQuery = (group: CheckGroup) => {
    setQueryError(null);
    catalogue.current ??= listChecks();
    catalogue.current.then(
      (entries) => {
        const entry = entries.find((e) => e.id === group.id);
        if (entry) onOpenQuery(entry.query, `${entry.id} ${entry.heading}`);
      },
      (e: unknown) => {
        catalogue.current = null;
        setQueryError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const stale = report !== null && isStale(report, revision, generation);
  const groups = report ? orderGroups(report.groups) : [];

  return (
    <section className="checks-view" aria-labelledby="checks-heading" aria-busy={running || undefined}>
      <div className="checks-toolbar">
        <h3 id="checks-heading" className="checks-title">
          Checks
        </h3>
        <button type="button" className="ghost" aria-disabled={running} onClick={() => !running && check()}>
          Run again
        </button>
        {report && <span className="hint checks-last-run">{lastRun(report.ran_ms)}</span>}
      </div>
      {/* In the page while empty: a live region added with its text is
          unreliably announced. */}
      <p className="hint checks-status" role="status">
        {running ? RUNNING : ""}
      </p>
      {failed && !running && (
        <div className="detail-error checks-failed">
          <p>
            {FAILED} {failed}
          </p>
          <button type="button" onClick={check}>
            Try again
          </button>
        </div>
      )}
      {report && (
        <>
          {stale && <p className="query-hint checks-stale">{STALE}</p>}
          {report.empty ? (
            <p className="checks-empty">{report.emptySentence}</p>
          ) : (
            <>
              <p className="checks-summary">{summaryLine(name, report.groups)}</p>
              <section className="checks-measures" aria-labelledby="checks-measures-heading">
                <h4 id="checks-measures-heading">Measures</h4>
                <ul>
                  {measureLines(report.measures).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {levelLines(report.measures).map((line) => (
                    <li key={line} className="checks-level">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
          {report.notes.map((note) => (
            <p key={note} className="hint checks-note">
              {note}
            </p>
          ))}
          {queryError && <p className="form-error">{queryError}</p>}
          {!report.empty && (
            <div className="checks-groups">
              {groups.map((group) => (
                <Group
                  key={group.id}
                  group={group}
                  onOpen={(finding) => onOpen(finding, destination(finding, ownBase, shapesDoc))}
                  onOpenQuery={() => openAsQuery(group)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Group({
  group,
  onOpen,
  onOpenQuery,
}: {
  group: CheckGroup;
  onOpen: (finding: CheckFinding) => void;
  onOpenQuery: () => void;
}) {
  const passed = group.total === 0 && !group.error;
  const showing = showingLine(group);
  return (
    <details className={`checks-group${passed ? " passed" : ""}`} open={!passed}>
      <summary>
        <h4 className="checks-group-heading">
          <span className="checks-level-word">
            <span aria-hidden="true">{passed ? PASSED_MARK : LEVEL_MARK[group.level]} </span>
            {passed ? "Passed" : group.level}
          </span>{" "}
          · {group.heading} ({group.total.toLocaleString("en")})
        </h4>
      </summary>
      <div className="checks-group-body">
        <p className="hint checks-fix">{group.fix}</p>
        <button type="button" className="link-btn checks-open-query" onClick={onOpenQuery}>
          Open as a query
        </button>
        {group.error && <p className="detail-error">{group.error}</p>}
        {group.findings.length > 0 && (
          <ul className="checks-findings">
            {group.findings.map((finding, index) => (
              <li key={`${finding.iri ?? ""}-${index}`}>
                <span>{finding.sentence}</span>
                {finding.iri && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Open: ${finding.sentence}`}
                      onClick={() => onOpen(finding)}
                    >
                      open
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {showing && <p className="hint">{showing}</p>}
      </div>
    </details>
  );
}
