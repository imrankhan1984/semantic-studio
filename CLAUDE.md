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
cd backend  && python -m pytest tests    # 169 tests (+2 marked `network`, deselected)
cd frontend && npm run test              # 306 tests, vitest
```

Both suites must pass before any change is considered done.

Five backend tests carry `@pytest.mark.perf` and hold the graph and
neighbourhood endpoints' performance budgets. Unlike `network`, they **run by default** — a budget nobody
enforces is a note in a document. Deselect them on a slow machine with
`-m "not perf"`.

**Both timed budgets take the median of five runs with `gc.disable()` around
them, and that is load-bearing.** Adding `test_neighborhood.py`'s two
40,000-node fixtures made `test_budget_cost_under_fifty_milliseconds` fail at
55.3 ms against its 50 ms limit without a line of the code it measures having
changed: five large ontologies resident is about a million GC-tracked objects,
and a collection landing inside a single-shot timing costs tens of milliseconds.
A single sample here measures how many other fixtures the suite holds. See
D-024. Do not "simplify" either test back to one `perf_counter` pair.

**Know the gap.** 67 of the 306 frontend tests are in `src/sparql/`. The rest
were added from 2026-07-27 onward and are the project's component tests. Copy
their pattern — a `// @vitest-environment jsdom` docblock per file and `vi.mock`
over `api.ts`. For anything touching the graph, either stub `GraphView` (see
`App.test.tsx`) or stub the two WebGL globals so Sigma's module can load (see
`GraphView.test.tsx`); Sigma reads `WebGL2RenderingContext` at import time and
jsdom does not define it. To reach anything *inside* GraphView, stub the `sigma`
module itself and read the settings object the constructor was handed — that is
how the node and edge reducers are tested without a WebGL context, and it tests
the shipped closures rather than an extracted copy of them.
**`Legend.tsx` and the rest are still untested.** A change to one of those is
adding the first test for that file, and should. `SourceView.test.tsx` exists
now but covers only the "view in source" target — the Original / Formatted
toggle, find-in-file, the show-more window and copy have no test.
`QueryPanel.tsx` now has a test file, but it covers one thing — that *Clear
results* empties the results without touching the query — and renders the
component with a hand-built `builder` rather than the real hook. Treat it as a
foothold, not as coverage. `LoadDialog.tsx` is covered only through
`CatalogueList.test.tsx`, which renders it to prove the catalogue matches the
start screen's — its file, URL and drag-and-drop tabs have no test.

**jsdom cannot see everything a browser can, and it fails silently when it
cannot.** Three measured examples. jsdom does not blur a focused element when it
becomes `disabled`, and will not let focus move off a disabled one either, so a
`document.activeElement` assertion about the remove control passed with the
focus fix deleted — `App.test.tsx` asserts on the `focus()` call instead and
says why. It implements neither layout nor sequential focus navigation, which is
why `CatalogueList.test.tsx` asserts the absence of `tabindex` rather than
driving Tab. And `import css from "./index.css?raw"` yields `""` unless
`test: { css: true }` is set. The first and third were each found by deleting
the fix and watching the test stay green, which is the habit to copy; the same
habit in its other form is:

**If you write a test that reads a file and asserts something is absent, assert
first that the file loaded.** vitest stubs CSS out of the module graph, so
`import css from "./index.css?raw"` returned an empty string and every negative
assertion in `focus-visible.test.ts` passed while proving nothing.
`test: { css: true }` in `vite.config.ts` is what makes that import real — do
not remove it.

**A timer scheduled by an effect that runs inside an async `act` body does not
fire before that body resolves**, however long it waits. React flushes the
passive effect as the act scope closes, so the timer is only queued at that
point. This is not a jsdom gap — it is an ordering property of `act`, and it
applies to any component that defers work with `setTimeout`. `SourceView.tsx`
does, to let a revealed line exist before scrolling to it, and
`SourceView.test.tsx`'s `settle()` therefore runs **two** act passes. One pass
leaves `scrollIntoView` at zero calls and the assertion looks like a bug in the
component. Measured 2026-07-31 against a four-line probe.

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
  sparql/            Pure query-building logic
  explore/           Pure Explore-mode logic: the suggestion ranking and the
                     ontology summary sentence
