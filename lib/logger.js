const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logFile = path.join(logDir, 'app.log');

function formatMessage(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
}

function log(level, message, meta = {}) {
  const formatted = formatMessage(level, message, meta);
  
  // Log to console
  if (level === 'error') {
    console.error(formatted.trim());
  } else if (level === 'warn') {
    console.warn(formatted.trim());
  } else {
    console.log(formatted.trim());
  }

  // Log to file
  try {
    fs.appendFileSync(logFile, formatted);
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta)
};
