const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

// Fail fast when Redis is down instead of queueing commands: the app degrades, it does not hang.
const redis = new Redis({
  ...config.redis,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
redis.on('error', (err) => logger.warn('redis error', { err: err.message }));

module.exports = redis;
