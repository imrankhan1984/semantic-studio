<!--
================================================================================
FILE: docs/known-state.md
================================================================================

SUMMARY
    The "Known state, so you do not rediscover it" narrative, moved here from
    the repository CLAUDE.md unchanged on 2026-09-27 (spec ci-and-housekeeping).
    Why each load-bearing rule exists, what was measured, and what was found in
    a browser that no test can see.

BASIC IDEA
    CLAUDE.md is loaded into every session and this is 55 KB of it, so it
    lives apart. CLAUDE.md keeps one line per rule under "Load-bearing rules",
    each pointing at the entry here that carries the reason. Read the entry
    before undoing anything it describes.

INPUTS / INPUT SOURCES
    - Builds of the specifications, 2026-07-27 onward.

EXPECTED OUTPUT
    - The reasons behind CLAUDE.md's load-bearing rules. New entries are
      appended at the foot, newest last, as they were in CLAUDE.md.
================================================================================
-->

# Semantic Studio — Known state

## Known state, so you do not rediscover it

- **SPARQL `SERVICE` runs, isolated, through `sparql_service.py`**
  (2026-09-27, spec `external-access` Stage 3, backlog Q-10, decision D-069).
  Every block is found and checked before anything is sent; the text each
  block will send is fixed then and shown in the approval dialog; a handler in
  rdflib's `CUSTOM_EVALS` answers every `ServiceGraphPattern` and sends only
  that text, through the broker as `sparql:service`, once per distinct block
  per run, capped at 10,000 rows, 10 MB and 20 s. The response carries
  `services`; `ResultsTable` names the hosts.

  **Five things are load-bearing.** **Never read rdflib's `service_string`**:
  rdflib 7.6 searches the whole query from the start for it, so every block
  in a two-block query carries the first block's text, and a nested `SERVICE`
  recurses until Python gives up. `find_service_blocks` scans the text
  (strings, IRIs, comments) and `match_blocks` pairs it with the *parse tree*
  -- not the algebra, which moves a `FILTER EXISTS` block first -- before
  `translateQuery` resolves the terms in place; any disagreement refuses.
  **The handler must never raise `NotImplementedError` for a SERVICE node**:
  that is rdflib's signal to fall through to its own `evalServiceQuery`, which
  sends every local binding as `VALUES`. `test_mutation_without_the_handler_leaks_local_data`
  shows what that looks like. **`execute_select` runs the worker in
  `contextvars.copy_context()`**, or the just-once grant and the run's memo
  never reach it and an approved retry is asked again. **The broker's
  `total_timeout` reads unchunked**: `iter_bytes(64 * 1024)` buffers until
  64 KB, so a trickling server never reached the deadline check. **The
  User-Agent names the project and its URL**; Wikidata answers the bare name
  with 403, which no local recorder can show.

  A nested `SERVICE` is refused with its own sentence (rdflib cannot parse
  one), only the `PREFIX` lines a block uses are sent, and SILENT is the join
  identity, so the local rows pass through a failed call. **The scanner reads
  `expandUnicodeEscapes(query)`, while `parseQuery` gets the raw query**: rdflib
  expands backslash-u escapes before parsing, so scanning the raw text let an
  escaped quote move a block boundary the dialog showed; expanding the text
  handed to `parseQuery` as well would expand twice. And when writing a test
  for it, build the escape with `chr(92)`: the tools that write files here
  decoded a literal backslash-u sequence on the way in, and the first version
  of the test held plain `"AB"` and passed with the fix removed.

