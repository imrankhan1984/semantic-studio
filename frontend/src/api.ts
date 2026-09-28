/*
================================================================================
FILE: frontend/src/api.ts
================================================================================

SUMMARY
    The single place the frontend talks to the backend. One thin wrapper per
    REST endpoint, each returning a typed Promise.

BASIC IDEA
    Keeping every fetch call here (rather than scattered in components) means
    URL shapes, request encoding and error handling live in one file. `handle`
    centralises turning a non-2xx response into a thrown Error carrying the
    backend's `detail` message, so callers can just try/catch.

    Every call that changes something on the server carries CLIENT_HEADER. The
    backend refuses a state-changing request without it (local_guard.py), which
    is what stops another web page open in the same browser from uploading to,
    or deleting from, the user's library. Any new mutating call must spread
    CLIENT_HEADER into its headers; api.test.ts fails for one that does not.

    Every call goes through `send`, which is where a 409 `approval_required`
    becomes a question for the user (external-access Stage 1, D-066). App
    registers the handler that opens the approval dialog; on Allow, `send`
    repeats the same request with the just-once grant id in
    X-Semantic-Studio-Grant, so an upload re-sends the file the browser still
    holds and the caller never learns there was a question. On Don't allow the
    call fails with one sentence naming the host. Putting this in one place
    means any action that can reach the network -- including a GET whose lazy
    parse needs a JSON-LD context -- asks the same way.

    Projects (authoring-foundations) add their own calls at the foot. An open
    project document is read through the same ontology calls under its
    prj-<hex>-<doc> id; the five that show names also carry the project's
    display language, set here once by the project store (setDisplayLanguage)
    rather than threaded through every component, and sent only while a
    project has one, so every library request is unchanged.

INPUTS / INPUT SOURCES
    - Arguments from the components (ids, IRIs, query text, files, payloads).
    - HTTP responses from the FastAPI backend.

EXPECTED OUTPUT
    - Typed data (or a thrown Error) for each endpoint.
================================================================================
*/

import type { QueryState } from "./sparql/types";
import type {
  AnnotationPropertyOption,
  ApprovalRequest,
  ChangeResult,
  DeleteImpact,
  SearchKind,
  Hierarchy,
  LanguageReport,
  OpenedProject,
  ProjectDocName,
  ProjectSummary,
  ProjectTemplate,
  SaveResult,
  ImportFilesResult,
  ImportsListing,
  NodeDetails,
  OntologyDeletion,
  OntologySource,
  OntologySummary,
  QueryNodeInfo,
  QuerySchema,
  SavedQuery,
  EmbeddedQueries,
  SparqlResults,
  VizGraph,
  VizNeighborhood,
  VizNode,
  NetworkActivity,
  NetworkCapability,
  NetworkGrant,
  NetworkPolicy,
} from "./types";

/**
 * Marks a request as coming from Semantic Studio's own page. A browser will not
 * attach a custom header to a request from a foreign origin without a CORS
 * preflight, and the backend's CORS policy refuses those preflights — so a
 * foreign page cannot send this, and the server refuses writes that lack it.
 * The value is not a secret; the browser's rules are what make it work.
 */
export const CLIENT_HEADER = { "X-Semantic-Studio": "1" } as const;

/**
 * A failed request, carrying the status code alongside the backend's message.
 *
 * The code is here because one caller has to tell two failures apart. A 404
 * from `/neighborhood` is not a fault: it is the endpoint saying the IRI is not
 * a node in the visualization graph, which is true of every predicate and every
 * blank node, and the interface answers that with a polite sentence rather than
 * an error bar. Anything else really did go wrong. Matching on the message text
 * would work until the message is reworded.
 *
 * It extends Error, so every existing `e instanceof Error` catch is unchanged.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * What the approval dialog answers: the just-once grant ids to present on the
 * retry (empty when the grant was remembered and the server needs no id), or
 * null when the user said Don't allow.
 */
export type ApprovalHandler = (requests: ApprovalRequest[]) => Promise<string[] | null>;

let approvalHandler: ApprovalHandler | null = null;

/** App registers the dialog here once, on mount. Passing null removes it. */
export function setApprovalHandler(handler: ApprovalHandler | null): void {
  approvalHandler = handler;
}

/** The sentence for a declined approval. Names the host and says nothing left. */
export function declinedMessage(requests: ApprovalRequest[]): string {
  const hosts = [...new Set(requests.map((r) => r.host))].join(", ");
  return `Semantic Studio did not connect to ${hosts}, so nothing was sent.`;
}