```

`sparql/` and `explore/` are the same idea twice: logic a component needs, kept
out of the component so it can be tested without rendering. `removalPrompt.ts`
and `catalogue.ts` are the same idea for one function and one constant. Prefer
this split for anything with a rule in it.

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

- **Selecting an IRI that is not a node in the drawn graph used to blank the
  whole application. Fixed 2026-07-30; both halves of the fix are load-bearing.**
  `nodeReducer` in `GraphView.tsx` called `graph.areNeighbors(selected, node)`
  unconditionally, graphology threw `NotFoundGraphError`, nothing caught it, and
  React unmounted the tree — `#root` empty until a reload. Two ordinary routes
  reached it: an `rdf:type` term link in the detail panel, which is a predicate
  and never a graph node, and **any search hit outside the node budget**, which
  stage 1 of `partial-graph-rendering` deliberately allows and marks *not drawn*.

  `focusTarget` in `GraphView.tsx` now returns null unless the node is in the
  graphology instance, and **both** reducers go through it. The edge reducer
  never threw, which is why it would have been missed: it compares rather than
  looks up, so unguarded it dimmed every edge while every node stayed lit.

  `ErrorBoundary.tsx`, wrapped around `<App />` in `main.tsx`, is the second
  half. It is the only class component in the codebase, because
  `componentDidCatch` has no hook form. It renders a dead end on purpose — the
  state that threw is still there — but it names the error and offers a reload
  instead of a white page. Verified in Chrome by rebuilding with the guard
  removed and confirming the crash screen appeared where the blank page used to
  be.

  `GraphView.test.tsx` reaches the real reducers by stubbing the `sigma` module
  with a class that records its constructor settings, so the tests exercise the
  shipped closures rather than an extracted copy. Three of them fail if the
  guard goes.
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
  MB.
- **Stage 2, expand-on-demand, is built too** (2026-07-30, same spec).
  `GET /{oid}/neighborhood?iri=&limit=` returns one entity, its highest-degree
  neighbours (200 by default, 2,000 maximum, clamped and reported) and the edges
  among that set, computed from the same cached viz. An entity outside the budget
  is now **drawn** when picked from search, and *Show its connections* on the
  detail panel grows the view from anywhere.

  Four things there are load-bearing. **The neighbourhood reaches `GraphView` on
  its own `expansion={data, token}` prop, never through `data`** — the effect
  that builds the scene is keyed on `data`, so routing it there would tear down
  every settled position, which is exactly what the merge exists to avoid. **The
  token, not the data, marks a new merge**, because expanding the same entity
  twice hands over an equal object. **The layout runs over the new nodes only**,
  by setting `fixed` on everything already drawn, running 50 iterations, then
  removing only the flags it set — a node mid-drag carries the same attribute for
  its own reasons. And **`onExpanded` reports what was actually added**, because
  only the renderer knows which returned nodes were already on the canvas; App's
  drawn counts and its live-region sentence are both built from that.

  One measurement worth not rediscovering: ForceAtlas2 copies every node's
  coordinates through a `Float32Array` and writes them all back, pinned or not,
  so an unmoved node returns quantised — `-49.99999999999998` came back as `-50`.
  `GraphView.test.tsx` asserts positions to three decimal places for that reason,
  and says so. Do not tighten it to `toEqual`.

  The limit is a plain constant, **not** an environment variable, unlike the node
  budget beside it. That asymmetry is deliberate and the reason is in
  `ontologies.py`.
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
- **The catalogue leads with FOAF, on purpose, and the order is tested**
  (2026-07-30, spec `catalogue-order`). `CATALOGUE` in `catalogue.ts` runs
  `foaf`, `schemaorg`, `fibo`, `juho`, ascending by how much the user has to
  cope with, and every entry carries a required `audience` string rendered under
  its description. FIBO led this list until then for a real reason — it is the
  richest OWL-restriction example and the primary validation target — which is a
  developer's reason, and D-002 makes the learner's reason win.
  `catalogue.test.ts` pins the id order and pins every `url` to its pre-reorder
  value, so a well-meaning reorder fails the suite, and so does a mis-paired
  name and URL. **The comment above the array is load-bearing; read it before
  touching the order.**

  Two of the four tests on `CatalogueList.test.tsx` look redundant and are not.
  `renders the audience line for each entry` reads `textContent`; `audience line
  is part of the row's accessible name` queries by *computed* accessible name.
  Put `aria-hidden` on the audience span and the first still passes while the
  second fails, which is exactly why both exist. And `tab order matches visual
  order` asserts the absence of `tabindex` rather than driving Tab, because
  jsdom implements neither layout nor sequential focus navigation; the visual
  half was measured in Chrome against bounding rectangles. Do not "strengthen"
  it into a `userEvent.tab()` loop — that would test the polyfill.

  One phantom worth not chasing: each row carries `title={entry.url}`, and some
  inspection tools display that URL as the row's label, which reads as though
  the accessible name were only a URL. Chrome computes it from **contents** —
  name-from-contents wins for a `button` — so the row announces its name,
  description, size and audience line. Measured 2026-07-30 on the built app.
