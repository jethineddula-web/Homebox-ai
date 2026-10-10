// Other creative and office apps the AI can work in. Every step waits for the user's approval.
// Four ways to reach an app:
//   python — our bridge script runs inside the app and listens on 127.0.0.1 (needs the shared secret)
//   adobe  — Photoshop / Illustrator ExtendScript through Windows COM (DoJavaScript)
//   ae     — After Effects runs a script file handed to AfterFX.exe -r and writes the result to a file
//   com    — Office / AutoCAD: a PowerShell script with the running app's COM object ready to use
//   obs    — OBS Studio's built-in WebSocket server (obs-websocket 5)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DATA, HOME, IS_WIN, config, saveConfig } = require('./config');
const { BRIDGE_DIR, BRIDGE_FILE, bridgeCall: rawBridgeCall, runLine } = require('./bridge');
const { wsRoot } = require('./sandbox');
const { checkCode } = require('./files');
const VSC = require('./vscode');
const GH = require('./github');

const STEP_DIR = path.join(DATA, 'steps');
const DOCS = path.join(HOME, 'Documents');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');


// ---------- the apps ----------
const APPS = [
  {
    id: 'blender', name: 'Blender', cat: '3D & VFX', abbr: 'Bl', kind: 'python', port: 7010, lang: 'python', process: 'blender',
    blurb: 'Model, light, animate and render with bpy.',
    globals: 'bpy, mathutils, C (= bpy.context), D (= bpy.data) and SANDBOX are ready',
    tips: 'Prefer bpy.data and object properties over bpy.ops (operators depend on the viewport context). Each step is one undo step.',
    example: "bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))\nC.active_object.name = 'crate'\nprint([o.name for o in D.objects])",
    console: 'Scripting workspace → Python Console',
  },
  {
    id: 'houdini', name: 'Houdini', cat: '3D & VFX', abbr: 'Hou', kind: 'python', port: 7011, lang: 'python', process: 'houdini',
    blurb: 'Build node networks, SOPs and simulations with hou.',
    globals: 'hou and SANDBOX are ready',
    tips: 'Create nodes with hou.node("/obj").createNode(...), set parms with node.parm("tx").set(...), call layoutChildren(). Each step is one undo step.',
    example: "geo = hou.node('/obj').createNode('geo', 'crate')\nbox = geo.createNode('box')\nprint(geo.path(), box.path())",
    console: 'Windows → Python Shell',
  },
  {
    id: 'max', name: '3ds Max', cat: '3D & VFX', abbr: '3ds', kind: 'python', port: 7012, lang: 'python', process: '3dsmax',
    blurb: 'Create and edit scenes with pymxs (MAXScript from Python).',
    globals: 'pymxs, rt (= pymxs.runtime) and SANDBOX are ready',
    tips: 'Use rt.Box(name="crate", length=20, width=20, height=20), rt.Point3(x, y, z), rt.select(...), rt.redrawViews(). Each step is one undo step.',
    example: "b = rt.Box(name='crate', length=20, width=20, height=20)\nb.position = rt.Point3(0, 0, 10)\nprint([o.name for o in rt.objects])",
    console: 'Scripting → Scripting Listener (switch it to Python)',
  },
  {
    id: 'c4d', name: 'Cinema 4D', cat: '3D & VFX', abbr: 'C4D', kind: 'python', port: 7013, lang: 'python', process: 'Cinema 4D',
    blurb: 'Build scenes and motion graphics with the c4d module.',
    globals: 'c4d, doc (the active document) and SANDBOX are ready',
    tips: 'Insert objects with doc.InsertObject(obj) and call doc.AddUndo(c4d.UNDOTYPE_NEWOBJ, obj) right after, so the step can be undone. Homebox calls c4d.EventAdd() for you.',
    example: "cube = c4d.BaseObject(c4d.Ocube)\ncube.SetName('crate')\ndoc.InsertObject(cube)\ndoc.AddUndo(c4d.UNDOTYPE_NEWOBJ, cube)\nprint(cube.GetName())",
    console: null,
  },
  {
    id: 'nuke', name: 'Nuke', cat: '3D & VFX', abbr: 'Nk', kind: 'python', port: 7014, lang: 'python', process: 'Nuke',
    blurb: 'Build compositing node trees.',
    globals: 'nuke and SANDBOX are ready',
    tips: 'Create nodes with nuke.nodes.Blur(size=4) or nuke.createNode("Grade"), connect with node.setInput(0, other). Each step is one undo step.',
    example: "r = nuke.nodes.Read(file=SANDBOX + '/plate.####.exr')\nb = nuke.nodes.Blur(size=4)\nb.setInput(0, r)\nprint(b.name())",
    console: 'Script Editor (Python)',
  },
  {
    id: 'unreal', name: 'Unreal Engine', cat: '3D & VFX', abbr: 'UE', kind: 'python', port: 7015, lang: 'python', process: 'UnrealEditor',
    blurb: 'Place actors, edit levels and assets in the editor.',
    globals: 'unreal and SANDBOX are ready',
    tips: 'Use unreal.EditorActorSubsystem via unreal.get_editor_subsystem(...), unreal.EditorAssetLibrary for assets. Each step is one editor transaction (Ctrl+Z).',
    example: "actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)\nlight = actors.spawn_actor_from_class(unreal.PointLight, unreal.Vector(0, 0, 300))\nlight.set_actor_label('KeyLight')\nprint(light.get_actor_label())",
    console: 'Output Log → switch "Cmd" to "Python"',
  },
  {
    id: 'painter', name: 'Substance 3D Painter', cat: '3D & VFX', abbr: 'Pt', kind: 'python', port: 7016, lang: 'python', process: 'Adobe Substance 3D Painter',
    blurb: 'Manage projects, texture sets, layers and exports.',
    globals: 'substance_painter (with project, textureset, layerstack, export, resource, baking already imported) and SANDBOX are ready',
    tips: 'Check substance_painter.project.is_open() first. Export with substance_painter.export.export_project_textures(config).',
    example: "import substance_painter.project as p\nprint('open:', p.is_open())\nif p.is_open():\n    print(p.name(), [t.name() for t in substance_painter.textureset.all_texture_sets()])",
    console: null,
  },
  {
    id: 'photoshop', name: 'Photoshop', cat: 'Adobe', abbr: 'Ps', kind: 'adobe', progId: 'Photoshop.Application', process: 'Photoshop', lang: 'jsx',
    blurb: 'Create documents, layers, text and exports with ExtendScript.',
    globals: 'app (Photoshop) and SANDBOX (a folder path string) are ready',
    tips: 'ExtendScript is old JavaScript (ES3): use var, no arrow functions or let/const. The value of the last line is sent back — end with a string. When a document is open, each step is one History step.',
    example: "var doc = app.documents.add(1920, 1080, 72, 'Poster');\nvar layer = doc.artLayers.add();\nlayer.name = 'Background art';\n'Made ' + doc.name + ' with ' + doc.layers.length + ' layers'",
  },
  {
    id: 'illustrator', name: 'Illustrator', cat: 'Adobe', abbr: 'Ai', kind: 'adobe', progId: 'Illustrator.Application', process: 'Illustrator', lang: 'jsx',
    blurb: 'Draw shapes, text and artboards with ExtendScript.',
    globals: 'app (Illustrator) and SANDBOX (a folder path string) are ready',
    tips: 'ExtendScript is old JavaScript (ES3): use var, no arrow functions or let/const. Coordinates are in points and y goes up. The value of the last line is sent back — end with a string.',
    example: "var doc = app.documents.length ? app.activeDocument : app.documents.add();\nvar c = doc.pathItems.ellipse(300, 100, 200, 200);\nc.name = 'logo circle';\n'Items: ' + doc.pageItems.length",
  },
  {
    id: 'aftereffects', name: 'After Effects', cat: 'Adobe', abbr: 'Ae', kind: 'ae', process: 'AfterFX', lang: 'jsx',
    blurb: 'Build compositions, layers, keyframes and render queues.',
    globals: 'app (After Effects) and SANDBOX (a folder path string) are ready',
    tips: 'ExtendScript is old JavaScript (ES3): use var, no arrow functions. Collection indexes start at 1 (app.project.item(1)). The value of the last line is sent back — end with a string. Each step is one undo group.',
    example: "var comp = app.project.items.addComp('Intro', 1920, 1080, 1, 10, 30);\nvar t = comp.layers.addText('Hello');\nt.property('Position').setValueAtTime(0, [200, 540]);\n'Comp ' + comp.name + ' has ' + comp.numLayers + ' layers'",
  },
  {
    id: 'excel', name: 'Excel', cat: 'Office', abbr: 'X', kind: 'com', progId: 'Excel.Application', varName: 'excel', process: 'EXCEL', lang: 'powershell',
    blurb: 'Fill sheets, write formulas, make charts in the open workbook.',
    globals: '$excel (the running Excel) and $SANDBOX are ready; the current folder is the sandbox',
    tips: 'Excel cannot undo changes made by scripts, so work carefully and tell me before big edits. Use $wb = $excel.ActiveWorkbook; $ws = $wb.ActiveSheet; $ws.Range("A1").Value2 = "Name". Output text with Write-Output.',
    example: "$ws = $excel.ActiveWorkbook.ActiveSheet\n$ws.Range('A1').Value2 = 'Item'\n$ws.Range('B1').Value2 = 'Price'\nWrite-Output \"Sheet: $($ws.Name)\"",
  },
  {
    id: 'word', name: 'Word', cat: 'Office', abbr: 'W', kind: 'com', progId: 'Word.Application', varName: 'word', process: 'WINWORD', lang: 'powershell',
    blurb: 'Write and format documents.',
    globals: '$word (the running Word) and $SANDBOX are ready; the current folder is the sandbox',
    tips: 'Use $doc = $word.ActiveDocument (or $word.Documents.Add()), $doc.Content.InsertAfter("text"), $doc.Paragraphs. Each step is one Undo in Word. Output text with Write-Output.',
    example: "$doc = if ($word.Documents.Count) { $word.ActiveDocument } else { $word.Documents.Add() }\n$doc.Content.InsertAfter(\"Meeting notes`n\")\nWrite-Output \"Paragraphs: $($doc.Paragraphs.Count)\"",
  },
  {
    id: 'powerpoint', name: 'PowerPoint', cat: 'Office', abbr: 'P', kind: 'com', progId: 'PowerPoint.Application', varName: 'ppt', process: 'POWERPNT', lang: 'powershell',
    blurb: 'Build slides, text and layouts.',
    globals: '$ppt (the running PowerPoint) and $SANDBOX are ready; the current folder is the sandbox',
    tips: 'PowerPoint cannot undo script changes, so save first. Use $pres = $ppt.ActivePresentation (or $ppt.Presentations.Add()), $pres.Slides.Add(index, 1) for a title slide. Output text with Write-Output.',
    example: "$pres = if ($ppt.Presentations.Count) { $ppt.ActivePresentation } else { $ppt.Presentations.Add() }\n$s = $pres.Slides.Add($pres.Slides.Count + 1, 1)\n$s.Shapes.Title.TextFrame.TextRange.Text = 'Roadmap'\nWrite-Output \"Slides: $($pres.Slides.Count)\"",
  },
  {
    id: 'autocad', name: 'AutoCAD', cat: 'CAD', abbr: 'CAD', kind: 'com', progId: 'AutoCAD.Application', varName: 'acad', process: 'acad', lang: 'powershell',
    blurb: 'Draw and edit the open drawing.',
    globals: '$acad (the running AutoCAD), $doc (the active drawing) and $SANDBOX are ready',
    tips: 'Points are double arrays: [double[]]@(0,0,0). Add geometry with $doc.ModelSpace.AddLine(...), AddCircle(...), or send commands with $doc.SendCommand("_ZOOM _E "). Each step is one undo mark.',
    example: "$c = $doc.ModelSpace.AddCircle([double[]]@(0,0,0), 50)\n$c.Layer = '0'\nWrite-Output \"Objects in model space: $($doc.ModelSpace.Count)\"",
  },
  {
    id: 'obs', name: 'OBS Studio', cat: 'Streaming', abbr: 'OBS', kind: 'obs', lang: 'json',
    blurb: 'Switch scenes, toggle sources, start and stop recording.',
    globals: '',
    tips: 'Use obs-websocket 5 request names, e.g. GetSceneList, SetCurrentProgramScene {"sceneName": "Live"}, GetInputList, SetInputMute, StartRecord, StopRecord.',
    example: '',
  },
  VSC.APP,
  GH.APP,
];
const BY_ID = Object.fromEntries(APPS.map(a => [a.id, a]));

