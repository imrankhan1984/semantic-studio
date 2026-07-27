# Semantic Studio — Canonical Project Context (v1)

> A single-source reference for what Semantic Studio is, how it is built, and
> the decisions behind it. Written to reflect the code as it actually stands
> (routes, caps, dependencies and test counts below were verified against the
> source, not from memory). Update as a new version (`project_context_v2.md`)
> rather than rewriting history.

---

## 1. What it is

Semantic Studio is a self-contained web application for working with Semantic
Web ontologies and vocabularies — **RDF, RDFS, OWL and SKOS**. It lets a user:

- **Load** an ontology from a local file, any reachable URL, or a built-in
  catalogue of well-known ontologies.
- **View** the raw source (original bytes or pretty-printed Turtle) with
  highlighting and search.
- **Explore** it as an interactive, force-directed graph, inspecting any
  entity's statements in a detail panel.
- **Query** it visually — building SPARQL SELECT queries by clicking the graph
  or the panel, with no SPARQL typed by hand.

It runs locally (Python backend + built frontend) or as a single all-in-one
Docker image. Repository: `github.com/imrankhan1984/semantic-studio`.

---

## 2. Technology stack

| Layer | Technology |
| --- | --- |
| Backend | Python, FastAPI, rdflib, uvicorn, httpx |
| Frontend | React 18 + TypeScript, Vite |
| Graph rendering | Sigma.js (WebGL) + graphology + ForceAtlas2 layout |
| PNG export | @sigma/export-image |
| Backend tests | pytest |
| Frontend tests | vitest |
| Packaging | Multi-stage Dockerfile + docker-compose |

All dependencies are permissive open source (MIT / BSD-family).

**Backend dependencies** (`backend/requirements.txt`):
`fastapi>=0.115`, `uvicorn[standard]>=0.30`, `rdflib>=7.1`, `httpx>=0.27`,
`python-multipart>=0.0.12`.

**Frontend dependencies** (`frontend/package.json`):
`@sigma/export-image ^3.0.0`, `graphology ^0.26.0`, `graphology-layout ^0.6.1`,
`graphology-layout-forceatlas2 ^0.10.1`, `react ^18.3.1`, `react-dom ^18.3.1`,
`sigma ^3.0.2`. Dev-only: `vitest`, `vite`, `typescript`, `@vitejs/plugin-react`.

---

## 3. Architecture

### 3.1 Backend (`backend/app/`)

| Module | Responsibility |
| --- | --- |
| `main.py` | Builds the FastAPI app, CORS, includes routers, serves the built frontend in production. |
| `store.py` | Disk-backed store of loaded ontologies (each an `rdflib.Graph`); lazy parse; cached derived views. Exposes singletons `store` and `saved_queries`. |
| `graph_builder.py` | Turns a graph into visualization nodes/edges; node details; search; shared `pick_label` / `prefixed` helpers. |
| `query_schema.py` | Class-level schema for the query builder (classes, links, subclass hierarchy, data properties) from declared axioms, OWL restrictions, and observed data. |
| `sparql_exec.py` | Safe SELECT execution (parse/validate, row cap, wall-clock timeout, JSON serialization). |
| `queries_store.py` | Persistent library of saved visual queries (one JSON file each). |
| `routers/ontologies.py` | The main REST surface (load/view/explore/query). |
| `routers/queries.py` | Saved-query CRUD. |

### 3.2 Frontend (`frontend/src/`)

- **Core**: `App.tsx` (root; owns theme, ontology list, mode, shared query
  hook), `api.ts` (one wrapper per endpoint), `types.ts` (API shapes + theme
  palettes), `catalogue.ts` (suggested ontologies), `main.tsx` (bootstrap).
- **Components** (`components/`): `GraphView`, `Legend`, `DetailPanel`,
  `SourceView`, `SearchBox`, `LoadDialog`, `Logo`, `icons`, and the query UI:
  `QueryPanel`, `PathBar`, `PredicateMenu`, `ClassPropsMenu`, `NextSteps`,
  `QueryStart`, `SparqlPreview`, `ResultsTable`.
- **Query logic** (`sparql/`): `types.ts` (query state model),
  `generate.ts` (pure state→SPARQL generator), `describe.ts` (plain-English),
  `starters.ts` (suggested queries), `highlight.ts` (tokenizers),
  `useQueryBuilder.ts` (the shared stateful hook).