- **Explore mode opens on a starting panel, not on nothing** (2026-07-30, spec
  `explore-mode-starting-point`). With an ontology open and no selection,
  `App.tsx` renders `ExploreStart.tsx` in the 380px column where `DetailPanel`
  used to return `null` before its first line of markup. It costs **no request**:
  the ranking and the summary sentence are computed from the `/graph` response
  App already holds, by the two pure functions in `explore/suggestions.ts`.

  Three things there are load-bearing. **Both functions must stay behind
  `useMemo` keyed on the graph** — App re-renders on a hover and the ranking is a
  pass over every node; `ExploreStart.test.tsx` counts the calls and fails
  without it. **`suggestedEntities` keeps the best `limit` per kind in one pass
  rather than sorting every node**, because a full sort of 40,000 nodes costs
  more than the 20 ms budget allows; the comment above it proves the candidate
  set is sufficient, so do not "simplify" it into a `sort`. And
  **`describeContents` must interpolate nothing from the ontology** — an
  unrecognised kind falls back to `KIND_LABELS.other` rather than being printed,
  and a test gives it a hostile kind key to prove it.

  Focus follows a selection made from this panel, and only from this panel. The
  flag travels with the selection through `selectAndFocus(iri, panelTakesFocus)`
  rather than living in its own state, and that is the fix for a defect the first
  implementation had: written as a counter it never reset, so a node clicked with
  the mouse after one suggestion had been used pulled focus into the panel
  heading. `App.test.tsx` asserts the graph-click case.
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
- **The query panel keeps the query on screen and pages its results**
  (2026-07-31, specs `query-results-area` and `next-steps-dropdown`, built
  together because either alone is a partial fix to the same complaint).
  `ResultsTable.tsx` renders `PAGE_SIZE = 15` rows and no more; the sort still
  runs over every row and the slice happens after it, which is the only ordering
  that lets page one show the true top rows. Measured in Chrome on FIBO: a
  1,000-row result set, the server cap, put **15** rows in the document instead
  of 1,000. `NextSteps.tsx` is a disclosure above three options and a plain open
  list at or below three — `ALWAYS_OPEN_MAX = 3`, and the old `COLLAPSED_COUNT`
  and *Show all N* toggle are gone. FIBO offers 114 options at one step, 184 at
  two and 240 at three, so the closed control is what a developer sees; the
  learner concession is for short lists and it is real, not a formality.

  **Three things here were found in a browser and cannot be found in jsdom, so
  do not trust a green suite on any of them.**

  `.query-pinned` needs `flex: none`. `.query-panel` is a flex column, and
  giving the pinned block `overflow-y` sets its automatic minimum size to zero,
  so the flex algorithm squashed it to **22px against a 109px content height** —
  a sticky empty strip, with the query scrolling away exactly as before. It also
  needs its opaque `background`; a sticky element over a scrolling table shows
  the table straight through it otherwise.

  `.next-steps-panel` is bounded in `vh`, not the `%` the spec asked for.
  `.next-steps` is an auto-height block, so a percentage max-height on its child
  resolves to `none` and bounds nothing. Measured open on FIBO: 245px against a
  2,373px content height.

  **The disclosure carries an explicit `aria-label`.** With a `title` on it, an
  inspection tool announced the title instead of the contents; with the title
  removed it announced nothing at all. The count is an acceptance criterion, so
  it is stated outright and the test asserts the visible text and the spoken
  name agree. This is the `CatalogueList` phantom in a form that actually bit:
  do not assume name-from-contents survives every consumer.

  One further thing worth copying rather than rediscovering. `ResultsTable`
  moves focus off a pagination control that the press has just disabled — press
  *Last* and focus lands on *Previous*. AC-12 asks for focus to stay on the
  control pressed, which is impossible for the press that reaches the end of the
  range, and the alternative is the documented blur-to-`<body>` above.
