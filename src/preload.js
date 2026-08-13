const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Groq API key
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),

  // Transcription + Analysis
  transcribe: (arrayBuffer, mimeType) => ipcRenderer.invoke('transcribe', arrayBuffer, mimeType),
  analyze: (params) => ipcRenderer.invoke('analyze', params),

  // Sessions
  saveSession: (data) => ipcRenderer.invoke('save-session', data),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  getSession: (id) => ipcRenderer.invoke('get-session', id),
  deleteSession: (id) => ipcRenderer.invoke('delete-session', id),
  updateSession: (id, updates) => ipcRenderer.invoke('update-session', id, updates),

  // ClickUp key
  saveClickupKey: (key) => ipcRenderer.invoke('save-clickup-key', key),
  getClickupKey: () => ipcRenderer.invoke('get-clickup-key'),

  // Integration config (non-sensitive IDs)
  saveIntegrationConfig: (cfg) => ipcRenderer.invoke('save-integration-config', cfg),
  getIntegrationConfig: () => ipcRenderer.invoke('get-integration-config'),

  // Google OAuth
  googleOAuthBegin: () => ipcRenderer.invoke('google-oauth-begin'),
  googleOAuthStatus: () => ipcRenderer.invoke('google-oauth-status'),
  googleOAuthDisconnect: () => ipcRenderer.invoke('google-oauth-disconnect'),
  getGoogleCreds: () => ipcRenderer.invoke('get-google-creds'),

  // Push integrations
  pushDrive: (params) => ipcRenderer.invoke('push-drive', params),
  pushClickup: (params) => ipcRenderer.invoke('push-clickup', params),
  pushCalendar: (params) => ipcRenderer.invoke('push-calendar', params),

  // Audio setup
  checkAudio: () => ipcRenderer.invoke('check-audio'),
  fixAudio: () => ipcRenderer.invoke('fix-audio'),

  // Navigation from main menu
  onNavigate: (callback) => ipcRenderer.on('navigate', (_e, screen) => callback(screen)),

  // Open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
