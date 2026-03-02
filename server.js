'use strict';
const express  = require('express');
const http     = require('http');
const ws       = require('ws');
const pty      = require('node-pty');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_DB = { data: [], tags: [], snippets: [], snipPkgs: [] };

// ─── DB helpers ────────────────────────────────────────────────────────────
function readDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const p = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      return {
        data:     Array.isArray(p.data)     ? p.data     : [],
        tags:     Array.isArray(p.tags)     ? p.tags     : [],
        snippets: Array.isArray(p.snippets) ? p.snippets : [],
        snipPkgs: Array.isArray(p.snipPkgs) ? p.snipPkgs : [],
      };
    }
  } catch (e) { console.error('readDB:', e.message); }
  return { ...DEFAULT_DB };
}

function writeDB(db) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) { console.error('writeDB:', e.message); return false; }
}

// ─── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'src')));

// DB endpoints
app.get('/api/db',       (_req, res) => res.json(readDB()));
app.get('/api/db/path',  (_req, res) => res.json({ path: DATA_FILE }));
app.post('/api/db',      (req, res)  => res.json({ ok: writeDB(req.body) }));

// Export: client asks server to serialize and return as file download
app.post('/api/db/export', (req, res) => {
  const date    = new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify(req.body, null, 2);
  res.setHeader('Content-Disposition', `attachment; filename="cmdb_backup_${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(payload);
});

// Import: receive uploaded file and return parsed JSON
app.post('/api/db/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    const p = JSON.parse(req.file.buffer.toString('utf-8'));
    if (p.data && Array.isArray(p.data)) {
      return res.json({
        ok: true,
        data: {
          data:     p.data,
          tags:     Array.isArray(p.tags)     ? p.tags     : [],
          snippets: Array.isArray(p.snippets) ? p.snippets : [],
          snipPkgs: Array.isArray(p.snipPkgs) ? p.snipPkgs : [],
        }
      });
    }
    if (Array.isArray(p)) {
      return res.json({ ok: true, data: { data: p, tags: [], snippets: [], snipPkgs: [] } });
    }
    return res.status(400).json({ ok: false, error: 'Formato inválido' });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// Serve the main app for any unknown route
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'src', 'index.html')));

// ─── WebSocket SSH PTY ──────────────────────────────────────────────────────
const wss = new ws.WebSocketServer({ server, path: '/api/ssh/pty' });

wss.on('connection', (socket, req) => {
  console.log(`[WS] New SSH connection from ${req.socket.remoteAddress}`);
  let ptyProc = null;
  let ready   = false;

  socket.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      // ── Start session ──────────────────────────────────────────────────
      if (msg.type === 'start' && !ready) {
        const { host, port, user, password, cols, rows } = msg;
        if (!host) { socket.send(JSON.stringify({ type: 'error', message: 'Host not specified' })); return; }

        const sshArgs = [
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ConnectTimeout=10',
          '-p', String(port || 22),
        ];

        let env = { ...process.env, TERM: 'xterm-256color' };

        // Use sshpass if password provided
        let cmd  = 'ssh';
        let args = [...sshArgs, user ? `${user}@${host}` : host];

        if (password) {
          // Try sshpass first, fallback to expect-style or plain ssh
          try {
            fs.accessSync('/usr/bin/sshpass');
            cmd  = 'sshpass';
            args = ['-p', password, 'ssh', ...sshArgs, user ? `${user}@${host}` : host];
          } catch {
            // sshpass not found, spawn ssh anyway (user will need to type password)
            console.warn('[PTY] sshpass not found, password auth may require manual input');
          }
        }

        try {
          ptyProc = pty.spawn(cmd, args, {
            name: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 30,
            env,
          });
        } catch (e) {
          socket.send(JSON.stringify({ type: 'error', message: e.message }));
          return;
        }

        ready = true;
        socket.send(JSON.stringify({ type: 'open' }));

        ptyProc.onData(data => {
          if (socket.readyState === ws.OPEN)
            socket.send(JSON.stringify({ type: 'data', data }));
        });

        ptyProc.onExit(({ exitCode }) => {
          if (socket.readyState === ws.OPEN)
            socket.send(JSON.stringify({ type: 'close', code: exitCode }));
          ptyProc = null;
          ready   = false;
        });

        return;
      }

      // ── Input ──────────────────────────────────────────────────────────
      if (msg.type === 'data' && ptyProc) {
        ptyProc.write(msg.data);
        return;
      }

      // ── Resize ────────────────────────────────────────────────────────
      if (msg.type === 'resize' && ptyProc) {
        ptyProc.resize(msg.cols, msg.rows);
        return;
      }

      // ── Kill ──────────────────────────────────────────────────────────
      if (msg.type === 'kill') {
        if (ptyProc) { ptyProc.kill(); ptyProc = null; ready = false; }
        return;
      }

    } catch (e) {
      console.error('[WS] Message error:', e.message);
    }
  });

  socket.on('close', () => {
    if (ptyProc) { try { ptyProc.kill(); } catch {} ptyProc = null; }
    console.log('[WS] SSH connection closed');
  });

  socket.on('error', err => {
    console.error('[WS] Socket error:', err.message);
    if (ptyProc) { try { ptyProc.kill(); } catch {} ptyProc = null; }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🖥  CMDB running on http://0.0.0.0:${PORT}`);
  console.log(`📁  Data file: ${DATA_FILE}\n`);
});
