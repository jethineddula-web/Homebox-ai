// Homebox extension — content script.
// Watches an AI chat page for ```homebox action blocks, runs them through the Homebox app,
// and puts the results back into the chat. Draws a small floating panel; never edits the chat's own DOM.
(() => {
  // After the extension is reloaded, the old copy on an open page is cut off from it: let a fresh copy take over.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  if (window.__homeboxContent && window.__homeboxContent.alive()) return;
  document.querySelectorAll('homebox-widget').forEach(el => el.remove());
  window.__homeboxContent = { alive };

  const LOADED_AT = Date.now();
  const STABLE_MS = 1100;   // a block's text must stop changing this long before it counts
  const QUIET_MS = 1400;    // the page must stop changing this long before auto-run fires
  const GRACE_MS = 4000;    // blocks already on the page when we load are "old" (never auto-run)
  const HOST = location.hostname.replace(/^www\./, '');
  const IS_ARENA = /(^|\.)(lm)?arena\.ai$/.test(HOST);  // only Arena's Battle mode shows two answers side by side

  const SITE = {
    'chatgpt.com': { input: '#prompt-textarea', send: 'button[data-testid="send-button"], #composer-submit-button' },
    'chat.openai.com': { input: '#prompt-textarea', send: 'button[data-testid="send-button"]' },
    'claude.ai': { input: 'div.ProseMirror[contenteditable="true"]', send: 'button[aria-label="Send message"], button[aria-label="Send Message"]' },
    'gemini.google.com': { input: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]', send: 'button.send-button, button[aria-label="Send message"]' },
    'chat.deepseek.com': { input: 'textarea#chat-input, textarea' },
    'lmarena.ai': { input: 'textarea' },
    'arena.ai': { input: 'textarea' },
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
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m.type === 'statusChanged') refresh();
    if (m.type === 'togglePanel') { st.open = !st.open; if (st.open) refresh(); render(); reply(true); }
    if (m.type === 'openPanel') { st.open = true; refresh(); render(); reply(true); }
    if (m.type === 'siteAllowed') siteAllowed(String(m.host || ''));
    if (m.type === 'aiStatus') remoteStatus(m);
    if (m.type === 'removeWidget') { hostEl.remove(); window.__homeboxContent = null; }
  });

  // ---------- parsing ----------
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const codeEl = pre => pre.querySelector('code') || pre;
  const blockText = pre => codeEl(pre).textContent || '';
  function langHint(pre) {
    const c = codeEl(pre);
    const attrs = `${c.className || ''} ${pre.className || ''} ${pre.getAttribute('data-language') || ''} ${c.getAttribute && (c.getAttribute('data-language') || '')}`;
    if (/homebox/i.test(attrs)) return true;
    const LABEL = /homebox(\W*(copy|code|edit|run|download|wrap))*\W*$/i;  // "homebox" plus the code box's buttons, e.g. "Copy code"
    // a label inside the code box, above the code (how ChatGPT and Claude show the language)
    if (c !== pre) {
      const inner = pre.textContent || '', probe = (c.textContent || '').slice(0, 30);
      const idx = probe ? inner.indexOf(probe) : -1;
      if (idx > 0 && LABEL.test(inner.slice(Math.max(0, idx - 60), idx))) return true;
    }
    // or a label just before the code box. Only the nearby text is read: reading whole parent elements
    // here meant copying the entire chat for every code block, which froze long chats.
    return LABEL.test(textBefore(pre, 80));
  }
  function textBefore(node, limit) {
    let out = '';
    for (let depth = 0; depth < 4 && node && out.length < limit; depth++, node = node.parentElement) {
      for (let s = node.previousSibling; s && out.length < limit; s = s.previousSibling) {
        const t = s.nodeType === 3 ? s.data : s.nodeType === 1 ? (s.textContent || '') : '';
        out = t.slice(-limit) + out;
      }
    }
    return out.slice(-limit);
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
    const m = first.match(/^([a-z0-9_]+)\s*(.*)$/);
    if (!m) return null;
    const [, tool, arg] = m;
    switch (tool) {
      case 'write_file': return arg ? { actions: [{ tool, args: { path: arg, content: rest.endsWith('\n') ? rest : rest + '\n' } }] } : null;
      case 'read_file': case 'list_dir': case 'make_dir': return { actions: [{ tool, args: { path: arg || '.' } }] };
      case 'read_document': return arg ? { actions: [{ tool, args: { path: arg } }] } : null;
      case 'browser_tabs': return { actions: [{ tool, args: {} }] };
      case 'browser_read': case 'browser_screenshot': case 'browser_switch': case 'browser_close': return /^d+$/.test(arg) ? { actions: [{ tool, args: { tab: Number(arg) } }] } : null;
      case 'browser_open': return arg ? { actions: [{ tool, args: { url: arg.trim() } }] } : null;
      case 'search': return { actions: [{ tool, args: { query: arg } }] };
      case 'run_command': return { actions: [{ tool, args: { command: [arg, rest].filter(Boolean).join('\n').trim() } }] };
      case 'delete_path': return arg ? { actions: [{ tool, args: { path: arg } }] } : null;
      case 'workspace_info': case 'maya_scene_info': case 'vscode_info': return { actions: [{ tool, args: {} }] };
      case 'vscode_problems': return { actions: [{ tool, args: arg ? { path: arg } : {} }] };
      case 'vscode_open': { const m2 = arg.match(/^(.*?)(?::(\d+)|\s+(\d+))?$/); return arg ? { actions: [{ tool, args: { path: m2[1].trim(), line: Number(m2[2] || m2[3]) || 1 } }] } : null; }
      case 'maya_run_python': return rest.trim() ? { actions: [{ tool, args: { code: rest } }] } : null;
      case 'obs_request': {
        let data = {};
        if (rest.trim()) { try { data = JSON.parse(rest); } catch (e) { return { error: `obs_request data is not valid JSON (${e.message})`, actions: [] }; } }
        return arg ? { actions: [{ tool, args: { request: arg.trim(), data } }] } : null;
      }
      default:
        // blender_run_python, photoshop_run_jsx, excel_run_powershell, … : the rest of the block is the code
        if (/^[a-z0-9]+_run_(python|jsx|powershell)$/.test(tool) && rest.trim()) return { actions: [{ tool, args: { code: rest } }] };
        return null;
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
    if (typeof x.code === 'string') { const n = x.code.split('\n').length; return `${a.tool.replace(/_run_.*/, '')}: ${n} line${n === 1 ? '' : 's'}`; }
    if (a.tool === 'obs_request') return `OBS: ${x.request || '?'}`;
    if (/^browser_/.test(a.tool)) return `${a.tool.replace('browser_', 'browser: ')}${x.tab != null ? ` tab ${x.tab}` : ''}${x.url ? ` ${x.url}` : ''}`.slice(0, 70);
    if (a.tool === 'email_compose') return `email draft to ${x.to || '?'}`.slice(0, 70);
    if (a.tool === 'show_copy_text') return `show "${x.title || 'text'}" to copy`.slice(0, 70);
    return `${a.tool} ${x.path || x.from || x.query || x.command || ''}`.trim().slice(0, 70);
  };

  // ---------- page watching ----------
  // Chat pages can hold megabytes of text. Instead of re-reading the whole page on a timer, the browser tells us
  // what changed (MutationObserver), and we only re-read the code blocks that changed.
  const inHost = el => hostEl.contains(el);
  const allPres = document.getElementsByTagName('pre');   // live list: always up to date, costs nothing to keep
  const touched = new Set();
  let preCount = -1, removedSomething = false;
  const hasText = n => n.nodeType === 3 ? !!n.data.trim() : n.nodeType === 1 && !!n.firstChild;
  const observer = new MutationObserver(list => {
    for (const m of list) {
      const t = m.target, el = t.nodeType === 1 ? t : t.parentElement;
      if (!el || el === hostEl) continue;
      let textChanged = m.type === 'characterData';
      for (const n of m.addedNodes) if (hasText(n)) { textChanged = true; break; }
      if (m.removedNodes.length) { removedSomething = true; if (!textChanged) for (const n of m.removedNodes) if (hasText(n)) { textChanged = true; break; } }
      if (textChanged) lastLenChange = Date.now();
      const pre = el.closest && el.closest('pre');
      if (pre) touched.add(pre);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  function addBlock(pre, now) {
    const text = blockText(pre);
    blocks.set(pre, { id: ++seq, pre, text, changedAt: now, fresh: now > freshAfter, status: 'streaming', parsed: null });
    dirty = true;
  }
  function scan() {
    if (st.quiet) return;  // not an AI chat page: nothing to look for
    const now = Date.now();
    // new code blocks, and blocks the chat app removed
    if (allPres.length !== preCount || removedSomething) {
      preCount = allPres.length;
      for (const pre of allPres) if (!blocks.has(pre) && !inHost(pre)) addBlock(pre, now);
      if (removedSomething) { removedSomething = false; for (const [pre] of blocks) if (!pre.isConnected) { blocks.delete(pre); dirty = true; } }
    }
    // only the blocks that actually changed are read again
    for (const pre of touched) {
      const rec = blocks.get(pre);
      if (!rec) { if (pre.isConnected && !inHost(pre)) addBlock(pre, now); continue; }
      const text = blockText(pre);
      if (text !== rec.text) {
        rec.text = text; rec.changedAt = now;
        if (rec.status !== 'running' && rec.status !== 'done') { rec.status = 'streaming'; rec.parsed = null; dirty = true; }
      }
    }
    touched.clear();
    let settled = false;
    for (const rec of blocks.values()) {
      if (rec.status !== 'streaming' || now - rec.changedAt < STABLE_MS) continue;
      const parsed = isOurs(rec.text) ? null : parseBlock(rec.text, langHint(rec.pre));
      rec.parsed = parsed; rec.status = parsed ? 'ready' : 'ignored'; rec.hash = hash(norm(rec.text)); dirty = true; settled = true;
    }
    // a chat app may re-render a block we already ran: count fresh copies per hash
    if (settled) {
      const seen = new Map();
      for (const rec of orderedBlocks()) {
        if (!rec.fresh || !rec.hash || !['ready', 'done', 'running', 'manual'].includes(rec.status)) continue;
        const i = seen.get(rec.hash) || 0; seen.set(rec.hash, i + 1);
        if (rec.status === 'ready' && i < (doneCount.get(rec.hash) || 0)) { rec.status = 'done'; dirty = true; }
      }
    }
    maybeAuto(now);
    if (dirty) { dirty = false; render(); }
  }
  const orderedBlocks = () => [...blocks.values()].filter(r => r.pre.isConnected)
    .sort((a, b) => (a.pre.compareDocumentPosition(b.pre) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // Is the AI still writing? Only look at buttons that could be a Stop button, instead of measuring every button.
  const STOP_SEL = 'button[aria-label*="stop" i], button[title*="stop" i], button[data-testid*="stop" i], [role="button"][aria-label*="stop" i]';
  function generating() {
    for (const b of document.querySelectorAll(STOP_SEL)) {
      if (inHost(b)) continue;
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''}`;
      if (/\bstop(\s|-|_)?(generating|streaming|response|button)?\b/i.test(label) && !/stop sharing|stop recording/i.test(label) && visible(b)) return true;
    }
    return false;
  }

  // Auto-run speed limit, so the chat site isn't flooded with messages faster than it can handle.
  const MIN_GAP_MS = 3000, MAX_PER_MINUTE = 8;
  const autoSends = [];
  function paced(now) {
    while (autoSends.length && now - autoSends[0] > 60_000) autoSends.shift();
    const last = autoSends[autoSends.length - 1] || 0;
    if (now - last < MIN_GAP_MS) return false;
    if (autoSends.length >= MAX_PER_MINUTE) {
      if (!st.slowNote) { st.slowNote = true; note('Slowing down a little so the AI site can keep up. Homebox continues in a moment.', 'warn'); }
      return false;
    }
    if (st.slowNote) { st.slowNote = false; note(''); }
    return true;
  }

  function maybeAuto(now = Date.now()) {
    if (!st.auto || st.running || !st.paired || (st.info && st.info.paused)) return;
    let ready = null, streaming = false, newest = 0;
    for (const r of blocks.values()) {
      if (!r.fresh) continue;
      if (r.status === 'streaming') { streaming = true; break; }
      if (r.status === 'ready') { (ready = ready || []).push(r); newest = Math.max(newest, r.changedAt); }
    }
    if (!ready || streaming) return;
    if (now - newest < QUIET_MS || now - lastLenChange < QUIET_MS) return;
    if (!paced(now)) return;
    if (generating()) return;
    ready = orderedBlocks().filter(r => ready.includes(r));
    const lefts = ready.map(r => r.pre.getBoundingClientRect().left);
    if (IS_ARENA && Math.max(...lefts) - Math.min(...lefts) > 150) {
      ready.forEach(r => { r.status = 'manual'; });
      note('Arena is showing two answers side by side (Battle mode). Click Run on the answer you want, or use Direct Chat for full auto-run.', 'warn');
      openPanel(); return;
    }
    const max = (st.info && st.info.maxAutoSteps) || 30;
    if (st.step >= max) { st.auto = false; note(`Homebox stopped after ${max} rounds so the AI can't run forever. To continue, turn on "Let the AI keep working by itself" again.`, 'warn'); openPanel(); return; }
    autoSends.push(now);
    runRecs(ready, true);
  }

  // ---------- running ----------
  async function runRecs(recs, auto) {
    if (st.running) return;
    st.running = true; st.pending = [];
    if (!st.task) st.task = { last: Date.now(), seenGen: true };  // steps run by hand still show as working
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
    if (!started.ok) { recs.forEach(r => { r.status = 'ready'; doneCount.set(r.hash, Math.max(0, (doneCount.get(r.hash) || 1) - 1)); }); st.running = false; st.step -= 1; note(started.error, 'bad'); render(); return; }
    const runId = started.data.runId;
    let data = null;
    for (;;) {
      await sleep(300);
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
      // Very long chats make AI sites slow or unresponsive. Suggest a fresh chat once it gets big.
      st.sentChars = (st.sentChars || 0) + data.text.length;
      if (st.sentChars > 300_000 && !st.longChatWarned) {
        st.longChatWarned = true;
        setTimeout(() => { note('This chat is getting very long, which can make the AI site slow. If it starts to lag, open a new chat and start a task like: "Continue the previous task in the sandbox. Look at the files first."', 'warn'); openPanel(); }, 4000);
      }
      remember(data.text);
      if (data.cards && data.cards.length) { st.cards = [...data.cards, ...(st.cards || [])].slice(0, 8); openPanel(); }
      const fails = (data.results || []).filter(x => !x.ok).length;
      await putInChat(data.text, auto || st.auto, `${actions.length - fails}/${actions.length} actions OK`, data.attach || []);
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
  // Background tabs are asleep: many chat sites keep their Send button disabled until the tab is seen.
  // Try once quietly; if the message is still in the box, show the AI tab for a moment, send, and go back.
  async function pressSend(el, marker) {
    if (!document.hidden) return pressSendHere(el, marker);
    const stillThere = () => el.isConnected && norm(inputText(el)).includes(marker);
    const b = findSendButton(el);
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
    await sleep(1200);  // one wait: sleeping tabs stretch every timer to at least a second
    if (!stillThere()) return true;
    await bg('frontFor');
    for (let i = 0; i < 30 && document.hidden; i++) await sleep(100);
    const ok = await pressSendHere(el, marker);
    bg('frontDone');
    return ok;
  }
  async function pressSendHere(el, marker) {
    const stillThere = () => el.isConnected && norm(inputText(el)).includes(marker);
    const gone = async ms => { for (let t = 0; t < ms; t += 100) { await sleep(100); if (!stillThere()) return true; } return false; };
    await sleep(150);
    for (let i = 0; i < 8; i++) {
      const b = findSendButton(el);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        b.click();
        if (await gone(900)) return true;
      }
      await sleep(200);
    }
    const form = el.closest('form');
    if (form && form.requestSubmit) {
      try { form.requestSubmit(); } catch {}
      await sleep(900);
      if (!stillThere()) return true;
    }
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(900);
    return !stillThere();
  }
  // a screenshot from the app (data: URL) as a file the chat site accepts
  function dataFile(d, name) {
    const [head, body] = String(d).split(',');
    const bin = atob(body || ''), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' });
  }
  async function putInChat(text, send, summary, attach = []) {
    const el = findInput();
    if (!el) { note('Could not find the chat box. Copy the results below and paste them into the chat.', 'warn'); openPanel(); return; }
    const ok = await setInput(el, text);
    if (!ok) { note('Could not type into the chat box. Copy the results below and paste them into the chat.', 'warn'); openPanel(); return; }
    if (attach.length) { try { attachToChat(el, attach.map(a => dataFile(a.data, a.name))); } catch {} await sleep(2500); }
    if (!send) { note(`${summary}. Results are in the message box — press Send.`, 'ok'); return; }
    const sent = await pressSend(el, norm(text).slice(0, 40));
    note(sent ? `${summary}. Results sent to the AI.` : `${summary}. Results are in the message box — press Send.`, sent ? 'ok' : 'warn');
  }
  function remember(text) { ourTexts.push(norm(text)); if (ourTexts.length > 50) ourTexts.shift(); }

  // ---------- actions from the panel ----------
  async function startTask(task, pictures = []) {
    if (!st.info) return;
    st.auto = st.autoPref !== false;  // a new task starts fresh, whatever Stop or the round limit did last time
    beginTask();
    const prompt = st.info.prompt + task.trim();
    remember(prompt);
    st.step = 0;
    freshAfter = Math.min(freshAfter, Date.now());
    const el = findInput();
    if (!el) { note('Could not find the chat box on this page. Click into the chat\'s message box once, then press Start task again.', 'bad'); return; }
    if (!(await setInput(el, prompt))) { note('Could not type into the chat box. Click into it once, then press Start task again.', 'bad'); return; }
    // show the pictures to the AI: paste them into the chat box the same way you would with Ctrl+V
    if (pictures.length) { attachToChat(el, pictures); await sleep(1500); }
    const sent = await pressSend(el, norm(prompt).slice(0, 40));
    const pics = pictures.length ? ` If the picture${pictures.length > 1 ? 's are' : ' is'} not in the chat, drag ${pictures.length > 1 ? 'them' : 'it'} into the chat's message box yourself. ${pictures.length > 1 ? 'They are' : 'It is'} saved in your AI folder either way.` : '';
    note(sent ? `Task sent. The AI is working on it now.${pics}` : `The task is in the chat's message box. Press the chat's Send button.${pics}`, sent ? 'ok' : 'warn');
  }
  function attachToChat(el, files) {
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
  }  async function refresh() {
    const r = await bg('status');
    if (!r.ok) { st.app = false; st.paired = false; note(r.error, 'bad'); render(); return; }
    const d = r.data;
    st.app = d.app; st.paired = !!d.paired; st.info = d.info || null; st.pairing = d.pairing;
    if (st.info) remember(st.info.prompt);
    if (st.paired && st.noteKind === 'bad') note('');
    render();
  }
  async function loadAuto() {
    // on unless the user turned the switch off on this site (older versions also saved "off" after Stop or the
    // round limit, which left every later task waiting for Run: that old setting is ignored)
    st.autoPref = true;
    try { const k = `autoPref:${HOST}`; const v = await chrome.storage.local.get(k); if (v[k] === false) st.autoPref = false; } catch {}
    st.auto = st.autoPref;
  }
  function saveAuto() { st.autoPref = st.auto; try { chrome.storage.local.set({ [`autoPref:${HOST}`]: st.auto }); } catch {} }

  // ---------- UI (closed shadow DOM, so the page can't read or click it) ----------
  const hostEl = document.createElement('homebox-widget');
  hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:18px;bottom:110px;';
  try { chrome.storage.local.get('pillBottom').then(v => { if (v.pillBottom) hostEl.style.bottom = v.pillBottom + 'px'; }); } catch {}
  const root = hostEl.attachShadow({ mode: 'closed' });
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAHDUlEQVR4nN2ab4yUVxXGf+fcOzO7hbYUtiBLiWALNmIpphWkiFuUaClQWsJSFymgsUoXSSVFNkYJEDA1NmljQoCkNoaU7Eo2JqJ8r/3QmBhiWhAxYGk1JhoDlFl29s/Me+/xw+wMLOyyf2YWqk8y82H3fe99nnPPOfd57zvCNWhsbHTt7e0B4OHvrVtk6pqw+LhFmylQCwi3BmbQLSofIPp7iaHtvf2t71zPkWsJNexq8G/veTuZ++1nZ8sdqZfNWKXeOQsBi1Yc8lZCBFFBnCMmIYhwzLoKPzz5i6NnS1zLAsrkX2haKWn/pjp3d+jNYxDETBG5VZHvDzMzkSjgXCZNDCFr+eS5kwfbflfiLKUlmbP52RU+k/4N0VwMIRERf1tIDwIzS9Q5j0pIevNPnz509HhjY6MTDHmoed1MTel7GONijFHA3W7CA8EgqKoi5GIhPnzqQOsHimAi9pp6Pz6GED6u5AEEXAwhqPfjRew1BJO5zV9fIOr+YGYG6O0mOUxEERGLYaGa6EZJeTGoapsRQEVQkar3AAOTlBcT3ejFWGIhIIZWq8uLCGZGd28vCGR8CqdKrFIrFkP7OC9RxGZYiCDVoa+qhBjp7O5iZ9O3+Nk3t5JPEvJJgtMqZaggRc42w4PUVGdUcOrozveQcp79L+xg2aMLAai7awLff/1VOnI5xtfWkoQwxEjDhdRUrWi9c3R05ai7cwKHX9rNskcXksRAEgKLPjOX1h/sZcaUqXzUeQXvqtfoqiLAO8elKx3MnfkAbS37+NynZhNiwKvDO0eIgVn102nbsY/Fc+ZxoSNbNREVCRAEp44L2cs88chCjmzfw311kwkx4vQqQaeOGCMT77yLN178MU0NX+VCx2VUK3cpoxagIiBw6UqW5594moNbWrgjU0O0OGCxal8Xcqr8dNMWtq9eTzbXSYwRraC4R+V3nGpfZymw+xvPs2npCqyvRaoMTkb72muMka0r1zJt0mR2vnmIJAZqUmlCjCPmMmLpXh1dvb145zjQvINNS1cUJx7mhiUifa02sPqxx/nltp3cVTuOzu7uUdXFiAR458h2dfKJeyZyZPsels6bTxICTke+BzotFvf82XNoa9nHrPrpfNTZMWIRwxbgnePilQ7m3f9p2lp+wmc/eX+x01TQTUoiZk6pp3XHXhoeeoQLHdl+DWAoDClARHCqXMhe5qkFizny0m6m3jPphk4zWpQ61N3jxvPGiz9iw5ef5OKV7LA91E2LWBBijGS7u2hesYaWNRsABu00o4WqYmYIwt7nvsu0unt55ddHqE1n8M6VG8SIBRiGSHHQ9UuWEc36XGb1XXfJAIYY2bxsNdMm3svu1tcpJEmxew1y36BMnDqudOV48vOPsX7JMpIQkEGWNcZIEgIhDu+TxDBgyyylayEkrFywmHUNX6OjK4feJFWHWAFI+xTRYpH8QNeYoaqj2hHNbMCAqBRTN+WH3qaGvMLMUFGC3RixUoqdOHeGP//9fdI+ddN8BUCEQlLggan38cU584pjDBCaUl1ULGAwlCzAO385ycZXd5dTrDyplL8oPkNR/rsghBg52NzC8vmLKrIToxZgfYz+9P5fKYTAlAkTr/P510fvapS9c/wne4k/nj3N8vmLymONBhWf/aR9CoVyEY/o3lSq0ukrF2A2cPwONO9g2qTJAGRznXxn/8vkevr7neHk+FAYs9O3mVOmUT+pDoDOnu6i/R4DjJmAnkK+fArRk8+P1TRjJ8CrK0fdV8EzDTpPpQMMZri2HnqlvBGFGOnJ917t7XLze0eCigUUvYr2mburRfm3f/2znEICZNJpfB9hp8XrC0lS6fSVC5g6sY5cbzcu54gWyxpU+0e3t6tQ/J+AEyWby1E/sa7S6UcvwGnR5q76wpf49+WLvHv+LJlhWAkRIZ8kzKqfzoavLMewm5q1oVDRCogI3jm2LF9TyTAVYVhmLpTt743RNSs+4BQxgqLsc7ED1XFpRx/OYbAH6xnsfNTMyKTSOHVDPD5Wt02W5qpNZ4ZISevxmHwoXh+0JPbztdEiNekM754/y8+P/WpQ7z4WKM114twZajOZa1a4dAEmXsWS+KE34S117sEY+r8bMzNq0mlO/+M8J86duSXEr0dNOk3NAKtgQlTnXAzxLS8WD1sh2SwDJHAphWrTVTuBHxHM4oB1ICBWSEwsHhaAuc1Nx1xN5qmkp/dj93r1ephZ4msyPvT0/vbkgbZViiFmsi0mSac65wyq9fah6jAI6pyLSdJpJtswRBvXNuqpg63nk3yhCZWoqs7MKt/jqwwzS1TVoRKTfKHp1MHW841rG1Xb29tDw64Gf/rQ0eOWT55BJetrMh6Kiqvy1FEB61JG+JqMRyVr+eSZ04eOHm/Y1eDb29vD/8ePPUr4X/y5zX8BnVyLDArwACsAAAAASUVORK5CYII=';
  root.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{--bg:#fff;--ink:#1c1b19;--muted:#6a675f;--line:#e3e0d7;--soft:#f3f1ea;--accent:#2e6b5a;--ai:#fff;--warn:#a8511c;--warnbg:#fcf0e6;--bad:#a3322a;--badbg:#fbe9e7;--okbg:#e3efe9}
@media (prefers-color-scheme:dark){.wrap{--bg:#1d1c1a;--ink:#ecebe5;--muted:#9d998f;--line:#34332f;--soft:#262522;--accent:#62b39b;--ai:#0d1a16;--warn:#f0a36e;--warnbg:#35251a;--bad:#f2837a;--badbg:#3a1f1c;--okbg:#1d302a}}
.pill{touch-action:none;user-select:none;display:flex;align-items:center;gap:8px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:6px 12px 6px 6px;box-shadow:0 4px 18px rgba(0,0,0,.18);cursor:pointer;font-size:13.5px;font-weight:600;margin-left:auto;width:max-content;transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,border-color .25s;animation:hbIn .5s cubic-bezier(.2,.8,.2,1)}
.pill:hover{transform:translateY(-2px);box-shadow:0 8px 26px rgba(0,0,0,.22);border-color:var(--accent)}
.pill:active{transform:scale(.97)}
.pill.open{border-color:var(--accent)}
.pill.busy img{animation:hbSpin 1.6s linear infinite}
.pill.mini{padding:5px}.pill.mini #pillText,.pill.mini .dot{display:none}
.pill.done{border-color:#2fa37e}
.pill img{transition:transform .4s cubic-bezier(.2,.8,.2,1)}
.pill:hover img{transform:rotate(-10deg)}
.pill img{width:26px;height:26px;border-radius:7px}
.dot{width:8px;height:8px;border-radius:50%;background:#999}
.dot.on{background:#2fa37e}.dot.auto{background:#2fa37e;animation:hbPing 2s infinite}.dot.bad{background:#d24a3f}
.badge{background:#d9822b;color:#fff;border-radius:999px;font-size:11px;padding:1px 7px;animation:hbPop .4s cubic-bezier(.2,.8,.2,1),hbGlow 2s 0.4s infinite}
.panel{width:390px;max-width:calc(100vw - 36px);max-height:min(620px,calc(100vh - 90px));overflow:auto;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.22);margin-bottom:10px;font-size:13.5px;line-height:1.45;transform-origin:bottom right;animation:hbOpen .28s cubic-bezier(.2,.8,.2,1)}
.hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
.hd img{width:22px;height:22px;border-radius:6px}
.hd b{font-size:14.5px}.hd .ws{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.x{border:0;background:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px}
.bd{padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.btn{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;transition:background .2s,border-color .2s,transform .12s}
.btn:hover{background:var(--soft)}.btn:active{transform:scale(.96)}
.btn.primary:hover{filter:brightness(1.08);background:var(--accent)}
.x{transition:color .2s,transform .2s}.x:hover{color:var(--ink);transform:rotate(90deg)}
textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--okbg)}
.hint{font-size:11px;color:var(--muted);text-align:right;margin-top:-4px}
kbd{font:10.5px ui-monospace,Consolas,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--soft)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--ai);font-weight:600}
.btn.small{padding:3px 9px;font-size:12px}
.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.muted{color:var(--muted)}.small{font-size:12.5px}
textarea{width:100%;min-height:84px;border:1px solid var(--line);border-radius:9px;background:var(--soft);color:var(--ink);padding:8px;font-size:13px;resize:vertical}
.note{border-radius:9px;padding:8px 10px;font-size:12.5px;background:var(--soft);animation:hbFade .3s ease}
.note.ok{background:var(--okbg)}.note.warn{background:var(--warnbg)}.note.bad{background:var(--badbg)}
.appr{border:1px solid var(--warn);background:var(--warnbg);border-radius:10px;padding:10px;animation:hbSlide .35s cubic-bezier(.2,.8,.2,1)}
.appr .w{font-weight:600;word-break:break-word}
.appr pre{max-height:260px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;font:11.5px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.sw{display:flex;align-items:flex-start;gap:10px;cursor:pointer}
.sw input{display:none}
.track{width:36px;height:20px;border-radius:999px;background:var(--line);position:relative;flex:none;margin-top:1px;transition:background .15s}
.track:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.sw input:checked + .track{background:var(--accent)}
.sw input:checked + .track:after{left:18px}
.list{display:flex;flex-direction:column;gap:6px}
.item{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12.5px;transition:border-color .2s}
.item:hover{border-color:var(--accent)}
.item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.tag{font-size:11px;color:var(--muted)}
.code{font:700 26px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;margin:6px 0}
h4{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.guide ol{margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--ink)}
.guide li::marker{color:var(--accent);font-weight:700}
.full{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:var(--warn);background:var(--warnbg);border-radius:999px;padding:1px 8px;margin-left:4px}
.step{border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.sh{display:flex;align-items:center;gap:8px;font-size:13.5px}
.num{width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--ai);font-weight:700;font-size:12px;display:grid;place-items:center;flex:none}
.opt{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 7px;margin-left:auto}
.tip{font-size:12px;color:var(--muted);line-height:1.4}
.tip b{color:var(--ink)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer;transition:border-color .15s,background .15s}
.chip:hover{border-color:var(--accent);background:var(--okbg)}
.drop{border:1.5px dashed var(--line);border-radius:10px;padding:12px;text-align:center;font-size:12.5px;color:var(--muted);transition:border-color .15s,background .15s}
.drop.over{border-color:var(--accent);background:var(--okbg);color:var(--ink)}
.drop .btn{margin-top:6px}
.file{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;font-size:12.5px}
.file img{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none;background:var(--soft)}
.file .fi{width:30px;height:30px;border-radius:6px;display:grid;place-items:center;background:var(--soft);flex:none;font-size:14px}
.file .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file .sz{color:var(--muted);font-size:11.5px}
.chk{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;cursor:pointer}
.chk input{margin-top:2px;accent-color:var(--accent)}
.btn.big{width:100%;padding:10px 12px;font-size:14px}
.sep{border:0;border-top:1px solid var(--line);margin:4px 0}
.hidden{display:none!important}
.qsel{flex:1;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);padding:5px 8px;font-size:13px}
.ho{border:1.5px solid var(--accent);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;animation:hbSlide .35s cubic-bezier(.2,.8,.2,1)}
.ho .q{font-size:12.5px;background:var(--soft);border-radius:8px;padding:6px 8px;max-height:80px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.ho select{border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);padding:3px 6px;font-size:12px}
.ho .st{font-size:12.5px;display:flex;gap:8px;align-items:center}
.spin{width:12px;height:12px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:hbSpin .8s linear infinite;flex:none}
.cardx{border:1.5px solid var(--accent);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;margin-bottom:10px;animation:hbSlide .35s cubic-bezier(.2,.8,.2,1)}
.cardx .top{display:flex;align-items:center;gap:8px}.cardx .top b{flex:1;font-size:13.5px}
.fld{display:flex;flex-direction:column;gap:4px}.fld .top span{flex:1;font-size:12px;color:var(--muted);font-weight:600}
.ftxt{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.45;background:var(--soft);border-radius:8px;padding:7px 9px;max-height:160px;overflow:auto}
@keyframes hbIn{from{opacity:0;transform:translateY(12px) scale(.9)}to{opacity:1;transform:none}}
@keyframes hbOpen{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
@keyframes hbSlide{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
@keyframes hbFade{from{opacity:0}to{opacity:1}}
@keyframes hbPop{0%{transform:scale(.5)}60%{transform:scale(1.2)}100%{transform:scale(1)}}
@keyframes hbGlow{0%{box-shadow:0 0 0 0 rgba(217,130,43,.55)}70%,100%{box-shadow:0 0 0 7px rgba(217,130,43,0)}}
@keyframes hbPing{0%{box-shadow:0 0 0 0 rgba(47,163,126,.55)}70%,100%{box-shadow:0 0 0 6px rgba(47,163,126,0)}}
@keyframes hbSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<div class="wrap">
  <div class="panel hidden" id="panel">
    <div class="hd"><img src="${ICON}" alt=""><b>Homebox</b><span class="ws" id="ws"></span><button class="x" id="close" title="Close">×</button></div>
    <div class="bd">
      <div id="handoff"></div>
      <div id="state"></div>
      <div id="noteBox" class="note hidden"></div>
      <div id="approvals" class="list"></div>
      <div id="ask" class="hidden">
        <div id="siteCtl" class="hidden" style="margin-bottom:10px"></div>
        <div id="askMount"></div>
        <div id="qStatus" style="margin-top:10px"></div>
      </div>
      <div id="main" class="hidden">
        <div class="list" style="gap:10px">
          <div class="step">
            <div class="sh"><span class="num">1</span><b>Tell the AI what to do</b></div>
            <div class="tip">Type here, <b>not</b> in the chat's own message box. Homebox adds the instructions the AI needs to work on your computer.</div>
            <textarea id="task" placeholder="For example: Make a simple website for my bakery with a home page and a menu page."></textarea>
            <div class="chips" id="ideas"></div>
          </div>
          <div class="step">
            <div class="sh"><span class="num">2</span><b>Add pictures or files</b><span class="opt">optional</span></div>
            <div class="drop" id="drop">Drag pictures or files here, or paste a picture into the box above.<br><button class="btn small" id="pick">Choose files…</button><input type="file" id="fileIn" multiple hidden></div>
            <div id="fileList" class="list"></div>
            <label class="chk hidden" id="showAiRow"><input type="checkbox" id="showAi" checked><span>Also show the pictures to the AI, so it can see them. They are always saved in your AI folder too.</span></label>
          </div>
          <div class="step">
            <div class="sh"><span class="num">3</span><b>Start</b><span class="small muted" id="stepInfo" style="margin-left:auto"></span></div>
            <button class="btn primary big" id="start">Start task</button>
            <div class="tip">Homebox sends your task to the AI on this page. Shortcut: <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.</div>
          </div>
        </div>
        <hr class="sep" style="margin-top:12px">
        <label class="sw" style="margin-top:10px"><input type="checkbox" id="auto"><span class="track"></span><span><b>Let the AI keep working by itself</b><br><span class="small muted" id="autoHelp"></span></span></label>
        <div id="cards" style="margin-top:12px"></div>
        <div id="detected" style="margin-top:12px"></div>
        <div id="resultsBox" class="hidden" style="margin-top:12px">
          <h4>What Homebox sent back to the AI</h4>
          <textarea id="results" readonly style="min-height:60px;margin-top:6px"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn small" id="copyRes">Copy</button><button class="btn small" id="insertRes" title="Use this if the AI didn't get the results">Put in chat box</button></div>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn small" id="stop" title="Stops the AI's steps and turns off working by itself">Stop the AI</button><button class="btn small" id="openApp">Open Homebox app</button></div>
        <div class="tip" style="margin-top:8px">Show or hide this panel: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>. Drag the round button up or down if it covers something.</div>
      </div>
    </div>
  </div>
  <div class="pill" id="pill" title="Click to give the AI a task"><img src="${ICON}" alt=""><span class="dot" id="dot"></span><span id="pillText">Homebox</span><span class="badge hidden" id="badge"></span></div>
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
    if (st.open && st.quiet && st.askBox) setTimeout(() => st.askBox.focus(), 50);
  });
  $('close').addEventListener('click', trusted(() => { st.open = false; render(); }));
  $('task').addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startFromPanel(); }  // a scripted click would be ignored as untrusted
    e.stopPropagation();
  });
  root.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Escape') { st.open = false; render(); } });
  // ---------- step 1 and 2: the task text, ideas, and pictures/files ----------
  const MAX_FILES = 10, MAX_FILE_MB = 20;
  st.files = [];
  const isImage = f => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
  const sizeText = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  function addFiles(list) {
    for (const f of list) {
      if (st.files.length >= MAX_FILES) { note(`You can add up to ${MAX_FILES} files at a time.`, 'warn'); break; }
      if (f.size > MAX_FILE_MB * 1048576) { note(`"${f.name}" is larger than ${MAX_FILE_MB} MB, so it can't be added.`, 'warn'); continue; }
      st.files.push({ file: f, name: f.name, size: f.size, image: isImage(f), url: isImage(f) ? URL.createObjectURL(f) : null });
    }
    renderFiles();
  }
  function renderFiles() {
    $('fileList').innerHTML = st.files.map((f, i) => `<div class="file">${f.url ? `<img src="${f.url}" alt="">` : '<span class="fi">📄</span>'}<span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span class="sz">${sizeText(f.size)}</span><button class="x" data-rmfile="${i}" title="Remove">×</button></div>`).join('');
    $('showAiRow').classList.toggle('hidden', !st.files.some(f => f.image));
  }
  const toBase64 = f => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
  $('pick').addEventListener('click', trusted(() => $('fileIn').click()));
  $('fileIn').addEventListener('change', trusted(() => { addFiles($('fileIn').files); $('fileIn').value = ''; }));
  $('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
  $('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
  $('drop').addEventListener('drop', trusted(e => { e.preventDefault(); $('drop').classList.remove('over'); addFiles(e.dataTransfer.files); }));
  $('task').addEventListener('paste', trusted(e => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  }));
  async function startFromPanel() {
    if ($('start').disabled) return;
    let t = $('task').value.trim();
    if (!t && !st.files.length) { $('task').focus(); note('First type what you want the AI to do, in step 1.', 'warn'); return; }
    if (!t) t = 'Look at the files I added and tell me what they are. Then ask me what I would like to do with them.';
    $('start').disabled = true;
    try {
      const added = [];
      for (const f of st.files) {
        note(`Adding ${f.name} to your AI folder…`);
        const r = await bg('upload', { name: f.name, data: await toBase64(f.file) });
        if (!r.ok) { note(`Could not add ${f.name}: ${r.error}`, 'bad'); return; }
        added.push(r.data.path);
      }
      const pictures = $('showAi').checked ? st.files.filter(f => f.image).map(f => f.file) : [];
      if (added.length) t += `\n\nFiles I added to the sandbox folder: ${added.join(', ')}.${pictures.length ? ' I also attached the pictures to this message so you can see them.' : ''}`;
      await startTask(t, pictures);
      $('task').value = '';
      st.files.forEach(f => f.url && URL.revokeObjectURL(f.url));
      st.files = []; renderFiles();
    } finally { $('start').disabled = false; }
  }
  $('start').addEventListener('click', trusted(startFromPanel));  // ideas that match what is switched on in Homebox
  function ideas() {
    const p = (st.info && st.info.policy) || {};
    const list = [
      ['Make a website', 'Make a simple website for my business with a home page, a menu page and a contact page. Use plain HTML and CSS.'],
      ['Explain my folder', 'Look at the files in my folder and explain in simple words what is there. Do not change anything.'],
      ['Fix my code', 'Find the errors in my project and fix them. Explain each change in simple words.'],
    ];
    if (p.maya && p.maya !== 'off') list.push(['3D in Maya', 'In Maya, build a simple wooden table with four legs, grouped as table_grp.']);
    if (p.blender && p.blender !== 'off') list.push(['3D in Blender', 'In Blender, model a low-poly campfire with stones around it.']);
    if (p.excel && p.excel !== 'off') list.push(['Excel budget', 'In Excel, make a monthly budget sheet with income, expenses and totals.']);
    if (p.vscode && p.vscode !== 'off') list.push(['Fix VS Code errors', 'Look at the errors VS Code shows, fix them, then open the files you changed.']);
    if (p.github && p.github !== 'off') list.push(['Build my GitHub', 'Read my CV in the files folder with read_document and check my GitHub with github_info. Plan 5 portfolio projects that fit my skills and the jobs I want, and show me the plan first. Then build the first one in its own folder under projects/: working code, a README with what it does, how to run it and a screenshot, a LICENSE and a .gitignore. When it works, publish it as a public repository. Also make my profile README if I don\'t have one.']);
    list.push(['LinkedIn from my CV', 'Read my CV in the files folder with read_document. Write my LinkedIn profile from it: a headline, an About section, each job with 3 to 4 achievement points, and my top 10 skills. Show it with show_copy_text so I can copy each part into LinkedIn.']);
    if (p.browser && p.browser !== 'off') {
      list.push(['Help me apply for a job', 'Read my CV in the files folder with read_document. Then find the job application in my open tabs, read it, fill in what you can from my CV, and write a short cover letter for this job. Tell me what to check before I press Submit myself.']);
      list.push(['Write an email', 'Write a short, polite email to [who] about [what]. Open it as a Gmail draft so I can check it and press Send.']);
      list.push(['Play a game', 'Look at my open tabs and find the game. Take a screenshot, then play one move at a time. Take a new screenshot after each move.']);
    }
    return `<span class="small muted">Ideas:</span>${list.map(([label, text]) => `<button class="chip" data-idea="${esc(text)}">${esc(label)}</button>`).join('')}`;
  }

  $('auto').addEventListener('change', trusted(() => { st.auto = $('auto').checked; if (st.auto) st.step = 0; saveAuto(); render(); }));
  $('stop').addEventListener('click', trusted(async () => { st.auto = false; st.task = null; await bg('stop'); note('Stopped. Waiting steps were cancelled, and the AI no longer works by itself. Turn the switch back on to continue.', 'warn'); }));
  $('openApp').addEventListener('click', trusted(() => bg('openApp')));
  $('copyRes').addEventListener('click', trusted(async () => { try { await navigator.clipboard.writeText(st.lastResults); note('Results copied.', 'ok'); } catch { $('results').select(); document.execCommand('copy'); } }));
  $('insertRes').addEventListener('click', trusted(() => putInChat(st.lastResults, false, 'Ready')));
  root.addEventListener('click', trusted(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.idea) { $('task').value = b.dataset.idea; $('task').focus(); return; }
    if (b.dataset.ho === 'cancel') { st.handoff = null; bg('handoffCancel'); render(); return; }
    if (b.dataset.ho === 'hide') { st.handoff = null; render(); return; }
    if (b.dataset.ho === 'plain' && st.handoff) { st.handoff.computer = false; return; }
    if (b.dataset.uncard) { st.cards.splice(Number(b.dataset.uncard), 1); render(); return; }
    if (b.dataset.copy) {
      const [ci, fi] = b.dataset.copy.split(':').map(Number), fld = st.cards[ci] && st.cards[ci].fields[fi];
      if (fld) { try { await navigator.clipboard.writeText(fld.text); b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy'; }, 1600); } catch { note('Could not copy. Select the text and press Ctrl+C.', 'warn'); } }
      return;
    }
    if (b.dataset.rmfile) { const [gone] = st.files.splice(Number(b.dataset.rmfile), 1); if (gone && gone.url) URL.revokeObjectURL(gone.url); renderFiles(); return; }
    if (b.dataset.approve) {
      const id = b.dataset.approve, yes = b.dataset.v === '1';
      st.pending = st.pending.filter(p => p.id !== id);
      st.runLabel = yes ? 'Approved. Running…' : 'Denied.';
      render();
      bg('decide', { id, approve: yes });
    }
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
    if (b.dataset.act === 'ctlon' || b.dataset.act === 'ctloff') {
      const r = await bg('siteControl', { on: b.dataset.act === 'ctlon' });
      if (!r.ok) { st.siteCtl = { ...(st.siteCtl || {}), never: r.error }; } else st.siteCtl = r.data;
      render();
    }
    if (b.dataset.act === 'aitab' && st.remote && st.remote.aiTab) bg('focusTab', { tabId: st.remote.aiTab });
  }));

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render() {
    const ready = st.app && st.paired;
    const recs = orderedBlocks().filter(r => r.parsed && ['ready', 'manual', 'running', 'done'].includes(r.status));
    const waiting = recs.filter(r => r.status === 'ready' || r.status === 'manual').length;
    // pill
    $('dot').className = `dot ${!st.app || (st.app && !st.paired) ? 'bad' : st.auto ? 'auto' : 'on'}`;
    const remote = st.quiet && st.remote;
    const shownState = remote ? st.remote.state : st.status;
    $('pillText').textContent = remote ? `${st.remote.site}: ${STATUS_TEXT[shownState] || 'working…'}`
      : st.running ? (st.pending.length ? 'Needs your OK' : 'Running steps…')
      : STATUS_TEXT[shownState] || (st.quiet ? '' : 'Homebox');
    const badgeN = st.pending.length || (!st.auto ? waiting : 0);
    $('badge').textContent = badgeN; $('badge').classList.toggle('hidden', !badgeN);
    $('panel').classList.toggle('hidden', !st.open);
    $('pill').classList.toggle('open', st.open);
    // not an AI chat site: stay out of sight unless the user opened Homebox here themselves
    $('pill').classList.toggle('mini', !!st.quiet && !remote);
    $('pill').classList.toggle('busy', st.running || ['sending', 'thinking', 'running'].includes(shownState));
    $('pill').classList.toggle('done', shownState === 'done');
    $('pill').title = st.quiet ? (remote ? 'Click to see the AI working' : 'Homebox: click to ask the AI') : 'Click to give the AI a task';
    if (!st.open) return;
    $('panel').style.maxHeight = Math.max(220, innerHeight - (parseInt(hostEl.style.bottom) || 110) - 70) + 'px';
    $('ws').innerHTML = st.info ? `· AI folder: ${esc(st.info.workspace)}${st.info.paused ? ' (paused)' : ''}${st.info.fullAccess ? ' <span class="full">⚡ Full access</span>' : ''}` : '';
    // connection state
    let stateHtml = '';
    if (st.app === null) stateHtml = '<div class="muted small">Checking…</div>';
    else if (!st.app) stateHtml = `<div><b>The Homebox app isn't running.</b><div class="small muted" style="margin:4px 0 8px">Open the Homebox app on this computer, then try again.</div><button class="btn primary" data-act="retry">Try again</button></div>`;
    else if (!st.paired) stateHtml = st.pairing && st.pairing.status === 'waiting'
      ? `<div><b>Approve this code in the Homebox app</b><div class="code">${esc(st.pairing.code)}</div><div class="small muted">The Homebox window should have opened. Waiting…</div></div>`
      : `<div><b>Connect this browser to Homebox</b><div class="small muted" style="margin:4px 0 8px">One time only. You'll confirm a code in the Homebox app.</div><button class="btn primary" data-act="pair">Connect</button></div>`;
    const ho = st.handoff;
    const hoHtml = ho ? `<div class="ho"><div class="row" style="justify-content:space-between"><b>Task for ${esc(ho.siteName)}</b><span class="tag">${esc(ho.reason)}</span></div>
      <div class="q">${esc(ho.task)}</div>
      <div class="st">${ho.state === 'sent' || ho.state === 'gone' ? '' : '<span class="spin"></span>'}<span>${esc(ho.msg || '')}</span></div>
      ${ho.state === 'app' ? '<div class="row"><button class="btn small" data-ho="plain">Send it as a normal question instead</button></div>' : ''}
      <div class="row"><span class="small muted">Use another AI:</span><select id="hoSwitch"><option value="">Choose…</option>${ho.others.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
      ${ho.state === 'sent' || ho.state === 'gone' ? '<button class="btn small" data-ho="hide">Hide</button>' : '<button class="btn small" data-ho="cancel">Cancel</button>'}</div></div>` : '';
    if ($('handoff').__h !== hoHtml) { $('handoff').__h = hoHtml; $('handoff').innerHTML = hoHtml; }
    $('handoff').classList.toggle('hidden', !hoHtml);
    $('state').innerHTML = stateHtml;
    $('state').classList.toggle('hidden', !stateHtml || !!st.quiet);
    $('main').classList.toggle('hidden', !ready || !!st.quiet);
    $('ask').classList.toggle('hidden', !st.quiet);
    if (st.quiet) {
      const sc = st.siteCtl;
      const scHtml = !sc ? '' : sc.never ? `<div class="note small">${esc(sc.never)}</div>`
        : sc.allowed ? `<div class="row" style="justify-content:space-between;align-items:center"><span class="small">✓ The AI may use this site.</span><button class="btn small" data-act="ctloff">Stop</button></div>`
        : `<div class="note small"><b>The AI can't use this page yet.</b> It can read it and, with your settings, type, click and scroll here. It never types passwords or card details and never presses Send, Submit or Pay.<div class="row" style="margin-top:8px"><button class="btn primary small" data-act="ctlon">Let AI control this site</button></div></div>`;
      if ($('siteCtl').__h !== scHtml) { $('siteCtl').__h = scHtml; $('siteCtl').innerHTML = scHtml; }
      $('siteCtl').classList.toggle('hidden', !scHtml);
      const r = st.remote;
      const qs = r ? `<div class="row" style="justify-content:space-between;align-items:center"><span class="small">${['sending', 'thinking', 'running'].includes(r.state) ? '<span class="spin" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>' : ''}<b>${esc(r.site)}:</b> ${esc(STATUS_TEXT[r.state] || 'working…')}</span>${r.aiTab ? '<button class="btn small" data-act="aitab">Open the AI tab</button>' : ''}</div>${r.aiTab && st.aiList && !['done', 'failed'].includes(r.state) ? `<div class="row" style="margin-top:8px;align-items:center"><span class="small muted">Move to:</span><select id="qMove" class="qsel"><option value="">Choose another AI…</option>${st.aiList.filter(a => a.name !== r.site).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>` : ''}` : '';
      if ($('qStatus').__h !== qs) { $('qStatus').__h = qs; $('qStatus').innerHTML = qs; }
      return;
    }
    const noteText = st.running ? st.runLabel : st.note;
    $('noteBox').textContent = noteText;
    $('noteBox').className = `note ${st.running ? '' : st.noteKind}${noteText ? '' : ' hidden'}`;
    // approvals
    const apprHtml = st.pending.map(p => `<div class="appr"><div class="w">${esc(p.summary)}</div>
      ${p.preview != null ? `<pre>${esc(String(p.preview))}</pre>` : ''}
      <div class="row"><button class="btn primary small" data-approve="${esc(p.id)}" data-v="1">Approve</button><button class="btn small" data-approve="${esc(p.id)}" data-v="0">Deny</button></div></div>`).join('');
    if ($('approvals').__h !== apprHtml) { $('approvals').__h = apprHtml; $('approvals').innerHTML = apprHtml; }
    if (!ready) return;
    $('auto').checked = st.auto;
    const ideasHtml = ideas();
    if ($('ideas').__h !== ideasHtml) { $('ideas').__h = ideasHtml; $('ideas').innerHTML = ideasHtml; }
    $('autoHelp').textContent = st.auto
      ? `On (recommended): Homebox runs each step the AI writes and sends the answer back, until the AI says DONE. ${st.info && st.info.fullAccess ? 'Full access is on, so nothing waits for you.' : 'Anything that changes your files still asks you first.'}`
      : 'Off: Homebox waits for you to press Run next to each step the AI writes.';
    const max = (st.info && st.info.maxAutoSteps) || 30;
    $('stepInfo').textContent = st.auto && st.step ? `Step ${st.step}/${max}` : '';
    const cardsHtml = (st.cards || []).map((c, ci) => `<div class="cardx"><div class="top"><b>${esc(c.title)}</b><button class="btn small" data-uncard="${ci}">Hide</button></div>
      <div class="tip">Click <b>Copy</b>, then paste it into the website yourself.</div>
      ${c.fields.map((f, fi) => `<div class="fld"><div class="top"><span>${esc(f.label)}</span><button class="btn small" data-copy="${ci}:${fi}">Copy</button></div><div class="ftxt">${esc(f.text)}</div></div>`).join('')}</div>`).join('');
    if ($('cards').__h !== cardsHtml) { $('cards').__h = cardsHtml; $('cards').innerHTML = cardsHtml; }
    // detected blocks
    const shown = recs.slice(-8);
    $('detected').innerHTML = shown.length ? `<h4>Steps the AI wrote</h4><div class="list" style="margin-top:6px">${shown.map(r => {
      const acts = r.parsed.error ? [{ error: r.parsed.error }] : r.parsed.actions;
      const label = acts.map(describe).join(' · ');
      const side = r.status === 'manual' ? (r.pre.getBoundingClientRect().left < innerWidth / 2 ? ' (left)' : ' (right)') : '';
      const right = r.status === 'done' ? '<span class="tag">done</span>' : r.status === 'running' ? '<span class="tag">running…</span>'
        : `<button class="btn small" data-run="${r.id}" ${st.running ? 'disabled' : ''}>Run${side}</button>`;
      return `<div class="item"><span class="t" title="${esc(label)}">${esc(label)}</span>${right}</div>`;
    }).join('')}</div>` : `<div class="guide"><h4>What happens next</h4><ol>
        <li>The AI reads your task and writes small steps for Homebox.</li>
        <li>${st.auto ? 'Homebox runs them for you and sends the results back to the AI.' : 'Press <b>Run</b> next to each step that appears here.'}</li>
        <li>${st.info && st.info.fullAccess ? 'Full access is on, so changes happen without asking.' : 'When a step wants to change something, an <b>Approve</b> button appears here. Read it, then approve or deny.'}</li>
        <li>When the AI says <b>DONE</b>, open your AI folder to see the result.</li>
      </ol></div>`;
    $('resultsBox').classList.toggle('hidden', !st.lastResults);
    if ($('results').value !== st.lastResults) $('results').value = st.lastResults;
  }

  // ---------- tasks typed outside an AI tab (Ask AI in the toolbar, or "hb …" in the address bar) ----------
  const OUTAGE = /(at capacity|something went wrong|too many requests|rate limit(ed)?|usage limit|you('ve| have) (hit|reached) (your|the)|limit reached|reached (your|the) (limit|message limit)|out of (free )?messages|try again later|temporarily unavailable|service unavailable|bad gateway|internal server error|high demand|not available in your (country|region))/i;
  const LOGIN_TEXT = /^(log ?in|sign ?in|sign up|get started|continue with (google|apple|microsoft|email|phone))$/i;
  function loginWall(input) {
    if (input) return false;  // some sites let you chat without an account: a chat box means we can go
    if (/(^|\/)(login|log-in|signin|sign-in|signup|auth|oauth|onboarding|welcome)(\/|$|\?)/i.test(location.pathname)) return true;
    return [...document.querySelectorAll('button, a, [role="button"]')].some(b => !inHost(b) && visible(b) && LOGIN_TEXT.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  }
  // error banners and pop-ups, plus the whole page while it has no chat box
  function outage(input, strict) {
    const sel = strict ? '[role="alert"], [role="alertdialog"], [data-testid*="error" i]' : '[role="alert"], [role="alertdialog"], [data-testid*="error" i], [class*="error" i], [class*="limit" i]';
    const bits = [...document.querySelectorAll(sel)]
      .filter(e => !inHost(e) && visible(e)).map(e => (e.innerText || '').trim()).filter(t => t && t.length < 400);
    if (!input && document.body) bits.push((document.body.innerText || '').slice(0, 3000));
    const hit = bits.find(t => OUTAGE.test(t));
    return hit ? hit.match(OUTAGE)[0] : '';
  }
  const hoSay = (state, msg) => {
    if (!st.handoff) return;
    if (st.handoff.state !== state) bg('handoffState', { state });
    st.handoff.state = state; st.handoff.msg = msg;
    const s = { login: 'login', app: 'approval', needsend: 'approval', gone: 'failed', loading: 'sending', typing: 'sending', moving: 'sending' }[state];
    if (s) setStatus(s);
    render();
  };
  async function hoFail(reason) {
    hoSay('moving', `${st.handoff.siteName} is unavailable (${reason}). Moving your task to the next AI…`);
    const r = await bg('handoffFail', { reason });
    if (r.ok && r.data && r.data.none) hoSay('gone', 'No other AI is available right now. Try again later, or turn more AIs back on in the Homebox popup.');
  }
  async function runHandoff() {
    const started = Date.now();
    let noBoxSince = Date.now();
    while (st.handoff && st.handoff.state !== 'sent') {
      const ho = st.handoff, name = ho.siteName;
      const el = findInput();
      const down = outage(el);
      if (down) return hoFail(down);
      if (loginWall(el)) { noBoxSince = Date.now(); if (ho.state !== 'login') bg('aiLogin', { site: ho.site, needs: true }); hoSay('login', `Log in to ${name}. Homebox will type your task as soon as you're in.`); }
      else if (!el) {
        if (Date.now() - noBoxSince > 30_000) return hoFail('the chat box did not appear');
        hoSay('loading', `Waiting for ${name} to load…`);
      } else if (ho.computer && !(st.app && st.paired && st.info)) {
        hoSay('app', 'This task needs your computer. Open the Homebox app and connect this browser, and it starts by itself.');
        await refresh();
      } else {
        hoSay('typing', 'Typing your task…');
        await sleep(800);  // let the site finish setting up its chat box
        let sent;
        if (ho.computer) { await startTask(ho.task); sent = st.noteKind === 'ok'; }
        else {
          const box = findInput();
          sent = !!box && await setInput(box, ho.task) && await pressSend(box, norm(ho.task).slice(0, 40));
          note(sent ? 'Question sent.' : "Your question is in the chat box. Press the chat's Send button.", sent ? 'ok' : 'warn');
        }
        if (!ho.computer) beginTask();  // computer tasks started it in startTask
        hoSay('sent', sent ? `Sent to ${name}. Not happy with the answer? Pick another AI below.` : 'Your task is in the chat box. Press Send.');
        watchLimit();
        watchAnswer(norm(ho.computer ? st.info.prompt : ho.task).slice(0, 40));
        return;
      }
      if (Date.now() - started > 20 * 60_000) { hoSay('gone', 'Stopped waiting after 20 minutes. Type the task again when you are ready.'); bg('handoffCancel'); return; }
      await sleep(1000);
    }
  }
  // The AI should start answering soon after the task is sent. If the task is still sitting in the chat box,
  // press Send again; if nothing happens at all, tell the user, or move the task to the next AI.
  function watchAnswer(marker) {
    const sentAt = Date.now();
    let pressedAgain = false;
    const t = setInterval(async () => {
      if (!st.handoff) return clearInterval(t);
      const answered = (st.task && st.task.seenGen) || st.running || st.step > 0 || lastLenChange > sentAt + 6000;
      if (answered) { clearInterval(t); bg('aiLogin', { site: st.handoff.site, needs: false }); return; }
      const box = findInput();
      const stuck = box && marker && norm(inputText(box)).includes(marker);
      if (stuck && !pressedAgain && Date.now() - sentAt > 8000) { pressedAgain = true; await pressSend(box, marker); return; }
      if (stuck && Date.now() - sentAt > 20000) { clearInterval(t); hoSay('needsend', `Your task is in ${st.handoff.siteName}'s chat box but didn't send. Press its Send button.`); return; }
      if (Date.now() - sentAt > 60000) {
        clearInterval(t);
        if (st.step === 0 && !st.running) { st.handoff.state = 'retry'; hoFail('it did not answer'); }
      }
    }, 2000);
  }

  // out of messages right after sending, before anything ran on the computer: move the task on by itself
  function watchLimit() {
    const until = Date.now() + 90_000;
    const t = setInterval(() => {
      if (!st.handoff || Date.now() > until) return clearInterval(t);
      const hit = outage(findInput(), true);  // only real error pop-ups: the answer itself may mention errors
      if (!hit) return;
      clearInterval(t);
      if (st.step === 0 && !st.running) { st.handoff.state = 'retry'; hoFail(hit); }
      else hoSay('sent', `${st.handoff.siteName} says: "${hit}". Pick another AI below to continue there.`);
    }, 2000);
  }
  async function checkHandoff() {
    const r = await bg('handoff');
    if (!r.ok || !r.data) return;
    st.handoff = { ...r.data, state: 'loading', msg: 'Getting ready…' };
    openPanel();
    runHandoff();
  }
  root.addEventListener('change', e => {
    if (e.target.id !== 'hoSwitch' || !e.isTrusted || !e.target.value) return;
    const name = e.target.selectedOptions[0].textContent;
    bg('handoffSwitch', { site: e.target.value }).then(r => { if (!r.ok) note(r.error, 'bad'); else if (st.handoff) hoSay(st.handoff.state === 'sent' ? 'sent' : 'moving', st.handoff.state === 'sent' ? `Opened your task in ${name} in a new tab.` : `Moving your task to ${name}…`); });
  });

  // The AI asked the user to allow a site (its last results said so) and the user just did: let the AI try again.
  function siteAllowed(host) {
    if (!host || !st.lastResults || !st.lastResults.includes(`allowed Homebox to control ${host}`)) return;
    const msg = `[Homebox] The user has now allowed ${host}. Please try again.`;
    if (st.auto && !st.running && st.paired) { st.lastResults = ''; remember(msg); putInChat(msg, true, `${host} is allowed now`); }
    else { note(`${host} is allowed now. Tell the AI to try again.`, 'ok'); openPanel(); }
  }

  // ---------- status: what the AI is doing right now (shown on the button, the toolbar badge, and the page you came from) ----------
  st.status = '';
  function beginTask() { st.task = { last: Date.now(), seenGen: false }; setStatus('thinking'); }
  function activity() {
    if (!st.task) return '';
    if (st.pending.length) return 'approval';
    if (st.running) { st.task.last = Date.now(); return 'running'; }
    if (generating()) { st.task.seenGen = true; st.task.last = Date.now(); return 'thinking'; }
    // between rounds, or before the answer starts: still working for a little while
    return Date.now() - st.task.last < (st.task.seenGen ? 7000 : 25000) ? 'thinking' : 'done';
  }
  function setStatus(s) {
    if (s === st.status) return;
    st.status = s; st.statusAt = Date.now();
    bg('activity', { state: s });
    render();
  }
  setInterval(() => {
    if (st.quiet) return;
    const s = activity();
    if (s) setStatus(s);
    if (s === 'done') st.task = null;
    else if (!s && st.status === 'done' && Date.now() - st.statusAt > 8000) setStatus('');
  }, 1000);
  const STATUS_TEXT = { sending: 'Sending your task…', thinking: 'AI is thinking…', running: 'Running steps…', approval: 'Needs your OK', login: 'Log in needed', done: 'Done ✓', failed: 'Stopped' };

  // On a normal site (like YouTube) Homebox is just a small icon that shows what the AI is doing for this page.
  function remoteStatus(m) {
    if (!m.state) { st.remote = null; render(); return; }  // the AI tab finished and cleared its status
    st.remote = { state: m.state, site: m.site || 'the AI', aiTab: m.aiTab, at: Date.now() };
    render();
    if (m.state === 'done' || m.state === 'failed') setTimeout(() => { if (st.remote && Date.now() - st.remote.at >= 8000) { st.remote = null; render(); } }, 8100);
  }

  async function loadSiteControl() { const r = await bg('siteControlStatus'); if (r.ok) { st.siteCtl = r.data; render(); } }

  // the same Ask AI box as the toolbar popup (askbox.js)
  async function mountAsk() {
    if (st.askBox || !self.HB_ASKBOX) return;
    st.askBox = await self.HB_ASKBOX.mount($('askMount'), {
      onPage: true,
      send: o => bg('routeFromPage', { text: o.text, site: o.forced, computer: o.computer, stay: o.stay }),
      sent: r => { st.remote = { state: 'sending', site: r.data.site, aiTab: r.data.tabId, at: Date.now() }; render(); },
    });
  }
  // which AI: "Best for the task" or the one the user picked last time
  async function loadAiList() {
    const r = await bg('aiList');
    if (!r.ok) return;
    st.aiList = r.data.sites;
  }
  root.addEventListener('change', async e => {
    if (e.target.id !== 'qMove' || !e.isTrusted || !e.target.value || !st.remote) return;
    const r = await bg('handoffMove', { aiTab: st.remote.aiTab, site: e.target.value });
    if (!r.ok) { note(r.error, 'bad'); return; }
    st.remote = { state: 'sending', site: r.data.site, aiTab: r.data.tabId, at: Date.now() };
    $('qStatus').__h = null;
    render();
  });

  // ---------- boot ----------
  (document.documentElement || document.body).appendChild(hostEl);
  bg('siteKind').then(r => {
    if (r.ok && r.data && !r.data.chat) { st.quiet = true; observer.disconnect(); loadAiList(); mountAsk(); loadSiteControl(); render(); return; }
    loadAuto().then(refresh).then(checkHandoff);
  });
  setInterval(scan, 500);  // cheap now: only changed blocks are read
  setInterval(() => { if (st.quiet && !st.open) return; if (st.open || !st.paired) refresh(); }, 6000);
})();
