// Every tool the AI can call, plus running them with permissions, approvals, logging and undo.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { SNAP_DIR, OS_NAME, VERSION, config } = require('./config');
const { wsRoot, safePath } = require('./sandbox');
const { addLog, requestApproval, isPaused, log } = require('./hub');
const { FILE_TOOLS, S, str, checkCode } = require('./files');
const { mayaRun, mayaText, SCENE_INFO } = require('./maya');
const APPS = require('./apps');
const BROWSER = require('./browser');
const { readDocument } = require('./docs');

// Results go back into the chat as a message. Chat sites slow down as conversations grow, so keep them modest.
const MAX_RESULT_TEXT = 16_000;

const TOOLS = {
  ...FILE_TOOLS,
  maya_run_python: {
    cap: 'maya',
    description: "Run Python inside the user's open Autodesk Maya (maya.cmds is already imported as cmds; SANDBOX is the sandbox folder path). Output from print() comes back to you. Each step is one undo step in Maya. The user approves every step.",
    schema: S({ code: str('Python code using maya.cmds'), timeout_s: { type: 'number', description: 'Default 120, max 600' } }, ['code']),
    describe: a => { checkCode(a.code); const n = String(a.code || '').split('\n').length; return `Maya: run ${n} line${n === 1 ? '' : 's'} of Python`; },
    preview: a => String(a.code ?? ''),
    previewLang: () => 'python',
    async run(a) {
      if (!String(a.code || '').trim()) throw new Error('code is empty');
      const r = await mayaRun(a.code, Math.min(Math.max(Number(a.timeout_s) || 120, 5), 600) * 1000);
      if (!r.ok) throw new Error(mayaText(r));
      return mayaText(r);
    },
  },
  maya_scene_info: {
    cap: 'maya',
    noAsk: true,   // fixed read-only script written by Homebox, not by the AI
    description: 'List what is in the open Maya scene: every object with its type, parent, center and size, plus the selection.',
    schema: S({}),
    describe: () => 'Maya: read scene contents',
    async run() { return mayaText(await mayaRun(SCENE_INFO, 60_000)); },
  },
  read_document: {
    cap: 'read',
    description: 'Read the text of a PDF or Word (.docx) file, such as a CV, a job post or a brief.',
    schema: S({ path: str('File path, e.g. files/cv.pdf') }, ['path']),
    describe: a => `Read document ${safePath(a.path).rel}`,
    async run(a) { return readDocument(safePath(String(a.path || '')).abs); },
  },
  ...BROWSER.TOOLS,
  ...APPS.appTools(),
};

// Human-friendly names for the permission groups, used in the panel and the log.
const CAPS = {
  read: { label: 'Read files', help: 'Look at the files and folders in your AI folder.' },
  write: { label: 'Change files', help: 'Create, edit, move and delete files in your AI folder. Every change can be undone.' },
  exec: { label: 'Run commands', help: 'Run command-line programs in your AI folder. Commands can reach outside the folder, so every one asks.' },
  maya: { label: 'Control Maya', help: 'Run Python in your open Autodesk Maya. Maya scripts can reach outside the folder, so every step asks.' },
  browser: { label: 'Control browser tabs', help: 'Read tabs, fill forms, scroll, play simple games and open email drafts, only on sites you allow in the browser toolbar button. Ask me: typing, clicking and emails wait for you, even with Full access. Automatic: they run without asking. Either way Homebox never types passwords or card details, and you press Send, Submit and Pay yourself.' },
  ...APPS.appCaps(),
};

const toolList = () => Object.entries(TOOLS).filter(([, t]) => config.policy[t.cap] !== 'off')
  .map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema }));