- **SPARQL can be written as text, beside a builder that did not change**
  (2026-09-27, spec `sparql-text-and-query-files`, backlog Q-1 and CF-5,
  decision D-071 accepting D-008). *Edit as text* and *New text query* open
  `SparqlEditor.tsx` in the preview's place; the first change forks the query
  to text, the builder sits in a disabled `fieldset`, and *Back to the visual
  version* returns to it. Saved queries carry `mode`; `.rq` files open and
  download in the browser; `embedded_queries.py` lists `sh:select`,
  `sh:construct`, `sh:ask` and `sp:text`.

  **Five things are load-bearing.** **The builder's state is never written
  while the query is text**, which is why going back restores it: nothing
  restores anything, and a test asserts identity, not equality. **The live
  text is in a ref (`textRef`), not state**, so typing renders the editor and
  not App or the graph; `keystroke_does_not_render_results` counts renders of
  the hook's owner and goes red if the text moves into state. **The editor's
  key is `editorSession`, the same before and after the fork** -- keyed
  `"visual"` then by session, the first keystroke replaced the textarea and
  every later one landed at the end (found in review; a browser pass that
  replaced the whole text could not see it). **The stored-query count rides on
  `query-schema`**, so entering Query mode makes exactly the requests it made
  before; the list is fetched only when opened. And **the saved-query id is
  checked twice** -- the request model's pattern and `_path` in the store,
  which also covers get and delete, whose id comes from the URL where `\` is a
  separator on Windows.

  Two browser findings. `.query-pinned` gets `editing` and a 70% cap while the
  editor is open: at 40% the action row was clipped into the block's own
  scroll area once a note was shown, and a click on *Run* landed on the list
  underneath. And *Insert prefixes* skips rdflib 7's 25 default bindings
  unless the text uses them -- the schema carries a graph's bindings as they
  are, and a file declaring 5 prefixes was offered 30.

- **`owl:imports` resolve local first, into an opt-in merged view**
  (2026-09-27, spec `external-access` Stage 2, backlog X-5, decision D-068).
  `imports.py` holds discovery, the chain (built in, library, bundled, the
  user's mapping or chosen file, a cached download, then the network as
  `ontology:import`), the closure (depth 10, 100 documents, 150 MB), the
  `imports/` cache with provenance, and `MergedView`. Nothing is resolved on
  open; the read endpoints take `?imports=true`.

  **Four things are load-bearing.** **`MergedView` deduplicates**: rdflib's
  `ReadOnlyGraphAggregate` yields a triple once per graph holding it, so a
  class declared in the file and in FOAF came back as two SPARQL rows.
  **It prunes by subject** through a subject-to-documents index; without it
  building the graph view over eleven documents cost 2.2x a single graph, and
  `test_merged_view_overhead` holds 1.5x (measured 1.30x). Both mutations were
  run and go red. **The vocabulary files are pinned by SHA-256 and marked
  `binary` in `.gitattributes`** -- a CRLF checkout would otherwise change
  their bytes and every hash check would refuse them. **A question never
  stops the closure**: an import needing approval is noted and the loop goes
  on, so everything local across the whole closure resolves first, and one
  409 then names every host, saved before it is raised. Raising on the first
  question (PR #41 review) left later imports unresolved, bundled FOAF
  included, and a Don't allow collapsed the merged view to the file alone.
  The files route for chosen imports is in main.py's declared-size refusal
  too (D-015), at the closure's 150 MB plus framing.

  The merged caches live in `Ontology.merged_cache`, apart from the file-only
  ones, and are dropped whenever the closure is saved. The *Include imports*
  switch is per ontology in `localStorage`; the query panel states which
  view a query ran over. `POST /imports/cancel` is not in the spec's
  endpoint table, which names a Cancel control but no route for it.

- **Every outbound connection goes through the network broker** (2026-09-27,
  spec `external-access` Stage 1, backlog E-T1, decisions D-066 and D-067).
  `network_broker.py` is the only module that connects out, and
  `test_no_direct_network.py` fails if another module imports a network client.
  Each request names a capability (`ontology:fetch`, `jsonld:context`, and the
  two later stages' `ontology:import`, `sparql:service`); per capability and
  host the policy is Ask, Allow or Block, stored in `network-policy.json`.
  No grant raises `ApprovalRequired`, which `main.py` maps to **409** for every
  route; Block is 403, offline is 503. Direct connections only: the proxy and
  certificate settings are Stage 4 (X-7).

  **Four things are load-bearing.** **The policy is asked before any name is
  resolved** -- a DNS query for a name in a file tells its owner the file was
  opened. **The connection goes to the judged address** with the name in
  `Host` and SNI (`_pinned_url`), closing D-012's rebinding residual; the test
  fakes `socket.getaddrinfo` itself, and with pinning removed it reaches the
  private server. **A just-once grant rides on `X-Semantic-Studio-Grant`** and
  reaches the parse worker only because `store.parse_rdf` submits inside
  `contextvars.copy_context()`; drop that and every approved retry asks again.
  **Contexts fetched at ingest are kept as `<id>.contexts.json`** and replayed
  on lazy restore, so a restart neither reconnects nor re-asks.

  The frontend answers a 409 in one place: `send` in `api.ts` calls the handler
  App registers, which opens `NetworkApprovalDialog`, and repeats the request
  with the grant. Tests reaching a loopback server now use `conftest.py`'s
  `loopback_is_public` (exactly 127.0.0.1 counts as public; 127.0.0.2 plays
  the private address) -- faking `resolve_host` alone no longer works, because
  the broker connects to whatever address it returned.

- **The API answers only the application's own page** (2026-09-26, spec
  `external-access` Stage 0, backlog S-6, decision D-065). Binding to
  `127.0.0.1` keeps other machines out but not other web pages in the same
  browser. Measured before the fix: a cross-site multipart upload was stored,
  and a forged `Host` header (DNS rebinding) listed and deleted ontologies.
  `local_guard.py` is plain ASGI middleware, added **last** in `main.py` so it
  runs **first**. It refuses a non-loopback `Host` with 400 on every method,
  and a `POST`/`PUT`/`PATCH`/`DELETE` without `X-Semantic-Studio: 1` or with a
  foreign `Origin` with 403.

  **Every new mutating call in `api.ts` must spread `CLIENT_HEADER`**;
  `api.test.ts` calls every export and fails otherwise, and fails if an export
  is added without being listed there. **Every backend `TestClient` is built
  with `base_url="http://localhost"` and the header**, because the default
  `testserver` host is refused. `test_local_guard.py` reads the mutating routes
  from the OpenAPI document, so a new route is covered without anyone adding it.
  Verified in headless Chromium: a foreign page's no-cors multipart POST stored
  `evil.ttl` with the middleware removed and nothing with it in place; its
  header-carrying fetch never left the browser, because the preflight fails.
  Scripts hitting the API directly (curl, `driver.mjs`) must send the header on
  writes; `SEMANTIC_STUDIO_ALLOWED_HOSTS` adds names for a reverse proxy.

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
  `HomeScreen.tsx` sets the marker when it takes focus and drops it on blur; the
  selector still says `.start-screen` because that class is still on the home
  screen's root, which is deliberate rather than leftover — the page frame and
  this one rule did not change when the chooser became a card grid.
  See D-022. If you need a focus rule anywhere else, you almost certainly do not.

  Keyboard **reach** followed on 2026-07-31; see the `keyboard-and-motion` entry
  at the foot of this list.
- **The application opens on a chooser and renders nothing until asked**
  (2026-07-29, spec `startup-chooser-screen`). `App.tsx` no longer selects the
  most recent ontology on mount: `activeId` stays `null`, the home screen fills
  the main area. Mount makes **exactly one** request, `GET /api/ontologies`, and
  `App.test.tsx` fails if a second appears. Both ways back — *Close this
  ontology* and removing the active one — set `activeId` to `null` rather than
  falling back to another entry. `CatalogueList.tsx` is shared by the home
  screen and the Load dialog so backlog L-1's reordering lands on both; do not
  inline a second copy.

  **Two halves of this item are superseded by `home-screen`, below.**
  `StartScreen.tsx` is gone, and the mode tabs are no longer disabled — that
  spec's Section 7 argues, and this codebase now agrees, that a disabled control
  prevented the empty canvas by removing the choice rather than answering it.
- **The catalogue leads with FOAF, on purpose, and the order is tested**
  (2026-07-30, spec `catalogue-order`). `CATALOGUE` in `catalogue.ts` runs
  `foaf`, `schemaorg`, `fibo`, `unesco`, ascending by how much the user has to
  cope with, and every entry carries a required `audience` string rendered under
  its description. FIBO led this list until then for a real reason — it is the
  richest OWL-restriction example and the primary validation target — which is a
  developer's reason, and D-002 makes the learner's reason win.
  `catalogue.test.ts` pins the id order and pins every `url`, so a well-meaning
  reorder fails the suite, and so does a mis-paired name and URL. **The comment
  above the array is load-bearing; read it before touching the order.**

  **The fourth entry is the UNESCO Thesaurus and it was JUHO until 2026-07-31**
  (spec `catalogue-skos-replacement`). JUHO was 26 MB of Finnish public
  administration terms offered to a newcomer as the catalogue's only SKOS
  example, with a size string ending in the word *slow*; its stated purpose was
  stress-testing, which `test_graph_budget.py` and `test_neighborhood.py` do
  reproducibly and offline. Measured on the swap: 3.8 MB, 99,685 triples, 4,595
  nodes and 26,102 edges, fetched and parsed in **3.5 seconds** against the
  spec's 15-second budget. **The order is no longer ascending by file size and
  that is deliberate** — UNESCO is smaller than FIBO on both bytes and triples
  and still sits after it, because it is the only entry whose labels are in five
  scripts. The reason is in the comment above the array; do not "fix" the order
  to match the numbers.

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

- **The About panel is the application's only modal dialog with a focus trap,
  and three things in it are load-bearing** (2026-07-31, spec `about-panel`).

  **The backdrop is a sibling of the dialog, not its parent.** `LoadDialog`
  wraps its content in `.modal-backdrop`; `AboutPanel` cannot, because the spec
  requires the decorative backdrop to be `aria-hidden` and `aria-hidden` on an
  ancestor removes the dialog from the accessibility tree entirely. The backdrop
  is a bare `.modal-backdrop` div and the panel positions itself. A test asserts
  the backdrop does **not** contain the dialog.

  **The key handler is on `document`, not on the panel.** Pressing on the
  panel's own prose blurs focus to `<body>` in a real browser, and a
  panel-scoped handler would then see neither Escape nor Tab. Because it is on
  the document, Tab from outside the panel is pulled back to its first control,
  which is what makes it a trap rather than a pair of wrapping edges. Confirmed
  in Chrome: heading → link → close → link, never leaving the panel.

  **Focus is restored by `App`, not by the panel**, because only App holds the
  control that opened it. `closeAbout` calls `focus()` directly rather than
  through an effect — that control is never disabled, so this is not the
  `saved-query-deletion-warning` case. `App.test.tsx` fails if the line goes.

  Two smaller things. `vite.config.ts` sets `server.fs.allow: [".."]` so
  `AboutPanel.test.tsx` can read the repository's `LICENSE` with `?raw` and fail
  when the panel's copyright line stops matching it; without it Vite refuses the
  id outright, which at least fails loudly where the CSS `?raw` trap returned
  `""`. And **the 45-to-70-character rule is asserted as a measure derived from
  the stylesheet, never per string** — *Created by Imran Khan* is 21 characters
  and is a label, not a paragraph. Measured in Chrome at 55 characters a line.

  **The panel's last two sentences are a promise, not decoration.** *Your
  ontologies stay on this machine. Semantic Studio does not upload them.* is the
  first place a security property from the specifications' `CLAUDE.md` Section 7
  is stated to the user, and a test asserts it. Any feature that sends ontology
  content anywhere has to change those words in the same commit.

- **Keyboard reach, screen reader support and reduced motion landed together**
  (2026-07-31, spec `keyboard-and-motion`, backlog X-1), with defect **D-2** in
  the same branch. Measured on the built application: **13 interactive elements
  exposed to assistive technology on 2026-07-26, 33 on 2026-07-31, every one of
  them named**, read from Chrome's accessibility tree rather than from the DOM.

  `Legend.tsx`'s filter rows are `<button aria-pressed>` and its collapse header
  is `<button aria-expanded aria-controls>`; the *Relations* rows stay a plain
  `<ul>`, because a control that does nothing is worse than text. `SearchBox.tsx`
  is a real combobox with a roving `aria-activedescendant` — **the one place in
  this codebase that uses one instead of real focus**, because focus has to stay
  in the text field or typing stops working. `GraphView.tsx`'s container is
  `role="img"` with a label naming the drawn and total counts and the keyboard
  route out. `App.tsx` opens the main area with a skip link.

  **The graph is not navigable node by node and that is a decision, not a gap.**
  D-025. A force-directed WebGL canvas has no stable reading order and nothing in
  the accessibility tree to move between; what it gets is an accessible
  equivalent — described canvas, skip link, and the path through suggestions,
  search and the detail panel that already existed. Confirmed dropped by Imran
  before the build. Do not reopen it, and do not call any of this WCAG
  conformance.

  **Four things here are load-bearing.**

  **The reduced-motion settle is bounded by time, not by iterations, and it is
  deliberately not "the same total" the spec asked for.** Measured with
  `graphology-layout-forceatlas2` at roughly FIBO's edge density: 100 nodes reach
  600 iterations in 24 ms, 500 nodes in 528 ms, and 2,000 nodes cost 1,343 ms for
  100 iterations. The animated path runs about 560 iterations over its 8.5 second
  window, so matching it at the default node budget is eight seconds of frozen
  tab. `REDUCED_MOTION_SETTLE_MS` is 1,000 and the comment above it carries the
  numbers. Anything a newcomer opens settles fully; the largest graphs are
  partially arranged, which is still the arranged-in-one-paint that AC-10 asks
  for.

  **The settle runs before `new Sigma(...)`, not after it.** Settling afterwards
  shows the ring `circular.assign` left behind and then replaces it, which is one
  motion event more than a reduced-motion user asked for. `GraphView.test.tsx`
  asserts this by snapshotting node positions **inside the stubbed Sigma
  constructor** — the graph is a live object, so reading it afterwards reports
  wherever the layout has since got to, and the claim is about that instant.

  **`matchMedia` is read exactly once per graph mount**, and that is a budget
  rather than tidiness. The obvious shape — one `matchMedia` in the `useState`
  initialiser and a second in the effect that subscribes — reads it twice on
  every ontology switch and every budget change. The MediaQueryList lives in a
  ref and both the initial value and the subscription come off it. Deleting the
  read makes four tests fail; that mutation was run.

  **The specification's Section 6 tab order is wrong about the graph toolbar.**
  It lists the legend first. The toolbar is a full-width strip *above* the
  legend, so matching the spec would put the tab order out of step with the
  visual order — the defect this item exists to fix, not a form of fixing it.
  Document order is left alone and asserted in `GraphView.test.tsx`, which is the
  only place that can see it: `App.test.tsx` stubs `GraphView`. The real order
  was walked with Tab in Chrome: skip link, Fit, Zoom in, Zoom out, Re-run the
  layout, PNG, legend header, seven filter rows, then the Explore panel.

  Two smaller things. **Two toolbar buttons had no accessible name at all**,
  being a "＋" and a "－" glyph each, and now carry `aria-label`; the same shape
  survives on the detail panel's ✕ and ⧉ and was deliberately left alone, that
  component being named nowhere in the spec. And `QueryPanel.tsx` gained an id,
  an `aria-label` and `tabIndex={-1}` — it is the only one of the four panels
  beside the graph with no heading of its own, so the skip link had nowhere to
  land in Query mode. That file is not in the spec's Section 8 list.

- **The graph notice cannot be dismissed, and `noticeDismissed` is gone**
  (2026-07-31, defect D-2, built with X-1). The ✕ set a flag in `App.tsx` that
  reset only when `activeId` changed, so one press removed *Show more* **and**
  *Show less* for the rest of the session with no way back. It was specified in
  `partial-graph-rendering` stage 1, when the bar was a sentence and one button,
  and kept through `show-less` without anyone noticing that `show-less` had given
  it something worth losing. The bar and its summary are permanent now.
  `GraphNotice.test.tsx` asserts over **every** button in the bar rather than
  querying for the one that used to be there, so any future control that hides
  the notice fails it too.

- **The application opens on a card grid, and `StartScreen.tsx` is gone**
  (2026-08-04, spec `home-screen`, backlog U-8, absorbing the retired L-9).
  `HomeScreen.tsx` is its successor and `OntologyCard.tsx` is one entry in it:
  a miniature of that ontology's own graph, L-5's generated sentence, a
  composition bar in the legend's colours, chips, three verbs and a `⋮` menu.
  Home is also a header control now, so the library is reachable from every mode
  rather than only through *Close this ontology*.

  **Everything on this screen still costs zero requests, and that is the
  property to defend.** It is `startup-chooser-screen`'s budget inherited whole:
  mount makes exactly one request and none to `/graph`, and `App.test.tsx` fails
  if either changes. Cards are drawn from the list response alone.

  **The one backend change is the sketch, and the spec was wrong about needing
  more.** `home-screen.md` Section 8 says the list response does not carry
  `kindCounts`. It does, and has since the metadata file existed — `store.add`
  writes `viz["stats"]` whole — so the composition bar and the sentence needed
  no server change at all. What was added is `meta["card"]["sketch"]`:
  `build_card_sketch` in `graph_builder.py`, the twenty highest-degree entities
  and the edges among them, computed inside the parse that already happens at
  ingest. **`summary()` reads it with `meta.get("card")` and that single `.get`
  is the whole migration** — an ontology stored before this exists serves
  `null`, its card renders without a thumbnail, and nothing parses to backfill
  one. Backfilling on first render would put a parse per stored ontology back on
  the startup path and hit the largest library hardest.

  **Five things here are load-bearing.**

  **`home/miniature.ts` draws with SVG and must never mount Sigma.** A browser
  caps live WebGL contexts at around sixteen and a library of twenty would ask
  for twenty. It is Fruchterman-Reingold over at most twenty points, and it is
  **deterministic** — a golden-angle spiral, never `Math.random`, because App
  re-renders this screen on every keystroke in the search box and a thumbnail
  that reshuffled per character would be noise.

  **The miniature's box is per layout and its aspect ratio is the reason.**
  `preserveAspectRatio` letterboxes, so one 120×70 viewBox in a card's 320×76
  strip put the whole drawing in a 130px column with 60% of the card empty. And
  **the fit-to-box step scales both axes by one factor** — normalising them
  independently stretched a roughly round layout into a flat smear. Both
  measured in Chrome; neither is visible from jsdom.

  **The automatic layout reads the whole library, never the filtered subset.**
  Nine or fewer is cards, ten or more is rows, `CARD_LAYOUT_MAX`, overridable by
  a toggle that persists. Switching on the *filtered* count would flip the
  screen between layouts while the user types. A mutation test on that line is
  in `HomeScreen.test.tsx`.

  **The `memo` around the catalogue lives in `HomeScreen.tsx`, at the import
  site, not on `CatalogueList` itself** — so the Load dialog renders the
  identical unwrapped component and the two callers cannot drift, which is the
  whole reason `CatalogueList` exists. The test mocks `./CatalogueList` with a
  spy and lets the production `memo` wrap it, which is the only arrangement that
  tests the shipped line rather than a copy declared in the test.

  **`.onto-menu[hidden] { display: none }` is a real fix, not tidiness.**
  `display: flex` beats the browser's own `[hidden]` rule, so without it the
  closed menu drew as an empty bordered strip beside every card's name. jsdom
  asserts the attribute and cannot see it being overridden.

  **Two further things worth not rediscovering.** `startup-chooser-screen`'s
  AC-9 is deliberately superseded: the mode tabs are **enabled** with nothing
  open, and pressing one is remembered as `pendingMode` while the library
  heading asks which ontology. And **Home is a view, not a reset** — D-026 — so
  it keeps the ontology, the selection and the query being built; what it does
  not keep is the graph's settled layout, because GraphView unmounts. Measured:
  the round trip Home → Query costs one request, the saved-query list.

  **The security review of this build found nothing to fix and one thing worth
  knowing**, now backlog X-6. `kindColor` in `types.ts`, and
  `KIND_LABELS[kind] ?? KIND_LABELS.other` in `explore/suggestions.ts` and
  `home/miniature.ts`, index plain objects with a string that comes from the
  graph — so a kind of `constructor` or `valueOf` returns an inherited function
  rather than falling through to `other`. It is not exploitable: `_best_kind`
  emits one of eleven fixed constants, so an uploaded file cannot reach it, and
  React escapes the result into an attribute either way. It was left alone
  because it is the same wart in four places, and fixing only the newest would
  leave them inconsistent. **If you touch one of those lookups, touch all
  four.**

  **One defect here was found in the accessibility tree rather than on screen.**
  Home was written `aria-selected={showHome}`, so with a mode question
  outstanding both Home and that mode reported themselves selected. Two selected
  tabs in one tablist is a contradiction a screen reader cannot resolve, and it
  is invisible visually because the styling agrees with the sensible reading
  either way. The lesson generalises past this build: the accessibility tree is
  worth reading for more than whether controls have names.

- **The node palette is pastel-with-alpha, the selected node wears a ring, and a
  budget change says what it discarded** (2026-08-05, spec `graph-legibility`,
  backlog G-8). `KIND_COLORS_DARK` / `KIND_COLORS_LIGHT` in `types.ts` are
  lower-saturation and carry an alpha (8-digit hex — Sigma parses
  `#RRGGBBAA`); the light theme is kept more opaque (`0xE6` vs dark's `0xD9`)
  because compositing over white lightens and washes a pale cluster out.
  `GraphPalette` gains `selectedRing`, the theme's accent.

  **Four things are load-bearing.**

  **Sigma 3.0.3 has no per-node border**, so the ring is drawn in the existing
  custom hover overlay `makeDrawNodeHover`, not a WebGL node program. Neither
  shipped node program (circle, point) exposes `borderColor` and no
  `@sigma/node-border` is installed; the hover overlay is the 2D-canvas pass
  Sigma already runs for every highlighted node, the same seam the label pill
  uses, so the ring costs no dependency and no shader. This is *not* the custom
  program the spec's open question 1 said to stop and report.

  **The selected node is told from the merely hovered one by a `selected` flag
  the node reducer sets**, which reaches the drawer through Sigma's display data:
  the reducer's return is stored whole in `nodeDataCache` and spread into the
  drawer's argument, so a boolean set there arrives without a second channel.
  Keying the ring on `highlighted` instead would ring hover and query-path nodes
  too — the flag is what separates selection from hover. The reducer checks
  `node === sel` **before** `node === hov`, so a node that is both keeps the ring
  and the larger +4 size; that ordering is AC-2's tie-break.

  **The node reducer's performance is guarded by three tests that are counts, not
  timings.** `GraphView.test.tsx` asserts every reducer result value is a
  primitive (the ring allocates nothing beyond the mandatory result object), the
  selected node makes zero `areNeighbors` calls (it returns before the dimming
  branch, so the ring costs no graph work), and a proxy palette sees one `.kind`
  read per node. The spec's "≤1.1× against none" is not literally meaningful — a
  selection always adds the dimming traversal that predates this spec — so these
  measure the ring's *actual* cost. Do not rewrite them as wall-clock ratios.

  **The discarded-expansion count is reported in `GraphNotice`, not a new live
  region.** `GraphNotice` already announces the counts on a budget change, so the
  cleared sentence is appended there — one announcement, not two (D-027). App
  captures the count in the refetch effect, from `expandedRef` and gated on
  `pendingBudgetPress`, so an ontology switch — which clears expansions too —
  stays silent, and the sentence appears only when something was cleared. There
  is deliberately no reset control: *Show less* already discards expansions and
  now says so, which is the whole of D-027.