// One action can meet more than one question -- a redirect to a second host
// asks again for that host -- but never an unbounded number. Five is the
// broker's redirect limit, plus the first host.
const MAX_APPROVAL_ROUNDS = 6;

async function approvalRequests(response: Response): Promise<ApprovalRequest[] | null> {
  try {
    const body = await response.clone().json();
    const detail = body?.detail;
    if (detail?.code === "approval_required" && Array.isArray(detail.requests)) {
      return detail.requests as ApprovalRequest[];
    }
  } catch {
    /* not the approval shape */
  }
  return null;
}

/**
 * fetch, with the approval round trip. The first attempt is exactly the
 * request the caller built; only a retry adds the grant header.
 */
async function send(url: string, init?: RequestInit): Promise<Response> {
  let grants: string[] = [];
  for (let round = 0; ; round++) {
    const attempt =
      grants.length === 0
        ? init
        : {
            ...init,
            headers: {
              ...((init?.headers as Record<string, string>) ?? {}),
              "X-Semantic-Studio-Grant": grants.join(","),
            },
          };
    const response = await (attempt === undefined ? fetch(url) : fetch(url, attempt));
    if (response.status !== 409 || !approvalHandler || round >= MAX_APPROVAL_ROUNDS) {
      return response;
    }
    const requests = await approvalRequests(response);
    if (!requests) return response;
    const answer = await approvalHandler(requests);
    if (answer === null) throw new ApiError(declinedMessage(requests), 409);
    grants = [...grants, ...answer];
  }
}

/**
 * Unwrap a fetch Response: return the parsed JSON on success, or throw an
 * ApiError carrying the backend's `detail` (falling back to the status text).
 */
async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      // Backend errors put a human message in { detail: ... }.
      const body = await response.json();
      if (body.detail?.code === "approval_required") {
        // Reached only with no dialog registered: say what was needed.
        const hosts = (body.detail.requests as ApprovalRequest[]).map((r) => r.host);
        detail = `Semantic Studio needs your permission to connect to ${hosts.join(", ")}.`;
      } else if (Array.isArray(body.detail)) {
        // FastAPI's validation errors (422) are a list of objects, which
        // String() would print as "[object Object]".
        detail = body.detail
          .map((d: { msg?: unknown }) => (typeof d?.msg === "string" ? d.msg : ""))
          .filter(Boolean)
          .join("; ") || detail;
      } else if (body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(detail, response.status);
  }
  return response.json() as Promise<T>;
}

/**
 * The merged-view switch, as a query-string fragment (external-access Stage 2).
 * Sent only when on, so every request made with imports off is byte for byte
 * the request it was before the toggle existed.
 */
function withImports(url: string, imports: boolean): string {
  if (!imports) return url;
  return url + (url.includes("?") ? "&" : "?") + "imports=true";
}

// The open project's display language, or null (D-085). Module state rather
// than a parameter: five calls read it and a dozen components make them, and
// none of those components has any other reason to know about languages.
let displayLanguage: string | null = null;

/** The project store sets this when a project opens, closes or switches. */
export function setDisplayLanguage(lang: string | null): void {
  displayLanguage = lang;
}

function withLang(url: string): string {
  if (!displayLanguage) return url;
  return url + (url.includes("?") ? "&" : "?") + `lang=${encodeURIComponent(displayLanguage)}`;
}

// List loaded ontologies (dropdown summaries).
export function listOntologies(): Promise<OntologySummary[]> {
  return send("/api/ontologies").then((r) => handle<OntologySummary[]>(r));
}

// Upload a local file as multipart form data.
export function uploadOntology(file: File): Promise<OntologySummary> {
  const form = new FormData();
  form.append("file", file);
  return send("/api/ontologies/upload", {
    method: "POST",
    headers: { ...CLIENT_HEADER },
    body: form,
  }).then((r) => handle<OntologySummary>(r));
}

// Ask the backend to download an ontology from a URL.
export function fetchOntology(url: string): Promise<OntologySummary> {
  return send("/api/ontologies/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ url }),
  }).then((r) => handle<OntologySummary>(r));
}

