// Local HTTP server on 127.0.0.1: the browser extension (/ext), MCP apps (/mcp) and the Homebox window (/api).
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { config, saveConfig, token, VERSION, OS_NAME, HOME, DEFAULT_WS } = require('./config');
const { wsRoot, validateWorkspace } = require('./sandbox');
const H = require('./hub');
const T = require('./tools');
const B = require('./browser');
const maya = require('./maya');
const A = require('./apps');
const { makeZip } = require('./zip');
const F = require('./files');

const BASE_PORT = Number(process.env.HOMEBOX_PORT) || 7777;
const UI_DIR = path.join(__dirname, '..', 'ui');
const EXT_DIR = path.join(__dirname, '..', '..', 'extension').replace('app.asar', 'app.asar.unpacked');
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/guides.js': ['guides.js', 'text/javascript; charset=utf-8'] };

let PORT = BASE_PORT;
const hooks = { quit: () => process.exit(0), show: () => {}, pickFolder: null, openPath: null };
const pairRequests = new Map();
const runs = new Map();
const clients = new Set();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, r] of runs) if (r.done && r.finished < cutoff) runs.delete(id);
  for (const [id, p] of pairRequests) if (p.created < Date.now() - 10 * 60_000) pairRequests.delete(id);
}, 60_000).unref();