// App steps always ask. Anything missing from the saved policy starts turned off.
for (const a of APPS) if (!['ask', 'off'].includes(config.policy[a.id])) config.policy[a.id] = 'off';
config.apps = Object.assign({ obs: { port: 4455, password: '' } }, config.apps);


// ---------- automatic start (where the app has a known startup folder) ----------
const BEGIN = '# >>> Homebox >>>', END = '# <<< Homebox <<<';
const blockRe = /# >>> Homebox >>>[\s\S]*?# <<< Homebox <<<\r?\n?/;
const loaderText = () => `${BEGIN}\nimport runpy\nrunpy.run_path(r"${BRIDGE_FILE}")\n${END}\n`;
const subdirs = (dir, re) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && re.test(d.name)).map(d => path.join(dir, d.name)); } catch { return []; } };

// Each target is either a file we own ("copy") or a marked block inside the app's own startup script ("block").
function autoStartTargets(id) {
  switch (id) {
    case 'blender': return subdirs(path.join(APPDATA, 'Blender Foundation', 'Blender'), /^\d+\.\d+$/)
      .map(v => ({ file: path.join(v, 'scripts', 'startup', 'homebox_bridge.py'), copy: BRIDGE_FILE }));
    case 'houdini': return subdirs(DOCS, /^houdini\d+\.\d+$/).map(v => ({ file: path.join(v, 'scripts', '456.py'), block: true }));
    case 'max': return subdirs(path.join(LOCALAPPDATA, 'Autodesk', '3dsMax'), /^\d{4} - 64bit$/)
      .map(v => ({ file: path.join(v, 'ENU', 'scripts', 'startup', 'homebox_start.py'), block: true }));
    case 'nuke': return [{ file: path.join(HOME, '.nuke', 'menu.py'), block: true }];
    case 'painter': {
      const dir = path.join(DOCS, 'Adobe', 'Adobe Substance 3D Painter');
      return fs.existsSync(dir) ? [{ file: path.join(dir, 'python', 'startup', 'homebox_bridge.py'), copy: BRIDGE_FILE }] : [];
    }
    default: return null;
  }
}
function autoStartStatus(id) {
  if (id === 'vscode') return VSC.status();
  const t = autoStartTargets(id);
  if (!t) return null;
  if (!t.length) return { available: false, on: false };
  const on = t.every(x => { try { return x.copy ? fs.existsSync(x.file) : blockRe.test(fs.readFileSync(x.file, 'utf8')); } catch { return false; } });
  return { available: true, on, where: t.map(x => x.file) };
}
function setAutoStart(id, on) {
  if (id === 'vscode') return VSC.setInstalled(on);  // installs or removes the VS Code extension
  const t = autoStartTargets(id);
  if (!t || !t.length) throw new Error(`Open ${BY_ID[id].name} once first, so its settings folder exists.`);
  for (const x of t) {
    if (x.copy) {
      if (on) { fs.mkdirSync(path.dirname(x.file), { recursive: true }); fs.copyFileSync(x.copy, x.file); }
      else fs.rmSync(x.file, { force: true });
      continue;
    }
    let cur = '';
    try { cur = fs.readFileSync(x.file, 'utf8'); } catch {}
    cur = cur.replace(blockRe, '');
    if (on) cur = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + loaderText();
    if (!cur.trim() && !on) { fs.rmSync(x.file, { force: true }); continue; }
    fs.mkdirSync(path.dirname(x.file), { recursive: true });
    fs.writeFileSync(x.file, cur, 'utf8');
  }
}