### 3.3 The three modes

All three render over the **same** graph instance so switching never discards
the settled layout:

- **View** overlays a source-text pane.
- **Explore** shows the node detail panel; clicking a node selects it.
- **Query** shows the query-builder panel; clicking a node adds a step.

---

## 4. API surface (14 endpoints)

Prefix `/api/ontologies` (plus `/api/health`):

| Method & path | Purpose |
| --- | --- |
| `GET  /api/ontologies` | List loaded ontologies (summaries) |
| `POST /api/ontologies/upload` | Upload a file (multipart) |
| `POST /api/ontologies/fetch` | Fetch by URL (`{url}`) |
| `DELETE /api/ontologies/{oid}` | Remove an ontology + its saved queries |
| `GET  /api/ontologies/{oid}/graph` | Visualization nodes/edges |
| `GET  /api/ontologies/{oid}/node` | `?iri=` — all statements for an IRI |
| `GET  /api/ontologies/{oid}/search` | `?q=` — label/IRI search |
| `GET  /api/ontologies/{oid}/source` | Source text (`?pretty=`, `?max_bytes=`) |
| `GET  /api/ontologies/{oid}/query-schema` | Class-level schema for the builder |
| `GET  /api/ontologies/{oid}/query-node` | `?iri=` — class/type of a clicked node |
| `POST /api/ontologies/{oid}/sparql` | Run a SELECT (`{query}`) |

Prefix `/api/queries`:

| Method & path | Purpose |
| --- | --- |
| `GET  /api/queries` | List saved queries (`?ontology=` to filter) |
| `POST /api/queries` | Create or update a saved query |
| `DELETE /api/queries/{qid}` | Delete a saved query |

---

## 5. Limits, caps and safety rails

Verified in the code:

| Constant | Value | Where / why |
| --- | --- | --- |
| `MAX_FETCH_BYTES` | 200 MB | `routers/ontologies.py` — reject oversized URL fetches |
| `SOURCE_MAX_BYTES` | 2 MB | default source-view payload (line-boundary truncated) |
| `SOURCE_HARD_MAX_BYTES` | 16 MB | ceiling on the `max_bytes` request param |
| `MAX_ROWS` | 1000 | `sparql_exec.py` — server-side result cap, independent of the query's LIMIT |
| `DEFAULT_TIMEOUT_SECONDS` | 30.0 | `sparql_exec.py` — wall-clock timeout on a worker thread |
| `MAX_LINKS` | 60000 | `query_schema.py` — cap on class-to-class links |
| `MAX_DATA_PROPS_PER_CLASS` | 200 | `query_schema.py` |
| `MAX_EXPRESSION_DEPTH` | 8 | `query_schema.py` — depth of OWL class-expression walking |

**Security posture** (trust boundaries the code is expected to keep):

- SPARQL execution is **SELECT-only**: `prepare_select` rejects
  UPDATE/CONSTRUCT/DESCRIBE/ASK before running anything.
- URL fetching allows any reachable http(s) URL **except GitHub Enterprise
  hosts**, which are rejected with guidance to download-and-upload (they sit
  behind SSO the backend cannot authenticate against). github.com "blob" URLs
  are rewritten to raw download URLs.
- No user-supplied content is rendered as raw HTML anywhere in the frontend
  (trust boundary 3): source and results are rendered as text/tokens only.

Related security review items tracked in the project: **S-1** URL fetch
restrictions, **S-2** SPARQL `SERVICE` (remote-endpoint) exposure, **S-3**
upload limits. The `verify-security-fix` skill proves such fixes against a live
instance.

---

## 6. Data & persistence

- Each ontology is stored as its original bytes plus a metadata JSON file in a
  per-user data directory; parsing is **lazy** (the dropdown lists from
  metadata; the RDF is parsed on first use).
- Data directory: `%LOCALAPPDATA%\semantic-studio` (Windows),
  `~/.local/share/semantic-studio` (Linux, honours `XDG_DATA_HOME`),
  `~/Library/Application Support/semantic-studio` (macOS). Override with
  `SEMANTIC_STUDIO_DATA_DIR`. Docker uses `/data` (declared as a volume).
