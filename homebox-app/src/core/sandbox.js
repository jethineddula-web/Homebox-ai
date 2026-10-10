// The sandbox folder: every file path the AI gives is resolved and checked here.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { HOME, DATA, SNAP_DIR, IS_WIN, config } = require('./config');

function wsRoot() {
  try { return realpath(config.active); }
  catch { throw new Error('The sandbox folder no longer exists. Pick another one in the Homebox app.'); }
}

const expandHome = p => p === '~' ? HOME : /^~[\\/]/.test(p) ? path.join(HOME, p.slice(2)) : p;
const samePath = (a, b) => IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
const isInside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function validateWorkspace(input, create) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Choose a folder');
  const abs = path.resolve(expandHome(input.trim()));
  if (!fs.existsSync(abs)) {
    if (!create) throw new Error(`Folder not found: ${abs}`);
    fs.mkdirSync(abs, { recursive: true });
  }
  const real = realpath(abs);
  if (!fs.statSync(real).isDirectory()) throw new Error('That is a file, not a folder');
  const forbidden = [HOME, path.parse(real).root, 'C:\\Users', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
    '/Users', '/home', '/System', '/usr', '/bin', '/etc', '/var', '/Library'];
  if (forbidden.some(f => samePath(real, f))) throw new Error('For safety, pick a specific project folder — not your whole user folder or a system folder.');
  if (isInside(DATA, real)) throw new Error("That folder contains Homebox's own data folder. Pick a more specific folder.");
  if (isInside(real, DATA)) throw new Error("That is Homebox's own data folder.");
  return real;
}

// Secret files stay hidden from AI even inside the sandbox.
const DENY = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)\.ssh(\/|$)/i, /(^|\/)\.aws(\/|$)/i, /(^|\/)\.gnupg(\/|$)/i, /(^|\/)\.homebox(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore|kdbx)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i, /(^|\/)\.git\/config$/i,
  /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /(^|\/)\.pypirc$/i, /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)client_secret[^/]*\.json$/i, /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.git-credentials$/i, /\.ppk$/i, /(^|\/)\.pgpass$/i, /(^|\/)\.kube(\/|$)/i, /(^|\/)\.azure(\/|$)/i, /(^|\/)\.config\/gcloud(\/|$)/i,
];
const SKIP_WALK = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', 'Library', 'Temp', 'Intermediate', 'DerivedDataCache']);
const isDenied = relPosix => DENY.some(r => r.test(relPosix));

// realpath that also works for paths that don't exist yet (resolves the deepest existing parent).
// The native version also follows junctions and expands Windows short names (PROGRA~1).
const realpath = fs.realpathSync.native || fs.realpathSync;
function realish(abs) {
  let cur = abs; const rest = [];
  for (;;) {
    try { return path.join(realpath(cur), ...rest); }
    catch {
      rest.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) return abs;
      cur = up;
    }
  }
}

function safePath(p, root = wsRoot()) {
  if (typeof p !== 'string' || !p.trim()) p = '.';
  p = p.trim().replace(/^\/+(?=.)/, '');
  const real = realish(path.resolve(root, p));
  const rel = path.relative(root, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`"${p}" is outside the sandbox folder`);
  const relPosix = rel.split(path.sep).join('/');
  if (IS_WIN && relPosix) {
    // Windows quirks that could sneak past the secret-file check:
    //   "a.env::$DATA" (alternate data streams), "a.env " / "a.env." (trailing spaces and dots are dropped),
    //   and device names like CON or NUL.
    if (relPosix.includes(':')) throw new Error(`"${p}" is not a valid file name`);
    for (const seg of relPosix.split('/')) {
      if (/[. ]$/.test(seg)) throw new Error(`"${p}": file and folder names can't end with a dot or space on Windows`);
      if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(seg)) throw new Error(`"${seg}" is a reserved Windows name`);
    }
  }
  if (relPosix && isDenied(relPosix)) throw new Error(`"${relPosix}" is protected (secret files are hidden from AI)`);
  return { abs: real, rel: relPosix || '.', root };
}

async function snapshotFile(abs) {
  const id = crypto.randomBytes(8).toString('hex');
  await fsp.copyFile(abs, path.join(SNAP_DIR, id));
  return id;
}

module.exports = { wsRoot, validateWorkspace, safePath, isDenied, isInside, snapshotFile, SKIP_WALK, expandHome };
