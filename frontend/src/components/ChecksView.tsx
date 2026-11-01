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

    A document above the cap (5.10, D-125) comes back with overCap set and no
    measures: the report shows one sentence with the count and the cap, and
    lists every check with Open as a query so each can still be run by hand.
    No check ran there, so neither Run again nor the last run's time shows.

    Stage B: the twelve hints (5.6) are groups at the level Hint, after the
    other two, each finding a question; a group that holds nothing for a
    reason other than a pass (H3 with no reasoning result) says why under
    its fix. Each Open as a query is named by its check's heading, so a
    screen reader's list of buttons tells them apart. Below the groups, the
    review aids (5.8): the hierarchy read aloud with a tick per link (the
    project manifest's, through PUT /read-aloud), the four questions with
    every definition, and a project's saved queries as its questions.

INPUTS / INPUT SOURCES (props)
    - ontologyId, name: what is checked and what the summary calls it.
    - revision / generation: the document's now, for the stale line.
    - ownBase: a project's base IRI (its own terms open in Edit), or null.
    - shapesDoc: the document is a project's shapes.ttl.
    - projectId: the project whose manifest keeps the read-aloud ticks.
    - onOpen(finding, destination): *open* pressed.
    - onOpenQuery(text, name): *Open as a query* pressed.

EXPECTED OUTPUT
    - The report; GET /checks once per mount and per Run again, GET
      /api/checks once, when Open as a query is first pressed; PUT
      /read-aloud per tick.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getChecks,
  listChecks,
  putReadAloud,
  type CheckEntry,
  type CheckFinding,
  type CheckGroup,
  type ChecksAids,
  type ChecksReport,
} from "../api";
import {
  DEFINITION_TESTS,
  FAILED,
  LEVEL_MARK,
  NO_DEFINITIONS,
  NO_LINKS,
  NO_QUESTIONS,
  PASSED_MARK,
  QUESTIONS_INTRO,
  READ_ALOUD_INTRO,
  READ_ALOUD_LIBRARY,
  RUNNING,
  STALE,
  destination,
  isStale,
  lastRun,
  levelLines,
  measureLines,
  orderGroups,
  overCapLine,
  questionLine,
  readAloudLine,
  showingLine,
  showingOf,
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
  /** The project whose manifest keeps the read-aloud ticks; null for the
   *  library, which reads the hierarchy without them. */
  projectId?: string | null;
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
  projectId = null,
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
        {/* Over the cap no check ran (5.10, D-125): there is nothing to run
            again and no run to time, so neither control shows. */}
        {!report?.overCap && (
          <button type="button" className="ghost" aria-disabled={running} onClick={() => !running && check()}>
            Run again
          </button>
        )}
        {report && !report.overCap && <span className="hint checks-last-run">{lastRun(report.ran_ms)}</span>}
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
      {report && report.overCap ? (
        <>
          {/* Too large to check (5.10, D-125): one sentence with both
              numbers, and every check still offered as a query. */}
          <p className="checks-over-cap">{overCapLine(name, report.overCap)}</p>
          {report.notes.map((note) => (
            <p key={note} className="hint checks-note">
              {note}
            </p>
          ))}
          {queryError && <p className="form-error">{queryError}</p>}
          <ul className="checks-over-cap-list">
            {report.groups.map((group) => (
              <li key={group.id}>
                <span>{group.heading}</span>{" "}
                <button
                  type="button"
                  className="link-btn checks-open-query"
                  aria-label={`Open as a query: ${group.heading}`}
                  onClick={() => openAsQuery(group)}
                >
                  Open as a query
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        report && (
          <>
            {stale && <p className="query-hint checks-stale">{STALE}</p>}
            {report.empty ? (
              <p className="checks-empty">{report.emptySentence}</p>
            ) : report.measures ? (
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
            ) : null}
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
            {!report.empty && report.aids && (
              <ReviewAids
                key={`${report.revision}-${report.ran_ms}`}
                aids={report.aids}
                projectId={projectId}
                onOpen={(finding) => onOpen(finding, destination(finding, ownBase, shapesDoc))}
              />
            )}
          </>
        )
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
  // A group with a note found nothing for a reason that is no pass (H3 with
  // no reasoning result to read): it keeps its level word, never the tick.
  const passed = group.total === 0 && !group.error && !group.note;
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
        <button
          type="button"
          className="link-btn checks-open-query"
          aria-label={`Open as a query: ${group.heading}`}
          onClick={onOpenQuery}
        >
          Open as a query
        </button>
        {group.error && <p className="detail-error">{group.error}</p>}
        {group.note && <p className="hint checks-note">{group.note}</p>}
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

/** The review aids (5.8, Stage B): what a person reads and judges beside
 *  the findings. Each a <details>, closed, so the report stays its groups
 *  first. A tick is the manifest's (AC-14): the box shows what the server
 *  holds, never the click, so a refused tick leaves it as it was; while one
 *  is on its way the box is aria-disabled, never disabled, which would drop
 *  the focus it holds. */
function ReviewAids({
  aids,
  projectId,
  onOpen,
}: {
  aids: ChecksAids;
  projectId: string | null;
  onOpen: (finding: CheckFinding) => void;
}) {
  const aloud = aids.readAloud;
  const [agreed, setAgreed] = useState(() => new Set(aloud.links.filter((l) => l.agreed).map((l) => l.key)));
  const [count, setCount] = useState(aloud.agreed);
  const [pending, setPending] = useState<string | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  const editable = aloud.editable && projectId !== null;

  const tick = (key: string) => {
    if (!projectId || pending !== null) return;
    const next = !agreed.has(key);
    setPending(key);
    setTickError(null);
    putReadAloud(projectId, key, next).then(
      (answer) => {
        setAgreed((held) => {
          const changed = new Set(held);
          if (answer.agreed) changed.add(key);
          else changed.delete(key);
          return changed;
        });
        setCount(answer.count);
        setPending(null);
      },
      (e: unknown) => {
        setTickError(e instanceof Error ? e.message : String(e));
        setPending(null);
      },
    );
  };

  const definitionsShowing = showingOf(aids.definitions.items.length, aids.definitions.total);
  const linksShowing = showingOf(aloud.links.length, aloud.total);
  return (
    <section className="checks-aids" aria-labelledby="checks-aids-heading">
      <h4 id="checks-aids-heading" className="checks-aids-title">
        Review aids
      </h4>

      <details className="checks-group checks-aid">
        <summary>
          <h4 className="checks-group-heading">Read it aloud ({readAloudLine(count, aloud.total)})</h4>
        </summary>
        <div className="checks-group-body checks-aid-body">
          <p className="hint">{READ_ALOUD_INTRO}</p>
          {!editable && aloud.total > 0 && <p className="hint">{READ_ALOUD_LIBRARY}</p>}
          {/* In the page while unchanged: the count is announced when a tick
              moves it. */}
          <p className="checks-read-aloud-count" aria-live="polite">
            {readAloudLine(count, aloud.total)}
          </p>
          {tickError && <p className="form-error">{tickError}</p>}
          {aloud.total === 0 ? (
            <p className="hint">{NO_LINKS}</p>
          ) : (
            <ul className="checks-aid-list checks-read-aloud">
              {aloud.links.map((link) => (
                <li key={link.key} aria-busy={pending === link.key || undefined}>
                  {editable ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={agreed.has(link.key)}
                        aria-disabled={pending !== null}
                        onChange={() => tick(link.key)}
                      />
                      <span>{link.sentence}</span>
                    </label>
                  ) : (
                    <span>{link.sentence}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {linksShowing && <p className="hint">{linksShowing}</p>}
        </div>
      </details>

      <details className="checks-group checks-aid">
        <summary>
          <h4 className="checks-group-heading">
            Test each definition ({aids.definitions.total.toLocaleString("en")})
          </h4>
        </summary>
        <div className="checks-group-body checks-aid-body">
          <p>Ask of each definition:</p>
          <ol className="checks-aid-list checks-definition-tests">
            {DEFINITION_TESTS.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
          {aids.definitions.total === 0 ? (
            <p className="hint">{NO_DEFINITIONS}</p>
          ) : (
            <ul className="checks-aid-list">
              {aids.definitions.items.map((item) => {
                const sentence = `${item.name}: ${item.text}`;
                return (
                  <li key={item.iri}>
                    <span className="checks-definition-name">{item.name}</span>: <span>{item.text}</span>{" "}
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Open the definition of ${item.name}`}
                      onClick={() => onOpen({ iri: item.iri, sentence, block: "definition" })}
                    >
                      open
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {definitionsShowing && <p className="hint">{definitionsShowing}</p>}
        </div>
      </details>

      {aids.questions !== null && (
        <details className="checks-group checks-aid">
          <summary>
            <h4 className="checks-group-heading">Your questions ({aids.questions.length.toLocaleString("en")})</h4>
          </summary>
          <div className="checks-group-body checks-aid-body">
            <p className="hint">{QUESTIONS_INTRO}</p>
            {aids.questions.length === 0 ? (
              <p className="hint">{NO_QUESTIONS}</p>
            ) : (
              <ul className="checks-aid-list">
                {aids.questions.map((question) => {
                  const line = questionLine(question);
                  return (
                    <li key={question.id}>
                      {line.level && (
                        <span className="checks-level-word">
                          <span aria-hidden="true">{LEVEL_MARK[line.level]} </span>
                          {line.level} ·{" "}
                        </span>
                      )}
                      {line.text}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