- Saved visual queries live in a `queries` subfolder; they store the full
  builder **state** (not just the SPARQL text) so they reopen visually.
- Deleting an ontology also deletes its saved queries.

---

## 7. Visual query builder — key design decisions

- **Paths branch, they are not a chain.** Each step attaches to an "anchor"
  step it actually relates to, so one class can fan out to several.
- **OPTIONAL wraps its whole subtree**, so no downstream pattern can reference
  an unbound variable.
- **Class inheritance is resolved at lookup time.** Declared/restriction links
  are recorded once at the level stated; the frontend walks `superClasses` so a
  relationship declared on a broad ancestor is offered on the subclass. This is
  what makes heavily-axiomatized ontologies (e.g. FIBO) usable, and it replaced
  an earlier approach that materialized every subclass pair and exploded.
- **OWL restrictions are read**, not just `rdfs:domain`/`rdfs:range`:
  `someValuesFrom`, `allValuesFrom`, `onClass`, `hasValue`, recursing through
  `intersectionOf`/`unionOf`. On FIBO this recovers the large majority of
  relationships.
- **SKOS is first-class**: `skos:Concept` and friends are steppable types, and
  self-hops offer both `broader` and `^broader` (narrower).
- **Filters are typed to the datatype**: bare numbers/booleans, typed
  date/dateTime, and STR() comparison for strings and for `xsd:gYear` (which
  SPARQL engines mishandle as a typed literal).
- **Newcomer aids**: an empty-state with schema-derived starter queries and
  entry-point classes; a live plain-English sentence above the SPARQL; a
  next-step chip cloud so a query can be built without touching the graph; a
  small auto-preview on small ontologies; and a Count mode (COUNT + GROUP BY).
- The generator (`generate.ts`) and describer (`describe.ts`) are pure and
  unit-tested; the SPARQL preview uses a hand-rolled tokenizer (no editor lib).

---

## 8. Testing

Verified counts (all passing):

- **Backend — 48 tests** across: `test_fetch_restrictions.py` (5),
  `test_graph_builder.py` (8), `test_persistence.py` (5),
  `test_query_schema.py` (14), `test_source_view.py` (5),
  `test_sparql_endpoint.py` (11). Run: `backend/.venv/Scripts/python -m pytest tests`.
- **Frontend — 67 tests** across `sparql/*.test.ts` (generate, describe,
  starters, inheritance). Run: `npm test` in `frontend/`.
- `frontend/tests` isolate data via `SEMANTIC_STUDIO_DATA_DIR`; backend tests
  isolate via `conftest.py` so they never touch a real user library.
- A demo ontology (`examples/space-exploration.ttl`) mixes OWL classes,
  properties, individuals, a small SKOS scheme, and a restriction-based class,
  so most extraction paths are covered without a network fetch.

---

## 9. Project skills (`.claude/skills/`)

Reusable checks the project ships:

- `check-architecture` — reports drift between the architecture doc and the code
  (routes, caps, deps, test counts, trust boundaries).
- `perf-budget` — enforces render/parse performance budgets.
- `a11y-check` — accessibility check for new/changed interactive elements.
- `rdf-fixture` — conventions for RDF test fixtures.
- `verify-security-fix` — proves a security fix blocks what it claims to.

---

## 10. Conventions & constraints

- **Git workflow**: push to the remote on a dedicated feature branch per change
  (never directly to `main`); land via pull request.
- **Deployment**: local (venv + `npm run build`, backend serves `frontend/dist`)
  or `docker compose up --build` (single image on port 8000, `/data` volume).
- **UI**: dark and light themes with adapted palettes; colours are keyed by the
  backend's node/edge "kind" strings, so a new kind only needs a colour added.

---

## 11. Known limitations / roadmap

- Querying **remote SPARQL endpoints** is not supported (queries run against the
  loaded ontology only).
- Editing / serialization back to RDF is not implemented.
- GitHub Enterprise fetching is intentionally unsupported (download-and-upload).
- Very large ontologies: unbounded `*`/`+` property-path modifiers can be slow;
  the source view is windowed and truncated for display (Explore/Query still
  operate on the whole graph).

---

*Document version: v1. Supersede with a new version rather than editing in
place, so the project's history of understanding stays intact.*
