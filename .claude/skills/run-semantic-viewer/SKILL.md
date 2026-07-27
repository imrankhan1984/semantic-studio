---
name: run-semantic-viewer
description: Build, launch, drive and screenshot the Semantic Studio app (FastAPI + React/Sigma.js). Use when asked to run, start, serve, or screenshot the app, to check a change in the real running application rather than in tests, or to hit the REST API of a live instance.
---

# Running and driving Semantic Studio

FastAPI serves both the JSON API and the built React frontend from one process
on one port. The agent-facing way to drive it is
`.claude/skills/run-semantic-viewer/driver.mjs` — a dependency-free Node script
that owns the uvicorn process, calls the REST API, and drives the real UI in
headless Chrome over the DevTools Protocol. It clicks, types and screenshots.

**All paths below are relative to the repository root.** Run everything from
there; `driver.mjs` resolves the repo from its own location, but a relative
`node .claude/...` invocation does not.

## Prerequisites

Python ≥ 3.11, Node ≥ 20, and Chrome or Edge (the driver finds
`C:/Program Files/Google/Chrome/Application/chrome.exe` and the usual Linux
paths automatically; otherwise set `CHROME=<path to the binary>`).

## Setup — once

```bash
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt
npm --prefix frontend install
```

## Build — after any frontend change

The backend only mounts `frontend/dist` at `/` if that directory exists. Without
this step the API works and `/` returns 404.

```bash
npm --prefix frontend run build
```

Takes about 1.5 s. Verified output: `dist/index.html`, `dist/assets/index-*.css`
(21 kB), `dist/assets/index-*.js` (413 kB).

## Run — agent path

One command starts the server, exercises every API endpoint, drives the UI
through a real user flow, writes five screenshots, and exits non-zero on the
first failure:

```bash
node .claude/skills/run-semantic-viewer/driver.mjs smoke
```

Screenshots land in `.claude/skills/run-semantic-viewer/shots/` (git-ignored):
`01-graph.png`, `02-search.png`, `03-detail.png`, `04-query.png`,
`05-results.png`. **Open them.** A blank canvas is the failure mode this app
has headless, and the step log will not tell you about it.

What `smoke` asserts, in order — upload `examples/space-exploration.ttl`, list
the library, fetch the graph (34 nodes / 42 edges), search, fetch node detail,
fetch the query schema, run a SELECT, confirm a `CONSTRUCT` is rejected with
400, then in the browser: graph renders on WebGL, search dropdown opens,
clicking a hit opens the detail panel, Query mode turns a clicked class into
SPARQL, and Execute returns rows into the results table.

Verified run, end to end:

```
[health] ok
[upload] id=ont-9dbe084fcfde name=space-exploration.ttl triples=142
[graph] 34 nodes, 42 edges
[sparql] 5 rows in 0.9ms, vars=s,p,o, truncated=false
[sparql-guard] CONSTRUCT rejected with 400
[ui] detail panel open for http://example.org/space#Mission -> ...\03-detail.png
[ui-query] builder generated:
    | SELECT ?mission
    | WHERE {
    |   ?mission a :Mission .
    | }
[ui-results] 1 rows -> ...\05-results.png
[smoke] ALL STEPS PASSED
```

### Holding the server up

To poke at a live instance across several commands:

```bash
node .claude/skills/run-semantic-viewer/driver.mjs serve
```

Prints `up at http://127.0.0.1:8010`. Ctrl-C stops it. Then, from another shell:

```bash
node .claude/skills/run-semantic-viewer/driver.mjs api GET /api/ontologies
```

```bash
node .claude/skills/run-semantic-viewer/driver.mjs ui http://127.0.0.1:8010 my-shot
```

`api` takes `<METHOD> <path> [json-body]` and exits non-zero on a non-2xx.
`ui` navigates any URL and writes `shots/<name>.png`.

### Knobs

`PORT` (8010) · `CDP_PORT` (9222) · `DATA_DIR` · `CHROME` · `HEADFUL=1` to watch
the browser · `KEEP_DATA=1` to keep the scratch library between smoke runs.

## Run — human path

```bash
backend/.venv/Scripts/python -m uvicorn --app-dir backend app.main:app --reload --port 8000
```

