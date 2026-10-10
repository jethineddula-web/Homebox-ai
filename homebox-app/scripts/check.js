// Release checks: npm run check
// 1. every JavaScript file parses, 2. the sandbox blocks known escape tricks, 3. the server's safety doors hold.
// Runs against a throwaway home folder, so your real Homebox settings are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const bad = msg => { failed++; console.log(`  ✗ ${msg}`); };

// ---------- 1. syntax ----------
console.log('Syntax');
const jsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(ROOT);
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  r.status === 0 ? null : bad(`${path.relative(ROOT, f)}: ${r.stderr.trim().split('\n').slice(0, 3).join(' ')}`);
}
ok(`${jsFiles.length} JavaScript files parse`);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
manifest.description.length <= 132 ? ok('extension description fits the Chrome Web Store limit') : bad(`extension description is ${manifest.description.length} characters (max 132)`);
const pkg = require(path.join(ROOT, 'package.json'));
manifest.version === pkg.version ? ok(`app and extension are both version ${pkg.version}`) : bad(`app is ${pkg.version} but extension is ${manifest.version}`);

console.log('Choosing an AI');
require(path.join(ROOT, 'extension', 'router.js'));
const RT = globalThis.HB_ROUTER;
RT.plan('what is the capital of France').site.id === 'chatgpt' && !RT.plan('what is the capital of France').computer ? ok('quick questions go to a chat, without computer access') : bad('quick question routed wrongly');
RT.plan('Make me a website for my bakery').computer ? ok('building tasks get computer access') : bad('a building task did not get computer access');
RT.plan('What are the latest phone prices today').site.id === 'perplexity' ? ok('latest-news questions go to a search AI') : bad('research question routed wrongly');
RT.plan('use gemini to write a poem').site.id === 'gemini' ? ok('"use Gemini" picks Gemini') : bad('naming an AI did not pick it');
RT.plan('tell me a joke', { skip: ['chatgpt'] }).site.id !== 'chatgpt' ? ok('AIs the user turned off are skipped') : bad('a turned-off AI was still picked');

// ---------- 2 & 3. live checks against a temporary Homebox ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'homebox-check-'));
const port = 7900 + Math.floor(Math.random() * 50);
const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), HOMEBOX_PORT: String(port) };
delete env.HOMEBOX_OPEN;
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'core', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Homebox': '1', ...headers }, body: JSON.stringify(body) });