// ---------- runners ----------
const bridgeCall = (app, msg, timeoutMs) => rawBridgeCall(app, msg, timeoutMs);
const sandboxPath = () => { try { return wsRoot(); } catch { return ''; } };


function powershell(script, timeoutMs) {
  if (!IS_WIN) return Promise.reject(new Error('This app connection needs Windows.'));
  fs.mkdirSync(STEP_DIR, { recursive: true });
  const file = path.join(STEP_DIR, `run-${crypto.randomBytes(6).toString('hex')}.ps1`);
  fs.writeFileSync(file, '\ufeff' + script, 'utf8');
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); err += '\n(stopped: took too long)'; }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 200_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 50_000) err += d; });
    child.on('close', code => { clearTimeout(timer); fs.rm(file, { force: true }, () => {}); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message }); });
  });
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;             // PowerShell single-quoted string
const jsStr = s => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); // ExtendScript-safe
const cleanPsError = s => s.replace(/^\s*(At |\+ |CategoryInfo|FullyQualifiedErrorId).*$/gm, '').replace(/\n{2,}/g, '\n').trim();
const psPrelude = app => `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not (Get-Process -Name ${psq(app.process)} -ErrorAction SilentlyContinue)) { [Console]::Error.Write(${psq(`${app.name} is not open. Open it first, then try again.`)}); exit 3 }
`;