- **The zoom controls are docked bottom right over the canvas, not in the
  toolbar** (2026-08-05, spec `graph-zoom-controls`, backlog G-5). Zoom in, zoom
  out and Fit are a `.graph-zoom` group inside `.graph-canvas-wrap` (already
  `position: relative`); the toolbar keeps only layout and PNG. Frontend only, no
  architecture impact, no decision entry.

  **Three things are load-bearing.**

  **The disabled state is a three-value edge, not the camera ratio.** The buttons
  disable at Sigma's `minCameraRatio` (0.01, fully zoomed in → `+` off) and
  `maxCameraRatio` (20 → `−` off), read from the camera's `updated` event. Storing
  the raw ratio would re-render GraphView every animation frame; storing
  `"min"/"max"/"mid"` lets React dedupe the frames between edges to one render —
  the first performance row. Do not "simplify" it to hold the ratio.

  **The camera listener is subscribed in the build effect and removed in its
  cleanup.** A listener left on a camera that outlives its renderer leaks one per
  ontology opened, invisibly; `GraphView.test.tsx` asserts the count is one after
  mount and zero after unmount, and the mutation removing the cleanup was run and
  goes red. The test's Sigma stub gained a stable `camera` with `on`/
  `removeListener`/`__fire`/`__listeners` for exactly this — the previous stub
  returned a fresh camera object per `getCamera()` call, which cannot model a
  subscription.

  **Focus moves to the partner when a press disables a control.** Zooming fully in
  disables `+`, and a disabled button drops focus to `<body>` — the trap G-6 and
  saved-query-deletion-warning both hit. `armZoomPress` records which button was
  pressed and expires that record after the animation window, so an effect keyed
  on the edge moves focus to the partner only for a press that reached the edge —
  an edge reached by the scroll wheel, or by a wheel zoom after a mid-range press
  whose intent has expired, moves nobody. That expiry is a real fix, not
  belt-and-braces: without it a mid-range press then a wheel-to-edge steals focus,
  and a test mutation-checks it. Confirmed in a real browser, both directions.

  Reduced motion reuses X-1's `moveDuration` helper rather than passing
  `duration: 200`; a literal there would undo X-1's work where nobody would look.

- **The Hierarchy view explains a selected entity and covers property trees**
  (2026-08-28, spec `hierarchy-view` v0.3, backlog G-1, decision D-047). The
  v0.2 build shipped a tree that selected an entity but showed nothing about it,
  and covered only classes and concepts. Both are fixed.

  **The detail panel lives in `App.tsx`, not in `HierarchyView`.** The Hierarchy
  branch renders the reused Explore `DetailPanel` beside the tree in the exact
  `selected === null ? empty : DetailPanel` shape Explore uses — so the panel is
  reused unchanged rather than reimplemented, and `HierarchyView` stays the tree
  alone. A tree row selects through `selectFromOutsideGraph` (the search /
  results-table route), and so does the panel's `onNavigate`, so following a
  connection behaves exactly like clicking a row and the tree highlights the new
  selection wherever it is a rendered row. The empty-state string is an
  acceptance criterion: *Select a class, property or concept to see its details
  and connections.*

  **Property forests carry only `subPropertyOf` participants, and that is a
  deliberate asymmetry with the class and concept forests, which carry lone
  declared nodes too.** `_build_property_forests` in `hierarchy.py` includes a
  property only if it is either end of a `subPropertyOf` edge — because a large
  ontology declares thousands of properties with no sub-property structure, and
  a flat list of all of them is the wall the whole view exists to avoid. Do not
  "fix" this into parity with the class forest without a spec that asks for it;
  the spec's version row and D-047 both record it as intended.

  **The three forests (object / datatype / annotation) reuse the one generic
  `_forest`**, so `origin` (the D-046 inference seam), cycle-breaking and
  multiple-inheritance all extend to them with no new code. A key and its count
  appear in the payload only when that kind exists — `classes` and `concepts`
  stay always-present, which is why `test_truly_empty_hierarchy` can still pin
  `counts == {"classes": 0, "concepts": 0}`. Classification is by
  `_property_kind` (best of the three explicit types), and an untyped
  `subPropertyOf` participant **falls back to the object-property forest** so its
  subtree stays with any typed relatives rather than being dropped. There is no
  fourth "plain property" forest.

  One measured browser fact worth not rediscovering: entering any graph mode
  (Explore / Query / View) in headless Chrome can throw *Sigma: Container has no
  width* if the container measures zero at mount — an environment timing artifact
  of the WebGL canvas, **not** a Hierarchy defect (the tree mounts no Sigma). It
  clears on reload once the viewport has a real width.

- **Authoring foundations: projects, editing and the Turtle editor**
  (2026-09-28, spec `authoring-foundations`, backlog E-6, decisions D-081 to
  D-085). A project is a folder under `<data dir>/projects/` with a
  `project.json` manifest; opened, each document is an `Ontology` registered
  in the store under `prj-<hex>-<doc>`, so every read endpoint serves it
  unchanged. Only `editing.py` changes one: typed commands with triple deltas,
  the whole-text Turtle apply, a 200-step undo, save under formatting option A,
  a two-second autosave to `.draft/`, and recovery from that draft.

  **Seven things are load-bearing.** **Every derived view on `Ontology` is
  `(key, value)`**, the key being the revision (and, where names show, the
  label languages); nothing else invalidated them, because nothing had ever
  changed an ontology after loading it, and an edit would otherwise leave the
  graph, the tree and the query builder on the old model. A library ontology
  stays at revision 0 for ever, and `test_cache_invalidation.py` counts builder
  calls to prove it never rebuilds. **Only `editing.py` mutates a document's
  graph**: `test_no_direct_mutation.py` parses every module with `ast` and
  fails on a mutating call on an ontology's graph anywhere else, after proving
  it catches a planted one. **A project id is matched with `fullmatch` before
  it becomes a path, and an id the server did not issue is 404 on every route**
  -- the path-attack test in `test_projects.py` reads the routes from OpenAPI,
  and it found `close` answering 200 for `..\..\ontologies` before the fix.
  **The Turtle editor's unapplied text lives in the project store, not in the
  editor**, because leaving it is App's to ask about ("Apply, discard, or
  stay?") before the editor unmounts. **The project store is module state**, so
  a test that renders App must `cleanup()` between tests: `App.test.tsx`
  emptied the body without unmounting, and seventy detached Apps answered one
  store change with seventy graph requests. **The authoring controls use
  `aria-disabled`, not `disabled`**: pressing Undo until the stack is empty
  would otherwise disable the button holding focus. **`pick_label` tests the
  exact `en` tag before the BCP 47 prefix match**: the prefix match on every
  label cost about 8% of a 40,000-node library build; with the exact test first
  the medians are 962 ms before and 972 ms after, interleaved.

  Two measured facts worth not rediscovering. rdflib normalises some lexical
  forms when a literal is made -- a `dateTime` ending `Z` becomes `+00:00` --
  so a typed value round-trips exactly from what was stored, not from what was
  typed. And a page with unsaved changes raises the browser's `beforeunload`
  question on purpose, so a headless driver navigating away must answer it
  (`Page.handleJavaScriptDialog`) or its `Page.navigate` times out.

  **The code review of the branch found ten defects, all fixed with a test that
  fails without the fix**, and four are rules now. **`_change` must leave a
  triple that is in both adds and removes where it is**: the first version put
  it in `removed` only, so `SetLabel` to the label a class already had deleted
  the label. **Views read a project document under `Ontology.reading()`**, the
  re-entrant lock `editing.py` takes, or a graph build iterates a graph an
  apply is changing. **The autosave timer moves nothing on disk unless the
  generation it started with is still current**, checked again after it
  serialises: a save or a discard in between used to leave a draft that was
  then offered for recovery. **App reads the project store by selector**: the
  editor's text is in the store, and a whole-snapshot subscription re-rendered
  all of App on every keystroke. The other six: a duplicate's saved queries
  get their own ids and the copy's document id; deleting an entity takes whole
  any anonymous expression that mentions it (a restriction on another class,
  a list in a union); a command builds the imports view only when a target is
  not in the document; Undo, Redo and Save ask about unapplied Turtle first;
  saving every document leaves the active one where it was; and switching
  document empties the editor until the new text arrives.

- **Visual modeling, Stage 1: the editing form, the tree's actions, safe links**
  (2026-09-28, spec `visual-modeling-canvas` Stage 1, backlog E-7 and CF-7,
  decision D-088). For an entity of a project's `model.ttl` the detail panel
  carries an Edit section (`EditSection.tsx`, with `EditStructure.tsx`,
  `AnnotationAdder.tsx`, `EntityPicker.tsx`, `NewEntityForm.tsx`,
  `DeleteDialog.tsx` and `EditParts.tsx`), read out of the panel's own
  statements by `modeling/entity.ts`; the Hierarchy view has New class, New
  concept and a row menu (`HierarchyActions.tsx`). Every change is one E-6
  command through `projectStore.command`. No dependency, no canvas: that is
  Stage 2.

  **Every `href` goes through `linkTarget`** (`links.ts`, D-088): only
  `http:` and `https:` become links, and `links.test.ts` scans every `.tsx` for
  an `href={…}` that is neither `linkTarget(…)` nor a name assigned from it. The
  helper checks the raw text and the parsed protocol both, because the URL
  parser reads ` javascript:` (a leading space) as `javascript:`. Proved live
  with a file whose entity, `seeAlso` and import are `javascript:` IRIs.

  **The save point is a step, compared by identity.** `Step` is a dataclass
  with `eq=False`: two steps with the same label and delta are two points in
  the history, and a value comparison would call the wrong one saved. `BASE`
  stands for an empty stack; the 200-step cap moves a save point on the step
  it drops to `BASE`, and drops any older one. **Each step keeps the editor
  text and the save rule's flag on both sides**: undo restores `before`, redo
  `after`, so apply-undo-save writes the file byte for byte, and landing on the
  save point puts back the saved text and removes the draft.

  **`DetailPanel` keeps its details while a new revision is fetched.** It used
  to clear them on every refetch, which unmounted the form field the user had
  just pressed Enter in and dropped focus to the body. It clears only when the
  entity, the ontology or the imports switch changes.

  **A tree row's `⋯` button is `aria-hidden` and out of the tab order.** A
  treeitem is named by its contents, and Chrome read "Person Class More actions
  for Person" (measured with `Accessibility.getFullAXTree`). The row declares
  `aria-keyshortcuts="Shift+F10"`, which opens the same menu; the visible note
  above the tree says so too.

  **Timed budgets multiply their millisecond limit by `BUDGET_FACTOR`**
  (`frontend/src/budget.ts`, `backend/tests/budget.py`), 1 by default and 2 in
  the CI `budgets` job, because `miniature.test.ts` measured 2.40 ms there
  against a 2 ms limit on every pull request. Ratios and byte counts are not
  multiplied: a ratio is taken on one machine and cancels it out.

  Two facts worth not rediscovering. A plain literal (`"1.0"` in Turtle) and
  `"1.0"^^xsd:string` are different terms to rdflib, and the form sends every
  untagged text as `xsd:string`, so `ReplaceAnnotation` and `RemoveAnnotation`
  look the plain spelling up too (`_stored` in `editing.py`). And a date field
  cannot hold an invalid date, in jsdom as in a browser, so a test of "invalid
  value refused before sending" uses an integer.

