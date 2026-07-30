<h1>
  <img src="frontend/public/logo.svg" width="28" height="28" alt="" valign="middle">
  Semantic Studio
</h1>

**An ontology workspace for RDF, RDFS, OWL and SKOS.**

A self-contained web application that turns Semantic Web ontologies and
vocabularies into an interactive, force-directed graph — and lets you query
them by clicking, without writing SPARQL by hand.

## Features

- **Load ontologies** three ways:
  1. **File upload** from your PC or laptop (drag & drop or file picker);
  2. **Any directly reachable URL** serving an RDF file;
  3. **Public github.com repositories** — GitHub `blob` links are converted
     to raw file URLs automatically, so you can paste a link straight from
     the GitHub UI.

  > **⚠️ Only public web addresses can be fetched.** The server refuses URLs
  > whose host resolves to a loopback, private, link-local or other
  > non-public address, and re-checks after every redirect. To load an
  > ontology from a machine on your own network, download the file first and
  > use the **Local file** tab. This also means a container-to-container
  > setup, where one container serves an ontology to another over a private
  > address, will not work.

  > **⚠️ GitHub Enterprise is not currently supported.** GHE instances sit
  > behind corporate SSO that the app cannot authenticate against, so
  > GHE-hosted files cannot be fetched by URL. To view an ontology hosted on
  > a GitHub Enterprise instance, download the file to your PC first and
  > load it into the application via file upload.
- **Formats**: Turtle, RDF/XML, OWL (XML), N-Triples, N3, JSON-LD, TriG,
  N-Quads. The format is detected from the file extension and falls back to
  content sniffing.
- **Scales to large vocabularies**: WebGL rendering via Sigma.js. Tested with
  a ~800k-triple SKOS thesaurus (≈40,000 concepts / 230,000 relations).
- **Interactive graph**
  - ForceAtlas2 layout — fluid, per-animation-frame physics for graphs up to
    3,000 nodes, a background web worker beyond that.
  - WebVOWL-style dragging: grab any node and its neighborhood elastically
    follows; on release the graph settles.
  - Hover highlights a node's neighborhood; edge lengths adapt to label
    length so long names stay readable.
- **A starting point in *Explore* mode**: with an ontology open and nothing
  selected, the right-hand panel says what the ontology contains and offers up
  to eight entities worth opening first — its most connected ones, spread across
  kinds so classes, properties and individuals are all represented. Clicking one
  opens it; closing it returns to the offer.
- **Detail panel**: click any concept, class, property or individual to open a
  right-hand panel with every statement about it (annotations, relations,
  typed literals with language/datatype tags) and everything that references
  it. IRIs are clickable for graph navigation, plus copy & open-in-browser.
- **Search** (top right): find concepts and properties by label or IRI; picking
  a result zooms the camera to the node.
- **Legend & filters**: color-coded node kinds (classes, object/datatype/
  annotation properties, SKOS concepts, schemes, individuals…) and relation
  types; click a kind to show/hide it.
