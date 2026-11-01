/*
================================================================================
FILE: frontend/src/checks/report.ts
================================================================================

SUMMARY
    The Checks report's rules and words (design-checks 5.4, 5.7), kept out
    of ChecksView so they are tested without rendering: the order of the
    groups, the summary line, the measures' lines, the level line, the
    *Showing 100 of N* line, when a report is stale, and where a finding
    leads. Stage B: the Hint level, after the other two (5.6), and the
    review aids' words (5.8): the read-aloud count, the four definition
    tests, and a competency question's line.

BASIC IDEA
    Groups with findings first -- Problems, then Worth a look, and within a
    level the group with the most findings first -- then the groups that
    passed, each said with (0). A tie keeps the catalogue's order. The
    numbers are the server's true totals; the page shows at most 100
    findings of a group and says so.

    A report is stale when the document's revision (or its data snapshots'
    generation) has moved since it ran (D-081): the findings stay, under a
    sentence saying so, until Run again.

    No colour carries a meaning here: each level is a word and a mark, and
    the words are these.

INPUTS / INPUT SOURCES
    - ChecksReport records from api.ts.

EXPECTED OUTPUT
    - Ordered groups; sentences; a finding's destination.
================================================================================
*/

import type { CheckFinding, CheckGroup, CheckLevel, CheckMeasures, ChecksReport, CompetencyQuestion } from "../api";

/** Problems, then Worth a look, then the hints (5.6): a question comes after
 *  every fault. */
export const LEVEL_ORDER: CheckLevel[] = ["Problem", "Worth a look", "Hint"];

/** The mark beside each level's word: shape, never colour alone. A hint's is
 *  a question mark, as each hint is a question. */
export const LEVEL_MARK: Record<CheckLevel, string> = { Problem: "▲", "Worth a look": "●", Hint: "?" };
export const PASSED_MARK = "✓";

export const RUNNING = "Checking… (28 checks, 12 hints)";
export const STALE = "The model has changed since these checks ran.";
export const FAILED = "The checks could not run.";

/** Above the cap (design-checks 5.10, D-125): one sentence, both numbers.
 *  No check ran; each is still offered as a query below. */
export function overCapLine(name: string, over: { statements: number; cap: number }): string {
  return `${name} has ${over.statements.toLocaleString("en")} statements, more than the ${over.cap.toLocaleString(
    "en",
  )} these checks run on, so they were not run.`;
}

/** Groups with findings first: Problems, then Worth a look, most findings
 *  first. Then the groups that passed, in the same level order: listed, so
 *  a learner sees what good looks like, but never above a finding (read in
 *  the browser, the 23 passing Problems of a good model stood above its
 *  five findings worth a look). */
