'use strict';
const express  = require('express');
const http     = require('http');
const ws       = require('ws');
const pty      = require('node-pty');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');

// ─── Prevent any uncaught exception from killing the server ───────────────
process.on('uncaughtException',  err => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

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

app.get('/api/db',       (_req, res) => res.json(readDB()));
app.get('/api/db/path',  (_req, res) => res.json({ path: DATA_FILE }));
app.post('/api/db',      (req, res)  => res.json({ ok: writeDB(req.body) }));

app.post('/api/db/export', (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="cmdb_backup_${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(req.body, null, 2));
});

app.post('/api/db/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    const p = JSON.parse(req.file.buffer.toString('utf-8'));
    if (p.data && Array.isArray(p.data)) {
      return res.json({ ok: true, data: { data: p.data, tags: p.tags||[], snippets: p.snippets||[], snipPkgs: p.snipPkgs||[] } });
    }
    if (Array.isArray(p)) return res.json({ ok: true, data: { data: p, tags: [], snippets: [], snipPkgs: [] } });
    return res.status(400).json({ ok: false, error: 'Formato inválido' });
  } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'src', 'index.html')));

// ─── Helper: safe WebSocket send ───────────────────────────────────────────
function safeSend(socket, obj) {
  try {
    if (socket.readyState === ws.OPEN)
      socket.send(JSON.stringify(obj));
  } catch (e) { console.error('[WS] safeSend:', e.message); }
}

// ─── Find sshpass ─────────────────────────────────────────────────────────
function findSshpass() {
  const candidates = ['/usr/bin/sshpass', '/usr/local/bin/sshpass', '/bin/sshpass'];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// ─── WebSocket SSH PTY ──────────────────────────────────────────────────────
const wss = new ws.WebSocketServer({ server, path: '/api/ssh/pty' });

wss.on('connection', (socket, req) => {
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
  let ptyProc = null;
  let started = false;

  function cleanup() {
    if (ptyProc) { try { ptyProc.kill(); } catch {} ptyProc = null; }
    started = false;
  }

  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.error('[WS] Bad JSON'); return; }

    // ── Start ────────────────────────────────────────────────────────────
    if (msg.type === 'start') {
      if (started) return safeSend(socket, { type: 'error', message: 'Session already started' });

      const { host, port, user, password, cols, rows } = msg;
      if (!host) return safeSend(socket, { type: 'error', message: 'Host não especificado' });

      // HOME is critical for ssh to find/write known_hosts
      const env = {
        ...process.env,
        TERM:                'xterm-256color',
        HOME:                process.env.HOME || '/root',
        SSH_ASKPASS_REQUIRE: 'never',
        DISPLAY:             '',
      };

      const sshArgs = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'BatchMode=no',
        '-p', String(port || 22),
        ...(user ? ['-l', user] : []),
        host,
      ];

      const sshpass = findSshpass();
      let cmd, args;

      if (password && sshpass) {
        console.log(`[SSH] sshpass → ${user ? user+'@' : ''}${host}:${port||22}`);
        cmd  = sshpass;
        args = ['-p', password, 'ssh', ...sshArgs];
      } else {
        if (password && !sshpass) console.warn('[SSH] sshpass not found — user must type password manually');
        console.log(`[SSH] ssh → ${user ? user+'@' : ''}${host}:${port||22}`);
        cmd  = 'ssh';
        args = sshArgs;
      }

      try {
        ptyProc = pty.spawn(cmd, args, {
          name: 'xterm-256color',
          cols: Math.max(cols || 120, 10),
          rows: Math.max(rows || 30,  5),
          cwd:  process.env.HOME || '/root',
          env,
        });
      } catch (e) {
        console.error('[PTY] spawn failed:', e.message);
        return safeSend(socket, { type: 'error', message: `Falha ao iniciar PTY: ${e.message}` });
      }

      started = true;
      safeSend(socket, { type: 'open' });
      console.log(`[PTY] Spawned PID ${ptyProc.pid}`);

      ptyProc.onData(data => safeSend(socket, { type: 'data', data }));

      ptyProc.onExit(({ exitCode }) => {
        console.log(`[PTY] Exit code=${exitCode}`);
        safeSend(socket, { type: 'close', code: exitCode ?? -1 });
        ptyProc = null;
        started = false;
      });

      return;
    }

    if (msg.type === 'data'   && ptyProc) { try { ptyProc.write(msg.data); }            catch (e) { console.error('[PTY] write:',  e.message); } return; }
    if (msg.type === 'resize' && ptyProc) { try { ptyProc.resize(Math.max(msg.cols,10), Math.max(msg.rows,5)); } catch (e) { console.error('[PTY] resize:', e.message); } return; }
    if (msg.type === 'kill')              { cleanup(); return; }
  });

  socket.on('close', () => { console.log('[WS] Closed'); cleanup(); });
  socket.on('error', err => { console.error('[WS] Error:', err.message); cleanup(); });
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🖥  CMDB running  → http://0.0.0.0:${PORT}`);
  console.log(`📁  Data file     → ${DATA_FILE}`);
  console.log(`🔐  sshpass       → ${findSshpass() || 'NOT FOUND — password login will require manual input'}\n`);
});