async function execute(tool, a, ctx) {
  a = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const def = TOOLS[tool];
  const base = { source: ctx.source, site: ctx.site, device: ctx.device, tool };
  if (!def) throw new Error(`Unknown tool "${tool}". Available: ${toolList().map(t => t.name).join(', ')}`);
  if (isPaused()) { addLog({ ...base, summary: tool, status: 'blocked', error: 'paused' }); throw new Error('Homebox is paused by the user.'); }
  const mode = config.policy[def.cap] || 'off';
  if (mode === 'off') {
    addLog({ ...base, summary: tool, status: 'blocked', error: `${def.cap} is off` });
    throw new Error(`The user has turned off "${CAPS[def.cap].label}" in Homebox.`);
  }
  let summary;
  try { if (def.prepare) await def.prepare(a, ctx); summary = def.describe(a); } catch (e) { addLog({ ...base, summary: tool, status: 'blocked', error: e.message }); throw e; }
  if (mode === 'ask' && !def.noAsk && (!config.fullAccess || def.alwaysAsk)) {
    const ok = await requestApproval({
      ...base, cap: def.cap, summary, args: a,
      preview: def.preview ? def.preview(a) : null, previewLang: def.previewLang ? def.previewLang(a) : '',
      runId: ctx.runId, deviceId: ctx.deviceId,
    });
    if (!ok) { addLog({ ...base, summary, status: 'denied' }); throw new Error('The user denied this action. Do not retry it; ask the user what they want instead.'); }
  }
  try {
    const r = await def.run(a, ctx);
    if (r && r.__undo) { addLog({ ...base, summary, status: 'ok', undo: r.__undo }); return r.text; }
    addLog({ ...base, summary, status: 'ok' });
    return r;
  } catch (e) {
    addLog({ ...base, summary, status: 'error', error: e.message });
    throw e;
  }
}

const asText = r => typeof r === 'string' ? r : JSON.stringify(r, null, 2);

async function undo(logId) {
  const e = log.find(x => x.id === logId);
  if (!e || !e.undo || e.undone) throw new Error('Nothing to undo');
  const u = e.undo;
  if (u.kind === 'restore') await fsp.copyFile(path.join(SNAP_DIR, u.snap), safePath(u.rel, u.root).abs);
  else if (u.kind === 'remove') await fsp.rm(safePath(u.rel, u.root).abs, { force: true });
  else if (u.kind === 'rmdir') await fsp.rmdir(safePath(u.rel, u.root).abs);
  else if (u.kind === 'move') {
    const f = safePath(u.from, u.root), t = safePath(u.to, u.root);
    if (fs.existsSync(t.abs)) throw new Error(`${t.rel} exists again; move it away first`);
    await fsp.rename(f.abs, t.abs);
  }
  else if (u.kind === 'undelete') {
    const t = safePath(u.rel, u.root);
    if (fs.existsSync(t.abs)) throw new Error(`${t.rel} exists again; move it away first`);
    await fsp.mkdir(path.dirname(t.abs), { recursive: true });
    await fsp.cp(path.join(SNAP_DIR, u.snap), t.abs, { recursive: true, errorOnExist: true, force: false });
  }
  e.undone = true;
  addLog({ source: 'you', tool: 'undo', summary: `Undo: ${e.summary}`, status: 'ok' });
}

function starterPrompt() {
  const tools = toolList().map(t => `- ${t.name}(${Object.keys(t.inputSchema.properties || {}).join(', ')}) — ${t.description}`).join('\n');
  const maya = config.policy.maya === 'off' ? '' : `

AUTODESK MAYA
Maya is open on my computer and you can control it live with maya_run_python. A simple form is allowed — first line "maya_run_python", then the code:
\`\`\`homebox
maya_run_python
body = cmds.polyCylinder(name='body', radius=1, height=3)[0]
cmds.move(0, 1.5, 0, body)
print(cmds.ls(type='mesh'))
\`\`\`
- cmds (maya.cmds) is already imported. Use print() to report what you made; errors come back to me and you.
- Build in small steps (one body part per step), give every object a clear name, group parts, then call maya_scene_info to check positions and sizes.
- You cannot see the viewport — reason with numbers (centers, sizes) and ask me how it looks.
- To save, use cmds.file(rename=SANDBOX + '/character.ma'); cmds.file(save=True, type='mayaAscii').`;
  return `You are an AI agent that can work inside a sandbox folder on my computer through a tool called Homebox.

HOW TO ACT
Write a fenced code block with the language "homebox" that contains JSON:
\`\`\`homebox
{"tool": "list_dir", "args": {"path": "."}}
\`\`\`
You may put several actions in one block as a JSON array: [{"tool":…,"args":…}, {…}].
To write a whole file, a simpler form is allowed — first line "write_file <path>", then the file content:
\`\`\`homebox
write_file notes/todo.md
# My list
- first item
\`\`\`
When your message ends, Homebox runs the actions (I approve risky ones) and my next message gives you the results, starting with "[Homebox results]". Then continue.

TOOLS
${tools}

RULES
- Paths are relative to the sandbox root. You cannot go outside it. Secret files (.env, keys) are hidden.
- Only write homebox blocks for actions you want to run right now. Never write example blocks.
- At most ~5 actions per message, then stop and wait for the results.
- In results, triple backticks inside file contents are shown as ''' .
- If an action is denied, don't repeat it — ask me.
- When the whole task is finished, reply with a short summary ending in DONE, with no homebox block.

Sandbox: "${path.basename(wsRoot())}" on ${OS_NAME}. Shell commands: ${config.policy.exec === 'off' ? 'disabled' : 'allowed (each one needs my approval)'}.${maya}${config.policy.browser && config.policy.browser !== 'off' ? BROWSER.promptText() : ''}${APPS.promptSection()}

MY TASK:
`;
}

