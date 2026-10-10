// Tools that work on the sandbox folder and the command line.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { OS_NAME, IS_WIN, SNAP_DIR, config } = require('./config');
const { wsRoot, safePath, isDenied, snapshotFile, SKIP_WALK } = require('./sandbox');

// Before deleting, make sure the whole thing can be backed up for Undo and holds nothing protected.
const MAX_DELETE_FILES = 20_000, MAX_DELETE_BYTES = 500 * 1024 * 1024;
async function deleteCheck(abs, rel) {
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) throw new Error(`${rel} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`${rel} is a link. Delete links yourself.`);
  if (!st.isDirectory()) return { files: 1, bytes: st.size, dir: false };
  let files = 0, bytes = 0;
  async function walk(a, r) {
    for (const e of await fsp.readdir(a, { withFileTypes: true })) {
      const er = `${r}/${e.name}`, ea = path.join(a, e.name);
      if (isDenied(er)) throw new Error(`${rel} contains protected files (like ${er}). Delete it yourself if you really want to.`);
      if (e.isSymbolicLink()) throw new Error(`${rel} contains a link (${er}). Delete it yourself if you really want to.`);
      if (e.isDirectory()) await walk(ea, er);
      else { files++; bytes += (await fsp.stat(ea)).size; }
      if (files > MAX_DELETE_FILES || bytes > MAX_DELETE_BYTES) throw new Error(`${rel} is too big to back up for Undo (over ${MAX_DELETE_FILES.toLocaleString('en')} files or 500 MB). Delete it yourself.`);
    }
  }
  await walk(abs, rel);
  return { files, bytes, dir: true };
}

const MAX_READ = 200_000;
const MAX_OUT = 60_000;
// Approvals always show everything that will run. Code longer than this is refused instead of shown in part.
const MAX_CODE = 100_000;
const MAX_PREVIEW = 100_000;
function checkCode(code, what = 'This step') {
  if (String(code ?? '').length > MAX_CODE) throw new Error(`${what} is too long to review (over ${MAX_CODE.toLocaleString('en')} characters). Split it into smaller steps.`);
}
const fullPreview = s => { s = String(s ?? ''); return s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}\n\n⚠ ${(s.length - MAX_PREVIEW).toLocaleString('en')} more characters are not shown here.` : s; };

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });

