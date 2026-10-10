// GitHub: the AI builds projects with the normal file tools, then publishes a project folder with github_publish.
// Homebox runs git and the GitHub CLI (gh) itself, with fixed arguments and no shell, so the AI never gets a command line.
// The user signs in to gh themselves (gh auth login); Homebox never sees a password or token.
// Publishing is outward-facing, so it always asks, even with Full access, and the approval lists every file that goes public.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { IS_WIN } = require('./config');
const { safePath, isDenied, SKIP_WALK } = require('./sandbox');

const APP = {
  id: 'github', name: 'GitHub', cat: 'Code', abbr: 'GH', kind: 'github', lang: 'code',
  blurb: 'Publish the projects the AI builds to your GitHub, each with a README. You approve every upload.',
};

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_FILES = 3000, MAX_FILE = 95 * 1024 * 1024, MAX_TOTAL = 500 * 1024 * 1024;
const PERSONAL = /(^|[\/_. -])(cv|resume|résumé|curriculum|passport|payslip|bank[_ -]?statement)([\/_. -]|$)/i;
const GITIGNORE = 'node_modules/\n__pycache__/\n*.pyc\n.venv/\nvenv/\ndist/\nbuild/\n.DS_Store\nThumbs.db\n.env\n.env.*\n*.pem\n*.key\n';

// git and gh may be missing from PATH right after installing them, so also look in their usual folders
const CANDIDATES = {
  git: IS_WIN ? ['git', 'C:\\Program Files\\Git\\cmd\\git.exe'] : ['git'],
  gh: IS_WIN ? ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')] : ['gh'],
};
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' };

function run(file, args, cwd, timeout = 60_000) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, env: ENV, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.code === 'ENOENT' ? 'not found' : err ? err.message : '')).trim() });
    });
  });
}
const found = {};
async function exe(name) {
  if (found[name]) return found[name];
  for (const c of CANDIDATES[name]) {
    const r = await run(c, ['--version'], undefined, 15_000);
    if (r.ok) { found[name] = { file: c, version: r.out.split('\n')[0] }; return found[name]; }
  }
  return null;
}

async function status() {
  const git = await exe('git'), gh = await exe('gh');
  let login = '';
  if (gh) { const r = await run(gh.file, ['api', 'user', '--jq', '.login'], undefined, 20_000); if (r.ok) login = r.out; }
  return { git, gh, login };
}
function missing(s) {
  if (!s.git) return 'Git is not installed. In Homebox → Apps → GitHub, follow step 1 (install Git), then try again.';
  if (!s.gh) return 'The GitHub CLI (gh) is not installed. In Homebox → Apps → GitHub, follow step 2, then try again.';
  if (!s.login) return 'You are not signed in to GitHub yet. Open a terminal, run: gh auth login   and follow the steps in your browser.';
  return '';
}

// The files git would publish: its own list if the folder is already a repository, otherwise every file except the usual junk.
async function filesToPublish(abs, git) {
  if (fs.existsSync(path.join(abs, '.git'))) {
    const r = await run(git.file, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], abs);
    if (r.ok) return r.out.split('\0').filter(Boolean);
  }
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || SKIP_WALK.has(e.name) || e.name === '.venv') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
      if (out.length > MAX_FILES) return;
    }
  })(abs, '');
  return out;
}

const plans = new WeakMap();  // what the approval showed, so the upload is exactly what the user saw
async function plan(a) {
  const name = String(a.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('name must be a GitHub repository name: letters, numbers, dots, dashes and underscores (e.g. maya-batch-renamer).');
  const { abs, rel } = safePath(String(a.folder || ''));
  if (!rel || rel === '.') throw new Error('Publish one project folder (e.g. projects/my-app), never the whole AI folder: it holds your CV and other private files.');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`${rel} is not a folder.`);
  const s = await status();
  const why = missing(s);
  if (why) throw new Error(why);
  const files = await filesToPublish(abs, s.git);
  if (!files.length) throw new Error(`${rel} is empty. Build the project first.`);
  if (files.length > MAX_FILES) throw new Error(`${rel} has more than ${MAX_FILES} files. Add a .gitignore for build output and dependencies first.`);
  const secret = files.filter(f => isDenied(`${rel}/${f}`) || isDenied(f));
  if (secret.length) throw new Error(`These files must never be published (keys, passwords or settings): ${secret.slice(0, 10).join(', ')}. Remove them or add them to .gitignore first.`);
  const personal = files.filter(f => PERSONAL.test(f) && /\.(pdf|docx?|odt|rtf|pages)$/i.test(f));
  if (personal.length) throw new Error(`These look like personal documents and would become public: ${personal.slice(0, 10).join(', ')}. Move them out of the project folder first.`);
  let total = 0;
  for (const f of files) {
    const size = fs.statSync(path.join(abs, f)).size;
    if (size > MAX_FILE) throw new Error(`${f} is over 95 MB. GitHub doesn't accept files that big.`);
    total += size;
  }
  if (total > MAX_TOTAL) throw new Error(`The project is over 500 MB. Leave out build output and big media files.`);
  const visibility = a.visibility === 'public' ? 'public' : 'private';
  const fresh = !fs.existsSync(path.join(abs, '.git'));
  const remote = fresh ? '' : (await run(s.git.file, ['remote', 'get-url', 'origin'], abs)).out;
  plans.set(a, { abs, rel, name, visibility, files, total, login: s.login, git: s.git, gh: s.gh, fresh, remote });
}

