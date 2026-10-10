const $ = id => document.getElementById(id);
const welcome = new URLSearchParams(location.search).has('welcome');
if (welcome) { document.body.classList.add('welcome'); $('welcome').classList.remove('hidden'); }

const send = (type, extra = {}) => new Promise(r => chrome.runtime.sendMessage({ type, ...extra }, x => r(x || { ok: false, error: chrome.runtime.lastError?.message })));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// only touch the DOM when the markup changes, so the 2-second refresh doesn't restart animations
const html = (el, s) => { if (el.__html !== s) { el.__html = s; el.innerHTML = s; } };
const BUILT_IN = /^(https:\/\/)(([a-z0-9-]+\.)?lmarena\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|aistudio\.google\.com|claude\.ai|chat\.deepseek\.com|grok\.com|chat\.qwen\.ai|chat\.mistral\.ai|(www\.)?kimi\.com|kimi\.moonshot\.cn|www\.perplexity\.ai|copilot\.microsoft\.com|poe\.com|huggingface\.co|chat\.z\.ai|x\.com)(\/|$)/;
const SITES = [
  ['Arena', 'https://lmarena.ai', '#6b4de6'], ['ChatGPT', 'https://chatgpt.com', '#10a37f'], ['Claude', 'https://claude.ai', '#d97757'],
  ['Gemini', 'https://gemini.google.com', '#4285f4'], ['DeepSeek', 'https://chat.deepseek.com', '#4d6bfe'], ['Grok', 'https://grok.com', '#222'],
  ['Qwen', 'https://chat.qwen.ai', '#615ced'], ['Mistral', 'https://chat.mistral.ai', '#fa520f'], ['Perplexity', 'https://www.perplexity.ai', '#1f8a8a'],
];
const ICON = {
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9M6.3 7a8 8 0 1 0 11.4 0"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
};

