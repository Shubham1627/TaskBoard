const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({ ...config.db, max: 10, connectionTimeoutMillis: 3000 });
pool.on('error', (err) => logger.error('postgres pool error', { err: err.message }));

module.exports = pool;