function parseBlock(text) {
  let t = String(text).replace(/^\s*homebox[ \t]*\r?\n/i, '').trim();
  if (!t) return null;
  if (t[0] === '{' || t[0] === '[') {
    let v;
    try { v = JSON.parse(t); } catch (e) { return /"tool"\s*:/.test(t) ? { error: `invalid JSON (${e.message})` } : null; }
    const arr = Array.isArray(v) ? v : Array.isArray(v.actions) ? v.actions : [v];
    if (!arr.length || !arr.every(x => x && typeof x.tool === 'string')) return null;
    return { actions: arr.map(x => ({ tool: x.tool, args: x.args || x.arguments || {} })) };
  }
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
      if (rest.trim()) { try { data = JSON.parse(rest); } catch (e) { return { error: `obs_request data is not valid JSON (${e.message})` }; } }
      return arg ? { actions: [{ tool, args: { request: arg.trim(), data } }] } : null;
    }
    default:
      // blender_run_python, photoshop_run_jsx, excel_run_powershell, … : the rest of the block is the code
      if (/^[a-z0-9]+_run_(python|jsx|powershell)$/.test(tool) && rest.trim()) return { actions: [{ tool, args: { code: rest } }] };
      return null;
  }
}

function formatResults(results, note) {
  const parts = results.map((r, i) => {
    const argStr = r.tool === 'write_file' ? JSON.stringify({ path: r.args.path })
      : typeof r.args.code === 'string' ? (n => `(${n} line${n === 1 ? '' : 's'})`)(r.args.code.split('\n').length)
      : JSON.stringify(r.args).slice(0, 300);
    return `#${i + 1} ${r.tool} ${argStr} → ${r.ok ? 'OK' : 'ERROR'}\n${r.output}`;
  });
  let text = `[Homebox results]\n\n${parts.join('\n\n---\n\n')}`.replace(/```/g, "'''");
  if (text.length > MAX_RESULT_TEXT) text = text.slice(0, MAX_RESULT_TEXT) + `\n…[results cut to ${MAX_RESULT_TEXT} characters — read smaller parts if you need more]`;
  return `${text}\n\n${note || 'Continue with more homebox blocks, or finish with a summary and DONE.'}`;
}

async function runActions(actions, ctx) {
  const results = [];
  for (const a of actions) {
    if (a.error) { results.push({ tool: '?', args: {}, ok: false, output: `Your homebox block could not be read: ${a.error}` }); continue; }
    try { results.push({ tool: a.tool, args: a.args || {}, ok: true, output: asText(await execute(a.tool, a.args, ctx)) }); }
    catch (e) { results.push({ tool: a.tool, args: a.args || {}, ok: false, output: e.message }); }
  }
  return results;
}

// Pull every ```homebox block out of a pasted AI reply.
function parseReply(text) {
  const re = /```homebox[^\n]*\n([\s\S]*?)```/g;
  const actions = [];
  let m;
  while ((m = re.exec(String(text || '')))) {
    const parsed = parseBlock(m[1]);
    if (parsed?.error) actions.push({ error: parsed.error });
    else if (parsed) actions.push(...parsed.actions);
  }
  return actions;
}

module.exports = { TOOLS, CAPS, toolList, execute, asText, undo, starterPrompt, parseBlock, parseReply, formatResults, runActions, VERSION };