async function publish(a) {
  const p = plans.get(a);
  if (!p) throw new Error('Nothing prepared to publish. Try again.');
  const g = (args, t) => run(p.git.file, args, p.abs, t);
  const step = async (r, what) => { if (!r.ok) throw new Error(`${what} failed: ${(r.err || r.out).slice(0, 600)}`); return r; };
  if (!fs.existsSync(path.join(p.abs, '.gitignore'))) fs.writeFileSync(path.join(p.abs, '.gitignore'), GITIGNORE);
  if (p.fresh) await step(await g(['init', '-b', 'main']), 'git init');
  // commits need a name and email: use GitHub's private "noreply" address, so the user's real email never goes public
  if (!/@users\.noreply\.github\.com$/.test((await g(['config', '--local', 'user.email'])).out)) {
    const id = (await run(p.gh.file, ['api', 'user', '--jq', '.id'], p.abs, 20_000)).out;
    await g(['config', 'user.name', p.login]);
    await g(['config', 'user.email', `${id ? `${id}+` : ''}${p.login}@users.noreply.github.com`]);
  }
  await step(await g(['add', '-A']), 'git add');
  const changed = !(await g(['diff', '--cached', '--quiet'])).ok;
  if (changed) await step(await g(['commit', '-m', String(a.message || 'Update project').slice(0, 300)]), 'git commit');
  const hasRemote = (await g(['remote', 'get-url', 'origin'])).ok;
  if (!hasRemote) {
    const args = ['repo', 'create', p.name, `--${p.visibility}`, '--source', '.', '--remote', 'origin', '--push'];
    if (a.description) args.push('--description', String(a.description).slice(0, 350));
    await step(await run(p.gh.file, args, p.abs, 180_000), 'Creating the GitHub repository');
  } else if (changed || p.fresh) {
    await step(await g(['push', '-u', 'origin', 'HEAD'], 180_000), 'git push');
  } else return `Nothing changed in ${p.rel} since the last upload.`;
  const url = (await run(p.gh.file, ['repo', 'view', '--json', 'url', '-q', '.url'], p.abs, 20_000)).out || `https://github.com/${p.login}/${p.name}`;
  return `Published ${p.files.length} files from ${p.rel} to ${url}${hasRemote ? '' : ` (${p.visibility})`}.`;
}

const S = (props, req = []) => ({ type: 'object', properties: props, required: req });
const str = d => ({ type: 'string', description: d });
const kb = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

function tools() {
  return {
    github_info: {
      cap: 'github', app: 'github', noAsk: true,  // only reads: setup and the user's repository list
      description: "Check that GitHub publishing is set up, and list the user's existing repositories (name, description, public or private, last update).",
      schema: S({}),
      describe: () => 'GitHub: check setup and list repositories',
      async run() {
        const s = await status();
        const why = missing(s);
        if (why) return why;
        const r = await run(s.gh.file, ['repo', 'list', '--limit', '100', '--json', 'name,description,visibility,updatedAt,stargazerCount', '--jq', '.[] | "\\(.name) (\\(.visibility | ascii_downcase), updated \\(.updatedAt[0:10])) — \\(.description // "no description")"'], undefined, 30_000);
        return `Signed in to GitHub as ${s.login}. ${s.git.version}; ${s.gh.version}.\n\nRepositories:\n${r.ok ? (r.out || '(none yet)') : `could not list them: ${r.err}`}`;
      },
    },
    github_publish: {
      cap: 'github', app: 'github', alwaysAsk: true,
      description: 'Publish one project folder from the AI folder to GitHub: creates the repository the first time (private unless visibility is "public"), then commits and pushes. Run it again after changes to upload them. The user approves every upload and sees the full file list.',
      schema: S({
        folder: str('Project folder inside the AI folder, e.g. projects/maya-batch-renamer'),
        name: str('Repository name, e.g. maya-batch-renamer'),
        description: str('One-line description shown on GitHub'),
        visibility: { type: 'string', enum: ['public', 'private'], description: 'Default private' },
        message: str('Commit message describing this change'),
      }, ['folder', 'name', 'message']),
      prepare: a => plan(a),
      describe: a => { const p = plans.get(a); return p.remote ? `GitHub: upload changes in ${p.rel} to ${p.remote}` : `GitHub: create ${p.login}/${p.name} from ${p.rel} (${p.visibility === 'public' ? 'PUBLIC: anyone can see it' : 'private'})`; },
      preview: a => {
        const p = plans.get(a);
        return `Repository: ${p.remote || `https://github.com/${p.login}/${p.name}  (new, ${p.visibility})`}\nCommit: ${a.message || ''}\n${a.description ? `Description: ${a.description}\n` : ''}\n${p.files.length} files, ${kb(p.total)}:\n${p.files.slice(0, 300).join('\n')}${p.files.length > 300 ? `\n…and ${p.files.length - 300} more` : ''}`;
      },
      run: a => publish(a),
    },
  };
}

function promptText() {
  return `
GitHub — tools github_info and github_publish. You build projects with the file tools, then publish each project folder.
- Call github_info first to see the setup and the user's existing repositories.
- One folder per project inside the AI folder (for example projects/maya-batch-renamer). Never publish the whole AI folder.
- Build real, working, useful projects that fit the user's skills and goals. A few solid projects beat many empty ones.
- Every project needs: a clear README.md (what it does, a screenshot or example output, how to install and run it, what it's built with), a LICENSE (MIT unless the user says otherwise) and a .gitignore.
- Publish when a project works, then again after real improvements, with honest commit messages.
- Never fake activity: no backdated commits, no commits made only to fill the contribution graph, no copies of other people's work presented as the user's.
- Never put the user's CV, personal documents, passwords or keys in a project.
- The profile README is a public repository named exactly like the user's GitHub username, with a README.md introducing them.
- Make a repository public only when the user wants it public.`;
}

async function test() {
  const s = await status();
  const why = missing(s);
  return why ? { ok: false, error: why } : { ok: true, version: `signed in as ${s.login}` };
}

module.exports = { APP, tools, promptText, test, status };
