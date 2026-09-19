const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const client = require('prom-client');
const config = require('./config');
const logger = require('./logger');
const pool = require('./db');
const redis = require('./redis');

const app = express();
const startedAt = new Date().toISOString();
const state = { shuttingDown: false };
app.locals.state = state;

// ---------- metrics (Prometheus) ----------
client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

app.use(express.json({ limit: '100kb' }));

// ---------- request logging + metrics ----------
const quietPaths = new Set(['/healthz', '/readyz', '/metrics']);
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const sec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    httpDuration.labels(req.method, route, String(res.statusCode)).observe(sec);
    if (!quietPaths.has(req.path)) {
      logger.info('request', { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(sec * 1000) });
    }
  });
  next();
});

// Shared request counter in Redis: proves state lives OUTSIDE the app instance.
app.use('/api', (req, res, next) => {
  redis.incr('stats:api_requests').catch(() => {});
  next();
});

// ---------- health & metrics (used by probes / monitoring) ----------
app.get('/healthz', (req, res) => res.json({ status: 'alive' })); // liveness: is the process OK?

app.get('/readyz', async (req, res) => {                          // readiness: can it serve traffic?
  if (state.shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  const checks = { database: 'ok', redis: redis.status === 'ready' ? 'ok' : 'down' };
  try { await pool.query('SELECT 1'); } catch (e) { checks.database = 'down'; }
  // Database is required. Redis is optional: the app degrades gracefully without it.
  const ready = checks.database === 'ok';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ---------- instance info ----------
app.get('/api/info', async (req, res) => {
  let totalApiRequests = null;
  try { totalApiRequests = Number(await redis.get('stats:api_requests')); } catch (e) { /* redis down */ }
  res.json({
    app: config.appName,
    env: config.appEnv,
    version: config.version,
    hostname: os.hostname(), // = pod name once running in Kubernetes
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    totalApiRequests,
    features: { uploads: config.enableUploads, loadEndpoint: config.enableLoadEndpoint },
  });
});

// ---------- tasks (PostgreSQL + Redis cache) ----------
const CACHE_KEY = 'tasks:list';
const invalidate = () => redis.del(CACHE_KEY).catch(() => {});
const parseId = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid id' }); return null; }
  return id;
};

app.get('/api/tasks', async (req, res, next) => {
  try {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }
    } catch (e) { /* redis down: fall through to the database */ }
    const { rows } = await pool.query(
      'SELECT id, title, done, attachment_name, created_at, completed_at FROM tasks ORDER BY id DESC');
    redis.set(CACHE_KEY, JSON.stringify(rows), 'EX', config.cacheTtl).catch(() => {});
    res.set('X-Cache', 'MISS');
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/tasks', async (req, res, next) => {
  const title = String(req.body.title || '').trim();
  if (!title || title.length > 200) return res.status(400).json({ error: 'title is required (max 200 characters)' });
  try {
    const { rows } = await pool.query('INSERT INTO tasks (title) VALUES ($1) RETURNING id, title, done', [title]);
    await invalidate();
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  const id = parseId(req, res); if (id === null) return;
  const done = req.body.done === true;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET done = $1::boolean,
         completed_at = CASE WHEN $1::boolean THEN now() ELSE NULL END
       WHERE id = $2 RETURNING id, title, done`, [done, id]);
    if (!rows.length) return res.status(404).json({ error: 'task not found' });
    await invalidate();
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  const id = parseId(req, res); if (id === null) return;
  try {
    const { rows } = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING attachment_file', [id]);
    if (!rows.length) return res.status(404).json({ error: 'task not found' });
    if (rows[0].attachment_file) fs.unlink(path.join(config.uploadDir, rows[0].attachment_file), () => {});
    await invalidate();
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ---------- attachments (files on local disk: the "persistent volume" lesson) ----------
if (config.enableUploads) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) =>
        cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname)}`),
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  });

  app.post('/api/tasks/:id/attachment', upload.single('file'), async (req, res, next) => {
    const id = parseId(req, res); if (id === null) return;
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const old = await pool.query('SELECT attachment_file FROM tasks WHERE id = $1', [id]);
      if (!old.rows.length) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'task not found' }); }
      await pool.query('UPDATE tasks SET attachment_name = $1, attachment_file = $2 WHERE id = $3',
        [req.file.originalname, req.file.filename, id]);
      if (old.rows[0].attachment_file) fs.unlink(path.join(config.uploadDir, old.rows[0].attachment_file), () => {});
      await invalidate();
      res.json({ name: req.file.originalname, storedBy: os.hostname() });
    } catch (e) { next(e); }
  });

  app.get('/api/tasks/:id/attachment', async (req, res, next) => {
    const id = parseId(req, res); if (id === null) return;
    try {
      const { rows } = await pool.query('SELECT attachment_name, attachment_file FROM tasks WHERE id = $1', [id]);
      if (!rows.length || !rows[0].attachment_file) return res.status(404).json({ error: 'no attachment' });
      const file = path.join(path.resolve(config.uploadDir), rows[0].attachment_file);
      res.download(file, rows[0].attachment_name, (err) => {
        // With several instances and per-instance disks, the file may live on another one.
        if (err && !res.headersSent) res.status(404).json({ error: `file not found on ${os.hostname()}` });
      });
    } catch (e) { next(e); }
  });
}

// ---------- load generator (for autoscaling experiments) ----------
if (config.enableLoadEndpoint) {
  app.get('/api/load', (req, res) => {
    const ms = Math.min(Math.max(parseInt(req.query.ms, 10) || 500, 1), 5000);
    const end = Date.now() + ms;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(Math.random()); // busy loop = CPU burn
    res.json({ burnedMs: ms, hostname: os.hostname() });
  });
}

// ---------- admin (protected by ADMIN_API_KEY, a secret) ----------
const requireAdmin = (req, res, next) => {
  if (!config.adminApiKey) return res.status(503).json({ error: 'admin API disabled (ADMIN_API_KEY not set)' });
  if (req.get('x-api-key') !== config.adminApiKey) return res.status(401).json({ error: 'invalid API key' });
  next();
};

app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE done)::int AS done,
              count(attachment_file)::int AS with_attachments FROM tasks`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Deliberate crash: watch systemd (VM) or the kubelet (Kubernetes) restart the process.
app.post('/api/admin/crash', requireAdmin, (req, res) => {
  res.json({ crashing: true, hostname: os.hostname() });
  setTimeout(() => process.exit(1), 100);
});

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `file too large (max ${config.maxUploadMb} MB)` });
  logger.error('unhandled error', { err: err.message, path: req.originalUrl });
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
