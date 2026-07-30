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
cd backend  && python -m pytest tests    # 161 tests (+2 marked `network`, deselected)
cd frontend && npm run test              # 147 tests, vitest
```

Both suites must pass before any change is considered done.

Three backend tests carry `@pytest.mark.perf` and hold the graph endpoint's
performance budget. Unlike `network`, they **run by default** — a budget nobody
enforces is a note in a document. Deselect them on a slow machine with
`-m "not perf"`.

**Know the gap.** 67 of the 147 frontend tests are in `src/sparql/`. The rest
were added from 2026-07-27 onward and are the project's component tests. Copy
their pattern — a `// @vitest-environment jsdom` docblock per file and `vi.mock`
over `api.ts`. For anything touching the graph, either stub `GraphView` (see
`App.test.tsx`) or stub the two WebGL globals so Sigma's module can load (see
`GraphView.test.tsx`); Sigma reads `WebGL2RenderingContext` at import time and
jsdom does not define it. **`QueryPanel.tsx`, `Legend.tsx`, `SourceView.tsx`
and the rest are still untested.** A change to one of those is adding the first
test for that file, and should. `LoadDialog.tsx` is covered only through
`CatalogueList.test.tsx`, which renders it to prove the catalogue matches the
start screen's — its file, URL and drag-and-drop tabs have no test.

**jsdom cannot see everything a browser can, and it fails silently when it
cannot.** Two measured examples, both found by deleting the fix and watching the
test stay green. jsdom does not blur a focused element when it becomes
`disabled`, and will not let focus move off a disabled one either, so a
`document.activeElement` assertion about the remove control passed with the
focus fix removed — `App.test.tsx` asserts on the `focus()` call instead and
says why. And `import css from "./index.css?raw"` yields `""` unless
`test: { css: true }` is set. The habit that catches both is the same one:

**If you write a test that reads a file and asserts something is absent, assert
first that the file loaded.** vitest stubs CSS out of the module graph, so
`import css from "./index.css?raw"` returned an empty string and every negative
assertion in `focus-visible.test.ts` passed while proving nothing.
`test: { css: true }` in `vite.config.ts` is what makes that import real — do
not remove it.

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
- **S-4 is fixed too** (2026-07-27, spec `parser-initiated-requests`). rdflib
  fetches a remote JSON-LD `@context` while parsing, which let an uploaded file
  choose where the server connected. `net_guard.install_rdflib_guard()` replaces
  `rdflib._networking._urlopen` *and* `rdflib.parser._urlopen` — both, because
  the latter imports the name directly — with a version that judges each
  redirect hop and caps the body. It is installed once at import in `store.py`.
  This patches a private function of a third-party library: `UNIT-4` asserts the
  guard is still installed, so an rdflib upgrade that moves it fails the suite
  rather than silently removing the protection. See D-016.
- **`backend/tests/test_fetch_restrictions.py` does not restrict the network**
  despite its name. It tests GitHub Enterprise host detection and blob URL
  rewriting. Do not cite it as protection, and do not add network tests to it —
  they belong in `test_network_restrictions.py`, `test_net_guard.py` or
  `test_upload_limits.py`.
- **The upload cap is enforced twice, on purpose.** Middleware in `main.py`
  refuses a declared oversize before FastAPI parses the body; `_read_capped` in
  the router enforces the real size while reading. Removing either one removes a
  real protection — see D-015. Measured: 124 MB peak became 5 MB.
- **The graph endpoint is capped** (2026-07-27, spec `partial-graph-rendering`,
  stage 1). `GET /{oid}/graph?limit=N` returns the N highest-degree nodes, ties
  broken by node id, and only edges whose both ends survived. The default is
  2,000 (`SEMANTIC_STUDIO_GRAPH_NODE_BUDGET`), the maximum is 20,000, and a
  request above it is clamped and the clamped value reported rather than
  refused. `stats` carries `nodeTotal`, `edgeTotal`, `truncated` and `budget`
  beside the drawn counts. `kindCounts` deliberately still counts the **whole**
  ontology — see D-017; a test asserts the mismatch so nobody "fixes" it.
  Measured: a 40,000-node ontology at FIBO's density fell from 18.98 MB to 0.607
  MB. **Stage 2, expand-on-demand, is not built.** An entity outside the budget
  is findable by search and marked *not drawn*, but cannot yet be drawn.
