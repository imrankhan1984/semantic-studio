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
| Rendering | Sigma.js over WebGL, graphology, ForceAtlas2; the modeling canvas on React Flow, lazily loaded (D-086) |
| Backend | FastAPI |
| RDF | rdflib, graphs held in memory |
| Packaging | Docker and Docker Compose |

Roughly 40,000 lines of source and 30,000 of tests. One FastAPI process
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

The Windows release (D-119) is a zip built by `.github/workflows/release.yml`
with `release/build.py`: python.org's embeddable Python, the packages, `app`,
the built frontend and `Start Semantic Studio.cmd`, which runs
`python\python.exe -B -m app.launcher`. Its smoke test, `release/smoke.py`,
runs on Linux too against a tree built without `--embed`:
`python release/smoke.py <tree> --python backend/.venv/bin/python`.

Set `SEMANTIC_STUDIO_DATA_DIR` to a temporary folder when experimenting, or the
app writes into the real per-user ontology library.

## Testing

```bash
cd backend  && python -m pytest tests    # 2425 tests (+2 marked `network`, deselected)
cd frontend && npm run test              # 2272 tests, vitest
```

Both suites must pass before any change is considered done, and locally both
run everything, budgets included.

**CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to
`main`. Four jobs block: `backend-linux` (Python 3.12, the Docker image's),
`backend-windows` (Python 3.14), `frontend` (`npm run test:ci`, `tsc -b`,
`vite build`) and `docker` (`docker build .`). `budgets` only reports. A build
is not done until CI is green on its pull request.

**Timing budgets are separated, not deleted.** Fifty-three backend tests carry
`@pytest.mark.perf`; twelve frontend tests have `[budget]` in their title. CI runs
them only in `budgets` (`-m "perf and not network"`, `npm run test:budgets`).
A command-line `-m` *replaces* `pytest.ini`'s `-m "not network"`, so always name
`network` again. Count-based budgets (renders, calls) are not timings and stay
in the blocking jobs. A new wall-clock assertion gets the `[budget]` tag.

**Timed budgets scale by `BUDGET_FACTOR`.** Every millisecond limit goes
through `limitMs` (`frontend/src/budget.ts`) or `limit_ms`
(`backend/tests/budget.py`): 1 by default, 2 in the CI `budgets` job. Ratios
and byte counts are not scaled. A new timed budget uses them.

**Timed budgets take a median, and that is load-bearing.** Backend: median of
five with `gc.disable()` around them (D-024); a single sample measures how many
other fixtures the suite holds. Frontend: jsdom gives no hold on the collector,
so a median of at least seven after a warm-up. Do not "simplify" either back to
one sample.

**Copy the component-test pattern:** a `// @vitest-environment jsdom` docblock
per file and `vi.mock` over `api.ts`. For the graph, stub `GraphView` (see
`App.test.tsx`), stub the two WebGL globals (`GraphView.test.tsx`), or stub the
`sigma` module and read the settings its constructor was handed, which tests
the shipped reducers. **Untested:** `Logo.tsx`, `SourceView`
beyond its target, and
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

**3. Do not add dependencies casually.** `frontend/package.json` carries eight
runtime dependencies and `backend/requirements.txt` carries ten (pySHACL the
sixth, D-092; openpyxl and defusedxml for Excel, D-100; owlrl, already there
through pySHACL, made direct for reasoning, D-102; truststore for the
operating system's certificates, D-123, imported by `network_broker.py`
alone). Adding one is
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
  launcher.py        The Windows release's entry point (D-119): the port, a running
                     copy reused only at its own version (D-130), 127.0.0.1
                     only, the browser, three sentences
  version.py         The one reader of the release's VERSION.txt, read once;
                     "development" without one (X-15)
  local_guard.py     Refuses requests not from the app's own page (Host, header, Origin)
  net_guard.py       Outbound address judgement; hands rdflib's own network calls to the broker
  network_broker.py  The one door out: capability grants, offline, pinning, activity log;
                     the proxy, the trusted certificates and Test connection (D-123)
  imports.py         owl:imports: resolution chain, closure, cache, MergedView
  sparql_service.py  SERVICE blocks found, approved, and sent through the broker
  vocab/             Bundled vocabularies, pinned by SHA-256 in manifest.json;
                     QUDT 3.5.2 the twelfth and largest (E-12)
  examples/          The library's bundled entries (D-111): two Turtle files
                     and manifest.json, each entry's group an example or a
                     reference; FOAF and QUDT are vocab/ files themselves;
                     questions/, eight pinned .rq files (D-118)
  library_examples.py  Seeds the four bundled entries once, under fixed ids;
                     examples.json in the data folder makes a removal stick;
                     restore; attaches each entry's group and ready-made
                     questions when listed
  references.py      Vocabularies reused by prefix (D-121, D-128): which a
                     document has in use (its declared prefixes, read from
                     its text), the term index built from the bundled files
                     or a kept copy and cached by hash, search, and the
                     Apply check
  vocabularies.py    The vocabularies a document uses and the one way one is
                     added (D-128): the list, the imported-or-reused rule,
                     inspect, the registry of what it read, and add_lines,
                     the only writer of owl:imports
  store.py           In-memory ontology store, disk persistence, lazy parsing;
                     every derived view keyed on the revision (D-081)
  parse_errors.py    A failed load in one plain sentence (D-112): the line,
                     the format, the raw parser text kept apart
  loads.py           The loads running now, by the browser's id; a cancel's
                     mark, which store.add reads before it writes (D-115)
  projects.py        Project folders and manifests: create, list, rename,
                     duplicate, trash, export; per-project saved queries;
                     a project's files (D-131): ids, the folder index, the
                     path rules of 8.3, New file, Move, Remove, folders
  editing.py         The only mutator of a project document: commands, undo,
                     Turtle apply, save rule, autosave, recovery; every file
                     of a project, the lock order, the cross-file refusal;
                     grouped steps across files, a term's uses (D-133),
                     Move to file
  modeling_checks.py The 5.9 checks: refusals and warnings, in plain words;
                     the hierarchy-move warning across files (E-17)
  templates/         The three New project templates, Turtle with placeholders
  graph_builder.py   RDF -> visualization nodes and edges, labels, node kinds
  query_schema.py    Class-level schema powering the visual query builder
  sparql_exec.py     SELECT-only execution, row cap, wall-clock timeout
  embedded_queries.py  SPARQL stored in the file (SHACL, SPIN), listed never run
  shacl.py           Validation on demand with pySHACL: one panel per shape, sentences
  reasoning.py       Reasoning on demand (D-102 to D-104): the spawned run, Stop,
                     the limits, what is shown, problems, and the explainer
  reasoning_worker.py  The reasoner process's body: OWL-RL and the probe run;
                     the only importer of owlrl
  shapes_form.py     A SHACL shape as the form reads it, read-only parts, suggestions
  queries_store.py   Saved queries, visual or text, one JSON file each
  query_export.py    One library ontology's saved queries as a zip of .rq
                     files and a README, for the removal dialog (D-122)
  tabular.py         A CSV file or a workbook's sheet read for the data import:
                     dialect detected, the fixed limits (2,000 rows, D-098),
                     the Excel defences (D-100), the copy written
  rml.py             The RML subset: written, read (refused outside it), run (D-099)
  snapshots.py       Data snapshots in data/<sid>/: import, refresh, switch,
                     remap, edit as RML, remove; the graphs the views join
  lexical.py         What fits an XML Schema type, shared by editing and the import
  sentences.py       The one a/an rule and the one verb rule every server sentence
                     uses; modeling/sentences.ts holds the same two (X-12)
  hierarchy.py       subClassOf / broader / subPropertyOf forests for the tree view
  docs_export.py     The documentation-site zip (with docs_assets/)
  provenance.py      Activity records for exports
  settings.py        The three limits Settings → Limits changes (D-120): every
                     read at call time, the ranges, an environment variable
                     winning, settings.json in the data folder; and its
                     second section, Settings → Naming's namespace (D-124)
  naming.py          The one address rule (D-124): artifact, term and data
                     addresses under https://w3id.org/<namespace>/, built
                     from their parts and read back; frontend naming/ the same
  checks.py          The design checks (D-124): the own-term rule and the one
                     standard-vocabulary list, ss:own and ss:term, the runner,
                     the sentences, the measures and the level; the hints,
                     the review aids (read aloud, definitions, questions)
  checks/            The 31 pinned SELECT files, the 12 hints' (H1 to H12)
                     and manifest.json
  standard_terms.py  The standard-term catalogue's one reader (D-126): a
                     home-made copy of a standard axiom matched by name and
                     refused; standard_terms.json is the data it owns
  routers/           HTTP layer only; the real work lives in the modules above

frontend/src/
  App.tsx            Top-level state: ontologies, mode, selection, theme
  api.ts             Every backend call, typed
  components/        One component per file
  state/             projectStore.ts, the useSyncExternalStore store for
                     authoring state (D-084); App's own state is not in it
  sparql/            Pure query-building logic
  explore/           Pure Explore-mode logic: the suggestion ranking, the
                     ontology summary sentence, and the graph's one label
                     overlap rule (labelBoxes.ts, D-110)
  reasoning/         Pure reasoning words: status lines, headings, endings and
                     when a result is stale (reasonSentences.ts)
  explain/           Pure In plain words logic (D-114): the detail panel's
                     sentences (explainSentences.ts) and the one glossary
                     of standard terms (glossary.ts)
  home/              Pure home-screen logic: the card thumbnail's layout
                     (no longer drawn, U-17), the composition bar's
                     bands, and the one library's
                     order, your work first and the examples last
                     (libraryOrder.ts)
  projects/          Pure New project form logic: the two kinds, defaults
                     and validation
  modeling/          Pure editing-form logic: an entity's blocks read out of
                     its statements, annotation value types and checks, and
                     the sentences a relationship reads as (sentences.ts),
                     the words for uses in other files (usesWords.ts),
                     and the data wizard's words and choices
                     (dataSentences.ts, dataChoices.ts)
  links.ts           linkTarget: the one gate an IRI passes to become a link
  theme/             kinds.ts, the one kind palette every tab draws from
                     (D-109), and contrast.ts, the WCAG ratio its tests use
  loadWords.ts       The Load dialog's step sentences, the expected time,
                     a Cancel's two endings, and the load id (load-progress)
  statusWords.ts     The status bar's words: Home's count, format names,
                     and statementCount, the one place *statements* is said
  limitWords.ts      Settings → Limits' words and its one rule: which typed
                     text is a value, and what a Save sends (D-120)
  naming/            The address rule (address.ts, with address.table.json,
                     the one table both sides test) and Settings → Naming's
                     words (words.ts) (D-124)
  checks/            Pure Checks report logic: the groups' order, the
                     measures' words, staleness, where a finding leads
  vocabularies/      Pure Vocabularies words (words.ts, D-128): a row's
                     status and source, its use, its menu, the dialog's tabs
  files/             Pure Files panel logic (multi-file-projects, D-131): the
                     name rule (names.ts, with names.table.json, the one
                     table both sides test), the tree's order and words
                     (tree.ts), and the tab strip's rows and the remembered
                     tabs (tabs.ts, D-132)
  connectionWords.ts Settings → Network's Connection words: the system proxy,
                     the trust, the file, and what a Save sends (D-123)
  referenceWords.ts  The Turtle editor's line for a reference term it does
                     not know, with the closest match (reference-ontologies)
  canvas/            The modeling canvas (D-086): ModelCanvas on React Flow,
                     its boxes and relate menu, its legend and tip card
                     (CanvasAids.tsx), the colour tokens by kind
                     (kindColours.ts, D-107), and the pure layered layout,
                     relate rule and line curves; loaded only through
                     React.lazy in App

release/             The Windows release: the start file, README.txt,
                     THIRD-PARTY.txt, build.py and smoke.py (D-119)

docs/known-state.md  Why each load-bearing rule below exists
```

`sparql/`, `explore/`, `home/`, `projects/`, `modeling/`, `reasoning/`, `explain/`, `naming/`, `checks/`, `vocabularies/` and `files/` are the same idea eleven times: logic a
component needs, kept out of the component so it can be tested without
rendering. `removalPrompt.ts`, `sourceTarget.ts`, `networkWords.ts`, `connectionWords.ts`, `statusWords.ts`, `limitWords.ts`, `referenceWords.ts`,
`links.ts` and `catalogue.ts` are the same idea for one function and one constant. Prefer this
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
- The broker connects to the judged address (`_pinned_url`), the name in `Host` and SNI, unless a proxy carries the request. [outbound connection]
- Through a proxy the original URL goes as it is (no pinned address, `Host` or `sni_hostname`), and only after D-070's name rules: a name resolving here to a non-public address never reaches the proxy (D-123). [Corporate network]
- The system proxy is `getproxies()` read at each request, after the policy gate, never cached, and the system's bypass list (`proxy_bypass`) holds; `conftest.py` makes it `{}` for every test. `trust_env=False` stays on the broker's client: httpx would otherwise take `HTTPS_PROXY` itself, past *No proxy*. [Corporate network]
- Trust is `truststore.SSLContext` with the user's file added by `load_verify_locations`, built per request; only `network_broker.py` imports truststore, and `test_network_settings.py` scans `app/` for any way to switch verification off. [Corporate network]
- The connection settings are `network-policy.json`'s, written by `network_broker.py` alone, never `settings.json`; a certificate file holding `PRIVATE KEY` is refused. [Corporate network]
- Workers run in `contextvars.copy_context()`, or a just-once grant never reaches them. [outbound connection]
- A limit is read at call time from `settings.py`, never cached at import; `test_settings.py` scans for any other reader of its variables (D-120). [Settings limits]
- A limit set by an environment variable is never changed from the page: the PUT is 409, and either size variable makes *Largest file* read-only (D-120). [Settings limits]
- The broker's `total_timeout` reads unchunked. [SERVICE]
- Never read rdflib's `service_string`; blocks come from `find_service_blocks` and `match_blocks`. [SERVICE]
- The SERVICE handler never raises `NotImplementedError`; that sends local rows as `VALUES`. [SERVICE]
- The scanner reads `expandUnicodeEscapes(query)`; `parseQuery` gets the raw query. [SERVICE]
- `local_guard` is added last in `main.py`; every mutating `api.ts` call spreads `CLIENT_HEADER`. [own page]
- Backend `TestClient`s use `base_url="http://localhost"` and the client header. [own page]
- `install_rdflib_guard` patches both `_urlopen`s, and UNIT-4 asserts it. [S-4]
- The upload cap is enforced twice: middleware and `_read_capped`; the certificate file's 1 MB too, middleware and the route's count. [enforced twice]
- Network tests assert a recording server saw zero requests, not only a 4xx. [S-1, S-2]
- `test_fetch_restrictions.py` restricts nothing; network tests go elsewhere. [test_fetch_restrictions]
- The About panel's "stay on this machine" sentences change with any feature that sends content out. [About panel]
- Every `href` goes through `linkTarget` (http and https only); `links.test.ts` scans for one that does not (D-088). [safe links]

**Windows release**
- The launcher binds `127.0.0.1`, its own socket handed to uvicorn, and the binding scan covers it (`test_deployment_binding.py`); it takes no `--host` (D-119). [Windows release]
- The launcher's own requests go by `http.client` to `127.0.0.1`, never `urllib`, which reads Windows' proxy; a recording proxy sees zero (AC-9). [Windows release]
- The release never writes inside its own folder: `-B` in the start file, bytecode compiled at build, work in the data folder; smoke step 7 lists the folder. [Windows release]
- The release workflow never publishes, it drafts; `test_release_workflow.py` scans for any way to publish and for the hash check. [Windows release]
- `PYTHON_VERSION` is the exact patch with `backend-windows`'s minor, and `PYTHON_EMBED_SHA256` moves with it. [Windows release]
- The launcher opens a running Semantic Studio only at its own `version()`; any other, or none, opens nothing and starts nothing (D-130). `version.py` is the one reader of `VERSION.txt`, and smoke step 1 holds health to the folder's. [running version]

**Queries and imports**
- No `async` route parses or builds on the event loop; that work goes through `run_in_threadpool` (`test_load_cancel.py` scans). [off the event loop]
- A cancelled load writes nothing: `store.add` checks its mark after the download and the parse, and `commit()`s under the lock `cancel()` takes, before the first write (D-115). [off the event loop]
- `MergedView` deduplicates and prunes by subject. [owl:imports]
- Vocabulary files stay `binary` in `.gitattributes`, or their hashes fail. [owl:imports]
- The example files are `binary` too and pinned in `examples/manifest.json`; change a file and its hash together, and a changed hash replaces the entry under its fixed id. [Home and examples]
- Examples are seeded in the app's lifespan, never at import, and a failure there never stops the server; `examples.json` makes a removal stick, and only `POST /api/examples/restore` brings one back. [Home and examples]
- An import needing approval never stops the closure; one 409 names every host. [owl:imports]
- Builder state is never written while the query is text; the live text is in `textRef`. [written as text]
- The editor's key is `editorSession`, the same across the fork. [written as text]
- The saved-query id is checked twice: request model and the store's `_path`. [written as text]
- An exported query's entry name keeps only letters, digits, spaces, hyphens and underscores, and its comment lines no control character; the export's id is matched before any lookup (D-122). [Query export]
- `ResultsTable` stays `React.memo`, fed a `useCallback` `onClear`. [leads somewhere]
- `sourceTarget.ts` uses `indexOf`, never a `RegExp` built from ontology text. [leads somewhere]
- A 404 is told by `ApiError.status`, never by message text. [leads somewhere]
- `selectFromOutsideGraph` serves search and results; no `builder.addNode` in it. [leads somewhere]
- `.query-pinned` keeps `flex: none` and a background; `.next-steps-panel` is bounded in `vh`. [keeps the query]
- A search answer is applied only if it is the latest; the request it replaces is aborted (CF-4). [latest search]
- Query's four switches are independent toggles with `aria-pressed`, never a single-choice control. [Explore and Query layout]
- A parser's message reaches a person only through `parse_errors.py`; the raw text is shown only as text, under *Technical details* (D-112). [Load and Shapes]
- The sentence explains the attempt of the format the file claims to be, else the furthest; a message the table knows counts as a sign of RDF. [Load and Shapes]
- A timed-out query is stopped from outside, on a thread of its own, and only while armed in its query, never inside a SERVICE call, and resent, as a finaliser can swallow one; its end is its thread's end; the worker holds the read lock, and the timeout starts once it has it (D-108). [stopped from outside]

**Sentences**
- One a/an rule and one verb rule per side, `sentences.py` and `modeling/sentences.ts`, tested with one table; no module defines its own (`test_sentences.py`, `sentences.test.ts` scan). [one a/an rule]
- A standard term's definition lives in `explain/glossary.ts` alone; a SKOS mapping's in `MAPPINGS` (D-114). [explain panel]
- The explain block's kind is `node_kind`, the graph's, never `term_kind`; its words go through `modeling/sentences.ts`, a property's label never read as a verb. [explain panel]

**Authoring**
- Every `Ontology` cache is `(key, value)` keyed on the revision; the library stays at revision 0. [authoring foundations]
- Only `editing.py` mutates a project document; `test_no_direct_mutation.py` enforces it. [authoring foundations]
- A project id or document name is `fullmatch`ed before it is a path; one not issued is 404 on every route. [authoring foundations]
- The editor's unapplied text lives in the project store; App asks before any exit. [authoring foundations]
- The project store is module state: a test rendering App calls `cleanup()`. [authoring foundations]
- Authoring controls are `aria-disabled`, not `disabled`, so focus is never dropped. [authoring foundations]
- `pick_label` tests the exact `en` tag before the prefix match. [authoring foundations]
- `_change` leaves a triple that is in both adds and removes; setting a value to itself deletes nothing. [authoring foundations]
- Views read a project document inside `Ontology.reading()`, the lock edits take. [authoring foundations]
- App reads the project store by selector; the editor's text must not re-render App. [authoring foundations]
- An undo `Step` is compared by identity (`eq=False`); the save point is a step, not a depth. [save point is a step]
- A step keeps the editor text on both sides; undo restores `before`, redo `after`. [save point is a step]
- `DetailPanel` keeps its details across a revision refetch; clearing them drops the form's focus. [keeps its details]
- A tree row's `⋯` is `aria-hidden` and not a tab stop; the row declares Shift+F10. [row menu]

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
- The label boxes are cleared on `beforeRender`, and `explore/labelBoxes.ts` is the only overlap rule (D-110). [Explore and Query layout]
- `graph_builder.py` reads restrictions only through `axioms.py`, once per blank node; `axioms.draws_line` is the canvas's test too (D-113). [Explore rules]
- A rule edge is keyed by its `key`: two rules can join the same two classes. [Explore rules]

**Modeling canvas**
- Only `canvas/` imports `@xyflow/react`, and App reaches `canvas/` only through `React.lazy` (D-086). [modeling canvas]
- The canvas imports React Flow's `base.css`, never `style.css`: the full theme hides the focus ring on a box. [modeling canvas]
- One handle per side and `ConnectionMode.Loose`: stacked source and target handles reversed a drawn line. [modeling canvas]
- Every fetch takes the server's layout as the base, with only unsaved moves on top: a rename moves its entry there (D-087). [modeling canvas]
- A layout write is never a model change: no revision, no dirty flag, no undo step. [modeling canvas]
- The canvas view's cache is keyed on the imports view as well as the revision. [modeling canvas]
- A position leaves the canvas's unsaved set only when its save has succeeded; `place()` marks it too. [lost drop point]
- `projectStore.close()` awaits every registered flush; the canvas registers its layout save. [lost drop point]
- The layout's `generation` is the server's alone; a response older than the last successful save gives no positions. [layout generation]
- `ProjectStore` serves layouts from memory after the first read: opening a just-replaced file costs ~130 ms on Windows. [layout generation]

**Relationships and kinds**
- A line completing a relationship is one `SetEnds`, never `SetDomain` then `SetRange`. [Relationships and project kinds]
- After a line makes a relationship, focus goes to the canvas surface, not a box: focusing a box selects it. [Relationships and project kinds]
- A loop leaves a box's upper right, clear of the side's middle where other lines leave. [Relationships and project kinds]
- The tree lists every property only for a project document, and only the document's own (`own`), never an import's. [Relationships and project kinds]
- A kind change writes the manifest only and decides which tools show first; nothing is read-only by kind (D-127). [Relationships and project kinds]
- The first concept in a document without a scheme brings one, in the same undo step (D-127). [SKOS and OWL together]
- A branch relationship's two halves are a grouped step of two (D-127, D-133): undo of either takes every lock, shapes first, and applies both, or refuses in D-127's words (`by_role`). [SKOS and OWL together, Links between files]
- A branch rule is read only in its exact shape; any other `sh:node` stays read-only (D-127). [SKOS and OWL together]
- A project's Turtle is parsed with its base IRI, relative IRIs written onto it, never resolved against the server's folder (CF-8). [Stage B]
- The modeling checks read a hierarchy in one predicate scan, never one store lookup per node. [Stage B]
- Top concepts are kept by the commands in the same undo step, never marked by hand (D-091). [Stage B]
- A characteristic's checkbox shows the model, not the click: a refusal leaves it unticked. [Stage B]
- A selected line's highlight clears on a change of selection only; a line's label is a click on its line. [Stage B]
- The chaining rule compares violations before and after a change: one written in Turtle warns, it never blocks another change. [chaining rule]
- A warning carries its `block` and stands under it; only a warning a change brings is announced. [chaining rule]

**SHACL**
- pySHACL runs with inference, Advanced Features, JavaScript and `owl:imports` off; a test asserts each (D-092). [SHACL validation]
- The data checked is a plain `Graph`, never a `Dataset`: on a dataset rdflib follows a constraint's `FROM`, past the broker. [SHACL validation]
- A refused run is repeated shape by shape, a blank-node shape under a temporary IRI: one broken shape never hides the others. [SHACL validation]
- `sh:in` text is written plain, never `^^xsd:string`: `sh:in` compares terms, and Turtle's text is plain. [SHACL validation]
- The first shape command is checked against an empty shapes document before `shapes.ttl` is made, under the service lock. [SHACL validation]
- A shape command takes the shapes document's lock, then the model's; every reader of both takes them in that order. [SHACL validation]
- In Shapes mode `activeId` stays the model's and only the store's `activeDoc` is `shapes.ttl`. [SHACL validation]
- The Shapes list keeps its selection by id while the list does not hold it: undo and redo of a create, a list still on its way. [SHACL validation]
- Shapes shows *Results* and marks its tab by watching the result, never the running flag: a quick run starts and ends within one render. [Load and Shapes]
- The Shape tab's form stays mounted, `hidden`, under *Results*: unmounting it lost a rule's edits to Validate. [Load and Shapes]
- The rule editor sends back every field it does not show, and an untouched `sh:in` list exactly. [SHACL validation]
- What counts as an example is `examples.py`'s alone: an individual of a model class, `owl:NamedIndividual` or not; the form, the tree and the commands ask it. [example data]
- The tree's Examples section keeps its own expansion: a class IRI is in two forests, and sharing the set opened both. [example data]
- A validation that outlives its project is ignored, result, announcement and failure alike; one check runs at a time. [example data]
- The Small template ships starter shapes (D-095); a test needing a Small project without them uses `test_editing.py`'s `bare`. [example data]

**Data snapshots**
- The engine stops at row 2,000 itself (`rml.run`); `MAX_ROWS` is no setting (D-098). [Data snapshots]
- An edited mapping's `rml:source` is checked before anything is kept; the engine never opens a file. [Data snapshots]
- A value that does not fit its type is a plain literal, never ill-typed; the rules are `lexical.py`'s (D-097). [Data snapshots]
- `source.csv` is written by the server in the mapping's dialect, so RMLMapper gives the app's statements. [Data snapshots]
- Snapshot actions move the generation, never the revision; the model's views key on the two summed. [Data snapshots]
- Data joins the read views with the imports switch off too; commands and the canvas keep `merged()`. [Data snapshots]
- A snapshot's individual is read-only: `fromData` is checked beside `importedFrom`. [Data snapshots]
- `data.ttl` is read by `read_ntriples`, rdflib the fallback: the open budget depends on it. [Data snapshots]
- The card's `data` line is written from the folders when the project is closed. [Data snapshots]
- The data routes check the project and snapshot before the body: an id not issued is 404. [Data snapshots]
- The wizard uses a class reading only for the class and id it was read for, and every exit past step 3 asks. [Data snapshots]
- A workbook's entries are read in chunks before openpyxl opens it, never with `ZipFile.read`: a lying entry inflates whole. [Excel workbooks]
- openpyxl parses through defusedxml or the workbook is refused; a sheet's rows come from its parser, never `iter_rows`. [Excel workbooks]
- `tabular.py` sets `OPENPYXL_LXML=False` before openpyxl is imported; the guard checks the parser functions, never `DEFUSEDXML` alone. [Excel workbooks]
- Step 1 applies only the latest inspect reply, and Next waits while one is on its way. [Excel workbooks]
- A sheet that gives no table is refused with the sheets and its rows (`detail.workbook`), so the pickers stay. [Excel workbooks]
- Step 1's pickers stay mounted while a file is read again, and are rendered conditionally, never `hidden`. [Excel workbooks]
- Links to no row are counted when asked, against the switched-on snapshots, never stored. [Excel workbooks]

**Reasoning**
- The reasoner runs in a `spawn` process on every platform, killed at 30 s or on Stop; only `reasoning_worker.py` imports `owlrl` (D-102). [Reasoning]
- The worker gives blank nodes back under the labels it was sent, and the server parses its answer with `_SameLabels`: else a restriction's conclusions name blank nodes the server never had. [Reasoning]
- A statement with a literal subject stays in the worker: N-Triples cannot carry it. [Reasoning]
- A result's names come from the stated facts only: OWL-RL copies labels across `owl:sameAs`. [Reasoning]
- No answer carries a `urn:semantic-studio:probe:` IRI; `test_reasoning.py` reads every route for one (D-104). [Reasoning]
- A result is current only for its revision, generation and imports view; the tree and the canvas drop its marks themselves, before their refetch lands. [Reasoning]
- Tree rows are keyed and focused by their path (`row.key`), never the id: a node under two parents is two rows. [Reasoning]
- A pair concluded both ways is shown one way, by IRI order, never by set order. [Reasoning]
- Whether the reasoner uses a rule is decided only by `axioms.unused_by_reasoner`, measured against the engine; the form, the canvas, H1 and the reasoning result read it, and nothing is refused for it (D-129). [Rules the reasoner does not use]
- The rules the reasoner does not use are counted in the main process, never in the worker; the summary carries `unused` only for a finished run. [Rules the reasoner does not use]

**Rules on a class**
- A restriction is read only in one of 5.8's exact shapes; anything else is its Turtle, read-only, and no command rewrites it (D-105). [Rules on a class]
- A rule is named by its content and matched in the document's own graph; none is `NoSuchRule` (404), never a near match. [Rules on a class]
- CheckInData never touches a statement already in shapes.ttl: a qualified rule is its own property shape, a plain one joins the form's rule only when nothing disagrees. [Rules on a class]
- The canvas reads rules only for classes a predicate scan finds with them: asking every class doubled the 10,000-statement view. [Rules on a class]
- A rule line's id carries its key: two rules can join the same two boxes. [Rules on a class]
- Disjointness is `owl:disjointWith` or `owl:AllDisjointClasses`, read through `axioms.disjoint_with`/`disjoint_pairs`; a group is read-only Turtle. [AllDisjointClasses counts]
- The relate menu and a relationship's pointer start a rule through `projectStore.ruleDraft`; the rule is written in the form (D-078). [Rules on a class]

**Sharing a property**
- Only `axioms.py` reads a domain's objects, through `domain_of`; `editing.py` writes them. `test_axioms.py` scans for any other read (D-116). [one reader of a domain]
- No command writes a second `rdfs:domain`: the standards read two as *both*. Sharing is a union of named classes or a shared parent (D-116). [one reader of a domain]
- A union is never left with one member: UnshareDomain from two writes the plain domain, and replacing or clearing a domain takes the union's blank nodes. [one reader of a domain]

**Reference ontologies**
- A term list is reused by its prefix and a `dcterms:requires`; a vocabulary with rules is imported (D-128, superseding D-121's *never*). [Reference terms, Vocabularies and ontologies]
- A reference ontology is in use when the document declares a prefix bound to its namespace, read from the document's text, never from its graph (rdflib binds `foaf:` in every graph) and never because of `dcterms:requires`; `clean()` writes a declared reference prefix back, and the project's own at creation and in `clean()`. [Reference terms]
- The reference index is built from a bundled file or a copy Add a vocabulary kept, never from the network, cached in memory and in the data folder by SHA-256 (a library copy's key moving with its file), and never sent whole to the browser. [Reference terms, Vocabularies and ontologies]

**Vocabularies**
- `vocabularies.add_lines` is the only code that writes `owl:imports`, called by `AddVocabulary` and New project; `test_projects.py`'s AST scan allows nothing else and proves it catches a planted writer (D-128). [Vocabularies and ontologies]
- The server decides imported or reused from the copy (5.4's rule, no size limit); the browser never sends it; `LARGE_STATEMENTS` (20,000) changes the sentence only. The manifest's `statements` and `rules` are recounted from each bundled file by a test. [Vocabularies and ontologies]
- A command's prefix is `Change.declare`/`undeclare`, written into the document's declarations before `_push`: undo restores the text byte for byte. [Vocabularies and ontologies]
- A step adding or removing an `owl:imports` resolves again with `allow_network=False`, outside the locks; never the network. [Vocabularies and ontologies]
- The list never counts `owl:imports` or `dcterms:requires` statements as use, nor rdflib's default bindings as declared. [Vocabularies and ontologies]
- A web address reaches the broker only as `ontology:import`, through `vocabularies.inspect_url`; a recording server sees zero requests before approval and while offline. [Vocabularies and ontologies]
- A placed term is the layout's `placed`, drawn per request: no revision, no dirty flag, no undo step (D-087); the prune on open keeps its position. [Vocabularies and ontologies]
- A test that inspects a file removes `vocabularies.json` afterwards: the run shares one data folder. [Vocabularies and ontologies]
- A namespace from a file is held to `vocabularies.iri_ok` where it enters (`describe`), at Add, and in `keep_prefixes` before a PREFIX line is written: rdflib keeps an IRI holding `>` and a newline. [Turtle cannot hold]

**OWL or RDFS for each class**
- A class is typed `owl:Class` or `rdfs:Class`, never both: CreateClass and SetClassType write one. Its kind is `axioms.kind_of`, the document's own typing first, for the commands and `/node` alike (D-117). [OWL or RDFS for each class]
- No command writes a rule, a disjointness or an equivalence about an RDFS class, on either side of a pair (`_owl_only`), nor a rule pointing to one (`_owl_filler`); Remove stays allowed. [OWL or RDFS for each class]
- The manifest's `classType` is written only by `_remember_class_type`, only on a change: no revision, no dirty flag, no undo step. [OWL or RDFS for each class]
- SetClassType's dry run and its change read `axioms.owl_about` once, together; a class named in another class's OWL list (a union domain, a disjoint group, a disjoint union) or rule is refused, never rewritten. [OWL or RDFS for each class]

**Query page**
- Only an explicit run (Execute, Run, Ctrl+Enter, a starter, a question) moves the camera to the results or draws hidden ones; an Auto re-run moves the rings only (D-118). [graph shows the answers]
- A ready-made question is told by its example's record (`source === "example"`, `example`), never by its name; questions are attached when listed, never stored. [graph shows the answers]

**Design checks and naming**
- A check is a pinned SELECT in `checks/`, run through `execute_select` (`prepare_select`, row cap, timeout); a file whose hash moved is refused (D-124). [Design checks]
- Above `CHECKS_MAX_STATEMENTS` (10,000, a fixed constant in `checks.py`, not a setting) the report runs no query and scans no statement: `checks.run` returns `overCap {statements, cap}` and null measures, every check still listed for *Open as a query*; the count-based `test_ac12a_over_the_cap` proves QUDT runs none (D-125). [Design checks]
- Only own terms are checked: `STANDARD_NAMESPACES` in `checks.py` alone, asked through `ss:own`; a project owns its model, shapes and data bases; `test_checks.py` scans for another list. [Design checks]
- The report runs only when Checks is chosen: `ChecksView` mounts on the switch, never before; zero `/checks` requests otherwise. [Design checks]
- A FILTER's order buys nothing in rdflib; a nested group or a one-row subquery is what cuts rows first. [Design checks]
- A check that compares terms with each other reads one row per term and pairs them in Python, never a SPARQL join of a term with its siblings: H9's pairs never finished 200 children in 30 s. [H9 reads one row per class]
- One address rule: `naming.py` and `naming/address.ts`, tested with one table (`naming/address.table.json`). [Design checks]
- The namespace never renames an existing IRI: read at each New project only; a project keeps the parts it was made with. [Design checks]
- Shapes and examples mint at their own base only when the manifest names `shapesBaseIri` and `dataBaseIri`; without them the templates render byte for byte as before. [Design checks]
- A project's View is `.project-view`, the overlay; the Turtle editor inside it is a flex child, never a second overlay over the switch. [Design checks]
- A hint (H1 to H12) is a pinned SELECT too, a question at the level Hint after the other two; a group's level is the worst of its findings' (`_worst`), and its word lists are `manifest.json`'s. [Design checks, Stage B]
- H2 and H3 read the current reasoning result the router hands in; `checks.py` imports neither `reasoning` nor `editing`, and a group with a `note` is never shown as Passed. [Design checks, Stage B]
- `checks.prepare()` runs in the lifespan, never at import, in its own `try`: a failure costs the first report's speed, never the server. [Design checks, Stage B]
- A read-aloud tick writes the manifest only, through `projects.edit_manifest`: no revision, no dirty flag, no undo step (AC-14); the route matches the project before it reads its 16 KB body. [Design checks, Stage B]
- A saved query run as a competency question never holds SERVICE (`sparql_exec.asks_a_service`): the report runs on this computer. [Design checks, Stage B]
- A check's *open* scrolls the nearest scrolling ancestor, never `scrollIntoView`, which took the whole app off its header. [Design checks, Stage B]

**Standard terms**
- A home-made copy of a standard axiom is refused by every door, with no way past; `standard_terms.py` is the only reader of the catalogue (D-126). [standard terms]

**Multi-file projects**
- A file's id is the manifest's (`model`, `shapes`, `f` and eight hex), matched in full and never a path; only the manifest's path is joined, through `projects.inside`, which resolves it inside the project folder and refuses a link or a junction on the way (D-131). [Multi-file projects]
- Every name typed and every path found passes `segment_error` and `folder_parts`; `files/names.ts` is the browser's copy, both held to `files/names.table.json`. [Multi-file projects]
- `*.original.ttl` and `*.layout.json` are reserved names: the folder index would read Save's backup as a file of its own and put every term in the project twice. [Multi-file projects]
- The manifest is written at open only when the index found or dropped a file: a project made before E-16 opens with `project.json` byte for byte as it was (AC-1). [Multi-file projects]
- Every change takes every file's lock in the 8.4 order (`_all_locks`: shapes files first, then the others, each in manifest order); a view holds its own file's lock only, which is enough because every change holds them all. [Multi-file projects]
- A file's views key on its revision and the siblings' key, the files' epoch and the sum of their revisions; the epoch moves when a file is added, moved or removed, as a sum alone comes round again. [Multi-file projects]
- Every whole-project revision both sides compare (validation, reasoning, Checks, the views' keys) is the sum plus the server's `revisionShift`, sent with the open and every file change and never counted in the browser: a removal or a rename leaves a bare sum unmoved. [Multi-file projects]
- The comments question is asked once per file: `commentsWarned` stands for model.ttl and shapes.ttl, any other file is listed in `commentsWarnedDocs`. [Multi-file projects]
- At the project folder `model.ttl` is kept for an ontology or vocabulary file and `shapes.ttl` for a shapes file; a removed file's saved queries move to the project's first ontology file. [Multi-file projects]
- A change to a term another file defines is refused twice: by `SUBJECT_ARGS` before the handler, and by `_cross_file_change` on the delta after it; a new command that changes a term names its subject argument there. [Multi-file projects]
- Drafts are `.draft/<id>` in the project folder, never beside a nested file; recovery parses every draft before it changes any file, all or none. [Multi-file projects]
- Export and duplicate never follow a link: `os.walk(followlinks=False)` and a copy that skips links. [Multi-file projects]
- A folder's rename changes paths only, in one manifest write: every file under it keeps its id, and so its statements, undo history, unsaved changes and layout; each open file is told its new path under every lock. [Tabs and a folder's rename]
- A tab is a file the person opened (`openDocs`), never the project's file list; closing one discards nothing, and the last tab keeps no close button while the page shows a file. [Tabs and a folder's rename]
- Only the active file's unapplied editor text is `editorDraft`; every other file's is `editorTexts`, and the two are moved between in `switchDocument` alone, never on a keystroke (the editor's text must not re-render App). Leaving the page or the project asks about every tab's text. [Tabs and a folder's rename]
- A Files row is two lines and its name is never cut: no ellipsis on `.files-name`. [Tabs and a folder's rename]

**Links between files**
- A change across files is one grouped step (D-133): a `Step` in each touched file sharing `group`, its `members` held by identity; undo or redo of any applies every member under every lock, refuses while one is not on top of its own history, and drops a member whose sibling is gone for good. [Links between files]
- RenameIri starts only in the file that defines the term; `_cross_file_change` is not loosened. The other files' rewrite is the service's, inside the same command and locks, never a command run in those files. [Links between files]
- A delete and a Turtle Apply name other files' `uses` and change none of them; a rename names the data snapshots and counts the saved queries that use the old address, changing neither. [Links between files]
- A draft's sidecar names its unsaved groups and the siblings each needs; a save refreshes the other drafts' claims, so a member already on disk needs no draft. Recovery restores a group or none. [Links between files]
- A draft and its sidecar are each written to a temporary name and `os.replace`d, the sidecar carrying the draft's SHA-256; recovery drops a draft whose sidecar is missing, unreadable or for another text, never restores it alone, and trusts one with no hash (written before CF-14). A test's `_crash` joins a running timer. [Draft and sidecar]
- With uses elsewhere, *Deprecate instead* is the delete dialog's first button and holds the focus (ConfirmDialog's `focus`): Enter never deletes. [Links between files]
- A hierarchy move compares where the term sits before and after, in every file; branch rules are read only through `shapes_form.branch_under`, ranges and fillers only through `axioms.class_uses`. The warning is the command's answer (`warnings`, `block`, `about`), kept as the store's `moveWarnings` and said there, so every door warns alike; it never refuses. [Links between files, PR 2]
- DC-30 and DC-31 are `_COMPUTED`: which file holds a statement comes from `whole`'s `files` and `outside`, never the merged graph; a finding carries `doc`, and the opener goes to that file. [Links between files, PR 2]
- MoveToFile is the service's, under every lock: `_cross_file` refuses it outside the defining file, the target's half is never held to `_cross_file_change`, its prefixes go through `Change.declare`, and undo restores both texts byte for byte. Its only door is the edit section's button (D-078). [Links between files, PR 2]

**Screens and focus**
- One global `:focus-visible` rule; the start-screen marker is the only exception (D-022). [focus is now visible]
- No font size outside the six `--fs-*` tokens, 12 px the smallest; `styles.test.ts` scans `index.css`. [Portal foundations]
- No rule sets `color: var(--accent)`: accent text is `--accent-text`; buttons keep `--accent`; `.chip-index` digits are `--accent-contrast`; the gutter has no opacity; `styles.test.ts` measures every light `.sparql-*` colour. [Portal foundations]
- The button set is `:where()` rules, and the plain `button` rule sets no font or padding: element specificity outranks the set. [Portal foundations]
- Removal starts only in a Home card's menu; its ⋮ is `aria-disabled` while counting, and Home refocuses when the card goes. [Portal foundations]
- Home's start focus is `focus({ preventScroll: true })`. [Portal foundations]
- Mount makes two requests, the ontology list and the project list; the home screen makes none to `/graph`. [card grid, authoring foundations]
- Home shows no catalogue and downloads nothing: the examples are library entries (D-111); `CatalogueList` is Settings → Library's alone. [Home and examples, Home and header]
- The catalogue order is deliberate, and FOAF is not in it because it is a bundled example; read the comment above `CATALOGUE`. [leads with FOAF, Home and examples]
- An example is told by `source === "example"` and its `example` record, never its name, and always follows the person's work (`home/libraryOrder.ts`). [Home and examples]
- A bundled entry's group (*Example* or *Reference*) is the manifest's, attached when listed, never stored; examples come before references on Home. [Reference library]
- A person reads *statements*, never *triples*; `wording.test.ts` scans the source, and code names keep `triples`. [Home and examples]
- `.onto-card` never clips: its "⋮" menu is longer than a card. [Home and examples]
- The Load dialog's key handler is on `document`, wraps Tab with `wrapTab`, and leaves every key to a modal open over it; past the wizard's step 3 Escape asks. Its opener is taken at the first render, before autoFocus moves focus. [Load and Shapes]
- In Query the legend starts folded and writes nothing; App keys it on the mode, so Explore reads its kept choice again. [Load and Shapes]
- Explore's ranking and sentence stay behind `useMemo`; the ranking never sorts every node. [starting panel]
- `describeContents` interpolates nothing from the ontology. [starting panel]
- `removalPrompt`: `null` is not `0`, and the zero case keeps its exact sentence. [saved queries go]
- Focus a disabled control drops is restored in an effect or given to its partner. [saved queries go]
- A card draws no graph thumbnail; Home is cards only, and a saved layout choice is ignored. [Home and header]
- Home renders no context row; every other page keeps it. [Home and header]
- `.onto-menu[hidden] { display: none }` stays. [card grid]
- `summary()` reads `meta.get("card")`; nothing backfills a sketch. [card grid]
- No kind colour is written outside `theme/kinds.ts` (`index.css` mirrors the Edit page's, checked by `kindColours.test.ts`); `theme/kinds.test.ts` scans every source (D-109). [Portal foundations]
- Every lookup by kind is own-key: `kindLabel`, `kindColor`, `nodeColor`, `edgeColor`, never `KIND_LABELS[kind]` (X-6). [Portal foundations]
- `classType` colours a class; its `kind` stays `class`. [Portal foundations]
- The About backdrop is the dialog's sibling; its key handler is on `document`. [About panel]
- The Load dialog and Settings → Library load through one `useLoadRun`; Settings keeps both panels mounted, `hidden`, so a look at Network never cancels a load. [Home and header]
- The Edit side panel lives in `App.tsx`, the detail panel inside it; property forests hold only `subPropertyOf` ends. [Hierarchy view, Edit page]

**Edit page**
- An outline section clips its content; open sections have a 120 px minimum and are capped at their rows. [Edit page]
- One draft, in the project store: the canvas box and the side panel's form share its name; the store makes it in one command. [Edit page]
- Cancel gives focus back where a draft began, or to the control now standing there (`data-create-from`), never the page. [Edit page]
- What a draft made takes focus on its box whether the refetch lands before the result or after; `focusBox` retries until the box holds focus, as React Flow draws a new node hidden. [Edit page]
- `index.css`'s kind tokens and `canvas/kindColours.ts` say the same values; `kindColours.test.ts` checks both themes. [Edit page]
- `HierarchyView` never imports from `canvas/`: App reaches `canvas/` only through `React.lazy`. [Edit page]
- Canvas markers are sized in user space, one per line kind, coloured by CSS. [Edit page]
- A rule's raw rows leave Statements exactly when a section says the rule: the Rules block, or the Edit section where `saysRules` holds (wording 5.6). [Wording tidy-up]

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