Opens nothing; browse to <http://localhost:8000>. For frontend work run
`npm --prefix frontend run dev` alongside it and use <http://localhost:5173>,
which proxies `/api` to 8000 and gives you HMR. `.claude/launch.json` already
has an `app` entry on port 8000 for the in-app browser preview.

## Test

The backend suite only collects from inside `backend/` — the tests import `app`,
which is not on the path from the repository root:

```bash
cd backend && .venv/Scripts/python -m pytest tests -q
```

```bash
npm --prefix frontend run test
```

48 backend tests, 67 frontend tests, both green as of this writing. (The
frontend count in `CLAUDE.md` says 61 — it is stale.) All frontend tests are in
`src/sparql/`; no React component has one, so `smoke` is the only thing
checking that a component still renders.

## Gotchas

- **The driver writes to a scratch library, on purpose.** Every ontology the app
  loads is persisted to `%LOCALAPPDATA%\semantic-studio\ontologies`. `smoke`
  sets `SEMANTIC_STUDIO_DATA_DIR` to a temp directory and wipes it first, so it
  never adds rows to the dropdown you actually use. If you launch uvicorn by
  hand, set that variable yourself or you will pollute the real library.
- **Headless Chrome needs `--enable-unsafe-swiftshader`.** The graph is Sigma.js
  on WebGL and headless Chrome has no GPU. Without software rasterisation the
  page loads, the DOM looks correct, no error is logged — and every screenshot
  of the graph is an empty rectangle. The driver passes the flag.
- **The graph keeps moving.** ForceAtlas2 runs per animation frame under 3,000
  nodes. The driver waits 4 s after the canvases mount so the layout has settled;
  screenshot earlier and you get a hairball.
- **`proc.kill()` on a spawned uvicorn crashes Node on Windows** with a libuv
  assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`). The
  driver shells out to `taskkill /T /F` instead, which also reaps the reloader
  children that otherwise keep the port.
- **Git Bash mangles `/api/...` arguments.** MSYS rewrites a leading-slash
  argument into a Windows path, so `api GET /api/ontologies` arrives as
  `C:/Program Files/Git/api/ontologies`. The driver cuts back to the `/api`
  segment; PowerShell does not have the problem.
- **API field names do not match the obvious guess.** `/search` returns viz
  nodes, so a hit's IRI is `id`, not `iri`. `/sparql` names its column list
  `vars`, not `columns`, and the count `rowCount`.
- **The Bash tool's working directory persists between calls.** A `cd frontend`
  in one command leaves the next one there, and `node .claude/...` then fails
  with `MODULE_NOT_FOUND`. Use absolute paths or re-`cd` to the repo root.
- **`pytest backend/tests` from the repo root fails to collect** — six
  `ModuleNotFoundError: No module named 'app'`. The suite imports `app.*`, which
  only resolves with `backend/` as the working directory. `--app-dir` fixes this
  for uvicorn, not for pytest.
- **`--reload` from the repo root watches the whole repository**, `frontend/`
  included, so `npm run build` in another shell restarts the backend several
  times. Harmless, but do not mistake the churn for a crash loop.
- **Nav tabs and toolbar buttons have no id or test attribute.** The driver
  matches them by visible text (`clickText`). Selectors it depends on are
  collected in the `SEL` object at the top of `driver.mjs`; a failure there
  means a class name moved, not that the app is broken.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no venv at backend/.venv` | Run the Setup section. |
| `frontend/dist missing` | `npm --prefix frontend run build`. |
| `/` returns 404 but `/api/health` is fine | Same — `dist` was never built. |
| `no Chrome or Edge found` | `CHROME=/path/to/chrome node ... smoke` |
| `DevTools endpoint never came up` | Port 9222 is taken by a real Chrome. Use `CDP_PORT=9333`. |
| `waitFor timed out: sigma canvases mounted` | The ontology never loaded. Check the `[upload]` line above it, then open the last screenshot. |
| Screenshot of the graph is blank | SwiftShader was refused — confirm the Chrome build supports `--enable-unsafe-swiftshader`, or run `HEADFUL=1` to see the real window. |
| Port 8010 already listening | A previous `serve` survived. `netstat -ano \| findstr :8010`, then `taskkill /PID <pid> /T /F`. |
