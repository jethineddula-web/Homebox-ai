// Homebox extension — background service worker.
// Talks to the Homebox app on 127.0.0.1. Content scripts never touch the network themselves.
importScripts('router.js');
const PORTS = Array.from({ length: 11 }, (_, i) => 7777 + i);
let base = null;

async function hello(b, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 700);
  try {
    const r = await fetch(`${b}/ext/hello`, { signal: ctl.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const j = await r.json();
    return j.app === 'homebox' ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}
async function findApp(token) {
  if (base) { const h = await hello(base, token); if (h) return { base, ...h }; }
  // ask every port at once instead of one by one (was up to 10 s when the app was closed)
  const found = await Promise.all(PORTS.map(async p => {
    const b = `http://127.0.0.1:${p}`;
    const h = await hello(b, token);
    return h ? { p, b, h } : null;
  }));
  const hit = found.find(Boolean);
  if (hit) { base = hit.b; chrome.storage.local.set({ lastPort: hit.p }); return { base, ...hit.h }; }
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

// The pairing request is saved, because Chrome stops this worker after ~30 s without events
// (for example while the user switches to the Homebox window to click Approve).
let pairing = null;
async function loadPairing() {
  if (!pairing) { try { pairing = (await chrome.storage.session.get('pairing')).pairing || null; } catch {} }
  return pairing;
}
function savePairing() { try { chrome.storage.session.set({ pairing }); } catch {} }
async function checkPair() {
  if (!pairing || pairing.status !== 'waiting') return;
  if (Date.now() - pairing.started > 10 * 60_000) { pairing.status = 'expired'; savePairing(); return; }
  try {
    const r = await fetch(`${pairing.base}/ext/pair/status?id=${encodeURIComponent(pairing.id)}`).then(x => x.json());
    if (r.status === 'approved' && r.token) { await chrome.storage.local.set({ token: r.token }); pairing.status = 'approved'; savePairing(); broadcastStatus(); }
    else if (r.status !== 'waiting') { pairing.status = r.status; savePairing(); broadcastStatus(); }
  } catch {}
}
async function startPair() {
  const app = await findApp(null);
  if (!app) throw new Error('Open the Homebox app first.');
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
  let { installId } = await chrome.storage.local.get('installId');
  if (!installId) { installId = crypto.randomUUID(); await chrome.storage.local.set({ installId }); }
  const res = await fetch(`${app.base}/ext/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${browser} on ${os}`, installId }) });
  const r = await res.json().catch(() => ({}));
  if (!res.ok || !r.id) throw new Error(r.error || 'Homebox did not accept the connection request.');
  pairing = { id: r.id, code: r.code, base: app.base, status: 'waiting', started: Date.now() };
  savePairing();
  pollPair();
  return { code: r.code };
}
async function pollPair() {
  while (pairing && pairing.status === 'waiting') {
    await new Promise(r => setTimeout(r, 1200));
    await checkPair();
  }
}
async function broadcastStatus() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'statusChanged' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'status': {
        selfUpdate();
        await loadPairing();
        await checkPair();  // finishes a pairing even if this worker was restarted meanwhile
        return { ...(await status()), pairing: pairing && { code: pairing.code, status: pairing.status } };
      }
      case 'pair': return startPair();
      case 'disconnect': await chrome.storage.local.remove('token'); broadcastStatus(); return { ok: true };
      case 'run': return api('/ext/run', { actions: msg.actions, site: sender.tab ? new URL(sender.tab.url).hostname : msg.site, step: msg.step });
      case 'runStatus': {
        const j = await api(`/ext/run/status?id=${encodeURIComponent(msg.runId)}`);
        if (j.browser && j.browser.length) runBrowser(j.browser);  // tab commands the AI asked for (already approved by the user)
        delete j.browser;
        return j;
      }
      case 'decide': return api('/ext/decide', { id: msg.id, approve: msg.approve });
      case 'stop': return api('/ext/stop', {});
      case 'upload': return api('/ext/upload', { name: String(msg.name || ''), data: String(msg.data || '') });
      case 'openApp': { const app = await findApp(await getToken()); if (app) chrome.tabs.create({ url: app.base + '/' }); return { ok: !!app }; }
      case 'enableSite':
        // only the toolbar popup may turn Homebox on for a new site, never a script on a web page
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        if (!/^https?:\/\/[^/]+$/.test(String(msg.origin))) throw new Error('Bad site address.');
        return enableSite(msg.origin, msg.tabId);
      case 'siteEnabled': return { enabled: await isSiteEnabled(msg.origin) };
      case 'siteKind': return { chat: sender.tab ? await isChatTab(sender.tab) : false };
      case 'frontFor': {
        // an AI tab in the background can't press Send: show it for a moment, then go back
        if (!sender.tab || !(await isChatTab(sender.tab))) throw new Error('Not allowed.');
        const [prev] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
        frontPrev[sender.tab.id] = prev && prev.id !== sender.tab.id ? prev.id : null;
        await chrome.tabs.update(sender.tab.id, { active: true });
        return { ok: true };
      }
      case 'frontDone': {
        if (!sender.tab) return null;
        const prev = frontPrev[sender.tab.id];
        delete frontPrev[sender.tab.id];
        if (prev) {
          const [cur] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
          if (cur && cur.id === sender.tab.id) await chrome.tabs.update(prev, { active: true }).catch(() => {});
        }
        return { ok: true };
      }
      case 'siteControlStatus': {
        if (!sender.tab) return null;
        let u; try { u = new URL(sender.tab.url); } catch { return { never: 'Homebox can only work on normal web pages.' }; }
        return { allowed: (await canControl(sender.tab.url)).ok, never: neverReason(u.hostname) || '' };
      }
      case 'siteControl': {
        // the panel's own button on this page (a trusted click inside Homebox's sealed panel)
        if (!sender.tab) throw new Error('Not allowed.');
        const u = new URL(sender.tab.url);
        if (!/^https?:$/.test(u.protocol)) throw new Error('Homebox can only work on normal web pages.');
        if (neverReason(u.hostname)) throw new Error(neverReason(u.hostname));
        if (msg.on && !(await chrome.permissions.contains({ origins: [`${u.origin}/*`] }))) throw new Error('Allow it from the Homebox button in the browser toolbar: click it on this page, then "Let AI control this site".');
        const list = (await controlSites()).filter(o => o !== u.origin);
        if (msg.on) list.push(u.origin);
        await chrome.storage.local.set({ controlSites: list });
        if (msg.on) tellAllowed(u.origin);
        return { allowed: !!msg.on, never: '' };
      }
      case 'everywhere': {
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        return setEverywhere(!!msg.on);
      }
      case 'everywhereStatus': return { on: await everywhereOn() };
      case 'activity': return sender.tab ? onActivity(sender.tab.id, String(msg.state || '')) : null;
      case 'openPopup': { let opened = false; try { await chrome.action.openPopup(); opened = true; } catch {} return { opened }; }
      case 'focusTab': {
        // only an AI tab Homebox opened for a task
        const h = await handoffs(), id = Number(msg.tabId);
        if (!h[id] && !(id in activityByTab)) throw new Error('Unknown tab.');
        const t = await getTab(id);
        await chrome.tabs.update(id, { active: true }); await chrome.windows.update(t.windowId, { focused: true });
        return { ok: true };
      }
      case 'showPanel':
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        return { shown: await ensurePanel(Number(msg.tabId)) };
      case 'rememberGrant': {
        // Chrome's "Allow access?" prompt can close the popup before it hears the answer, so the worker finishes the job
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        if (msg.kind === 'everywhere') { const g = (await chrome.storage.session.get('grants')).grants || {}; g.everywhere = { kind: 'everywhere', at: Date.now() }; await chrome.storage.session.set({ grants: g }); return { ok: true }; }
        if (!/^https?:\/\/[^/]+$/.test(String(msg.origin)) || !['chat', 'control'].includes(msg.kind)) throw new Error('Bad request.');
        const g = (await chrome.storage.session.get('grants')).grants || {};
        g[msg.origin] = { kind: msg.kind, tabId: Number(msg.tabId) || null, at: Date.now() };
        await chrome.storage.session.set({ grants: g });
        return { ok: true };
      }
      case 'removeSite': {
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        await chrome.scripting.unregisterContentScripts({ ids: [scriptId(String(msg.origin))] }).catch(() => {});
        if (msg.tabId) chrome.tabs.sendMessage(Number(msg.tabId), { type: 'removeWidget' }).catch(() => {});
        if (!(await controlSites()).includes(msg.origin)) await chrome.permissions.remove({ origins: [`${msg.origin}/*`] }).catch(() => {});
        return { ok: true };
      }
      case 'routeFromPage': {
        // the Ask AI box in the small Homebox panel on a normal site (only Homebox's own panel can send this)
        if (!sender.tab) throw new Error('Not allowed.');
        const site = HB_ROUTER.byId(String(msg.site || '')) ? String(msg.site) : '';
        await chrome.storage.local.set({ pageAiChoice: site });
        return route(String(msg.text || ''), { srcTab: sender.tab, stay: msg.stay !== false, computer: msg.computer, forced: site });
      }
      case 'aiList':
        return { sites: HB_ROUTER.SITES.map(s => ({ id: s.id, name: s.name })), choice: (await chrome.storage.local.get('pageAiChoice')).pageAiChoice || '' };
      case 'handoffMove': {
        // "Move to another AI" in the small panel on the page the task came from
        const h = await handoffs(), id = Number(msg.aiTab);
        if (!sender.tab || !h[id] || h[id].src !== sender.tab.id) throw new Error('This task is no longer running. Send it again.');
        await handoffSwitch(id, String(msg.site || ''));
        const nh = await handoffs();
        const moved = Object.entries(nh).find(([, x]) => x.src === sender.tab.id && x.site === msg.site && x.state === 'opening');
        return { tabId: moved ? Number(moved[0]) : id, site: (HB_ROUTER.byId(msg.site) || {}).name };
      }
      case 'aiLogin': {
        const k = (await chrome.storage.local.get('aiNeedsLogin')).aiNeedsLogin || {};
        if (msg.needs) k[msg.site] = Date.now(); else delete k[msg.site];
        await chrome.storage.local.set({ aiNeedsLogin: k });
        return { ok: true };
      }
      case 'route':
        // only the popup (or the address bar) may open a new AI tab with a task, never a web page
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        return route(String(msg.text || ''), { forced: msg.forced, computer: msg.computer, stay: msg.stay });
      case 'handoff': return sender.tab ? handoffFor(sender.tab) : null;
      case 'handoffState': return sender.tab ? setHandoff(sender.tab.id, { state: String(msg.state || '') }) : null;
      case 'handoffFail': return sender.tab ? handoffNext(sender.tab.id, String(msg.reason || '')) : null;
      case 'handoffSwitch': return sender.tab ? handoffSwitch(sender.tab.id, String(msg.site || '')) : null;
      case 'handoffCancel': return sender.tab ? dropHandoff(sender.tab.id) : null;
      case 'controlStatus': {
        let host = '';
        try { host = new URL(msg.origin).hostname; } catch {}
        return { allowed: (await controlSites()).includes(msg.origin), never: neverReason(host) };
      }
      case 'controlSite': {
        // only the toolbar popup may let the AI control a site, never a script on a web page
        if (sender.tab || sender.id !== chrome.runtime.id) throw new Error('Not allowed from a web page.');
        if (!/^https?:\/\/[^/]+$/.test(String(msg.origin))) throw new Error('Bad site address.');
        if (neverReason(new URL(msg.origin).hostname)) throw new Error(neverReason(new URL(msg.origin).hostname));
        const list = (await controlSites()).filter(o => o !== msg.origin);
        if (msg.on) list.push(msg.origin);
        await chrome.storage.local.set({ controlSites: list });
        if (msg.on) { tellAllowed(msg.origin); for (const t of await chrome.tabs.query({})) { try { if (new URL(t.url).origin === msg.origin) showIcon(t); } catch {} } }
        return { allowed: !!msg.on };
      }
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
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['router.js', 'askbox.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  }
  if (tabId) await chrome.scripting.executeScript({ target: { tabId }, files: ['router.js', 'askbox.js', 'content.js'] }).catch(() => {});
  return { enabled: true };
}

