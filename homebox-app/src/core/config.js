// Settings stored in ~/.homebox/config.json (shared with Homebox 1.x so pairings survive the upgrade).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const DATA = path.join(HOME, '.homebox');
const CONFIG_FILE = path.join(DATA, 'config.json');
const SNAP_DIR = path.join(DATA, 'snapshots');
const AUDIT = path.join(DATA, 'audit.jsonl');
const DEFAULT_WS = path.join(HOME, 'Homebox Workspace');
const IS_WIN = process.platform === 'win32';
const OS_NAME = IS_WIN ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
const VERSION = require('../../package.json').version;

fs.mkdirSync(SNAP_DIR, { recursive: true });

const token = (n = 24) => crypto.randomBytes(n).toString('base64url');

// File reading/writing and browser tabs can be automatic; anything that runs code (commands, Maya, apps) is only ever 'ask' or 'off'.
const FILE_CAPS = ['read', 'write', 'browser'];

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  c.workspaces = Array.isArray(c.workspaces) ? c.workspaces.filter(w => { try { return fs.statSync(w).isDirectory(); } catch { return false; } }) : [];
  c.policy = Object.assign({ read: 'auto', write: 'ask', exec: 'off', maya: 'off', browser: 'off' }, c.policy);
  for (const k of Object.keys(c.policy)) {
    const allowed = FILE_CAPS.includes(k) ? ['auto', 'ask', 'off'] : ['ask', 'off'];
    if (!allowed.includes(c.policy[k])) c.policy[k] = k === 'read' ? 'auto' : 'off';
  }
  c.mayaPort = Number(c.mayaPort) || 7001;
  c.mcpToken ||= token();
  c.devices = Array.isArray(c.devices) ? c.devices : [];
  c.maxAutoSteps = Number(c.maxAutoSteps) || 30;
  c.ui = Object.assign({ theme: 'system', reduceMotion: false, notifications: true, advanced: false }, c.ui);  // advanced: show expert options
  c.fullAccess = c.fullAccess === true;  // when on, nothing that is turned on waits for approval
  if (!c.workspaces.length) {
    fs.mkdirSync(DEFAULT_WS, { recursive: true });
    const readme = path.join(DEFAULT_WS, 'WELCOME.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, 'This folder is your AI sandbox.\nAI agents connected through Homebox can only see and change files inside this folder.\nYou can pick a different folder in the Homebox app.\n');
    c.workspaces = [fs.realpathSync(DEFAULT_WS)];
  }
  if (!c.workspaces.includes(c.active)) c.active = c.workspaces[0];
  return c;
}

const config = loadConfig();

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 }); }
  catch (e) { console.error('config save failed', e.message); }
}

module.exports = {
  HOME, DATA, CONFIG_FILE, SNAP_DIR, AUDIT, DEFAULT_WS, IS_WIN, OS_NAME, VERSION,
  FILE_CAPS, config, saveConfig, token,
};
