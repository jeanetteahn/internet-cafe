// Rotating file logger for both kiosk and wallpaper Electron processes.
// makeLogger(name) returns { log(msg), logFile } backed by
// app.getPath('userData')/logs/<name>.log.  Loggers are cached by name so
// calling makeLogger('kiosk') from kiosk-main.js and kiosk-browsers.js
// (same process, same module cache) returns the same instance.
//
// Rotation: once the log exceeds MAX_BYTES it is renamed to <name>.log.1
// (clobbering the previous .1) and a fresh <name>.log starts (~10 MB total,
// no external tooling required).
const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG_DIR   = path.join(app.getPath('userData'), 'logs');
const MAX_BYTES = 5 * 1024 * 1024;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

const _loggers = {};

function makeLogger(name) {
  if (_loggers[name]) return _loggers[name];

  const logFile = path.join(LOG_DIR, `${name}.log`);
  const oldFile = path.join(LOG_DIR, `${name}.log.1`);

  function log(msg) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      let size = 0;
      try { size = fs.statSync(logFile).size; } catch (_) {}
      if (size > MAX_BYTES) {
        try { fs.renameSync(logFile, oldFile); } catch (_) {}
      }
      fs.appendFileSync(logFile, line);
    } catch (_) {
      process.stdout.write(`[${name}-log write failed] ${line}`);
    }
  }

  _loggers[name] = { log, logFile };
  return _loggers[name];
}

// Convenience backward-compatible exports so kiosk-main.js and
// kiosk-browsers.js keep working without changes.
const _kiosk = makeLogger('kiosk');
module.exports = {
  makeLogger,
  LOG_DIR,
  kioskLog: _kiosk.log,
  LOG_FILE: _kiosk.logFile,
};
