const { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('fs');
const { execSync } = require('child_process');
const { analyzeTranscript } = require('./analysis');
const { init: sentryInit, captureException } = require('@sentry/electron/main');

// Replace YOUR_SENTRY_DSN with the DSN from sentry.io → your Meetings project → Settings → Client Keys
sentryInit({
  dsn: 'https://e0a35240b3eb86faf9f387edf3613f65@o4511405360087040.ingest.de.sentry.io/4511683630071888',
  environment: app.isPackaged ? 'production' : 'development',
});

if (require('electron-squirrel-startup')) app.quit();

// ── JSON Session Storage ───────────────────────────────────────────────────────
let sessionsPath;
let sessions = [];
let nextId = 1;

function initStorage() {
  sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  if (fs.existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      sessions = data.sessions || [];
      nextId = data.nextId || (sessions.length > 0 ? Math.max(...sessions.map(s => s.id)) + 1 : 1);
    } catch {
      sessions = [];
      nextId = 1;
    }
  }
}

function persistSessions() {
  fs.writeFileSync(sessionsPath, JSON.stringify({ sessions, nextId }, null, 2), 'utf8');
}

// ── API Key (safeStorage) ─────────────────────────────────────────────────────
function saveApiKey(key) {
  const userData = app.getPath('userData');
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(path.join(userData, '.groq-key.enc'), safeStorage.encryptString(key));
  } else {
    fs.writeFileSync(path.join(userData, '.groq-key'), key, 'utf8');
  }
}

function loadApiKey() {
  try {
    const userData = app.getPath('userData');
    if (safeStorage.isEncryptionAvailable()) {
      const p = path.join(userData, '.groq-key.enc');
      if (!fs.existsSync(p)) return null;
      return safeStorage.decryptString(fs.readFileSync(p));
    } else {
      const p = path.join(userData, '.groq-key');
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8');
    }
  } catch {
    return null;
  }
}

