# Semantic Viewer

A self-contained web application for visualizing Semantic Web ontologies and
vocabularies — RDF, RDFS, OWL and SKOS — as an interactive, force-directed
graph.

## Features

- **Load ontologies** three ways:
  1. **File upload** from your PC or laptop (drag & drop or file picker);
  2. **Any directly reachable URL** serving an RDF file;
  3. **Public github.com repositories** — GitHub `blob` links are converted
     to raw file URLs automatically, so you can paste a link straight from
     the GitHub UI.

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
- **Detail panel**: click any concept, class, property or individual to open a
  right-hand panel with every statement about it (annotations, relations,
  typed literals with language/datatype tags) and everything that references
  it. IRIs are clickable for graph navigation, plus copy & open-in-browser.
- **Search** (top right): find concepts and properties by label or IRI; picking
  a result zooms the camera to the node.
- **Legend & filters**: color-coded node kinds (classes, object/datatype/
  annotation properties, SKOS concepts, schemes, individuals…) and relation
  types; click a kind to show/hide it.
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
docker build -t semantic-viewer .
docker run -p 8000:8000 semantic-viewer
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

Ontologies hosted on **GitHub Enterprise** must be downloaded locally and
loaded via file upload — see the note above.

## Where your ontologies are stored

Every ontology you load (uploaded file or URL fetch) is persisted so it is
available again in the dropdown after a restart. The original RDF bytes plus
a small metadata file are written to a per-user data directory:

| How you run the app | Storage location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\semantic-viewer\ontologies` (typically `C:\Users\<you>\AppData\Local\semantic-viewer\ontologies`) |
| Linux | `$XDG_DATA_HOME/semantic-viewer/ontologies` (typically `~/.local/share/semantic-viewer/ontologies`) |
| macOS | `~/Library/Application Support/semantic-viewer/ontologies` |
| Docker / Docker Compose | `/data/ontologies` inside the container (see below) |

Set the `SEMANTIC_VIEWER_DATA_DIR` environment variable to store the files
somewhere else.

Restoring is **lazy**: on startup the dropdown is populated instantly from
the stored metadata (name, triple/node counts), and the RDF itself is only
re-parsed the moment you select that ontology — so even very large saved
files never slow down startup. **Remove** in the toolbar deletes the stored
copy from disk as well (you are asked to confirm).

### Persistence with Docker and Docker Compose

The image stores ontologies in the `/data` volume:

- `docker compose up` automatically creates a named volume
  (`semantic-viewer-data`) mapped to `/data`, so your ontologies survive
  `docker compose down`, image rebuilds, and container recreation. Only
  `docker compose down -v` (or `docker volume rm`) deletes them.
- With plain `docker run`, pass a volume yourself to get the same behavior,
  e.g.:

  ```bash
  docker run -p 8000:8000 -v semantic-viewer-data:/data semantic-viewer
  ```

  To keep the files in a normal folder on the host instead, bind-mount one,
  e.g. `-v "$HOME/semantic-viewer-data:/data"` (Linux/macOS) or
  `-v "%USERPROFILE%\semantic-viewer-data:/data"` (Windows).
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

### API overview

| Method & path                       | Purpose                              |
| ----------------------------------- | ------------------------------------ |
| `GET  /api/ontologies`              | List loaded ontologies + stats       |
| `POST /api/ontologies/upload`       | Multipart file upload                |
| `POST /api/ontologies/fetch`        | `{url}` — fetch from URL/GitHub      |
| `DELETE /api/ontologies/{id}`       | Remove an ontology                   |
| `GET  /api/ontologies/{id}/graph`   | Visualization nodes/edges            |
| `GET  /api/ontologies/{id}/node`    | `?iri=` — all statements for an IRI  |
| `GET  /api/ontologies/{id}/search`  | `?q=` — label/IRI search             |

## Roadmap

- SPARQL querying (the rdflib store already supports it server-side).
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
