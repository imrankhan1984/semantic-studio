---
name: build-spec
description: Implements a Semantic Studio specification end to end, including its tests and document updates. Use when asked to build, implement, or execute a spec by name, for example "build the network-and-resource-limits spec".
---

# Build a specification

Takes one argument: the spec file name, with or without the `.md` extension.
Example: `/build-spec network-and-resource-limits`

The specification is the contract. If something in it is wrong or impossible,
stop and say so. Do not quietly build something different.

## Step 1 — Read before touching anything

Read these five, in this order:

1. The named spec file. It is in the specifications folder, which is available
   as an added directory. If you cannot find it, stop and ask for the path
   rather than guessing.
2. `architecture.md` — how the application is built, as it stands now.
3. `decisions.md` — the decision log, D-001 onward, and the drift-check history
   in its Appendix A. Decisions moved out of `architecture.md` on 2026-09-28.
4. `skills.md` — which skills apply, though the spec names them in its own
   Section 13.
5. `backlog.md` — the row for this item, for context on why it matters.

If the spec's status is `Draft` rather than `Ready for build`, stop. A draft has
unanswered questions in its Section 15 and building it will waste your work.

**A spec-lite is a complete spec.** Small items (under two sessions, no new
network path, no new input file type) carry only Sections 1, 5, 11, 12 and 14.
Section 5 then holds the behaviour and the file list, and there is no Section 8,
10 or 13 to read: take the files from Section 5, and treat a missing
performance section as no budget beyond the ones the suite already holds.

## Step 2 — Check for drift

Run the `check-architecture` skill. Report any difference between
`architecture.md` and the code before you write anything. A spec written against
a stale architecture document may be wrong in ways neither of us has noticed.

## Step 3 — Plan against the acceptance criteria

List every acceptance criterion from the spec's Section 12 and every test row
from Section 11. That list is your definition of done. Do not add scope that is
not in it, and do not drop anything that is.

Note which files Section 8 (Section 5 in a spec-lite) says you will touch. If you find yourself editing a
file the spec does not mention, that is a signal the spec is incomplete: say so.

## Step 4 — Build, tests first where it is practical

Use the skills the spec names in its Section 13. For security work
`verify-security-fix` is not optional; it carries the assertions that make the
difference between a test that proves something and a test that passes.

Rules that hold for every spec:

- Match the file header convention. Every source file in this repository opens
  with a structured comment block: `SUMMARY`, `BASIC IDEA`,
  `INPUTS / INPUT SOURCES`, `EXPECTED OUTPUT`. New files get one. Changed files
  get theirs updated if the summary is no longer true.
- Keep the inline comment density. This codebase explains why, not what. Follow
  it.
- Do not add a dependency unless the spec says to. If one seems necessary, stop
  and ask.

## Step 5 — Verify

- Every acceptance criterion demonstrably passes.
- The whole existing suite still passes. Backend: `cd backend && python -m pytest tests`.
  Frontend: `cd frontend && npm run test`.
- If the spec has a performance budget in Section 10, run the `perf-budget`
  skill and record the before and after numbers.
- If the spec adds an interactive element, run the `a11y-check` skill.
- Run `/security-review` if any network, parsing, or resource-limit code
  changed.
- Run `/code-review` on the working diff.

Where the spec makes a claim about behavior in a browser, confirm it with
`/verify` rather than trusting the test suite. Three defects in this project
reached a running application because tests passed and nobody looked.

## Step 6 — Update the documents

This is part of the work, not an afterthought. The spec's Section 14 says what
changes.

- `architecture.md`: correct Section 4 if an endpoint or a cap changed, Section
  5 if a trust boundary changed, Section 6 if test counts changed.
- `decisions.md`: add the decision entries the spec named, appended, in the
  existing format, and a row in its table. Never edit a decision already
  written; supersede it with a new one. `architecture.md` no longer carries
  decisions.
- `CLAUDE.md` in the specifications folder: update the state column in Section 7
  if a security item moved from Not met to Met.
- The spec file itself: add a version row recording that it was built, and set
  its status to `Built`. **A staged spec is built one stage at a time**: its
  version row says *Stage N built* and its status stays as it was until the last
  stage is built. Never mark the whole spec `Built` for one stage.
- `backlog.md`: set the row's status to `Built` (or *Stage N built*, the same
  rule).
- `log.md` in the specifications folder: **an entry is required**, in the
  existing format — date and time, what was built, on which branch and pull
  request, and the files changed. Two builds skipped it and the log lost them.
- The repository `CLAUDE.md`: if the build leaves a rule someone must not undo,
  add one line under *Load-bearing rules* and the reason, as a new entry at the
  foot of `docs/known-state.md`. The narrative goes there, not in `CLAUDE.md`.
- `README.md`: only if user-visible behavior or configuration changed.

**The build stops only once CI is green on the pull request.** Push the branch,
open the pull request (or hand over the link where the pull request is someone
else's to open), and wait for `backend-linux`, `backend-windows`, `frontend` and
`docker` to pass. The `budgets` job reports and does not block, but read it: a
budget missed there is worth a sentence in the report.

## Step 7 — Report

Give a short summary: what changed, the pull request and its CI result, which acceptance criteria pass and how you
know, any performance numbers, and anything in the spec you disagreed with or
could not do. Name the last one explicitly rather than leaving it to be
discovered.