- **The modeling canvas** (2026-09-28, spec `visual-modeling-canvas` Stage 2,
  backlog E-7, decisions D-086 and D-087). In a project's Hierarchy view the
  canvas sits between the tree and the form (`canvas/ModelCanvas.tsx`), on
  React Flow 12.12.0, pinned exactly and loaded with `React.lazy`: its code
  and React Flow are a chunk of their own (68 KB compressed, plus 2 KB of
  CSS), fetched from the local server the first time a canvas opens. The
  main bundle grew 2.1 KB. A project now opens in this view.

  What it draws is `backend/app/canvas.py`'s view, served by
  `GET …/documents/{doc}/canvas` and cached by revision, language and the
  imports view; where it draws it is `<doc>.layout.json`, written by
  `PUT …/layout` (1 MB, declared and while reading; at most 20,000 entries,
  keys of at most 2,048 characters, finite numbers). Past
  `CANVAS_MAX_BOXES` (300) classes and concepts it draws only the shown set
  and its direct links. Measured: 300 boxes and 400 lines drawn 360 ms after
  the click with the code fetched, about 170 ms cached; the view builds in
  36 ms on 10,000 triples.

  **The canvas imports React Flow's `base.css`, not `style.css`.** The full
  theme sets `outline: none` on a focused node, and every box lost the one
  global focus ring (measured with the accessibility tree: `outline: none`).
  `base.css` suppresses it only on React Flow's built-in node types, which
  the canvas does not use. No second focus rule was needed.

  **One handle per side, and `ConnectionMode.Loose`.** A source and a target
  handle stacked on each side left the pointer on whichever was on top, and
  a line started on a target handle comes back reversed: *Invoice item to
  Invoice* opened a menu for *Invoice to Invoice item* (the browser pass).
  In loose mode any handle starts or ends a line, and it runs from where it
  started. Lines leave and enter by the sides facing each other; with one
  top and one bottom handle, a relationship between two boxes in a row
  looped round both.

  **Lines are not Tab stops** (`edgesFocusable={false}`): React Flow puts
  lines before boxes in the page, so Tab reached every line first. Each box's
  name already says what its lines say, and the form removes a link by
  keyboard. **Focus on a box selects it**, so the form follows the keyboard;
  a box just deleted is still drawn until the refetch and the delete dialog
  gives focus back to it, so its focus is ignored until the view drops it,
  or it re-selected the entity the delete had cleared.

  **The browser's layout is merged, not kept.** Every fetch takes the
  server's layout as the base and lays over it only the moves not yet
  written: a rename moves its entry on the server (and its undo and redo
  move it back), and a copy read once would have lost that and then written
  itself back over it (code review). A deleted box's position stays in the
  file until the next open, so an undone delete returns to its place.

  Found in the code review and fixed with a test each: the canvas cache
  ignored newly resolved imports; the rename field kept the first name it
  saw and stripped any "(…)"; Enter on a button in a box renamed the box;
  an emptied shown set refilled itself; an end written as `owl:unionOf` was
  offered to "complete"; an attribute of a class outside the model vanished.
  And on Windows, replacing the layout file many times a second now and
  then meets "access denied" from a scanner holding it: the write retries a
  few times 20 ms apart (`projects._replace`).

- **The canvas's lost drop point, lost last move and deaf Delete** (2026-09-28,
  the review of PR #47). Three defects the suite and the first browser pass
  missed, each reproduced in Chrome by the reviewer and now held by a test
  that fails without its fix.

  **A position leaves the unsaved set only when its save has succeeded.** A
  box made on the canvas is saved at its drop point at once, and the create's
  refetch could read the layout before that save landed: the box was taken
  for unplaced, laid out again, and that was saved instead (4 of 8 drops on a
  280-class model). `place()` now marks its box unsaved like any move, and a
  save records what it sent and settles an IRI only if the box has not moved
  again since. A failed save keeps everything pending and says so in the
  canvas's status line. Measured after the fix: 8 of 8 drops kept.

  **`projectStore.close()` awaits every registered flush.** A move made less
  than a second before *Close project* was lost: the project closed, and the
  layout write then met a closed project. The canvas registers its flush
  (`useCanvasData.flush`), and close waits for it before the server is told.

  **A clicked line focuses the canvas surface.** A click on a line focuses
  nothing, so the Delete key went to the page and never reached the canvas's
  key handler; the jsdom test had sent the key to an element inside the
  canvas and so passed. The surface is now script-focusable, the click
  focuses it and says *… selected. Delete removes it.*, and the test sends
  the key to whatever holds focus.

  Also from that review: the canvas pans to a selection once, not after every
  form edit; Show and Hide on canvas revert and say so when the write fails;
  past 300 boxes only a class or a concept joins the shown set (its kind is
  asked for when it is not drawn); the tree is `aria-busy` while a command
  runs; Tidy up is `aria-disabled`. `renderCanvas` in the tests waits for the
  boxes, not only the canvas, which is what failed about 1 run in 6 on CI.

- **The layout generation: order-proof drop points** (2026-09-28, the
  re-review of PR #47). The unsaved-until-success rule above still lost 4 of
  10 drops in Chrome, because it depended on the order responses arrived in:
  the create's refetch read the layout on the server just before the drop's
  save wrote it, the save's answer arrived first and settled the box, and the
  older refetch then arrived without its position, so the box was laid out
  again and that was saved.

  **The layout file carries a `generation`**, which the server increases on
  every write (the browser's PUT, a rename moving an entry and its undo and
  redo, the prune on open) and which the browser cannot set. PUT layout and
  GET canvas both return it. The canvas remembers the generation of its last
  successful save, and a response older than that brings its boxes and
  lines but none of its positions or shown set. A rename's move is a later
  write, so it is still taken. `ModelCanvas.test.tsx` forces that exact
  order (GET reads, PUT resolves, GET resolves); it fails without the check.
  Chrome after the fix: 10 of 10 drops kept, twice, and the screen and the
  file agree for all ten.

  **Layouts are served from memory after the first read.** Reading the old
  generation before each write made a 300-position PUT take about 95 ms
  against its 20 ms budget. The cost was all in opening the file: about
  130 ms on Windows to open a file just replaced, while a scanner looks at
  it (profiled; no retries fired). `ProjectStore` keeps each layout as last
  read or written and hands out copies, so the file is read once per
  document: 1.2 ms per write again, and GET canvas no longer pays for a
  fresh file either.


- **Relationships and project kinds, Stage A** (2026-09-29, E-8,
  `relationships-and-project-kinds.md`). Four things a later change could
  undo without noticing.

  **Completing a relationship by a line is one command.** The canvas used
  to send `SetDomain` then `SetRange` for a relationship with neither end, so
  one line was two undo steps and an undo left half a relationship (the E-7
  note, matrix row R6). `SetEnds` sets whichever ends the line supplies in one
  change. Checked in Chrome: one Undo, labelled *Set the ends of likes: from
  Employee to Organization*, takes both away.

  **After a line makes or completes a relationship, focus goes to the canvas
  surface, not the box.** Focusing a box selects it (E-7, so the form follows
  the keyboard), and focusing the start box straight after selecting the new
  relationship took the selection back to the class. The surface is
  script-focusable and keeps Delete for the selected line.

  **A loop leaves a box's right side near the top and enters its top edge.**
  The first version looped on the middle of the right side, where the lines
  to other boxes leave: in Chrome it sat on top of them, was small, and a
  click on it selected another relationship. `curves.ts` holds the geometry;
  its test asserts the loop's label is above and right of the corner.

  **The tree lists every property for a project document only, and only the
  document's own.** `build_hierarchy(own=...)` is the document graph, also
  under the merged imports view: listing the merged graph's properties
  would bury a small model under FOAF's. A library ontology keeps the
  sub-property forests alone (a test asserts it), because a large ontology's
  flat property list is the wall the tree exists to avoid.

  **The kind is the tools, never the model (D-089).** `PATCH` with `kind`
  writes the manifest only; a test compares the model file byte for byte
  across the change, and Chrome confirmed it. Content of the other kind is
  shown read-only with one line, never filtered out of a view.

  **Found in the browser pass and left alone:** with the canvas on, Tab from
  the tree to the form walks every canvas box, and each box focused selects
  its entity, so the form ends on the last box. That is E-7's design (a box
  focused is a box selected); the keyboard route through the tree and the
  form (matrix R22) was run with the canvas switched off.

- **Relationships and project kinds, Stage B** (2026-09-30, E-8 and CF-8,
  `relationships-and-project-kinds.md`). Meaningful relationships: six
  things a later change could undo without noticing.

  **A project's Turtle is parsed with its base IRI, written onto it, never
  resolved against it (CF-8).** Without a base, rdflib resolved `<owns>`
  against the server's working folder and the model gained
  `file:///C:/…/owns`, which went out in every save and export. With the
  base, standard resolution is still wrong for the default base, which ends
  in `#`: `<owns>` under `http://example.org/shop#` resolves to
  `http://example.org/owns`. So `parse_turtle` parses under a reserved
  `http://relative.invalid/` and moves every such IRI onto the base, and an
  `@base` in the text still wins. It applies to the editor's apply, to a file
  loaded on open (the editor's text is saved verbatim, relative IRIs and
  all), and to a recovered draft. A test deletes the base and goes red.

  **The 5.9 checks read a hierarchy in one scan of its predicate.** Walking
  up by asking the store for each node's parents cost 25 ms for a 2,500-deep
  chain in a loaded test process, over the 20 ms budget; one
  `subject_objects` scan into a dictionary and a walk of that is about 3 ms.

  **Top concepts are kept by the commands, in the same undo step (D-091).**
  `CreateConcept`, `AddBroader`, `RemoveBroader` and a concept's delete
  compute `_top_delta`; nothing in the form marks one. A stale
  `skos:hasTopConcept` is an integrity error the learner cannot see.

  **A characteristic's checkbox shows the model, not the click.** It is
  controlled by the statements the panel refetches, so a refused
  contradiction leaves it unticked with the sentence under the block; an
  optimistic tick would show a combination the model does not hold.

  **A selected line's highlight clears on a change of selection only.** The
  effect depends on `selected` alone: depending on the selected line too
  cleared a relationship's line on its own click, before App's selection
  arrived (found by the unit tests, which do not re-render with it). A line's
  label is a click on its line (`pointer-events: all` on the label, drawn
  outside the SVG over the pane), or the click went to the pane and cleared
  the selection.

  **The link panel clears its refusal when the line changes.** App keeps one
  panel mounted across line clicks; the refusal for the last line stood under
  the next (5.10 item 5).

  **Found in the browser pass:** a matrix harness that calls
  `scrollIntoView` on an element inside the canvas scrolls React Flow's
  container, which React Flow puts back at once, so the click lands about
  11 px from its target. It looked like *+ attribute* never opening; it was
  the harness. Elements on the canvas are clicked where they are drawn.