// Photoshop / Illustrator: ExtendScript through COM. The last value of the script comes back.
function adobeScript(app, code, sandbox) {
  const body = `var SANDBOX = ${jsStr(sandbox.replace(/\\/g, '/'))};
var __hb_result;
function __hb_run() {
  try { __hb_result = eval(${jsStr(code)}); __hb_result = (__hb_result === undefined) ? '(ran OK - end the script with a string to report results)' : String(__hb_result); }
  catch (e) { __hb_result = 'ERROR: ' + e.toString() + (e.line ? ' (line ' + e.line + ')' : ''); }
}
if (${app.id === 'photoshop'} && app.documents.length) app.activeDocument.suspendHistory('Homebox AI step', '__hb_run()'); else __hb_run();
__hb_result;`;
  return `${psPrelude(app)}$app = New-Object -ComObject ${psq(app.progId)}
$r = $app.DoJavaScript(${psq(body)})
[Console]::Out.Write([string]$r)
`;
}

// Office / AutoCAD: the AI writes PowerShell with the running app's COM object in a variable.
function comScript(app, code, sandbox) {
  const stepFile = path.join(STEP_DIR, `step-${crypto.randomBytes(6).toString('hex')}.ps1`);
  fs.mkdirSync(STEP_DIR, { recursive: true });
  fs.writeFileSync(stepFile, '\ufeff' + code, 'utf8');
  const extra = app.id === 'autocad' ? `$doc = $acad.ActiveDocument\n` : '';
  const [begin, end] = app.id === 'word' ? ['$word.UndoRecord.StartCustomRecord(\'Homebox AI step\')', '$word.UndoRecord.EndCustomRecord()']
    : app.id === 'autocad' ? ['$doc.StartUndoMark()', '$doc.EndUndoMark()'] : ['', ''];
  return { stepFile, script: `${psPrelude(app)}try { $${app.varName} = [Runtime.InteropServices.Marshal]::GetActiveObject(${psq(app.progId)}) }
catch { [Console]::Error.Write(${psq(`Could not reach ${app.name}. Close any open dialog box in ${app.name} and try again.`)}); exit 3 }
${extra}$SANDBOX = ${psq(sandbox)}
if ($SANDBOX) { Set-Location -LiteralPath $SANDBOX }
${begin ? `try { ${begin} } catch {}` : ''}
try {
  . ${psq(stepFile)} 2>&1 | Out-String -Width 220 | ForEach-Object { [Console]::Out.Write($_) }
} catch {
  [Console]::Error.Write("ERROR: $($_.Exception.Message)")
  exit 1
} finally {
  ${end ? `try { ${end} } catch {}` : ''}
}
` };
}

