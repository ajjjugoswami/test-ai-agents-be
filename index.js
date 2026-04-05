const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const AGENT_KEY = process.env.AGENT_KEY || 'change-me-secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// In-memory state
let commandQueue = [];
let latestResult = null;
let lastHeartbeat = 0;
let googleTokens = null; // Store Google OAuth tokens

// Auth middleware for agent endpoints
function agentAuth(req, res, next) {
  if (req.headers['x-agent-key'] !== AGENT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Phone sends a command
app.post('/command', (req, res) => {
  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });
  const command = { id: crypto.randomUUID(), type, payload, createdAt: Date.now() };
  commandQueue.push(command);
  res.json(command);
});

// PC agent polls for pending command
app.get('/command/pending', agentAuth, (req, res) => {
  if (commandQueue.length === 0) {
    return res.json(null);
  }
  const command = commandQueue.shift();
  res.json(command);
});

// PC agent posts result
app.post('/result', agentAuth, (req, res) => {
  const { commandId, output, screenshot, suggestions } = req.body;
  latestResult = { commandId, output, screenshot, suggestions, receivedAt: Date.now() };
  res.json({ ok: true });
});

// Phone fetches latest result
app.get('/result/latest', (req, res) => {
  res.json(latestResult);
});

// PC status
app.get('/status', (req, res) => {
  const online = (Date.now() - lastHeartbeat) < 10000;
  res.json({ online, lastSeen: lastHeartbeat || null });
});

// PC agent heartbeat
app.post('/heartbeat', agentAuth, (req, res) => {
  lastHeartbeat = Date.now();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ message: 'PC Control Backend is running' });
});

// ---- Google OAuth2 ----
function getOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// Start OAuth flow — user visits this URL
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google OAuth not configured' });
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  res.redirect(url);
});

// OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    googleTokens = tokens;
    // Get user info
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    googleTokens.email = data.email;
    googleTokens.name = data.name;
    googleTokens.picture = data.picture;
    res.redirect(`${FRONTEND_URL}?google=connected`);
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect(`${FRONTEND_URL}?google=error`);
  }
});

// Check connection status
app.get('/auth/google/status', (req, res) => {
  if (googleTokens && googleTokens.access_token) {
    res.json({
      connected: true,
      email: googleTokens.email || null,
      name: googleTokens.name || null,
      picture: googleTokens.picture || null,
    });
  } else {
    res.json({ connected: false });
  }
});

// Agent fetches tokens to use Gmail API
app.get('/auth/google/tokens', agentAuth, (req, res) => {
  if (!googleTokens) return res.json(null);
  res.json(googleTokens);
});

// Disconnect Google
app.post('/auth/google/disconnect', (req, res) => {
  googleTokens = null;
  res.json({ ok: true });
});

// Send email via Gmail API (called by agent)
app.post('/google/gmail/send', agentAuth, async (req, res) => {
  try {
    const oauth2Client = await getAuthedClient();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const { to, subject, body } = req.body;
    const rawMessage = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawMessage } });
    res.json({ ok: true, message: `Email sent to ${to}` });
  } catch (e) {
    console.error('Gmail send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create draft via Gmail API
app.post('/google/gmail/draft', agentAuth, async (req, res) => {
  try {
    const oauth2Client = await getAuthedClient();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const { to, subject, body } = req.body;
    const rawMessage = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: rawMessage } } });
    res.json({ ok: true, message: `Draft created for ${to}` });
  } catch (e) {
    console.error('Gmail draft error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper to get authenticated OAuth client (refreshes token if needed)
async function getAuthedClient() {
  if (!googleTokens) throw new Error('Google not connected');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(googleTokens);
  if (googleTokens.expiry_date && Date.now() > googleTokens.expiry_date) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    googleTokens = { ...googleTokens, ...credentials };
    oauth2Client.setCredentials(googleTokens);
  }
  return oauth2Client;
}

// Fetch Gmail inbox messages
app.get('/google/gmail/inbox', agentAuth, async (req, res) => {
  try {
    const oauth2Client = await getAuthedClient();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 10, labelIds: ['INBOX'] });
    const messageIds = (listRes.data.messages || []).map(m => m.id);
    const messages = [];
    for (const id of messageIds) {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
      const headers = msg.data.payload.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      messages.push({ id, from, subject, snippet: msg.data.snippet || '' });
    }
    res.json({ messages });
  } catch (e) {
    console.error('Gmail inbox error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Drive file listing
app.get('/google/drive/files', agentAuth, async (req, res) => {
  try {
    const oauth2Client = await getAuthedClient();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const q = req.query.q || '';
    const params = {
      pageSize: 30,
      fields: 'files(id, name, mimeType, size, webViewLink, modifiedTime)',
      orderBy: 'modifiedTime desc',
    };
    if (q) params.q = `name contains '${q.replace(/'/g, "\\'")}'`;
    const listRes = await drive.files.list(params);
    res.json({ files: listRes.data.files || [] });
  } catch (e) {
    console.error('Drive files error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Calendar events
app.get('/google/calendar/events', agentAuth, async (req, res) => {
  try {
    const oauth2Client = await getAuthedClient();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const now = new Date().toISOString();
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now,
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });
    res.json({ events: eventsRes.data.items || [] });
  } catch (e) {
    console.error('Calendar error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