// keyboard shortcut (Alt+Shift+H by default): show or hide the panel on the current page
// on an AI site it shows the panel; on any other page it opens the popup with the Ask AI box
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let shown = false;
  if (tab) { try { shown = !!(await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' })); } catch {} }
  if (!shown && tab && await isChatTab(tab)) shown = await ensurePanel(tab.id);
  if (!shown && chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
});
async function isChatTab(tab) {
  let u;
  try { u = new URL(tab.url); } catch { return false; }
  return !!HB_ROUTER.byHost(u.hostname) || CHAT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)) || isSiteEnabled(u.origin);
}
// open the panel; if the page has no working Homebox (tab opened before the extension was reloaded), add it first
async function ensurePanel(tabId) {
  try { if (await chrome.tabs.sendMessage(tabId, { type: 'openPanel' })) return true; } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['router.js', 'askbox.js', 'content.js'] });
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { if (await chrome.tabs.sendMessage(tabId, { type: 'openPanel' })) return true; } catch {}
    }
  } catch {}
  return false;
}
// a chat whose AI was told "this site isn't allowed yet" can carry on as soon as the user allows it
async function tellAllowed(origin) {
  const host = new URL(origin).hostname;
  for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, { type: 'siteAllowed', host }).catch(() => {});
}
const frontPrev = {};