(async () => {
  for (let i = 0; i < 50 && !serverOut.includes('running at'); i++) await sleep(100);
  if (!serverOut.includes('running at')) { bad(`test server did not start: ${serverOut.trim()}`); return finish(); }

  console.log('Sandbox');
  const ws = path.join(home, 'Homebox Workspace');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n');
  const B = '\\';
  const attempts = ['.env', '.env::$DATA', '.env ', '.env.', 'sub/../.env', `..${B}..${B}.homebox${B}config.json`, `C:${B}Windows${B}win.ini`, `${B}${B}localhost${B}c$${B}Windows${B}win.ini`, 'nul', '../outside.txt'];
  const block = '```homebox\n' + JSON.stringify(attempts.map(p => ({ tool: 'read_file', args: { path: p } }))) + '\n```';
  const reply = (await (await post('/api/paste', { text: block })).json()).reply || '';
  const parts = reply.split('\n---\n');
  attempts.forEach((a, i) => {
    const part = parts[i] || '';
    part.includes('→ ERROR') && !part.includes('SECRET=1') ? ok(`blocks ${JSON.stringify(a)}`) : bad(`did NOT block ${JSON.stringify(a)}: ${part.slice(0, 160)}`);
  });
  const good = (await (await post('/api/paste', { text: '```homebox\n{"tool":"read_file","args":{"path":"WELCOME.txt"}}\n```' })).json()).reply || '';
  good.includes('→ OK') ? ok('still reads normal files') : bad('cannot read a normal file in the sandbox');

  console.log('Doors');
  const panel = await fetch(base + '/');
  panel.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(panel.headers.get('content-security-policy') || '')
    ? ok('control panel cannot be framed by other sites') : bad('control panel can be framed (clickjacking)');
  (await fetch(base + '/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"paused":true}' })).status === 403
    ? ok('panel actions need the Homebox header') : bad('panel action worked without the Homebox header');
  (await post('/api/state', {}, { Origin: 'https://evil.example' })).status === 403 ? ok('web pages cannot use the panel API') : bad('a web page origin reached the panel API');
  (await fetch(base + '/ext/pair/request', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status === 403
    ? ok('web pages cannot ask to connect') : bad('a web page could start pairing');
  (await fetch(base + '/ext/info')).status === 401 ? ok('extension API needs a paired browser') : bad('extension API answered without pairing');
  (await fetch(base + '/mcp/wrong-token', { method: 'POST', body: '{}' })).status === 401 ? ok('MCP needs its secret link') : bad('MCP answered a wrong token');
  (await fetch(base + '/mcp/x', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status === 403 ? ok('web pages cannot use MCP') : bad('a web page reached MCP');
  const state = await (await fetch(base + '/api/state')).json();
  ['blender', 'photoshop', 'excel', 'obs', 'github'].every(id => state.policy[id] === 'off') && state.policy.exec === 'off' && state.policy.maya === 'off' && state.policy.browser === 'off' && state.fullAccess === false
    ? ok('apps, commands, browser control and Full access start turned off') : bad('something risky starts turned on');
  // the reply only comes after the approval, so don't wait for it here
  const write = post('/api/paste', { text: '```homebox\nwrite_file x.txt\nhi\n```' });
  await sleep(300);
  const pend = await (await fetch(base + '/api/state')).json();
  pend.pending.length === 1 ? ok('file changes wait for approval by default') : bad('a file change ran without approval');
  for (const p of pend.pending) await post('/api/decide', { id: p.id, approve: false });
  await write;

  console.log('Delete and undo');
  await post('/api/fullaccess', { on: true });  // so the steps below don't wait for approval
  fs.mkdirSync(path.join(ws, 'proj', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'proj', 'lib', 'a.js'), 'one');
  fs.writeFileSync(path.join(ws, 'proj', 'b.js'), 'two');
  const run = async block => (await (await post('/api/paste', { text: '```homebox\n' + block + '\n```' })).json()).reply || '';
  const del = await run('delete_path proj');
  !fs.existsSync(path.join(ws, 'proj')) && del.includes('→ OK') ? ok('deletes a folder when asked') : bad(`delete failed: ${del.slice(0, 200)}`);
  const entry = (await (await fetch(base + '/api/state')).json()).log.reverse().find(e => e.tool === 'delete_path' && e.undo);
  if (entry) await post('/api/undo', { id: entry.id });
  fs.existsSync(path.join(ws, 'proj', 'lib', 'a.js')) && fs.readFileSync(path.join(ws, 'proj', 'b.js'), 'utf8') === 'two'
    ? ok('Undo brings a deleted folder back exactly') : bad('Undo did not restore the deleted folder');
  (await run('delete_path .')).includes('→ ERROR') && fs.existsSync(path.join(ws, 'WELCOME.txt')) ? ok("can't delete the whole sandbox") : bad('the whole sandbox could be deleted');
  fs.mkdirSync(path.join(ws, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'keys', 'server.pem'), 'x');
  (await run('delete_path keys')).includes('protected') && fs.existsSync(path.join(ws, 'keys', 'server.pem')) ? ok('refuses folders holding protected files') : bad('deleted a folder with protected files');
  await post('/api/fullaccess', { on: false });

  console.log('Documents and browser');
  const { makeZip } = require(path.join(ROOT, 'src', 'core', 'zip.js'));
  fs.mkdirSync(path.join(ws, 'files'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'files', 'cv.docx'), makeZip({ 'word/document.xml': Buffer.from('<w:document><w:body><w:p><w:r><w:t>Jane Doe &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Lighting artist</w:t></w:r></w:p></w:body></w:document>') }));
  const doc = await run('read_document files/cv.docx');
  doc.includes('Jane Doe & Co') && doc.includes('Lighting artist') ? ok('reads Word documents') : bad(`could not read a .docx: ${doc.slice(0, 200)}`);
  await post('/api/policy', { browser: 'ask' });
  await post('/api/fullaccess', { on: true });
  (await run('browser_tabs')).includes('only work when the task was started from the Homebox panel') ? ok('browser tools refuse requests that did not come from a paired browser') : bad('browser tools answered without a browser');
  // act as a paired browser extension
  const pr = await (await fetch(base + '/ext/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Check browser"}' })).json();
  await post('/api/pair/decide', { id: pr.id, approve: true });
  const tok = (await (await fetch(`${base}/ext/pair/status?id=${pr.id}`)).json()).token;
  const ext = (p, body) => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  const { runId } = await ext('/ext/run', { actions: [{ tool: 'browser_fill', args: { tab: 5, fields: [{ el: 2, text: 'Jane' }] } }] });
  let st = await ext(`/ext/run/status?id=${runId}`);
  const cmd = (st.browser || [])[0];
  cmd && cmd.op === 'describe' ? ok('browser commands reach the paired browser') : bad(`no browser command was handed over: ${JSON.stringify(st).slice(0, 200)}`);
  if (cmd) await ext('/ext/browser/result', { id: cmd.id, ok: true, data: { site: 'jobs.example', title: 'Apply', labels: { 2: 'First name (input text)' } } });
  await sleep(200);
  st = await ext(`/ext/run/status?id=${runId}`);
  const ask = (st.pending || [])[0];
  ask && /First name/.test(ask.preview || '') ? ok('typing in a browser still asks, even with Full access, and shows the real field names') : bad(`browser typing did not ask under Full access: ${JSON.stringify(st).slice(0, 200)}`);
  if (ask) await ext('/ext/decide', { id: ask.id, approve: false });
  await post('/api/policy', { browser: 'auto' });
  const auto = await ext('/ext/run', { actions: [{ tool: 'browser_scroll', args: { tab: 5 } }] });
  let as = await ext(`/ext/run/status?id=${auto.runId}`);
  ((as.browser || [])[0] || {}).op === 'scroll' && !(as.pending || []).length ? ok('with browser control on Automatic, steps go straight to the browser without asking') : bad(`Automatic browser control still asked: ${JSON.stringify(as).slice(0, 200)}`);
  if ((as.browser || [])[0]) await ext('/ext/browser/result', { id: as.browser[0].id, ok: true, data: { ok: true } });
  await post('/api/policy', { browser: 'ask' });
  for (let i = 0; i < 20 && !st.done; i++) { await sleep(100); st = await ext(`/ext/run/status?id=${runId}`); }
  !(st.browser || []).some(c => c.op === 'fill') && /denied/.test(st.text || '') ? ok('a denied browser step is never sent to the browser') : bad('a denied browser step still went to the browser');
  const cards = await ext('/ext/run', { actions: [{ tool: 'show_copy_text', args: { title: 'LinkedIn profile', fields: [{ label: 'Headline', text: 'Lighting artist' }] } }] });
  let cs = {};
  for (let i = 0; i < 20 && !cs.done; i++) { await sleep(100); cs = await ext(`/ext/run/status?id=${cards.runId}`); }
  (cs.cards || []).length === 1 && cs.cards[0].fields[0].text === 'Lighting artist' ? ok('copy boxes reach the browser panel') : bad('copy boxes did not arrive');
  await post('/api/policy', { github: 'ask' });
  fs.mkdirSync(path.join(ws, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'projects', 'demo', 'main.py'), 'print(1)\n');
  const root = await run('{"tool":"github_publish","args":{"folder":".","name":"everything","message":"x"}}');
  root.includes('never the whole AI folder') ? ok('GitHub refuses to publish the whole AI folder') : bad(`GitHub publish of the whole AI folder was not refused: ${root.slice(0, 200)}`);
  await post('/api/fullaccess', { on: false });
  finish();
})().catch(e => { bad(e.stack || e.message); finish(); });

function finish() {
  server.kill();
  setTimeout(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
  }, 300);
}
