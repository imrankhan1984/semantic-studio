/*
================================================================================
FILE: frontend/src/reasoning/reasonSentences.ts
================================================================================

SUMMARY
    The words of reasoning (axioms-and-reasoning 5.1 to 5.7, Section 6): the
    line under Reason, the running and finished status lines, each ending's
    sentence, the group headings with their true counts, a premise's mark,
    and the rule that says when a result no longer belongs to the model
    being shown. Pure: no React, no fetch.

BASIC IDEA
    The facts, the problems and the reasons arrive as sentences from the
    server, which builds them where the explainer runs, from the model's own
    names and E-8's words for each characteristic (D-103). What is left for
    the browser is the frame around them, and that is here so every state
    of Section 6 can be tested without rendering a panel.

    A result is stale once the open model's revision, the snapshots'
    generation or the imports switch is not what it was computed on (5.3),
    or when the server already said so -- a change made while it ran. The
    views stop showing its marks at once; nothing is re-run without a press.

INPUTS / INPUT SOURCES
    - A ReasoningResult from the server; the model's revision, the data
      generation and the imports switch from the project store and App.

EXPECTED OUTPUT
    - Sentences and headings as strings; isStale(result, now).
================================================================================
*/

import type { ReasoningGroupKind, ReasoningResult } from "../types";

export const INTRO =
  "Reasoning (OWL 2 RL) draws conclusions about the classes and things you have. It does not invent new things, and it changes nothing in your file.";
export const EMPTY = "Press Reason to see what follows from your model.";
export const NOTHING = "Nothing new follows, and nothing contradicts.";
export const STALE = "The model changed after this run.";
export const TAXONOMY = "Reasoning is for ontology projects.";
export const DATA_SLOWER = "slower: about a second per 1,000 rows";
export const VALUES_FOOTER = "Values in your data are checked by Validate (SHACL), not here.";
export const NEVER_MEMBERS = "can never have members";
export const NOT_SAVED = "Nothing here is saved or needs undoing: these are conclusions, not changes.";

export const GROUP_TITLES: Record<Exclude<ReasoningGroupKind, "imported">, string> = {
  kinds: "New kinds",
  same: "Same meaning",
  memberships: "New memberships",
  links: "New links",
};

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** *New kinds (2)*: every heading carries its group's true total. */
export function groupHeading(kind: Exclude<ReasoningGroupKind, "imported">, total: number): string {
  return `${GROUP_TITLES[kind]} (${count(total)})`;
}

/** The one line facts about imported terms alone are counted in (5.4). */
export function importedLine(total: number): string {
  return `${plural(total, "fact", "facts")} about imported terms`;
}

/** *4 s*, or a tenth of a second under one. */
export function seconds(ms: number): string {
  if (ms < 950) return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** The status line while a run goes: the seconds count up; they are not
 *  announced (Section 6). */
export function runningLine(elapsedSeconds: number): string {
  return `Reasoning… ${Math.floor(elapsedSeconds)} s`;
}

/** Every new fact the run shows, imported ones included. */
export function factCount(result: ReasoningResult): number {
  return result.groups.reduce((sum, g) => sum + g.total, 0) + result.importedFacts.total;
}

/** The status line and the announcement once a run ends (5.2). */
export function finishedLine(result: ReasoningResult): string {
  if (result.status !== "done") return result.sentence ?? "The run ended.";
  const problems = result.problems.length;
  const facts = factCount(result);
  if (problems === 0 && facts === 0) return `Reasoned in ${seconds(result.durationMs)}: ${NOTHING.toLowerCase()}`;
  return `Reasoned in ${seconds(result.durationMs)}: ${plural(problems, "problem", "problems")}, ${plural(
    facts,
    "new fact",
    "new facts",
  )}`;
}

/** The announcement for a run whose answer arrives after the model moved
 *  (5.3): its seconds, and that it is not current. A run that did not
 *  finish says only how it ended. */
export function staleLine(result: ReasoningResult): string {
  if (result.status !== "done") return finishedLine(result);
  return `Reasoned in ${seconds(result.durationMs)}, but the model changed meanwhile: Reason again.`;
}

/** The results panel's heading. */
export function panelHeading(result: ReasoningResult | null): string {
  if (!result) return "Results";
  if (result.status === "done") return `Results: reasoned in ${seconds(result.durationMs)}`;
  return "Results";
}

/** How a premise is marked, in text (Section 6, never colour alone). */
export function premiseMark(inferred: boolean): string {
  return inferred ? "inferred" : "stated";
}

/** What the model, the data and the switch are now. */
export interface ReasoningNow {
  revision: number;
  generation: number;
  imports: boolean;
}

/** Whether a result no longer belongs to what is shown (5.3). */
export function isStale(result: ReasoningResult, now: ReasoningNow): boolean {
  return (
    result.stale ||
    result.basis.revision !== now.revision ||
    result.basis.generation !== now.generation ||
    result.basis.imports !== now.imports
  );
}

/** Whether the marks show: a finished run, current, and Show inferred on. */
export function marksShown(result: ReasoningResult | null, now: ReasoningNow, showInferred: boolean): boolean {
  return Boolean(result && result.status === "done" && showInferred && !isStale(result, now));
}