// Remove an ontology (and its saved queries) from the server. The body is
// returned rather than discarded because `deletedQueries` is the only place the
// count of destroyed work exists — the client's own count was taken before the
// delete and can be out of date by the time it lands.
export function deleteOntology(id: string): Promise<OntologyDeletion> {
  return send(`/api/ontologies/${id}`, {
    method: "DELETE",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<OntologyDeletion>(r));
}

/**
 * The visualization nodes/edges for the graph view.
 *
 * `limit` is omitted on the first request on purpose, so the server applies
 * its own configured default. Sending 2,000 from here would hard-code the
 * number in a second place and make SEMANTIC_STUDIO_GRAPH_NODE_BUDGET do
 * nothing, which is the setting the whole choice of default relies on.
 * Callers pass a limit only once the user has asked for more.
 */
export function getGraph(id: string, limit?: number, imports = false): Promise<VizGraph> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  return send(withLang(withImports(`/api/ontologies/${id}/graph${query}`, imports))).then((r) =>
    handle<VizGraph>(r),
  );
}

/**
 * One entity plus its highest-degree neighbours, for growing the drawn graph.
 *
 * `limit` is omitted by default for the same reason getGraph omits it: the
 * server owns the number, and writing it here would put it in two places. The
 * response is merged into the graph the browser already holds rather than
 * replacing it, so this never costs the settled layout.
 */
export function getNeighborhood(
  id: string,
  iri: string,
  limit?: number,
  imports = false,
): Promise<VizNeighborhood> {
  const extra = limit === undefined ? "" : `&limit=${limit}`;
  return send(
    withLang(
      withImports(
        `/api/ontologies/${id}/neighborhood?iri=${encodeURIComponent(iri)}${extra}`,
        imports,
      ),
    ),
  ).then((r) => handle<VizNeighborhood>(r));
}

/**
 * The subClassOf / broader forests for the Hierarchy view.
 *
 * Unbudgeted, unlike getGraph: the tree is a fraction of the graph's size and
 * the frontend virtualizes it, so the whole asserted structure comes back. The
 * server caches it on the ontology, so re-opening the tab is cheap.
 */
export function fetchHierarchy(id: string, imports = false): Promise<Hierarchy> {
  return send(withLang(withImports(`/api/ontologies/${id}/hierarchy`, imports))).then((r) =>
    handle<Hierarchy>(r),
  );
}

// Every statement about one entity, for the detail panel.
export function getNodeDetails(id: string, iri: string, imports = false): Promise<NodeDetails> {
  return send(
    withLang(withImports(`/api/ontologies/${id}/node?iri=${encodeURIComponent(iri)}`, imports)),
  ).then((r) => handle<NodeDetails>(r));
}

// Label/IRI search for the search box. `kind` keeps one kind of entity,
// applied by the server before its limit (the editing form's pickers).
export function searchNodes(
  id: string,
  q: string,
  imports = false,
  kind?: SearchKind,
): Promise<VizNode[]> {
  const extra = kind ? `&kind=${kind}` : "";
  return send(
    withLang(
      withImports(`/api/ontologies/${id}/search?q=${encodeURIComponent(q)}${extra}`, imports),
    ),
  ).then((r) => handle<VizNode[]>(r));
}

// The source text for the View tab (original bytes, or pretty Turtle).
export function getSource(id: string, pretty = false): Promise<OntologySource> {
  return send(`/api/ontologies/${id}/source?pretty=${pretty}`).then((r) =>
    handle<OntologySource>(r),
  );
}

/* --- visual query builder ------------------------------------------------ */

// The class-level schema powering the query builder.
export function getQuerySchema(id: string, imports = false): Promise<QuerySchema> {
  return send(withImports(`/api/ontologies/${id}/query-schema`, imports)).then((r) =>
    handle<QuerySchema>(r),
  );
}

// Map a clicked graph node to the class/type the builder should step on.
export function getQueryNode(id: string, iri: string, imports = false): Promise<QueryNodeInfo> {
  return send(
    withImports(`/api/ontologies/${id}/query-node?iri=${encodeURIComponent(iri)}`, imports),
  ).then((r) => handle<QueryNodeInfo>(r));
}

// Execute a SPARQL SELECT and return the result rows.
export function runSparql(id: string, query: string, imports = false): Promise<SparqlResults> {
  return send(withImports(`/api/ontologies/${id}/sparql`, imports), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ query }),
  }).then((r) => handle<SparqlResults>(r));
}

// The saved-query library for one ontology.
export function listSavedQueries(ontologyId: string): Promise<SavedQuery[]> {
  return send(`/api/queries?ontology=${encodeURIComponent(ontologyId)}`).then((r) =>
    handle<SavedQuery[]>(r),
  );
}

