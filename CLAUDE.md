# Semantic Studio — Working on this codebase

Instructions for anyone, human or agent, changing code in this repository.

> This file is for **implementation**. Feature specifications are written
> elsewhere by the project's analyst and arrive as markdown files. If a spec has
> been provided, it is the contract; this file is the house style.

## What this is

A self-contained web application for exploring ontologies and vocabularies in
RDF, RDFS, OWL and SKOS. Load a file, see it as an interactive force-directed
graph, inspect any entity, and build SPARQL SELECT queries by clicking rather
than typing.

| Layer | Technology |
| --- | --- |
| Frontend | React 18 + TypeScript, built with Vite |
| Rendering | Sigma.js over WebGL, graphology, ForceAtlas2 |
| Backend | FastAPI |
| RDF | rdflib, graphs held in memory |
| Packaging | Docker and Docker Compose |

Roughly 8,500 lines. One FastAPI process serves the API and, in production, the
built frontend as static files.

## Running it

Prerequisites: Python 3.11 or later, Node 20 or later.

```bash
# Backend, port 8000
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# Frontend, port 5173, proxies /api to 8000
cd frontend
npm install
npm run dev
```

Or `docker compose up --build` for the whole thing on port 8000.

Set `SEMANTIC_STUDIO_DATA_DIR` to a temporary folder when experimenting, or the
app writes into the real per-user ontology library.

## Testing

```bash
cd backend  && python -m pytest tests    # 128 tests (+1 marked `network`, deselected)
cd frontend && npm run test              # 67 tests, vitest
```

Both suites must pass before any change is considered done.

**Know the gap.** All 67 frontend tests are in `src/sparql/`. **No React
component has a test.** A change to a component is adding the first test for
that file, and should. Two visual defects reached a running application because
this gap exists.

## Conventions that are not negotiable

**1. Every source file opens with a structured header.** This is the strongest
convention in the codebase and it is applied without exception. New files get
one; changed files get theirs corrected when the summary stops being true.

```
================================================================================
FILE: backend/app/routers/queries.py
================================================================================

SUMMARY
    One paragraph: what this file is.

BASIC IDEA
    How it works, in prose.

INPUTS / INPUT SOURCES
    - Where its data comes from.

EXPECTED OUTPUT
    - What it produces.
================================================================================
```

**2. Comments explain why, not what.** Read `sparql_exec.py` or
`query_schema.py` before writing any. The density is deliberate. Match it.

**3. Do not add dependencies casually.** `frontend/package.json` carries seven
runtime dependencies and `backend/requirements.txt` carries five. Adding one is
a decision that belongs in a spec, not in a commit.

**4. SPARQL execution is SELECT-only.** `prepare_select` in `sparql_exec.py` is
a security control, not a convenience. Do not widen it without a spec that says
to, and do not remove the row cap or the wall-clock timeout.

**5. Never render ontology content as raw HTML.** No `dangerouslySetInnerHTML`
appears anywhere in this codebase and none should. Loaded files are untrusted
input.

**6. Keep the backend and the frontend honest about limits.** When the server
truncates something, it returns the true total, and the interface says so. See
the results header in `ResultsTable.tsx` for the pattern.

## Layout

```
backend/app/
  main.py            FastAPI app, CORS for the dev frontend, static mount
  store.py           In-memory ontology store, disk persistence, lazy parsing
  graph_builder.py   RDF -> visualization nodes and edges, labels, node kinds
  query_schema.py    Class-level schema powering the visual query builder
  sparql_exec.py     SELECT-only execution, row cap, wall-clock timeout
  queries_store.py   Saved visual queries, one JSON file each
  routers/           HTTP layer only; the real work lives in the modules above

frontend/src/
  App.tsx            Top-level state: ontologies, mode, selection, theme
  api.ts             Every backend call, typed
  components/        One component per file
  sparql/            Pure query-building logic, the only tested frontend code
```

Routers stay thin. If you are writing logic in `routers/`, it probably belongs
in a module.

## Skills

Project skills live in `.claude/skills/` and load automatically.

| Skill | Use for |
| --- | --- |
| `build-spec` | Implementing a specification end to end |
| `check-architecture` | Reporting drift between the architecture document and the code |
| `verify-security-fix` | Proving a security fix blocks what it claims to |
| `rdf-fixture` | Creating RDF test data |
| `perf-budget` | Measuring rendering and parsing budgets |
| `a11y-check` | Any new or changed interactive element |
| `run-semantic-viewer` | Building, launching, driving and screenshotting the running app |

`run-semantic-viewer` carries `driver.mjs`, a dependency-free harness that owns
the uvicorn process, calls the API, and drives the real UI in headless Chrome.
`node .claude/skills/run-semantic-viewer/driver.mjs smoke` is the fastest way to
prove a change works in the application rather than in the test suite.

## Known state, so you do not rediscover it

- **The three security defects S-1, S-2 and S-3 are fixed** (2026-07-27, spec
  `network-and-resource-limits`). `net_guard.py` refuses non-public addresses on
  every redirect hop, `prepare_select` refuses `SERVICE` at any algebra depth,
  and uploads are capped at 50 MB with a 60 second parse timeout. The tests that
  prove it assert a recording server saw **zero** requests, not just a 4xx — keep
  that property if you touch them.
- **One outbound path is still open: S-4.** rdflib's JSON-LD parser fetches a
  remote `@context`, so an uploaded JSON-LD file can make the server request any
  address, bypassing `net_guard` entirely (the upload path never consults it).
  Reproduced. Needs its own spec; do not patch rdflib internals casually.
- **`backend/tests/test_fetch_restrictions.py` does not restrict the network**
  despite its name. It tests GitHub Enterprise host detection and blob URL
  rewriting. Do not cite it as protection, and do not add network tests to it —
  they belong in `test_network_restrictions.py`, `test_net_guard.py` or
  `test_upload_limits.py`.
- **The upload cap is enforced twice, on purpose.** Middleware in `main.py`
  refuses a declared oversize before FastAPI parses the body; `_read_capped` in
  the router enforces the real size while reading. Removing either one removes a
  real protection — see D-015. Measured: 124 MB peak became 5 MB.
- **The graph endpoint has no cap.** It returns every node and every edge. At
  40,000 nodes that is 6.45 MB of JSON, and the browser cannot cope. Loading
  FIBO makes the interface unresponsive.
- **Accessibility is weak.** Thirteen interactive elements are exposed to
  assistive technology for the entire application. The graph, the legend rows
  and the search results are not among them. `index.css` sets `outline: none` on
  focused inputs. There is no `prefers-reduced-motion` rule. Do not add to this.

## Pull requests

Small and single-purpose. Say what changed and why, and include before and after
numbers for anything touching performance. If a change alters an endpoint, a
cap, a data shape, or a dependency, say so explicitly in the description so the
architecture document can be updated.
