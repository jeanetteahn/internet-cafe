// Rotating file logger shared by kiosk-main.js and kiosk-browsers.js.
// Both files run in the same Electron process, so require() is called once
// and the module state (LOG_FILE path, lock-free append) is shared.
//
// Rotation: when kiosk.log exceeds MAX_BYTES it is renamed to kiosk.log.1
// (clobbering the previous .1) and a fresh kiosk.log starts.  This keeps
// at most ~10 MB total with no external tooling.
const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG_DIR      = path.join(app.getPath('userData'), 'logs');
const LOG_FILE     = path.join(LOG_DIR, 'kiosk.log');
const LOG_FILE_OLD = path.join(LOG_DIR, 'kiosk.log.1');
const MAX_BYTES    = 5 * 1024 * 1024; // 5 MB rotation threshold

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function kioskLog(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch (_) {}
    if (size > MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, LOG_FILE_OLD); } catch (_) {}
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // Never throw — log falls back to stdout on write failure.
    process.stdout.write(`[kiosk-log write failed] ${line}`);
  }
}

module.exports = { kioskLog, LOG_FILE };