function afterFxExe() {
  const roots = [process.env.ProgramFiles || 'C:\\Program Files', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')];
  const found = [];
  for (const r of roots) for (const d of subdirs(r, /^Adobe After Effects/)) {
    const exe = path.join(d, 'Support Files', 'AfterFX.exe');
    if (fs.existsSync(exe)) found.push(exe);
  }
  return found.sort().pop() || null;
}
async function aeRun(app, code, sandbox, timeoutMs) {
  const exe = afterFxExe();
  if (!exe) throw new Error('After Effects was not found in Program Files.');
  const running = await powershell(`if (Get-Process -Name 'AfterFX' -ErrorAction SilentlyContinue) { 'yes' }`, 15000);
  if (running.out !== 'yes') throw new Error('After Effects is not open. Open it first, then try again.');
  fs.mkdirSync(STEP_DIR, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const jsx = path.join(STEP_DIR, `ae-${id}.jsx`), outFile = path.join(STEP_DIR, `ae-${id}.txt`);
  fs.writeFileSync(jsx, `(function () {
  var SANDBOX = ${jsStr(sandbox.replace(/\\/g, '/'))};
  var __r, __ok = true;
  app.beginUndoGroup('Homebox AI step');
  try { __r = eval(${jsStr(code)}); } catch (e) { __ok = false; __r = 'ERROR: ' + e.toString() + (e.line ? ' (line ' + e.line + ')' : ''); }
  app.endUndoGroup();
  var f = new File(${jsStr(outFile.replace(/\\/g, '/') + '.tmp')});
  f.encoding = 'UTF-8';
  if (f.open('w')) { f.write((__ok ? 'OK' : 'ERR') + '\\n' + (__r === undefined ? '(ran OK - end the script with a string to report results)' : String(__r))); f.close(); f.rename(${jsStr(path.basename(outFile))}); }
})();
`, 'utf8');
  spawn(exe, ['-r', jsx], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(outFile)) {
        const t = fs.readFileSync(outFile, 'utf8');
        const nl = t.indexOf('\n');
        return { ok: t.slice(0, nl) === 'OK', output: t.slice(nl + 1) };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('After Effects did not answer in time. Check that Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network" is on, and that no dialog box is open.');
  } finally {
    setTimeout(() => { for (const f of [jsx, outFile]) fs.rm(f, { force: true }, () => {}); }, 2000);
  }
}

// OBS Studio: one request over obs-websocket 5.
function obsCall(requestType, requestData, timeoutMs = 15000) {
  const { port = 4455, password = '' } = config.apps.obs || {};
  const b64sha = s => crypto.createHash('sha256').update(s).digest('base64');
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('This version of Homebox cannot open WebSocket connections.'));
    let done = false, ws;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('OBS did not answer in time.')), timeoutMs);
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`, 'obswebsocket.json'); } catch (e) { return finish(e); }
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.op === 0) {
        const d = { rpcVersion: 1 };
        const auth = m.d && m.d.authentication;
        if (auth) {
          if (!password) return finish(new Error('OBS asks for a password. Enter it in Homebox → Apps → OBS Studio.'));
          d.authentication = b64sha(b64sha(password + auth.salt) + auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) {
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: 'homebox', requestData: requestData || {} } }));
      } else if (m.op === 7) {
        const st = m.d.requestStatus || {};
        finish(null, { ok: !!st.result, output: st.result ? JSON.stringify(m.d.responseData || {}, null, 2) : `OBS error ${st.code}: ${st.comment || 'request failed'}` });
      }
    };
    ws.onerror = () => finish(new Error(`OBS is not reachable on port ${port}. In OBS, open Tools → WebSocket Server Settings and turn on "Enable WebSocket server".`));
    ws.onclose = ev => finish(new Error(ev.code === 4009 ? 'OBS rejected the password. Check it in Homebox → Apps → OBS Studio.' : `OBS closed the connection (${ev.code}).`));
  });
}

// Run one step in an app. Resolves { ok, output }.
async function runStep(app, code, timeoutMs = 120_000) {
  const sandbox = sandboxPath();
  switch (app.kind) {
    case 'python': return bridgeCall(app, { op: 'run', code, sandbox, timeout: timeoutMs / 1000 }, timeoutMs + 10_000);
    case 'adobe': {
      const r = await powershell(adobeScript(app, code, sandbox), timeoutMs);
      if (r.code !== 0) return { ok: false, output: cleanPsError(r.err) || `${app.name} did not run the script.` };
      return { ok: !r.out.startsWith('ERROR: '), output: r.out };
    }
    case 'ae': return aeRun(app, code, sandbox, timeoutMs);
    case 'com': {
      const { stepFile, script } = comScript(app, code, sandbox);
      try {
        const r = await powershell(script, timeoutMs);
        const out = [r.out, r.code !== 0 ? cleanPsError(r.err) : ''].filter(Boolean).join('\n');
        return { ok: r.code === 0, output: out || '(ran OK, no output - use Write-Output to report things)' };
      } finally { fs.rm(stepFile, { force: true }, () => {}); }
    }
    default: throw new Error(`Unknown app type ${app.kind}`);
  }
}

// ---------- test connection ----------
const lastTest = {};
async function testApp(id) {
  const app = BY_ID[id];
  if (!app) throw new Error('Unknown app');
  let r;
  try {
    if (app.kind === 'github') {
      r = await GH.test();
    } else if (app.kind === 'vscode') {
      r = await VSC.test();
    } else if (app.kind === 'python') {
      const p = await bridgeCall(app, { op: 'ping' }, 5000);
      r = p.ok ? { ok: true, version: p.version } : { ok: false, error: p.output };
    } else if (app.kind === 'obs') {
      const p = await obsCall('GetVersion', {}, 6000);
      r = p.ok ? { ok: true, version: JSON.parse(p.output).obsVersion } : { ok: false, error: p.output };
    } else if (app.kind === 'adobe' || app.kind === 'ae') {
      const p = await runStep(app, 'app.version', 30000);
      r = p.ok ? { ok: true, version: p.output } : { ok: false, error: p.output };
    } else {
      const p = await runStep(app, `Write-Output $${app.varName}.Version`, 30000);
      r = p.ok ? { ok: true, version: p.output.trim() } : { ok: false, error: p.output };
    }
  } catch (e) { r = { ok: false, error: e.message }; }
  lastTest[id] = { ...r, at: Date.now() };
  return lastTest[id];
}

// ---------- tools for the AI ----------
const str = d => ({ type: 'string', description: d });
const LANG = { python: 'Python', jsx: 'ExtendScript (JavaScript)', powershell: 'PowerShell' };
const toolName = app => app.kind === 'obs' ? 'obs_request' : app.kind === 'vscode' ? 'vscode_info' : app.kind === 'github' ? 'github_publish' : `${app.id}_run_${app.lang}`;

function appTools() {
  const tools = {};
  for (const app of APPS) {
    if (app.kind === 'vscode') { Object.assign(tools, VSC.tools()); continue; }
    if (app.kind === 'github') { Object.assign(tools, GH.tools()); continue; }
    if (app.kind === 'obs') {
      tools.obs_request = {
        cap: 'obs', app: app.id,
        description: 'Send one request to the user\'s running OBS Studio (obs-websocket 5), e.g. {"request": "SetCurrentProgramScene", "data": {"sceneName": "Live"}}. The response data comes back as JSON. The user approves every request.',
        schema: { type: 'object', properties: { request: str('obs-websocket request type, e.g. GetSceneList'), data: { type: 'object', description: 'requestData for that request' } }, required: ['request'] },
        describe: a => `OBS: ${String(a.request || '?')}`,
        preview: a => JSON.stringify(a.data || {}, null, 2),
        previewLang: () => 'json',
        async run(a) {
          if (!String(a.request || '').trim()) throw new Error('request is empty');
          const r = await obsCall(String(a.request), a.data && typeof a.data === 'object' ? a.data : {});
          if (!r.ok) throw new Error(r.output);
          return r.output;
        },
      };
      continue;
    }
    tools[toolName(app)] = {
      cap: app.id, app: app.id,
      description: `Run ${LANG[app.lang]} inside the user's open ${app.name}: ${app.globals}. ${app.lang === 'python' ? 'Output from print() comes back to you.' : app.lang === 'jsx' ? 'The value of the last line comes back to you.' : 'Output from Write-Output comes back to you.'} The user approves every step.`,
      schema: { type: 'object', properties: { code: str(`${LANG[app.lang]} code to run in ${app.name}`), timeout_s: { type: 'number', description: 'Default 120, max 600' } }, required: ['code'] },
      describe: a => { checkCode(a.code); const n = String(a.code || '').split('\n').length; return `${app.name}: run ${n} line${n === 1 ? '' : 's'} of ${LANG[app.lang].split(' ')[0]}`; },
      preview: a => String(a.code ?? ''),
      previewLang: () => app.lang,
      async run(a) {
        if (!String(a.code || '').trim()) throw new Error('code is empty');
        const r = await runStep(app, String(a.code), Math.min(Math.max(Number(a.timeout_s) || 120, 5), 600) * 1000);
        if (!r.ok) throw new Error(r.output);
        return r.output;
      },
    };
  }
  return tools;
}

