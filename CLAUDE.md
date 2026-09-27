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

Roughly 26,000 lines of source and as many again of tests. One FastAPI process
serves the API and, in production, the built frontend as static files.

## Running it

Prerequisites: Python 3.11 or later, Node 20 or later.

```bash
# Backend, port 8000
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt  # Windows; runtime + pytest, pyyaml
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
cd backend  && python -m pytest tests    # 429 tests (+2 marked `network`, deselected)
cd frontend && npm run test              # 650 tests, vitest
```

Both suites must pass before any change is considered done, and locally both
run everything, budgets included.

**CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to
`main`. Four jobs block: `backend-linux` (Python 3.12, the Docker image's),
`backend-windows` (Python 3.14), `frontend` (`npm run test:ci`, `tsc -b`,
`vite build`) and `docker` (`docker build .`). `budgets` only reports. A build
is not done until CI is green on its pull request.

**Timing budgets are separated, not deleted.** Eleven backend tests carry
`@pytest.mark.perf`; nine frontend tests have `[budget]` in their title. CI runs
them only in `budgets` (`-m "perf and not network"`, `npm run test:budgets`).
A command-line `-m` *replaces* `pytest.ini`'s `-m "not network"`, so always name
`network` again. Count-based budgets (renders, calls) are not timings and stay
in the blocking jobs. A new wall-clock assertion gets the `[budget]` tag.

**Timed budgets take a median, and that is load-bearing.** Backend: median of
five with `gc.disable()` around them (D-024); a single sample measures how many
other fixtures the suite holds. Frontend: jsdom gives no hold on the collector,
so a median of at least seven after a warm-up. Do not "simplify" either back to
one sample.

**Copy the component-test pattern:** a `// @vitest-environment jsdom` docblock
per file and `vi.mock` over `api.ts`. For the graph, stub `GraphView` (see
`App.test.tsx`), stub the two WebGL globals (`GraphView.test.tsx`), or stub the
`sigma` module and read the settings its constructor was handed, which tests
the shipped reducers. **Untested:** `Logo.tsx`, `PathBar.tsx`, `icons.tsx`, the
Legend's colours, `SourceView` beyond its target, `LoadDialog`'s tabs, and
`QueryPanel` beyond a foothold. A change to one adds its first test.

**jsdom fails silently where a browser would not.** It does not blur a focused
element that becomes `disabled`; it has no layout and no sequential focus
navigation; `import css from "./index.css?raw"` is `""` without
`test: { css: true }` (keep it). If a test asserts something is absent from a
file, assert first that the file loaded. A timer an effect schedules inside an
async `act` body fires only after a second act pass (`SourceView.test.tsx`'s
`settle()`). Delete the fix and watch the test go red: that is the habit.

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
  local_guard.py     Refuses requests not from the app's own page (Host, header, Origin)
  net_guard.py       Outbound address judgement; hands rdflib's own network calls to the broker
  network_broker.py  The one door out: capability grants, offline, pinning, activity log
  imports.py         owl:imports: resolution chain, closure, cache, MergedView
  sparql_service.py  SERVICE blocks found, approved, and sent through the broker
  vocab/             Bundled vocabularies, pinned by SHA-256 in manifest.json
  store.py           In-memory ontology store, disk persistence, lazy parsing
  graph_builder.py   RDF -> visualization nodes and edges, labels, node kinds
  query_schema.py    Class-level schema powering the visual query builder
  sparql_exec.py     SELECT-only execution, row cap, wall-clock timeout
  embedded_queries.py  SPARQL stored in the file (SHACL, SPIN), listed never run
  queries_store.py   Saved queries, visual or text, one JSON file each
  hierarchy.py       subClassOf / broader / subPropertyOf forests for the tree view
  docs_export.py     The documentation-site zip (with docs_assets/)
  provenance.py      Activity records for exports
  routers/           HTTP layer only; the real work lives in the modules above

frontend/src/
  App.tsx            Top-level state: ontologies, mode, selection, theme
  api.ts             Every backend call, typed
  components/        One component per file
  sparql/            Pure query-building logic
  explore/           Pure Explore-mode logic: the suggestion ranking and the
                     ontology summary sentence
  home/              Pure home-screen logic: the card thumbnail's layout and
                     the composition bar's bands

docs/known-state.md  Why each load-bearing rule below exists
```

`sparql/`, `explore/` and `home/` are the same idea three times: logic a
component needs, kept out of the component so it can be tested without
rendering. `removalPrompt.ts`, `sourceTarget.ts`, `networkWords.ts` and
`catalogue.ts` are the same idea for one function and one constant. Prefer this
split for anything with a rule in it.

Routers stay thin. If you are writing logic in `routers/`, it probably belongs
in a module.

## Load-bearing rules

Each line is a rule that was broken once or measured to matter. The reason is
in `docs/known-state.md`; the bracket is a phrase to search for there. Read it
before undoing a rule, and add a line here and an entry there when a build
leaves one behind.

**Security and network**
- Only `network_broker.py` connects out; policy is asked before any name resolves. [outbound connection]
- The broker connects to the judged address (`_pinned_url`), the name in `Host` and SNI. [outbound connection]
- Workers run in `contextvars.copy_context()`, or a just-once grant never reaches them. [outbound connection]
- The broker's `total_timeout` reads unchunked. [SERVICE]
- Never read rdflib's `service_string`; blocks come from `find_service_blocks` and `match_blocks`. [SERVICE]
- The SERVICE handler never raises `NotImplementedError`; that sends local rows as `VALUES`. [SERVICE]
- The scanner reads `expandUnicodeEscapes(query)`; `parseQuery` gets the raw query. [SERVICE]
- `local_guard` is added last in `main.py`; every mutating `api.ts` call spreads `CLIENT_HEADER`. [own page]
- Backend `TestClient`s use `base_url="http://localhost"` and the client header. [own page]
- `install_rdflib_guard` patches both `_urlopen`s, and UNIT-4 asserts it. [S-4]
- The upload cap is enforced twice: middleware and `_read_capped`. [enforced twice]
- Network tests assert a recording server saw zero requests, not only a 4xx. [S-1, S-2]
- `test_fetch_restrictions.py` restricts nothing; network tests go elsewhere. [test_fetch_restrictions]
- The About panel's "stay on this machine" sentences change with any feature that sends content out. [About panel]

**Queries and imports**
- `MergedView` deduplicates and prunes by subject. [owl:imports]
- Vocabulary files stay `binary` in `.gitattributes`, or their hashes fail. [owl:imports]
- An import needing approval never stops the closure; one 409 names every host. [owl:imports]
- Builder state is never written while the query is text; the live text is in `textRef`. [written as text]
- The editor's key is `editorSession`, the same across the fork. [written as text]
- The saved-query id is checked twice: request model and the store's `_path`. [written as text]
- `ResultsTable` stays `React.memo`, fed a `useCallback` `onClear`. [leads somewhere]
- `sourceTarget.ts` uses `indexOf`, never a `RegExp` built from ontology text. [leads somewhere]
- A 404 is told by `ApiError.status`, never by message text. [leads somewhere]
- `selectFromOutsideGraph` serves search and results; no `builder.addNode` in it. [leads somewhere]
- `.query-pinned` keeps `flex: none` and a background; `.next-steps-panel` is bounded in `vh`. [keeps the query]

**Graph**
- Both reducers go through `focusTarget`; `ErrorBoundary` stays around `<App />`. [used to blank]
- `kindCounts` counts the whole ontology, not what is drawn (D-017). [graph endpoint is capped]
- A neighbourhood reaches `GraphView` on `expansion={data, token}`, never through `data`. [expand-on-demand]
- The merge lays out new nodes only, and centres on a selection only if it added it. [expand-on-demand, leads somewhere]
- Positions are asserted to three decimals; ForceAtlas2 quantises. [expand-on-demand]
- `GraphNotice` hides only when `!truncated && !canReduce`, and has no dismiss. [both directions]
- The budget floor is learned from the first `stats.budget`, never written in. [both directions]
- Reduced motion settles by time, before `new Sigma`; `matchMedia` is read once per mount. [Keyboard reach]
- The graph is not node-navigable (D-025); toolbar tab order stays document order. [Keyboard reach]
- The selection ring is drawn in the hover overlay, keyed on a `selected` flag checked before hover. [pastel]
- Node-reducer performance tests are counts, not timings. [pastel]
- Zoom's disabled state is a three-value edge; the camera listener is removed on cleanup. [zoom controls]

**Screens and focus**
- One global `:focus-visible` rule; the start-screen marker is the only exception (D-022). [focus is now visible]
- Mount makes exactly one request; the home screen makes none to `/graph`. [card grid]
- `CatalogueList` is shared by Home and the Load dialog; its `memo` sits at Home's import. [card grid]
- The catalogue order is deliberate; read the comment above `CATALOGUE`. [leads with FOAF]
- Explore's ranking and sentence stay behind `useMemo`; the ranking never sorts every node. [starting panel]
- `describeContents` interpolates nothing from the ontology. [starting panel]
- `removalPrompt`: `null` is not `0`, and the zero case keeps its exact sentence. [saved queries go]
- Focus a disabled control drops is restored in an effect or given to its partner. [saved queries go]
- Miniatures are deterministic SVG scaled by one factor, never Sigma. [card grid]
- The home layout switches on the whole library, not the filtered count. [card grid]
- `.onto-menu[hidden] { display: none }` stays. [card grid]
- `summary()` reads `meta.get("card")`; nothing backfills a sketch. [card grid]
- Touch one `KIND_LABELS[kind]` or `kindColor` lookup, touch all four (X-6). [card grid]
- The About backdrop is the dialog's sibling; its key handler is on `document`. [About panel]
- The Hierarchy detail panel lives in `App.tsx`; property forests hold only `subPropertyOf` ends. [Hierarchy view]

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

## Pull requests

Small and single-purpose. Say what changed and why, and include before and after
numbers for anything touching performance. If a change alters an endpoint, a
cap, a data shape, or a dependency, say so explicitly in the description so the
architecture document can be updated.