// ---------- tabs ----------
function moveInd() {
  const on = $('tabs').querySelector('button.on');
  $('ind').style.width = on.offsetWidth + 'px';
  $('ind').style.transform = `translateX(${on.offsetLeft}px)`;
}
function showTab(t) {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('hidden', p.dataset.pane !== t);
  moveInd();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$('ind').style.transition = 'none'; moveInd(); requestAnimationFrame(() => { $('ind').style.transition = ''; });

html($('siteGrid'), SITES.map(([n, u, c], i) => `<button class="tile" data-url="${u}" style="animation-delay:${i * 30}ms"><i>${n[0]}</i>${n}</button>`).join(''));
$('siteGrid').addEventListener('click', e => { const t = e.target.closest('.tile'); if (t) { chrome.tabs.create({ url: t.dataset.url }); window.close(); } });
$('openAppLink').onclick = () => send('openApp');
$('ver').textContent = `Extension v${chrome.runtime.getManifest().version}`;

function setChip(kind, text) { $('chip').className = `chip ${kind}`; $('chipText').textContent = text; }
const busy = b => b && b.classList.add('busy');

// ---------- status ----------
let timer = null;
async function render() {
  const r = await send('status');
  const d = r.ok ? r.data : { app: false };
  const body = $('body');
  if (!d.app) {
    setChip('bad', 'Offline');
    html(body, `<div class="card hero bad"><span class="art">${ICON.power}</span><b>Homebox app is not running</b>
      <span class="small muted">Open the Homebox app on this computer. This window updates by itself.</span>
      <button class="btn" id="retry" style="margin-top:8px">Check again</button></div>`);
  } else if (!d.paired) {
    const waiting = d.pairing && d.pairing.status === 'waiting';
    setChip('warn', waiting ? 'Waiting' : 'Not connected');
    html(body, waiting
      ? `<div class="card hero"><span class="small muted">Approve this code in the Homebox app</span>
          <div class="code">${[...String(d.pairing.code)].map(c => `<span>${esc(c)}</span>`).join('')}</div>
          <span class="wait"><span class="spinner"></span>Waiting for you to click Approve…</span></div>`
      : `<div class="card hero"><span class="art">${ICON.link}</span><b>Connect this browser</b>
          <span class="small muted">One time only. You'll confirm a 4-digit code in the Homebox app.</span>
          ${d.pairing && d.pairing.status === 'denied' ? '<span class="small" style="color:var(--bad)">The request was denied. Try again.</span>' : ''}
          <button class="btn primary" id="pair" style="margin-top:8px">${ICON.link}Connect to Homebox</button></div>`);
  } else {
    const i = d.info;
    setChip(i.paused ? 'warn' : 'on', i.paused ? 'Paused' : 'Connected');
    $('sub').textContent = `App v${d.version}`;
    // the extension is installed from an unzipped folder, so it doesn't update itself: say when the app is newer
    const mine = chrome.runtime.getManifest().version, newer = (x, y) => { const p = v => String(v).split('.').map(Number); const [a1, b1] = [p(x), p(y)]; for (let k = 0; k < 3; k++) { if ((a1[k] || 0) !== (b1[k] || 0)) return (a1[k] || 0) > (b1[k] || 0); } return false; };
    const old = newer(d.version, mine);
    const perm = (label, v) => `<span class="perm ${esc(v)}">${label}: <i>${v === 'auto' ? 'by itself' : v === 'ask' ? 'asks you' : 'off'}</i></span>`;
    html(body, `${old ? `<div class="card" style="border:1.5px solid var(--warn);margin-bottom:10px"><b>This extension is out of date</b><div class="small" style="margin-top:4px">The Homebox app is v${esc(d.version)}, this extension is v${esc(mine)}. In the Homebox app go to <b>Connect AI → Download extension</b>, unzip it over your old <b>homebox-extension</b> folder, then click the reload arrow on Homebox at <b>chrome://extensions</b>.</div></div>` : ''}<div class="card">
        <div class="ws"><span class="ic">${ICON.folder}</span><div class="body"><span class="small muted">AI folder</span><b>${esc(i.workspace)}</b></div></div>
        ${i.paused ? '<div class="small" style="color:var(--warn);margin-top:8px">AI access is paused in the Homebox app.</div>' : ''}
        ${i.fullAccess ? '<div class="small" style="color:var(--warn);margin-top:8px">⚡ <b>Full access is on</b>: AI acts without asking. Change it in the Homebox app.</div>' : ''}
        <div class="perms">${perm('Looks at files', i.policy.read)}${perm('Changes files', i.policy.write)}${i.policy.exec && i.policy.exec !== 'off' ? perm('Commands', i.policy.exec) : ''}</div>
      </div>
      <div class="card"><b>How to start a task</b>
        <ol class="steps small" style="margin-top:8px"><li><span>Open an AI chat site in a new chat (see <b>AI sites</b> above).</span></li><li><span>Click the round <b>Homebox</b> button at the bottom right of the page.</span></li><li><span>Type what you want in box <b>1</b>, add pictures in box <b>2</b> if you like, then click <b>Start task</b>.</span></li></ol>
      </div>
      <div class="row"><button class="btn" id="openApp">${ICON.open}Open app</button><button class="btn" id="disc">Disconnect</button></div>`);
  }
  wire();
  await renderSite(d);
  clearTimeout(timer); timer = setTimeout(render, 2000);
}
function wire() {
  const on = (id, fn) => { const el = $(id); if (el && !el.__wired) { el.__wired = true; el.onclick = fn; } };
  on('retry', e => { busy(e.currentTarget); render(); });
  on('pair', async e => { busy(e.currentTarget); const x = await send('pair'); if (!x.ok) alert(x.error); render(); });
  on('openApp', () => send('openApp'));
  on('disc', async () => { if (confirm('Disconnect this browser from Homebox?')) { await send('disconnect'); render(); } });
  on('togglePanel', async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }).catch(() => {}); window.close(); });
}

async function renderSite(d) {
  const box = $('siteBox');
  if (welcome || !d.paired) { box.classList.add('hidden'); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) { box.classList.add('hidden'); return; }
  const url = new URL(tab.url), origin = url.origin, host = esc(url.hostname);
  const fav = tab.favIconUrl && /^https:/.test(tab.favIconUrl) ? `<img src="${esc(tab.favIconUrl)}" alt="">` : '';
  box.classList.remove('hidden');
  const builtIn = BUILT_IN.test(tab.url);
  const added = !builtIn && ((await send('siteEnabled', { origin })).data || {}).enabled;
  if (builtIn || added) {
    html(box, `<div class="card"><div class="site">${fav}<div class="body"><span class="small muted">${added ? 'AI site you added' : 'AI chat site'}</span><b>${host}</b></div><span class="ok-tag">${ICON.check}Ready</span></div>
      <button class="btn primary" id="showPanel" style="margin-top:10px">${ICON.panel}Show Homebox on this page</button>
      ${added ? '<div class="small muted" style="margin-top:8px">Not an AI chat site? <button class="linkish" id="unAdd">Remove it from my AI sites</button></div>' : ''}</div>`);
    $('showPanel').onclick = async e => { busy(e.currentTarget); await send('showPanel', { tabId: tab.id }); window.close(); };
    if ($('unAdd')) $('unAdd').onclick = async () => { await send('removeSite', { origin, tabId: tab.id }); box.__html = null; renderSite(d); };
    return;
  }
  // Any other site: let the AI read and fill it (after approvals), or turn Homebox's chat panel on if it's an AI site.
  const ctl = (await send('controlStatus', { origin })).data || {};
  const browserOff = !d.info || !d.info.policy || !d.info.policy.browser || d.info.policy.browser === 'off';
  const control = ctl.never
    ? `<div class="small muted" style="margin-top:8px">${esc(ctl.never.replace('Write the text and show it with show_copy_text, so the user can paste it into LinkedIn.', 'Instead, ask the AI to write your profile or answers: you get Copy buttons in the Homebox panel and paste the text in yourself.'))}</div>`
    : ctl.allowed
      ? `<div class="small" style="margin-top:8px"><b>The AI may use this site.</b> It reads the page and fills forms only after you approve. You always press Send, Submit and Pay yourself.</div>
         <button class="btn" id="ctlOff" style="margin-top:8px">Stop letting AI use this site</button>`
      : `<button class="btn primary" id="ctlOn" style="margin-top:10px">Let AI control this site</button>
         <div class="small muted" style="margin-top:6px">The AI can read this page, fill forms, click and play games here, each step after your approval. It never types passwords or card details, and never presses Send, Submit or Pay.</div>`;
  html(box, `<div class="card"><div class="site">${fav}<div class="body"><span class="small muted">This site</span><b>${host}</b></div>${ctl.allowed ? `<span class="ok-tag">${ICON.check}AI allowed</span>` : ''}</div>
    ${control}
    ${!ctl.never && browserOff ? '<div class="small" style="margin-top:8px;color:var(--warn)">Also turn on <b>Control browser tabs</b> in the Homebox app, under Settings.</div>' : ''}
    <div class="small muted" style="margin-top:10px">Is this an AI chat website, like ChatGPT? <button class="linkish" id="enable">Add it as an AI site</button></div></div>`);
  const ctlOn = $('ctlOn'), ctlOff = $('ctlOff');
  if (ctlOn) ctlOn.onclick = async () => {
    send('rememberGrant', { origin, kind: 'control', tabId: tab.id });  // finishes the job if this popup closes
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
    const x = await send('controlSite', { origin, on: true });
    if (!x.ok) alert(x.error);
    box.__html = null; renderSite(d);
  };
  if (ctlOff) ctlOff.onclick = async () => { await send('controlSite', { origin, on: false }); box.__html = null; renderSite(d); };
  $('enable').onclick = async e => {
    const btn = e.currentTarget;
    busy(btn);
    send('rememberGrant', { origin, kind: 'chat', tabId: tab.id });  // finishes the job if this popup closes
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) { btn.classList.remove('busy'); return; }
    const x = await send('enableSite', { origin, tabId: tab.id });
    if (!x.ok) alert(x.error);
    box.__html = null; renderSite(d);
  };
}
render();

// ---------- "Show the Homebox icon on every site" ----------
(async () => {
  if (welcome) { $('evw').classList.add('hidden'); return; }
  const r = await send('everywhereStatus');
  $('evwOn').checked = !!(r.ok && r.data && r.data.on);
  $('evwOn').addEventListener('change', async () => {
    const on = $('evwOn').checked;
    if (on) {
      send('rememberGrant', { kind: 'everywhere' });  // finishes the job if this popup closes during Chrome's question
      const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
      if (!granted) { $('evwOn').checked = false; return; }
    }
    const x = await send('everywhere', { on });
    if (!x.ok) { alert(x.error); $('evwOn').checked = !on; }
  });
})();

// ---------- Ask AI: the same box as the panel on web pages (askbox.js) ----------
(async () => {
  if (welcome) { $('ask').classList.add('hidden'); return; }
  const [here] = await chrome.tabs.query({ active: true, currentWindow: true });
  let onPage = false;
  try { onPage = !!here && /^https?:/.test(here.url || '') && !self.HB_ROUTER.byHost(new URL(here.url).hostname); } catch {}
  const ask = await self.HB_ASKBOX.mount($('ask'), {
    onPage,
    placeholder: 'Type a task from any tab. For example: scroll this page every 5 seconds for 2 minutes',
    send: o => send('route', o),
    sent: () => window.close(),
  });
  ask.focus();
})();
