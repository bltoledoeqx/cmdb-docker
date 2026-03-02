'use strict';
const express = require('express');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');

process.on('uncaughtException',  err => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const PORT      = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_DB = { data: [], tags: [], snippets: [], snipPkgs: [] };

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

const app    = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'src')));

app.get('/api/db',      (_req, res) => res.json(readDB()));
app.get('/api/db/path', (_req, res) => res.json({ path: DATA_FILE }));
app.post('/api/db',     (req, res)  => res.json({ ok: writeDB(req.body) }));

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
    if (p.data && Array.isArray(p.data))
      return res.json({ ok: true, data: { data: p.data, tags: p.tags||[], snippets: p.snippets||[], snipPkgs: p.snipPkgs||[] } });
    if (Array.isArray(p))
      return res.json({ ok: true, data: { data: p, tags: [], snippets: [], snipPkgs: [] } });
    return res.status(400).json({ ok: false, error: 'Formato inválido' });
  } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime().toFixed(1) + 's' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'src', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🖥  CMDB running → http://0.0.0.0:${PORT}`);
  console.log(`📁  Data file   → ${DATA_FILE}`);
  console.log(`🔑  SSH mode    → client-side (ssh:// URI + clipboard)\n`);
});
