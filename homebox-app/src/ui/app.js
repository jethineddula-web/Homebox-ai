// Homebox control panel. Live state comes from /api/events; every change goes through POST /api/*.
(() => {
  const $ = id => document.getElementById(id);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg><use href="#i-${name}"/></svg>`;
  const html = (el, s) => { if (el && el.__html !== s) { el.__html = s; el.innerHTML = s; } };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let S = null;              // latest panel state from the app
  let page = 'home';
  let mayaResult = null;  // last live test this session; re-checked when the Maya or Apps page opens
  try { localStorage.removeItem('hb.maya'); } catch {}

  const PAGES = {
    home: 'Home', approvals: 'Approvals', activity: 'Activity', folders: 'AI folder',
    connect: 'Connect AI', apps: 'Apps', maya: 'Maya', settings: 'Settings', help: 'Help',
  };
  const ORDER = ['home', 'approvals', 'activity', 'folders', 'connect', 'apps', 'maya', 'settings', 'help'];

  // ---------- api ----------
  async function api(path, body = {}) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Homebox': '1' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Homebox error ${r.status}`);
    return j;
  }
  // run an action with a busy button and error toast
  async function act(btn, fn, okMsg) {
    if (btn) btn.classList.add('busy');
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast(e.message, 'bad'); }
    finally { if (btn) btn.classList.remove('busy'); }
  }

  // ---------- toasts & tooltips ----------
  function toast(msg, kind = '', action) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `${icon(kind === 'bad' ? 'x' : 'check')}<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
    if (action) t.querySelector('button').onclick = () => { action.run(); close(); };
    $('toasts').appendChild(t);
    const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
    setTimeout(close, kind === 'bad' ? 6000 : 3200);
  }
  async function copy(text, what = 'Copied') {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    toast(what);
  }
  let tipTimer = null;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    const tip = $('tip');
    if (!el) { tip.classList.remove('show'); return; }
    tipTimer = setTimeout(() => {
      tip.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      tip.classList.add('show');
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = r.left + r.width / 2 - w / 2, y = r.bottom + 8;
      if (el.closest('nav')) { x = r.right + 10; y = r.top + r.height / 2 - h / 2; }
      if (y + h > innerHeight - 8) y = r.top - h - 8;
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px';
      tip.style.top = y + 'px';
    }, 450);
  });

  // ---------- navigation ----------
  function go(p, opts = {}) {
    if (!PAGES[p]) p = 'home';
    const changed = p !== page;
    page = p;
    $$('.page').forEach(s => s.classList.toggle('on', s.dataset.page === p));
    $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === p));
    $('crumb').textContent = PAGES[p];
    $('crumb').style.animation = 'none'; void $('crumb').offsetWidth; $('crumb').style.animation = '';
    if (!opts.keepHash && location.hash.split('/')[0] !== '#' + p) history.replaceState(null, '', '#' + p);
    moveNavInd();
    closeMenu();
    if (changed && !opts.keepScroll) window.scrollTo({ top: 0 });
    if (p === 'connect') requestAnimationFrame(moveTabInd);
    if (p === 'settings') requestAnimationFrame(() => $$('.seg').forEach(moveSegInd));
    if (p === 'folders') lsSet('hb.foldersSeen', true);
    if (S) render();
    if ((p === 'maya' || p === 'apps') && S && S.policy.maya !== 'off') testMaya(null, true);
  }
  function moveNavInd() {
    const a = $('nav').querySelector('a.on'), ind = $('navInd');
    if (!a) { ind.style.opacity = 0; return; }
    const first = !ind.dataset.placed;
    if (first) ind.style.transition = 'none';
    ind.style.opacity = 1;
    ind.style.height = a.offsetHeight + 'px';
    ind.style.transform = `translateY(${a.offsetTop}px)`;
    if (first) { void ind.offsetWidth; ind.style.transition = ''; ind.dataset.placed = '1'; }
  }
  // #apps/blender opens that app's details
  function route() {
    const [p, sub] = location.hash.slice(1).split('/');
    if (p === 'setup') { go('home'); if (S) openWizard(Math.min(3, Number(sub) || 0)); return; }  // #setup or #setup/2 opens the setup guide
    go(p || 'home');
    if (p === 'apps' && sub && S && S.apps) openDrawer(sub);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { moveNavInd(); moveTabInd(); $$('.seg').forEach(moveSegInd); });
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); go(g.dataset.go); }
    const a = e.target.closest('#nav a');
    if (a) { e.preventDefault(); go(a.dataset.page); }
    const c = e.target.closest('[data-copy]');
    if (c) copy(c.dataset.copy);
    const cf = e.target.closest('[data-copy-from]');
    if (cf) { const src = $(cf.dataset.copyFrom); copy(src.value !== undefined ? src.value : src.textContent); }
  });
  window.addEventListener('scroll', () => document.querySelector('.topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });

  // mobile drawer
  const closeMenu = () => { $('side').classList.remove('open'); $('scrim').classList.remove('on'); };
  $('menuBtn').onclick = () => { $('side').classList.add('open'); $('scrim').classList.add('on'); };
  $('scrim').onclick = closeMenu;

  // tabs on the Connect page
  function moveTabInd() {
    const on = $('connectTabs').querySelector('button.on'), ind = $('connectTabs').querySelector('.tab-ind');
    if (!on || !on.offsetWidth) return;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  function showTab(t) {
    $$('#connectTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.tabpane').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== t));
    lsSet('hb.tab', t);
    moveTabInd();
  }
  $('connectTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  // segmented controls: sliding highlight
  function moveSegInd(seg) {
    let ind = seg.querySelector('.seg-ind');
    if (!ind) { ind = document.createElement('span'); ind.className = 'seg-ind'; seg.prepend(ind); }
    const on = seg.querySelector('button.on');
    if (!on || !on.offsetWidth) { ind.style.opacity = 0; return; }
    ind.style.opacity = 1;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }

  // ---------- theme ----------
  function applyUi() {
    const ui = (S && S.ui) || {};
    const root = document.documentElement;
    if (ui.theme === 'light' || ui.theme === 'dark') root.dataset.theme = ui.theme; else delete root.dataset.theme;
    root.classList.toggle('rm', !!ui.reduceMotion);
    document.body.classList.toggle('simple', !ui.advanced);
    if (!ui.advanced && /^(mcp|paste)$/.test(lsGet('hb.tab', 'ext'))) showTab('ext');
    const dark = ui.theme === 'dark' || (ui.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('themeBtn').innerHTML = icon(dark ? 'sun' : 'moon');
    lsSet('hb.ui', ui);
  }
  const cachedUi = lsGet('hb.ui', null);
  if (cachedUi) { S = { ui: cachedUi }; applyUi(); S = null; }
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    setUi({ theme: dark ? 'light' : 'dark' });
  }
  async function setUi(patch) {
    if (S) { S.ui = { ...S.ui, ...patch }; applyUi(); renderSettings(); }
    await act(null, () => api('/api/ui', patch));
  }
  $('themeBtn').onclick = toggleTheme;

  // ---------- numbers ----------
  function countTo(el, n) {
    const from = Number(el.dataset.n || 0);
    el.dataset.n = n;
    if (from === n || document.documentElement.classList.contains('rm') || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = n; return; }
    const t0 = performance.now(), dur = 500;
    const step = t => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (n - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- helpers for log entries ----------
  const TOOL_ICON = {
    read_file: 'file', list_dir: 'folder', search: 'search', workspace_info: 'folder', write_file: 'file', edit_file: 'file',
    make_dir: 'folder', move_path: 'arrow', delete_path: 'trash', run_command: 'term', maya_run_python: 'cube', maya_scene_info: 'cube',
    vscode_info: 'file', vscode_problems: 'search', vscode_open: 'open', github_info: 'search', github_publish: 'open',
    pause: 'pause', undo: 'undo', pair: 'link', workspace: 'folder', settings: 'gear', maya: 'cube', start: 'power',
  };
  const CHANGE_TOOLS = { has: t => ['write_file', 'edit_file', 'make_dir', 'move_path', 'delete_path', 'run_command'].includes(t) || isAppTool(t) };
  const isAppTool = t => /_run_(python|jsx|powershell)$/.test(t || '') || t === 'obs_request' || /^(vscode|github)_/.test(t || '');
  const AI_SOURCES = new Set(['extension', 'mcp', 'paste']);
  const timeOf = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function dayOf(iso) {
    const d = new Date(iso), now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function who(e) {
    if (e.source === 'you') return 'You';
    if (e.source === 'app') return 'Homebox';
    if (e.source === 'mcp') return 'MCP app';
    if (e.source === 'paste') return 'Paste';
    return e.site || e.device || 'Browser';
  }
  const seen = new Set();
  let seenReady = false;
  function entryHtml(e, compact) {
    const status = e.status || 'ok';
    const isNew = seenReady && !seen.has(e.id);
    seen.add(e.id);
    const canUndo = e.undo && !e.undone && !e.old;
    const tag = status !== 'ok' ? `<span class="pill-tag ${esc(status)}">${esc(status)}</span>` : e.undone ? '<span class="pill-tag">undone</span>' : '';
    return `<div class="entry ${esc(status)}${e.undone ? ' undone' : ''}${e.old ? ' old' : ''}${isNew ? ' new' : ''}">
      <span class="ic">${icon(TOOL_ICON[e.tool] || (isAppTool(e.tool) ? 'grid' : 'pulse'))}</span>
      <div class="body"><div class="s" title="${esc(e.summary)}">${esc(e.summary || e.tool)}</div>
        <div class="meta">${esc(who(e))}${e.error ? ` · <span class="err">${esc(e.error)}</span>` : ''}</div></div>
      ${tag}
      ${canUndo && !compact ? `<button class="btn small" data-undo="${esc(e.id)}">${icon('undo')}Undo</button>` : ''}
      <span class="when">${timeOf(e.time)}</span>
    </div>`;
  }

  // ---------- render ----------
  function render() {
    if (!S) return;
    applyUi();
    renderChrome();
    renderPairBar();
    if (page === 'home') renderHome();
    renderApprovals();
    if (page === 'activity') renderActivity();
    if (page === 'folders') renderFolders();
    if (page === 'connect') renderConnect();
    if (page === 'apps') renderApps();
    if (drawerApp) renderDrawer();
    if (wzStep >= 0) renderWizard();
    if (page === 'maya') renderMaya();
    if (page === 'settings') renderSettings();
    seenReady = true;
  }

  let lastPendingIds = new Set();
  function renderChrome() {
    $('ver').textContent = `v${S.version} · ${S.os}`;
    const n = S.pending.length;
    $('navBadge').textContent = n; $('navBadge').classList.toggle('hidden', !n);
    const pr = S.pairRequests.length;
    $('pairBadge').textContent = pr; $('pairBadge').classList.toggle('hidden', !pr);
    const appsOn = allApps().filter(a => a.mode !== 'off').length;
    $('appsCount').textContent = appsOn; $('appsCount').classList.toggle('hidden', !appsOn);
    document.title = n ? `(${n}) Homebox · approval needed` : 'Homebox';
    $('pauseBtn').classList.toggle('paused', S.paused);
    $('pauseText').textContent = S.paused ? 'AI access paused' : 'AI access on';
    $('pauseBtn').dataset.tip = S.paused ? 'Click to let AI work again.' : 'Instantly cuts off all AI access. Click again to allow it.';
    $('pausedBanner').classList.toggle('hidden', !S.paused);
    $('fullBanner').classList.toggle('hidden', !S.fullAccess || S.paused);
    $('fullSide').checked = !!S.fullAccess;
    $('fullSettings').checked = !!S.fullAccess;
    $('mayaDot').className = `dot ${S.policy.maya === 'off' ? '' : mayaResult && mayaResult.ok ? 'on' : 'warn'}`;
    // notify about new approvals when the window is in the background
    const ids = new Set(S.pending.map(p => p.id));
    const fresh = S.pending.filter(p => !lastPendingIds.has(p.id));
    if (fresh.length && lastPendingIds.size + fresh.length > 0 && booted) {
      if (document.hidden && S.ui.notifications && 'Notification' in window && Notification.permission === 'granted') {
        const nt = new Notification('Homebox needs your OK', { body: fresh[0].summary, icon: '/icon.png', tag: 'homebox-approval' });
        nt.onclick = () => { window.focus(); go('approvals'); nt.close(); };
      }
      if (page !== 'approvals' && !document.hidden) toast(`AI wants to: ${fresh[0].summary}`, '', { label: 'Review', run: () => go('approvals') });
    }
    lastPendingIds = ids;
  }

  function renderPairBar() {
    html($('pairBar'), S.pairRequests.map(p => `<div class="pairreq">
      <span class="code">${esc(p.code)}</span>
      <div><b>${esc(p.name)} wants to connect</b><div class="small muted">Approve only if this code matches the one in your browser.</div></div>
      <button class="btn primary small" data-pair="${esc(p.id)}" data-v="1">${icon('check')}Approve</button>
      <button class="btn small" data-pair="${esc(p.id)}" data-v="0">Deny</button></div>`).join(''));
  }

  function renderHome() {
    renderNextStep();
    const h = new Date().getHours();
    $('greeting').textContent = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('hFolder').textContent = S.workspace.name || '—';
    $('hFolderPath').textContent = S.workspace.missing ? 'Folder is missing, pick another' : S.workspace.active;
    countTo($('hBrowsers'), S.devices.length);
    countTo($('hPending'), S.pending.length);
    $('hPending').closest('.stat').classList.toggle('alert', S.pending.length > 0);
    const onApps = allApps().filter(a => a.mode !== 'off');
    $('hApps').textContent = `${onApps.length} on`;
    $('hAppsSub').textContent = onApps.length ? onApps.map(a => a.name).join(', ') : 'Blender, Photoshop, Excel…';

    const aiRuns = S.log.filter(e => AI_SOURCES.has(e.source) && e.status === 'ok');
    const steps = [
      { done: lsGet('hb.foldersSeen', false) || S.workspace.list.length > 1, t: 'Choose your AI folder', s: 'The only folder AI can see.', go: 'folders' },
      { done: S.devices.length > 0, t: 'Connect your browser', s: 'Install the extension and approve the code.', go: 'connect' },
      { done: aiRuns.length > 0, t: 'Give the AI its first task', s: 'Use the Homebox button on an AI chat site.', go: 'help' },
      { done: allApps().some(a => a.mode !== 'off' && a.test && a.test.ok), t: 'Optional: connect an app', s: 'Maya, Blender, Photoshop, Excel, OBS and more.', go: 'apps' },
    ];
    const done = steps.filter(x => x.done).length;
    $('checkLabel').textContent = `${done} of ${steps.length} done`;
    $('checkBar').style.width = `${(done / steps.length) * 100}%`;
    html($('checklist'), steps.map(x => `<li class="${x.done ? 'done' : ''}" data-go="${x.go}">
      <span class="tick">${icon('check')}</span><span class="t"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span><span class="go">${icon('chev')}</span></li>`).join(''));

    const today = new Date().toDateString();
    const todays = S.log.filter(e => !e.old && new Date(e.time).toDateString() === today && AI_SOURCES.has(e.source));
    html($('todayStats'), `<div><b>${todays.filter(e => e.status === 'ok').length}</b><span>actions done</span></div>
      <div><b>${todays.filter(e => e.status === 'ok' && CHANGE_TOOLS.has(e.tool)).length}</b><span>changes</span></div>
      <div><b>${todays.filter(e => e.status === 'denied' || e.status === 'blocked').length}</b><span>denied</span></div>`);
    const recent = S.log.slice(-6).reverse();
    html($('hLog'), recent.length ? recent.map(e => entryHtml(e, true)).join('')
      : `<div class="empty"><div class="art">${icon('pulse')}</div><b>Nothing yet</b>What the AI does will show up here.</div>`);
  }

  // approvals keep their DOM nodes so the countdown bars don't restart
  function renderApprovals() {
    const box = $('approvals');
    const ids = new Set(S.pending.map(p => p.id));
    for (const el of $$('.appr', box)) if (!ids.has(el.dataset.id) && !el.classList.contains('leaving')) {
      el.classList.add('leaving'); setTimeout(() => el.remove(), 300);
    }
    for (const p of S.pending) {
      if (box.querySelector(`.appr[data-id="${CSS.escape(p.id)}"]`)) continue;
      const el = document.createElement('div');
      el.className = 'appr'; el.dataset.id = p.id;
      const capLabel = (S.caps[p.cap] && S.caps[p.cap].label) || p.cap;
      const left = Math.max(0, p.expires - Date.now()), total = p.expires - p.created;
      el.innerHTML = `<div class="appr-hd"><span class="ic">${icon(TOOL_ICON[p.tool] || 'shield')}</span>
        <div class="w"><b>${esc(p.summary)}</b><span>${esc(capLabel)} · from ${esc(who(p))}</span></div></div>
        ${p.preview != null ? `<pre>${esc(p.preview)}</pre>` : ''}
        <div class="appr-ft"><button class="btn primary" data-decide="${esc(p.id)}" data-v="1">${icon('check')}Approve</button>
          <button class="btn" data-decide="${esc(p.id)}" data-v="0">${icon('x')}Deny</button>
          <span class="grow"></span><span class="small muted" data-left="${p.expires}"></span></div>
        <div class="timer"><i></i></div>`;
      box.appendChild(el);
      const bar = el.querySelector('.timer i');
      bar.style.transform = `scaleX(${left / total})`;
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `transform ${left}ms linear`; bar.style.transform = 'scaleX(0)'; }));
    }
    tickCountdowns();
    $$('.appr', box).forEach(el => el.classList.remove('first'));
    const first = $$('.appr:not(.leaving)', box)[0];
    if (first) first.classList.add('first');
    const empty = box.querySelector('.empty');
    if (!S.pending.length && !empty) box.insertAdjacentHTML('beforeend', `<div class="empty"><div class="art">${icon('shield')}</div><b>All clear</b>When AI wants to change something, it will wait for you here.</div>`);
    if (S.pending.length && empty) empty.remove();
  }
  function tickCountdowns() {
    for (const el of $$('[data-left]')) {
      const s = Math.max(0, Math.round((Number(el.dataset.left) - Date.now()) / 1000));
      el.textContent = `Auto-denies in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
  }
  setInterval(tickCountdowns, 1000);

  let actFilter = 'all';
  function renderActivity() {
    const q = $('actSearch').value.trim().toLowerCase();
    const match = e => {
      if (actFilter === 'changes' && !(CHANGE_TOOLS.has(e.tool) && e.status === 'ok')) return false;
      if (actFilter === 'denied' && !['denied', 'blocked'].includes(e.status)) return false;
      if (actFilter === 'error' && e.status !== 'error') return false;
      if (actFilter === 'you' && e.source !== 'you') return false;
      return !q || `${e.summary} ${e.tool} ${who(e)} ${e.error || ''}`.toLowerCase().includes(q);
    };
    const list = S.log.filter(match).reverse();
    let out = '', lastDay = '';
    for (const e of list) {
      const d = dayOf(e.time);
      if (d !== lastDay) { out += `<div class="day">${esc(d)}</div>`; lastDay = d; }
      out += entryHtml(e, false);
    }
    html($('log'), out || `<div class="empty"><div class="art">${icon('search')}</div><b>No matching activity</b>Try another filter.</div>`);
  }
  $('actFilter').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    actFilter = c.dataset.f;
    $$('#actFilter .chip').forEach(x => x.classList.toggle('on', x === c));
    renderActivity();
  });
  $('actSearch').addEventListener('input', () => renderActivity());

  function renderFolders() {
    html($('folderList'), S.workspace.list.map((w, i) => {
      const on = w === S.workspace.active;
      const name = w.split(/[\\/]/).filter(Boolean).pop() || w;
      return `<div class="folder${on ? ' active' : ''}" style="animation-delay:${i * 40}ms">
        <span class="ic">${icon('folder')}</span>
        <div class="body"><b>${esc(name)}${on ? '<span class="tag-on">Active</span>' : ''}</b><div class="path" title="${esc(w)}">${esc(w)}</div></div>
        <div class="acts">${on ? `<button class="btn small" data-open-ws>${icon('open')}Open</button>`
          : `<button class="btn small primary" data-select="${esc(w)}">Use this folder</button>`}
          ${S.workspace.list.length > 1 ? `<button class="btn small ghost" data-remove="${esc(w)}" data-tip="Remove from list (doesn't delete files)">${icon('trash')}</button>` : ''}</div>
      </div>`;
    }).join(''));
    $('pickBtn').classList.toggle('hidden', !S.canPickFolder);
    const sugg = S.suggestions.filter(s => !S.workspace.list.includes(s));
    html($('suggest'), sugg.length ? `<span class="muted small">Suggestions:</span>${sugg.map(s => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}` : '');
  }

  const SITES = [
    ['Arena', 'https://arena.ai', '#6b4de6'], ['ChatGPT', 'https://chatgpt.com', '#10a37f'], ['Claude', 'https://claude.ai', '#d97757'],
    ['Gemini', 'https://gemini.google.com', '#4285f4'], ['DeepSeek', 'https://chat.deepseek.com', '#4d6bfe'], ['Grok', 'https://grok.com', '#222'],
    ['Qwen', 'https://chat.qwen.ai', '#615ced'], ['Mistral', 'https://chat.mistral.ai', '#fa520f'], ['Perplexity', 'https://www.perplexity.ai', '#1f8a8a'],
    ['Copilot', 'https://copilot.microsoft.com', '#0078d4'], ['Kimi', 'https://www.kimi.com', '#111'], ['Poe', 'https://poe.com', '#5d5cde'],
  ];
  html($('sites'), SITES.map(([n, u, c]) => `<a class="site" href="${u}" target="_blank" rel="noopener"><i>${n[0]}</i>${n}</a>`).join(''));

  function renderConnect() {
    const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 2 ? 'active now' : m < 60 ? `seen ${m} min ago` : m < 1440 ? `seen ${Math.round(m / 60)} h ago` : `seen ${Math.round(m / 1440)} days ago`; };
    html($('devices'), S.devices.length ? S.devices.map(d => `<div class="device">
      <span class="dot ${Date.now() - d.lastSeen < 120000 ? 'on' : ''}"></span>
      <div class="body"><b>${esc(d.name)}</b><small>${esc(ago(d.lastSeen))}</small></div>
      <button class="btn small ghost" data-revoke="${esc(d.id)}">Disconnect</button></div>`).join('')
      : `<div class="empty"><div class="art">${icon('link')}</div><b>No browser yet</b>Install the extension, then click Connect in it.</div>`);
    $('mcpUrl').textContent = S.mcp.localUrl;
    moveTabInd();
  }

  function renderMaya() {
    const on = S.policy.maya !== 'off';
    $('mayaCap').checked = on;
    $('mayaAuto').checked = !!S.maya.autoStart;
    $('mUserSetup').textContent = S.maya.userSetup;
    html($('mayaGuide'), window.HB_GUIDES.render('maya', S.maya));
    const r = mayaResult;
    $('mDot').className = `dot big ${!on ? '' : r ? (r.ok ? 'on' : 'bad') : 'warn'}`;
    $('mStatus').textContent = !on ? 'Maya control is off' : r ? (r.ok ? `Connected to Maya ${r.version}` : 'Maya did not answer') : 'Not tested';
    $('mStatusSub').textContent = !on ? 'Turn on "Let AI control Maya" below.' : r ? (r.ok ? `Tested ${timeOf(r.at)}` : r.error) : 'Click Test to check that Maya answers.';
  }

  // ---------- apps ----------
  // Maya has its own page; on the Apps page it is one more card that links there.
  const mayaApp = () => ({ id: 'maya', name: 'Maya', cat: '3D & VFX', abbr: 'M', lang: 'Python', blurb: 'Build live in Autodesk Maya with maya.cmds.', mode: S.policy.maya, test: mayaResult });
  const allApps = () => (S && S.apps ? [mayaApp(), ...S.apps] : []);
  const appById = id => allApps().find(a => a.id === id);
  // light brand colors get dark letters
  // Homebox's own tiles: an icon for the kind of app, never another company's logo colours or letters
  const CAT_ICON = { '3D & VFX': 'cube', Adobe: 'image', Office: 'file', CAD: 'grid', Streaming: 'play', Code: 'term' };
  const appIcon = (a, big) => `<span class="app-ic${big ? ' big' : ''}">${icon(CAT_ICON[a.cat] || 'grid')}</span>`;
  function appState(a) {
    if (a.mode === 'off') return ['', 'Off'];
    if (!a.test) return ['warn', 'On · not tested yet'];
    return a.test.ok ? ['on', `Connected${a.test.version ? ` · ${String(a.test.version).split(/\s/)[0]}` : ''}`] : ['bad', 'On · not reachable'];
  }

  let appCat = 'All';
  function renderApps() {
    const apps = allApps();
    const cats = ['All', ...new Set(apps.map(a => a.cat))];
    html($('appFilter'), cats.map(c => `<button class="chip${c === appCat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}<span class="n">${c === 'All' ? apps.length : apps.filter(a => a.cat === c).length}</span></button>`).join(''));
    const q = $('appSearch').value.trim().toLowerCase();
    const list = apps.filter(a => (appCat === 'All' || a.cat === appCat) && (!q || `${a.name} ${a.cat} ${a.blurb}`.toLowerCase().includes(q)));
    html($('appGrid'), list.map((a, i) => {
      const [dot, text] = appState(a);
      return `<div class="app-card${a.mode !== 'off' ? ' on' : ''}" role="button" tabindex="0" data-app="${a.id}" style="animation-delay:${Math.min(i, 12) * 25}ms">
        <div class="top">${appIcon(a)}<div><b>${esc(a.name)}</b><span>${esc(a.cat)} · ${esc(a.lang)}</span></div>
          <label class="switch" data-tip="${a.mode === 'off' ? 'Let AI control' : 'Stop AI controlling'} ${esc(a.name)}"><input type="checkbox" data-app-toggle="${a.id}"${a.mode !== 'off' ? ' checked' : ''}><span></span></label></div>
        <p>${esc(a.blurb)}</p>
        <div class="foot"><span class="state"><i class="dot ${dot}"></i><span>${esc(text)}</span></span><span>${a.id === 'maya' ? 'Open page' : 'Set up'} →</span></div>
      </div>`;
    }).join('') || `<div class="empty"><div class="art">${icon('search')}</div><b>No app matches</b>Try another name.</div>`);
    const n = apps.filter(a => a.mode !== 'off').length;
    $('appsCount').textContent = n; $('appsCount').classList.toggle('hidden', !n);
  }
  $('appFilter').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) { appCat = c.dataset.cat; renderApps(); } });
  $('appSearch').addEventListener('input', () => renderApps());
  $('appGrid').addEventListener('click', e => {
    if (e.target.closest('.switch')) return;
    const card = e.target.closest('.app-card');
    if (card) card.dataset.app === 'maya' ? go('maya') : openDrawer(card.dataset.app);
  });
  $('appGrid').addEventListener('keydown', e => { const card = e.target.closest('.app-card'); if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); } });
  document.addEventListener('change', e => {
    const t = e.target.closest('[data-app-toggle]');
    if (t) setAppMode(t.dataset.appToggle, t.checked);
    const au = e.target.closest('[data-app-autostart]');
    if (au) {
      const id = au.dataset.appAutostart, on = au.checked, isVsc = id === 'vscode';
      au.disabled = true;
      if (isVsc && on) toast('Installing the Homebox extension in VS Code…');
      act(null, () => api('/api/apps/autostart', { id, on }),
        isVsc ? (on ? 'Installed. Now reload VS Code (step 3).' : 'Homebox extension removed from VS Code') : (on ? 'Automatic start installed' : 'Automatic start removed'))
        .then(() => { au.disabled = false; return api('/api/apps/test', { id }).catch(() => {}); });
    }
  });
  function setAppMode(id, on) {
    const a = appById(id);
    if (S.policy) S.policy[id] = on ? 'ask' : 'off';
    const inApps = (S.apps || []).find(x => x.id === id);
    if (inApps) inApps.mode = on ? 'ask' : 'off';
    render();
    return act(null, () => api('/api/policy', { [id]: on ? 'ask' : 'off' }), on ? `${a.name} on. Start a new chat so the AI knows about it.` : `${a.name} off`)
      .then(() => { if (on) id === 'maya' ? testMaya(null, true) : testAppNow(id, true); });
  }
  async function testAppNow(id, quiet, btn) {
    try {
      if (btn) btn.classList.add('busy');
      const r = await api('/api/apps/test', { id });
      if (!quiet) toast(r.ok ? `${appById(id).name} answered${r.version ? ` (${r.version})` : ''}` : r.error, r.ok ? '' : 'bad');
    } catch (e) { if (!quiet) toast(e.message, 'bad'); }
    finally { if (btn) btn.classList.remove('busy'); }
  }

  let drawerApp = null;
  function openDrawer(id) {
    drawerApp = id;
    $('drawer').classList.remove('hidden', 'closing');
    $('dBody').__html = null;
    renderDrawer();
    const a = appById(id);
    if (a && a.mode !== 'off') testAppNow(id, true);
    $('dBody').scrollTop = 0;
    setTimeout(() => $('dClose').focus(), 50);
  }
  function closeDrawer() {
    if (!drawerApp) return;
    drawerApp = null;
    if (location.hash.includes('/')) history.replaceState(null, '', '#apps');
    $('drawer').classList.add('closing');
    setTimeout(() => $('drawer').classList.add('hidden'), 220);
  }
  $('dClose').onclick = closeDrawer;
  $('drawerScrim').onclick = closeDrawer;

  function renderDrawer() {
    const a = appById(drawerApp);
    if (!a) return closeDrawer();
    $('dIcon').outerHTML = `<span id="dIcon">${appIcon(a, true)}</span>`;
    $('dTitle').textContent = a.name;
    $('dSub').textContent = `${a.cat} · the AI writes ${a.lang}`;
    const [dot, text] = appState(a);
    const on = a.mode !== 'off';
    const t = a.test;
    const auto = a.autoStart;
    const noUndo = a.id === 'excel' || a.id === 'powerpoint';
    html($('dBody'), `
      <div class="card">
        <div class="status-row"><span class="dot big ${dot}"></span><div class="grow0"><b>${esc(text)}</b>
          <div class="muted small">${t ? (t.ok ? `Tested ${timeOf(new Date(t.at).toISOString())}` : esc(t.error)) : on ? 'Click Test to check that it answers.' : 'Turn it on to let AI use it.'}</div></div>
          <button class="btn small" data-app-test="${a.id}">${icon('pulse')}Test connection</button></div>
        <div class="setting mt"><div><b>Let AI control ${esc(a.name)}</b><div class="muted small">${a.kind === 'github' ? 'Every upload asks you first and shows every file that will go online, even with Full access.' : S.fullAccess ? 'Full access is on, so steps run without asking.' : 'Every step still asks you first.'}</div></div>
          <label class="switch"><input type="checkbox" data-app-toggle="${a.id}"${on ? ' checked' : ''}><span></span></label></div>
        ${auto ? `<div class="setting"><div><b>${esc(auto.label || 'Start automatically')}</b><div class="muted small">${a.id === 'vscode' ? (auto.available ? 'Uses VS Code\'s own installer. Reload VS Code afterwards.' : 'VS Code was not found on this computer.') : auto.available ? `Starts the Homebox bridge every time ${esc(a.name)} opens.` : `Open ${esc(a.name)} once, then come back here.`}</div></div>
          <label class="switch"><input type="checkbox" data-app-autostart="${a.id}"${auto.on ? ' checked' : ''}${auto.available ? '' : ' disabled'}><span></span></label></div>` : ''}
      </div>
      <div class="card"><h2>Set up ${esc(a.name)} step by step</h2>${window.HB_GUIDES.render(a.id, a)}
        ${a.obs ? `<form class="row wrap mt" id="obsForm"><input class="input narrow" id="obsPort" value="${esc(a.obs.port)}" inputmode="numeric" aria-label="Port">
          <input class="input grow" id="obsPass" type="password" placeholder="${a.obs.hasPassword ? 'Password saved — type to change' : 'WebSocket password'}" autocomplete="off">
          <button class="btn" type="submit">Save</button></form>` : ''}
      </div>
      <div class="card"><h2>What the AI can do</h2>
        <p class="muted">${esc(a.blurb)} The AI uses the <code>${esc(a.tool)}</code> tool${a.port ? ` (port ${a.port} on this computer only)` : ''}.</p>
        ${noUndo ? `<p class="small mt" style="color:var(--warn)">${esc(a.name)} can't undo changes made by scripts. Save your file before letting AI work in it.</p>` : ''}
        <p class="small muted mt">${a.kind === 'github' ? 'Homebox runs git and the GitHub CLI itself: the AI never gets a command line or your login. It refuses to publish your whole AI folder, keys and passwords, or documents that look like a CV. New repositories are private unless you ask for public.' : a.kind === 'obs' ? 'Requests can change what you stream or record.' : a.kind === 'vscode' ? 'The AI only sees files inside your sandbox folder. Code changes, including deletes, are normal Homebox changes: they ask first and can be undone on the Activity page.' : 'Scripts can reach outside the sandbox folder. Read each step before you approve it.'}</p>
      </div>`);
  }
  $('dBody').addEventListener('click', e => { const b = e.target.closest('[data-app-test]'); if (b) testAppNow(b.dataset.appTest, false, b); });
  $('dBody').addEventListener('submit', e => {
    if (e.target.id !== 'obsForm') return;
    e.preventDefault();
    const body = { port: $('obsPort').value };
    if ($('obsPass').value) body.password = $('obsPass').value;
    act(e.submitter, async () => { await api('/api/apps/obs', body); $('obsPass').value = ''; await testAppNow('obs'); });
  });

  const MODE_LABEL = { auto: 'Automatic', ask: 'Ask me', off: 'Off' };
  function renderSettings() {
    if (!S || !S.caps) return;
    const box = $('policy');
    html(box, Object.entries(S.caps).filter(([, c]) => !c.app).map(([k, c]) => {
      const opts = ['read', 'write', 'browser'].includes(k) ? ['auto', 'ask', 'off'] : ['ask', 'off'];
      return `<div class="setting${k === 'exec' ? ' adv' : ''}"><div><b>${esc(c.label)}</b><div class="muted small">${esc(c.help)}</div>${explainMode(k, S.policy[k])}</div>
        <div class="seg off-on" data-cap="${k}">${opts.map(o => `<button data-v="${o}">${MODE_LABEL[o]}</button>`).join('')}</div></div>`;
    }).join(''));
    for (const seg of $$('.seg[data-cap]', box)) {
      $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.v === S.policy[seg.dataset.cap]));
      moveSegInd(seg);
    }
    $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.ui.theme));
    moveSegInd($('themeSeg'));
    if (document.activeElement !== $('maxSteps')) $('maxSteps').value = S.maxAutoSteps;
    $('reduceMotion').checked = !!S.ui.reduceMotion;
    $('advanced').checked = !!S.ui.advanced;
    $('notifications').checked = !!S.ui.notifications;
    $('aboutLine').textContent = `Homebox ${S.version} on ${S.os} · port ${S.port} · by Jethin Production`;
  }

  // ---------- actions ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.decide) decide(d.decide, d.v === '1');
    else if (d.pair) act(b, () => api('/api/pair/decide', { id: d.pair, approve: d.v === '1' }), d.v === '1' ? 'Browser connected' : 'Request denied');
    else if (d.undo) act(b, () => api('/api/undo', { id: d.undo }), 'Change undone');
    else if (d.select) act(b, () => api('/api/workspace/select', { path: d.select }), 'AI folder switched');
    else if (d.remove) { if (await ask('Remove this folder?', `${esc(d.remove)}<br><br>It is only removed from Homebox. The files stay where they are.`, 'Remove')) act(b, () => api('/api/workspace/remove', { path: d.remove }), 'Folder removed from list'); }
    else if (d.suggest) act(b, () => api('/api/workspace/add', { path: d.suggest, create: true }), 'Folder added and selected');
    else if (d.openWs !== undefined) openWs();
    else if (d.revoke) { if (await ask('Disconnect this browser?', 'It will need to connect again before AI can use it.', 'Disconnect', true)) act(b, () => api('/api/devices/revoke', { id: d.revoke }), 'Browser disconnected'); }
    else if (b.closest('.seg[data-cap]')) {
      const cap = b.closest('.seg').dataset.cap;
      if (S.policy[cap] === d.v) return;
      S.policy[cap] = d.v; renderSettings();
      act(null, () => api('/api/policy', { [cap]: d.v }), `${S.caps[cap].label}: ${MODE_LABEL[d.v]}. Start a new chat so the AI sees it.`);
    } else if (b.closest('#themeSeg')) setUi({ theme: d.v });
  });

  function decide(id, approve) {
    const el = $('approvals').querySelector(`.appr[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add('leaving');
    api('/api/decide', { id, approve }).then(() => toast(approve ? 'Approved' : 'Denied')).catch(err => { if (el) el.classList.remove('leaving'); toast(err.message, 'bad'); });
  }
  const openWs = () => act(null, () => api('/api/workspace/open'));
  async function setPaused(p) {
    if (S) { S.paused = p; renderChrome(); }
    await act($('pauseBtn'), () => api('/api/pause', { paused: p }), p ? 'AI access paused' : 'AI access resumed');
  }
  $('pauseBtn').onclick = () => setPaused(!(S && S.paused));
  $('resumeBtn').onclick = () => setPaused(false);
  $('openWsBtn').onclick = openWs;
  $('pickBtn').onclick = () => act($('pickBtn'), async () => { const r = await api('/api/workspace/pick'); if (r.ok) toast('AI folder switched'); });
  $('addForm').onsubmit = e => {
    e.preventDefault();
    const p = $('addPath').value.trim();
    if (!p) { $('addPath').focus(); return; }
    act(e.submitter, async () => { await api('/api/workspace/add', { path: p, create: $('addCreate').checked }); $('addPath').value = ''; toast('Folder added and selected'); });
  };
  $('rotateBtn').onclick = async () => { if (await ask('Make a new secret link?', 'Apps using the old link stop working until you give them the new one.', 'Make new link', true)) act($('rotateBtn'), () => api('/api/mcp/rotate'), 'New link made. Update your apps.'); };
  const copyPrompt = async () => { const t = await fetch('/api/prompt').then(r => r.text()); copy(t, 'Starter prompt copied. Paste it into a chat, then add your task.'); };
  $('copyPrompt').onclick = copyPrompt;
  $('dlExt').onclick = () => { location.href = '/download/homebox-extension.zip'; };
  $('pasteRun').onclick = () => act($('pasteRun'), async () => {
    const text = $('pasteIn').value;
    if (!text.trim()) { $('pasteIn').focus(); return; }
    const r = await api('/api/paste', { text });
    $('pasteInfo').textContent = r.count ? `Ran ${r.count} action${r.count > 1 ? 's' : ''}.` : '';
    $('pasteOut').value = r.reply;
    $('pasteOutWrap').classList.remove('hidden');
    if (!r.count) toast(r.reply, 'bad');
  });
  let mayaTesting = false;
  async function testMaya(btn, quiet) {
    if (mayaTesting) return;
    mayaTesting = true;
    try {
      await act(btn || (quiet ? null : $('mayaTest')), async () => {
        const r = await api('/api/maya/test');
        mayaResult = { ...r, at: new Date().toISOString() };
        if (!quiet) toast(r.ok ? `Maya ${r.version} answered` : r.error || 'Maya did not answer', r.ok ? '' : 'bad');
        render();
      });
    } finally { mayaTesting = false; }
  }
  $('mayaTest').onclick = () => testMaya();
  $('mayaCap').onchange = e => setAppMode('maya', e.target.checked);
  $('mayaAuto').onchange = e => act(null, () => api('/api/maya/autostart', { on: e.target.checked }), e.target.checked ? 'Maya will connect every time it starts' : 'Automatic start removed');
  $('stepsForm').onsubmit = e => { e.preventDefault(); act(e.submitter, () => api('/api/policy', { maxAutoSteps: $('maxSteps').value }), 'Step limit saved'); };
  $('reduceMotion').onchange = e => setUi({ reduceMotion: e.target.checked });
  $('notifications').onchange = async e => {
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    setUi({ notifications: e.target.checked });
  };
  $('quitBtn').onclick = async () => { if (await ask('Quit Homebox?', 'AI loses all access until you start Homebox again.', 'Quit', true)) api('/api/quit').then(() => toast('Homebox is shutting down')); };

  // ---------- help ----------
  const FAQ = [
    ['Start', 'How do I give the AI a task?', '<p>Open an AI chat site in a <b>new chat</b> and click the round <b>Homebox</b> button at the bottom right. In box <b>1</b>, type what you want. In box <b>2</b>, add pictures if you like. Then click <b>Start task</b>.</p><p>Always type the task in the Homebox panel, not in the chat site&#39;s own message box. Homebox adds the instructions the AI needs to work on your computer.</p>'],
    ['Start', 'How do I add pictures for the AI?', '<p>Two ways. On the chat page, drag pictures into box <b>2</b> of the Homebox panel, or paste one into box 1. Homebox saves them in your AI folder and can also show them to the AI. Or open <a href="#folders">AI folder</a> here and drag them into <b>Add pictures or files</b>.</p>'],
    ['Browser', 'Can I give the AI a task without opening an AI site first?', '<p>Yes. Click the Homebox button in the browser toolbar and type in <b>Ask AI</b>, or type <b>hb</b>, a space and your task in the address bar, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> on any page. Homebox picks the AI that suits the task, opens it in a new tab and types the task for you.</p><p>Not logged in? Log in and Homebox types the task as soon as you are in. If that AI is down or out of messages, the task moves to the next AI by itself. To use a different AI, pick it in <b>Use another AI</b> in the panel, or write for example <i>use Claude</i> in your task. Choose your favourite AI for each kind of task under <b>Which AI for which task</b> in the toolbar popup.</p>'],
    ['Browser', 'Can the AI fill forms, write emails, help me apply for jobs or play games?', '<p>Yes. Turn on <b>Control browser tabs</b> in <a href="#settings">Settings</a>. Then open the website, click the Homebox button in the browser toolbar and click <b>Let AI control this site</b>. Only sites you allow this way can be read or used.</p><p>The AI reads the page and fills fields, and you approve every typing, click and email, even with Full access on. It never types passwords or card details, and it never presses the final <b>Send</b>, <b>Submit</b>, <b>Apply</b>, <b>Pay</b> or <b>Save</b> button: you check everything and press it yourself. Emails open as a Gmail draft for you to send. Games: single-player games only.</p><p>Before you use the AI on a site, check that the site&#39;s terms allow it.</p>'],
    ['Browser', 'Can the AI fill in my LinkedIn profile or apply on LinkedIn?', '<p>LinkedIn does not allow tools to automate its website, so Homebox never controls LinkedIn. Instead, put your CV in your AI folder and use the idea <b>LinkedIn from my CV</b> in the browser panel. The AI writes each part of your profile and shows it with <b>Copy</b> buttons, and you paste it into LinkedIn yourself.</p>'],
    ['Browser', 'Can the AI read my CV?', '<p>Yes. Drag your CV (PDF or Word) into the browser panel or onto the <a href="#folders">AI folder</a> page. The AI reads it with <b>read_document</b>. Scanned CVs (pictures of paper) have no text inside: attach them as a picture instead.</p>'],
    ['Start', 'How do I connect my browser?', '<p>Go to <a href="#connect">Connect AI</a>, download the extension, and load it with <b>Load unpacked</b> on <code>chrome://extensions</code>. Then click the Homebox icon, then <b>Connect</b>, and approve the matching code here.</p>'],
    ['Start', 'The AI gives me a script instead of doing the work', '<p>You typed the task into the chat site directly. Start a <b>new chat</b> and use <b>Homebox button → Start task</b>.</p>'],
    ['Start', 'I changed a permission, but the AI doesn\'t notice', '<p>The AI learns its tool list at the start of a task. Start a <b>new chat</b> after changing permissions.</p>'],
    ['Sites', 'My AI site isn\'t listed', '<p>Open that site, click the Homebox toolbar icon and choose <b>Enable Homebox on this site</b>.</p>'],
    ['Sites', 'Arena shows two answers side by side', '<p>Battle mode shows two answers. Homebox asks you to pick <b>Run (left)</b> or <b>Run (right)</b>. Use <b>Direct Chat</b> so Homebox can keep working by itself.</p>'],
    ['Sites', 'The results didn\'t get sent to the AI', '<p>They are in the chat\'s message box. Press <b>Send</b> yourself. If the same action keeps repeating, click <b>Put in chat box</b> in the Homebox panel on the page, then Send.</p>'],
    ['Sites', 'The AI\'s actions aren\'t picked up', '<p>The AI must write them in <code>```homebox</code> code blocks. Tell it: <i>"Use homebox blocks, as in my first message."</i></p>'],
    ['Apps', 'Which apps can the AI control?', '<p>Maya, Blender, Houdini, 3ds Max, Cinema 4D, Nuke, Unreal Engine, Substance 3D Painter, Photoshop, Illustrator, After Effects, Excel, Word, PowerPoint, AutoCAD, OBS Studio and VS Code. Open <a href="#apps">Apps</a>, click one, turn it on and follow its setup steps. Then start a <b>new chat</b> so the AI learns about it.</p>'],
    ['Apps', 'An app says it is not reachable', '<p>Make sure the app is open with no dialog box waiting. For 3D apps, the Homebox bridge must be running inside the app: paste the setup line from its page on <a href="#apps">Apps</a>, or turn on <b>Start automatically</b>.</p>'],
    ['Maya', 'How do I set up Maya?', '<p>On the <a href="#maya">Maya</a> page, turn on <b>Let AI control Maya</b> and <b>Start with Maya automatically</b>. Restart Maya, then click <b>Test connection</b>.</p>'],
    ['Maya', '"Maya did not answer in time"', '<p>Make sure Maya is open with no dialog box waiting, and that the Script Editor shows <i>"Homebox: Maya is listening on port …"</i>. If Maya was just restarted, check that the startup file ran.</p>'],
    ['Maya', 'The AI says it doesn\'t have maya_run_python', '<p><b>Control Maya</b> is off. Turn it on in <a href="#settings">Settings</a>, then start a new chat.</p>'],
    ['Safety', 'What can the AI see?', '<p>Only the active sandbox folder. Secret files (<code>.env</code>, SSH keys, <code>.pem</code>/<code>.key</code>) are hidden even inside it. Everything the AI reads is sent to that AI\'s company, so don\'t keep private documents there.</p>'],
    ['Safety', 'How do I undo a change?', '<p>Every file change is saved first. Press <b>Undo</b> next to it on the <a href="#activity">Activity</a> page. Deleted files and folders come back the same way.</p>'],
    ['Safety', 'How do I stop everything right now?', '<p>Click <b>AI access on</b> at the bottom of the sidebar to pause. It cuts all access and denies anything waiting. Quitting Homebox does the same.</p>'],
    ['Safety', 'What should I be careful approving?', '<p>Commands and Maya scripts can reach outside the sandbox folder. Don\'t approve code you don\'t understand, especially right after the AI read a web page or a file you didn\'t write.</p>'],
    ['Problems', 'The extension says the app isn\'t running', '<p>Start Homebox, then click <b>Try again</b> in the extension. Homebox uses ports 7777–7787 on this computer only.</p>'],
    ['Problems', 'A chat site changed its design and something broke', '<p>Use the <b>Copy</b> / <b>Put in chat box</b> buttons in the page panel, or use <a href="#connect">Paste mode</a>, which works with any AI.</p>'],
  ];
  html($('faq'), FAQ.map(([cat, q, a], i) => `<details data-i="${i}"><summary><span class="cat">${cat}</span>${esc(q)}${icon('chev')}</summary><div class="ans">${a}</div></details>`).join(''));
  $('helpSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const d of $$('#faq details')) {
      const hit = !q || d.textContent.toLowerCase().includes(q);
      d.classList.toggle('hidden', !hit);
      if (q && hit) d.open = true;
    }
  });
  $('faq').addEventListener('click', e => { const a = e.target.closest('.ans a[href^="#"]'); if (a) { e.preventDefault(); go(a.getAttribute('href').slice(1)); } });
  const KEYS = [
    ['Search and commands', ['Ctrl', 'K']], ['Go to page 1–8', ['Ctrl', '1…8']], ['Help', ['F1']], ['Switch theme', ['Ctrl', 'Shift', 'L']],
    ['Approve the top request', ['Enter']], ['Deny the top request', ['Esc']], ['Pause / resume AI', ['Ctrl', 'Shift', 'P']], ['Focus search on this page', ['/']],
  ];
  html($('keys'), KEYS.map(([t, k]) => `<div><span>${t}</span><span>${k.map(x => `<kbd>${x}</kbd>`).join('')}</span></div>`).join(''));

  // ---------- in-app confirm ----------
  let modalDone = null;
  function ask(title, textHtml, okLabel = 'OK', danger = false) {
    if (modalDone) modalDone(false);
    $('mTitle').textContent = title;
    $('mText').innerHTML = textHtml;
    $('mOk').textContent = okLabel;
    $('mOk').className = `btn ${danger ? 'danger' : 'primary'}`;
    $('modal').classList.remove('hidden');
    setTimeout(() => $('mOk').focus(), 0);
    return new Promise(resolve => { modalDone = v => { modalDone = null; $('modal').classList.add('hidden'); resolve(v); }; });
  }
  $('mOk').onclick = () => modalDone && modalDone(true);
  $('mCancel').onclick = () => modalDone && modalDone(false);
  $('modal').addEventListener('mousedown', e => { if (e.target === $('modal') && modalDone) modalDone(false); });

  // ---------- full access ----------
  async function setFullAccess(on, fromEl) {
    if (on && !(S && S.fullAccess)) {
      const ok = await ask('Turn on full access?',
        'AI will run everything you have turned on <b>without asking you first</b>: file changes, commands, Maya and other apps, including anything waiting right now.<br><br>Only use this with an AI and a task you trust. You can turn it off or press <b>Pause</b> at any time.',
        'Turn on full access', true);
      if (!ok) { if (fromEl) fromEl.checked = false; return; }
    }
    if (S) { S.fullAccess = on; renderChrome(); renderSettings(); }
    act(null, () => api('/api/fullaccess', { on }), on ? 'Full access on. AI will not ask before acting.' : 'Full access off. AI asks again.');
  }
  $('fullSide').onchange = e => setFullAccess(e.target.checked, e.target);
  $('fullSettings').onchange = e => setFullAccess(e.target.checked, e.target);
  $('fullOffBtn').onclick = () => setFullAccess(false);

  // ---------- live guide: the one next thing to do ----------
  function nextStep() {
    const aiRuns = S.log.some(e => AI_SOURCES.has(e.source) && e.status === 'ok');
    if (S.paused) return { t: 'AI access is paused', s: 'Nothing can run until you resume.', btn: 'Resume', run: () => setPaused(false) };
    if (S.pending.length) return { t: `${S.pending.length} action${S.pending.length > 1 ? 's are' : ' is'} waiting for you`, s: 'Read what the AI wants to do, then approve or deny.', btn: 'Review', run: () => go('approvals') };
    if (S.pairRequests.length) return { t: 'A browser wants to connect', s: 'Approve it at the top of this page if the code matches.', btn: null };
    if (!S.devices.length) return { t: 'Connect your browser', s: 'Install the Homebox extension, click its icon, then Connect.', btn: 'Show me how', run: () => { go('connect'); showTab('ext'); } };
    if (!aiRuns) return { t: 'Give the AI its first task', s: 'Open ChatGPT, Claude, Gemini or Arena in a new chat, click the round Homebox button at the bottom right, type a task and press Start task.', btn: 'Open ChatGPT', run: () => window.open('https://chatgpt.com', '_blank', 'noopener') };
    if (!allApps().some(a => a.mode !== 'off')) return { t: 'Want AI to work in your apps too?', s: 'Turn on Blender, Photoshop, Excel, OBS or others.', btn: 'Browse apps', run: () => go('apps') };
    return { t: 'You are all set', s: S.fullAccess ? 'Full access is on: AI works without asking. Watch the Activity page.' : 'Keep this window open while AI works. Approvals pop up here.', btn: 'Activity', run: () => go('activity') };
  }
  let nextRun = null;
  function renderNextStep() {
    const n = nextStep();
    nextRun = n.run || null;
    html($('nextStep'), `<span class="ns-ic">${icon('map')}</span><div class="ns-body"><small>What to do now</small><b>${esc(n.t)}</b><br><span>${esc(n.s)}</span></div>${n.btn ? `<button class="btn primary small" id="nsBtn">${esc(n.btn)}${icon('arrow')}</button>` : ''}`);
  }
  $('nextStep').addEventListener('click', e => { if (e.target.closest('#nsBtn') && nextRun) nextRun(); });

  // ---------- guided tour ----------
  const TOUR = [
    { sel: '#nav a[data-page="home"]', page: 'home', t: 'Welcome to Homebox', x: 'This window is your control room. Homebox lets AI from chat websites work in one folder on your computer, and in apps like Maya, Blender or Excel.' },
    { sel: '#nextStep', page: 'home', t: 'What to do now', x: 'This card always shows the one next step, and it changes as you go. Follow it and you are set up in a few minutes.' },
    { sel: '#nav a[data-page="connect"]', page: 'connect', t: 'Connect an AI', x: 'Install the browser extension here once. Then every AI chat site gets a round Homebox button at the bottom right.' },
    { sel: '#nav a[data-page="approvals"]', page: 'approvals', t: 'Approvals', x: 'When AI wants to change something, it waits here. Read the code, then Approve (Enter) or Deny (Esc).' },
    { sel: '.full-row', page: null, t: 'Full access', x: 'Tired of approving every step? Turn on Full access and AI runs everything you allowed without asking. Turn it off any time.' },
    { sel: '#pauseBtn', page: null, t: 'Emergency stop', x: 'One click pauses all AI access at once. Click again to resume.' },
    { sel: '#nav a[data-page="apps"]', page: 'apps', t: 'Apps', x: 'Let AI work in Blender, Houdini, Photoshop, Excel, OBS and more. Each app has its own setup steps and a Test button.' },
    { sel: '#nav a[data-page="activity"]', page: 'activity', t: 'Activity and Undo', x: 'Everything AI did is listed here. File changes can be undone with one click.' },
    { sel: '#paletteBtn', page: null, t: 'Find anything fast', x: 'Press Ctrl+K to jump to any page, app or help answer. Press F1 for help, and use the map button up here to see this tour again.' },
  ];
  let tourI = -1;
  function startTour() { closeMenu(); closeDrawer(); tourI = 0; $('tour').classList.remove('hidden'); showTourStep(); }
  function endTour() { tourI = -1; $('tour').classList.add('hidden'); lsSet('hb.toured', true); }
  function showTourStep() {
    const st = TOUR[tourI];
    if (!st) return endTour();
    if (st.page && st.page !== page) go(st.page);
    const el = document.querySelector(st.sel);
    if (!el || !el.offsetWidth) { tourI++; return showTourStep(); }
    if (innerWidth <= 760 && el.closest('#side')) { $('side').classList.add('open'); }
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect(), pad = 6;
      Object.assign($('tourSpot').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
      $('tourStep').textContent = `Step ${tourI + 1} of ${TOUR.length}`;
      $('tourTitle').textContent = st.t;
      $('tourText').textContent = st.x;
      $('tourBack').disabled = tourI === 0;
      $('tourNext').textContent = tourI === TOUR.length - 1 ? 'Finish' : 'Next';
      const card = $('tourCard'), cw = card.offsetWidth || 330, ch = card.offsetHeight || 170;
      let x = r.right + 16, y = r.top;
      if (x + cw > innerWidth - 16) { x = Math.max(16, Math.min(innerWidth - cw - 16, r.left)); y = r.bottom + 14; }
      if (y + ch > innerHeight - 16) y = Math.max(16, r.top - ch - 14);
      card.style.left = x + 'px'; card.style.top = y + 'px';
      $('tourNext').focus();
    });
  }
  $('tourNext').onclick = () => { tourI++; showTourStep(); };
  $('tourBack').onclick = () => { tourI = Math.max(0, tourI - 1); showTourStep(); };
  $('tourSkip').onclick = endTour;
  $('tourBtn').onclick = startTour;
  window.addEventListener('resize', () => { if (tourI >= 0) showTourStep(); });

  // ---------- adding pictures and files to the AI folder ----------
  const MAX_UPLOAD = 20 * 1048576;
  const toBase64 = f => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
  const added = [];
  async function uploadFiles(list) {
    let n = 0;
    for (const f of list) {
      if (f.size > MAX_UPLOAD) { toast(`"${f.name}" is larger than 20 MB, so it wasn't added.`, 'bad'); continue; }
      try {
        const r = await api('/api/upload', { name: f.name, data: await toBase64(f) });
        added.unshift({ path: r.path, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : null });
        n++;
      } catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
    }
    html($('uploaded'), added.slice(0, 8).map(a => `<div class="added">${a.url ? `<img src="${a.url}" alt="">` : `<span class="how-ic">${icon('file')}</span>`}<span class="grow0">Added <code>${esc(a.path)}</code></span></div>`).join(''));
    if (n) toast(`Added ${n} file${n > 1 ? 's' : ''} to your AI folder`);
  }
  $('filePick').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { uploadFiles([...$('fileInput').files]); $('fileInput').value = ''; };
  $('dropzone').addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('over'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('over'));
  $('dropzone').addEventListener('drop', e => { e.preventDefault(); $('dropzone').classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
  // a file dropped anywhere else shouldn't make the window open it
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { if (!e.target.closest('#dropzone')) e.preventDefault(); });

  // ---------- settings that explain themselves ----------
  const EXPLAIN = {
    read: { auto: ['The AI can look at the files in your AI folder without asking.', ''], ask: ['The AI asks before it looks at any file.', ''], off: ["The AI can't look at your files, so it can't do much.", 'off'] },
    write: { auto: ['The AI creates and changes files without asking. You can still undo each change on the Activity page.', 'warn'], ask: ['Each change waits for you to click Approve. (Recommended)', ''], off: ["The AI can't create or change files.", 'off'] },
    exec: { ask: ['Each command waits for your OK. Commands can reach outside your AI folder, so read them carefully.', 'warn'], off: ["The AI can't run commands. (Recommended unless you need it.)", 'off'] },
    browser: { auto: ['The AI reads, types, clicks and scrolls on the sites you allowed without asking you. It still never types passwords or card details and never presses Send, Submit or Pay. A web page could try to trick the AI, so only allow sites you trust.', 'warn'], ask: ['The AI can use tabs on sites you allow (Homebox button in the browser toolbar → Let AI control this site). Typing, clicking and emails always wait for your OK, even with Full access. You press Send, Submit and Pay yourself.', ''], off: ["The AI can't see or use your browser tabs. It can still write text for you to copy.", 'off'] },
    maya: { ask: ['The AI can work in Maya. Each step waits for your OK.', ''], off: ["The AI can't use Maya.", 'off'] },
  };
  function explainMode(cap, mode) {
    const e = (EXPLAIN[cap] || {})[mode];
    if (!e) return '';
    const full = S.fullAccess && mode === 'ask' ? ' Full access is on right now, so it won\'t ask.' : '';
    return `<div class="explain ${full ? 'warn' : e[1]}">${esc(e[0] + full)}</div>`;
  }
  $('advanced').onchange = e => { setUi({ advanced: e.target.checked }); toast(e.target.checked ? 'Advanced options are shown' : 'Advanced options are hidden'); };

  // ---------- help: what each part does ----------
  const PARTS = [
    ['home', 'Home', 'Your next step, how Homebox works, and what the AI did today.'],
    ['shield', 'Approvals', 'Things the AI wants to do that need your OK. Read each one, then click Approve or Deny.'],
    ['pulse', 'Activity', 'Everything the AI did, newest first. Click Undo next to a change to take it back.'],
    ['folder', 'AI folder', 'The one folder the AI can use. Add pictures and files here, or pick a different folder.'],
    ['link', 'Connect AI', 'Add Homebox to your browser, and see which browsers are connected.'],
    ['grid', 'Apps', 'Let the AI work inside programs like Maya, Blender, Photoshop, Excel and VS Code. Each app has step-by-step setup.'],
    ['gear', 'Settings', 'Choose what the AI may do (Automatic, Ask me or Off), and the look of Homebox.'],
    ['bolt', 'Full access', 'When on, the AI does everything you allowed without asking. Leave it off unless you trust the task.'],
    ['pause', 'AI access on / paused', 'The emergency stop at the bottom of the menu. One click blocks the AI completely; click again to allow it.'],
    ['map', 'Map button (top right)', 'Shows you around this window.'],
    ['search', 'Search (Ctrl+K)', 'Jump to any page, app, setting or help answer.'],
    ['link', 'The round Homebox button on chat sites', 'Where you type tasks for the AI and add pictures. It appears at the bottom right of ChatGPT, Claude, Gemini and other AI chat sites once your browser is connected.'],
  ];
  html($('parts'), PARTS.map(([ic, t, d]) => `<dt>${icon(ic)}${esc(t)}</dt><dd>${esc(d)}</dd>`).join(''));

  // ---------- setup guide (first run, and from Home or Help) ----------
  let wzStep = -1;
  function openWizard(step = 0) { closeDrawer(); wzStep = step; $('wizard').classList.remove('hidden'); $('wzBody').__html = null; renderWizard(); }
  function closeWizard() { wzStep = -1; $('wizard').classList.add('hidden'); lsSet('hb.wizardDone', true); }
  function renderWizard() {
    if (wzStep < 0 || !S) return;
    const aiRuns = S.log.some(e => AI_SOURCES.has(e.source) && e.status === 'ok');
    html($('wzDots'), [0, 1, 2, 3].map(i => `<i class="${i <= wzStep ? 'on' : ''}"></i>`).join(''));
    let body = '', next = 'Next';
    if (wzStep === 0) {
      body = `<div class="wz-step">Step 1 of 3</div><h2>Your AI folder</h2>
        <p>The AI can only see and change files in one folder on your computer. Everything it makes is saved there.</p>
        <div class="wz-box"><b>${esc(S.workspace.name)}</b><div class="muted small">${esc(S.workspace.active)}</div></div>
        <p class="muted small">Tip: use a folder just for AI work. Homebox won't let you pick your whole user folder or Windows folders.</p>
        <div class="row wrap">${S.canPickFolder ? '<button class="btn" data-wz="pick">Choose another folder…</button>' : '<button class="btn" data-wz="folders">Use another folder…</button>'}</div>`;
      next = 'Use this folder';
    } else if (wzStep === 1) {
      const pr = S.pairRequests[0];
      const status = S.devices.length ? `<div class="wz-ok">${icon('check')}Your browser is connected.</div>`
        : pr ? `<div class="wz-box"><b>${esc(pr.name)} wants to connect.</b> Does your browser show the same code?<div class="row wrap mt"><span class="wz-code">${esc(pr.code)}</span><span class="grow0"></span><button class="btn primary" data-pair="${esc(pr.id)}" data-v="1">Yes, approve</button><button class="btn" data-pair="${esc(pr.id)}" data-v="0">No</button></div></div>`
        : `<div class="wz-wait"><span class="spinner"></span>Waiting for your browser. Follow the steps above.</div>`;
      body = `<div class="wz-step">Step 2 of 3</div><h2>Add Homebox to your browser</h2>
        <p>This lets Homebox work with AI chat sites. You only do it once. It works in Chrome, Edge, Brave and Opera.</p>
        <ol class="wz-list">
          <li><a class="btn small primary" href="/download/homebox-extension.zip" download>${icon('download')}Download the extension</a>, then unzip it: right-click the file and choose <b>Extract All</b>.</li>
          <li>In your browser's address bar, type <code>chrome://extensions</code> (in Edge: <code>edge://extensions</code>) and press Enter.</li>
          <li>Turn on <b>Developer mode</b> (top right). Click <b>Load unpacked</b> and choose the unzipped <b>homebox-extension</b> folder.</li>
          <li>Click the puzzle-piece icon in the toolbar and pin <b>Homebox</b>. Click it, then click <b>Connect to Homebox</b>.</li>
        </ol>
        <p class="note small"><b>Check each AI site's rules.</b> Some AI sites don't allow their website to be used through tools like this. Only use Homebox on sites whose terms allow it.</p>${status}`;
      next = S.devices.length ? 'Next' : 'Skip for now';
    } else if (wzStep === 2) {
      body = `<div class="wz-step">Step 3 of 3</div><h2>Give the AI its first task</h2>
        <ol class="wz-list">
          <li>Open an AI chat site in a new chat: <a href="https://chatgpt.com" target="_blank" rel="noopener">ChatGPT</a>, <a href="https://claude.ai" target="_blank" rel="noopener">Claude</a> or <a href="https://gemini.google.com" target="_blank" rel="noopener">Gemini</a>.</li>
          <li>Click the round <b>Homebox</b> button at the bottom right of the chat page.</li>
          <li>In box <b>1</b>, type what you want, for example <i>"Make a simple website about my favourite hobby."</i> Type it there, <b>not</b> in the chat's own message box.</li>
          <li>Optional: drag pictures into box <b>2</b>.</li>
          <li>Click <b>Start task</b>. When the AI wants to create or change a file, click <b>Approve</b>.</li>
        </ol>${aiRuns ? `<div class="wz-ok">${icon('check')}Your first task worked. Open your AI folder to see the result.</div>` : '<div class="wz-wait"><span class="spinner"></span>Waiting for your first task…</div>'}`;
      next = aiRuns ? 'Next' : 'Skip for now';
    } else {
      body = `<h2 style="margin-top:14px">You're ready</h2><p>A few things to know:</p>
        <ul class="wz-list" style="counter-reset:none">
          <li style="padding-left:0"><b>Apps</b>: let the AI work in Maya, Blender, Photoshop, Excel, VS Code and more. Each app has its own step-by-step setup.</li>
          <li style="padding-left:0"><b>Full access</b> (bottom of the menu): lets the AI work without asking. Leave it off until you're comfortable.</li>
          <li style="padding-left:0"><b>AI access on</b> (bottom of the menu): click it to stop the AI at once.</li>
          <li style="padding-left:0"><b>Help</b>: explains every part of Homebox, in plain words.</li>
        </ul>
        <div class="row wrap"><button class="btn" data-wz="tour">${icon('map')}Show me around this window</button><button class="btn" data-wz="apps">${icon('grid')}Open Apps</button></div>`;
      next = 'Finish';
    }
    html($('wzBody'), body);
    $('wzBack').classList.toggle('hidden', wzStep === 0);
    $('wzNext').textContent = next;
  }
  $('wzNext').onclick = () => { if (wzStep >= 3) closeWizard(); else { wzStep++; renderWizard(); } };
  $('wzBack').onclick = () => { wzStep = Math.max(0, wzStep - 1); renderWizard(); };
  $('wzClose').onclick = closeWizard;
  $('wzBody').addEventListener('click', e => {
    const b = e.target.closest('[data-wz]'); if (!b) return;
    const a = b.dataset.wz;
    if (a === 'pick') act(b, async () => { const r = await api('/api/workspace/pick'); if (r.ok) toast('AI folder changed'); });
    if (a === 'folders') { closeWizard(); go('folders'); }
    if (a === 'tour') { closeWizard(); startTour(); }
    if (a === 'apps') { closeWizard(); go('apps'); }
  });
  $('openWizard').onclick = () => openWizard();
  $('helpWizard').onclick = () => openWizard();

  // ---------- command palette ----------
  let palItems = [], palSel = 0;
  function commands() {
    const c = ORDER.map((p, i) => ({ grp: 'Go to', label: PAGES[p], icon: $(`nav`).querySelector(`a[data-page="${p}"] use`).getAttribute('href').slice(3), hint: i < 8 ? `Ctrl ${i + 1}` : 'F1', run: () => go(p) }));
    c.push(
      { grp: 'Actions', label: S && S.paused ? 'Resume AI access' : 'Pause all AI access', icon: S && S.paused ? 'play' : 'pause', hint: 'Ctrl Shift P', run: () => setPaused(!(S && S.paused)) },
      { grp: 'Actions', label: S && S.fullAccess ? 'Turn off full access' : 'Turn on full access (no approvals)', icon: 'bolt', run: () => setFullAccess(!(S && S.fullAccess)) },
      { grp: 'Actions', label: 'Show me around (tour)', icon: 'map', run: startTour },
      { grp: 'Actions', label: 'Open the setup guide', icon: 'help', run: () => openWizard() },
      { grp: 'Actions', label: 'Add pictures or files to the AI folder', icon: 'download', run: () => { go('folders'); $('fileInput').click(); } },
      { grp: 'Actions', label: 'Open AI folder', icon: 'open', run: openWs },
      { grp: 'Actions', label: 'Copy starter prompt', icon: 'copy', run: copyPrompt },
      { grp: 'Actions', label: 'Copy MCP link', icon: 'link', run: () => S && copy(S.mcp.localUrl, 'MCP link copied') },
      { grp: 'Actions', label: 'Download browser extension', icon: 'download', run: () => { location.href = '/download/homebox-extension.zip'; } },
      { grp: 'Actions', label: 'Test Maya connection', icon: 'cube', run: () => { go('maya'); testMaya(); } },
      { grp: 'Actions', label: 'Switch light / dark theme', icon: 'moon', hint: 'Ctrl Shift L', run: toggleTheme },
      { grp: 'Actions', label: 'Paste an AI reply', icon: 'term', run: () => { go('connect'); showTab('paste'); setTimeout(() => $('pasteIn').focus(), 50); } },
    );
    if (S) for (const w of S.workspace.list) if (w !== S.workspace.active) c.push({ grp: 'Switch folder', label: w, icon: 'folder', run: () => act(null, () => api('/api/workspace/select', { path: w }), 'AI folder switched') });
    for (const a of allApps()) c.push({ grp: 'Apps', label: `${a.name}${a.mode !== 'off' ? '' : ' (off)'}`, icon: 'grid', run: () => { if (a.id === 'maya') go('maya'); else { go('apps'); openDrawer(a.id); } } });
    FAQ.forEach(([cat, q], i) => c.push({ grp: 'Help', label: q, icon: 'help', run: () => { go('help'); const d = $('faq').querySelector(`[data-i="${i}"]`); d.open = true; setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); } }));
    return c;
  }
  function openPalette() {
    $('palette').classList.remove('hidden', 'closing');
    $('palInput').value = '';
    renderPalette();
    $('palInput').focus();
  }
  function closePalette() {
    const p = $('palette');
    if (p.classList.contains('hidden')) return;
    p.classList.add('closing');
    setTimeout(() => p.classList.add('hidden'), 150);
  }
  function renderPalette() {
    const q = $('palInput').value.trim().toLowerCase();
    const all = commands();
    palItems = q ? all.filter(c => `${c.grp} ${c.label}`.toLowerCase().includes(q)) : all.filter(c => c.grp !== 'Help');
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    if (!q) palSel = 0;
    let out = '', grp = '';
    palItems.forEach((c, i) => {
      if (c.grp !== grp) { out += `<div class="grp">${esc(c.grp)}</div>`; grp = c.grp; }
      out += `<div class="it${i === palSel ? ' sel' : ''}" data-i="${i}">${icon(c.icon)}<span>${esc(c.label)}</span>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</div>`;
    });
    $('palList').innerHTML = out || '<div class="none">No matches</div>';
    const sel = $('palList').querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPal(i) { const c = palItems[i]; if (!c) return; closePalette(); c.run(); }
  $('paletteBtn').onclick = openPalette;
  $('palInput').addEventListener('input', () => { palSel = 0; renderPalette(); });
  $('palInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
  });
  $('palList').addEventListener('mousemove', e => { const it = e.target.closest('.it'); if (it && Number(it.dataset.i) !== palSel) { palSel = Number(it.dataset.i); $$('.it', $('palList')).forEach(x => x.classList.toggle('sel', x === it)); } });
  $('palList').addEventListener('click', e => { const it = e.target.closest('.it'); if (it) runPal(Number(it.dataset.i)); });
  $('palette').addEventListener('mousedown', e => { if (e.target === $('palette')) closePalette(); });

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('palette').classList.contains('hidden') ? openPalette() : closePalette(); return; }
    if (e.key === 'Escape' && !$('palette').classList.contains('hidden')) { closePalette(); return; }
    if (e.key === 'Escape' && modalDone) { modalDone(false); return; }
    if (e.key === 'Escape' && wzStep >= 0) { closeWizard(); return; }
    if (e.key === 'Escape' && tourI >= 0) { endTour(); return; }
    if (modalDone || tourI >= 0 || wzStep >= 0) return;
    if (e.key === 'Escape' && drawerApp) { closeDrawer(); return; }
    if (e.key === 'F1') { e.preventDefault(); go('help'); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleTheme(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setPaused(!(S && S.paused)); return; }
    if (mod && !e.shiftKey && /^[1-8]$/.test(e.key)) { e.preventDefault(); go(ORDER[Number(e.key) - 1]); return; }
    if (typing || !$('palette').classList.contains('hidden')) return;
    if (e.key === '/') {
      const s = page === 'activity' ? $('actSearch') : page === 'help' ? $('helpSearch') : null;
      e.preventDefault(); s ? s.focus() : openPalette(); return;
    }
    if (page === 'approvals' && S && S.pending.length && (e.key === 'Enter' || e.key === 'Escape')) {
      const first = $('approvals').querySelector('.appr:not(.leaving)');
      if (first) { e.preventDefault(); decide(first.dataset.id, e.key === 'Enter'); }
    }
  });

  // ---------- live connection ----------
  let booted = false, es = null, retry = 0;
  function connect() {
    es = new EventSource('/api/events');
    es.onmessage = m => {
      retry = 0;
      $('offlineBanner').classList.add('hidden');
      S = JSON.parse(m.data);
      render();
      if (!booted) {
        booted = true;
        document.body.classList.remove('booting');
        requestAnimationFrame(moveNavInd);
        // first visit: show the tour, unless a link brought the user to a specific panel (like #apps/vscode).
        // Check before route(), which may tidy the address.
        const deepLinked = location.hash.includes('/');
        route();
        if (!deepLinked) {
          if (!lsGet('hb.wizardDone', false) && !S.devices.length) openWizard();
          else if (!lsGet('hb.toured', false)) requestAnimationFrame(() => requestAnimationFrame(startTour));
        }
      }
    };
    es.onerror = () => {
      es.close();
      $('offlineBanner').classList.remove('hidden');
      setTimeout(connect, Math.min(8000, 800 * 2 ** retry++));
    };
  }
  showTab(lsGet('hb.tab', 'ext'));
  // first paint, before the app's data arrives: keep links like #setup/2 or #apps/vscode for route() to read
  go(location.hash.slice(1).split('/')[0] || 'home', { keepHash: true });
  connect();
  setTimeout(() => { if (!booted) document.body.classList.remove('booting'); }, 1500);
})();
