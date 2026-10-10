// VS Code: the AI edits code with the normal file tools (write_file, edit_file, delete_path…), which VS Code
// picks up straight away. The small Homebox extension for VS Code (homebox-app/vscode) adds what the AI
// can't see on its own: open files, the selection, unsaved files and the Problems panel, plus "open this file".
// It talks over the same secret-protected bridge as the 3D apps, one port per VS Code window (7018-7027).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA, HOME, IS_WIN } = require('./config');
const { wsRoot, safePath } = require('./sandbox');
const { bridgeCall } = require('./bridge');
const { makeZip } = require('./zip');

const PORTS = Array.from({ length: 10 }, (_, i) => 7018 + i);
const EXT_ID = 'jethinproduction.homebox-vscode';
const SRC = path.join(__dirname, '..', '..', 'vscode');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const NOT_CONNECTED = 'VS Code is not connected. Open VS Code with the Homebox extension installed (Homebox → Apps → VS Code), and reload VS Code once after installing.';

const APP = {
  id: 'vscode', name: 'VS Code', cat: 'Code', abbr: 'VS', kind: 'vscode', port: 7018, lang: 'code',
  blurb: 'Edit, add and delete code in your project while you watch in VS Code.',
};

// ---------- talking to VS Code ----------
const contains = (outer, inner) => { const r = path.relative(outer, inner); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const sandbox = () => { try { return wsRoot(); } catch { return ''; } };

// Every VS Code window runs its own bridge. Use the one that has the sandbox folder open, else the last one used.
async function pickWindow() {
  const root = sandbox();
  const found = (await Promise.all(PORTS.map(port => bridgeCall({ name: 'VS Code', port }, { op: 'ping' }, 1500)
    .then(r => (r && r.ok ? { port, ...r } : null)).catch(() => null)))).filter(Boolean);
  if (!found.length) throw new Error(NOT_CONNECTED);
  const holds = w => root && (w.folders || []).some(f => contains(f, root) || contains(root, f));
  found.sort((a, b) => (holds(b) - holds(a)) || ((b.lastFocused || 0) - (a.lastFocused || 0)));
  return { ...found[0], holdsSandbox: !!holds(found[0]) };
}
async function call(msg) {
  const w = await pickWindow();
  const r = await bridgeCall({ name: 'VS Code', port: w.port }, { ...msg, root: sandbox() }, 15000, NOT_CONNECTED);
  if (!r.ok) throw new Error(r.output || 'VS Code reported an error.');
  return r.output;
}

// ---------- tools for the AI ----------
const str = d => ({ type: 'string', description: d });
function tools() {
  return {
    vscode_info: {
      cap: 'vscode', app: 'vscode', noAsk: true,  // read-only, and only about files inside the sandbox
      description: 'See what the user is doing in VS Code: the active file, cursor line and selected text, open files, which files have UNSAVED changes, and how many errors and warnings there are. Only files inside the sandbox are reported.',
      schema: { type: 'object', properties: {} },
      describe: () => 'VS Code: see open files and problems',
      run: () => call({ op: 'info' }),
    },
    vscode_problems: {
      cap: 'vscode', app: 'vscode', noAsk: true,
      description: 'List the errors and warnings VS Code shows in its Problems panel for the sandbox (optionally for one file). Use it after editing to check your work.',
      schema: { type: 'object', properties: { path: str('Optional: only this file') } },
      describe: a => `VS Code: list problems${a.path ? ` in ${safePath(a.path).rel}` : ''}`,
      run: a => call({ op: 'problems', path: a.path ? safePath(a.path).rel : null }),
    },
    vscode_open: {
      cap: 'vscode', app: 'vscode', noAsk: true,
      description: 'Open a file in VS Code at a line, so the user can see it (for example a file you just changed).',
      schema: { type: 'object', properties: { path: str('File path'), line: { type: 'number', description: 'Line to show, default 1' } }, required: ['path'] },
      describe: a => `VS Code: open ${safePath(a.path).rel}${a.line ? ` at line ${a.line}` : ''}`,
      run: a => { const { abs } = safePath(a.path); return call({ op: 'open', abs, line: Number(a.line) || 1 }); },
    },
  };
}

const promptText = () => `
VS Code — I am working on this project in VS Code. Tools: vscode_info, vscode_problems, vscode_open.
- Start by calling vscode_info to see my open files, my selection and any UNSAVED files. Never write to a file that has unsaved changes in VS Code; ask me to save it first.
- Edit code with edit_file for small changes and write_file for new or rewritten files. Use delete_path only when a file or folder really should go (I can undo it).
- After changing code, call vscode_problems to check for new errors and fix them, then use vscode_open to show me the main file you changed.
\`\`\`homebox
vscode_info
\`\`\``;

async function test() {
  try {
    const w = await pickWindow();
    return { ok: true, version: `${w.version}${w.holdsSandbox ? '' : ' (sandbox folder not open there)'}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- installing the extension into VS Code ----------
function codeCli() {
  const cands = [
    path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', IS_WIN ? 'code.cmd' : 'code'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'),
  ];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) cands.push(path.join(dir, IS_WIN ? 'code.cmd' : 'code'));  // installed elsewhere
  return cands.find(f => fs.existsSync(f)) || null;
}
const extDir = () => path.join(process.env.USERPROFILE || HOME, '.vscode', 'extensions');
function installedVersion() {
  try { const d = fs.readdirSync(extDir()).filter(n => n.toLowerCase().startsWith(EXT_ID + '-')); return d.length ? d.sort().pop().slice(EXT_ID.length + 1) : null; } catch { return null; }
}
function status() {
  const cli = codeCli();
  return { available: !!cli, on: !!installedVersion(), where: [extDir()], label: 'Install the Homebox extension in VS Code' };
}

// A .vsix is a zip with a manifest; VS Code installs it with its own installer.
function buildVsix() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;
  const types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".png" ContentType="image/png" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>';
  const files = { '[Content_Types].xml': Buffer.from(types), 'extension.vsixmanifest': Buffer.from(manifest) };
  for (const f of ['package.json', 'extension.js', 'icon.png']) files[`extension/${f}`] = fs.readFileSync(path.join(SRC, f));
  const out = path.join(DATA, 'steps', 'homebox-vscode.vsix');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, makeZip(files));
  return out;
}

function runCode(args) {
  const cli = codeCli();
  if (!cli) return Promise.reject(new Error('VS Code was not found. Install VS Code, or install the extension yourself: Extensions view → … → Install from VSIX.'));
  return new Promise((resolve, reject) => {
    const child = spawn(`"${cli}"`, args.map(a => `"${a}"`), { shell: true, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('VS Code took too long to install the extension.')); }, 120_000);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').pop() || `VS Code exited with code ${code}`)); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
async function setInstalled(on) {
  if (on) await runCode(['--install-extension', buildVsix(), '--force']);
  else await runCode(['--uninstall-extension', EXT_ID]);
}

// If an older Homebox extension is installed in VS Code, install the one that came with this Homebox.
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function updateIfOld() {
  const have = installedVersion();
  if (!have || !codeCli()) return null;
  const bundled = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version;
  if (!newer(bundled, have)) return null;
  await setInstalled(true);
  return bundled;
}

module.exports = { APP, tools, promptText, test, status, setInstalled, buildVsix, updateIfOld };
