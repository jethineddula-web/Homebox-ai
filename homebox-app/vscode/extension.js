// Homebox for VS Code: a small bridge so the Homebox app can see what you're working on.
// It listens on 127.0.0.1 only (ports 7018-7027, one per VS Code window) and every request must carry
// the secret from ~/.homebox/bridge_token. It only reports files inside the folder Homebox sends
// (your sandbox), and it never edits code itself: Homebox does that, with your approval.
const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const FIRST_PORT = 7018, LAST_PORT = 7027;
const isWin = process.platform === 'win32';
let server = null, port = null, statusItem = null, lastFocused = Date.now();

function homeboxDir() {
  const base = process.env.USERPROFILE || os.homedir();
  return path.join(base, '.homebox');
}
function readToken() {
  try { return fs.readFileSync(path.join(homeboxDir(), 'bridge_token'), 'utf8').trim(); } catch { return ''; }
}
function tokenOk(given) {
  const want = readToken();
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Is this file inside the sandbox folder Homebox sent? (Windows paths are not case-sensitive.)
function inside(file, root) {
  if (!root) return false;
  const rel = path.relative(root, file);
  if (!rel) return true;
  const bad = rel.startsWith('..') || path.isAbsolute(rel);
  return !bad;
}
const relTo = (file, root) => path.relative(root, file).split(path.sep).join('/') || '.';
const SEVERITY = ['error', 'warning', 'info', 'hint'];

function folders() { return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath); }

function info(root) {
  const ed = vscode.window.activeTextEditor;
  const tabs = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file');
  const openFiles = tabs.filter(d => inside(d.uri.fsPath, root)).map(d => ({ path: relTo(d.uri.fsPath, root), unsaved: d.isDirty }));
  let active = null;
  if (ed && ed.document.uri.scheme === 'file') {
    if (inside(ed.document.uri.fsPath, root)) {
      const sel = ed.selection;
      const text = ed.document.getText(sel);
      active = {
        path: relTo(ed.document.uri.fsPath, root), language: ed.document.languageId, unsaved: ed.document.isDirty,
        cursorLine: sel.active.line + 1,
        selection: sel.isEmpty ? null : { fromLine: sel.start.line + 1, toLine: sel.end.line + 1, text: text.length > 8000 ? text.slice(0, 8000) + '\n…[selection cut]' : text },
      };
    } else active = { outsideSandbox: true };
  }
  const diags = vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && inside(uri.fsPath, root));
  let errors = 0, warnings = 0;
  for (const [, list] of diags) for (const d of list) { if (d.severity === 0) errors++; else if (d.severity === 1) warnings++; }
  return {
    vscode: vscode.version, sandboxOpenInThisWindow: folders().some(f => inside(f, root) || inside(root, f)),
    activeFile: active, openFiles, otherOpenFiles: tabs.length - openFiles.length, problems: { errors, warnings },
  };
}

