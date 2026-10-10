// Homebox extension — the "Ask AI" box. One component, used in the toolbar popup and in the small panel on web pages,
// so both look and work exactly the same. Needs router.js (HB_ROUTER). No network: sending is done by the caller.
(function (root) {
  if (root.HB_ASKBOX) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CSS = `
.hbx{--hbx-bg:#fff;--hbx-card:#f3f1ea;--hbx-ink:#1c1b19;--hbx-muted:#6a675f;--hbx-line:#d4d0c4;--hbx-accent:#2e6b5a;--hbx-accent2:#3f8a74;--hbx-on:#fff;--hbx-soft:#e3efe9;
  display:flex;flex-direction:column;gap:8px;background:var(--hbx-card);color:var(--hbx-ink);border-radius:12px;padding:12px 14px;
  font:13.5px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;box-sizing:border-box;text-align:left}
@media (prefers-color-scheme:dark){.hbx{--hbx-bg:#1d1c1a;--hbx-card:#262522;--hbx-ink:#ecebe5;--hbx-muted:#9d998f;--hbx-line:#45433e;--hbx-accent:#62b39b;--hbx-accent2:#7cc4ae;--hbx-on:#0d1a16;--hbx-soft:#1d302a}}
:host{all:initial;display:block}
.hbx *{box-sizing:border-box;font:inherit}
.hbx-t{font-weight:700}
.hbx textarea{width:100%;min-height:62px;resize:vertical;border:1px solid var(--hbx-line);border-radius:10px;background:var(--hbx-bg);color:var(--hbx-ink);padding:8px 10px}
.hbx textarea:focus,.hbx select:focus{outline:none;border-color:var(--hbx-accent);box-shadow:0 0 0 3px var(--hbx-soft)}
.hbx-plan{font-size:12.5px;color:var(--hbx-muted)}
.hbx-plan b{color:var(--hbx-ink)}
.hbx-opts{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.hbx select{border:1px solid var(--hbx-line);border-radius:8px;background:var(--hbx-bg);color:var(--hbx-ink);padding:4px 6px;font-size:12.5px;max-width:200px;min-width:0}
.hbx-chk{display:inline-flex;align-items:flex-start;gap:6px;cursor:pointer;font-size:12.5px}
.hbx-chk input{accent-color:var(--hbx-accent);margin:2px 0 0}
.hbx-go{border:1px solid var(--hbx-accent);background:var(--hbx-accent);color:var(--hbx-on);border-radius:10px;padding:9px 12px;font-weight:600;cursor:pointer;transition:background .15s,transform .1s}
.hbx-go:hover{background:var(--hbx-accent2);border-color:var(--hbx-accent2)}.hbx-go:active{transform:scale(.98)}
.hbx-go[disabled]{opacity:.6;cursor:default}
.hbx-prefs{font-size:12.5px;border:1px solid var(--hbx-line);border-radius:10px;padding:8px 10px}
.hbx-prefs summary{cursor:pointer;color:var(--hbx-muted)}
.hbx-pr{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px}.hbx-pr span{flex:1;min-width:0}
.hbx-pr select{max-width:140px}
.hbx-skip{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px}
.hbx-err{font-size:12.5px;color:#d24a3f}
.hbx-hidden{display:none!important}`;

  // host: an element in a page or a shadow root. opts.onPage: show "Stay on this page".
  // opts.send({ text, forced, computer, stay }) → Promise<{ ok, error }>. opts.sent(result) after a successful send.
  async function mount(host, opts = {}) {
    const R = root.HB_ROUTER;
    // its own sealed space, so neither the popup's styles nor a website's can change how it looks
    const shell = document.createElement('div');
    host.appendChild(shell);
    const sealed = shell.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.className = 'hbx';
    box.innerHTML = `<style>${CSS}</style>
      <span class="hbx-t">Ask AI</span>
      <textarea class="hbx-text" rows="3" placeholder="${esc(opts.placeholder || 'Type a task. For example: scroll this page every 5 seconds for 2 minutes')}"></textarea>
      <div class="hbx-plan">Homebox picks the best AI for the task and opens it in a new tab.</div>
      <div class="hbx-opts"><select class="hbx-site" aria-label="Which AI"></select><label class="hbx-chk"><input type="checkbox" class="hbx-pc"> Use my computer</label></div>
      <label class="hbx-chk hbx-stayrow"><input type="checkbox" class="hbx-stay"> Stay on this page (the AI works in a background tab)</label>
      <button class="hbx-go" type="button">Send to AI</button>
      <div class="hbx-err hbx-hidden"></div>
      <details class="hbx-prefs"><summary>Which AI for which task</summary><div class="hbx-pbox"></div></details>`;
    sealed.appendChild(box);
    const q = c => box.querySelector(c);
    const text = q('.hbx-text'), plan = q('.hbx-plan'), site = q('.hbx-site'), pc = q('.hbx-pc'), stay = q('.hbx-stay'), go = q('.hbx-go'), err = q('.hbx-err');
    q('.hbx-stayrow').classList.toggle('hbx-hidden', !opts.onPage);
    // typing here must not reach the page (YouTube's own keyboard shortcuts, for example)
    for (const t of ['keydown', 'keyup', 'keypress']) text.addEventListener(t, e => e.stopPropagation());

    let prefs = {}, choice = '';
    try { const s = await chrome.storage.local.get(['routePrefs', 'pageAiChoice']); prefs = s.routePrefs || {}; choice = s.pageAiChoice || ''; } catch {}
    site.innerHTML = '<option value="">Best AI for the task</option>' + R.SITES.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    site.value = R.byId(choice) ? choice : '';
    let pcTouched = false, stayTouched = false;
    const update = () => {
      const t = text.value.trim();
      if (!t) { plan.textContent = 'Homebox picks the best AI for the task and opens it in a new tab.'; if (!stayTouched) stay.checked = !!opts.onPage; return; }
      const p = R.plan(t, prefs, site.value);
      if (!pcTouched) pc.checked = p.computer;
      if (!stayTouched) stay.checked = !!opts.onPage && pc.checked;
      plan.innerHTML = `Goes to <b>${esc(p.site.name)}</b> (${esc(p.reason)}). If it's unavailable: ${esc(p.order.slice(1, 3).map(id => R.byId(id).name).join(', '))}.`;
    };
    text.addEventListener('input', update);
    site.addEventListener('change', () => { try { chrome.storage.local.set({ pageAiChoice: site.value }); } catch {} update(); });
    pc.addEventListener('change', () => { pcTouched = true; update(); });
    stay.addEventListener('change', () => { stayTouched = true; });

    const send = async () => {
      const t = text.value.trim();
      if (!t) { text.focus(); return; }
      go.disabled = true; go.textContent = 'Sending…'; err.classList.add('hbx-hidden');
      const r = await opts.send({ text: t, forced: site.value, computer: pc.checked, stay: !!opts.onPage && stay.checked });
      go.disabled = false; go.textContent = 'Send to AI';
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Could not send. Is the Homebox app running?'; err.classList.remove('hbx-hidden'); return; }
      text.value = ''; pcTouched = stayTouched = false; update();
      if (opts.sent) opts.sent(r);
    };
    go.addEventListener('click', e => { if (e.isTrusted) send(); });
    text.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

    const drawPrefs = () => {
      const skip = new Set(prefs.skip || []);
      q('.hbx-pbox').innerHTML = Object.entries(R.KINDS).map(([k, v]) => `<div class="hbx-pr"><span>${esc(v.label)}</span><select data-kind="${k}">
          <option value="">Suggested: ${esc(R.byId(v.order[0]).name)}</option>${R.SITES.map(s => `<option value="${esc(s.id)}"${prefs.first && prefs.first[k] === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`).join('')
        + `<div style="margin-top:8px">Never use:</div><div class="hbx-skip">${R.SITES.map(s => `<label class="hbx-chk"><input type="checkbox" data-skip="${esc(s.id)}"${skip.has(s.id) ? ' checked' : ''}>${esc(s.name)}</label>`).join('')}</div>`;
    };
    q('.hbx-pbox').addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.kind) { prefs.first = { ...(prefs.first || {}), [t.dataset.kind]: t.value }; if (!t.value) delete prefs.first[t.dataset.kind]; }
      if (t.dataset.skip) { const s = new Set(prefs.skip || []); t.checked ? s.add(t.dataset.skip) : s.delete(t.dataset.skip); prefs.skip = [...s]; }
      try { await chrome.storage.local.set({ routePrefs: prefs }); } catch {}
      update();
    });
    drawPrefs();
    update();
    return { focus: () => text.focus(), el: box };
  }

  root.HB_ASKBOX = { mount };
})(typeof self !== 'undefined' ? self : globalThis);
