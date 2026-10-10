// Homebox desktop app (Electron): runs the local server and shows the control panel in its own window.
// The window only ever shows Homebox's own pages on 127.0.0.1. Every other link opens in the normal browser.
const path = require('path');
const { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, nativeImage, session } = require('electron');

app.setAppUserModelId('com.jethinproduction.homebox');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
let win = null, tray = null, baseUrl = null, quitting = false, trayHintShown = false;

const isOwnUrl = u => { try { const x = new URL(u); return x.origin === new URL(baseUrl).origin; } catch { return false; } };

function show(page) {
  if (!win) return;
  if (page && /^[a-z]+$/.test(page)) win.webContents.executeJavaScript(`location.hash = '#${page}'`).catch(() => {});
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 380, minHeight: 500,
    title: 'Homebox', icon: ICON, backgroundColor: '#161614', show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  // Links to AI sites, docs and so on open in the user's browser; the window never leaves Homebox.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  // Closing the window keeps Homebox running in the tray, so AI keeps working; Quit is in the tray menu.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Homebox is still running', body: 'It keeps working in the tray. Right-click the Homebox icon to quit.', icon: ICON }).show();
    }
  });
  win.loadURL(baseUrl);
}

function createTray(H) {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Homebox');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Homebox', click: () => show() },
    { label: 'Approvals', click: () => show('approvals') },
    { type: 'separator' },
    { label: H.isPaused() ? 'Resume AI access' : 'Pause all AI access', click: () => { H.setPaused(!H.isPaused()); rebuild(); } },
    { type: 'separator' },
    { label: 'Quit Homebox', click: () => { quitting = true; app.quit(); } },
  ]));
  rebuild();
  H.hub.on('change', rebuild);
  tray.on('click', () => show());
}

app.on('second-instance', () => show());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', e => e.preventDefault());

app.whenReady().then(async () => {
  // The panel needs no camera, microphone, location, notifications and so on. The desktop app shows its own notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const server = require('./core/server');
  const H = require('./core/hub');
  let r;
  try {
    r = await server.start({
      quit: () => { quitting = true; app.quit(); },
      show: page => show(page),
      openPath: p => shell.openPath(p),
      pickFolder: async () => {
        const res = await dialog.showOpenDialog(win, { title: 'Choose the folder AI may work in', properties: ['openDirectory', 'createDirectory'] });
        return res.canceled ? null : res.filePaths[0];
      },
    });
  } catch (e) {
    dialog.showErrorBox('Homebox could not start', e.message);
    app.exit(1);
    return;
  }
  if (r.alreadyRunning) {
    // Homebox is already running from Start Homebox.cmd: just show that one.
    shell.openExternal(`http://127.0.0.1:${r.alreadyRunning}/`);
    app.exit(0);
    return;
  }
  baseUrl = server.url();
  createWindow();
  createTray(H);

  // When AI asks for approval and the window isn't in front, flash the taskbar and show a notification.
  const { config } = require('./core/config');
  H.hub.on('approval', item => {
    if (win && win.isFocused()) return;
    if (!config.ui.notifications) { if (win) win.flashFrame(true); return; }
    if (win) win.flashFrame(true);
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Homebox needs your OK', body: String(item.summary || 'An AI action is waiting'), icon: ICON });
      n.on('click', () => show('approvals'));
      n.show();
    }
  });
  win.on('focus', () => win.flashFrame(false));
});
