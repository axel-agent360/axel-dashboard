const express = require('express');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3847;
const LOGS_DIR = path.join(__dirname, '../logs');
const CONV_DIR = path.join(LOGS_DIR, 'conversations');
const MEMORY_DIR = '/home/ubuntu/.claude/projects/-home-ubuntu/memory';

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// API: Get activity logs
app.get('/api/activity', (req, res) => {
  const logFile = path.join(LOGS_DIR, 'activity.log');
  if (!fs.existsSync(logFile)) {
    return res.json([]);
  }
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
  const activities = lines.slice(-100).map(line => {
    const [timestamp, tool, result] = line.split('|');
    return { timestamp, tool, result };
  }).reverse();
  res.json(activities);
});

// API: Get memory entries
app.get('/api/memory', (req, res) => {
  const memory = { solutions: [], errors: [], patterns: [] };

  ['solutions', 'errors', 'patterns'].forEach(type => {
    const dir = path.join(MEMORY_DIR, type);
    if (fs.existsSync(dir)) {
      memory[type] = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md') && !f.startsWith('.'))
        .map(f => ({
          name: f.replace('.md', ''),
          path: path.join(dir, f),
          modified: fs.statSync(path.join(dir, f)).mtime
        }));
    }
  });

  res.json(memory);
});

// API: Get memory file content
app.get('/api/memory/:type/:name', (req, res) => {
  const { type, name } = req.params;
  const validTypes = ['solutions', 'errors', 'patterns'];
  if (!validTypes.includes(type)) return res.status(400).send('Invalid type');
  const safeName = path.basename(name);
  const filePath = path.join(MEMORY_DIR, type, `${safeName}.md`);
  if (fs.existsSync(filePath)) {
    res.type('text/markdown').send(fs.readFileSync(filePath, 'utf-8'));
  } else {
    res.status(404).send('Not found');
  }
});

// API: List conversation logs
app.get('/api/conversations', (req, res) => {
  if (!fs.existsSync(CONV_DIR)) return res.json([]);
  const files = fs.readdirSync(CONV_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();
  res.json(files.map(f => ({ date: f.replace('.jsonl', ''), file: f })));
});

// API: Get conversation for a specific date
app.get('/api/conversations/:date', (req, res) => {
  const safeDate = path.basename(req.params.date).replace(/[^0-9-]/g, '');
  const filePath = path.join(CONV_DIR, `${safeDate}.jsonl`);
  if (!fs.existsSync(filePath)) return res.json([]);
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  const messages = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  res.json(messages);
});

// API: Get inventory
app.get('/api/inventory', (req, res) => {
  const invPath = path.join(MEMORY_DIR, 'INVENTORY.md');
  if (fs.existsSync(invPath)) {
    res.type('text/markdown').send(fs.readFileSync(invPath, 'utf-8'));
  } else {
    res.status(404).send('No inventory');
  }
});

// API: Get advisors
app.get('/api/advisors', (req, res) => {
  const advisorsDir = '/home/ubuntu/advisors';
  if (!fs.existsSync(advisorsDir)) {
    return res.json([]);
  }
  const advisors = fs.readdirSync(advisorsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f.replace('.md', ''),
      path: path.join(advisorsDir, f)
    }));
  res.json(advisors);
});

// API: Get system status
app.get('/api/status', (req, res) => {
  const status = {
    cliproxyapi: false,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };

  // Check cliproxyapi
  exec('curl -s http://localhost:8317/v1/models', (err, stdout) => {
    status.cliproxyapi = !err && stdout.includes('claude');
    res.json(status);
  });
});

// WebSocket for live updates
wss.on('connection', (ws) => {
  console.log('Dashboard client connected');

  // Watch activity log for changes
  const logFile = path.join(LOGS_DIR, 'activity.log');
  if (fs.existsSync(logFile)) {
    const watcher = fs.watch(logFile, () => {
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      const last = lines[lines.length - 1];
      if (last) {
        const [timestamp, tool, result] = last.split('|');
        ws.send(JSON.stringify({ type: 'activity', data: { timestamp, tool, result } }));
      }
    });

    ws.on('close', () => watcher.close());
  }

  // Watch conversation logs for changes
  if (fs.existsSync(CONV_DIR)) {
    const convWatcher = fs.watch(CONV_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const filePath = path.join(CONV_DIR, filename);
      if (!fs.existsSync(filePath)) return;
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          const msg = JSON.parse(last);
          ws.send(JSON.stringify({ type: 'conversation', data: msg }));
        } catch {}
      }
    });
    ws.on('close', () => convWatcher.close());
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Axel Dashboard running on http://localhost:${PORT}`);
});
