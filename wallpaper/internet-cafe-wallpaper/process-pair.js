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

const PID_DIR = path.join(os.tmpdir(), 'internet-cafe-wallpaper');
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

// Kills every other registered process (by PID file), leaving the caller
// to quit itself afterward.
function killOthers(exceptName) {
  let entries;
  try {
    entries = fs.readdirSync(PID_DIR);
  } catch {
    return;
  }
  entries
    .filter((f) => f.endsWith('.pid') && f !== `${exceptName}.pid`)
    .forEach((f) => {
      try {
        const pid = parseInt(fs.readFileSync(path.join(PID_DIR, f), 'utf8'), 10);
        if (pid && pid !== process.pid) process.kill(pid, 'SIGTERM');
      } catch {
        /* sibling already gone, or PID reused/stale — fine either way */
      }
    });
}

module.exports = { registerSelf, killOthers };