function appCaps() {
  return Object.fromEntries(APPS.map(a => [a.id, {
    label: `Control ${a.name}`, app: true,
    help: `${a.blurb} ${a.kind === 'github' ? 'Every upload asks you first, even with Full access.' : a.kind === 'obs' ? 'Every request asks you first.' : a.kind === 'vscode' ? 'Code changes are normal file changes: they ask first and can be undone.' : 'Scripts can reach outside the sandbox folder, so every step asks.'}`,
  }]));
}

// The part of the starter prompt that teaches the AI about the apps that are turned on.
function promptSection() {
  const on = APPS.filter(a => config.policy[a.id] !== 'off');
  if (!on.length) return '';
  return '\n\nOTHER APPS ON MY COMPUTER\nThese apps are open on my computer and you can control them live. A simple form is allowed — first line is the tool name, the rest is the code:\n' + on.map(a => {
    if (a.kind === 'vscode') return VSC.promptText();
    if (a.kind === 'github') return GH.promptText();
    if (a.kind === 'obs') return `\n${a.name} — tool obs_request. ${a.tips}\n\`\`\`homebox\nobs_request SetCurrentProgramScene\n{"sceneName": "Live"}\n\`\`\``;
    return `\n${a.name} — tool ${toolName(a)} (${LANG[a.lang]}). ${a.globals}. ${a.tips}\n\`\`\`homebox\n${toolName(a)}\n${a.example}\n\`\`\``;
  }).join('\n') + '\n- Work in small steps and check results before the next step. You cannot see these apps — ask me how things look.';
}