// Create or update a saved query (id present -> update). A text query sends
// mode "text", its text as `sparql`, and the state it forked from or null.
export function saveQuery(payload: {
  id?: string;
  name: string;
  ontologyId: string;
  state: QueryState | null;
  sparql: string;
  mode?: "visual" | "text";
}): Promise<SavedQuery> {
  return send("/api/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify(payload),
  }).then((r) => handle<SavedQuery>(r));
}

// The SPARQL the ontology stores in itself (sh:select, sp:text, ...). Read
// only when the list is opened, so entering Query mode costs nothing more.
export function getEmbeddedQueries(id: string, imports = false): Promise<EmbeddedQueries> {
  return send(withImports(`/api/ontologies/${id}/embedded-queries`, imports)).then((r) =>
    handle<EmbeddedQueries>(r),
  );
}

// Delete a saved query by id.
export function deleteSavedQuery(qid: string): Promise<void> {
  return send(`/api/queries/${qid}`, {
    method: "DELETE",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle(r));
}

/** Pull the filename out of a Content-Disposition header, or null. The backend
 *  sends `attachment; filename="<name>-docs.zip"`; anything unexpected falls
 *  back to null so the caller can name the file itself. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match ? match[1] : null;
}

/**
 * Fetch an ontology's documentation as a zip blob, with the server's filename.
 *
 * This is the one client call that returns bytes rather than JSON, so it does
 * not go through `handle`. It still unwraps a failure the same way — the error
 * body is JSON `{ detail }` (for instance, the graph is over the 5 MB embed
 * guard) — and throws an ApiError carrying the status, so the caller can tell a
 * refusal from a real fault exactly as elsewhere.
 */
export async function downloadDocumentation(
  id: string,
  includeIndividuals = false,
): Promise<{ blob: Blob; filename: string }> {
  // Instance data is excluded by default (DOC-1 D-038); the flag is sent only
  // when the user opted in, and the backend treats any value other than "true"
  // as excluded, so omitting it is the safe path.
  const query = includeIndividuals ? "?include_individuals=true" : "";
  const response = await send(`/api/ontologies/${id}/documentation${query}`);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(detail, response.status);
  }
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ?? `${id}-docs.zip`;
  return { blob, filename };
}

/* --- the network broker (external-access Stage 1) ------------------------- */

// The offline switch and every remembered decision, for the Network panel.
export function getNetworkPolicy(): Promise<NetworkPolicy> {
  return send("/api/network/policy").then((r) => handle<NetworkPolicy>(r));
}

// Record the user's answer to the approval dialog. A just-once Allow comes
// back with the id the retry presents; a Block is always remembered.
export function grantNetwork(payload: {
  capability: NetworkCapability;
  host: string;
  decision: "allow" | "block";
  remember: boolean;
}): Promise<NetworkGrant> {
  return send("/api/network/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify(payload),
  }).then((r) => handle<NetworkGrant>(r));
}

