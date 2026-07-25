# Development Plan: Visual SPARQL Query Builder

> **Audience**: this plan is written for an AI coding agent (Opus 5) to execute
> in a later session. It contains no code — it specifies scope, architecture,
> behavior, and acceptance criteria. Read the whole plan before writing any
> code. Read `README.md` and the memory notes first; run the existing test
> suite before and after every milestone.

## 1. Goal

Add a **Query** mode to Semantic Viewer that lets users build SPARQL queries
**visually — no typing required**:

- Click classes on the ontology graph to build a **traversal path**
  (`Product → Order Detail → Order → Customer → …`).
- Click the predicate chip between two path steps to choose **which
  relationship(s)** connect them (forward, inverse `^`, multiple = alternation
  `|`), apply **property path modifiers** (`*`, `+`, `?`), and toggle
  **OPTIONAL** on that hop.
- Click a class chip to check **datatype properties** to include in the
  results and to add **FILTER**s on them.
- A **live SPARQL preview** re-generates on every edit.
- **Execute** runs the query against the loaded ontology and shows a results
  table.

Reference workflow: RDF Studio's "Visual Query Composer"
(https://rdf-studio.com). The user's video shows: a PATH chip bar above a
SPARQL preview pane docked to the right of the graph; numbered class chips
with predicate chips between them; a per-edge menu with "Make OPTIONAL",
path modifier radio (`none/*/+/?`), and relationship checkboxes ("check
multiple for `|`", inverse marked with `^`, one marked PRIMARY); a per-class
"Data properties & filters" popover with checkboxes and type badges; toggles
"Auto" (live preview) and "Paths" (compact property-path syntax vs explicit
triple patterns); EXECUTE with a results table (entity IRIs rendered as
chips, literal columns sortable); LIMIT 100 default; graph highlights the
selected path (selected classes strongly, candidate next hops with dashed
outline).

## 2. Hard constraints

1. **Do not disturb existing features.** Explore mode (current behavior),
   persistence, loading, theming, PNG export, drag physics must work exactly
   as before. All existing backend endpoints keep their contracts. All
   existing tests must keep passing unmodified (except imports if files
   move — avoid moving files).
2. **No paid/heavyweight dependencies.** Permissive licenses only (MIT/BSD),
   consistent with the README license table. Prefer zero new runtime deps:
   rdflib already executes SPARQL; syntax highlighting can be a small
   hand-rolled tokenizer (keywords/variables/IRIs/literals) instead of
   Monaco/CodeMirror.
3. **Token-efficient execution**: follow this plan milestone by milestone;
   don't refactor unrelated code.
4. Windows dev environment; PowerShell quirks documented in memory notes
   (e.g. use `git commit -F <file>`, backend venv at `backend/.venv`).

## 3. Where this fits in the existing app

- Frontend: React + TS + Vite in `frontend/`; graph = Sigma.js in
  `frontend/src/components/GraphView.tsx`; app shell/toolbar in `App.tsx`;
  API client in `api.ts`; types in `types.ts`; all styling in `index.css`
  (CSS variables, dark/light themes — new UI must support both).
- Backend: FastAPI in `backend/app/`; `store.py` holds each ontology as an
  in-memory `rdflib.Graph` (disk-persisted, lazily parsed — call
  `ontology.ensure_loaded()` before graph access); routes in
  `routers/ontologies.py`; viz extraction in `graph_builder.py` (node
  "kinds", edge extraction, label logic — reuse its vocabulary constants).
- The README's Roadmap already promises "SPARQL querying (the rdflib store
  already supports it server-side)" — this feature delivers that.

## 4. UX specification

### 4.1 Mode switch

- Add a small two-tab switch in the toolbar (left of the ontology selector):
  **Explore** (default, current behavior) and **Query**. State lives in
  `App.tsx`. Explore mode renders exactly today's UI.
- Query mode reuses the SAME GraphView/Sigma instance (pass a `queryMode`
  prop) — do not mount a second Sigma. In query mode:
  - The right side shows the **Query Panel** instead of (not alongside) the
    detail panel. Clicking nodes must NOT open the detail panel.
  - Only `class` (and `conceptScheme`/`concept`? — no: classes only, see
    §10 Q1) nodes are clickable as path steps; property/individual nodes are
    dimmed via the existing reducer mechanism.
  - Graph highlighting: path classes highlighted (reuse `highlighted` +
    zIndex conventions), candidate next-hop classes get a distinct visual
    (e.g. their kind color at full strength while others dim — Sigma has no
    dashed-outline support without a custom node program; dimming
    non-candidates is sufficient and cheap).
  - Clicking a candidate class appends a step; clicking a non-candidate
    class shows a transient hint ("No known relationship from X to Y — pick
    a highlighted class") in the panel, not an alert.

### 4.2 Query Panel layout (top to bottom)

1. **PATH bar**: numbered class chips (`1 Product`, `2 Order Detail`, …)
   with predicate chips between them (label of chosen predicate; `+` suffix
   when a modifier is set; dashed/outlined style when OPTIONAL). A `✕` on
   the last class chip removes the last step; **Clear Path** resets
   everything. Chips wrap onto multiple lines.
2. **Toolbar row**: `Auto` toggle (live preview on edit; when off, a
   "Refresh preview" button), `Paths` toggle (compact property-path syntax
   vs explicit per-hop triples, see §6.4), **Copy** (clipboard), and
   **EXECUTE** (primary button, disabled while running; shows spinner).
3. **SPARQL preview**: read-only, monospace, line-numbered,
   syntax-highlighted `<pre>` (hand-rolled tokenizer). Both themes.
4. **Results table** (after execute): column per projected variable,
   `RESULTS <n>` count badge, IRIs shortened to prefixed names/labels
   (clickable → selects that node in the graph and, in Explore mode,
   would open details; in Query mode just centers it), literals as text.
   Client-side column sort. Cap display height with internal scroll.
   Show query duration. Errors (timeout, malformed) appear in the existing
   error-bar style inside the panel.

### 4.3 Predicate chip menu (click a predicate chip)

- **Make OPTIONAL** toggle — "Results may or may not match".
- **Path modifier** radio: `none (exact)` (default), `* (zero or more)`,
  `+ (one or more)`, `? (zero or one)`.
- **Relationships** checkbox list: every candidate predicate between the two
  adjacent classes (see §5 schema), each with direction badge (`forward` /
  `inverse ^`); the auto-picked one is marked PRIMARY. Checking several
  produces alternation `|`. At least one must stay checked.

### 4.4 Class chip menu (click a class chip)

"Data properties & filters" popover for that step's class:

- Checkbox list of datatype properties (from schema §5): property label +
  datatype badge. Checking one projects a variable for it.
- Per checked property, an optional **filter row**: operator dropdown
  (`=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `starts with`,
  `lang =` for langString) + value input (typed input is allowed here —
  filters need values; numeric/date inputs per datatype).
- Per checked property, an **optional?** toggle (default ON ⇒ wrapped in
  `OPTIONAL { … }` so rows without the property still match; a property
  with a filter is forced non-optional — filtering implies presence).
- SELECT ALL / CLEAR ALL.

### 4.5 Keyboard/misc

- `Esc` closes popovers. Path state resets when the active ontology
  changes. Query mode state is per-ontology in-session only (no
  persistence of queries in v1 — listed as future work).

## 5. Backend: schema endpoint (new)

The composer needs class-level structure ("which predicates connect class A
to class B; which datatype properties does class A have") — this is
different from the instance-level viz graph.

`GET /api/ontologies/{id}/query-schema` → computed from the rdflib graph
(after `ensure_loaded()`), cached on the `Ontology` object like `viz_cache`:

- **classes**: `[{iri, label, prefixed}]` — reuse `graph_builder` kind
  detection (kinds `class`; include `concept` schemes? no — v1 classes only,
  but treat `skos:Concept` itself as a class if typed instances exist).
- **objectLinks**: `[{source: classIri, target: classIri, predicate,
  label, prefixed}]`, derived from BOTH:
  1. declared `rdfs:domain`/`rdfs:range` of object properties, and
  2. observed instance data: for each triple `(s, p, o)` with `s,o` typed
     individuals, emit link `type(s) —p→ type(o)` (this is what makes the
     Northwind-style demo work). Deduplicate. Cap the instance scan
     sensibly (e.g. sample first N triples per predicate if the graph is
     huge; note the cap in a `truncated` flag).
- **dataProperties**: per class: `[{predicate, label, prefixed, datatype}]`
  from declared datatype properties (domain) plus observed
  literal-valued predicates on typed instances (record the most common
  datatype seen).
- **namespaces**: reuse the stored prefix map for query PREFIX emission.

Also emit `subClassOf` links so the UI can offer hops along
`rdfs:subClassOf` (the video shows subclass edges in the graph). Keep the
response JSON small: IRIs as strings, no nesting beyond the above.

## 6. SPARQL generation (frontend, pure function)

A pure TS module `frontend/src/sparql/generate.ts` mapping the query state
(§7) to a query string. **This module must be unit-testable without React.**

### 6.1 Query state model

```
QueryState = {
  steps: Step[]            // ordered; steps[0] is the root class
  limit: number            // default 100
  pathsMode: boolean       // compact property paths vs explicit triples
}
Step = {
  classIri: string
  varName: string          // derived, editable later; dedup: ?order, ?order2
  props: SelectedProp[]    // datatype property selections for this step
  link?: {                 // how this step connects to the PREVIOUS step
    predicates: {iri, inverse: boolean}[]  // >=1; >1 ⇒ alternation |
    modifier: "" | "*" | "+" | "?"
    optional: boolean
  }
}
SelectedProp = { predicateIri, varName, optional: boolean,
                 filter?: {op, value, datatype} }
```

### 6.2 Emission rules (explicit mode, `pathsMode=false`)

- `PREFIX` lines only for prefixes actually used; fall back to full IRIs in
  `<>` when no prefix matches.
- `SELECT` all step vars + all selected prop vars, in path order.
- For each step: `?x a <Class> .` For each link (non-optional, no
  modifier): `?prev <pred> ?x .` — inverse predicates swap subject/object;
  alternation with n>1 or any modifier forces property-path syntax for that
  single hop (`?prev (p1|^p2)+ ?x .`) even in explicit mode (SPARQL has no
  other way to express it).
- A modifier on a hop suppresses the intermediate `a <Class>` assertion?
  No — keep `?x a <Class> .` on every step (matches the video: typing stays).
- OPTIONAL hop ⇒ wrap that hop's connecting pattern AND the step's
  `a`-typing AND everything that depends on it downstream? **No** — follow
  the video: wrap only that hop's `{ connect + typing (+ that step's
  non-optional props) }`; downstream hops continue from the optional var —
  emit a note in the preview as a SPARQL comment (`# note: steps after an
  optional hop may yield unbound results`) OR (simpler, more correct)
  restrict: only allow OPTIONAL on hops with no downstream steps and on
  prop selections. Decide during implementation; prefer correctness —
  see §10 Q2.
- Selected props: `?x <pred> ?xProp .` — wrapped in `OPTIONAL { … }` when
  optional; `FILTER(...)` immediately after the pattern, with typed
  literals (`"50"^^xsd:decimal`, `CONTAINS(LCASE(STR(?v)), "…")` for
  contains, `STRSTARTS` for starts-with, `LANG(?v) = "en"` for lang).
- `LIMIT <n>` last. No `GRAPH ?g` wrapper (our store is a single graph —
  unlike the video).

### 6.3 Variable naming

Derived from class local name, lower-camel (`?orderDetail`); collision ⇒
numeric suffix (`?order`, `?order2`). Prop vars: `?<stepVar><PropLocal>`
(`?orderFreight`). Names must be stable across regenerations.

### 6.4 Paths mode (`pathsMode=true`)

Collapse maximal runs of steps that have **no** selected props, no filters,
and no OPTIONAL into a single property-path triple:
`?product (^nwo:hasProduct)/(nwo:belongsToOrder) ?order .` — modifiers and
alternations apply per segment. Steps that carry props/filters/OPTIONAL
break the run and keep explicit vars. SELECT then only projects surviving
vars (the video shows `SELECT ?product ?target`).

## 7. Backend: SPARQL execution endpoint (new)

`POST /api/ontologies/{id}/sparql` with `{query: string}` →
`{vars: string[], rows: [[{type, value, label?, prefixed?, lang?,
datatype?}]], truncated: bool, durationMs: number}`.

Safety rails (server-side, non-negotiable):

- **Read-only**: parse with `rdflib.plugins.sparql.prepareQuery`; reject
  anything that is not a `SELECT` (no UPDATE/CONSTRUCT/etc. — prepareQuery
  only handles query forms; additionally check `.algebra.name ==
  "SelectQuery"`).
- **Row cap**: server enforces its own cap (e.g. 1000) independent of the
  query's LIMIT; set `truncated` if hit.
- **Timeout**: run the evaluation in a worker thread with a hard timeout
  (e.g. 30s) — rdflib has no native timeout; use
  `concurrent.futures.ThreadPoolExecutor` + `future.result(timeout=…)` and
  return HTTP 504 with a friendly message on expiry (thread may keep
  running to completion in the background — acceptable for v1; document it).
- Enrich URI results with `label`/`prefixed` via existing
  `graph_builder.pick_label`/`prefixed` helpers so the UI can render chips.
- SPARQL-injection is *not* a concern beyond read-only enforcement (the
  graph is the user's own local data), but never interpolate the query into
  shell/log output unescaped.

## 8. Files to add / touch

**Add** (all new — zero risk to existing features):
- `backend/app/query_schema.py` (schema extraction), `backend/app/sparql_exec.py`
  (execution + safety rails)
- `backend/tests/test_query_schema.py`, `backend/tests/test_sparql_endpoint.py`
- `frontend/src/sparql/generate.ts`, `frontend/src/sparql/highlight.ts`
- `frontend/src/components/QueryPanel.tsx`, `PathBar.tsx`,
  `PredicateMenu.tsx`, `ClassPropsMenu.tsx`, `SparqlPreview.tsx`,
  `ResultsTable.tsx`
- `frontend/src/sparql/generate.test.ts` — add `vitest` (MIT) as the only
  new dev dependency, with a `test` script; do NOT add UI testing libs.

**Touch minimally**:
- `routers/ontologies.py`: two new routes delegating to the new modules.
- `store.py`: one new cache field (like `viz_cache`) for the query schema.
- `App.tsx`: mode state + conditional right panel + passing `queryMode`.
- `GraphView.tsx`: `queryMode` prop — click routing + candidate/path
  highlighting inside the existing reducers (guard every change behind
  `queryMode` so Explore behavior is byte-for-byte identical).
- `api.ts`, `types.ts`, `index.css` (new classes only), `README.md`.

## 9. Milestones (implement in order; commit per milestone)

**M1 — Schema + execution backend.** `query_schema.py`, `sparql_exec.py`,
routes, tests against `examples/space-exploration.ttl` (assert: Product-like
links exist between example classes; `orbits` connects CelestialBody to
CelestialBody; datatype props found; non-SELECT rejected; row cap works;
LIMIT respected). All existing tests still pass.

**M2 — Query state + generator.** `generate.ts` with vitest snapshot-style
unit tests covering: single class; linear 3-hop path; inverse hop;
alternation; each modifier; OPTIONAL hop; props with/without filters (every
operator); paths-mode collapsing; variable dedup; prefix fallback.

**M3 — Query mode UI.** Tab switch, QueryPanel with PathBar + preview
(Auto + Copy), GraphView click-to-append + highlighting. No menus yet
(primary predicate auto-chosen: prefer declared object property over
observed; deterministic tie-break by IRI).

**M4 — Menus.** PredicateMenu (OPTIONAL, modifiers, relationship
checkboxes), ClassPropsMenu (props + filters). Live preview reflects all.

**M5 — Execute + results.** EXECUTE wiring, ResultsTable (sort, chips,
count, duration, truncation notice, error display), result-chip → center
node on graph.

**M6 — Polish + docs.** Both themes verified, large-ontology check (schema
endpoint fast on the 40k-node JUHO thesaurus — verify or add caps), README
section ("Visual query builder" with a workflow walkthrough + limitations),
Roadmap updated. Full manual verification pass in the browser (load example
→ build the demo path → toggle everything → execute → sane rows).

## 10. Open questions — decide with the user before/during implementation

1. **SKOS support in v1?** The video is class/instance-centric. Proposal:
   v1 = classes only; treat SKOS concept hierarchies as future work
   (they'd want `skos:broader+` paths). Ask Imran.
2. **OPTIONAL mid-path semantics** (§6.2): restrict OPTIONAL to terminal
   hops + props (correct, simpler) vs. allow anywhere (matches video, can
   produce confusing unbound downstream vars). Recommend restricting; ask.
3. **Query persistence** (saved queries library): out of v1; confirm.
4. **Execute against remote endpoints** (public SPARQL endpoints): out of
   v1; confirm.

## 11. Risks

- **rdflib SPARQL performance** on ~800k-triple graphs: property paths with
  `*`/`+` can explode. Mitigations: server cap + timeout (M1), warn in UI
  when a modifier is used on a large ontology.
- **Schema extraction cost** on huge instance-heavy graphs: sample/cap per
  predicate; cache like `viz_cache`; compute lazily on first Query-mode
  entry (endpoint call), NOT at load time.
- **Sigma interaction conflicts**: query-mode click handling must not fight
  drag physics — route clicks through the existing `clickNode` handler with
  a mode check, never add parallel event listeners.
- **Theme regressions**: every new CSS rule uses existing variables.

## 12. Definition of done

- All pre-existing tests pass unmodified; new backend + generator tests
  green; `npm run build` clean.
- Explore mode behaves identically to before (manual smoke: load, click,
  search, drag, theme, PNG, remove).
- In Query mode a user can, with mouse only: build a ≥3-hop path on the
  example ontology, set an inverse + alternation + modifier, make a hop
  OPTIONAL, project two datatype properties, filter one numerically,
  watch the SPARQL update live in both Paths and explicit modes, execute,
  and see correct rows — in dark and light themes.