// What the Homebox window shows on the Apps page.
function panelInfo() {
  return APPS.map(a => ({
    id: a.id, name: a.name, cat: a.cat, color: a.color, abbr: a.abbr, kind: a.kind, blurb: a.blurb,
    lang: { python: 'Python', jsx: 'ExtendScript', powershell: 'PowerShell', code: 'any language' }[a.lang] || 'WebSocket', tool: toolName(a), port: a.port || null, console: a.console || null,
    mode: config.policy[a.id], test: lastTest[a.id] || null, autoStart: autoStartStatus(a.id),
    setupLine: a.kind === 'python' ? runLine() : null,
    c4dFolder: a.id === 'c4d' ? path.join(BRIDGE_DIR, 'c4d') : null,
    bridgeFile: a.kind === 'python' ? BRIDGE_FILE : null,
    obs: a.kind === 'obs' ? { port: config.apps.obs.port, hasPassword: !!config.apps.obs.password } : null,
  }));
}

function setObs({ port, password }) {
  if (port !== undefined) {
    const p = Number(port);
    if (!(p >= 1024 && p <= 65535)) throw new Error('Port must be a number between 1024 and 65535');
    config.apps.obs.port = p;
  }
  if (typeof password === 'string') config.apps.obs.password = password;
  saveConfig();
}

module.exports = { APPS, BY_ID, appTools, appCaps, promptSection, panelInfo, testApp, setAutoStart, setObs, toolName, BRIDGE_FILE };
