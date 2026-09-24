const { app, BrowserWindow, shell, session } = require('electron');

const CHAT_URL = 'https://jchat.fly.dev';
const CHAT_ORIGIN = new URL(CHAT_URL).origin;

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      shell.openExternal(url);
    }
  } catch (_) {}
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    icon: `${__dirname}/icon.ico`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === CHAT_ORIGIN) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== CHAT_ORIGIN) {
        event.preventDefault();
        openExternal(url);
      }
    } catch (_) {
      event.preventDefault();
    }
  });
  win.loadURL(CHAT_URL);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.jimmyqrg.chat');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let allowedOrigin = false;
    try {
      allowedOrigin = new URL(details.requestingUrl || webContents.getURL()).origin === CHAT_ORIGIN;
    } catch (_) {}
    callback(allowedOrigin && ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
