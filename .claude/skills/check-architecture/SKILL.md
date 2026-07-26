---
name: check-architecture
description: Checks the architecture document against the current code and reports drift. Run at the start of any session that produces a specification, and after any change that adds an endpoint, a cap, or a dependency.
---

# Architecture drift check

## Current routes
!`grep -rn "@router\.\(get\|post\|delete\|put\)" backend/app/routers/ | sed 's/:.*@router/ -> @router/'`

## Current limits and caps
!`grep -rn "MAX_\|_CAP\|LIMIT\|TIMEOUT" backend/app/*.py backend/app/routers/*.py | grep -v "^\s*#"`

## Backend test counts
!`for f in backend/tests/test_*.py; do echo "$f: $(grep -c '^def test_' $f)"; done`

## Frontend test counts
!`find frontend/src -name '*.test.ts*' -exec sh -c 'echo "$1: $(grep -c "it(" "$1")"' _ {} \;`

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

Report only differences. For each one, say which of these it is:

- **A documentation gap.** The code was always like this and the document is
  wrong. Correct the document and say so.
- **A real architectural change.** Something moved. It needs a numbered entry
  in the decision log in Section 7, and the person who made the change should
  say why.

Do not edit `architecture.md` without telling Imran what changed and why.
Decisions already written are never edited; a reversal is a new entry that
supersedes the old one.
