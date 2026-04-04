const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const AGENT_KEY = process.env.AGENT_KEY || 'change-me-secret';

// In-memory state
let commandQueue = [];
let latestResult = null;
let lastHeartbeat = 0;

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
  const command = { id: uuidv4(), type, payload, createdAt: Date.now() };
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
  const { commandId, output, screenshot } = req.body;
  latestResult = { commandId, output, screenshot, receivedAt: Date.now() };
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