const FILE_TOOLS = {
  workspace_info: {
    cap: 'read',
    description: 'Show the sandbox folder name, operating system, permissions and which apps are connected.',
    schema: S({}),
    describe: () => 'Workspace info',
    run: () => ({
      workspace: path.basename(wsRoot()), os: OS_NAME, permissions: { ...config.policy },
      commands_shell: IS_WIN ? 'cmd.exe' : '/bin/sh',
    }),
  },
  list_dir: {
    cap: 'read',
    description: 'List files and folders. Path is relative to the sandbox root ("." = root).',
    schema: S({ path: str('Folder path, default ".".') }),
    describe: a => `List ${safePath(a.path).rel}`,
    async run(a) {
      const { abs, rel } = safePath(a.path);
      const ents = await fsp.readdir(abs, { withFileTypes: true });
      const lines = [];
      for (const e of ents) {
        const r = rel === '.' ? e.name : `${rel}/${e.name}`;
        if (isDenied(r)) continue;
        if (e.isDirectory()) lines.push(`[dir]  ${e.name}/`);
        else {
          let size = '';
          try { size = ` (${(await fsp.stat(path.join(abs, e.name))).size} bytes)`; } catch {}
          lines.push(`[file] ${e.name}${size}`);
        }
      }
      lines.sort((x, y) => x.startsWith('[dir]') === y.startsWith('[dir]') ? x.localeCompare(y) : x.startsWith('[dir]') ? -1 : 1);
      return `${rel}/\n${lines.join('\n') || '(empty)'}`;
    },
  },
  read_file: {
    cap: 'read',
    description: 'Read a text file.',
    schema: S({ path: str('File path') }, ['path']),
    describe: a => `Read ${safePath(a.path).rel}`,
    async run(a) {
      const { abs, rel } = safePath(a.path);
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 8000).includes(0) || /.(pdf|docx)$/i.test(rel)) return /.(pdf|docx)$/i.test(rel) ? `[${rel} is a document: use read_document to read its text]` : `[${rel} is a binary file, ${buf.length} bytes]`;
      const text = buf.subarray(0, MAX_READ).toString('utf8');
      return buf.length > MAX_READ ? `${text}\n…[truncated, ${buf.length} bytes total]` : text;
    },
  },
  search: {
    cap: 'read',
    description: 'Find lines containing text (case-insensitive) in files under a folder.',
    schema: S({ query: str('Text to find'), path: str('Folder to search, default ".".') }, ['query']),
    describe: a => `Search "${String(a.query || '').slice(0, 60)}"`,
    async run(a) {
      const q = String(a.query || '').toLowerCase();
      if (!q) throw new Error('query is empty');
      const start = safePath(a.path);
      const hits = [];
      let files = 0;
      async function walk(abs, rel) {
        if (hits.length >= 100 || files > 5000) return;
        let ents;
        try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (hits.length >= 100) return;
          const r = rel === '.' ? e.name : `${rel}/${e.name}`;
          if (isDenied(r) || e.isSymbolicLink()) continue;  // links could point outside the sandbox
          const p = path.join(abs, e.name);
          if (e.isDirectory()) { if (!SKIP_WALK.has(e.name)) await walk(p, r); continue; }
          files++;
          let st; try { st = await fsp.stat(p); } catch { continue; }
          if (st.size > 1e6) continue;
          let buf; try { buf = await fsp.readFile(p); } catch { continue; }
          if (buf.subarray(0, 8000).includes(0)) continue;
          buf.toString('utf8').split('\n').forEach((line, i) => {
            if (hits.length < 100 && line.toLowerCase().includes(q)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      }
      await walk(start.abs, start.rel);
      return hits.length ? hits.join('\n') : 'No matches.';
    },
  },
  write_file: {
    cap: 'write',
    description: 'Create or overwrite a text file (parent folders are created). The old version is kept so the user can undo.',
    schema: S({ path: str('File path'), content: str('Full new file content') }, ['path', 'content']),
    describe(a) { const { abs, rel } = safePath(a.path); return `${fs.existsSync(abs) ? 'Overwrite' : 'Create'} ${rel} (${String(a.content ?? '').length} chars)`; },
    preview: a => fullPreview(a.content),
    previewLang: a => path.extname(String(a.path || '')).slice(1),
    async run(a) {
      const { abs, rel, root } = safePath(a.path);
      let undo = { kind: 'remove', root, rel };
      if (fs.existsSync(abs)) {
        if (!(await fsp.stat(abs)).isFile()) throw new Error(`${rel} is a folder`);
        undo = { kind: 'restore', root, rel, snap: await snapshotFile(abs) };
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(a.content ?? ''), 'utf8');
      return { __undo: undo, text: `Wrote ${rel} (${String(a.content ?? '').length} chars)` };
    },
  },
  edit_file: {
    cap: 'write',
    description: 'Replace an exact piece of text in a file. old_text must appear exactly once (unless replace_all is true).',
    schema: S({ path: str('File path'), old_text: str('Exact text to find'), new_text: str('Replacement text'), replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']),
    describe: a => `Edit ${safePath(a.path).rel}`,
    preview: a => fullPreview(`- ${String(a.old_text ?? '')}\n+ ${String(a.new_text ?? '')}`),
    previewLang: () => 'diff',
    async run(a) {
      const { abs, rel, root } = safePath(a.path);
      const text = await fsp.readFile(abs, 'utf8');
      const oldT = String(a.old_text ?? ''), newT = String(a.new_text ?? '');
      if (!oldT) throw new Error('old_text is empty');
      const count = text.split(oldT).length - 1;
      if (count === 0) throw new Error('old_text was not found in the file (it must match exactly, including spaces)');
      if (count > 1 && !a.replace_all) throw new Error(`old_text appears ${count} times; add more context or set replace_all`);
      const undo = { kind: 'restore', root, rel, snap: await snapshotFile(abs) };
      await fsp.writeFile(abs, a.replace_all ? text.split(oldT).join(newT) : text.replace(oldT, () => newT), 'utf8');
      return { __undo: undo, text: `Edited ${rel} (${a.replace_all ? count : 1} replacement${a.replace_all && count > 1 ? 's' : ''})` };
    },
  },
  make_dir: {
    cap: 'write',
    description: 'Create a folder (and its parents).',
    schema: S({ path: str('Folder path') }, ['path']),
    describe: a => `Create folder ${safePath(a.path).rel}`,
    async run(a) {
      const { abs, rel, root } = safePath(a.path);
      if (fs.existsSync(abs)) return `${rel} already exists`;
      await fsp.mkdir(abs, { recursive: true });
      return { __undo: { kind: 'rmdir', root, rel }, text: `Created ${rel}/` };
    },
  },
  move_path: {
    cap: 'write',
    description: 'Move or rename a file or folder inside the sandbox. The destination must not exist.',
    schema: S({ from: str('Current path'), to: str('New path') }, ['from', 'to']),
    describe: a => `Move ${safePath(a.from).rel} → ${safePath(a.to).rel}`,
    async run(a) {
      const f = safePath(a.from), t = safePath(a.to);
      if (!fs.existsSync(f.abs)) throw new Error(`${f.rel} does not exist`);
      if (fs.existsSync(t.abs)) throw new Error(`${t.rel} already exists`);
      await fsp.mkdir(path.dirname(t.abs), { recursive: true });
      await fsp.rename(f.abs, t.abs);
      return { __undo: { kind: 'move', root: f.root, from: t.rel, to: f.rel }, text: `Moved ${f.rel} → ${t.rel}` };
    },
  },
  delete_path: {
    cap: 'write',
    description: 'Delete a file or folder in the sandbox. A full backup is kept so the user can undo it. Only delete what really should go.',
    schema: S({ path: str('File or folder path') }, ['path']),
    describe(a) {
      const { abs, rel } = safePath(a.path);
      if (rel === '.') throw new Error("The AI can't delete the whole sandbox folder");
      let st; try { st = fs.lstatSync(abs); } catch { throw new Error(`${rel} does not exist`); }
      return `Delete ${st.isDirectory() ? 'folder ' : ''}${rel}${st.isDirectory() ? ' and everything in it' : ''}`;
    },
    async run(a) {
      const { abs, rel, root } = safePath(a.path);
      if (rel === '.') throw new Error("The AI can't delete the whole sandbox folder");
      const info = await deleteCheck(abs, rel);
      const snap = `del-${crypto.randomBytes(8).toString('hex')}`;
      await fsp.cp(abs, path.join(SNAP_DIR, snap), { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(abs, { recursive: true });
      return { __undo: { kind: 'undelete', root, rel, snap }, text: `Deleted ${rel}${info.dir ? ` (${info.files} file${info.files === 1 ? '' : 's'})` : ''}. A backup is kept, so the user can undo it.` };
    },
  },
  run_command: {
    cap: 'exec',
    description: `Run a shell command in the sandbox folder (${IS_WIN ? 'cmd.exe' : 'sh'}). The user approves every command.`,
    schema: S({ command: str('Command line'), timeout_s: { type: 'number', description: 'Default 120, max 600' } }, ['command']),
    describe: a => { checkCode(a.command, 'This command'); return `Run: ${String(a.command || '').slice(0, 400)}`; },
    preview: a => String(a.command || ''),
    previewLang: () => IS_WIN ? 'bat' : 'sh',
    run(a) {
      return new Promise(resolve => {
        const t = Math.min(Math.max(Number(a.timeout_s) || 120, 1), 600) * 1000;
        const child = spawn(String(a.command), { cwd: wsRoot(), shell: true, env: process.env, windowsHide: true });
        let out = '';
        const add = d => { if (out.length < MAX_OUT) out += d.toString(); };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\n[stopped: timeout]'; }, t);
        child.on('close', code => { clearTimeout(timer); resolve(`exit code ${code}\n${out.slice(0, MAX_OUT)}`); });
        child.on('error', e => { clearTimeout(timer); resolve(`error: ${e.message}`); });
      });
    },
  },
};

// ---------- files the user adds (pictures for a website, reference images for Maya…) ----------
const UPLOAD_MAX = 20 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|heic|avif|ico|psd|exr|hdr|tga)$/i;
const cleanName = n => (path.basename(String(n || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 120)) || 'file';
// Saves into the sandbox (pictures/ or files/), never overwrites, and returns an Undo record.
async function saveUpload(name, base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > UPLOAD_MAX) throw new Error(`"${cleanName(name)}" is larger than 20 MB.`);
  const base = cleanName(name), ext = path.extname(base), stem = base.slice(0, base.length - ext.length) || 'file';
  const dir = IMAGE_EXT.test(base) ? 'pictures' : 'files';
  let target = safePath(`${dir}/${base}`);
  for (let i = 2; fs.existsSync(target.abs); i++) target = safePath(`${dir}/${stem}-${i}${ext}`);
  await fsp.mkdir(path.dirname(target.abs), { recursive: true });
  await fsp.writeFile(target.abs, buf, { flag: 'wx' });
  return { rel: target.rel, bytes: buf.length, undo: { kind: 'remove', root: target.root, rel: target.rel } };
}

module.exports = { FILE_TOOLS, S, str, checkCode, fullPreview, saveUpload, UPLOAD_MAX };
