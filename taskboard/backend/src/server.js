const config = require('./config');
const logger = require('./logger');
const app = require('./app');
const pool = require('./db');
const redis = require('./redis');

const server = app.listen(config.port, config.host, () =>
  logger.info('server started', { host: config.host, port: config.port, env: config.appEnv, version: config.version }));

// Graceful shutdown: systemd (VM) and the kubelet (Kubernetes) both send SIGTERM first.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('shutdown requested', { signal });
  app.locals.state.shuttingDown = true; // /readyz now returns 503, so traffic is routed away

  setTimeout(() => { logger.error('forced exit after timeout'); process.exit(1); }, config.shutdownTimeoutMs).unref();

  setTimeout(() => {
    server.close(async () => {   // stop accepting, finish in-flight requests
      await pool.end().catch(() => {});
      await redis.quit().catch(() => {});
      logger.info('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  }, config.shutdownDelayMs);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
