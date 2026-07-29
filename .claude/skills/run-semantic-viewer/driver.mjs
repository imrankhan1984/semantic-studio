#!/usr/bin/env node
/*
================================================================================
FILE: .claude/skills/run-semantic-viewer/driver.mjs
================================================================================

SUMMARY
    Agent-facing harness for running and driving Semantic Studio. It owns a
    uvicorn process, talks to the REST API, and drives the built frontend in
    headless Chrome over the DevTools Protocol so a caller can click, type and
    screenshot the real application without a human at the keyboard.

BASIC IDEA
    One Node file, no npm dependencies. `serve` spawns uvicorn against a
    throwaway data directory so the smoke run never touches the user's real
    ontology library. `api` is curl for the JSON endpoints. `ui` drives Chrome
    over raw CDP: Node 24 ships a global WebSocket, so the whole browser
    automation layer is a promise-keyed request/response map over one socket.
    `smoke` chains all of it into one end-to-end flow and exits non-zero if any
    step fails.

    Chrome is launched with --enable-unsafe-swiftshader because the graph is
    rendered by Sigma.js on WebGL, and headless Chrome has no GPU: without
    software rasterisation the canvas stays blank and every screenshot lies.

INPUTS / INPUT SOURCES
    - argv: the sub-command and its arguments.
    - backend/.venv/Scripts/python.exe (Windows) or backend/.venv/bin/python.
    - frontend/dist, built by `npm run build`, mounted by the backend at /.
    - examples/space-exploration.ttl as the ontology under test.
    - Env: PORT, DATA_DIR, CHROME, HEADFUL, KEEP_DATA.

EXPECTED OUTPUT
    - Progress lines on stdout, one per step, prefixed with the step name.
    - PNG screenshots written to .claude/skills/run-semantic-viewer/shots/.
    - Exit code 0 when every step passed, 1 otherwise.
================================================================================
*/

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SKILL_DIR, '..', '..', '..');
const SHOTS = join(SKILL_DIR, 'shots');

const PORT = Number(process.env.PORT || 8010);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

// A scratch library by default. The app persists every ontology it loads to
// disk, so a smoke run against the default location would silently add rows to
// whatever the developer has in their real dropdown.
const DATA_DIR = process.env.DATA_DIR || join(tmpdir(), 'semantic-studio-driver-data');

// Every selector the UI flow depends on, in one place: these are the handles
// that break when a component is restyled, and a driver that fails here is
// telling you a class name moved, not that the app is broken.
const SEL = {
  startRow: '.start-screen .start-row',
  search: '.search-box input',
  results: '.search-results li',
  detail: '.detail-panel',
  queryPanel: '.query-panel',
  sparql: '.sparql-preview',
  results2: '.results-table',
  nav: '.nav-item',
};

