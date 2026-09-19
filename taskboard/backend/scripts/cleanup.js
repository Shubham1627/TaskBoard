// Deletes finished tasks older than DONE_RETENTION_DAYS. VM: cron. Kubernetes: CronJob.
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');
const config = require('../src/config');
const logger = require('../src/logger');

async function main() {
  const { rows } = await pool.query(
    `DELETE FROM tasks
      WHERE done = true AND completed_at < now() - make_interval(days => $1::int)
      RETURNING id, attachment_file`, [config.retentionDays]);
  for (const r of rows) {
    if (r.attachment_file) fs.unlink(path.join(config.uploadDir, r.attachment_file), () => {});
  }
  logger.info('cleanup complete', { deleted: rows.length, retentionDays: config.retentionDays });
}

main()
  .then(() => pool.end())
  .catch(async (e) => { logger.error('cleanup failed', { err: e.message }); await pool.end().catch(() => {}); process.exit(1); });
