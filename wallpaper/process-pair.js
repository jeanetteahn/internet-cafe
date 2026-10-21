// Shared helper for the wallpaper (main.js) and kiosk (kiosk-main.js)
// processes, which now run as two independent Electron processes rather
// than two windows opened by one — see xwinwrap-launch.sh's comments for
// why: wrapping both windows out of a single process crashes xwinwrap
// (confirmed on a NucBox5 running Mint Cinnamon — the whole Electron
// process died silently, exit status 0, the instant the kiosk window was
// created alongside the wallpaper window).
//
// Splitting them means Ctrl+Alt+Q (the emergency safety-quit — see
// main.js) can only ever be registered as an OS-level global shortcut by
// whichever of the two processes asks first; Electron silently fails the
// registration in the other. Each process still needs Ctrl+Alt+Q to quit
// BOTH of them, not just itself, since the whole point is "get me out of
// this no matter what's covering the screen." This drops a PID file per
// process in a shared temp dir so whichever one's shortcut actually fires
// can find and kill the other(s) too.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PID_DIR   = path.join(os.tmpdir(), 'internet-cafe-wallpaper');
const QUIT_FLAG = path.join(PID_DIR, 'quit-requested');
fs.mkdirSync(PID_DIR, { recursive: true });

// Called once at startup. Returns a cleanup function to call on quit.
function registerSelf(name) {
  const ownFile = path.join(PID_DIR, `${name}.pid`);
  fs.writeFileSync(ownFile, String(process.pid));
  return () => {
    try {
      fs.unlinkSync(ownFile);
    } catch {
      /* already gone — fine */
    }
  };
}

// Kills the known sibling processes (wallpaper and kiosk), leaving the caller
// to quit itself afterward.  Only targets the two known process names so that
// launcher.pid (which lives in the same PID_DIR) is never accidentally killed.
const KNOWN_PROCESS_NAMES = ['wallpaper', 'kiosk'];

function killOthers(exceptName) {
  for (const name of KNOWN_PROCESS_NAMES) {
    if (name === exceptName) continue;
    const pidFile = path.join(PID_DIR, `${name}.pid`);
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (pid && pid !== process.pid) process.kill(pid, 'SIGTERM');
    } catch {
      /* sibling already gone, or no pid file — fine */
    }
  }
}

// Write the quit-requested flag so the supervisor loop in xwinwrap-launch.sh /
// native-launch.sh knows not to restart the kiosk after it exits.
// Called from the Ctrl+Alt+Q handler and the SIGTERM handler (both mean
// "intentional shutdown, not a crash").
function requestQuit() {
  try { fs.writeFileSync(QUIT_FLAG, String(process.pid)); } catch (_) {}
}

// Remove the quit flag.  Called at the start of a fresh kiosk launch so any
// stale flag from a previous Ctrl+Alt+Q session doesn't block future restarts.
function clearQuitFlag() {
  try { fs.unlinkSync(QUIT_FLAG); } catch (_) {}
}

// Read the quit flag (pure-Node — safe to call from scripts/launch-both.js).
function isQuitRequested() {
  try { return fs.existsSync(QUIT_FLAG); } catch (_) { return false; }
}

module.exports = { registerSelf, killOthers, requestQuit, clearQuitFlag, isQuitRequested, PID_DIR, QUIT_FLAG };