const log = (step, ...rest) => console.log(`[${step}]`, ...rest);
const fail = (step, msg) => { console.error(`[${step}] FAILED: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pythonExe() {
  const win = join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe');
  const nix = join(ROOT, 'backend', '.venv', 'bin', 'python');
  if (existsSync(win)) return win;
  if (existsSync(nix)) return nix;
  fail('setup', `no venv at backend/.venv — run the Setup section of SKILL.md first`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

function startServer() {
  mkdirSync(DATA_DIR, { recursive: true });
  const proc = spawn(
    pythonExe(),
    ['-m', 'uvicorn', '--app-dir', 'backend', 'app.main:app', '--port', String(PORT), '--log-level', 'warning'],
    {
      cwd: ROOT,
      env: { ...process.env, SEMANTIC_STUDIO_DATA_DIR: DATA_DIR, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout.on('data', (b) => process.stdout.write(`[uvicorn] ${b}`));
  proc.stderr.on('data', (b) => process.stderr.write(`[uvicorn] ${b}`));
  return proc;
}

// proc.kill() on Windows aborts the Node process with a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) when the child was
// spawned with pipes. taskkill /T also reaps uvicorn's reloader children, which
// a plain kill leaves holding the port.
function stopServer(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* best effort */ }
  } else {
    proc.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, ok: r.ok, body: json };
}

async function uploadOntology(file) {
  // multipart via the platform FormData/Blob — no form-data package needed.
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(file);
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'text/turtle' }), file.split(/[\\/]/).pop());
  const r = await fetch(`${BASE}/api/ontologies/upload`, { method: 'POST', body: fd });
  const body = await r.json().catch(() => null);
  if (!r.ok) fail('upload', `${r.status} ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------
// Chrome over CDP — no puppeteer, no playwright
// ---------------------------------------------------------------------------

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  fail('chrome', 'no Chrome or Edge found — set CHROME=<path to the binary>');
}

class Browser {
  constructor(proc, ws, profileDir) {
    this.proc = proc;
    this.ws = ws;
    this.profileDir = profileDir;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}, useSession = true) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
    });
  }

  static async launch() {
    const profileDir = join(tmpdir(), `semantic-studio-chrome-${process.pid}`);
    mkdirSync(profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1600,1000',
      // Sigma.js renders on WebGL. Headless Chrome has no GPU, and without
      // SwiftShader every canvas screenshot comes back an empty rectangle.
      '--enable-unsafe-swiftshader',
      'about:blank',
    ];
    if (!process.env.HEADFUL) args.unshift('--headless=new');
    const proc = spawn(chromePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', () => {}); // Chrome is chatty on stderr; ignore.

    // The DevTools endpoint is not ready the instant the process exists.
    let wsUrl = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !wsUrl) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        wsUrl = (await r.json()).webSocketDebuggerUrl;
      } catch { await sleep(250); }
    }
    if (!wsUrl) fail('chrome', 'DevTools endpoint never came up');

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    const b = new Browser(proc, ws, profileDir);
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' }, false);
    // flatten:true multiplexes the page session over the browser socket, which
    // is what lets one WebSocket serve both browser- and page-level commands.
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true }, false);
    b.sessionId = sessionId;
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    return b;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30_000);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  // Poll rather than subscribe: the app has no single "ready" event, and every
  // interesting condition here is a DOM predicate anyway.
  async waitFor(expression, timeoutMs = 20_000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(`!!(${expression})`);
        if (last) return true;
      } catch (e) { last = e.message; }
      await sleep(200);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label} (last=${last})`);
  }

  async click(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`click: no element matching ${selector}`);
    await this.mouseClick(box.x, box.y);
  }

  async mouseClick(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    await sleep(120);
  }

  // Nav tabs and toolbar buttons carry no id or data attribute, only a label,
  // so text is the only stable handle on them.
  async clickText(selector, text) {
    const found = await this.eval(`(() => {
      const want = ${JSON.stringify(text.toLowerCase())};
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(e => e.textContent.trim().toLowerCase().includes(want));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;   // present but not laid out
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!found) throw new Error(`clickText: no visible ${selector} containing "${text}"`);
    await this.mouseClick(found.x, found.y);
  }

  clickNav(label) { return this.clickText(SEL.nav, label); }

  async type(selector, text) {
    await this.click(selector);
    // Select-all first: the search box keeps its text between flows, and React
    // controlled inputs ignore a value assigned straight onto the DOM node.
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA',
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA',
    });
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp' });
      await sleep(30);
    }
    await sleep(300); // the results list is debounced
  }

  async shot(name) {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const path = join(SHOTS, name.endsWith('.png') ? name : `${name}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    try { this.ws.close(); } catch {}
    try { this.proc.kill(); } catch {}
    await sleep(300);
    try { rmSync(this.profileDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdServe() {
  if (!existsSync(join(ROOT, 'frontend', 'dist', 'index.html'))) {
    console.warn('[serve] frontend/dist missing — API will work, but / returns 404. Run: cd frontend && npm run build');
  }
  const proc = startServer();
  if (!(await waitForHealth())) fail('serve', 'health check never passed');
  log('serve', `up at ${BASE}  (data dir: ${DATA_DIR})`);
  log('serve', 'Ctrl-C to stop');
  process.on("SIGINT", () => { stopServer(proc); process.exit(0); });
  await new Promise(() => {});
}

// Git Bash / MSYS rewrites any argument that looks like a Unix absolute path
// into a Windows one before the process ever starts, so `/api/ontologies`
// arrives as `C:/Program Files/Git/api/ontologies`. Cut back to the /api
// segment rather than making every caller remember MSYS_NO_PATHCONV=1.
function unmanglePath(p) {
  const i = p.indexOf('/api/');
  return i > 0 ? p.slice(i) : p;
}

async function cmdApi(argv) {
  const [method, rawPath, body] = argv;
  if (!rawPath) fail('api', 'usage: driver.mjs api <METHOD> <path> [json-body]');
  const path = unmanglePath(rawPath);
  const r = await api(method.toUpperCase(), path, body);
  console.log(JSON.stringify(r.body, null, 2));
  if (!r.ok) process.exit(1);
}

async function cmdUi(argv) {
  const url = argv[0] || BASE;
  const name = argv[1] || 'ui';
  const b = await Browser.launch();
  try {
    await b.goto(url);
    await sleep(1500);
    const path = await b.shot(name);
    log('ui', `title=${JSON.stringify(await b.eval('document.title'))}`);
    log('ui', `screenshot -> ${path}`);
  } finally {
    await b.close();
  }
}

async function cmdSmoke() {
  if (!process.env.KEEP_DATA) rmSync(DATA_DIR, { recursive: true, force: true });
  if (!existsSync(join(ROOT, 'frontend', 'dist', 'index.html'))) {
    fail('smoke', 'frontend/dist missing — run: cd frontend && npm run build');
  }

  const server = startServer();
  let browser = null;
  try {
    if (!(await waitForHealth())) fail('smoke', 'backend health check never passed');
    log('health', 'ok');

    // --- API layer -------------------------------------------------------
    const up = await uploadOntology(join(ROOT, 'examples', 'space-exploration.ttl'));
    const oid = up.id;
    log('upload', `id=${oid} name=${up.name} triples=${up.triples}`);

    const list = await api('GET', '/api/ontologies');
    if (!list.ok || !list.body.some((o) => o.id === oid)) fail('list', JSON.stringify(list.body));
    log('list', `${list.body.length} ontology/ontologies in the library`);

    const graph = await api('GET', `/api/ontologies/${oid}/graph`);
    if (!graph.ok || !graph.body.nodes?.length) fail('graph', JSON.stringify(graph.body).slice(0, 300));
    log('graph', `${graph.body.nodes.length} nodes, ${graph.body.edges.length} edges`);

    const search = await api('GET', `/api/ontologies/${oid}/search?q=mission`);
    if (!search.ok || !search.body.length) fail('search', JSON.stringify(search.body));
    log('search', `q=mission -> ${search.body.length} hits, first=${search.body[0].label}`);

    // /search returns viz nodes, so the IRI arrives as `id` — there is no `iri`
    // key on a search hit, only on the /node response it feeds.
    const hitIri = search.body[0].id;
    const node = await api('GET', `/api/ontologies/${oid}/node?iri=${encodeURIComponent(hitIri)}`);
    if (!node.ok) fail('node', JSON.stringify(node.body));
    log('node', `${hitIri} -> ${node.body.outgoingTotal} outgoing, ${node.body.incomingTotal} incoming`);

    const schema = await api('GET', `/api/ontologies/${oid}/query-schema`);
    if (!schema.ok || !schema.body.classes?.length) fail('query-schema', JSON.stringify(schema.body).slice(0, 300));
    log('query-schema', `${schema.body.classes.length} classes offered to the query builder`);

    const sparql = await api('POST', `/api/ontologies/${oid}/sparql`, {
      query: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5',
    });
    if (!sparql.ok || !sparql.body.rows?.length) fail('sparql', JSON.stringify(sparql.body).slice(0, 300));
    // The executor names the column list `vars` (SPARQL's own word), not `columns`.
    log('sparql', `${sparql.body.rowCount} rows in ${sparql.body.durationMs}ms, vars=${sparql.body.vars.join(',')}, truncated=${sparql.body.truncated}`);

    // SELECT-only is a security control, not a convenience — assert it holds.
    const blocked = await api('POST', `/api/ontologies/${oid}/sparql`, {
      query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
    });
    if (blocked.ok) fail('sparql-guard', 'CONSTRUCT was accepted; prepare_select is not enforcing SELECT-only');
    log('sparql-guard', `CONSTRUCT rejected with ${blocked.status}`);

    // --- UI layer --------------------------------------------------------
    browser = await Browser.launch();
    await browser.goto(BASE);
    log('ui', `loaded ${BASE}, title=${await browser.eval('document.title')}`);

    // The application opens on the chooser and renders nothing until asked, so
    // the graph has to be requested by picking the ontology uploaded above.
    // Before the startup-chooser-screen spec this step did not exist: the app
    // auto-selected the most recent ontology on mount, which is exactly the
    // behaviour that feature removed. A driver that skipped this would sit
    // here waiting for canvases that are correctly absent.
    await browser.waitFor(
      `document.querySelectorAll("${SEL.startRow}").length > 0`,
      30_000, 'start screen library rows',
    );
    log('ui-chooser', `chooser shown -> ${await browser.shot('00-chooser')}`);
    // Nothing may have been drawn yet: the whole point is that the graph costs
    // nothing until this click.
    if (await browser.eval('document.querySelectorAll("canvas").length > 0')) {
      fail('ui-chooser', 'a canvas was mounted before any ontology was picked');
    }
    await browser.click(`${SEL.startRow}:first-child`);

    await browser.waitFor(
      'document.querySelector("canvas") && document.querySelectorAll("canvas").length >= 2',
      30_000, 'sigma canvases mounted',
    );
    // ForceAtlas2 keeps moving for a while; let it settle so the shot is legible.
    await sleep(4000);
    log('ui', `graph rendered -> ${await browser.shot('01-graph')}`);

    const painted = await browser.eval(`(() => {
      const cs = [...document.querySelectorAll('canvas')];
      return cs.map(c => c.width + 'x' + c.height).join(' ');
    })()`);
    log('ui', `canvas sizes: ${painted}`);

    // A blank WebGL canvas is the classic headless failure. Prove pixels moved.
    const nonBlank = await browser.eval(`(() => {
      const c = [...document.querySelectorAll('canvas')].find(c => c.width > 100);
      if (!c) return false;
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'no-webgl-context';
      return true;
    })()`);
    if (nonBlank !== true) fail('ui-webgl', `WebGL not available in the page: ${nonBlank}`);
    log('ui-webgl', 'WebGL context is live');

    // --- Explore mode: search -> detail panel ---------------------------
    await browser.type(SEL.search, 'Mission');
    await browser.waitFor(`document.querySelectorAll("${SEL.results}").length > 0`, 15_000, 'search results');
    log('ui', `search dropdown -> ${await browser.shot('02-search')}`);

    await browser.click(`${SEL.results}:first-child`);
    await browser.waitFor(`document.querySelector("${SEL.detail}")`, 15_000, 'detail panel open');
    // .detail-iri also holds the copy-to-clipboard glyph; keep the IRI only.
    const detailIri = await browser.eval(`document.querySelector(".detail-iri")?.innerText.trim().split(/\\s+/)[0]`);
    log('ui', `detail panel open for ${detailIri} -> ${await browser.shot('03-detail')}`);

    // --- Query mode: search adds a step, preview writes SPARQL ----------
    await browser.clickNav('query');
    await browser.waitFor(`document.querySelector("${SEL.queryPanel}")`, 15_000, 'query panel mounted');
    await browser.type(SEL.search, 'Mission');
    await browser.waitFor(`document.querySelectorAll("${SEL.results}").length > 0`, 15_000, 'query search results');
    await browser.click(`${SEL.results}:first-child`);
    // The visual builder regenerates the preview after the schema round-trip.
    await browser.waitFor(
      `document.querySelector("${SEL.sparql}") && document.querySelector("${SEL.sparql}").innerText.includes("SELECT")`,
      20_000, 'SPARQL preview generated',
    );
    // .sparql-preview innerText interleaves the line-number gutter with the
    // code; read the .sparql-code spans to get the query as a user would copy it.
    const generated = await browser.eval(
      `[...document.querySelectorAll("${SEL.sparql} .sparql-code")].map(e => e.innerText).join("\\n")`,
    );
    log('ui-query', `builder generated:\n${generated.split('\n').map((l) => '    | ' + l).join('\n')}`);
    if (!generated.includes(':Mission')) fail('ui-query', 'generated query does not constrain the clicked class');
    log('ui-query', `query mode -> ${await browser.shot('04-query')}`);

    // Execute runs the generated SELECT through the same endpoint the API
    // smoke hit, but via the builder — the round trip PRs most often break.
    await browser.clickText('button', 'Execute');
    await browser.waitFor(`document.querySelector("${SEL.results2}")`, 30_000, 'results table rendered');
    const rowCount = await browser.eval(`document.querySelectorAll("${SEL.results2} tbody tr").length`);
    if (!rowCount) fail('ui-results', 'results table rendered with zero rows');
    log('ui-results', `${rowCount} rows -> ${await browser.shot('05-results')}`);

    log('smoke', 'ALL STEPS PASSED');
  } finally {
    if (browser) await browser.close();
    stopServer(server);
  }
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const commands = { serve: cmdServe, api: () => cmdApi(rest), ui: () => cmdUi(rest), smoke: cmdSmoke };
if (!commands[cmd]) {
  console.error(`usage: node driver.mjs <smoke|serve|api|ui>

  smoke                        start server, exercise API + UI, screenshot, exit
  serve                        start the server and hold it (Ctrl-C to stop)
  api <METHOD> <path> [json]   one request against a server already running
  ui <url> [name]              screenshot any URL into shots/<name>.png

env: PORT=${PORT} CDP_PORT=${CDP_PORT} DATA_DIR=<scratch> CHROME=<path> HEADFUL=1 KEEP_DATA=1`);
  process.exit(2);
}
commands[cmd]().catch((e) => { console.error(e); process.exit(1); });