// "Show the Homebox icon on every site": a content script for all pages (it stays a small icon on normal sites)
const EVERYWHERE = ['https://*/*', 'http://*/*'];
async function everywhereOn() { return (await chrome.scripting.getRegisteredContentScripts({ ids: ['hbx-everywhere'] }).catch(() => [])).length > 0; }
async function setEverywhere(on) {
  if (!on) { await chrome.scripting.unregisterContentScripts({ ids: ['hbx-everywhere'] }).catch(() => {}); return { on: false }; }
  if (!(await chrome.permissions.contains({ origins: EVERYWHERE }))) throw new Error('Allow access to all sites first.');
  if (!(await everywhereOn())) await chrome.scripting.registerContentScripts([{ id: 'hbx-everywhere', matches: EVERYWHERE, js: ['router.js', 'askbox.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  for (const t of await chrome.tabs.query({})) if (/^https?:/.test(t.url || '')) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['router.js', 'askbox.js', 'content.js'] }).catch(() => {});
  return { on: true };
}

chrome.permissions.onAdded.addListener(async p => {
  const g = (await chrome.storage.session.get('grants')).grants || {};
  let changed = false;
  if (g.everywhere && (p.origins || []).some(o => EVERYWHERE.includes(o)) && Date.now() - g.everywhere.at < 10 * 60_000) { delete g.everywhere; changed = true; await setEverywhere(true).catch(() => {}); }
  for (const pattern of p.origins || []) {
    const origin = pattern.replace(/\/\*$/, '');
    const x = g[origin];
    if (!x || Date.now() - x.at > 10 * 60_000) continue;
    delete g[origin]; changed = true;
    if (x.kind === 'chat') { await enableSite(origin, x.tabId).catch(() => {}); if (x.tabId) ensurePanel(x.tabId); }
    else if (!neverReason(new URL(origin).hostname)) {
      const list = (await controlSites()).filter(o => o !== origin);
      list.push(origin);
      await chrome.storage.local.set({ controlSites: list });
      tellAllowed(origin);
    }
  }
  if (changed) await chrome.storage.session.set({ grants: g });
});

chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?welcome=1') });
  cleanOldSites();
});

// Before 2.0, every non-AI page showed "Enable Homebox here", which really meant "this is an AI chat site",
// so sites like YouTube were added by mistake. Remove those once; real AI sites are built in, and others can be re-added.
async function cleanOldSites() {
  if ((await chrome.storage.local.get('sitesCleaned2')).sitesCleaned2) return;
  const regs = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const ours = regs.filter(r => r.id.startsWith('hb-'));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map(r => r.id) }).catch(() => {});
  const keep = new Set(await controlSites());
  const origins = ours.flatMap(r => r.matches || []).map(m => m.replace(/\/\*$/, '')).filter(o => !keep.has(o));
  if (origins.length) await chrome.permissions.remove({ origins: origins.map(o => `${o}/*`) }).catch(() => {});
  for (const t of await chrome.tabs.query({})) if (!(await isChatTab(t))) chrome.tabs.sendMessage(t.id, { type: 'removeWidget' }).catch(() => {});
  await chrome.storage.local.set({ sitesCleaned2: true });
}

// ---- browser tabs: commands from the Homebox app while a task runs ----
// The AI may only read and control tabs on sites the user allowed in the popup. Some sites are never controlled.
const CHAT_HOSTS = (chrome.runtime.getManifest().content_scripts || []).flatMap(c => c.matches)
  .map(m => (m.match(/^https?:\/\/([^/]+)/) || [])[1]).filter(Boolean).map(h => h.replace(/^\*\./, ''));
function neverReason(host) {
  host = String(host || '').toLowerCase();
  const is = d => host === d || host.endsWith('.' + d);
  if (is('linkedin.com') || is('lnkd.in')) return 'LinkedIn does not allow tools to automate its website, so Homebox never controls it. Write the text and show it with show_copy_text, so the user can paste it into LinkedIn.';
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) return 'Homebox never controls its own app.';
  if (is('chromewebstore.google.com') || host === 'chrome.google.com' || is('accounts.google.com') || is('login.microsoftonline.com') || is('login.live.com')) return 'Homebox never controls sign-in pages or the extension store.';
  if (CHAT_HOSTS.some(is)) return 'This is an AI chat site. Homebox does not control AI chat sites.';
  return '';
}
async function controlSites() { return (await chrome.storage.local.get('controlSites')).controlSites || []; }
async function canControl(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, why: 'This tab has no web page open.' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: 'Homebox can only control normal web pages.' };
  const never = neverReason(u.hostname);
  if (never) return { ok: false, why: never, never: true };
  if (!(await controlSites()).includes(u.origin) || !(await chrome.permissions.contains({ origins: [`${u.origin}/*`] }))) {
    return { ok: false, why: `The user hasn't allowed Homebox to control ${u.hostname}. Ask them to open that site, click the Homebox button in the browser toolbar, and turn on "Let AI control this site".` };
  }
  return { ok: true };
}
async function getTab(id) {
  try { return await chrome.tabs.get(Number(id)); } catch { throw new Error(`Tab ${id} is not open. Use browser_tabs to see the open tabs.`); }
}
async function controlledTab(id) {
  const t = await getTab(id);
  const c = await canControl(t.url || '');
  if (!c.ok) throw new Error(c.why);
  return t;
}
async function inPage(tabId, op, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: hbPage, args: [op, args] });
  const v = r && r.result;
  if (!v) throw new Error('The page did not answer. It may still be loading; try again.');
  if (v.__error) throw new Error(v.__error);
  return v;
}
const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
async function shrink(dataUrl, maxW = 1280) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, maxW / bmp.width), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  return { dataUrl: 'data:image/jpeg;base64,' + b64(await blob.arrayBuffer()), width: w, height: h };
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
async function opened() { return (await chrome.storage.session.get('hbOpened')).hbOpened || []; }
async function lastShot(id) { return (await chrome.storage.session.get(`shot:${id}`))[`shot:${id}`] || null; }

