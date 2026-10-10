// The Homebox bridge: a small Python server (bridges/homebox_bridge.py) that runs inside Maya,
// Blender, Houdini and other apps. It listens on 127.0.0.1 only and every request must carry the
// secret in ~/.homebox/bridge_token, so web pages and other computers cannot use it.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { DATA, token } = require('./config');

const BRIDGE_SRC = path.join(__dirname, '..', '..', 'bridges').replace('app.asar', 'app.asar.unpacked');
const BRIDGE_DIR = path.join(DATA, 'bridges');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'homebox_bridge.py');
const TOKEN_FILE = path.join(DATA, 'bridge_token');

function installBridgeFiles() {
  fs.mkdirSync(path.join(BRIDGE_DIR, 'c4d'), { recursive: true });
  for (const rel of ['homebox_bridge.py', path.join('c4d', 'homebox_c4d.pyp')]) {
    try { fs.copyFileSync(path.join(BRIDGE_SRC, rel), path.join(BRIDGE_DIR, rel)); } catch (e) { console.error('bridge copy failed', rel, e.message); }
  }
  if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, token(32), { mode: 0o600 });
}
installBridgeFiles();

const bridgeToken = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const runLine = () => `import runpy; runpy.run_path(r"${BRIDGE_FILE}")`;

// Send one JSON request to the bridge inside an app and wait for its one-line JSON answer.
function bridgeCall({ name, port }, msg, timeoutMs, notListening) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error(`${name} did not answer in time. It may still be working, or a dialog box is open in ${name}.`)), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ token: bridgeToken(), ...msg }) + '\n'));
    sock.on('data', d => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { try { finish(null, JSON.parse(buf.slice(0, nl))); } catch (e) { finish(e); } }
    });
    sock.on('error', e => finish(e.code === 'ECONNREFUSED'
      ? new Error(notListening || `${name} is not listening on port ${port}. Open ${name} and start the Homebox bridge in it (Homebox → Apps → ${name}).`)
      : e));
    sock.on('close', () => finish(new Error(`${name} closed the connection without an answer. Is something else using port ${port}?`)));
  });
}

module.exports = { BRIDGE_DIR, BRIDGE_FILE, bridgeToken, bridgeCall, runLine };