- **The chaining rule, and four review fixes** (2026-10-01, E-8 Stage B, spec
  v0.6, from the analyst's review of PR #49).

  **The chaining rule compares before and after.** OWL 2 allows *at most
  one*, *identifies its start*, *never both ways* and *never to itself* only
  on a simple relationship: one that does not chain, has no chaining one
  under it, and whose other way round is simple. `modeling_checks._Facts`
  reads the characteristics, `subPropertyOf` and `inverseOf` once, works out
  every relationship that is not simple and why, and a command is refused
  only for a violation its change would add. A violation written in Turtle
  (D-089) is a warning on that relationship; refusing every later change
  because of it would lock a learner out of an unrelated fix.
  `SetCharacteristic`, `AddSubPropertyOf` and `SetInverse` all ask it, since
  each can make a relationship not simple.

  **A warning says which block it belongs to.** The server sends `block`
  (*characteristics* or *inverse*) and the form shows each under that block.
  Only a warning a change brings is said in the live region
  (`projectStore.say`); those already there when the entity opens are read
  with the form, and moving to another entity announces nothing.

  **The relate menu offers only what the server accepts,** read from the
  drawn lines, through other concepts too: nothing when the target is
  already narrower than the source, no *related to* when the source is
  already under the target, no *narrower than* between related concepts.
  Two canvas tests had drawn exactly the loop-making line and passed.

  **Checkboxes are aria-disabled while a change saves:** the click is still
  dropped, as the runner allows one command at a time, but a screen reader
  now says why.

- **SHACL validation** (2026-10-01, V-6 Stage A, `shacl-authoring-and-validation.md`,
  D-092 to D-094).

  **pySHACL runs with everything that reaches further off.** Inference
  `none`, `advanced=False`, `js=False`, `do_owl_imports=False`, each asserted
  by `test_validation_runs_with_inference_advanced_js_and_imports_off`. No
  inference is needed for what learners write: pySHACL already finds an
  Employee through `rdfs:subClassOf` when a shape targets Person, and RDFS
  inference cost five times the time on the spec's measurement.

  **The data is a plain Graph, on purpose.** A SPARQL-based constraint is
  core SHACL and runs whatever `advanced` says. rdflib follows a query's
  `FROM <file:///...>` or `FROM <http://...>` only when the graph is a
  `Dataset` or `ConjunctiveGraph`, through its own loader, which the broker
  never sees. `editing.validate` copies the model and its imports into a
  plain `Graph`, and `shacl.validate` refuses anything else. Keeping imports
  as named graphs one day would open that door; the security review of this
  build found it closed only by this. SERVICE is refused twice: by pySHACL's
  own check, and behind it by `sparql_service`'s handler, which fails closed
  outside the query runner (S15's recording server saw nothing).

  **One broken shape must not hide the others.** pySHACL refuses a whole run
  when one shape will not load (`sh:minCount "x"`). A refused run is
  repeated shape by shape with `use_shapes` to find which, and the rest run
  together. `use_shapes` takes IRIs only, so a blank-node shape is given a
  temporary `urn:x-semantic-studio:shape:` IRI in a copy of the shapes graph
  for the run and mapped back to its id for the panels; without it every
  blank-node shape beside a broken one read *Could not run* (found in
  review).

  **`sh:in` text is written plain.** `sh:in` compares terms exactly, rdflib
  keeps Turtle's `"active"` apart from `"active"^^xsd:string`, and the form
  sends text as `xsd:string`: a list written that way refused every value
  typed in Turtle.

  **`shapes.ttl` is made by the first shape command, only once it will
  succeed.** The command is first run against an empty shapes document, so
  a refusal or a dry run leaves no file, and the file is made under the
  service lock, so two first commands at once make it once (both found in
  review). A shape command reads the model too, so it holds the shapes
  document's lock and then the model's; the shapes list and the suggestions
  take them in the same order, and validation takes each alone in turn.

  **Shapes mode keeps the views on the model.** The store's `activeDoc` is
  `shapes.ttl`, so the header's Undo, Redo and Save act on the shapes, but
  `activeId` stays the model's: a problem's link selects an individual
  without a document switch, which would clear the selection in the very
  render that sets it. Leaving for View shows `shapes.ttl` in the editor;
  leaving for anything else goes back to the model. From the editor's own
  panels, which do switch, the selection waits in `pendingSelection` for the
  effect after the switch.

  **The Shapes list keeps a selection by id even when the list does not hold
  it.** The Chrome pass found two ways the form lost its shape: a list still
  on its way after a create, which dropped the shape just made, and undo then
  redo of a create, which brought the shape back with nothing selected.
  Delete clears the selection on purpose. Focus goes to a new shape's form
  once that form is drawn, not when the command answers, or it fell to the
  page.

  **The rule editor sends back what it does not show.** It offers the kinds
  that fit the path's kind (5.3), so a rule written in Turtle may carry a
  check it has no field for: a datatype on a name, a class on an attribute.
  Editing the count used to drop it; now every field the editor does not
  show is kept, an untouched allowed-values list goes back exactly
  (language tags and commas inside values included), and a one-sided count
  stays one-sided rather than gaining a maximum of 3. The reader marks a
  type of value or a bound the form does not offer (`xsd:double`) as
  read-only, so the form never presents an edit the commands would refuse.

- **Example data** (2026-10-02, V-6 Stage B, `shacl-authoring-and-validation.md`
  5.8 and 5.9, D-095).

  **An example is decided in one place.** A shape's `sh:targetClass` finds
  any individual typed with the class, so an example is exactly that: a
  named node whose rdf:type is a class of the model (or an import), or one
  typed `owl:NamedIndividual`, and not itself a class, property, concept,
  scheme, ontology or shape. `CreateExample` writes both types, so the graph
  view colours it as an individual; Turtle may write only the class, and it
  still counts. `examples.py` says so for the node route, the tree's forest
  and the commands alike; a second rule anywhere would let a Turtle-written
  example be checked by a shape but missing from the form.

  **The Examples section has its own expansion.** The tree keeps one set of
  open rows keyed by IRI, which was safe while every IRI was in one forest.
  The Examples section lists each class again, as the heading its examples
  sit under, so opening Person there opened Person in the class tree too.
  The section's classes start open and have no actions: a class is changed
  in the class tree.

  **A validation belongs to its project.** A check still running when the
  project was closed, or another opened, used to announce its summary in the
  next project and free its Validate early; and a second press while one ran
  sent a second request. The store numbers each run and moves the number on
  at every open, close and reset: an answer from an old run sets nothing,
  says nothing, and its failure never reaches the next project's error bar.

  **The Small template's starter shapes are for row S23.** With only Alice
  and Acme, a first Validate had no shapes, and the suggested rules all
  passed: `sh:class` does not fail on a missing link. So the template ships
  three shapes written as the form writes them (each opens editable), and
  Alice is not yet member of Acme, which makes *Person rules* red until the
  learner links her (D-095). Stage A's tests that make the first shape
  command create `shapes.ttl` need a Small project without the file: the
  `bare` fixture removes it from the folder and the manifest before opening.

  **A blank-node shape is found again by what it is.** Its `_:` id is the
  parse's, so Undo or Redo of a Turtle apply, from the Shapes view, swaps it
  for the other side's id and the form lost its shape. The view remembers
  the shape it showed and, when its id is gone, selects the one shape with
  no IRI and the same name and target. The Chrome check mutated this away
  and went red on Undo; Redo alone would have passed, as it brings back the
  first id.

  **`name (label)` only where it is needed.** rdfs:label reads *name*; when
  the model has an attribute or relationship itself labelled "name", two
  paths both read "name" and a dict keyed by label in the tests had folded
  the two rules into one. It reads *name (label)* then, found by index
  lookups on the label so the shapes list stays inside its budget, and the
  plural goes before the brackets.

- **Data snapshots** (2026-10-02, X-10 Stage A, `csv-data-import.md` 5.1 to
  5.7, D-096 to D-099).

  **The 2,000-row limit is the engine's, not only the wizard's.** D-098 says
  no path ever produces data from more than 2,000 rows. The reader keeps at
  most 2,000 and counts the rest, the import refuses a larger file unless
  the sample was chosen, and `rml.run` itself takes `table.rows[:MAX_ROWS]`,
  so a refresh, a changed mapping and an edited mapping stop there too. A
  test writes 3,000 rows into a snapshot's copy behind its back and asserts
  an edited mapping still makes 2,000. `MAX_ROWS` reads no environment, and
  a test asserts the module imports no `os`.

  **An edited mapping's source is checked first and on its own.** `rml.read`
  refuses anything outside the subset, and a mapping outside it is kept as
  written with its reason (it runs in other RML tools). A mapping that
  named `../model.ttl` beside an `rml:function` would have been kept that
  way, harmlessly, since the engine never opens a file -- but kept all the
  same. So `edit_mapping` checks every `rml:source` before anything else and
  refuses the whole mapping, keeping nothing (D10). The engine is handed the
  table the snapshot read; a test patches `open` to fail and runs it.

  **The copy is written, not copied.** `source.csv` is the table as imported:
  the header as the mapping names it (an empty or repeated name renamed, a
  header-less file given `column 1`...), a `row` column when rows are
  identified by number, the first 2,000 rows only, values trimmed, in the
  dialect the mapping declares and without a byte-order mark. That is what
  makes RMLMapper 8.1.0, run on the folder, give the app's statements
  exactly (D13), and what lets every import take one path: write the copy,
  read the mapping back from its text, run it on the copy.

  **A value that does not fit is plain text, never ill-typed (D-097).**
  `lexical.py` holds the patterns the editing form refuses by, so what the
  form refuses is exactly what an import keeps as text; rdflib alone is not
  strict enough (it reads `2026-1-5` as a date). RMLMapper, by contrast,
  writes `"yesterday"^^xsd:date`: on such a file the two engines differ in
  exactly those values, by design.

  **Snapshots move the generation, never the revision.** They are not model
  changes (5.7): no revision, no dirty flag, no undo step. The server counts
  their changes in a per-project generation, the model's data view is cached
  on revision and generation, and App keys the model's views (graph, tree,
  detail panel, query builder) on the sum of the two, which grows whenever
  either does. The canvas and the Turtle editor keep the revision: they show
  the model alone.

  **Data joins the view whatever the imports switch says.** The merged view
  was opt-in, so data behind it would have vanished with the switch off.
  `ImportsService.reading` serves the model plus data with the switch off,
  and model plus imports plus data with it on; the editing commands and the
  canvas keep `merged()`, without data, so a command never targets a row.

  **A snapshot's individual is read-only everywhere.** The detail panel's
  edit section first offered Rename, Change identifier and Delete on one,
  found in Chrome: the model view held its type, so it looked defined here.
  `fromData` now makes the section read-only, as `importedFrom` does, the
  example form is never built for one, and its tree row has no actions.

  **`data.ttl` is read by `read_ntriples`.** rdflib's N-Triples parser took
  0.64 s for one full snapshot (40,000 statements); opening a project with
  two measured 956 ms against the 1 s budget. The file is the app's own
  output, so a strict line reader takes it in 0.39 s (open: 695 ms), and any
  line it does not recognise sends the whole file to rdflib as Turtle.

  **The card's line is written from the folders when the project is shut.**
  A switch or a remove does not need the project open, and the manifest's
  `data` list was built from the snapshots in memory -- none, when closed --
  which emptied the card. Found in review.

  **The data routes look at the project before the body.** FastAPI refused a
  JSON body sent where a file was expected with 422 before the route ran,
  so an id not issued answered 422, not 404; the generic route test caught
  it. Each route now checks the project (and snapshot) first.

  **The wizard's class reading belongs to its class (PR #53 review).** The
  identifier check, the fields and the suggestions were held without the
  class they were read for, so a class changed on step 2 carried the old
  class's columns into step 3, which the server then refused. The reading is
  now held with its class and identifier and used only while both are still
  chosen; until the new one arrives, or after it fails, Next waits with its
  reason and a failure offers Try again. A second file's id suggestion was
  lost the same way, to a closure holding the first file's identifier: the
  reset values are now passed into the read. Leaving past step 3 asked only
  from Cancel; the dialog's close button and its tabs dropped the mapping
  without a word, and now ask too.

- **Excel workbooks and links between snapshots** (2026-10-03, X-10 Stage B,
  `csv-data-import.md` 5.8, 5.9 and Section 9, D-100 and D-101).

  **A workbook's entries are read in chunks, never with `ZipFile.read`.**
  The defences judge a workbook from the ZIP's directory first: 100 MB
  unpacked, 100:1. But the directory can lie, and `ZipFile.read` inflates an
  entry's whole compressed data in one call before cutting it to the
  declared size, so an entry declaring 1,000 bytes and holding 20 MB of
  zeros took 52 MB to refuse (`test_xlsx_defences` measured it). Every entry
  is now read to its end in 64 KB chunks before openpyxl sees any: a liar
  fails its CRC with memory flat, and openpyxl then reads only entries
  whose sizes are proven. The same pass refuses a document type
  declaration, which Excel never writes and every XML entity attack needs.

  **openpyxl must parse through defusedxml.** It does so only when the
  package is installed and `OPENPYXL_DEFUSEDXML` is not `False`; otherwise
  it uses the standard library's parser quietly. `tabular._open_workbook`
  checks `openpyxl.DEFUSEDXML` and refuses the workbook rather than parse it
  without. A test switches the byte scan off to prove defusedxml alone still
  refuses each entity case, with a recording server seeing nothing.

  The flag was not enough (PR #54 review). With `lxml` installed, openpyxl
  takes lxml's `fromstring` for `workbook.xml`, the relationships, styles
  and comments, while `DEFUSEDXML` stays True, so the guard passed on a
  machine with lxml and the claim was untrue there. openpyxl chooses on
  first import, so `tabular.py` sets `OPENPYXL_LXML=False` at its top,
  before anything imports openpyxl, and `parses_through_defusedxml()`
  checks the functions themselves (`openpyxl.xml.functions` and the names
  the readers bound) and refuses unless every one is defusedxml's. A test
  imported openpyxl before `app.tabular` loses the switch, so
  `test_xlsx_defences` imports `app.tabular` first, and the lxml case is
  proved in a fresh interpreter (skipped where lxml is not installed).

  **A sheet's rows come from openpyxl's parser, not `iter_rows`.** The row
  iterator pads every row to the sheet's declared width and yields every
  missing row, so one crafted cell in `XFD1048576` makes millions of empty
  values. `WorkSheetParser` yields only the cells written; openpyxl is
  pinned at 3.1.5 because this is its internal API.

  **Step 1's pickers stay mounted while the file is read again.** They were
  rendered under `!reading`, so changing the sheet unmounted the select
  being used and keyboard focus fell to the page (found by X4 in Chrome;
  Stage A's separator select had the same drop). And `hidden` on
  `.wizard-detections` did not hide it, because the class sets `display`:
  jsdom passed, Chrome showed a workbook a CSV separator. Render
  conditionally instead.

  **Only the latest read's reply is applied, and Next waits for it.** Quick
  sheet changes raced: a slower reply for the earlier sheet replaced the
  newer one, so the table showed another sheet than the picker, and Next
  could be pressed on it (PR #54 review, reproduced in Chrome). `read()`
  numbers each request in a ref and drops any reply but the latest's;
  `reading` is cleared only by the latest, and `stepBlocked` says *Reading
  the file…* on step 1 while it is set.

  **A sheet that gives no table still names the sheets.** An empty first
  sheet, or a table starting at row 3, answered 422 with nothing else, and
  the wizard had no Sheet or Header row picker to put it right. Not chosen,
  the sheet is now the first holding a value and the header row its first
  row holding one; a chosen empty sheet or row is refused with the sheet
  list and top rows in the 422's `detail.workbook`, which the wizard shows.

  **Links to no row are counted when asked, never stored.** Which row
  points at which IRI is kept in `snapshot.json`; whether that IRI is a row
  depends on the other snapshots, which come, go and switch after the
  import. `summary()` counts against the switched-on snapshots each time, so
  importing the target second, or switching it off, changes the first
  snapshot's report without touching it. Stage A's D1 expected a clean
  report with `org` linking to nothing; it now reports those two rows.

- **Reasoning** (2026-10-09, V-7 Stage A, `axioms-and-reasoning.md` 5.1 to
  5.7, D-102 to D-104, D-106).

  **The reasoner runs in a spawned process, everywhere.** A run can take
  minutes on a dense model, and a thread cannot be stopped; a process can be
  killed. `spawn`, not Linux's `fork`, on every platform, so CI tests what
  Windows runs and the child inherits none of the server's threads or locks.
  A script that calls `reasoning.reason` must sit under
  `if __name__ == "__main__"`, since spawn re-runs the caller's top level;
  the server and pytest already are. The packaged app (X-9) needs
  `multiprocessing.freeze_support()`.

  **Blank nodes come back under their own labels.** rdflib gives every blank
  node a fresh id on parse, so the worker's conclusions about a restriction
  (*order 7 is one of [only Order lines]*) named blank nodes the server never
  had, and the *only* family found no reason for *L1 is an Order line*. The
  worker parses with a `bnode_context` it keeps, maps each fresh id back to
  the label it was sent, and the server parses the answer with
  `_SameLabels`, a context that maps every label to itself.

  **Generalized RDF stays in the worker.** OWL-RL concludes
  `"Manager"@en owl:sameAs "Manager"@en`; N-Triples cannot carry a literal
  subject and the parse of the whole answer failed. No such statement is ever
  shown, so the worker drops them.

  **Names come from the stated facts.** OWL-RL copies a label across
  `owl:sameAs`, and read from the closure, Anne was named Ann.

  **The marks go at once.** In Chrome (R5) the tree kept four inferred rows
  after an edit, for as long as its refetch took. The tree and the canvas now
  strip a result's marks themselves the moment the flag goes off
  (`withoutInferred`, the canvas's filtered view), and App derives the flag
  for the tree, the canvas and the detail panel from one rule
  (`marksShown`).

  **Tree rows are keyed and focused by their path.** The same R5 run showed
  the rows still there after the strip: keyed by entity id, a node under two
  parents gave React two rows with one key, and the duplicates stayed in the
  DOM. The roving focus had the same flaw, so Shift+F10 on the second row
  opened the first row's menu. Inferred memberships made two parents common;
  the defect was older. Both now use `row.key`, the path from the root.

  **One way round, by IRI.** A pair concluded both ways (`owl:sameAs`,
  equivalence) is shown once; which direction depended on set order, which
  changes with Python's hash seed, and a test failed one run in three. The
  kept direction is the IRIs' order.

  **A test trap found here.** `beforeEach(() => mock.mockReset())` returns
  the mock, and vitest runs a function returned from `beforeEach` as its
  cleanup: the mock was called with no arguments after each test. Brace the
  body.

- **Rules on a class** (2026-10-10, V-7 Stage B, `axioms-and-reasoning.md` 5.8
  to 5.10, D-105, D-106 Q3).

  **Read strictly, so the round trip holds.** `axioms.parse_restriction`
  accepts a blank node only when every predicate on it is one 5.8's shape
  uses, once: one `owl:onProperty` naming a property, one value predicate, a
  qualified count's one `owl:onClass` or `owl:onDataRange`. A looser reader
  showed a restriction with an extra `rdfs:comment` as a sentence, and Edit
  would have written it back without the comment. *some* and *only* over a
  datatype are legal OWL but outside the sentences, so they are Turtle too.

  **Named by content, matched in the document.** A restriction has no IRI.
  Two identical ones written in Turtle are one rule by content; Remove takes
  one and the other stays. The key's filler compares Turtle's plain `"gold"`
  and the form's `"gold"^^xsd:string` as one value, as `_stored` already did
  for annotations.

  **Check it in data too never rewrites.** The V-6 form reads a qualified
  count only as the language rule, so a shape that gets one is read-only in
  the Shapes view and its commands refuse it; CheckInData itself adds a new
  property shape and touches nothing there. A plain rule (`sh:class`, a
  count) joins the form's rule on the path, as Add on a suggestion does, so
  an editable shape stays editable, and is refused when it disagrees. The
  validator's own words for a qualified count were *Focus node does not
  conform to shape MinCount 1*; `shacl.py` now says *order 7 is not linked by
  has line to an Order line; every Order must be.*

  **The canvas cost.** Asking every class for its rules took the
  10,000-statement view from about 45 ms to 110 ms on this machine; one scan
  of each predicate first, then only the classes with rules, brought it back
  to about 48 ms.

  **Budgets under load.** The full backend suite run beside the Chrome
  server missed three timing budgets (explain 6,000 facts, two snapshots);
  each passed alone, on `main` and on the branch.

  **owl:AllDisjointClasses counts.** Protégé writes the disjointness of
  three or more classes as one `owl:AllDisjointClasses` with `owl:members`.
  Stage B first read `owl:disjointWith` only, and the analyst's review of
  PR #56 found the group invisible: the class's block showed nothing, *Person
  means the same as Organization* was accepted though the two were disjoint,
  and the box had no *never* note, while the reasoner found the
  contradiction. Every disjointness check now reads both forms through
  `axioms.disjoint_with` and `axioms.disjoint_pairs`: the equivalence
  refusal, both *can never have members* warnings (so a subclass made
  through E-8's command is warned too), and the canvas's *never* lines. The
  group itself is no sentence of 5.8 and names other classes than the one
  shown, so each member's block shows it as read-only Turtle, and
  `RemoveDisjointWith` never touches it. `owl:AllDisjointProperties` is not
  in scope: no Stage B check is about disjoint properties, so nothing reads
  it, and it is neither shown nor checked.

- **Edit page** (2026-10-11, E-9, `edit-page-rework.md`, D-107; fixes CF-9).

  **The outline's height rule.** At 1280x720 the old tree sections were
  `flex: 1; min-height: 0` with no clipping and got 39 px each against 59 of
  content, so they drew over each other and the *Relationships* header took
  the click meant for **New class**. A section now clips its content
  (`overflow: hidden`, its tree scrolling inside it), a folded one is its
  32 px header, and open ones share what is left with a 120 px minimum each;
  past that the column scrolls. Sharing equally was not enough: two open
  sections at 1280x720 got 190 px of tree each, 6.8 rows against row E1's 8.
  So an open section is also capped at its own rows (an inline `maxHeight`),
  and the height a short section does not need goes to a long one: 20
  classes beside 2 relationships showed 10 rows. Two long sections still
  share equally, 6.8 rows each at that size.

  **One draft.** A new class can be begun from the canvas palette, a drop on
  a box, an outline +, a row's *Add subclass* or the side panel; it was three
  forms, each with its own name. Now the draft is the project store's
  (`creating`): the canvas draws its box, the side panel its form, and both
  show one name, so typing in either shows in the other. The store makes it
  in one command, which is why CreateClass and CreateConcept take an
  optional `definition`: the form's definition and the class are one undo
  step. The side panel's own **New class** button is replaced by the form
  while the draft is open, so Cancel finds the control standing in its place
  by its `data-create-from` name; without that, focus fell to the outline's
  heading.

  **Focus on what was made.** After Create, the new box is drawn only when
  the canvas's refetch for the new revision lands, which can come before the
  store's result or after it. Focusing at once found no box (row E6 in
  Chrome: focus stayed on the + the draft began from); waiting for the box
  to appear missed the case where it was already there (row E4, the drag
  route). The canvas focuses it now if drawn, else when it is.

  That was still not enough in a browser (PR #57 review: every route, both
  test models, focus back on the control the draft began from). React Flow
  draws a new node `visibility: hidden` until it has measured it, and
  Chromium ignores `focus()` on a hidden element; a focus a tick after the
  box appeared won or lost that race (4 of 6 routes lost on the unfixed
  build). jsdom focuses anything, so the tests passed. `focusBox` now tries
  again every 16 ms until the box holds focus, for at most a second, and
  stops if focus moved elsewhere meanwhile. The test stub draws a new box
  hidden for 40 ms and refuses `focus()` on a hidden element, as a browser
  does; both orders of refetch and result go red without the retry.

  **Colour by kind, checked twice.** The tokens are custom properties in
  `index.css` (both themes) and the same values in `canvas/kindColours.ts`,
  whose test measures every pair against 5.8's floors and reads the
  stylesheet to catch drift. Measured: the relationship line `#b0763a` is
  3.4:1 on the page's grey `#eef1f6`, under 5.8's 3.7, and 3.8:1 on white,
  so the canvas surface is white in the light theme (`--canvas-bg`). The
  lightest word on its tint is 5.175:1, which 5.8 rounds to 5.2; the test's
  floor is 5.1. React Flow's markers take no colour from CSS and scale with
  the stroke, so the canvas defines its own, one per line kind, in user
  space; the legend draws its samples with them.

  **The outline does not import from `canvas/`.** App reaches `canvas/` only
  through `React.lazy` (D-086), so the outline's dots map their kinds to the
  same tokens in `HierarchyView.tsx` itself. That took `kindColor` out of the
  outline: three users remain (X-6), and Explore keeps its palette until
  U-10.

  **classType costs no lookup.** It is read in the scans that already found
  classes: two subject scans in `canvas.py`, the one `rdf:type` scan in
  `hierarchy.py`. A counting graph pins the triple-pattern count of a build
  on a fixture: 55 for the canvas and 29 for the hierarchy, the same as on
  `main` at `4c0bb46`.

  **Not changed.** The spec asked for the reasoning panel's 35% line to be
  removed from `CLAUDE.md`'s rules; there was no such line, only the CSS
  (`.reasoning { max-height: 35% }`), which is gone, and a test asserts it.

- **Tidy-up, October 2026** (2026-10-13, X-12, `tidy-up-2026-10.md`, D-108;
  fixes CF-2, CF-3, CF-4). Twenty-six small items from five reviews, in one
  pull request, one commit per group.

  **A timed-out query is stopped from outside.** `executor.shutdown(wait=
  False)` left a timed-out query running with nothing bounding it (CF-2).
  As first built, a stop flag checked between rows ended a query producing
  rows, but one still computing its first row (a three-way join under ORDER
  BY) kept its ontology's key for as long as it ran, and every later query
  there was 409, still 90 s on in the review's probe (PR #58 review, spec
  v1.2). Now each query runs on a thread of its own, and at the timeout
  `QueryStopped` is raised in it with `ctypes.pythonapi.
  PyThreadState_SetAsyncExc`; the same stuck query ended 0.04 s after the
  stop. Three things make that safe. The stop is sent only while the worker
  is *armed*, inside its query, under the lock the worker takes to disarm,
  and disarming clears a stop sent but not yet delivered: so it never lands
  in `end_run` or the read lock's release, and never in a later thread
  reusing the id (`_Stopper`). The thread is never a pool's, which would
  carry a stop into its next query. `QueryStopped` is a `BaseException`, so
  an `except Exception` in rdflib cannot swallow it. The worker takes the
  ontology's read lock itself (the router no longer holds it around the
  call), so a stopped query lets go of it in its own cleanup instead of
  reading on unlocked after the request has gone; it serialises the rows
  under the same hold, so their labels are of the revision they came from,
  and the timeout starts only once it holds the lock, so a query queued
  behind an edit is neither timed out unrun nor called "still stopping".
  The stop is held off round a SERVICE call (`sparql_service.hold_stop`,
  `_Stopper.held`): the broker's and the socket's code is not written to be
  interrupted between a lock and its bookkeeping, and the call's 20 s limit
  bounds the wait; a stop asked for meanwhile is raised as the hold ends.
  Disarming is in a `finally`, so a query ending in an ordinary error is
  disarmed too. A stop can be lost: on Linux CI one landed in a `WeakSet`
  remove callback the collector ran on the worker, was reported as
  unraisable, and the join ran on (409, and its CPU failed an unrelated
  timing test). So the stop is sent again every 50 ms of the grace while the
  worker is armed and alive. A resent stop can land as the worker disarms
  and reach its cleanup; that is made harmless rather than prevented: the
  worker's end is its thread's end (`is_alive`), never a flag it must set,
  and the read lock is a `with` the exception unwinds. A stop lands only at a
  Python instruction: a worker inside a C call or a network wait still
  alive `STOP_GRACE_SECONDS` (2 s) later keeps its ontology's id in
  `_abandoned`, and a new query there is 409 *The last query is still
  stopping. Try again in a few seconds.* (D-108). The row-loop flag stays,
  for a stop that reached the worker in C. A query whose rows were complete
  when the timeout fired was never sent the stop and keeps them. The client
  reads a 409 as an approval request only when its body has the approval
  shape, so this one shows as its sentence. The tests: the stuck join frees
  its ontology inside 3 s (a simple query then answers 200); a worker waiting
  on a gate in C still gets the 409; a worker in its cleanup when the
  timeout fires finishes it whole, and so does one ending in an error; a
  query behind a held lock answers; one hold of the lock per query; a stop
  asked for during a SERVICE call waits for the call; a stop lost in a
  finaliser is sent again. Each goes red with its
  part of the fix removed. Accepted: a worker stuck in a C call keeps the
  project's edit lock until the call returns, as the spec gives the lock to
  the worker.

  **The source view writes a part of a large ontology, not all of it.**
  Above `BOUNDED_SOURCE_FROM` (20,000 statements; the bundled vocabularies run
  37 to 120 bytes a statement in Turtle, so the wordiest pass 2 MB there) the
  formatted view serialises whole subjects in IRI order, each with its blank
  nodes, until an estimate of the Turtle passes the cap, and answers
  `statements: {shown, total}` (CF-3). Measured on 200,000 generated
  statements: about 3.5 s for the part against 6 s for the whole, and the
  part's cost no longer grows with the ontology. The test counts the
  statements handed to `Graph.serialize`; the documentation export keeps
  `pretty_turtle()`, whole, and a test says so.

  **A search answer is applied only if it is the latest.** Cancelling the
  debounce timer did not stop a request already sent, so a slow answer for
  *Pla* could replace the one for *Planet* (CF-4). Searches are numbered, as
  the data wizard's reads are, and only the latest one's answer is applied;
  the one it replaces is aborted through `searchNodes`' signal. The number is
  what makes it correct: an answer can already be on its way when the abort
  comes.

  **One a/an rule and one verb rule per side.** Four copies chose the
  article by the first letter (*an University*, *a XML file*) and two verb
  rules disagreed (*must be uses*). `backend/app/sentences.py` and
  `frontend/src/modeling/sentences.ts` now hold one of each, and both suites
  test them with one table, `frontend/src/modeling/sentences.table.json`, so
  they cannot drift apart. `test_sentences.py` and `sentences.test.ts` scan
  every module for a function named for either rule, the first-letter
  ternary or the verb rule's word lists, after asserting they read the
  files. The scan found two copies nobody had listed, in `editing.py`. No
  article is guessed before a label: *Ann is member of Team A* stays.

  **Where the spec and the build differ.** T-25's refusal is 422, as every
  command refusal is, not the 409 the spec wrote. T-22's test is in
  `test_examples.py`, not `ExampleForm.test.tsx`: the example's choices are
  the server's, and the form is not told a relationship's characteristics.
  T-21 writes *has exactly one line*, as 5.8 writes one, not *exactly 1*.

- **Portal foundations** (2026-10-15, U-11, `portal-foundations.md`, D-109;
  fixes CF-10, closes X-6 and G-2). One palette, six sizes, one button set,
  the status bar's words, the bin out of the context bar, Home at its top.

  **One place writes a kind's colour.** `frontend/src/theme/kinds.ts` holds
  every kind's accent, tint and ink in both themes and every edge colour;
  `canvas/kindColours.ts` and `types.ts` read it, so the Edit page and every
  other tab cannot drift apart again. It sits outside `canvas/` because App
  reaches `canvas/` only through `React.lazy`. `index.css` still says the
  Edit page's values as custom properties (CSS cannot import TypeScript), and
  `kindColours.test.ts` checks they agree. `theme/kinds.test.ts` scans every
  production source for a palette hex outside `theme/`, after asserting it
  read them; the dark graph's `dimEdge` equals the dark *other* tint by
  chance and is allowed by its line, not by its value. Graph nodes are
  measured as drawn, composited at `GRAPH_ALPHA`: at the old 90 % the light
  object property was 3.03:1, so the test's floors are 5.3's (3.2 light,
  6.0 dark), not AC-3's 3:1, or putting 90 % back would pass.

  **classType is a colour, not a kind.** `graph_builder.py` reads the two
  class typings in its first pass and marks a class typed only `rdfs:Class`
  `classType: "rdfs"`; `kind` stays `class`, so filters, counts and Query
  are untouched. `stats.rdfsClassCount` counts them over the whole ontology,
  as `kindCounts` does (D-017), for the legend's line under Class. The path
  bar reads the query schema, which has no class type yet (U-12), so App
  hands it the RDFS-only classes the graph holds; one the budget did not
  draw is shown in the OWL colour there. Query's start list keeps the OWL
  colour (Section 15). The Home thumbnail's sketch carries no class type
  and nothing backfills a sketch, so it stays OWL-coloured too.

  **Every lookup by kind is own-key.** A kind is a string from a loaded
  file, and `KIND_LABELS["constructor"]` was Object's constructor, truthy,
  so `?? "Other"` never fired (X-6). `own()` and `paletteKind()` in
  `theme/kinds.ts`, `kindLabel()`, `kindColor()`, `nodeColor()` and
  `edgeColor()` in `types.ts` are the lookups; ES2020's lib has no
  `Object.hasOwn`, so it is `hasOwnProperty.call`, as `networkWords.ts`.

  **Six font sizes.** Every `font-size` in `index.css` is a `--fs-*` token or
  `inherit`; `styles.test.ts` scans it, the `font` shorthand included.
  React Flow's `base.css` loads after `index.css` and writes its credit at
  10 px, so the override carries the extra `.react-flow` class. Measured in
  Chrome on every tab against the previous stylesheet: no new clipping, no
  sideways scroll, and exactly the six sizes rendered.

  **The button set has no specificity, and the plain rule sets no size.**
  The set is `:where()` rules, so a class's own rule still places its
  button; the tabs, rows, cards, chips, links and menu items in its `:not()`
  list keep their shapes. As first built the plain `button` rule still set
  `font` and `padding`: element specificity beats `:where()`'s none, so no
  size in the set applied and icon buttons kept 12 px side padding, their
  icons squeezed to 4 to 8 px. The screenshots showed it; the tests did not.
  Both now sit in a `:where(button)` default, and `styles.test.ts` holds the
  plain rule to colours. The zoom stack keeps radius 0 between its three
  joined buttons. The turned-off look is one rule on
  `button[aria-disabled="true"]` (and `:disabled`, for the few native ones
  left), replacing five per-area copies.

  **Removal starts on Home only, and keeps focus.** The bin left the context
  bar (5.7) and `removeRef` with it. The spec said Home already placed focus
  after a removal from its menu; it did not: the Remove item unmounted with
  focus on it, and the card's ⋮ was natively `disabled` during the count, so
  focus fell to the page. The ⋮ is now `aria-disabled`, Remove closes the
  menu onto it first, and when the card goes Home focuses its start target.
  Checked in Chrome by keyboard.

  **Where the spec and the build differ.** The status bar counts what is
  there only when nothing is open: an ontology still open behind Home keeps
  its line, which two earlier tests require. `stats.rdfsClassCount` is a
  field the spec did not name. The light-theme text left under 4.5:1 by the
  first build (Turtle view keywords 3.99:1, strings 4.45:1, the accent blue
  as link text 4.36:1), with two more the analyst's review (spec v0.4)
  found, the line numbers at 60 % opacity (2.38:1 light, 2.93:1 dark) and
  React Flow's credit on its own pale panel in the dark theme (1.14:1), were
  closed in a review fix commit. Accent as text is now `--accent-text`
  (`#1d63cc` light, 5.00:1 on `--bg`; the dark theme's is `--accent`);
  buttons keep `--accent`, whose white label is another pair. `--literal` is
  `#3c781f` and numbers and types `#975c07` in the light theme; the gutter
  has no opacity; the credit sits on `--bg-raised`. `styles.test.ts`
  computes every light `.sparql-*` colour against `--bg`, `--bg-raised`,
  `--bg-panel` and the accent tint. The analyst's re-check (spec v0.6) then
  measured the detail panel's prefixed name at 4.36:1: `--accent` as text
  passes only on white, so no rule sets `color: var(--accent)` any more (21
  were moved to `--accent-text`; the dark theme is unchanged), and
  `styles.test.ts` fails on one that does. Query's numbered chips write their
  digits in `--accent-contrast`: white on the dark theme's pale kind colours
  was 1.83:1 to 2.28:1, `#0b1220` is at least 8.20:1. Their background is the
  class's kind colour, not `--accent`, and in the light theme white on three
  kinds is still under 4.5:1 (individual 4.12, object property 3.82,
  datatype property 4.28); left for the analyst. The Edit outline's relationship
  ends, *(Person → Organization)*, were an ellipsis at 1280x720 before this
  build (15 px of 128 shown) and are now 3 px, the row's ⋯ being a 28 px
  square; the outline's 264 px is the Edit page spec's.

- **Explore and Query layout** (2026-10-15, U-12 with U-4,
  `explore-and-query-layout.md`, D-110). Labels that fit, link names for
  the node in focus, the legend folded under 1440 px, the toolbar in words,
  Query's query first at 60 %, four switches that say whether they are on,
  the RDFS colour in Query's start list, search and save limits in words.

  **One overlap rule, cleared on `beforeRender`.** Sigma 3.0.3's grid keeps
  one candidate per 100 px cell, and a 13 px name is wider than a cell, so
  neighbours collided. Sigma has no hook between choosing and drawing, so
  the rule runs in the drawing functions GraphView hands it
  (`defaultDrawNodeLabel`, `defaultDrawEdgeLabel`, built by
  `makeLabelDrawers`): each asks `explore/labelBoxes.ts` to place its box and
  skips its label on a refusal. Two things a reader will not guess. First,
  on a hover Sigma redraws link names on their own
  (`scheduleHighlightedNodesRender`) with no `beforeRender`, so every link
  name would meet its own box from the pass before; a link seen twice since
  the last clear starts a new link pass, which drops the link boxes and
  keeps the node boxes. Second, the hovered and selected nodes' pills are
  reserved at the frame's first label, not in `beforeRender`: the pill is
  drawn above everything on the hover layer, Sigma may offer the selected
  name late in grid order, and `beforeRender` fires before the frame's camera
  matrix is set, so a box worked out there is in the last frame's place. A
  second overlap test anywhere else would drift from this one; that is the
  load-bearing rule. Link names are rotated, so two boxes are separated by
  the separating-axis test: a bounding rectangle refused names that touch
  nothing. Measured in Chrome by recording every `fillText` the canvases
  make, at 1280x720 and 1920x1080 in both themes: no overlapping pair at
  rest or with a node selected; drawn at rest against what Sigma offered
  (what `main` draws), 8 of 11 and 23 of 29 at 1280x720, 19 of 19 and 56 of
  66 at 1920x1080, `space-exploration.ttl` and a generated 200-class file.

  **Four switches, never one choice.** Auto, Paths, Distinct and Count are
  independent and combine (Distinct with Count, Paths with either). The
  design review proposed a segmented control; that would remove
  combinations people use. Each is a toggle with `aria-pressed` and a check
  mark beside the tint, in one `role="group"`.

  **Where the spec and the build differ.** The pills are reserved first
  (above); the spec says only that labels are placed in the order Sigma
  offers them. The 420 px Query panel under 1100 px went: it undercut the
  520 px floor. The duplicate-name note has no exclusion for the open query:
  saving the open query is an update under its own name and never shows the
  prompt. The search box's 100-row budget test now sees 25 rows, the most the
  box shows. Locally two backend timing budgets fail on this machine
  (`test_reasoning.py`'s six-thousand-conclusions explain, `test_snapshots.py`'s
  two-snapshot open) identically with `main`'s code; nothing here touches
  either path.
- **Home is one library with three bundled examples, and Home downloads
  nothing** (2026-10-16, spec `home-and-examples`, backlog U-13a, decision
  D-111). Space Exploration (`backend/app/examples/space-exploration.ttl`,
  832 statements, every floor of the spec's 5.2), The Lord of the Rings
  (`middle-earth.ttl`, 547 statements, facts only) and FOAF
  (`vocab/foaf.rdf` itself, not a copy) are added to the library once, at
  the first start, through the store's own `add` with `source: "example"`
  and fixed ids (`ont-` and 12 hex of SHA-256 of `example:<key>`).
  `<data dir>/examples.json` records each key and hash: a later start parses
  nothing (a count test), a removed example stays removed, and a changed
  hash replaces an entry still in the library under the same id, so its
  saved queries stay attached. `POST /api/examples/restore`, behind
  `local_guard`, is the only way one comes back; the Load dialog's
  Suggested tab offers it while one is missing. `examples/space-exploration.ttl`
  at the repository root is untouched: eight backend test files and the
  smoke run depend on its 142 statements.

  **Seeding is in the lifespan, never at import**, so a `TestClient` that
  never starts the app gets only the library it built; and a failure there
  is logged and the server starts anyway (a read-only data folder cost the
  person their own library otherwise). **An example is told by `source` and
  its `example` record, never by its name**: a person's own file may be
  called FOAF, and it sorts with their work. **The examples always follow
  the person's work**, newest first by `updatedAt` for a project and
  `addedAt` for a file, in `home/libraryOrder.ts`; its `EXAMPLE_ORDER` is
  read against the server manifest by a test.

  **Home's catalogue is gone, and with it the `memo` at Home's import** that
  the card grid entry above describes: `CatalogueList` has one caller, the
  Load dialog, and FOAF left `CATALOGUE` because picking it would add the
  example twice. The comment above the array says so.

  **The card is one sentence and two facts** (*832 statements*, *Added Oct
  14* or *Example*) and *Read-only* in words. **`.onto-card` must not clip**:
  found in Chrome, a card that short cut its own "⋮" menu off at Remove (a
  64 px row did even before), so the miniature clips its own corners
  instead; `styles.test.ts` pins both. **A person reads *statements***:
  `statusWords.statementCount` says it for the card, the picker and the
  status bar, and `wording.test.ts` strips comments and fails on *triple* or
  *triples* standing as words; *N-Triples* and the code's `triples` stay.

  Measured in Chrome from an empty data folder at 1280x720 and 1920x1080 in
  both themes: Home's first load asked for `/api/ontologies` and
  `/api/projects` and nothing else, the network activity log was empty,
  focus started on *Explore Space Exploration*; Explore, Query and View
  opened each example; a project started from Space Exploration came first;
  a removed example stayed removed across a restart and came back from the
  Load dialog, focus on the Suggested tab.
- **A failed load is one plain sentence; Shapes is two columns** (2026-10-16,
  spec `load-and-shapes`, backlog U-13b with U-2, decision D-112). A file no
  parser reads answers `422` with `detail` `{code: "parse_error", message,
  line, format, technical}` on both the upload and the URL route;
  `technical` is the old *Could not parse the file as RDF. Attempts:* text,
  unchanged. `store.py`'s `ParseError` keeps its attempts as (format,
  message) and the format the name suggested; `backend/app/parse_errors.py`
  is the one place a message becomes a sentence.

  **The sentence explains one attempt, chosen from what the file claims to
  be**: the suggested format's, else the attempt that got furthest (the
  highest line it reports), else Turtle's. A Turtle file missing a full stop
  also fails as RDF/XML at line 1 and as JSON at column 1; those messages are
  true and say nothing, and quoting them was the defect. A message the table
  does not know is named by format and line, never quoted. **A known message
  counts as a sign of RDF**: a Turtle file whose only fault is a missing
  `@prefix` has no `<` in it, and was first told it did not look like RDF. A
  NUL byte in the first kilobyte means a binary file, whatever its bytes
  contain. On a URL load the name wins and a server's `Content-Type`
  explains a nameless address; it never chooses the parser. The Load dialog
  shows `technical` in a `<pre>` under a closed `<details>`, as React text;
  a test puts markup in it and finds characters.

  **The Load dialog is a dialog**: `role="dialog"`, `aria-modal`,
  `aria-labelledby` its heading, focus in on open and back to the opener on
  close. **Escape's handler is on `document`**, as `useDialogTrap`'s is, and
  leaves a key pressed inside another dialog over this one (an approval) to
  that dialog; past the wizard's third step it asks, as Cancel does.

  **Shapes is the list and one panel** with *Shape* and *Results*;
  `SideTabs` takes its tabs as a prop and the Edit page keeps *Details* and
  *Reasoning* by default. Validate sits at the list's head and shows
  *Results*. **Results is shown, and its tab marked (*Results, 3 problems*),
  by watching the result, not the running flag**: App's test found a quick
  run that started and ended within one render, so the flag never looked
  true. A failed run marks nothing. The first shape is selected on arrival
  without moving focus.

  **The legend in Query starts folded and writes nothing**: open, it took
  208 px of a 512 px graph. App keys `Legend` on the mode, so opening it in
  Query lasts until Query is left, and Explore remounts and reads
  `semantic-studio-legend` again.

  The example files take US spelling outside proper names (*Indian Space
  Research Organisation* stays), and the mission is *Rosetta mission*, the
  spacecraft *Rosetta*. Their hashes changed with them, so a library already
  holding the examples is updated in place at its next start, under the
  same ids; a test seeds the older text and starts again. *Add the examples
  back* is `aria-disabled` while it works and ignores clicks; on failure
  focus stays on it.

  **Found in code review, fixed.** The Load dialog took its opener in its
  effect, after the URL field's `autoFocus` and the wizard's own effect had
  moved focus inside, so closing gave focus to nothing: it is taken at the
  first render now. A key from `<body>` while the approval dialog stood over
  it closed both, so any other `aria-modal` dialog open takes every key. It
  declared `aria-modal` without keeping Tab inside: `useDialogTrap`'s Tab
  wrap is exported as `wrapTab` and both use it. In Chrome that wrap let
  focus out at once: its last item was the dialog's `hidden` file input,
  which Tab never stops on, so focus passed the real last control and
  Shift+Tab stuck on the first. `wrapTab` now skips anything under
  `[hidden]` and, where the browser has it, anything `checkVisibility`
  calls hidden; jsdom has no layout and only the first is tested. In Shapes, choosing a row
  or making a shape while *Results* showed changed nothing visible (and a
  new shape's focus never landed), so both show *Shape*; and Validate
  unmounted the form, losing a rule being edited, so the form stays mounted
  and `hidden`. `ShapesView` is keyed on the project, so another project's
  arrival selects its own first shape.

  **Found in review, left as the spec writes them.** The name's format wins
  over the furthest attempt, so a Turtle file named `.owl` is explained as
  XML at line 1 (5.1's order); `<` is a sign of RDF, so an HTML page gets the
  XML sentence, not *does not look like RDF* (5.1's list); a missing full
  stop reported at line 1 still says *the statement before this line*
  (5.1's table); the Results badge's number uses the browser's locale like
  every other count in `shapeSentences.ts`.

- **Explore rules: restrictions are lines and sentences in Explore**
  (2026-10-16, spec `explore-rules`, backlog G-7, decision D-113). A class's
  restriction that the Edit canvas draws is a `rule` edge on `/graph`, from
  the class to the named class it reaches, carrying `rule` and `key` as the
  canvas's edge does; a library class's `/node` carries `rules.items`, every
  one read-only, and Explore's detail panel says them under **Rules**.

  **`graph_builder.py` reads restrictions only through `axioms.py`.**
  `rule_edges` scans `rdfs:subClassOf` and `owl:equivalentClass` once each
  and hands each blank-node object on a typed class to
  `axioms.parse_restriction` or `axioms.parse_defining`, once; whether it is
  a line is `axioms.draws_line`, which `canvas.py` asks too. A second reader
  would draw a different set than the canvas sooner or later, and the two
  pages would disagree about one file. `test_graph_builder.py` scans the file
  for the restriction predicates, compares the two pages' sets (source,
  target, key) on two files, and counts the parse calls: asking
  `axioms.contents` per class instead cost about half as much again on
  10,000 restrictions, and the test makes `contents` raise. `axioms` is
  imported inside `rule_edges`: it reaches back to `graph_builder` through
  `examples` and `shapes_form`, and a top-level import is a cycle.

  **A rule edge is keyed by its `key`**, `rule|source|key` in `GraphView`:
  two rules can join the same two classes (*some* and *at most 3* on one
  property), both with an empty label, and the old `kind|label|source|target`
  key dropped the second as a duplicate. The server sends one edge per
  (class, key), however often the same rule is written: two would share a
  key, and graphology refuses the second.

  The line is solid, `EDGES.rule` (the Edit page's rule colour, shared with
  *disjoint with*; the legend lists *rule* right after it), through Sigma's
  own arrow program (Section 15 of the spec). Its words go through D-110's
  overlap rule like every link name, so at 1280 px *at least 1 · crew member*
  is skipped where it would cross the *crew member* node's name and drawn at
  1920 px; the detail panel always says it. Where the read-only **Rules**
  block is drawn, the blank-node rows under the four rule predicates are
  left out of the statements and out of their count. With the Edit section
  on screen (a project's model, in Explore too) the block is not drawn and
  the rows stay. The documentation site leaves rule edges out, since its
  viewer has no words for them, and with them any untyped entity only a
  rule reached.

  **Found in code review, fixed.** The rows were first hidden whenever
  `rules` came back, but the Edit section says rules only in some of its
  forms (not for an imported class, an example, or a class of the other
  kind), so there they vanished; they stay now. When the server cuts the
  statement list, only the page it sent is known to hold rule rows, so the
  heading keeps the true total and the note says how many of the page went
  to Rules. The same rule written twice is two items in the block, keyed by
  their place as well. `draws_line` first left out every rule to
  `owl:Thing`, which changed the canvas for a document that declares
  `owl:Thing` a class (it drew that line before); it takes the boxes now.
  On the docs site, an untyped node only a rule reached became a dot
  joined to nothing; it is left out.

  **Found in code review, left.** A rule whose filler is its own class is a
  loop, which Sigma's straight arrow does not draw: the edge is there (one
  set with the canvas, two more degree), the line and its words are not,
  and the detail panel says it. Parallel lines between the same two classes
  overlap, and D-110 skips the second name. Both want an edge program of our
  own, which Section 15 of the spec decided against. Card miniatures made
  before this change ranked by the old degree; nothing backfills them.

  Measured on the generated 5,000-class, 10,000-restriction file (69,119
  statements, 2,000 of them definitions), median of five: `build_viz_graph`
  118 ms before, 553 ms after, against a 1,000 ms budget. Each term is named
  once per build: labels were a fifth of the rule pass.

- **The explain panel: In plain words, and what the words mean**
  (2026-10-16, spec `explain-panel`, backlog L-2, decision D-114). The node
  response carries `explain` for every ontology's entity: its kind, its
  authors' description, and the facts its file states, as structure. The
  detail panel words it as **In plain words** wherever no Edit section is
  present, and ends the block with a closed **What these words mean**.

  **A standard term's definition lives in `explain/glossary.ts` alone; a
  SKOS mapping's in `MAPPINGS`.** The list is the app's own, fixed, keyed by
  full IRI, and nothing is fetched or generated (D-114): a learner reading
  a definition has to be able to trust that it is the one the reviewer
  read against its standard. A second list, or a definition written in a
  component, would drift from it without a test noticing. The SKOS mapping
  definitions are `modeling/sentences.ts`'s, the Edit page's concept form's
  words, read from there: copied, the two pages would one day say two
  things about one term. `glossary.test.ts` checks that every standard term
  the bundled examples show has an entry, against `exampleTerms.json`,
  which `test_node_detail.py` measures from the files themselves; and that
  each entry is one sentence of at most 25 words naming no prefixed term.

  **The panel's kind is the graph's, not `rdf:type`'s.** `term_kind` reads
  `rdf:type` alone, so Apollo 11, typed only as a Crewed mission, is
  *other* there and an individual on the graph. `node_kind` reads one node
  the way `build_viz_graph`'s passes do (its types, the kinds a
  subClassOf, subPropertyOf or SKOS link implies, and typed with a class
  means an individual), and `test_node_detail.py` compares the two on
  every node of every bundled example.

  **The words are the frontend's, through `modeling/sentences.ts`.** The
  server sends names and counts; `explain/explainSentences.ts` writes them
  with `a`, `parentSentence`, `linkSentence` and `asType`, so the one
  article rule stays where it is. A property's label is never read as a
  verb: the relationship sentence wrote *A Crewed mission crew member an
  Astronaut* for a library's noun label, so the block says *crew member
  links a Crewed mission to an Astronaut*. A sentence from `sentences.ts` is
  asked for with control-character markers where its names go and split on
  them, so each name stays the panel's term button and no name is ever
  searched for in a sentence.

  **Counts are bounded.** A class's members, its subclasses, a concept's
  narrower ones, a scheme's top concepts and a collection's members stop at
  10,000, reading at most 10,001 from one iterator; names are sorted and
  sent, three of them, only for a count of 50 or fewer. A class with ten
  thousand individuals costs the same as one with 10,001.

  **Found in code review, fixed.** A literal's type reached the panel only
  in the file's own prefixed form, so a file binding XML Schema as `xs:` got
  no definition, and one binding `dc:` to Dublin Core terms would have got
  the original set's; a literal now carries `datatypeIri` and the glossary
  looks that up. A datatype property's type of value is named `xsd:` by its
  namespace, whatever the file's prefix, so `typeWord` says *a date*. A
  domain or range given only as a blank node (a union) read as *a thing*;
  it reads *something the statements below describe*. A description in
  another language than the one shown says which, as a fallback name does
  (D-085). An empty description no longer hides the next predicate's, and
  the fallback among other languages is the first by tag, not store order.

- **Loads say their step and can be cancelled; parsing is off the event
  loop** (2026-10-20, spec `load-progress`, backlog U-1, decision D-115).
  The Load dialog says which step a load is on, under the control it
  started from, and Cancel throws the result away.

  **No `async` route parses or builds on the event loop; that work goes
  through `run_in_threadpool`.** The upload and fetch routes are `async`
  and called `store.add` directly, so a parse ran on the server's one event
  loop: behind a 35.5 MB upload a request for the library list waited
  47.3 s. A Cancel would have waited in the same line, so 5.1 came first.
  `test_load_cancel.py` reads every `async` route in `routers/` with `ast`
  for a direct call to `store.add` or `parse_rdf` (a nested def handed to
  the threadpool is skipped), and holds an upload inside its parse with an
  Event while the library list is asked for through the same client: the
  same portal, so the same loop.

  **A cancel is a mark the store reads, under one lock with the last
  check.** `loads.py` keeps the running loads by the browser's id, each
  entry removed when its route ends, whatever the outcome. `store.add`
  checks the mark on entry (after a download), after the parse, and takes
  `commit()` after the summary, before the first write; `cancel()` takes
  the same lock, so a cancel landing between the last check and the write
  cannot answer `stopped` for a load that is then written. A running parse
  is not stopped (D-013); only its result is dropped. An unknown id is
  `{"stopped": false}`, a non-UUID 422.

  **The dialog applies an answer only while its load is current.** The
  ref holding the running load is its identity: Cancel clears it, so a
  late success never opens and an aborted request never shows an error.
  Progress is written onto the ref's own object as well as the state,
  because Cancel reads `sending` there: a file still being sent never
  reached the server whole and is *Stopped* whatever the server answers,
  and reading it from a stale copy said *Stopped* for every file load
  (found by the tests). The ✕, Escape and a click outside cancel before
  `onClose`, and the unmount cleanup cancels too, for any other way the
  dialog goes. The upload is XMLHttpRequest, for `upload.onprogress`, its
  answer made a `Response` so `send`'s approval round reads it unchanged.

  **Found while building, not fixed (not in the spec).** `parse_rdf`'s
  `with ThreadPoolExecutor(...)` waits for its worker on the way out, so
  `ParseTimeout` reaches the caller only when the parse ends: the 60 s
  limit has never released a request early. `pool.shutdown(wait=False)`
  inside the block is undone by the context manager's own `shutdown(wait=
  True)`. Measured: a parse held 3 s under a 0.2 s timeout raised after
  3.01 s.