// ---------- live state for the window ----------
function panelState() {
  let root = null;
  try { root = wsRoot(); } catch {}
  return {
    version: VERSION, port: PORT, os: OS_NAME, paused: H.isPaused(),
    policy: config.policy, caps: T.CAPS, maxAutoSteps: config.maxAutoSteps, ui: config.ui, fullAccess: config.fullAccess,
    workspace: { active: root || config.active, name: path.basename(root || config.active || ''), list: config.workspaces, missing: !root },
    suggestions: [path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), DEFAULT_WS],
    pending: H.publicPending(),
    log: H.log.slice(-300),
    devices: config.devices.map(({ token: _t, ...d }) => d),
    pairRequests: [...pairRequests.values()].filter(p => p.status === 'waiting').map(({ token: _t, ...p }) => p),
    mcp: { localUrl: `http://127.0.0.1:${PORT}/mcp/${config.mcpToken}` },
    apps: A.panelInfo(),
    maya: { port: maya.MAYA_PORT, setupLine: maya.setupLine(), autoStart: maya.autoStartStatus(), userSetup: maya.USER_SETUP },
    canPickFolder: !!hooks.pickFolder,
  };
}
H.hub.on('change', () => {
  const msg = `data: ${JSON.stringify(panelState())}\n\n`;
  for (const res of clients) res.write(msg);
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000).unref();

// ---------- MCP ----------
async function handleMcpMessage(msg) {
  const { id, method, params = {} } = msg || {};
  const ok = result => ({ jsonrpc: '2.0', id, result });
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'homebox', version: VERSION },
        instructions: "These tools work inside one sandbox folder on the user's own computer. Risky actions wait for the human to approve them in the Homebox app. If an action is denied, do not retry it — ask the user.",
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: T.toolList() });
    case 'tools/call':
      try { return ok({ content: [{ type: 'text', text: T.asText(await T.execute(params.name, params.arguments, { source: 'mcp' })) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ---------- helpers ----------
const localHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function isLocalPanelRequest(req) {
  const hosts = localHosts();
  if (!hosts.has(String(req.headers.host))) return false;
  const o = req.headers.origin;
  if (o && !hosts.has(o.replace(/^https?:\/\//, ''))) return false;
  if (req.method === 'POST' && req.headers['x-homebox'] !== '1') return false;
  return true;
}
const isExtensionOrigin = req => /^(chrome|moz|safari-web)-extension:\/\//.test(String(req.headers.origin || ''));
function readBody(req, limit = 8_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readJson = async (req, limit) => { const b = await readBody(req, limit); return b ? JSON.parse(b) : {}; };
const UPLOAD_BODY = 30_000_000;  // a 20 MB file as base64 text
// A picture or file the user adds: saved into the sandbox, listed in Activity with Undo.
async function addUpload(body, who) {
  const r = await F.saveUpload(body.name, body.data);
  H.addLog({ source: who, tool: 'upload', summary: `Added ${r.rel}`, status: 'ok', undo: r.undo });
  return { path: r.rel, bytes: r.bytes };
}
// No other site may show Homebox in a frame (stops "clickjacking" Approve / Full access),
// and the window may only load its own files and talk to this server.
const PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Content-Security-Policy': "frame-ancestors 'none'; default-src 'none'",
};
function send(res, code, body, type = 'application/json', extra = {}) {
  const csp = type.startsWith('text/html') ? { 'Content-Security-Policy': PANEL_CSP } : {};
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...csp, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function tokenEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function extDevice(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const d = config.devices.find(x => tokenEq(x.token, t));
  if (d) d.lastSeen = Date.now();
  return d || null;
}
function extensionZip() {
  const files = {};
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else files[`homebox-extension/${prefix}${e.name}`] = fs.readFileSync(p);
    }
  };
  walk(EXT_DIR, '');
  return makeZip(files);
}

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  const m = p.match(/^\/mcp(?:\/([^/]+))?\/?$/);
  if (m) {
    // MCP apps run on this computer and don't send an Origin; web pages do.
    if (!localHosts().has(String(req.headers.host))) return send(res, 403, { error: 'local only' });
    if (req.headers.origin && !localHosts().has(String(req.headers.origin).replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'websites cannot use this door' });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenEq(m[1] || bearer || '', config.mcpToken)) return send(res, 401, { error: 'bad token' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, 'application/json', { Allow: 'POST' });
    let payload;
    try { payload = await readJson(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const out = Array.isArray(payload) ? (await Promise.all(payload.map(handleMcpMessage))).filter(Boolean) : await handleMcpMessage(payload);
    if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
    return send(res, 200, out);
  }

  if (p.startsWith('/ext/')) {
    if (!localHosts().has(String(req.headers.host))) return send(res, 403, { error: 'local only' });
    if (req.headers.origin && !isExtensionOrigin(req)) return send(res, 403, { error: 'websites cannot use this door' });
    if (p === '/ext/hello') return send(res, 200, { app: 'homebox', version: VERSION, paired: !!extDevice(req) });
    if (p === '/ext/pair/request' && req.method === 'POST') {
      const body = await readJson(req);
      if ([...pairRequests.values()].filter(p => p.status === 'waiting').length >= 3) return send(res, 429, { error: 'Too many connection requests are waiting. Approve or deny them in the Homebox window first.' });
      const id = crypto.randomBytes(8).toString('hex');
      const code = String(crypto.randomInt(1000, 10000));
      pairRequests.set(id, { id, code, name: String(body.name || 'Browser').slice(0, 60), installId: String(body.installId || '').slice(0, 64), created: Date.now(), status: 'waiting' });
      H.changed();
      hooks.show('connect');
      return send(res, 200, { id, code });
    }
    if (p === '/ext/pair/status') {
      const r = pairRequests.get(url.searchParams.get('id'));
      if (!r) return send(res, 404, { status: 'expired' });
      if (r.status === 'approved') { pairRequests.delete(r.id); return send(res, 200, { status: 'approved', token: r.token }); }
      return send(res, 200, { status: r.status });
    }
    const dev = extDevice(req);
    if (!dev) return send(res, 401, { error: 'not paired' });
    if (p === '/ext/info') {
      return send(res, 200, { workspace: path.basename(config.active), os: OS_NAME, policy: config.policy, paused: H.isPaused(), fullAccess: config.fullAccess, prompt: T.starterPrompt(), maxAutoSteps: config.maxAutoSteps, port: PORT });
    }
    if (p === '/ext/upload' && req.method === 'POST') {
      const body = await readJson(req, UPLOAD_BODY);
      return send(res, 200, await addUpload(body, 'extension'));
    }
    if (p === '/ext/parse' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, T.parseBlock(body.text || '') || { none: true });
    }
    if (p === '/ext/run' && req.method === 'POST') {
      const body = await readJson(req);
      const actions = Array.isArray(body.actions) ? body.actions.slice(0, 20) : [];
      if (!actions.length) return send(res, 400, { error: 'no actions' });
      const id = crypto.randomBytes(8).toString('hex');
      const site = String(body.site || '').slice(0, 100);
      const run = { id, deviceId: dev.id, site, done: false, created: Date.now(), extras: { cards: [], attach: [] } };
      runs.set(id, run);
      T.runActions(actions, { source: 'extension', site, device: dev.name, deviceId: dev.id, runId: id, extras: run.extras }).then(results => {
        run.results = results;
        const step = Number(body.step) || 0;
        run.text = T.formatResults(results, step ? `(Homebox step ${step}/${config.maxAutoSteps}) Continue with more homebox blocks, or finish with a summary and DONE.` : null);
        run.done = true;
        run.finished = Date.now();
      });
      return send(res, 200, { runId: id });
    }
    if (p === '/ext/run/status') {
      const run = runs.get(url.searchParams.get('id'));
      if (!run || run.deviceId !== dev.id) return send(res, 404, { error: 'no such run' });
      // browser commands for this browser ride along while the panel checks on the task
      const out = { done: run.done, text: run.text, results: run.results, pending: H.publicPending(x => x.runId === run.id), browser: B.take(dev.id) };
      if (run.done) { out.cards = run.extras.cards; out.attach = run.extras.attach; }
      return send(res, 200, out);
    }
    if (p === '/ext/browser/result' && req.method === 'POST') {
      const body = await readJson(req, UPLOAD_BODY);  // screenshots can be a few MB
      return send(res, B.result(dev.id, body) ? 200 : 404, { ok: true });
    }
    if (p === '/ext/decide' && req.method === 'POST') {
      const body = await readJson(req);
      const item = H.pendingItem(body.id);
      if (!item || item.deviceId !== dev.id) return send(res, 404, { error: 'no such request' });
      H.decide(body.id, body.approve);
      return send(res, 200, { ok: true });
    }
    if (p === '/ext/stop' && req.method === 'POST') {
      for (const item of H.publicPending(x => x.deviceId === dev.id)) H.decide(item.id, false);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (!isLocalPanelRequest(req)) return send(res, 403, { error: 'The Homebox panel is only available on this computer.' });

  if (req.method === 'GET') {
    if (STATIC[p]) return send(res, 200, fs.readFileSync(path.join(UI_DIR, STATIC[p][0])), STATIC[p][1]);
    if (p === '/icon.png' && fs.existsSync(ICON)) return send(res, 200, fs.readFileSync(ICON), 'image/png');
    if (p === '/api/state') return send(res, 200, panelState());
    // small answer for the VS Code extension: which folder the AI works in, and the folders already approved
    if (p === '/api/sandbox') { let active = null; try { active = wsRoot(); } catch {} return send(res, 200, { app: 'homebox', active, list: config.workspaces }); }
    if (p === '/api/prompt') return send(res, 200, T.starterPrompt(), 'text/plain; charset=utf-8');
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write(`data: ${JSON.stringify(panelState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/download/homebox-extension.zip') {
      return send(res, 200, extensionZip(), 'application/zip', { 'Content-Disposition': 'attachment; filename="homebox-extension.zip"' });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (req.method === 'POST') {
    const body = await readJson(req, p === '/api/upload' ? UPLOAD_BODY : undefined);
    switch (p) {
      case '/api/decide': return send(res, H.decide(body.id, body.approve) ? 200 : 404, { ok: true });
      case '/api/policy': {
        for (const k of Object.keys(T.CAPS)) {
          if (body[k] === undefined) continue;
          const allowed = ['read', 'write', 'browser'].includes(k) ? ['auto', 'ask', 'off'] : ['ask', 'off'];
          if (allowed.includes(body[k])) config.policy[k] = body[k];
        }
        if (Number(body.maxAutoSteps) >= 1) config.maxAutoSteps = Math.min(200, Math.floor(Number(body.maxAutoSteps)));
        saveConfig();
        const changed = Object.keys(T.CAPS).filter(k => body[k] !== undefined);
        H.addLog({ source: 'you', tool: 'settings', summary: changed.length ? `Permissions: ${changed.map(k => `${T.CAPS[k].label.toLowerCase()} ${config.policy[k]}`).join(' · ')}` : `Auto-run step limit: ${config.maxAutoSteps}`, status: 'ok' });
        return send(res, 200, { ok: true });
      }
      case '/api/ui': {
        if (['system', 'light', 'dark'].includes(body.theme)) config.ui.theme = body.theme;
        for (const k of ['reduceMotion', 'notifications', 'advanced']) if (typeof body[k] === 'boolean') config.ui[k] = body[k];
        saveConfig(); H.changed();
        return send(res, 200, { ok: true });
      }
      case '/api/pause': H.setPaused(!!body.paused); return send(res, 200, { paused: H.isPaused() });
      case '/api/fullaccess': {
        config.fullAccess = !!body.on;
        saveConfig();
        // anything already waiting is approved too, so the AI isn't left stuck
        if (config.fullAccess) for (const item of H.publicPending()) H.decide(item.id, true);
        H.addLog({ source: 'you', tool: 'settings', summary: config.fullAccess ? 'Full access ON: AI runs everything turned on without asking' : 'Full access off: AI asks again', status: 'ok' });
        return send(res, 200, { fullAccess: config.fullAccess });
      }
      case '/api/workspace/pick': {
        if (!hooks.pickFolder) throw new Error('Type the folder path instead.');
        const picked = await hooks.pickFolder();
        if (!picked) return send(res, 200, { ok: false, cancelled: true });
        body.path = picked;
      } // falls through to add
      case '/api/workspace/add': {
        const real = validateWorkspace(body.path, !!body.create);
        if (!config.workspaces.includes(real)) config.workspaces.push(real);
        config.active = real;
        saveConfig();
        H.addLog({ source: 'you', tool: 'workspace', summary: `Sandbox folder → ${real}`, status: 'ok' });
        return send(res, 200, { ok: true });
      }
      case '/api/workspace/select': {
        if (!config.workspaces.includes(body.path)) throw new Error('Unknown folder');
        config.active = body.path;
        saveConfig();
        H.addLog({ source: 'you', tool: 'workspace', summary: `Sandbox folder → ${body.path}`, status: 'ok' });
        return send(res, 200, { ok: true });
      }
      case '/api/workspace/remove': {
        if (config.workspaces.length <= 1) throw new Error('Keep at least one folder');
        config.workspaces = config.workspaces.filter(w => w !== body.path);
        if (config.active === body.path) config.active = config.workspaces[0];
        saveConfig(); H.changed();
        return send(res, 200, { ok: true });
      }
      case '/api/workspace/open': (hooks.openPath || (() => {}))(wsRoot()); return send(res, 200, { ok: true });
      case '/api/pair/decide': {
        const r = pairRequests.get(body.id);
        if (!r || r.status !== 'waiting') throw new Error('That connection request expired. Click Connect in the browser again.');
        if (body.approve) {
          r.token = token(32);
          r.status = 'approved';
          if (r.installId) config.devices = config.devices.filter(d => d.installId !== r.installId);
          config.devices.push({ id: crypto.randomBytes(6).toString('hex'), installId: r.installId, name: r.name, token: r.token, created: Date.now(), lastSeen: Date.now() });
          saveConfig();
          H.addLog({ source: 'you', tool: 'pair', summary: `Connected browser: ${r.name}`, status: 'ok' });
        } else r.status = 'denied';
        H.changed();
        return send(res, 200, { ok: true });
      }
      case '/api/devices/revoke':
        config.devices = config.devices.filter(d => d.id !== body.id);
        saveConfig();
        H.addLog({ source: 'you', tool: 'pair', summary: 'Disconnected a browser', status: 'ok' });
        return send(res, 200, { ok: true });
      case '/api/maya/test': return send(res, 200, await maya.mayaTest());
      case '/api/maya/autostart':
        maya.setAutoStart(!!body.on);
        H.addLog({ source: 'you', tool: 'maya', summary: body.on ? 'Maya: start with Maya automatically' : 'Maya: removed automatic start', status: 'ok' });
        return send(res, 200, { ok: true });
      case '/api/apps/test': {
        const r = await A.testApp(String(body.id));
        H.changed();
        return send(res, 200, r);
      }
      case '/api/apps/autostart': {
        const app = A.BY_ID[body.id];
        if (!app) throw new Error('Unknown app');
        await A.setAutoStart(app.id, !!body.on);
        const what = app.id === 'vscode' ? (body.on ? 'installed the Homebox extension (reload VS Code)' : 'removed the Homebox extension')
          : (body.on ? 'start the Homebox bridge automatically' : 'removed automatic start');
        H.addLog({ source: 'you', tool: 'apps', summary: `${app.name}: ${what}`, status: 'ok' });
        return send(res, 200, { ok: true });
      }
      case '/api/apps/obs': A.setObs(body); H.changed(); return send(res, 200, { ok: true });
      case '/api/mcp/rotate': config.mcpToken = token(); saveConfig(); H.changed(); return send(res, 200, { ok: true });
      case '/api/paste': {
        const actions = T.parseReply(body.text);
        if (!actions.length) return send(res, 200, { count: 0, reply: 'No ```homebox blocks found in that reply.' });
        const results = await T.runActions(actions, { source: 'paste' });
        return send(res, 200, { count: actions.length, reply: T.formatResults(results) });
      }
      case '/api/undo': await T.undo(body.id); return send(res, 200, { ok: true });
      case '/api/upload': return send(res, 200, await addUpload(body, 'you'));
      case '/api/quit': send(res, 200, { ok: true }); setTimeout(() => hooks.quit(), 200); return;
    }
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => { if (!res.headersSent) send(res, 400, { error: e.message }); else res.end(); });
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

// Is something already listening on this port, and is it Homebox?
function probe(port) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/ext/hello', timeout: 700 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).app === 'homebox' ? 'homebox' : 'other'); } catch { resolve('other'); } });
    });
    r.on('error', () => resolve('free'));
    r.on('timeout', () => { r.destroy(); resolve('other'); });
  });
}

// Returns { port } when listening, or { alreadyRunning: port } when another Homebox owns the port.
async function start(opts = {}) {
  Object.assign(hooks, opts);
  for (let port = BASE_PORT; port < BASE_PORT + 11; port++) {
    const s = await probe(port);
    if (s === 'homebox') return { alreadyRunning: port };
    if (s !== 'free') continue;
    PORT = port;
    const ok = await new Promise(resolve => { server.once('error', () => resolve(false)); server.listen(PORT, '127.0.0.1', () => resolve(true)); });
    if (ok) break;
  }
  if (!server.listening) throw new Error('Could not find a free port between 7777 and 7787.');
  H.addLog({ source: 'app', tool: 'start', summary: `Homebox ${VERSION} started on port ${PORT}`, status: 'ok' });
  // keep the VS Code extension in step with this version of Homebox (only if the user installed it)
  require('./vscode').updateIfOld()
    .then(v => { if (v) H.addLog({ source: 'app', tool: 'apps', summary: `VS Code: updated the Homebox extension to ${v}. Reload VS Code windows to use it.`, status: 'ok' }); })
    .catch(() => {});
  if (maya.upgraded) H.addLog({ source: 'app', tool: 'maya', summary: 'Maya: switched automatic start to the secure Homebox bridge. Restart Maya once.', status: 'ok' });
  return { port: PORT };
}

module.exports = { start, url: () => `http://127.0.0.1:${PORT}/` };

// Run without the desktop window (Start Homebox.cmd / node src/core/server.js).
if (require.main === module) {
  const { spawn } = require('child_process');
  const isWin = process.platform === 'win32';
  const openTarget = target => spawn(isWin ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // Windows folder picker, shown on top of the browser
  const pickFolder = () => new Promise(resolve => {
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the folder AI may work in'; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => resolve(out.trim() || null));
    child.on('error', () => resolve(null));
  });
  start({ openPath: openTarget, pickFolder: isWin ? pickFolder : null }).then(r => {
    const port = r.port || r.alreadyRunning;
    console.log(r.port ? `Homebox ${VERSION} running at http://127.0.0.1:${port}/` : `Homebox is already running on port ${port}`);
    if (process.env.HOMEBOX_OPEN) openTarget(`http://127.0.0.1:${port}/${process.env.HOMEBOX_OPEN === '1' ? '' : '#' + process.env.HOMEBOX_OPEN}`);
    if (r.alreadyRunning) process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
