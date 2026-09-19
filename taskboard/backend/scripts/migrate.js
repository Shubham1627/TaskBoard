// One-shot database migration. VM: run by setup script. Kubernetes: initContainer or Job.
const pool = require('../src/db');
const logger = require('../src/logger');

const SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id              SERIAL PRIMARY KEY,
  title           TEXT        NOT NULL,
  done            BOOLEAN     NOT NULL DEFAULT false,
  attachment_name TEXT,
  attachment_file TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);`;

async function main() {
  for (let attempt = 1; ; attempt++) { // wait for the database (it may still be starting)
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (attempt >= 30) throw e;
      logger.warn('database not ready, retrying', { attempt, err: e.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await pool.query(SQL);
  logger.info('migration complete');
}

main()
  .then(() => pool.end())
  .catch(async (e) => { logger.error('migration failed', { err: e.message }); await pool.end().catch(() => {}); process.exit(1); });
