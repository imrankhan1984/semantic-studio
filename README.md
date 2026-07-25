# Semantic Viewer

A self-contained web application for visualizing Semantic Web ontologies and
vocabularies — RDF, RDFS, OWL and SKOS — as an interactive, force-directed
graph.

## Features

- **Load ontologies** from a local file (drag & drop or file picker) or fetch
  them from any URL. GitHub `blob` links are converted to raw file URLs
  automatically — paste a link straight from the GitHub UI.
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
scheme ships in [`examples/space-exploration.ttl`](examples/space-exploration.ttl).
Real-world files that load well, pasted into *Load ontology → URL / GitHub*:

- `https://github.com/schemaorg/schemaorg/blob/main/data/releases/28.1/schemaorg-current-https.ttl`
- `http://xmlns.com/foaf/spec/index.rdf`
- `https://api.finto.fi/rest/v1/juho/data?format=text/turtle` (large SKOS)

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
- Private GitHub repositories via personal access token.

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