- **Visual SPARQL query builder** (*Query* mode): build queries by clicking
  the graph — no SPARQL typing required. See
  [Building queries visually](#building-queries-visually).
- **Dark & light mode** with adapted graph palettes.
- **PNG export** of the current graph view.
- Multiple ontologies can be loaded side by side and switched via a dropdown.
- **Persistent library**: every loaded ontology is saved on your machine and
  reappears in the dropdown the next time you start the app — see
  [Where your ontologies are stored](#where-your-ontologies-are-stored).

## Quick start (Docker)

```bash
docker compose up --build
```

or without compose:

```bash
docker build -t semantic-studio .
docker run -p 8000:8000 semantic-studio
```

Open <http://localhost:8000>.

## Quick start (local development)

Prerequisites: Python ≥ 3.11, Node.js ≥ 20.

**Backend** (port 8000):

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt     # Linux / macOS
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

**Frontend** (port 5173, proxies `/api` to the backend):

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. For a production-style single server, run
`npm run build` in `frontend/` — the backend then serves `frontend/dist`
itself at <http://localhost:8000>.

**Tests**:

```bash
cd backend
.venv/Scripts/python -m pytest tests
```

## Try it

A demo ontology mixing OWL classes, properties, individuals and a small SKOS
scheme ships in [`examples/space-exploration.ttl`](examples/space-exploration.ttl) —
load it via file upload. Real-world files that load well, pasted into
*Load ontology → URL / GitHub*:

- `https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl`
- `http://xmlns.com/foaf/spec/index.rdf`
- `https://api.finto.fi/rest/v1/juho/data?format=text/turtle` (large SKOS)
- `https://spec.edmcouncil.org/fibo/ontology/master/latest/prod.fibo-quickstart.ttl`
  — the official FIBO production release (132k triples, 2,415 classes),
  which the query builder is validated against: relationships there are
  declared on broad domains and inherited by subclasses, so the builder
  resolves `rdfs:subClassOf` when offering the next step.

Ontologies hosted on **GitHub Enterprise** must be downloaded locally and
loaded via file upload — see the note above.

## Building queries visually

Switch the toolbar to **Query** and build a SPARQL SELECT by clicking, with a
live preview that updates on every edit.

1. **Click a node in the graph** (or use the search box, which adds a step in
   Query mode) to start the path. Clicking a class steps on the class;
   clicking an individual or a SKOS concept steps on its type and *pins* that
   entity with `VALUES`, so you can ask questions like "everything under this
   concept".
2. **Keep clicking** to extend the path. Nodes that can extend it stay
   highlighted; everything else dims. A new step attaches to the most recent
   earlier step it actually relates to, so paths **branch** — an `Order` can
   fan out to `Customer`, `Shipper` and `Employee` rather than forming one
   rigid chain. A branched hop is labelled `↳N` with the step it hangs off.
   **Add a step** does the same without the graph: it lists every legal
   continuation from where you are, showing them outright when there are three
   or fewer and otherwise opening on demand with a count and a filter, so a
   schema offering two hundred continuations does not push the query off the
   screen.
3. **Click a relationship chip** to change the hop: reverse its direction
   (`^`), tick several predicates to form an alternation (`|`), apply a path
   modifier (`*`, `+`, `?`), or make the hop **OPTIONAL** — which wraps that
   hop *and everything hanging off it*, so no later pattern can reference an
   unbound variable.
4. **Click a class chip** to pick data properties to return and to filter
   them (`=`, `≠`, `>`, `≥`, `<`, `≤`, contains, starts with, language is).
   Selected properties are OPTIONAL by default; adding a filter makes the
   property required, since filtering implies it must be present.
5. **Toggle `Paths`** to collapse hops through steps that carry no data of
   their own into compact property paths
   (`?mission (:uses)/(:operatedBy) ?spaceAgency`), `Distinct` to drop
   duplicate rows, and set `LIMIT`. `Auto` regenerates the preview on every
   edit; turn it off to freeze the query and refresh manually.
6. **Execute** to run the query against the loaded ontology. Results appear in
   a sortable table, fifteen rows to a page; IRI cells are clickable and centre
   that node in the graph. Sorting applies to the whole result set rather than
   the page you happen to be on, so page one shows the true top rows. The query
   text stays pinned above the results while you scroll them, and **Clear
   results** empties the table without touching the query — unlike *Clear path*,
   which resets the query itself.
7. **Save** the query to reuse later. Saved queries are stored with the
   ontologies (see below) and keep the *visual* state, so reopening one
   restores the path, pins, modifiers and filters — not just the query text.

SKOS taxonomies are fully supported: `skos:Concept` and friends are steppable
types, and a self-hop offers both `broader` and `^broader` (narrower), so
`?concept (^skos:broader)+ ?descendant` is a few clicks away.

**Limits.** Queries run against the ontology loaded in the app. Federated
queries using `SERVICE` are refused. Remote SPARQL
endpoints are not supported yet. Execution is SELECT-only, capped at 1,000
rows and 30 seconds, and unbounded `*` / `+` modifiers on very large graphs
can be slow.

## Size and time limits

Loading an ontology is bounded so that a mistake — or a hostile file — costs you
a message rather than a restart. Each limit can be raised with an environment
variable if you have a known-good file that needs it.

| Limit | Default | Environment variable |
| --- | --- | --- |
| Upload size | 50 MB | `SEMANTIC_STUDIO_MAX_UPLOAD_BYTES` |
| Fetch size | 50 MB | `SEMANTIC_STUDIO_MAX_FETCH_BYTES` |
| Parse time | 60 seconds | `SEMANTIC_STUDIO_PARSE_TIMEOUT` |
| Entities drawn at once | 2,000 | `SEMANTIC_STUDIO_GRAPH_NODE_BUDGET` |

50 MB comfortably covers the largest ontology in the suggested list, the JUHO
thesaurus at about 26 MB. Both size limits are applied *while* the file is being
read, so an oversized file is refused without ever being held in memory.

## Large ontologies

A big ontology is loaded in full but **drawn in part**. The graph shows the
2,000 most connected entities by default, because drawing tens of thousands at
once makes the browser tab unresponsive rather than informative.

When that happens the app says so above the graph — *Showing the 2,000 most
connected of 18,717 entities* — and the status bar keeps both numbers even if
you dismiss the notice. Nothing is hidden silently.

- **Show more** draws twice as many, up to a ceiling of 20,000.
- **Search still covers the whole ontology.** A result that is not on the canvas
  is marked *not drawn* — and picking it draws it, together with everything it
  connects to.
- **Show its connections**, on any entity's detail panel, grows the graph
  outward from that entity. The view only ever gets bigger; to go back to the
  budgeted graph, reopen the ontology.
- Each expansion says what it added and how much of the ontology is now drawn,
  and the status bar keeps the running total.
- The legend counts the **whole** ontology, not just what is drawn, so its
  numbers will be larger than what you can see. That is deliberate: it describes
  the file, not the canvas.

Raise `SEMANTIC_STUDIO_GRAPH_NODE_BUDGET` if your machine copes with more.

## Where your ontologies are stored

Every ontology you load (uploaded file or URL fetch) is persisted so it is
available again in the dropdown after a restart. The original RDF bytes plus
a small metadata file are written to a per-user data directory:

| How you run the app | Storage location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\semantic-studio\ontologies` (typically `C:\Users\<you>\AppData\Local\semantic-studio\ontologies`) |
| Linux | `$XDG_DATA_HOME/semantic-studio/ontologies` (typically `~/.local/share/semantic-studio/ontologies`) |
| macOS | `~/Library/Application Support/semantic-studio/ontologies` |
| Docker / Docker Compose | `/data/ontologies` inside the container (see below) |

Set the `SEMANTIC_STUDIO_DATA_DIR` environment variable to store the files
somewhere else. Saved visual queries live beside them, in a `queries`
subfolder of the same directory; removing an ontology also removes its
saved queries.

If you used the app under its old name, an existing `semantic-viewer`
library folder is moved to `semantic-studio` automatically on first start,
so nothing is lost. The old `SEMANTIC_VIEWER_DATA_DIR` variable is still
honoured.

Restoring is **lazy**: on startup the dropdown is populated instantly from
the stored metadata (name, triple/node counts), and the RDF itself is only
re-parsed the moment you select that ontology — so even very large saved
files never slow down startup. **Remove** in the toolbar deletes the stored
copy from disk as well. You are asked to confirm, and the confirmation says
how many saved queries will go with it — naming them when there are three or
fewer — so nothing disappears without being mentioned first.

### Persistence with Docker and Docker Compose

The image stores ontologies in the `/data` volume:

- `docker compose up` automatically creates a named volume
  (`semantic-studio-data`) mapped to `/data`, so your ontologies survive
  `docker compose down`, image rebuilds, and container recreation. Only
  `docker compose down -v` (or `docker volume rm`) deletes them.
- With plain `docker run`, pass a volume yourself to get the same behavior,
  e.g.:

  ```bash
  docker run -p 8000:8000 -v semantic-studio-data:/data semantic-studio
  ```

  To keep the files in a normal folder on the host instead, bind-mount one,
  e.g. `-v "$HOME/semantic-studio-data:/data"` (Linux/macOS) or
  `-v "%USERPROFILE%\semantic-studio-data:/data"` (Windows).
- Without any volume, files written to `/data` are lost when the container
  is removed.

## Architecture

```
┌────────────────────────────┐        ┌─────────────────────────────┐
│ React + TypeScript (Vite)  │  /api  │ FastAPI                     │
│  Sigma.js (WebGL render)   │ ─────► │  rdflib graph store (RAM)   │
│  graphology + ForceAtlas2  │        │  graph_builder: RDF → viz   │
└────────────────────────────┘        └─────────────────────────────┘
```

- `backend/app/store.py` — in-memory ontology store; each ontology is a full
  `rdflib.Graph`, so SPARQL querying and editing can be added later without
  changing the data model.
- `backend/app/graph_builder.py` — extracts the visual graph: node kinds
  (class / property kinds / SKOS concept / individual …), structural edges
  (`subClassOf`, `domain`/`range`, `broader`, object-property assertions, …;
  `skos:narrower` and `skos:hasTopConcept` are normalized to their inverses),
  labels (`skos:prefLabel` > `rdfs:label` > titles > local name).
- `backend/app/routers/ontologies.py` — REST API: upload, fetch-by-URL,
  list/delete, graph, node details, search.
- `frontend/src/components/GraphView.tsx` — Sigma renderer, layout engine
  selection, drag physics, highlighting.
- `backend/app/query_schema.py` — class-level schema for the query builder:
  which predicates connect instances of one class to another, and which
  literal properties a class carries, derived from both declared
  `rdfs:domain`/`rdfs:range` (propagated down `rdfs:subClassOf`) and the
  instance data actually present.
- `backend/app/sparql_exec.py` — SELECT-only execution with a row cap and a
  wall-clock timeout on a worker thread.
- `frontend/src/sparql/generate.ts` — pure, unit-tested state → SPARQL
  generator; `useQueryBuilder.ts` holds the builder state shared by the graph
  and the query panel.

### API overview

| Method & path                       | Purpose                              |
| ----------------------------------- | ------------------------------------ |
| `GET  /api/ontologies`              | List loaded ontologies + stats       |
| `POST /api/ontologies/upload`       | Multipart file upload                |
| `POST /api/ontologies/fetch`        | `{url}` — fetch from URL/GitHub      |
| `DELETE /api/ontologies/{id}`       | Remove an ontology                   |
| `GET  /api/ontologies/{id}/graph`   | Visualization nodes/edges            |
| `GET  /api/ontologies/{id}/neighborhood` | `?iri=` — one entity and its neighbours, to grow the drawn graph |
| `GET  /api/ontologies/{id}/node`    | `?iri=` — all statements for an IRI  |
| `GET  /api/ontologies/{id}/search`  | `?q=` — label/IRI search             |
| `GET  /api/ontologies/{id}/query-schema` | Class-level schema for the builder |
| `GET  /api/ontologies/{id}/query-node`   | `?iri=` — class/type of a clicked node |
| `POST /api/ontologies/{id}/sparql`  | `{query}` — run a SELECT             |
| `GET/POST /api/queries`             | List / save visual queries           |
| `DELETE /api/queries/{id}`          | Delete a saved query                 |

## Roadmap

- Running the built queries against remote SPARQL endpoints.
- Editing and serialization back to RDF.
- GitHub Enterprise support (configurable hosts, per-user access tokens,
  corporate proxy handling) — until then, download files and upload them.
- Private github.com repositories via personal access token.

## Licenses of major dependencies

All dependencies are permissive open source:

| Library | License |
| --- | --- |
| React, Vite, Sigma.js, graphology, ForceAtlas2 layout | MIT |
| FastAPI | MIT |
| rdflib | BSD-3-Clause |
| uvicorn | BSD-3-Clause |
| httpx | BSD-3-Clause |

This project itself is MIT licensed — see [LICENSE](LICENSE).