- **Every result row leads somewhere, in two directions** (2026-07-31, spec
  `result-navigation`). Clicking a URI chip already selected the entity; what it
  did not do was draw one the node budget had left out, so a query returning any
  entity in the ontology could select something the canvas could not show and
  move the camera nowhere. `selectFromOutsideGraph` in `App.tsx` is now the one
  route for both the search box and the results table — they had drifted apart
  once already, which is exactly why they share a function now. **Do not add
  `builder.addNode` to it**: that half belongs to search alone, because clicking
  a result is inspecting an answer and a chip that quietly extended the query
  would be a trap. `App.test.tsx` asserts both halves.

  **The camera fix in `GraphView.tsx` is `partial-graph-rendering` stage 2's,
  not this spec's, and it is the thing most worth knowing here.** Focus is
  requested at the moment of selection, when the entity is not yet in the graph,
  so the camera effect bails on `hasNode` and the request is simply lost —
  nothing honoured it afterwards. Measured in Chrome: 5 of 34 nodes became 8 of
  34 and **the view did not move**. The merge now calls `centerOn` when the
  selection is in `addedNodes`. Conditioned on what the merge *added*, never on
  what is drawn: *Show its connections* grows the view around an entity the user
  has already centred, and re-running the camera there would zoom a view they
  arranged.

  A 404 from `/neighborhood` is now a polite notice, not the red error bar. It
  is what the endpoint says about every predicate and every blank node, which is
  an ordinary thing to reach. Telling it from a real failure is why `api.ts`
  throws `ApiError` with the HTTP status; **do not match on the message text**,
  which works until the message is reworded.

  **`sourceTarget.ts` is where the "view in source" rule lives**, out of the
  component so a 2 MB scan can be timed without measuring jsdom — 1.9 ms median
  over 30,394 lines against a 50 ms budget. Two things in it were found by
  loading a real file and cannot be found any other way. A match must not be
  followed by a character that continues an RDF name, or `:Mars` matches
  `ns1:Mars2020`; and a prefixed form arriving **without** a colon gets one back,
  because `namespace_manager.qname` shortens a term in the default namespace to
  a bare local name, so the backend sends `Mars` and searching for that lands on
  `rdfs:label "Mars 2020"`. It is `indexOf` throughout and must stay that way:
  the needle is ontology-controlled text and a `RegExp` built from it would let
  an uploaded file choose which line the reader is sent to.

  `ResultsTable` is wrapped in `React.memo` and that is load-bearing rather than
  decorative: an expansion sets App state three times over and every one of
  those renders `QueryPanel` again, under the cursor of someone reading the
  table. It only bites while all four props keep their identity, which is why
  `QueryPanel` hands over a `useCallback` for `onClear` — measured at 60 reads
  of `term.value` without the memo and 0 with it.

  Two smaller things. `SourceView` has a heading now, `#source-view-heading`,
  because focus has to land somewhere when the mode changes under the user and
  the pane had nothing naming it. And `App.tsx` clears `sourceTarget` whenever
  the mode is picked from the tab bar — without that, leaving View and coming
  back re-runs the lookup and steals focus from the tab just pressed.

  **AC-9 is honoured literally and there is a better answer available.** The
  target is the *first* line mentioning the entity, which on pretty-printed
  Turtle is often a reference to it from elsewhere (`:targets :Mars`) rather than
  its own declaration (`:Mars a :Planet`). That is what the spec asks for and it
  lands on a true occurrence. Preferring the subject position would be better and
  belongs in a version row of its own, not in a quiet edit.