// ── Transcription ─────────────────────────────────────────────────────────────
async function transcribeAudio(audioBuffer, mimeType, apiKey) {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const blob = new Blob([audioBuffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, `recording.${ext}`);
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const e = new Error(err.error?.message || 'Transcription failed');
      e.status = response.status;
      throw e;
    }
    const data = await response.json();
    return data.text || '';
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      const e = new Error('timeout');
      e.status = 0;
      throw e;
    }
    throw err;
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 800,
    minHeight: 600,
    title: 'Northlight Meetings',
    backgroundColor: '#0E0E14',
    icon: path.join(__dirname, '..', '..', 'resources', 'northlight-meetings-icon-512x512.png'),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('navigate', 'settings') },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Northlight Meetings', click: () => {
          dialog.showMessageBox(mainWindow, {
            title: 'Northlight Meetings',
            message: 'Northlight Meetings',
            detail: 'Phase 1 — Recording + Transcription\nTranscription powered by Groq Whisper.',
          });
        }},
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  initStorage();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Audio Setup Check ─────────────────────────────────────────────────────────
function checkAudioSetup() {
  try {
    const ps = `
Import-Module AudioDeviceCmdlets -ErrorAction Stop
$play = Get-AudioDevice -Playback
$recList = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Recording' }
$cableOut = $recList | Where-Object { $_.Name -like '*CABLE Output*' }
[PSCustomObject]@{
  DefaultPlayback = $play.Name
  IsRealtekDefault = ($play.Name -like '*Realtek*')
  CableOutputAvailable = ($null -ne $cableOut)
} | ConvertTo-Json
`.trim();
    const raw = execSync(`powershell -NonInteractive -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 8000 }).toString().trim();
    return JSON.parse(raw);
  } catch {
    return { DefaultPlayback: 'Unknown', IsRealtekDefault: false, CableOutputAvailable: false, error: true };
  }
}

function fixAudioSetup() {
  try {
    const ps = `Import-Module AudioDeviceCmdlets -ErrorAction Stop; $idx = (Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*Realtek*Speakers*' } | Select-Object -First 1).Index; if ($idx) { Set-AudioDevice -Index $idx }; $idx`;
    const out = execSync(`powershell -NonInteractive -Command "${ps}"`, { timeout: 8000 }).toString().trim();
    return { fixed: !!out };
  } catch {
    return { fixed: false };
  }
}

ipcMain.handle('check-audio', () => checkAudioSetup());
ipcMain.handle('fix-audio', () => fixAudioSetup());

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('save-api-key', (_e, key) => { saveApiKey(key); return true; });
ipcMain.handle('get-api-key', () => loadApiKey());
ipcMain.handle('has-api-key', () => !!loadApiKey());

ipcMain.handle('transcribe', async (_e, arrayBuffer, mimeType) => {
  const apiKey = loadApiKey();
  if (!apiKey) {
    const e = new Error('No API key configured');
    e.status = 401;
    throw e;
  }
  return transcribeAudio(Buffer.from(arrayBuffer), mimeType, apiKey);
});

ipcMain.handle('save-session', (_e, data) => {
  const session = { id: nextId++, ...data };
  sessions.unshift(session);
  persistSessions();
  return session.id;
});

ipcMain.handle('list-sessions', () => sessions);

ipcMain.handle('get-session', (_e, id) => sessions.find(s => s.id === id) || null);

ipcMain.handle('delete-session', (_e, id) => {
  sessions = sessions.filter(s => s.id !== id);
  persistSessions();
  return true;
});

ipcMain.handle('analyze', async (_e, params) => {
  const apiKey = loadApiKey();
  if (!apiKey) {
    const e = new Error('No API key configured');
    e.status = 401;
    throw e;
  }
  return analyzeTranscript(params, apiKey);
});

ipcMain.handle('update-session', (_e, id, updates) => {
  const session = sessions.find(s => s.id === id);
  if (!session) return false;
  Object.assign(session, updates);
  persistSessions();
  return true;
});

// ── ClickUp Key (safeStorage) ─────────────────────────────────────────────────
function saveClickupKey(key) {
  const userData = app.getPath('userData');
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(path.join(userData, '.clickup-key.enc'), safeStorage.encryptString(key));
  } else {
    fs.writeFileSync(path.join(userData, '.clickup-key'), key, 'utf8');
  }
}

function loadClickupKey() {
  try {
    const userData = app.getPath('userData');
    if (safeStorage.isEncryptionAvailable()) {
      const p = path.join(userData, '.clickup-key.enc');
      if (!fs.existsSync(p)) return null;
      return safeStorage.decryptString(fs.readFileSync(p));
    } else {
      const p = path.join(userData, '.clickup-key');
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8');
    }
  } catch { return null; }
}

ipcMain.handle('save-clickup-key', (_e, key) => { saveClickupKey(key); return true; });
ipcMain.handle('get-clickup-key', () => loadClickupKey());

// ── Integration Config (plain JSON — non-sensitive IDs) ───────────────────────
function getIntegrationConfigPath() {
  return path.join(app.getPath('userData'), 'integration-config.json');
}

function loadIntegrationConfig() {
  try {
    const p = getIntegrationConfigPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function saveIntegrationConfig(cfg) {
  fs.writeFileSync(getIntegrationConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

ipcMain.handle('save-integration-config', (_e, cfg) => { saveIntegrationConfig(cfg); return true; });
ipcMain.handle('get-integration-config', () => loadIntegrationConfig());

// ── Google OAuth ──────────────────────────────────────────────────────────────
ipcMain.handle('google-oauth-begin', async () => {
  const { beginOAuth } = require('./google-oauth');
  return beginOAuth();
});

ipcMain.handle('google-oauth-status', () => {
  return require('./google-oauth').isConnected();
});

ipcMain.handle('google-oauth-disconnect', () => {
  require('./google-oauth').clearTokens();
  return true;
});

ipcMain.handle('get-google-creds', () => {
  return require('./google-oauth').loadCreds();
});

// ── Push Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('push-drive', async (_e, { session, templateFileId, targetFolderId }) => {
  const { pushToDrive } = require('./integrations');
  const { getValidAccessToken } = require('./google-oauth');
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('Not connected to Google — please connect in Settings.');
  return pushToDrive({ session, templateFileId, targetFolderId, accessToken });
});

ipcMain.handle('push-clickup', async (_e, { session, listId }) => {
  const { pushToClickup } = require('./integrations');
  const clickupApiKey = loadClickupKey();
  if (!clickupApiKey) throw new Error('No ClickUp API key — please add it in Settings.');
  return pushToClickup({ session, listId, clickupApiKey });
});

ipcMain.handle('push-calendar', async (_e, { session }) => {
  const { pushToCalendar } = require('./integrations');
  const { getValidAccessToken } = require('./google-oauth');
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('Not connected to Google — please connect in Settings.');
  return pushToCalendar({ session, accessToken });
});
