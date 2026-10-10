// Shared live state: the activity log, the approval queue and the pause switch.
// Emits 'change' whenever the panel should redraw and 'approval' when a new request needs the user.
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AUDIT } = require('./config');

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const hub = new EventEmitter();
const log = [];
const pending = new Map();
let paused = false;
let changeTimer = null;

function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => hub.emit('change'), 30);
}

// Show the last session's history too, so the Activity page isn't empty after a restart.
try {
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-150);
  for (const l of lines) { try { const e = JSON.parse(l); e.old = true; log.push(e); } catch {} }
} catch {}

function addLog(entry) {
  const e = { id: crypto.randomBytes(6).toString('hex'), time: new Date().toISOString(), ...entry };
  log.push(e);
  if (log.length > 2000) log.shift();
  fs.appendFile(AUDIT, JSON.stringify(e) + '\n', () => {});
  changed();
  return e;
}

function requestApproval(item) {
  return new Promise(resolve => {
    const id = crypto.randomBytes(6).toString('hex');
    const p = { ...item, id, created: Date.now(), expires: Date.now() + APPROVAL_TIMEOUT_MS, resolve };
    pending.set(id, p);
    hub.emit('approval', publicItem(p));
    changed();
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(false); changed(); } }, APPROVAL_TIMEOUT_MS);
  });
}

const publicItem = ({ resolve, ...p }) => p;
const publicPending = filter => [...pending.values()].filter(filter || (() => true)).map(publicItem);

function decide(id, approve) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve(!!approve);
  changed();
  return true;
}

function setPaused(v) {
  paused = !!v;
  if (paused) for (const item of publicPending()) decide(item.id, false);
  addLog({ source: 'you', tool: 'pause', summary: paused ? 'Paused all AI access' : 'Resumed AI access', status: 'ok' });
}

module.exports = {
  hub, log, addLog, changed, requestApproval, publicPending, decide, setPaused,
  isPaused: () => paused, pendingItem: id => pending.get(id),
};
