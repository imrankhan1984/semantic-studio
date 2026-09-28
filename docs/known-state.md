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

