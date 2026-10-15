// Entry point for the kiosk browser cluster, run as its OWN Electron
// process — separate from the wallpaper (main.js). This split exists
// because of a confirmed crash: when a single Electron process opened
// both the `type: 'desktop'` wallpaper window(s) AND this cluster window,
// running the whole thing through `xwinwrap` (needed on Cinnamon — see
// README) killed the entire process silently (exit status 0) the instant
// the second window appeared. xwinwrap expects to wrap exactly one
// single-window app (it was built around tools like mpv), and this app
// used to hand it two differently-sized windows from one process.
//
// The fix: xwinwrap now only ever wraps main.js (wallpaper-only, one
// window). This file is launched alongside it as a completely ordinary,
// unwrapped Electron process — see linux/xwinwrap-launch.sh and
// linux/native-launch.sh, which start both. Running it standalone for
// dev/testing works too: `electron kiosk-main.js`.
const { app, globalShortcut } = require('electron');
const { createKioskWindow } = require('./kiosk-browsers');
const { registerSelf, killOthers, requestQuit, clearQuitFlag } = require('./process-pair');
const { kioskLog, LOG_FILE } = require('./kiosk-log');

// KIOSK_DISABLE_GPU=1 — call before app.whenReady() so it takes effect.
// Use this if logs show repeated GPU child-process-gone events.
// enable-transparent-visuals is still set below so transparent windows work.
if (process.env.KIOSK_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

// X11/Cinnamon: transparent: true BrowserWindows need an ARGB visual from
// the X server.  Cinnamon's Mutter compositor provides one, but Chromium
// only requests it when this switch is set — and it must be set before the
// app is ready or it has no effect.  Guard with a platform check so the line
// is a no-op on macOS/Windows where transparent windows work out of the box.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// Log all otherwise-silent failures with a clear prefix so startup errors
// (like calling a non-existent method on a BrowserView) appear in the
// terminal rather than being swallowed as unhandled promise rejections.
process.on('uncaughtException', (err) => {
  console.error('[kiosk] Uncaught exception:', err);
  kioskLog(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('[kiosk] Unhandled rejection:', reason);
  kioskLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// SIGTERM: sent by killOthers() when the wallpaper process handles Ctrl+Alt+Q.
// Write the quit flag so the supervisor loop does not restart us.
// Only registered on Linux where the supervisor loop runs.
if (process.platform === 'linux') {
  process.on('SIGTERM', () => {
    kioskLog('received SIGTERM — writing quit flag and exiting');
    requestQuit();
    try { cleanupPidFile(); } catch (_) {}
    process.exit(0);
  });
}

const PROCESS_NAME = 'kiosk';
const cleanupPidFile = registerSelf(PROCESS_NAME);

// Belt-and-suspenders GC protection: createKioskWindow() already keeps
// module-level references to all five panel windows inside kiosk-browsers.js,
// but we hold the returned array here too so multiple strong references exist.
// See README's "Known bug" section for why this matters — a BrowserWindow with
// no surviving JS reference is silently destroyed by V8's GC (no crash, no
// error, process stays alive), and window-all-closed below is a deliberate
// no-op, so dropping this reference would leave the process alive and idle
// forever with nothing on screen.
let kioskWindows = null;

app.whenReady().then(() => {
  // Clear any stale quit flag from a previous session so future nightly
  // restarts or crash restarts are not blocked.
  clearQuitFlag();

  console.log(`[kiosk] log file: ${LOG_FILE}`);
  kioskLog(`startup pid=${process.pid} platform=${process.platform}`);

  // GPU crash logging — fired when the GPU process dies (type:'GPU').
  // If you see this repeatedly, set KIOSK_DISABLE_GPU=1 in the launch script.
  app.on('child-process-gone', (_e, details) => {
    const msg = `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
  });

  // Memory metrics every 5 minutes so we can spot leaks before a disappearance.
  setInterval(() => {
    try {
      const mem     = process.memoryUsage();
      const metrics = app.getAppMetrics();
      let totalWS = 0;
      for (const m of metrics) {
        totalWS += (m.memory && m.memory.workingSetSize) ? m.memory.workingSetSize : 0;
      }
      kioskLog(
        `memory heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB` +
        ` rss=${Math.round(mem.rss / 1024 / 1024)}MB` +
        ` all-processes-ws=${Math.round(totalWS / 1024)}MB` +
        ` processes=${metrics.length}`
      );
    } catch (e) {
      kioskLog(`memory log failed: ${e.message}`);
    }
  }, 5 * 60 * 1000);

  try {
    kioskWindows = createKioskWindow();
  } catch (err) {
    console.error('[kiosk] Failed to create kiosk panels:', err);
    kioskLog(`createKioskWindow failed: ${err && err.stack ? err.stack : err}`);
  }

  // Safety valve, mirrored from main.js: Ctrl+Alt+Q always quits
  // immediately. Only one of the two processes (this one, or main.js —
  // whichever asks first) can actually win this OS-level registration;
  // the loser's handler below never fires, but that's fine, since
  // whichever one DOES fire kills the sibling process too.
  const registered = globalShortcut.register('Control+Alt+Q', () => {
    kioskLog('Ctrl+Alt+Q — writing quit flag and exiting');
    requestQuit();  // tell supervisor loop: intentional shutdown, do not restart
    killOthers(PROCESS_NAME);
    app.quit();
  });
  if (!registered) {
    console.error(
      'Ctrl+Alt+Q already claimed by the wallpaper process — expected, ' +
      'and harmless: that process\'s shortcut quits this one too.'
    );
  }
}).catch((err) => {
  console.error('[kiosk] app.whenReady() rejected:', err);
  kioskLog(`app.whenReady rejected: ${err && err.stack ? err.stack : err}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupPidFile();
});

app.on('window-all-closed', () => {
  // Same reasoning as main.js: no normal "all windows closed means quit"
  // moment for an app meant to sit there indefinitely.
});