// Forget a remembered decision; the site is asked about again next time.
export function revokeNetworkGrant(id: string): Promise<{ revoked: string }> {
  return send(`/api/network/grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<{ revoked: string }>(r));
}

// Turn working offline on or off.
export function setNetworkOffline(offline: boolean): Promise<{ offline: boolean }> {
  return send("/api/network/offline", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ offline }),
  }).then((r) => handle<{ offline: boolean }>(r));
}

// The latest connections, newest first. The server caps the limit.
export function getNetworkActivity(limit = 200): Promise<NetworkActivity[]> {
  return send(`/api/network/activity?limit=${limit}`).then((r) =>
    handle<NetworkActivity[]>(r),
  );
}

/* --- owl:imports (external-access Stage 2) --------------------------------- */

// Each import and its status. Reads files on the server; never connects.
export function listImports(id: string): Promise<ImportsListing> {
  return send(`/api/ontologies/${id}/imports`).then((r) => handle<ImportsListing>(r));
}

// Run the resolution chain. A host nobody has approved yet comes back as a 409,
// which `send` turns into the approval dialog and retries, as for any action.
export function resolveImports(id: string): Promise<ImportsListing> {
  return send(`/api/ontologies/${id}/imports/resolve`, {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<ImportsListing>(r));
}

// Download again whatever came from the network, through the broker.
export function refreshImports(id: string): Promise<ImportsListing> {
  return send(`/api/ontologies/${id}/imports/refresh`, {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<ImportsListing>(r));
}

// Stop a running resolution after the document it is on.
export function cancelImports(id: string): Promise<{ cancelled: boolean }> {
  return send(`/api/ontologies/${id}/imports/cancel`, {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<{ cancelled: boolean }>(r));
}

// Use an ontology already in the library for one import IRI.
export function mapImport(id: string, iri: string, ontologyId: string): Promise<ImportsListing> {
  return send(`/api/ontologies/${id}/imports/mapping`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ iri, ontologyId }),
  }).then((r) => handle<ImportsListing>(r));
}

/**
 * Files the user chose in the browser's picker, matched to imports on the
 * server by the IRI each declares. Only bytes travel: the server never sees,
 * and never reads, a path (AC-43). `forIri` is set when the files were chosen
 * for one import, and `acceptMismatch` is the user's confirmation that a file
 * declaring a different IRI should be used for it anyway (AC-42).
 */
export function chooseImportFiles(
  id: string,
  files: File[],
  options: { forIri?: string; acceptMismatch?: boolean } = {},
): Promise<ImportFilesResult> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  if (options.forIri) form.append("forIri", options.forIri);
  if (options.acceptMismatch) form.append("acceptMismatch", "true");
  return send(`/api/ontologies/${id}/imports/files`, {
    method: "POST",
    headers: { ...CLIENT_HEADER },
    body: form,
  }).then((r) => handle<ImportFilesResult>(r));
}

/* --- projects and editing (authoring-foundations) --------------------------- */

const JSON_WRITE = { "Content-Type": "application/json", ...CLIENT_HEADER };

/**
 * Invalid Turtle from the editor. The server answers 422 with the line and
 * column rdflib stopped at and its own message, which the editor shows behind
 * a disclosure; the shape is kept rather than flattened into a sentence.
 */
export class TurtleError extends ApiError {
  readonly line: number | null;
  readonly column: number | null;
  readonly detail: string;

  constructor(message: string, line: number | null, column: number | null, detail: string) {
    super(message, 422);
    this.name = "TurtleError";
    this.line = line;
    this.column = column;
    this.detail = detail;
  }
}

function projectUrl(pid: string, rest = ""): string {
  return `/api/projects/${encodeURIComponent(pid)}${rest}`;
}

function documentUrl(pid: string, doc: ProjectDocName, rest: string): string {
  return projectUrl(pid, `/documents/${doc}${rest}`);
}

/** A byte download (zip or Turtle), unwrapped the way downloadDocumentation is. */
async function bytes(url: string): Promise<{ blob: Blob; filename: string }> {
  const response = await send(url);
  if (!response.ok) await handle(response);
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ?? "download";
  return { blob, filename };
}

// Every project, from manifests alone.
export function listProjects(): Promise<ProjectSummary[]> {
  return send("/api/projects").then((r) => handle<ProjectSummary[]>(r));
}

// A new project from a template, or from a library ontology (fromOntologyId).
export function createProject(payload: {
  name: string;
  template?: ProjectTemplate;
  fromOntologyId?: string;
  baseIri?: string;
  prefix?: string;
  primaryLanguage?: string;
}): Promise<ProjectSummary> {
  return send("/api/projects", {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify(payload),
  }).then((r) => handle<ProjectSummary>(r));
}

// Rename, or change the additional languages. The manifest only.
export function updateProject(
  pid: string,
  changes: { name?: string; languages?: string[] },
): Promise<ProjectSummary> {
  return send(projectUrl(pid), {
    method: "PATCH",
    headers: JSON_WRITE,
    body: JSON.stringify(changes),
  }).then((r) => handle<ProjectSummary>(r));
}

export function duplicateProject(pid: string): Promise<ProjectSummary> {
  return send(projectUrl(pid, "/duplicate"), {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<ProjectSummary>(r));
}

// Moves the folder to projects/.trash/; `location` is where, for the notice.
export function deleteProject(pid: string): Promise<{ trashed: string; location: string }> {
  return send(projectUrl(pid), { method: "DELETE", headers: { ...CLIENT_HEADER } }).then((r) =>
    handle<{ trashed: string; location: string }>(r),
  );
}

export function exportProject(pid: string): Promise<{ blob: Blob; filename: string }> {
  return bytes(projectUrl(pid, "/export"));
}

export function openProject(pid: string): Promise<OpenedProject> {
  return send(projectUrl(pid, "/open"), {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<OpenedProject>(r));
}

// 409 when there are unsaved changes, unless `discard` says to drop them.
export function closeProject(pid: string, discard = false): Promise<{ closed: string }> {
  return send(projectUrl(pid, "/close"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ discard }),
  }).then((r) => handle<{ closed: string }>(r));
}

export function addShapesDocument(pid: string): Promise<ProjectSummary> {
  return send(projectUrl(pid, "/documents"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ role: "shapes" }),
  }).then((r) => handle<ProjectSummary>(r));
}

// One typed command (5.4). The canvas (E-7) is its main caller.
export function runCommand(
  pid: string,
  doc: ProjectDocName,
  command: string,
  args: Record<string, unknown>,
): Promise<ChangeResult> {
  return send(documentUrl(pid, doc, "/commands"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ command, args }),
  }).then((r) => handle<ChangeResult>(r));
}

// DeleteEntity's dry run: what a delete would take, with nothing changed.
export function previewDelete(
  pid: string,
  doc: ProjectDocName,
  iri: string,
  strategy: "reparent" | "orphan" = "reparent",
): Promise<{ dryRun: true; impact: DeleteImpact; revision: number }> {
  return send(documentUrl(pid, doc, "/commands"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ command: "DeleteEntity", args: { iri, strategy }, dryRun: true }),
  }).then((r) => handle<{ dryRun: true; impact: DeleteImpact; revision: number }>(r));
}

// The annotation properties the form offers, each with its default type.
export function getAnnotationProperties(
  pid: string,
  doc: ProjectDocName,
): Promise<AnnotationPropertyOption[]> {
  return send(documentUrl(pid, doc, "/annotation-properties")).then((r) =>
    handle<AnnotationPropertyOption[]>(r),
  );
}

// The editor's text: the text last applied, or clean Turtle.
export function getDocumentSource(
  pid: string,
  doc: ProjectDocName,
): Promise<{ text: string; revision: number; fromEditor: boolean }> {
  return send(documentUrl(pid, doc, "/source")).then((r) =>
    handle<{ text: string; revision: number; fromEditor: boolean }>(r),
  );
}

// Parse and replace the document. Invalid Turtle throws a TurtleError.
export async function applyDocumentSource(
  pid: string,
  doc: ProjectDocName,
  text: string,
): Promise<ChangeResult> {
  const response = await send(documentUrl(pid, doc, "/source"), {
    method: "PUT",
    headers: JSON_WRITE,
    body: JSON.stringify({ text }),
  });
  if (response.status === 422) {
    let body: { detail?: unknown } = {};
    try {
      body = await response.clone().json();
    } catch {
      /* not JSON: the generic path below says what it can */
    }
    const detail = body.detail as
      | { line?: number | null; column?: number | null; message?: string; detail?: string }
      | undefined;
    if (detail && typeof detail === "object" && typeof detail.message === "string") {
      throw new TurtleError(
        detail.message,
        detail.line ?? null,
        detail.column ?? null,
        detail.detail ?? "",
      );
    }
  }
  return handle<ChangeResult>(response);
}

export function undoChange(pid: string, doc: ProjectDocName): Promise<ChangeResult> {
  return send(documentUrl(pid, doc, "/undo"), {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<ChangeResult>(r));
}

export function redoChange(pid: string, doc: ProjectDocName): Promise<ChangeResult> {
  return send(documentUrl(pid, doc, "/redo"), {
    method: "POST",
    headers: { ...CLIENT_HEADER },
  }).then((r) => handle<ChangeResult>(r));
}

// Answers needsCommentsWarning, writing nothing, until confirmRewrite.
export function saveDocument(
  pid: string,
  doc: ProjectDocName,
  confirmRewrite = false,
): Promise<SaveResult> {
  return send(documentUrl(pid, doc, "/save"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ confirmRewrite }),
  }).then((r) => handle<SaveResult>(r));
}

// Save a copy as Turtle: the save format rule, the project untouched.
export function downloadDocumentCopy(
  pid: string,
  doc: ProjectDocName,
): Promise<{ blob: Blob; filename: string }> {
  return bytes(documentUrl(pid, doc, "/download"));
}

export function recoverProject(
  pid: string,
  action: "recover" | "discard",
): Promise<{ documents: OpenedProject["documents"] }> {
  return send(projectUrl(pid, "/recover"), {
    method: "POST",
    headers: JSON_WRITE,
    body: JSON.stringify({ action }),
  }).then((r) => handle<{ documents: OpenedProject["documents"] }>(r));
}

// How many entities lack a name in each project language.
export function getLanguageReport(pid: string, doc: ProjectDocName): Promise<LanguageReport> {
  return send(documentUrl(pid, doc, "/languages")).then((r) => handle<LanguageReport>(r));
}
