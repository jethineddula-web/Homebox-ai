// Homebox extension — content script.
// Watches an AI chat page for ```homebox action blocks, runs them through the Homebox app,
// and puts the results back into the chat. Draws a small floating panel; never edits the chat's own DOM.
(() => {
  if (window.__homeboxContent) return;
  window.__homeboxContent = true;

  const LOADED_AT = Date.now();
  const STABLE_MS = 1600;   // a block's text must stop changing this long before it counts
  const QUIET_MS = 2200;    // the page must stop changing this long before auto-run fires
  const GRACE_MS = 4000;    // blocks already on the page when we load are "old" (never auto-run)
  const HOST = location.hostname.replace(/^www\./, '');

  const SITE = {
    'chatgpt.com': { input: '#prompt-textarea', send: 'button[data-testid="send-button"], #composer-submit-button' },
    'chat.openai.com': { input: '#prompt-textarea', send: 'button[data-testid="send-button"]' },
    'claude.ai': { input: 'div.ProseMirror[contenteditable="true"]', send: 'button[aria-label="Send message"], button[aria-label="Send Message"]' },
    'gemini.google.com': { input: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]', send: 'button.send-button, button[aria-label="Send message"]' },
    'chat.deepseek.com': { input: 'textarea#chat-input, textarea' },
    'lmarena.ai': { input: 'textarea' },
    'grok.com': { input: 'textarea, div[contenteditable="true"]', send: 'button[type="submit"]' },
    'chat.qwen.ai': { input: 'textarea#chat-input, textarea' },
    'chat.mistral.ai': { input: 'textarea, div[contenteditable="true"]' },
    'perplexity.ai': { input: 'textarea, div[contenteditable="true"]' },
  };
  const site = SITE[HOST] || {};

  const st = {
    app: null, paired: false, info: null, pairing: null,
    auto: false, running: false, step: 0,
    pending: [], note: '', noteKind: '', open: false, lastResults: '', runLabel: '',
  };
  const blocks = new Map();        // <pre> element → record
  const doneCount = new Map();     // content hash → how many fresh copies we already ran
  const ourTexts = [];             // texts we typed into the chat (prompt, results) — never parse blocks from them
  let freshAfter = LOADED_AT + GRACE_MS, seq = 0, lastLen = 0, lastLenChange = Date.now(), lastFocusedInput = null, dirty = true;

  // ---------- messaging ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function bg(type, extra = {}) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, r => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'Extension was updated — reload this page.' });
          else resolve(r || { ok: false, error: 'No response' });
        });
      } catch { resolve({ ok: false, error: 'Extension was updated — reload this page.' }); }
    });
  }
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'statusChanged') refresh(); });

  // ---------- parsing ----------
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const codeEl = pre => pre.querySelector('code') || pre;
  const blockText = pre => codeEl(pre).textContent || '';
  function langHint(pre) {
    const c = codeEl(pre);
    const attrs = `${c.className || ''} ${pre.className || ''} ${pre.getAttribute('data-language') || ''} ${c.getAttribute && (c.getAttribute('data-language') || '')}`;
    if (/homebox/i.test(attrs)) return true;
    const probe = (c.textContent || '').slice(0, 30);
    let n = pre;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const full = n.textContent || '';
      const idx = probe ? full.indexOf(probe) : -1;
      if (idx > 0 && /homebox\W*(copy|code)?\W*$/i.test(full.slice(Math.max(0, idx - 60), idx))) return true;
    }
    return false;
  }
  function parseBlock(text, hinted) {
    let t = String(text).replace(/^\s*homebox[ \t]*\r?\n/i, '').trim();
    if (!t) return null;
    if (t[0] === '{' || t[0] === '[') {
      let v;
      try { v = JSON.parse(t); } catch (e) { return hinted && /"tool"\s*:/.test(t) ? { error: `invalid JSON (${e.message})`, actions: [] } : null; }
      const arr = Array.isArray(v) ? v : Array.isArray(v.actions) ? v.actions : [v];
      if (!arr.length || !arr.every(x => x && typeof x.tool === 'string')) return null;
      return { actions: arr.map(x => ({ tool: x.tool, args: x.args || x.arguments || {} })) };
    }
    if (!hinted) return null;
    const nl = t.indexOf('\n');
    const first = (nl < 0 ? t : t.slice(0, nl)).trim();
    const rest = nl < 0 ? '' : t.slice(nl + 1);
    const m = first.match(/^([a-z_]+)\s*(.*)$/);
    if (!m) return null;
    const [, tool, arg] = m;
    switch (tool) {
      case 'write_file': return arg ? { actions: [{ tool, args: { path: arg, content: rest.endsWith('\n') ? rest : rest + '\n' } }] } : null;
      case 'read_file': case 'list_dir': case 'make_dir': return { actions: [{ tool, args: { path: arg || '.' } }] };
      case 'search': return { actions: [{ tool, args: { query: arg } }] };
      case 'run_command': return { actions: [{ tool, args: { command: [arg, rest].filter(Boolean).join('\n').trim() } }] };
      case 'workspace_info': return { actions: [{ tool, args: {} }] };
      default: return null;
    }
  }
  function isOurs(text) {
    const n = norm(text);
    if (n.length < 8) return false;
    return ourTexts.some(t => t.includes(n));
  }
  const describe = a => {
    if (a.error) return 'unreadable block';
    const x = a.args || {};
    return `${a.tool} ${x.path || x.from || x.query || x.command || ''}`.trim().slice(0, 70);
  };

  // ---------- page watching ----------
  const inHost = el => hostEl.contains(el);
  function scan() {
    const now = Date.now();
    const len = document.body ? document.body.textContent.length : 0;
    if (len !== lastLen) { lastLen = len; lastLenChange = now; }
    for (const pre of document.querySelectorAll('pre')) {
      if (inHost(pre)) continue;
      const text = blockText(pre);
      let rec = blocks.get(pre);
      if (!rec) {
        rec = { id: ++seq, pre, text, changedAt: now, fresh: now > freshAfter, status: 'streaming', parsed: null };
        blocks.set(pre, rec); dirty = true; continue;
      }
      if (text !== rec.text) {
        rec.text = text; rec.changedAt = now;
        if (rec.status !== 'running' && rec.status !== 'done') { rec.status = 'streaming'; rec.parsed = null; dirty = true; }
        continue;
      }
      if (rec.status === 'streaming' && now - rec.changedAt >= STABLE_MS) {
        const parsed = isOurs(text) ? null : parseBlock(text, langHint(pre));
        rec.parsed = parsed; rec.status = parsed ? 'ready' : 'ignored'; rec.hash = hash(norm(text)); dirty = true;
      }
    }
    for (const [pre] of blocks) if (!pre.isConnected) { blocks.delete(pre); dirty = true; }
    // a chat app may re-render a block we already ran: count fresh copies per hash
    const seen = new Map();
    for (const rec of orderedBlocks()) {
      if (!rec.fresh || !rec.hash || !['ready', 'done', 'running', 'manual'].includes(rec.status)) continue;
      const i = seen.get(rec.hash) || 0; seen.set(rec.hash, i + 1);
      if (rec.status === 'ready' && i < (doneCount.get(rec.hash) || 0)) { rec.status = 'done'; dirty = true; }
    }
    maybeAuto();
    if (dirty) { dirty = false; render(); }
  }
  const orderedBlocks = () => [...blocks.values()].filter(r => r.pre.isConnected)
    .sort((a, b) => (a.pre.compareDocumentPosition(b.pre) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  function generating() {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (inHost(b)) continue;
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''} ${(b.textContent || '').trim().slice(0, 30)}`;
      if (/\bstop(\s|-|_)?(generating|streaming|response|button)?\b/i.test(label) && !/stop sharing|stop recording/i.test(label) && visible(b)) return true;
    }
    return false;
  }

  function maybeAuto() {
    if (!st.auto || st.running || !st.paired || (st.info && st.info.paused)) return;
    const recs = orderedBlocks();
    const ready = recs.filter(r => r.fresh && r.status === 'ready');
    if (!ready.length) return;
    if (recs.some(r => r.fresh && r.status === 'streaming')) return;
    const now = Date.now();
    if (now - Math.max(...ready.map(r => r.changedAt)) < QUIET_MS) return;
    if (now - lastLenChange < QUIET_MS) return;
    if (generating()) return;
    const lefts = ready.map(r => r.pre.getBoundingClientRect().left);
    if (Math.max(...lefts) - Math.min(...lefts) > 150) {
      ready.forEach(r => { r.status = 'manual'; });
      note('Two answers side by side (Arena battle mode?). Click Run on the answer you want — or use Direct Chat for full auto mode.', 'warn');
      openPanel(); return;
    }
    const max = (st.info && st.info.maxAutoSteps) || 30;
    if (st.step >= max) { st.auto = false; saveAuto(); note(`Auto-run paused after ${max} steps. Turn it on again to keep going.`, 'warn'); openPanel(); return; }
    runRecs(ready, true);
  }

  // ---------- running ----------
  async function runRecs(recs, auto) {
    if (st.running) return;
    st.running = true; st.pending = [];
    const actions = [];
    for (const r of recs) {
      r.status = 'running';
      doneCount.set(r.hash, (doneCount.get(r.hash) || 0) + 1);
      if (r.parsed.error) actions.push({ error: r.parsed.error }); else actions.push(...r.parsed.actions);
    }
    st.step += 1;
    st.runLabel = `Running ${actions.length} action${actions.length > 1 ? 's' : ''}…`;
    note(''); render();
    const started = await bg('run', { actions, step: auto ? st.step : 0 });
    if (!started.ok) { recs.forEach(r => { r.status = 'ready'; doneCount.set(r.hash, Math.max(0, (doneCount.get(r.hash) || 1) - 1)); }); st.running = false; st.step -= 1; st.auto = false; note(started.error, 'bad'); render(); return; }
    const runId = started.data.runId;
    let data = null;
    for (;;) {
      await sleep(700);
      const s = await bg('runStatus', { runId });
      if (!s.ok) { note(s.error, 'bad'); break; }
      data = s.data;
      const before = st.pending.length;
      st.pending = data.pending || [];
      if (st.pending.length && !before) openPanel();
      st.runLabel = st.pending.length ? 'Waiting for your approval…' : st.runLabel;
      render();
      if (data.done) break;
    }
    st.pending = [];
    recs.forEach(r => { r.status = 'done'; });
    st.running = false; st.runLabel = '';
    if (data && data.done) {
      st.lastResults = data.text;
      remember(data.text);
      const fails = (data.results || []).filter(x => !x.ok).length;
      await putInChat(data.text, auto || st.auto, `${actions.length - fails}/${actions.length} actions OK`);
    }
    render();
  }

  // ---------- typing into the chat ----------
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (t && !inHost(t) && (t.tagName === 'TEXTAREA' || t.isContentEditable)) lastFocusedInput = t.closest('[contenteditable="true"]') || t;
  }, true);
  function findInput() {
    if (site.input) for (const el of document.querySelectorAll(site.input)) if (!inHost(el) && visible(el)) return el;
    if (lastFocusedInput && lastFocusedInput.isConnected && visible(lastFocusedInput)) return lastFocusedInput;
    const c = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], div[role="textbox"]')]
      .filter(e => !inHost(e) && visible(e) && !e.disabled && !e.readOnly)
      .filter(e => !(e.parentElement && e.parentElement.closest('[contenteditable="true"]')));
    c.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return c[0] || null;
  }
  const inputText = el => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : el.innerText || '';
  async function setInput(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const selectAll = () => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
    const probe = norm(text).slice(0, 40);
    selectAll();
    try {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
    await sleep(120);
    if (norm(inputText(el)).includes(probe)) return true;
    selectAll();
    document.execCommand('insertText', false, text);
    await sleep(80);
    return norm(inputText(el)).includes(probe);
  }
  function findSendButton(el) {
    if (site.send) for (const b of document.querySelectorAll(site.send)) if (!inHost(b) && visible(b)) return b;
    const er = el.getBoundingClientRect();
    const cx = er.left + er.width / 2, cy = er.top + er.height / 2;
    const cands = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(b => !inHost(b) && visible(b)).filter(b => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''} ${b.type === 'submit' ? 'submit' : ''} ${(b.textContent || '').trim().slice(0, 20)}`;
      return /\b(send|submit)\b/i.test(label) && !/stop|voice|dictat|attach|upload|feedback/i.test(label);
    });
    const form = el.closest('form');
    if (!cands.length && form) { const s = form.querySelector('button[type="submit"]'); if (s) return s; }
    cands.sort((a, b) => {
      const d = x => { const r = x.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); };
      return d(a) - d(b);
    });
    return cands[0] || null;
  }
  async function pressSend(el, marker) {
    const stillThere = () => el.isConnected && norm(inputText(el)).includes(marker);
    await sleep(350);
    for (let i = 0; i < 8; i++) {
      const b = findSendButton(el);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        b.click(); await sleep(900);
        if (!stillThere()) return true;
      }
      await sleep(300);
    }
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(900);
    return !stillThere();
  }
  async function putInChat(text, send, summary) {
    const el = findInput();
    if (!el) { note('Could not find the chat box. Copy the results below and paste them into the chat.', 'warn'); openPanel(); return; }
    const ok = await setInput(el, text);
    if (!ok) { note('Could not type into the chat box. Copy the results below and paste them into the chat.', 'warn'); openPanel(); return; }
    if (!send) { note(`${summary}. Results are in the message box — press Send.`, 'ok'); return; }
    const sent = await pressSend(el, norm(text).slice(0, 40));
    note(sent ? `${summary}. Results sent to the AI.` : `${summary}. Results are in the message box — press Send.`, sent ? 'ok' : 'warn');
  }
  function remember(text) { ourTexts.push(norm(text)); if (ourTexts.length > 50) ourTexts.shift(); }

  // ---------- actions from the panel ----------
  async function startTask(task) {
    if (!st.info) return;
    const prompt = st.info.prompt + task.trim();
    remember(prompt);
    st.step = 0;
    freshAfter = Math.min(freshAfter, Date.now());
    const el = findInput();
    if (!el) { note('Could not find the chat box on this page.', 'bad'); return; }
    if (!(await setInput(el, prompt))) { note('Could not type into the chat box.', 'bad'); return; }
    const sent = await pressSend(el, norm(prompt).slice(0, 40));
    note(sent ? 'Task sent. Homebox will pick up the AI\'s actions when it answers.' : 'The task is in the message box — press Send.', sent ? 'ok' : 'warn');
  }
  async function refresh() {
    const r = await bg('status');
    if (!r.ok) { st.app = false; st.paired = false; note(r.error, 'bad'); render(); return; }
    const d = r.data;
    st.app = d.app; st.paired = !!d.paired; st.info = d.info || null; st.pairing = d.pairing;
    if (st.info) remember(st.info.prompt);
    if (st.paired && st.noteKind === 'bad') note('');
    render();
  }
  async function loadAuto() {
    try { const k = `auto:${HOST}`; const v = await chrome.storage.local.get(k); st.auto = !!v[k]; } catch {}
  }
  function saveAuto() { try { chrome.storage.local.set({ [`auto:${HOST}`]: st.auto }); } catch {} }

  // ---------- UI (closed shadow DOM, so the page can't read or click it) ----------
  const hostEl = document.createElement('homebox-widget');
  hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:18px;bottom:110px;';
  try { chrome.storage.local.get('pillBottom').then(v => { if (v.pillBottom) hostEl.style.bottom = v.pillBottom + 'px'; }); } catch {}
  const root = hostEl.attachShadow({ mode: 'closed' });
  const ICON = 'data:image/png;base64,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';
  root.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{--bg:#fff;--ink:#1c1b19;--muted:#6a675f;--line:#e3e0d7;--soft:#f3f1ea;--accent:#2e6b5a;--ai:#fff;--warn:#a8511c;--warnbg:#fcf0e6;--bad:#a3322a;--badbg:#fbe9e7;--okbg:#e3efe9}
@media (prefers-color-scheme:dark){.wrap{--bg:#1d1c1a;--ink:#ecebe5;--muted:#9d998f;--line:#34332f;--soft:#262522;--accent:#62b39b;--ai:#0d1a16;--warn:#f0a36e;--warnbg:#35251a;--bad:#f2837a;--badbg:#3a1f1c;--okbg:#1d302a}}
.pill{touch-action:none;user-select:none;display:flex;align-items:center;gap:8px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:6px 12px 6px 6px;box-shadow:0 4px 18px rgba(0,0,0,.18);cursor:pointer;font-size:13.5px;font-weight:600;margin-left:auto;width:max-content}
.pill img{width:26px;height:26px;border-radius:7px}
.dot{width:8px;height:8px;border-radius:50%;background:#999}
.dot.on{background:#2fa37e}.dot.auto{background:#2fa37e;box-shadow:0 0 0 3px rgba(47,163,126,.3)}.dot.bad{background:#d24a3f}
.badge{background:#d9822b;color:#fff;border-radius:999px;font-size:11px;padding:1px 7px}
.panel{width:360px;max-width:calc(100vw - 36px);max-height:min(620px,calc(100vh - 90px));overflow:auto;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.22);margin-bottom:10px;font-size:13.5px;line-height:1.45}
.hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
.hd img{width:22px;height:22px;border-radius:6px}
.hd b{font-size:14.5px}.hd .ws{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.x{border:0;background:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px}
.bd{padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.btn{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--ai);font-weight:600}
.btn.small{padding:3px 9px;font-size:12px}
.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.muted{color:var(--muted)}.small{font-size:12.5px}
textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:9px;background:var(--soft);color:var(--ink);padding:8px;font-size:13px;resize:vertical}
.note{border-radius:9px;padding:8px 10px;font-size:12.5px;background:var(--soft)}
.note.ok{background:var(--okbg)}.note.warn{background:var(--warnbg)}.note.bad{background:var(--badbg)}
.appr{border:1px solid var(--warn);background:var(--warnbg);border-radius:10px;padding:10px}
.appr .w{font-weight:600;word-break:break-word}
.appr pre{max-height:140px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;font:11.5px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.sw{display:flex;align-items:flex-start;gap:10px;cursor:pointer}
.sw input{display:none}
.track{width:36px;height:20px;border-radius:999px;background:var(--line);position:relative;flex:none;margin-top:1px;transition:background .15s}
.track:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.sw input:checked + .track{background:var(--accent)}
.sw input:checked + .track:after{left:18px}
.list{display:flex;flex-direction:column;gap:6px}
.item{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12.5px}
.item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.tag{font-size:11px;color:var(--muted)}
.code{font:700 26px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;margin:6px 0}
h4{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.hidden{display:none!important}
</style>
<div class="wrap">
  <div class="panel hidden" id="panel">
    <div class="hd"><img src="${ICON}" alt=""><b>Homebox</b><span class="ws" id="ws"></span><button class="x" id="close" title="Close">×</button></div>
    <div class="bd">
      <div id="state"></div>
      <div id="noteBox" class="note hidden"></div>
      <div id="approvals" class="list"></div>
      <div id="main" class="hidden">
        <div class="list" style="gap:8px">
          <h4>New task</h4>
          <textarea id="task" placeholder="What should the AI do in your sandbox folder? e.g. Build a simple to-do web app in index.html"></textarea>
          <div class="row"><button class="btn primary" id="start">Start task</button><span class="small muted" id="stepInfo"></span></div>
        </div>
        <label class="sw" style="margin-top:12px"><input type="checkbox" id="auto"><span class="track"></span><span><b>Auto-run</b><br><span class="small muted">Run the AI's actions and send results back by itself. Changes still wait for your approval.</span></span></label>
        <div id="detected" style="margin-top:12px"></div>
        <div id="resultsBox" class="hidden" style="margin-top:12px">
          <h4>Last results</h4>
          <textarea id="results" readonly style="min-height:60px;margin-top:6px"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn small" id="copyRes">Copy</button><button class="btn small" id="insertRes">Put in chat box</button></div>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn small" id="stop">Stop</button><button class="btn small" id="openApp">Open Homebox app</button></div>
      </div>
    </div>
  </div>
  <div class="pill" id="pill"><img src="${ICON}" alt=""><span class="dot" id="dot"></span><span id="pillText">Homebox</span><span class="badge hidden" id="badge"></span></div>
</div>`;
  const $ = id => root.getElementById(id);
  const trusted = fn => e => { if (!e.isTrusted) return; fn(e); };

  function openPanel() { st.open = true; render(); }
  function note(text, kind = '') { st.note = text; st.noteKind = kind; render(); }
  // drag the pill up/down so it never covers the chat's own buttons; a short press toggles the panel
  let drag = null;
  $('pill').addEventListener('pointerdown', e => { if (!e.isTrusted) return; drag = { y: e.clientY, bottom: parseInt(hostEl.style.bottom) || 110, moved: false }; $('pill').setPointerCapture(e.pointerId); });
  $('pill').addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) hostEl.style.bottom = Math.min(innerHeight - 60, Math.max(8, drag.bottom - dy)) + 'px';
  });
  $('pill').addEventListener('pointerup', e => {
    if (!drag || !e.isTrusted) return;
    const moved = drag.moved; drag = null;
    if (moved) { try { chrome.storage.local.set({ pillBottom: parseInt(hostEl.style.bottom) }); } catch {} return; }
    st.open = !st.open; if (st.open) refresh(); render();
  });
  $('close').addEventListener('click', trusted(() => { st.open = false; render(); }));
  $('start').addEventListener('click', trusted(async () => {
    const t = $('task').value.trim();
    if (!t) { $('task').focus(); return; }
    $('start').disabled = true;
    await startTask(t);
    $('start').disabled = false; $('task').value = '';
  }));
  $('auto').addEventListener('change', trusted(() => { st.auto = $('auto').checked; if (st.auto) st.step = 0; saveAuto(); render(); }));
  $('stop').addEventListener('click', trusted(async () => { st.auto = false; saveAuto(); await bg('stop'); note('Stopped. Auto-run is off.', 'warn'); }));
  $('openApp').addEventListener('click', trusted(() => bg('openApp')));
  $('copyRes').addEventListener('click', trusted(async () => { try { await navigator.clipboard.writeText(st.lastResults); note('Results copied.', 'ok'); } catch { $('results').select(); document.execCommand('copy'); } }));
  $('insertRes').addEventListener('click', trusted(() => putInChat(st.lastResults, false, 'Ready')));
  root.addEventListener('click', trusted(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.approve) { b.disabled = true; await bg('decide', { id: b.dataset.approve, approve: b.dataset.v === '1' }); }
    if (b.dataset.run) {
      const rec = [...blocks.values()].find(r => String(r.id) === b.dataset.run);
      if (rec && rec.parsed) {
        // in side-by-side mode, "Run (left)" runs every waiting block in that answer's column together
        const side = r => r.pre.getBoundingClientRect().left < innerWidth / 2;
        const group = rec.status === 'manual'
          ? orderedBlocks().filter(r => r.status === 'manual' && side(r) === side(rec))
          : [rec];
        if (rec.status === 'manual') orderedBlocks().filter(r => r.status === 'manual' && !group.includes(r)).forEach(r => { r.status = 'skipped'; });
        group.forEach(r => { r.status = 'ready'; });
        runRecs(group, st.auto);
      }
    }
    if (b.dataset.act === 'pair') { const r = await bg('pair'); if (!r.ok) note(r.error, 'bad'); else { st.pairing = { code: r.data.code, status: 'waiting' }; render(); } }
    if (b.dataset.act === 'retry') refresh();
  }));

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render() {
    const ready = st.app && st.paired;
    const recs = orderedBlocks().filter(r => r.parsed && ['ready', 'manual', 'running', 'done'].includes(r.status));
    const waiting = recs.filter(r => r.status === 'ready' || r.status === 'manual').length;
    // pill
    $('dot').className = `dot ${!st.app || (st.app && !st.paired) ? 'bad' : st.auto ? 'auto' : 'on'}`;
    $('pillText').textContent = st.running ? (st.pending.length ? 'Approve…' : 'Working…') : st.auto && ready ? 'Homebox · auto' : 'Homebox';
    const badgeN = st.pending.length || (!st.auto ? waiting : 0);
    $('badge').textContent = badgeN; $('badge').classList.toggle('hidden', !badgeN);
    $('panel').classList.toggle('hidden', !st.open);
    if (!st.open) return;
    $('panel').style.maxHeight = Math.max(220, innerHeight - (parseInt(hostEl.style.bottom) || 110) - 70) + 'px';
    $('ws').textContent = st.info ? `· ${st.info.workspace}${st.info.paused ? ' (paused)' : ''}` : '';
    // connection state
    let stateHtml = '';
    if (st.app === null) stateHtml = '<div class="muted small">Checking…</div>';
    else if (!st.app) stateHtml = `<div><b>The Homebox app isn't running.</b><div class="small muted" style="margin:4px 0 8px">Open the Homebox app on this computer, then try again.</div><button class="btn primary" data-act="retry">Try again</button></div>`;
    else if (!st.paired) stateHtml = st.pairing && st.pairing.status === 'waiting'
      ? `<div><b>Approve this code in the Homebox app</b><div class="code">${esc(st.pairing.code)}</div><div class="small muted">The Homebox window should have opened. Waiting…</div></div>`
      : `<div><b>Connect this browser to Homebox</b><div class="small muted" style="margin:4px 0 8px">One time only. You'll confirm a code in the Homebox app.</div><button class="btn primary" data-act="pair">Connect</button></div>`;
    $('state').innerHTML = stateHtml;
    $('state').classList.toggle('hidden', !stateHtml);
    $('main').classList.toggle('hidden', !ready);
    const noteText = st.running ? st.runLabel : st.note;
    $('noteBox').textContent = noteText;
    $('noteBox').className = `note ${st.running ? '' : st.noteKind}${noteText ? '' : ' hidden'}`;
    // approvals
    $('approvals').innerHTML = st.pending.map(p => `<div class="appr"><div class="w">${esc(p.summary)}</div>
      ${p.preview != null ? `<pre>${esc(String(p.preview).slice(0, 1500))}</pre>` : ''}
      <div class="row"><button class="btn primary small" data-approve="${esc(p.id)}" data-v="1">Approve</button><button class="btn small" data-approve="${esc(p.id)}" data-v="0">Deny</button></div></div>`).join('');
    if (!ready) return;
    $('auto').checked = st.auto;
    const max = (st.info && st.info.maxAutoSteps) || 30;
    $('stepInfo').textContent = st.auto && st.step ? `Step ${st.step}/${max}` : '';
    // detected blocks
    const shown = recs.slice(-8);
    $('detected').innerHTML = shown.length ? `<h4>Actions on this page</h4><div class="list" style="margin-top:6px">${shown.map(r => {
      const acts = r.parsed.error ? [{ error: r.parsed.error }] : r.parsed.actions;
      const label = acts.map(describe).join(' · ');
      const side = r.status === 'manual' ? (r.pre.getBoundingClientRect().left < innerWidth / 2 ? ' (left)' : ' (right)') : '';
      const right = r.status === 'done' ? '<span class="tag">done</span>' : r.status === 'running' ? '<span class="tag">running…</span>'
        : `<button class="btn small" data-run="${r.id}" ${st.running ? 'disabled' : ''}>Run${side}</button>`;
      return `<div class="item"><span class="t" title="${esc(label)}">${esc(label)}</span>${right}</div>`;
    }).join('')}</div>` : '<div class="small muted">No actions on this page yet. Start a task, or ask the AI to use Homebox.</div>';
    $('resultsBox').classList.toggle('hidden', !st.lastResults);
    if ($('results').value !== st.lastResults) $('results').value = st.lastResults;
  }

  // ---------- boot ----------
  (document.documentElement || document.body).appendChild(hostEl);
  loadAuto().then(refresh);
  setInterval(scan, 700);
  setInterval(() => { if (st.open || !st.paired) refresh(); }, 6000);
})();