function problems(root, onlyPath) {
  const out = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file' || !inside(uri.fsPath, root)) continue;
    const rel = relTo(uri.fsPath, root);
    if (onlyPath && rel !== onlyPath) continue;
    for (const d of list) {
      if (d.severity > 1) continue;  // errors and warnings only
      out.push({ file: rel, line: d.range.start.line + 1, column: d.range.start.character + 1, severity: SEVERITY[d.severity], message: d.message, source: d.source || '' });
      if (out.length >= 300) return out;
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

async function openFile(abs, line, root) {
  if (!inside(abs, root)) throw new Error('That file is outside the sandbox folder.');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const ln = Math.max(0, Math.min(doc.lineCount - 1, (Number(line) || 1) - 1));
  const range = new vscode.Range(ln, 0, ln, 0);
  await vscode.window.showTextDocument(doc, { selection: range, preview: false });
  return `Opened ${relTo(abs, root)} at line ${ln + 1}`;
}

async function handle(req) {
  if (!tokenOk(req.token)) return { ok: false, output: 'Homebox bridge: wrong secret.' };
  const root = typeof req.root === 'string' ? req.root : '';
  switch (req.op) {
    case 'ping': return { ok: true, app: 'vscode', version: vscode.version, folders: folders(), lastFocused, focused: vscode.window.state.focused };
    case 'info': return { ok: true, output: JSON.stringify(info(root), null, 2) };
    case 'problems': {
      const list = problems(root, req.path || null);
      return { ok: true, output: list.length ? list.map(p => `${p.file}:${p.line}:${p.column} ${p.severity}: ${p.message}${p.source ? ` (${p.source})` : ''}`).join('\n') : 'No errors or warnings in the sandbox folder.' };
    }
    case 'open': return { ok: true, output: await openFile(String(req.abs || ''), req.line, root) };
    default: return { ok: false, output: `Unknown request: ${req.op}` };
  }
}

function serve(conn) {
  conn.setTimeout(15000, () => conn.destroy());
  let data = '';
  conn.on('data', chunk => {
    data += chunk;
    if (data.length > 1_000_000) return conn.destroy();
    const nl = data.indexOf('\n');
    if (nl < 0) return;
    let req;
    try { req = JSON.parse(data.slice(0, nl)); } catch { conn.end(JSON.stringify({ ok: false, output: 'Bad request' }) + '\n'); return; }
    Promise.resolve(handle(req))
      .catch(e => ({ ok: false, output: `VS Code: ${e.message}` }))
      .then(res => conn.end(JSON.stringify(res) + '\n'));
  });
  conn.on('error', () => {});
}

function listen(p) {
  if (p > LAST_PORT) { port = null; updateStatus(); return; }
  const s = net.createServer(serve);
  s.once('error', () => listen(p + 1));  // another VS Code window has this port
  s.listen(p, '127.0.0.1', () => { server = s; port = p; updateStatus(); });
}

// ---------- talking to the Homebox app (ports 7777-7787, or from HOMEBOX_PORT like the app itself) ----------
const HB_FIRST = Number(process.env.HOMEBOX_PORT) || 7777;
let homeboxPort = null;
let sandboxState = { running: false, active: null, list: [] };
const norm = p => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return isWin ? r.toLowerCase() : r; };
const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

function request(p, method, pathname, body) {
  return new Promise(resolve => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${p}`, 'X-Homebox': '1' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: p, path: pathname, method, timeout: 3000, headers }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(out); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end(data || undefined);
  });
}
// Find Homebox (cached port first) and read which folder the AI works in.
async function fetchSandbox() {
  const ports = homeboxPort ? [homeboxPort] : [];
  for (let p = HB_FIRST; p <= HB_FIRST + 10; p++) if (p !== homeboxPort) ports.push(p);
  for (const p of ports) {
    const r = await request(p, 'GET', '/api/sandbox');
    if (r && r.status === 200 && r.body.app === 'homebox') { homeboxPort = p; return { running: true, active: r.body.active, list: r.body.list || [] }; }
  }
  homeboxPort = null;
  return { running: false, active: null, list: [] };
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { sandboxState = await fetchSandbox(); } finally { refreshing = false; }
  updateStatus();
}

// The status bar shows this window's relation to Homebox; one click switches the AI to this folder.
function updateStatus() {
  if (!statusItem) return;
  const fs_ = folders();
  const here = fs_.find(f => samePath(f, sandboxState.active) || (sandboxState.active && inside(sandboxState.active, f)));
  let text, tip, cmd = 'homebox.status';
  if (!port) { text = '$(warning) Homebox'; tip = 'Homebox: no free port (too many VS Code windows).'; }
  else if (!sandboxState.running) { text = '$(circle-slash) Homebox: not running'; tip = 'Open the Homebox app to let AI work in this window.'; }
  else if (!fs_.length) { text = '$(home) Homebox: open a folder'; tip = 'Open a folder (File → Open Folder) to let AI work here.'; }
  else if (here) { text = '$(check) Homebox: AI works here'; tip = `AI works in ${sandboxState.active}`; }
  else {
    text = '$(arrow-swap) Homebox: use this folder';
    tip = `AI works in "${path.basename(sandboxState.active || '') || 'another folder'}". Click to switch the AI to this window's folder.`;
    cmd = 'homebox.useFolder';
  }
  statusItem.text = text;
  statusItem.tooltip = tip;
  statusItem.command = cmd;
  statusItem.show();
}

async function useFolder() {
  const fs_ = folders();
  if (!fs_.length) { vscode.window.showWarningMessage('Open a folder in VS Code first (File → Open Folder).'); return; }
  const pick = fs_.length === 1 ? fs_[0] : await vscode.window.showQuickPick(fs_, { placeHolder: 'Which folder may the AI work in?' });
  if (!pick) return;
  sandboxState = await fetchSandbox();
  if (!sandboxState.running) { vscode.window.showErrorMessage('Homebox is not running. Open the Homebox app and try again.'); updateStatus(); return; }
  // A folder you already approved switches straight away; a new one asks once.
  const known = sandboxState.list.find(w => samePath(w, pick));
  let r;
  if (known) r = await request(homeboxPort, 'POST', '/api/workspace/select', { path: known });
  else {
    const ok = await vscode.window.showWarningMessage(`Let AI from Homebox work in "${path.basename(pick)}"? It can read files there and, with your approval, change them.`, { modal: true }, 'Use this folder');
    if (ok !== 'Use this folder') return;
    r = await request(homeboxPort, 'POST', '/api/workspace/add', { path: pick });
  }
  if (!r) vscode.window.showErrorMessage('Homebox stopped answering. Is it still running?');
  else if (r.status !== 200) vscode.window.showErrorMessage(`Homebox: ${r.body.error || 'could not use that folder.'}`);
  else vscode.window.setStatusBarMessage(`$(check) Homebox: AI now works in "${path.basename(pick)}". Start a new chat for a new task.`, 6000);
  await refresh();
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.command = 'homebox.status';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.window.onDidChangeWindowState(s => { if (s.focused) { lastFocused = Date.now(); refresh(); } }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('homebox.useFolder', useFolder));
  context.subscriptions.push(vscode.commands.registerCommand('homebox.openApp', () => vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${homeboxPort || HB_FIRST}/#apps/vscode`))));
  context.subscriptions.push(vscode.commands.registerCommand('homebox.status', async () => {
    await refresh();
    const items = [];
    if (folders().length) items.push({ label: '$(folder) Use this folder as the AI sandbox', id: 'use' });
    items.push({ label: '$(home) Open the Homebox app', id: 'app' });
    const where = sandboxState.running ? `AI works in: ${sandboxState.active || 'no folder yet'}` : 'Homebox is not running';
    const choice = await vscode.window.showQuickPick(items, { placeHolder: where });
    if (choice && choice.id === 'use') useFolder();
    if (choice && choice.id === 'app') vscode.commands.executeCommand('homebox.openApp');
  }));
  updateStatus();
  listen(FIRST_PORT);
  refresh();
  // keep the status current: often while this window is in front, now and then otherwise
  const timer = setInterval(() => { if (vscode.window.state.focused || Date.now() % 15000 < 4000) refresh(); }, 4000);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); if (server) server.close(); } });
}

function deactivate() { if (server) server.close(); }

module.exports = { activate, deactivate };
