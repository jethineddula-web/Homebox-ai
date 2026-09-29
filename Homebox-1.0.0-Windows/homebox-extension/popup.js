const $ = id => document.getElementById(id);
const welcome = new URLSearchParams(location.search).has('welcome');
if (welcome) { document.body.classList.add('welcome'); $('welcome').classList.remove('hidden'); }

const send = (type, extra = {}) => new Promise(r => chrome.runtime.sendMessage({ type, ...extra }, x => r(x || { ok: false, error: chrome.runtime.lastError?.message })));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUILT_IN = /^(https:\/\/)(([a-z0-9-]+\.)?lmarena\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|aistudio\.google\.com|claude\.ai|chat\.deepseek\.com|grok\.com|chat\.qwen\.ai|chat\.mistral\.ai|(www\.)?kimi\.com|kimi\.moonshot\.cn|www\.perplexity\.ai|copilot\.microsoft\.com|poe\.com|huggingface\.co|chat\.z\.ai|x\.com)(\/|$)/;

let timer = null;
async function render() {
  const r = await send('status');
  const d = r.ok ? r.data : { app: false };
  const dot = $('dot'), text = $('statusText'), body = $('body');
  if (!d.app) {
    dot.className = 'dot bad'; text.textContent = 'Homebox app is not running';
    body.innerHTML = '<p class="small muted" style="margin:0 0 10px">Open the Homebox app on this computer. This window updates by itself.</p><button class="btn" id="retry">Check again</button>';
    $('retry').onclick = render;
  } else if (!d.paired) {
    dot.className = 'dot bad'; text.textContent = 'Not connected yet';
    if (d.pairing && d.pairing.status === 'waiting') {
      body.innerHTML = `<div class="box"><div class="small">Approve this code in the Homebox app:</div><div class="code">${esc(d.pairing.code)}</div><div class="small muted">Waiting for you to click Approve…</div></div>`;
    } else {
      body.innerHTML = `${d.pairing && d.pairing.status === 'denied' ? '<p class="small" style="color:var(--bad)">The request was denied. Try again.</p>' : ''}<button class="btn primary" id="pair">Connect to Homebox</button>`;
      $('pair').onclick = async () => { const x = await send('pair'); if (!x.ok) alert(x.error); render(); };
    }
  } else {
    dot.className = 'dot on'; text.textContent = 'Connected';
    const i = d.info;
    body.innerHTML = `<div class="box small">Sandbox folder: <b>${esc(i.workspace)}</b>${i.paused ? ' <span style="color:var(--bad)">(paused)</span>' : ''}<br>
      <span class="muted">Read: ${i.policy.read} · Change files: ${i.policy.write} · Commands: ${i.policy.exec}</span></div>
      <p class="small muted" style="margin:10px 0">On an AI chat site, click the <b>Homebox</b> button at the bottom right to start a task.</p>
      <button class="btn" id="openApp">Open Homebox app</button>
      <button class="btn" id="disc" style="margin-top:8px">Disconnect this browser</button>`;
    $('openApp').onclick = () => send('openApp');
    $('disc').onclick = async () => { if (confirm('Disconnect this browser from Homebox?')) { await send('disconnect'); render(); } };
  }
  await renderSite(d);
  clearTimeout(timer); timer = setTimeout(render, 2000);
}

async function renderSite(d) {
  const box = $('siteBox');
  if (welcome || !d.paired) { box.classList.add('hidden'); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) { box.classList.add('hidden'); return; }
  const origin = new URL(tab.url).origin;
  box.classList.remove('hidden');
  if (BUILT_IN.test(tab.url)) { box.innerHTML = `✓ Homebox works on <b>${esc(new URL(tab.url).hostname)}</b>.`; return; }
  const r = await send('siteEnabled', { origin });
  if (r.ok && r.data.enabled) { box.innerHTML = `✓ Enabled on <b>${esc(new URL(tab.url).hostname)}</b>.`; return; }
  box.innerHTML = `Using a different AI site? <button class="btn" id="enable" style="margin-top:8px">Enable Homebox on ${esc(new URL(tab.url).hostname)}</button>`;
  $('enable').onclick = async () => {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
    const x = await send('enableSite', { origin, tabId: tab.id });
    if (!x.ok) alert(x.error);
    renderSite(d);
  };
}
render();
