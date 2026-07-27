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

Read these four, in this order:

1. The named spec file. It is in the specifications folder, which is available
   as an added directory. If you cannot find it, stop and ask for the path
   rather than guessing.
2. `architecture.md` — how the application is built, and the decision log.
3. `skills.md` — which skills apply, though the spec names them in its own
   Section 13.
4. `backlog.md` — the row for this item, for context on why it matters.

If the spec's status is `Draft` rather than `Ready for build`, stop. A draft has
unanswered questions in its Section 15 and building it will waste your work.

## Step 2 — Check for drift

Run the `check-architecture` skill. Report any difference between
`architecture.md` and the code before you write anything. A spec written against
a stale architecture document may be wrong in ways neither of us has noticed.

## Step 3 — Plan against the acceptance criteria

List every acceptance criterion from the spec's Section 12 and every test row
from Section 11. That list is your definition of done. Do not add scope that is
not in it, and do not drop anything that is.

Note which files Section 8 says you will touch. If you find yourself editing a
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
  5 if a trust boundary changed, Section 6 if test counts changed. Add the
  decision log entries the spec named, using the existing format. Never edit a
  decision already written; supersede it with a new one.
- `AGENTS.md` in the specifications folder: update the state column in Section 7
  if a security item moved from Not met to Met.
- The spec file itself: add a version row recording that it was built, and set
  its status to `Built`.
- `backlog.md`: set the row's status to `Built`.
- `README.md`: only if user-visible behavior or configuration changed.

## Step 7 — Report

Give a short summary: what changed, which acceptance criteria pass and how you
know, any performance numbers, and anything in the spec you disagreed with or
could not do. Name the last one explicitly rather than leaving it to be
discovered.