- **The node budget moves in both directions, and the bar survives a fully
  drawn graph** (2026-07-31, spec `show-less`). `GraphNotice.tsx` used to open
  with `if (!stats.truncated) return null`, so pressing *Show more* until the
  whole ontology was drawn **deleted the entire bar** — counts, dismiss control
  and all — at the moment the user most wanted to reduce. The condition is now
  `if (!stats.truncated && !canReduce) return null`. That is the load-bearing
  edit; three tests fail without it.

  *Show less* halves what *Show more* doubles, so the sequence up is the
  sequence back down, and both step from `stats.budget` — what the server
  **granted** — rather than from what was asked for, because above the ceiling
  those differ. **The floor is learned, never declared.** App captures the
  `stats.budget` of the first response for an ontology, which is by definition
  the server's default including `SEMANTIC_STUDIO_GRAPH_NODE_BUDGET`. Writing
  2,000 into the client would silently ignore that variable. Verified in Chrome
  with the budget set to 5: the disabled title read *5 entities is the smallest
  view*, and the round trip 5 → 10 → 20 → 40 → 20 → 10 → 5 made exactly one
  request per press.

  **Two things here cannot be found in jsdom.**

  `allDrawn` and `atMaximum` can be true at once — ask for 32,000 of FIBO's
  18,717 and the server clamps to 20,000 *and* returns everything. `allDrawn` is
  checked first because the reason *Show more* is dead is the ontology, not the
  ceiling.

  And **pressing either control unmounts the notice**, because App sets
  `graphData` to null while the refetch is in flight. So focus is on `<body>`
  before anything is disabled, and nothing inside the component survives to put
  it back — which is why the instruction is a `restoreFocus` prop from App,
  handed over only when the new graph arrives. Set at click time it reaches a
  bar still showing the old counts and clears itself before the real one mounts.
  This is *not* the `saved-query-deletion-warning` defect, though that one is
  real too and the partner-focus rule handles it. *Show more* has had the same
  unremarked focus loss since `partial-graph-rendering` stage 1.

  One measured non-defect, so it is not chased twice: the moved focus draws the
  global `:focus-visible` ring after a keyboard activation and **not** after a
  real pointer press — D-022's divergence again. No scoped focus rule was added.
  Focus moves one button to the right, beside the control just pressed, on a bar
  whose text visibly changed; that is not D-022's "focus landed on a row showing
  nothing".

  **The spec's Section 5 is wrong about expansions** and Section 16 of that file
  records it. It promises that reducing the budget leaves entities added by
  *Show its connections* in place. Every budget refetch has always discarded
  them — the comment above `setExpansion(null)` in `App.tsx` says so — and
  preserving them would need one request per expansion, contradicting the same
  spec's one-request budget.

## Pull requests

Small and single-purpose. Say what changed and why, and include before and after
numbers for anything touching performance. If a change alters an endpoint, a
cap, a data shape, or a dependency, say so explicitly in the description so the
architecture document can be updated.