async function browserOp(op, a) {
  switch (op) {
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return Promise.all(tabs.map(async t => {
        const ok = (await canControl(t.url || '')).ok;
        let site = '';
        try { site = new URL(t.url).hostname; } catch {}
        return ok ? { id: t.id, active: t.active, allowed: true, title: t.title, url: t.url, site } : { id: t.id, active: t.active, allowed: false, site: site || 'a browser page' };
      }));
    }
    case 'read': { const t = await controlledTab(a.tab); return inPage(t.id, 'read', {}); }
    case 'describe': { const t = await controlledTab(a.tab); return inPage(t.id, 'describe', { els: a.els || [], x: a.x, y: a.y, shot: await lastShot(t.id) }); }
    case 'fill': { const t = await controlledTab(a.tab); return inPage(t.id, 'fill', { fields: a.fields || [] }); }
    case 'click': { const t = await controlledTab(a.tab); return inPage(t.id, 'click', { el: a.el, x: a.x, y: a.y, shot: await lastShot(t.id) }); }
    case 'keys': { const t = await controlledTab(a.tab); return inPage(t.id, 'keys', { text: a.text || '', keys: a.keys || [] }); }
    case 'scroll': { const t = await controlledTab(a.tab); return inPage(t.id, 'scroll', { direction: a.direction, amount: a.amount }); }
    case 'repeat': { const t = await controlledTab(a.tab); return inPage(t.id, 'repeat', { every_s: a.every_s, for_s: a.for_s, action: a.action || {}, shot: await lastShot(t.id) }); }
    case 'stopRepeat': { const t = await getTab(a.tab); return inPage(t.id, 'stopRepeat', {}); }
    case 'shot': {
      const t = await controlledTab(a.tab);
      if (!t.active) { await chrome.tabs.update(t.id, { active: true }); await sleepMs(400); }
      let img, canvas = false;
      try {
        // works on the tab where the user last clicked the Homebox toolbar button (Chrome's "active tab" rule)
        const raw = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 85 });
        if (!(await getTab(t.id)).active) throw new Error('The tab was switched away while taking the picture. Try again.');
        img = await shrink(raw);
      } catch (e) {
        if (/switched away/.test(e.message)) throw e;
        // games drawn on a canvas: picture just the game area
        const c = await inPage(t.id, 'canvasShot', {}).catch(() => null);
        if (!c) throw new Error("Homebox can't take a picture of this tab yet. Ask the user to click the Homebox button in the browser toolbar once while this tab is open, then try again.");
        img = await shrink(c.dataUrl);
        canvas = true;
      }
      await chrome.storage.session.set({ [`shot:${t.id}`]: { w: img.width, h: img.height, canvas } });
      return { ...img, title: t.title, canvas };
    }
    case 'open': {
      if (!/^https?:\/\//i.test(String(a.url || ''))) throw new Error('Only https:// and http:// addresses can be opened.');
      const t = await chrome.tabs.create({ url: String(a.url), active: true });
      await chrome.storage.session.set({ hbOpened: [...(await opened()), t.id].slice(-50) });
      return { id: t.id };
    }
    case 'switch': {
      const t = await getTab(a.tab);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    }
    case 'close': {
      const t = await getTab(a.tab);
      if (!(await opened()).includes(t.id)) {
        const c = await canControl(t.url || '');
        if (!c.ok) throw new Error(`Homebox only closes tabs it opened, or tabs on sites the user allowed. ${c.why}`);
      }
      await chrome.tabs.remove(t.id);
      return { ok: true };
    }
    default: throw new Error(`Unknown browser command ${op}`);
  }
}
async function runBrowser(cmds) {
  for (const c of cmds) {
    let body;
    try { body = { id: c.id, ok: true, data: await browserOp(c.op, c.args || {}) }; }
    catch (e) { body = { id: c.id, ok: false, error: e.message }; }
    api('/ext/browser/result', body).catch(() => {});
  }
}

