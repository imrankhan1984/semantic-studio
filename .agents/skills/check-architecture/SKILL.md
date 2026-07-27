---
name: check-architecture
description: Checks the architecture document against the current code and reports drift. Run at the start of any session that produces a specification, and after any change that adds an endpoint, a cap, or a dependency.
---

# Architecture drift check

<!-- Maintainers: the shell blocks below must not use positional parameters
     (a dollar sign followed by a digit). They are replaced with this skill's
     own invocation arguments before the shell ever runs, so a construct like
     `sh -c 'echo "one: ..."' _ {}` receives an argument word instead of the
     filename that find passed it.

     Verified 2026-07-27. The frontend probe used to be an `-exec sh -c` one
     liner reading the file name from the first positional. Invoked as
     `/check-architecture alpha SENTINELWORD gamma` it grepped for a file
     called SENTINELWORD; invoked during real work it grepped for the word
     "drift", because that happened to be the second word of the arguments
     both times. It reported nothing but errors for months without anyone
     noticing, because the errors looked like a missing file rather than a
     broken probe.

     Note that this comment is itself passed through the same substitution,
     which is why it spells the sigil out in words. Use a named variable in a
     `for` loop, as the backend block does. -->


## Current routes
!`grep -rn "@router\.\(get\|post\|delete\|put\)" backend/app/routers/ | sed 's/:.*@router/ -> @router/'`

## Current limits and caps
!`grep -rn "MAX_\|_CAP\|LIMIT\|TIMEOUT" backend/app/*.py backend/app/routers/*.py | grep -v "^\s*#"`

## Backend test counts
!`for f in backend/tests/test_*.py; do echo "$f: $(grep -c '^def test_' $f)"; done`

## Frontend test counts
!`for f in $(find frontend/src -name '*.test.ts*'); do echo "$f: $(grep -cE '^[[:space:]]*(it|test)\(' "$f")"; done`
!`npm --prefix frontend run test 2>/dev/null | grep -E "Tests +[0-9]" || echo "  (vitest did not run; the per-file counts above are all you have)"`

## Raw HTML rendering, must stay empty
!`grep -rn "dangerouslySetInnerHTML" frontend/src/ || echo "none found, trust boundary 3 holds"`

## Dependencies
!`cat backend/requirements.txt; echo "--- frontend ---"; sed -n '/"dependencies"/,/}/p' frontend/package.json`

## Instructions

Compare each block above with the matching part of `architecture.md`:

| Block | Compare against |
| --- | --- |
| Routes and caps | Section 4, the interface table |
| Test counts | Section 6 |
| Raw HTML | Section 5, trust boundary 3 |
| Dependencies | Section 5, and the stack table in Section 1 |

**Reading the test counts.** The per-file numbers are grep counts of test
declarations, so they are a **lower bound**: a parametrized test declared once
runs many times. Measured 2026-07-27 — the backend greps to 83 declarations and
pytest collects 129; the frontend greps to 60 and vitest reports 67. The runner
totals are authoritative and are what Section 6 records. The frontend block runs
vitest for that reason; for the backend, run `cd backend && python -m pytest
tests -q` before reporting a count as drift.

Report only differences. For each one, say which of these it is:

- **A documentation gap.** The code was always like this and the document is
  wrong. Correct the document and say so.
- **A real architectural change.** Something moved. It needs a numbered entry
  in the decision log in Section 7, and the person who made the change should
  say why.

Do not edit `architecture.md` without telling Imran what changed and why.
Decisions already written are never edited; a reversal is a new entry that
supersedes the old one.
