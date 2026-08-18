const { app, safeStorage, shell } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Injected at build time by webpack DefinePlugin — set GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET in your .env file before building.
/* global GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET */

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

let callbackServer = null;

function getTokenPath() {
  return path.join(app.getPath('userData'), 'google-tokens.enc');
}

function getCredsPath() {
  return path.join(app.getPath('userData'), 'google-creds.enc');
}

// ── Token storage ─────────────────────────────────────────────────────────────
function storeTokens(tokens) {
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(getTokenPath(), safeStorage.encryptString(json));
  } else {
    fs.writeFileSync(getTokenPath() + '.plain', json, 'utf8');
  }
}

function loadTokens() {
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(getTokenPath())) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(getTokenPath())));
    }
    const plain = getTokenPath() + '.plain';
    if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, 'utf8'));
    return null;
  } catch { return null; }
}

// ── Credential storage (client ID + secret) ───────────────────────────────────
function storeCreds(clientId, clientSecret) {
  const json = JSON.stringify({ clientId, clientSecret });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(getCredsPath(), safeStorage.encryptString(json));
  } else {
    fs.writeFileSync(getCredsPath() + '.plain', json, 'utf8');
  }
}

function loadCreds() {
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(getCredsPath())) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(getCredsPath())));
    }
    const plain = getCredsPath() + '.plain';
    if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, 'utf8'));
    return null;
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────
function isConnected() {
  return !!loadTokens()?.refresh_token;
}

function clearTokens() {
  try { fs.unlinkSync(getTokenPath()); } catch {}
  try { fs.unlinkSync(getTokenPath() + '.plain'); } catch {}
}

async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return null;

  const twoMinutesFromNow = Date.now() + 2 * 60 * 1000;
  if (tokens.access_token && tokens.expires_at && tokens.expires_at > twoMinutesFromNow) {
    return tokens.access_token;
  }

  // Refresh the token
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    storeTokens({
      ...tokens,
      access_token: data.access_token,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
      ...(data.refresh_token && { refresh_token: data.refresh_token }),
    });
    return data.access_token;
  } catch { return null; }
}

function beginOAuth() {
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString('hex');
    let port;

    // Shut down any previous hanging server
    if (callbackServer) {
      try { callbackServer.close(); } catch {}
      callbackServer = null;
    }

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') { res.end(); return; }

      const code = url.searchParams.get('code');
      const stateParam = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Validate before responding — success page must never show on error or state mismatch
      if (error || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Northlight Meetings</title></head>' +
          '<body style="font-family:system-ui;background:#0E0E14;color:#C8CCE0;display:flex;align-items:center;' +
          'justify-content:center;height:100vh;margin:0;text-align:center">' +
          '<div><h2 style="color:#C44F4F;margin-bottom:12px">&#10007; Connection failed</h2>' +
          '<p style="color:#8A92A8">You can close this tab and return to Northlight Meetings.</p></div>' +
          '</body></html>');
        callbackServer.close(); callbackServer = null;
        reject(new Error(error || 'OAuth cancelled')); return;
      }
      if (stateParam !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Northlight Meetings</title></head>' +
          '<body style="font-family:system-ui;background:#0E0E14;color:#C8CCE0;display:flex;align-items:center;' +
          'justify-content:center;height:100vh;margin:0;text-align:center">' +
          '<div><h2 style="color:#C44F4F;margin-bottom:12px">&#10007; Connection failed</h2>' +
          '<p style="color:#8A92A8">Security check failed. Please try again.</p></div>' +
          '</body></html>');
        callbackServer.close(); callbackServer = null;
        reject(new Error('State mismatch — try connecting again')); return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Northlight Meetings</title></head>' +
        '<body style="font-family:system-ui;background:#0E0E14;color:#C8CCE0;display:flex;align-items:center;' +
        'justify-content:center;height:100vh;margin:0;text-align:center">' +
        '<div><h2 style="color:#4FC3C8;margin-bottom:12px">&#10003; Connected to Google</h2>' +
        '<p style="color:#8A92A8">You can close this tab and return to Northlight Meetings.</p></div>' +
        '</body></html>');

      callbackServer.close();
      callbackServer = null;

      try {
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: `http://localhost:${port}/callback`,
            grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          reject(new Error(`Token exchange failed (${tokenRes.status}): ${errText}`));
          return;
        }
        const tokens = await tokenRes.json();
        storeTokens({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        });
        resolve({ success: true });
      } catch (err) { reject(err); }
    });

    callbackServer.listen(0, '127.0.0.1', () => {
      port = callbackServer.address().port;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `http://localhost:${port}/callback`,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      shell.openExternal(`${GOOGLE_AUTH_URL}?${params.toString()}`);
    });

    callbackServer.on('error', reject);
  });
}

module.exports = { beginOAuth, getValidAccessToken, isConnected, clearTokens };
