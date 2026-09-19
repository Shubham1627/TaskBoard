// Structured JSON logs on stdout: journald on the VM, `kubectl logs` later.
const os = require('os');
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const min = levels[(process.env.LOG_LEVEL || 'info').toLowerCase()] || levels.info;

const log = (level, msg, extra = {}) => {
  if (levels[level] < min) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, host: os.hostname(), ...extra }));
};

module.exports = {
  debug: (m, e) => log('debug', m, e),
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};