// Runs inside the web page (Chrome's isolated extension world), so everything it needs is defined inside.
// The safety rules live here, next to the page, so they hold whatever the AI asks for.
async function hbPage(op, args) {
  try {
    const txt = s => String(s || '').replace(/\s+/g, ' ').trim();
    const SENSITIVE = /pass(word|code|phrase)|passwd|\bpin\b|cvv|cvc|\bcsc\b|card ?(number|no\b)|credit card|security code|expir(y|ation)|\biban\b|routing|account number|sort code|\bssn\b|social security|one[- ]?time|\botp\b|2fa|verification code/i;
    const FINAL = /\b(send|apply|post|publish|share|pay|buy|purchase|place order|order now|checkout|check out|submit|transfer|withdraw|donate|subscribe|delete|confirm|sign ?in|log ?in|sign ?up|register|save)\b/i;
    const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true]';
    const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
    const labelOf = el => {
      const aria = el.getAttribute('aria-label'); if (aria && txt(aria)) return txt(aria);
      const by = el.getAttribute('aria-labelledby');
      if (by) { const t = txt(by.split(/\s+/).map(id => (document.getElementById(id) || {}).innerText || '').join(' ')); if (t) return t; }
      if (el.labels && el.labels.length && txt(el.labels[0].innerText)) return txt(el.labels[0].innerText);
      const ph = el.getAttribute('placeholder'); if (ph && txt(ph)) return txt(ph);
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return txt(el.value);
      const t = txt(el.innerText || el.textContent); if (t) return t.slice(0, 120);
      return txt(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || (el.querySelector('img') || {}).alt || el.id || '');
    };
    const isField = el => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || /^(textbox|combobox)$/.test(el.getAttribute('role') || '');
    const isSensitive = el => {
      if (el.type === 'password') return true;
      if (/cc-|password|one-time-code/i.test(el.getAttribute('autocomplete') || '')) return true;
      return SENSITIVE.test([labelOf(el), el.name, el.id, el.getAttribute('placeholder')].join(' '));
    };
    const isFinal = el => {
      const words = [labelOf(el), el.getAttribute('title'), el.tagName === 'INPUT' ? el.value : ''].join(' ');
      if (FINAL.test(words)) return true;
      const form = el.form || (el.closest && el.closest('form'));
      return !!(form && form.querySelector('input[type=password]') && (el.type === 'submit' || el.tagName === 'BUTTON'));
    };
    const need = n => { const el = document.querySelector(`[data-hb-el="${Number(n)}"]`); if (!el || !el.isConnected) throw new Error(`Element ${n} is no longer on the page. Read the page again.`); return el; };
    const kind = el => el.tagName === 'INPUT' ? `input ${el.type || 'text'}` : el.tagName === 'A' ? 'link' : el.isContentEditable ? 'text box' : (el.getAttribute('role') || el.tagName.toLowerCase());
    const clickable = el => (el.closest && el.closest('button,a[href],input,select,textarea,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option]')) || el;
    const pointToCss = (x, y) => {
      const s = args.shot, c = s && s.canvas && document.querySelector('[data-hb-shot]');
      if (c) { const r = c.getBoundingClientRect(); return { x: r.left + x * r.width / s.w, y: r.top + y * r.height / s.h }; }
      return s && s.w ? { x: x * innerWidth / s.w, y: y * innerHeight / s.h } : { x: x / devicePixelRatio, y: y / devicePixelRatio };
    };
    const fire = (el, x, y) => {
      const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
      const p = { ...o, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointerover', p)); el.dispatchEvent(new MouseEvent('mouseover', o));
      el.dispatchEvent(new PointerEvent('pointerdown', p)); el.dispatchEvent(new MouseEvent('mousedown', o));
      if (el.focus) el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', p)); el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
    };
    const center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); };

    if (op === 'canvasShot') {
      let best = null, area = 0;
      for (const c of document.querySelectorAll('canvas')) { if (!visible(c)) continue; const r = c.getBoundingClientRect(); if (r.width * r.height > area) { area = r.width * r.height; best = c; } }
      if (!best || area < 20000) throw new Error('no game canvas on this page');
      document.querySelectorAll('[data-hb-shot]').forEach(e => e.removeAttribute('data-hb-shot'));
      best.setAttribute('data-hb-shot', '1');
      try { return { dataUrl: best.toDataURL('image/jpeg', 0.85) }; } catch { throw new Error('this game picture is protected by the site'); }
    }

    if (op === 'read') {
      let n = 0;
      for (const el of document.querySelectorAll('[data-hb-el]')) n = Math.max(n, Number(el.getAttribute('data-hb-el')) || 0);
      const elements = []; let more = 0;
      for (const el of document.querySelectorAll(SEL)) {
        if (!visible(el)) continue;
        if (elements.length >= 300) { more++; continue; }
        let id = el.getAttribute('data-hb-el');
        if (!id) { id = String(++n); el.setAttribute('data-hb-el', id); }
        const e = { n: Number(id), kind: kind(el), label: labelOf(el) };
        if (isField(el) || el.type === 'checkbox' || el.type === 'radio') {
          if (isSensitive(el)) e.note = "protected: Homebox won't fill this, the user types it";
          else if (el.tagName === 'SELECT') e.value = txt((el.selectedOptions[0] || {}).text);
          else if (el.type === 'checkbox' || el.type === 'radio') e.value = el.checked ? 'yes' : 'no';
          else if (el.type === 'file') e.note = 'file upload: tell the user which file to attach';
          else e.value = txt(el.isContentEditable ? el.innerText : el.value).slice(0, 200);
        } else if (isFinal(el)) e.note = 'final button: the user presses this';
        elements.push(e);
      }
      const text = String(document.body ? document.body.innerText : '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      return { url: location.href, title: document.title, text: text.length > 15000 ? text.slice(0, 15000) + '\n…[more text below; scroll and read again]' : text, elements, more };
    }

    if (op === 'describe') {
      const labels = {};
      for (const n of args.els || []) {
        const el = need(n);
        if (isField(el) && isSensitive(el)) throw new Error(`Element ${n} ("${labelOf(el)}") is a password or payment field. Homebox never fills those: ask the user to type it.`);
        labels[n] = `${labelOf(el) || kind(el)} (${kind(el)})`;
      }
      if (args.x != null && args.y != null) {
        const p = pointToCss(args.x, args.y), at = document.elementFromPoint(p.x, p.y);
        if (!at) throw new Error('Nothing is at that point. Take a new screenshot.');
        const el = clickable(at);
        labels.point = `${txt(labelOf(el)).slice(0, 60) || kind(el)} at ${Math.round(args.x)},${Math.round(args.y)}`;
      }
      return { site: location.hostname, title: document.title, labels };
    }

    if (op === 'fill') {
      const out = [];
      for (const f of args.fields) {
        try {
          const el = need(f.el), v = String(f.text);
          if (isSensitive(el)) throw new Error('password or payment field: the user types it');
          if (el.type === 'file') throw new Error('file upload: tell the user which file to attach');
          if (el.disabled || el.readOnly) throw new Error('this field is locked');
          el.scrollIntoView({ block: 'center' });
          if (el.tagName === 'SELECT') {
            const opts = [...el.options], low = v.toLowerCase();
            const o = opts.find(x => txt(x.text).toLowerCase() === low || x.value === v) || opts.find(x => txt(x.text).toLowerCase().includes(low));
            if (!o) throw new Error(`no option "${v}". Options: ${opts.map(x => txt(x.text)).slice(0, 30).join(', ')}`);
            el.value = o.value;
          } else if (el.type === 'checkbox' || el.type === 'radio' || /^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '')) {
            const want = /^(yes|true|on|1|checked|tick)$/i.test(v.trim());
            const cur = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.getAttribute('aria-checked') === 'true';
            if (want !== cur) { const c = center(el); fire(el, c.x, c.y); }
            out.push({ el: f.el, ok: true }); continue;
          } else if (el.isContentEditable) {
            el.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, v);
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.focus(); setValue(el, v);
          } else throw new Error('this is not a text field');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (el.blur) el.blur();
          out.push({ el: f.el, ok: true });
        } catch (e) { out.push({ el: f.el, ok: false, error: e.message }); }
      }
      return out;
    }

    const doClick = async a => {
      let el, x, y;
      if (a.el != null) {
        el = need(a.el);
        el.scrollIntoView({ block: 'center' });
        await sleep(150);
        ({ x, y } = center(el));
      } else {
        ({ x, y } = pointToCss(a.x, a.y));
        el = document.elementFromPoint(x, y);
        if (!el) throw new Error('Nothing is at that point. Take a new screenshot.');
      }
      const target = clickable(el);
      if (isField(target) && isSensitive(target)) throw new Error('That is a password or payment field. The user types it.');
      if (isFinal(target) && (target !== el || txt(target.innerText).length < 80)) throw new Error(`"${labelOf(target)}" is a final button (send, submit, apply, pay, post, save or sign in). Homebox never presses those: tell the user to check everything and press it.`);
      fire(el, x, y);
    };

    const doKeys = async a => {
      if (!a.text) leaveTextField();  // arrows, Space, PageDown… are for the page, not a search box
      const t = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
      const typing = t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/i.test(t.type));
      if (typing && isSensitive(t)) throw new Error('The cursor is in a password or payment field. The user types it.');
      const NAMED = { Enter: 13, Space: 32, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
      const press = (key, code, keyCode) => {
        const mk = type => { const e = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }); Object.defineProperty(e, 'keyCode', { get: () => keyCode }); Object.defineProperty(e, 'which', { get: () => keyCode }); return e; };
        const down = mk('keydown');
        t.dispatchEvent(down);
        if (key.length === 1) t.dispatchEvent(mk('keypress'));
        t.dispatchEvent(mk('keyup'));
        return !down.defaultPrevented;
      };
      for (const ch of String(a.text || '')) {
        const up = ch.toUpperCase();
        const ok = press(ch, /[a-z]/i.test(ch) ? `Key${up}` : /\d/.test(ch) ? `Digit${ch}` : '', up.charCodeAt(0));
        if (ok && typing && !t.isContentEditable) { setValue(t, t.value + ch); t.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (ok && t.isContentEditable) document.execCommand('insertText', false, ch);
        await sleep(60);
      }
      for (const raw of a.keys || []) {
        const key = raw === ' ' || /^space$/i.test(raw) ? 'Space' : String(raw);
        if (!(key in NAMED)) throw new Error(`Unknown key "${raw}". Use: ${Object.keys(NAMED).join(', ')}. Type letters with text.`);
        if (key === 'Enter' && (typing || (t.closest && t.closest('form')))) throw new Error('Homebox does not press Enter inside forms or message boxes, because that can send or submit. The user presses it.');
        const ok = press(key === 'Space' ? ' ' : key, key, NAMED[key]);
        if (ok && (key === 'PageDown' || key === 'PageUp')) scrollBy(0, (key === 'PageDown' ? 1 : -1) * innerHeight * 0.85);
        await sleep(90);
      }
    };

    // Scroll whatever is scrolling in the middle of the screen (a feed, a list, YouTube Shorts), else the page.
    // Never type into a search box or form by accident: named keys go to the page, not a focused text field.
    const leaveTextField = () => {
      const ae = document.activeElement;
      if (ae && ae !== document.body && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) ae.blur();
    };
    const pressArrow = down => {
      leaveTextField();
      const key = down ? 'ArrowDown' : 'ArrowUp', code = down ? 40 : 38;
      const target = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
      for (const type of ['keydown', 'keyup']) {
        const e = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(e, 'keyCode', { get: () => code }); Object.defineProperty(e, 'which', { get: () => code });
        target.dispatchEvent(e);
      }
    };
    // Scroll the feed or list in the middle of the screen, else the page. Some feeds (YouTube Shorts, Reels) don't
    // scroll at all and move with the arrow keys or a "Next" button instead: try those when nothing moved.
    const doScroll = async a => {
      const down = a.direction !== 'up', part = a.amount === 'little' ? 0.35 : 1;
      // Short-video feeds (YouTube Shorts, Reels, TikTok) change video, not scroll position: use their own
      // "next" (the arrow key, then a Next button) and only count it when the video really changed.
      if (/^\/(shorts|reels?)(\/|$)/.test(location.pathname) || /(^|\.)tiktok\.com$/.test(location.hostname)) {
        const url = location.href;
        pressArrow(down);
        for (let i = 0; i < 12 && location.href === url; i++) await sleep(100);
        if (location.href !== url) return 'arrow key';
        const re = down ? /^(next( video| short| reel| post)?|go to next video)$/i : /^(previous( video| short| reel| post)?|go to previous video)$/i;
        const btn = [...document.querySelectorAll('button, [role="button"]')].find(b => visible(b) && re.test((b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()));
        if (btn) { const c = center(btn); fire(btn, c.x, c.y); for (let i = 0; i < 12 && location.href === url; i++) await sleep(100); if (location.href !== url) return 'next button'; }
      }
      let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      const canScroll = e => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 10; };
      while (el && el !== document.body && el !== document.documentElement && !canScroll(el)) el = el.parentElement;
      const box = el && el !== document.body && el !== document.documentElement ? el : null;
      const where = () => `${location.href}|${Math.round(scrollY)}|${box ? Math.round(box.scrollTop) : 0}`;
      const before = where();
      const step = (box ? box.clientHeight : innerHeight) * part * (down ? 1 : -1);
      if (box) box.scrollBy({ top: step, behavior: 'smooth' }); else window.scrollBy({ top: step, behavior: 'smooth' });
      await sleep(700);
      if (where() !== before) return 'scrolled';
      pressArrow(down);
      await sleep(900);
      if (where() !== before) return 'arrow key';
      const re = down ? /^(next( video| short| reel| post)?|down)$/i : /^(previous( video| short| reel| post)?|up)$/i;
      const btn = [...document.querySelectorAll('button, [role="button"]')].find(b => visible(b) && re.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
      if (btn) { const c = center(btn); fire(btn, c.x, c.y); await sleep(900); if (where() !== before) return 'next button'; }
      return '';
    };

    // A repeating job runs inside the page itself, so it keeps time while the AI's tab is in the background.
    // A small "Stop" badge shows on the page while it runs.
    const stopRepeat = () => {
      const r = window.__hbRepeat;
      if (r) { clearInterval(r.t); if (r.badge) r.badge.remove(); }
      window.__hbRepeat = null;
    };

    if (op === 'click') { await doClick(args); return { ok: true }; }
    if (op === 'keys') { await doKeys(args); return { ok: true }; }
    if (op === 'scroll') { const how = await doScroll(args); return { ok: true, moved: !!how, how }; }
    if (op === 'stopRepeat') { const was = !!window.__hbRepeat; stopRepeat(); return { ok: true, was }; }

    if (op === 'repeat') {
      const every = Math.max(1, Math.min(3600, Number(args.every_s) || 5)) * 1000;
      const total = Math.max(1, Math.min(7200, Number(args.for_s) || 60)) * 1000;
      const act = args.action || {};
      const run = act.type === 'click' ? () => doClick(act) : act.type === 'keys' ? () => doKeys(act) : () => doScroll(act);
      if (act.type === 'click' && act.el != null) need(act.el);  // fail now, not on the first repeat
      stopRepeat();
      document.querySelectorAll('homebox-repeat').forEach(e => e.remove());
      const host = document.createElement('homebox-repeat');
      host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647';
      const sh = host.attachShadow({ mode: 'closed' });
      sh.innerHTML = `<style>div{font:13px system-ui,"Segoe UI",sans-serif;background:#1d1c1a;color:#ecebe5;border:1px solid #2e6b5a;border-radius:999px;padding:6px 8px 6px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.3)}button{border:0;border-radius:999px;padding:4px 12px;background:#62b39b;color:#0d1a16;font-weight:600;cursor:pointer}</style>
        <div><span id="t"></span><button id="s">Stop</button></div>`;
      const started = Date.now();
      let count = 0, misses = 0;
      const label = () => {
        const left = Math.max(0, Math.round((started + total - Date.now()) / 1000));
        const what = act.type === 'click' ? 'clicking' : act.type === 'keys' ? 'pressing keys' : 'scrolling';
        sh.getElementById('t').textContent = `Homebox: ${what} every ${every / 1000}s · ${act.type === 'scroll' || !act.type ? `moved ${count}× · ` : ''}${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left}s`} left`;
      };
      sh.getElementById('s').addEventListener('click', e => { if (e.isTrusted) stopRepeat(); });
      document.documentElement.appendChild(host);
      label();
      let busy = false;
      const t = setInterval(async () => {
        if (Date.now() - started >= total) return stopRepeat();
        if (busy) return;
        busy = true;
        try {
          const r = await run();
          if (r === '' && (act.type === 'scroll' || !act.type)) misses++; else { count++; misses = 0; }
        } catch { misses = 99; }
        busy = false;
        if (misses >= 3) {  // the page won't move this way: stop, and say so instead of pretending
          clearInterval(t); window.__hbRepeat = null;
          sh.getElementById('t').textContent = misses === 99 ? 'Homebox: stopped, the step failed on this page' : "Homebox: stopped, this page didn't move when scrolled";
          setTimeout(() => host.remove(), 8000);
          return;
        }
        label();
      }, every);
      window.__hbRepeat = { t, badge: host, count: () => count };
      return { ok: true, every: every / 1000, total: total / 1000 };
    }

    return { __error: `unknown page command ${op}` };
  } catch (e) { return { __error: e.message || String(e) }; }
}

// ---- Ask AI from any tab: open the best AI site in a new tab and hand it the task ----
// The task waits in session storage until the AI page is ready (logged in, chat box showing), then that page's
// Homebox panel types it. If the site is down or out of messages, the task moves to the next AI on the list.
const HANDOFF_TTL = 20 * 60_000;
async function handoffs() { return (await chrome.storage.session.get('handoffs')).handoffs || {}; }
async function saveHandoffs(h) { await chrome.storage.session.set({ handoffs: h }); }
async function routePrefs() { try { return (await chrome.storage.local.get('routePrefs')).routePrefs || {}; } catch { return {}; } }

async function route(text, { forced = '', computer, stay, srcTab } = {}) {
  text = text.trim().slice(0, 20_000);
  if (!text) throw new Error('Type a task first.');
  const p = HB_ROUTER.plan(text, await routePrefs(), forced || '');
  // AIs that last asked for a login go to the back of the line, unless the user picked one
  if (!forced && !p.named) {
    const needs = (await chrome.storage.local.get('aiNeedsLogin')).aiNeedsLogin || {};
    const fresh = id => needs[id] && Date.now() - needs[id] < 7 * 24 * 3600_000;
    p.order = [...p.order.filter(id => !fresh(id)), ...p.order.filter(fresh)];
    p.site = HB_ROUTER.byId(p.order[0]);
  }
  const useComputer = computer === undefined ? p.computer : !!computer;
  // the page the user typed on, so "this page" means something to the AI
  const src = srcTab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const onPage = src && /^https?:/.test(src.url || '') && !(await isChatTab(src));
  if (useComputer && onPage) text += `\n\n(I typed this while on tab ${src.id}: "${String(src.title || '').slice(0, 120)}" — ${src.url}. "This page" means that tab.)`;
  const background = stay === undefined ? useComputer && onPage : !!stay;
  const tab = await chrome.tabs.create({ url: p.site.url, active: !background, index: src ? src.index + 1 : undefined });
  const h = await handoffs();
  h[tab.id] = { task: text, computer: useComputer, order: p.order, site: p.site.id, tried: [], kind: p.kind, reason: p.reason, created: Date.now(), state: 'opening', background, src: onPage ? src.id : null };
  if (onPage) { await showIcon(src); onActivity(tab.id, 'sending'); }
  await saveHandoffs(h);
  return { site: p.site.name, reason: p.reason, tabId: tab.id };
}

// ---- what the AI is doing: toolbar badge on every page, and the small icon on the page the task came from ----
const activityByTab = {};
async function onActivity(tabId, state) {
  if (state) activityByTab[tabId] = state; else delete activityByTab[tabId];
  updateBadge();
  const x = (await handoffs())[tabId];
  if (x && x.src) chrome.tabs.sendMessage(x.src, { type: 'aiStatus', state, site: (HB_ROUTER.byId(x.site) || {}).name, aiTab: tabId }).catch(() => {});
  if (state === 'done' || state === 'failed') setTimeout(() => { if (activityByTab[tabId] === state) { delete activityByTab[tabId]; updateBadge(); } }, 8000);
  return { ok: true };
}
function updateBadge() {
  const s = Object.values(activityByTab);
  const need = s.some(x => x === 'approval' || x === 'login'), work = s.some(x => ['sending', 'thinking', 'running'].includes(x)), done = s.includes('done');
  chrome.action.setBadgeBackgroundColor({ color: need ? '#d9822b' : '#2e6b5a' }).catch(() => {});
  chrome.action.setBadgeText({ text: need ? '!' : work ? '•••' : done ? '✓' : '' }).catch(() => {});
  chrome.action.setTitle({ title: need ? 'Homebox: the AI needs you' : work ? 'Homebox: the AI is working…' : done ? 'Homebox: done' : 'Homebox' }).catch(() => {});
}
chrome.tabs.onRemoved.addListener(id => { if (id in activityByTab) { delete activityByTab[id]; updateBadge(); } });

// the small Homebox icon on sites you allowed (like YouTube), so you can see and reach Homebox there too
async function showIcon(tab) {
  if (!tab || !(await canControl(tab.url || '')).ok) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['router.js', 'askbox.js', 'content.js'] }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.status === 'complete') showIcon(tab); });

async function handoffFor(tab) {
  const h = await handoffs(), x = h[tab.id];
  if (!x || Date.now() - x.created > HANDOFF_TTL || x.state === 'sent') return null;
  const s = HB_ROUTER.byId(x.site);
  let host = '';
  try { host = new URL(tab.url).hostname; } catch {}
  if (!s || HB_ROUTER.byHost(host) !== s) return null;
  return { task: x.task, computer: x.computer, site: s.id, siteName: s.name, reason: x.reason, tried: x.tried.map(id => HB_ROUTER.byId(id).name), others: HB_ROUTER.SITES.filter(o => o.id !== s.id).map(o => ({ id: o.id, name: o.name })) };
}
async function setHandoff(tabId, patch) {
  const h = await handoffs();
  if (!h[tabId]) return null;
  // working in the background, but the user has to do something there: bring that tab to the front
  if (h[tabId].background && ['login', 'app', 'gone', 'needsend'].includes(patch.state)) chrome.tabs.update(tabId, { active: true }).catch(() => {});
  Object.assign(h[tabId], patch);
  await saveHandoffs(h);
  return { ok: true };
}
async function dropHandoff(tabId) { const h = await handoffs(); delete h[tabId]; await saveHandoffs(h); return { ok: true }; }

// this AI can't take the task (down, out of messages, no chat box): go to the next one in the same tab
async function handoffNext(tabId, reason) {
  const h = await handoffs(), x = h[tabId];
  if (!x) return { none: true };
  x.tried.push(x.site);
  const next = x.order.find(id => !x.tried.includes(id));
  if (!next) { delete h[tabId]; await saveHandoffs(h); return { none: true }; }
  x.site = next; x.state = 'opening'; x.reason = `${HB_ROUTER.byId(x.tried[x.tried.length - 1]).name} was unavailable (${reason.slice(0, 120)})`;
  await saveHandoffs(h);
  await chrome.tabs.update(tabId, { url: HB_ROUTER.byId(next).url });
  return { next: HB_ROUTER.byId(next).name };
}

// the user picked a different AI: same tab if the task wasn't sent yet, otherwise a new tab (keeps the first chat)
async function handoffSwitch(tabId, siteId) {
  const s = HB_ROUTER.byId(siteId);
  if (!s) throw new Error('Unknown AI.');
  const h = await handoffs(), x = h[tabId];
  if (!x) throw new Error('This task is no longer waiting. Type it again from the Homebox button.');
  const order = [s.id, ...x.order.filter(id => id !== s.id)];
  if (x.state === 'sent') {
    const t = await chrome.tabs.create({ url: s.url, active: !x.background });
    h[t.id] = { ...x, order, site: s.id, tried: [], state: 'opening', reason: 'you chose ' + s.name, created: Date.now() };
  } else {
    Object.assign(x, { order, site: s.id, state: 'opening', reason: 'you chose ' + s.name });
    await chrome.tabs.update(tabId, { url: s.url });
  }
  await saveHandoffs(h);
  return { ok: true };
}
chrome.tabs.onRemoved.addListener(async id => { const h = await handoffs(); if (h[id]) { delete h[id]; await saveHandoffs(h); } });

// address bar: type "hb", a space, then the task
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
if (chrome.omnibox) {
  chrome.omnibox.setDefaultSuggestion({ description: 'Homebox: send this task to the best AI' });
  chrome.omnibox.onInputChanged.addListener(async text => {
    if (!text.trim()) return chrome.omnibox.setDefaultSuggestion({ description: 'Homebox: type a task, then press Enter' });
    const p = HB_ROUTER.plan(text, await routePrefs());
    chrome.omnibox.setDefaultSuggestion({ description: xmlEsc(`Homebox → ${p.site.name} (${p.reason})`) });
  });
  chrome.omnibox.onInputEntered.addListener(text => { route(text).catch(() => {}); });
}

// Installed from an unzipped folder, the extension keeps running old code until it is reloaded. When newer files
// are on disk (an update was unzipped over the folder), reload by itself so the user doesn't have to.
let lastSelfCheck = 0;
async function selfUpdate() {
  if (Date.now() - lastSelfCheck < 30_000) return;
  lastSelfCheck = Date.now();
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (disk.version && disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {}
}
chrome.runtime.onStartup.addListener(selfUpdate);
selfUpdate();
