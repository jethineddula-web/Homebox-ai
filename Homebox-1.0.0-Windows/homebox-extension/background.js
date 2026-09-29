// Homebox extension — background service worker.
// Talks to the Homebox app on 127.0.0.1. Content scripts never touch the network themselves.
const PORTS = Array.from({ length: 11 }, (_, i) => 7777 + i);
let base = null;

async function hello(b, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 900);
  try {
    const r = await fetch(`${b}/ext/hello`, { signal: ctl.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const j = await r.json();
    return j.app === 'homebox' ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}
async function findApp(token) {
  if (base) { const h = await hello(base, token); if (h) return { base, ...h }; }
  const { lastPort } = await chrome.storage.local.get('lastPort');
  const order = lastPort ? [lastPort, ...PORTS.filter(p => p !== lastPort)] : PORTS;
  for (const p of order) {
    const b = `http://127.0.0.1:${p}`;
    const h = await hello(b, token);
    if (h) { base = b; chrome.storage.local.set({ lastPort: p }); return { base, ...h }; }
  }
  base = null;
  return null;
}
async function getToken() { return (await chrome.storage.local.get('token')).token || null; }

async function api(pathname, body) {
  const token = await getToken();
  const app = await findApp(token);
  if (!app) throw Object.assign(new Error('The Homebox app is not running on this computer.'), { code: 'no_app' });
  const r = await fetch(app.base + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) { await chrome.storage.local.remove('token'); throw Object.assign(new Error('This browser is not connected to Homebox yet.'), { code: 'unpaired' }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Homebox error ${r.status}`);
  return j;
}

async function status() {
  const token = await getToken();
  const app = await findApp(token);
  if (!app) return { app: false };
  if (!token || !app.paired) return { app: true, paired: false, version: app.version };
  const info = await api('/ext/info');
  return { app: true, paired: true, version: app.version, info };
}

let pairing = null;
async function startPair() {
  const app = await findApp(null);
  if (!app) throw new Error('Open the Homebox app first.');
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
  let { installId } = await chrome.storage.local.get('installId');
  if (!installId) { installId = crypto.randomUUID(); await chrome.storage.local.set({ installId }); }
  const r = await fetch(`${app.base}/ext/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${browser} on ${os}`, installId }) }).then(x => x.json());
  pairing = { id: r.id, code: r.code, base: app.base, status: 'waiting' };
  pollPair();
  return { code: r.code };
}
async function pollPair() {
  const started = Date.now();
  while (pairing && pairing.status === 'waiting' && Date.now() - started < 10 * 60_000) {
    await new Promise(r => setTimeout(r, 1200));
    try {
      const r = await fetch(`${pairing.base}/ext/pair/status?id=${pairing.id}`).then(x => x.json());
      if (r.status === 'approved') { await chrome.storage.local.set({ token: r.token }); pairing.status = 'approved'; broadcastStatus(); }
      else if (r.status !== 'waiting') { pairing.status = r.status; broadcastStatus(); }
    } catch {}
  }
}
async function broadcastStatus() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'statusChanged' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'status': return { ...(await status()), pairing: pairing && { code: pairing.code, status: pairing.status } };
      case 'pair': return startPair();
      case 'disconnect': await chrome.storage.local.remove('token'); broadcastStatus(); return { ok: true };
      case 'run': return api('/ext/run', { actions: msg.actions, site: sender.tab ? new URL(sender.tab.url).hostname : msg.site, step: msg.step });
      case 'runStatus': return api(`/ext/run/status?id=${encodeURIComponent(msg.runId)}`);
      case 'decide': return api('/ext/decide', { id: msg.id, approve: msg.approve });
      case 'stop': return api('/ext/stop', {});
      case 'openApp': { const app = await findApp(await getToken()); if (app) chrome.tabs.create({ url: app.base + '/' }); return { ok: !!app }; }
      case 'enableSite': return enableSite(msg.origin, msg.tabId);
      case 'siteEnabled': return { enabled: await isSiteEnabled(msg.origin) };
      default: return { error: 'unknown message' };
    }
  })().then(r => sendResponse({ ok: true, data: r }), e => sendResponse({ ok: false, error: e.message, code: e.code }));
  return true;
});

// ---- extra sites the user turns on from the popup ----
const scriptId = origin => 'hb-' + origin.replace(/[^a-z0-9]/gi, '_');
async function isSiteEnabled(origin) {
  const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId(origin)] }).catch(() => []);
  return regs.length > 0;
}
async function enableSite(origin, tabId) {
  const id = scriptId(origin);
  if (!(await isSiteEnabled(origin))) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  }
  if (tabId) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  return { enabled: true };
}

chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?welcome=1') });
});