- **Accessibility is weak, but focus is now visible** (2026-07-27, spec
  `visual-defects`). `index.css` carries a global `:focus-visible` rule —
  `outline: 2px solid var(--accent)` — and the `outline: none` that used to
  suppress it on inputs and selects is gone. `focus-visible.test.ts` fails if
  either changes back. Do not add a per-component focus rule; the global one
  covers it.

  **One documented exception, and it is not a licence for others.**
  `.start-screen [data-start-focus]:focus` in `index.css` draws a ring on the
  row the chooser moves focus to on mount. Measured in Chrome 2026-07-29:
  script-driven focus **does** match `:focus-visible` on a fresh page load, but
  **does not** once the last interaction was a pointer — so pressing *Close this
  ontology* with the mouse landed focus on a row showing nothing.
  `:focus-visible` excludes that case by design and no global rule can reach it.
  `StartScreen.tsx` sets the marker when it takes focus and drops it on blur.
  See D-022. If you need a focus rule anywhere else, you almost certainly do not.

  What is still missing is keyboard **reach**, which a focus ring is not. Around
  twenty interactive elements are exposed to assistive technology for the whole
  application — the chooser added several, but the graph, the legend rows and
  the search results are still not among them, so the *not drawn* marker on a
  search result sits in a row a keyboard user cannot get to, and it has nothing
  to show a ring on. There is still no `prefers-reduced-motion` rule. All of
  that is backlog X-1. Do not add to it.
- **The application opens on a chooser and renders nothing until asked**
  (2026-07-29, spec `startup-chooser-screen`). `App.tsx` no longer selects the
  most recent ontology on mount: `activeId` stays `null`, `StartScreen.tsx`
  fills the main area, and the mode tabs are disabled. Mount makes **exactly
  one** request, `GET /api/ontologies`, and `App.test.tsx` fails if a second
  appears. Both ways back to the chooser — *Close this ontology* and removing
  the active one — set `activeId` to `null` rather than falling back to another
  entry. `CatalogueList.tsx` is shared by the chooser and the Load dialog so
  backlog L-1's reordering lands on both; do not inline a second copy.
- **Removing an ontology says how many saved queries go with it** (2026-07-30,
  spec `saved-query-deletion-warning`). The cascade in `DELETE
  /api/ontologies/{oid}` is unchanged and still deliberate — a re-loaded file
  gets a fresh id, so a retained query would point at nothing — but the response
  now carries `deletedQueries`, counting what was actually deleted rather than
  what was listed. `App.tsx` fetches the count before opening the dialog and
  reports the server's figure afterwards in a polite live region.
  `removalPrompt.ts` owns the wording and is a separate module for one reason:
  `null` means *unknown* and must not collapse into `0`, and that is testable
  without rendering `App`. Do not rewrite its branch as a falsy check. **The
  zero case must keep today's exact sentence** — a warning shown every time is a
  warning nobody reads, and `removalPrompt.test.ts` asserts the string.

  One browser-only finding from that build, worth knowing before adding any
  other busy control: disabling a focused button blurs it to `document.body`,
  and re-enabling does not give focus back. Measured in Chrome 2026-07-30 on the
  built application. `App.tsx` restores it in an effect — not in a line after
  `setRemoving(false)`, because React has not re-rendered at that point and
  `focus()` on a still-disabled button does nothing.

## Pull requests

Small and single-purpose. Say what changed and why, and include before and after
numbers for anything touching performance. If a change alters an endpoint, a
cap, a data shape, or a dependency, say so explicitly in the description so the
architecture document can be updated.
