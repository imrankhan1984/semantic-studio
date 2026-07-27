---
name: verify-security-fix
description: Proves a security fix actually blocks what it claims to block, by running the attack against a live instance. Use when working on S-1 URL fetch restrictions, S-2 SPARQL SERVICE, S-3 upload limits, or any change to network access or resource limits.
---

# Verify a security fix

A test that asserts a 400 status is not proof. Prove the request never left the
process, or that the work never started.

## Setup

Run the app in-process with an isolated data directory so nothing touches a real
library. Set `SEMANTIC_STUDIO_DATA_DIR` to a temporary path **before** importing
`app.main`, then drive it with `fastapi.testclient.TestClient`. Importing first
and setting the variable afterward will use the real library, which is a mistake
worth avoiding.

## S-1, URL fetch reaching internal addresses

1. Start a local HTTP server on `127.0.0.1` that records every request it
   receives and serves a valid Turtle file.
2. Post that URL to `/api/ontologies/fetch`.
3. **Assert two things:** the response is refused, *and* the recorder saw zero
   requests. The second assertion is the real test.
4. Repeat for `localhost`, a private range address, `169.254.169.254`, and a
   host on the public internet that redirects to a loopback address. The
   redirect case is the one that breaks naive fixes, because the check must run
   again after every hop.

Note for anyone reproducing this in a sandbox: outbound traffic may be forced
through a proxy by `ALL_PROXY` and friends, which makes loopback unreachable and
can make a broken app look protected. Clear those variables for the test, or the
result is meaningless.

## S-2, SPARQL SERVICE

Same recorder. Post this to the SPARQL endpoint:

    SELECT ?s WHERE { SERVICE <http://127.0.0.1:PORT/sparql> { ?s ?p ?o } }

Assert refusal and zero recorded requests. Also assert that a normal SELECT
still runs, so the fix has not broken query execution. Reject at the parsed
algebra, not by matching the word SERVICE in the query text; string matching is
defeated by comments, casing, and whitespace.

## S-3, upload limits

1. Post a file larger than the limit. Assert it is refused **and** that peak
   memory did not grow by the file size, which means the limit is applied while
   reading rather than after.
2. Post a file that parses slowly. Assert the timeout fires and the process
   still answers `/api/health` afterward.

## Before you finish

- Add every case above as a permanent test in `backend/tests/`.
- Do not add them to `test_fetch_restrictions.py`. That file's name already
  overpromises; it tests GitHub Enterprise name detection and blob URL
  rewriting. Create `test_network_restrictions.py` instead.
- Update the state column in Section 7 of `AGENTS.md` from Not met to Met, and
  add a decision log entry in `architecture.md` if the fix changed a boundary.
