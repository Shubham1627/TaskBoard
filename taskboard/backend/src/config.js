// All configuration comes from environment variables (12-factor style).
// On the VM they come from /etc/taskboard/*.env; in Kubernetes from a ConfigMap and a Secret.
const int = (name, def) => parseInt(process.env[name] || String(def), 10);
const bool = (name, def) => (process.env[name] ?? String(def)).toLowerCase() === 'true';

if (!process.env.DB_PASSWORD) {
  console.error('Missing required env var DB_PASSWORD');
  process.exit(1);
}

module.exports = {
  appName: process.env.APP_NAME || 'TaskBoard',
  appEnv: process.env.APP_ENV || 'development',
  version: process.env.APP_VERSION || '1.0.0',
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 3000),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 5432),
    database: process.env.DB_NAME || 'taskboard',
    user: process.env.DB_USER || 'taskboard',
    password: process.env.DB_PASSWORD,
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: int('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  cacheTtl: int('CACHE_TTL_SECONDS', 30),
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxUploadMb: int('MAX_UPLOAD_MB', 5),
  enableUploads: bool('ENABLE_UPLOADS', true),
  enableLoadEndpoint: bool('ENABLE_LOAD_ENDPOINT', true),
  retentionDays: int('DONE_RETENTION_DAYS', 7),
  adminApiKey: process.env.ADMIN_API_KEY || '',
  shutdownDelayMs: int('SHUTDOWN_DELAY_MS', 1000),
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 15000),
};
