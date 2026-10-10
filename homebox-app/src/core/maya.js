// Autodesk Maya: runs Python in the user's open Maya through the Homebox bridge (bridges/homebox_bridge.py).
// The bridge needs Homebox's secret, unlike Maya's own command port, which runs anything sent to it —
// even a request from a web page. Each step is one undo chunk in Maya.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { wsRoot } = require('./sandbox');
const { bridgeCall, runLine, BRIDGE_FILE } = require('./bridge');

const MAYA = { name: 'Maya', port: 7017 };
const NOT_LISTENING = 'Maya is not connected. Open Maya, then either turn on "Start with Maya automatically" in Homebox → Maya and restart Maya, or paste the setup line from Homebox → Maya into the Script Editor (Python tab).';
const setupLine = () => runLine();

const SCENE_INFO = `print('Maya', cmds.about(version=True), '| scene:', cmds.file(q=True, sn=True) or '(not saved yet)', '| units:', cmds.currentUnit(q=True, linear=True))
print('Selected:', ', '.join(cmds.ls(sl=True) or []) or 'nothing')
skip = {'persp', 'top', 'front', 'side'}
rows = 0
for t in cmds.ls(type='transform', long=False) or []:
    if t in skip:
        continue
    rows += 1
    if rows > 250:
        print('... more objects not shown')
        break
    shapes = cmds.listRelatives(t, s=True, f=True) or []
    kind = cmds.nodeType(t) if cmds.nodeType(t) == 'joint' else (cmds.nodeType(shapes[0]) if shapes else 'group')
    parent = (cmds.listRelatives(t, p=True) or ['-'])[0]
    try:
        bb = cmds.exactWorldBoundingBox(t)
        c = tuple(round((bb[i] + bb[i + 3]) / 2, 2) for i in range(3))
        size = tuple(round(bb[i + 3] - bb[i], 2) for i in range(3))
        where = ' center=%s size=%s' % (c, size)
    except Exception:
        where = ''
    print('%s [%s] parent=%s%s' % (t, kind, parent, where))
if rows == 0:
    print('The scene is empty.')
`;

async function mayaRun(code, timeoutMs = 120_000) {
  let sandbox = '';
  try { sandbox = wsRoot(); } catch {}
  return bridgeCall(MAYA, { op: 'run', code: String(code), sandbox, timeout: timeoutMs / 1000 }, timeoutMs + 10_000, NOT_LISTENING);
}

const mayaText = r => `${r.ok ? '' : 'PYTHON ERROR in Maya:\n'}${String(r.output || '').trim() || (r.ok ? '(ran OK, no output — use print() to report things)' : '')}`;

async function mayaTest() {
  try {
    const r = await bridgeCall(MAYA, { op: 'ping' }, 5000, NOT_LISTENING);
    return r.ok ? { ok: true, version: r.version } : { ok: false, error: r.output || 'Maya answered with an error.' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Maya runs Documents\maya\scripts\userSetup.py at every start. We add a marked block that starts the bridge.
const USER_SETUP = path.join(HOME, 'Documents', 'maya', 'scripts', 'userSetup.py');
const BEGIN = '# >>> Homebox >>>', END = '# <<< Homebox <<<';
const autoStartBlock = () => `${BEGIN}
def _homebox_start():
    import runpy
    runpy.run_path(r"${BRIDGE_FILE}")
import maya.utils
maya.utils.executeDeferred(_homebox_start)
${END}
`;
const blockRe = /# >>> Homebox >>>[\s\S]*?# <<< Homebox <<<\r?\n?/;
// The file written by hand during 1.1.0 troubleshooting — safe to replace.
const isOldHomeboxFile = s => /^# Homebox: runs every time Maya starts\./.test(s);
const readSetup = () => { try { return fs.readFileSync(USER_SETUP, 'utf8'); } catch { return ''; } };

function autoStartStatus() {
  const s = readSetup();
  return blockRe.test(s) || isOldHomeboxFile(s);
}
function setAutoStart(on) {
  let cur = readSetup();
  if (isOldHomeboxFile(cur)) cur = '';
  cur = cur.replace(blockRe, '');
  if (on) cur = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + autoStartBlock();
  fs.mkdirSync(path.dirname(USER_SETUP), { recursive: true });
  fs.writeFileSync(USER_SETUP, cur, 'utf8');
}

// Older Homebox versions opened Maya's unprotected command port from userSetup.py. Swap that for the bridge.
function upgradeOldAutoStart() {
  const s = readSetup();
  const old = isOldHomeboxFile(s) || (blockRe.test(s) && !s.match(blockRe)[0].includes('homebox_bridge.py'));
  if (!old) return false;
  try { setAutoStart(true); return true; } catch { return false; }
}
const upgraded = upgradeOldAutoStart();

module.exports = { mayaRun, mayaText, mayaTest, setupLine, SCENE_INFO, autoStartStatus, setAutoStart, USER_SETUP, MAYA_PORT: MAYA.port, upgraded };