export function orderGroups(groups: CheckGroup[]): CheckGroup[] {
  const found = (g: CheckGroup) => (g.total > 0 || g.error ? 0 : 1);
  return groups
    .map((g, index) => ({ g, index }))
    .sort((a, b) => {
      const passed = found(a.g) - found(b.g);
      if (passed !== 0) return passed;
      const level = LEVEL_ORDER.indexOf(a.g.level) - LEVEL_ORDER.indexOf(b.g.level);
      if (level !== 0) return level;
      if (b.g.total !== a.g.total) return b.g.total - a.g.total;
      return a.index - b.index;
    })
    .map(({ g }) => g);
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

/** "Space Exploration: 3 problems, 5 worth a look, 2 hints": groups with
 *  findings. A hint is a question, not a failure: every check can pass with
 *  questions still to think about. */
export function summaryLine(name: string, groups: CheckGroup[]): string {
  const problems = groups.filter((g) => g.level === "Problem" && g.total > 0).length;
  const worth = groups.filter((g) => g.level === "Worth a look" && g.total > 0).length;
  const hints = groups.filter((g) => g.level === "Hint" && g.total > 0).length;
  const asked = hints > 0 ? `, ${plural(hints, "hint", "hints")}` : "";
  if (problems === 0 && worth === 0) return `${name}: every check passed${asked}`;
  return `${name}: ${plural(problems, "problem", "problems")}, ${worth.toLocaleString("en")} worth a look${asked}`;
}

/** The measures of 5.7, one line each, as the report shows them. */
export function measureLines(m: CheckMeasures): string[] {
  const c = m.counts;
  const percent = (part: number, whole: number) => (whole ? Math.round((part * 100) / whole) : 0);
  return [
    [
      plural(c.classes, "class", "classes"),
      plural(c.properties, "property", "properties"),
      plural(c.concepts, "concept", "concepts"),
      plural(c.individuals, "individual", "individuals"),
    ].join(" · "),
    `Hierarchy ${m.hierarchy.depth.toLocaleString("en")} deep, ${m.hierarchy.widest.toLocaleString("en")} at most under one parent, ${plural(m.hierarchy.tops, "top class or concept", "top classes and concepts")}`,
    `Documentation ${m.documentation.documented.toLocaleString("en")} of ${plural(m.documentation.terms, "term", "terms")} labelled and defined (${percent(m.documentation.documented, m.documentation.terms)}%)`,
    `Reuse ${plural(m.reuse.namespaces, "namespace", "namespaces")} from other vocabularies · ${percent(m.reuse.reused, m.reuse.used)}% of terms reused`,
  ];
}

/** "Level: Formal model with data (step 6 of 6)", and what the next takes. */
export function levelLines(m: CheckMeasures): string[] {
  const l = m.level;
  const lines = [`Level: ${l.name} (step ${l.step} of ${l.of})`];
  if (l.next) lines.push(`Next: ${l.next}`);
  return lines;
}

/** Said when a group holds more than it shows; null when it shows all. */
export function showingLine(group: CheckGroup): string | null {
  return group.total > group.findings.length
    ? `Showing ${group.findings.length.toLocaleString("en")} of ${group.total.toLocaleString("en")}`
    : null;
}

/** "Showing 1,000 of 1,204", or null when everything is shown. */
export function showingOf(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown.toLocaleString("en")} of ${total.toLocaleString("en")}` : null;
}

// --- the review aids (5.8, Stage B) ---------------------------------------------

/** "12 of 30 read and agreed." */
export function readAloudLine(agreed: number, total: number): string {
  return `${agreed.toLocaleString("en")} of ${total.toLocaleString("en")} read and agreed.`;
}

export const READ_ALOUD_INTRO =
  "Each link of the hierarchy as a sentence. Read it aloud; tick it when it is true of every one.";
export const READ_ALOUD_LIBRARY = "Ticks are kept for a project; a library ontology is read without them.";
export const NO_LINKS = "There is no hierarchy to read yet: no term is under another.";

/** The four questions a definition is tested by (5.8). */
export const DEFINITION_TESTS = [
  "What kind of thing is it, and what sets it apart?",
  "Does the sentence stay true with the definition in place of the term?",
  "Can you name something almost like it that it excludes?",
  "Would a new colleague understand it?",
];
export const NO_DEFINITIONS = "No term has a definition yet.";

export const QUESTIONS_INTRO = "Your saved queries are this project's questions; each was run on the model.";
export const NO_QUESTIONS =
  "No saved queries yet. Save a query in Query, and it is listed here as a question the model should answer.";

/** One competency question's line: its rows, or why it did not run. A
 *  question that returns nothing is Worth a look (5.8): its level word goes
 *  with it, never a colour alone. */
export function questionLine(q: CompetencyQuestion): { level: CheckLevel | null; text: string } {
  if (q.error) return { level: null, text: `${q.name}: ${q.error}` };
  if (!q.total) return { level: "Worth a look", text: `${q.name} returns nothing.` };
  return { level: null, text: `${q.name}: ${plural(q.total, "row", "rows")}` };
}

export function lastRun(ms: number): string {
  return `Last run ${(ms / 1000).toFixed(1)} s`;
}

export function isStale(report: ChecksReport, revision: number, generation?: number): boolean {
  return report.revision !== revision || (generation !== undefined && report.generation !== generation);
}

export type Destination = "edit" | "explore" | "source" | "shapes";

/** Where *open* goes (5.9): a project's own term to Edit, a library header
 *  to the Turtle at its owl:Ontology line, a project's shape to Shapes, and
 *  anything else to Explore. `own` is the project's base, null for the
 *  library. */
export function destination(finding: CheckFinding, own: string | null, shapesDoc: boolean): Destination {
  if (shapesDoc) return "shapes";
  if (own !== null && finding.iri && (finding.iri.startsWith(own) || finding.block === "header")) return "edit";
  if (own === null && finding.block === "header") return "source";
  return "explore";
}
