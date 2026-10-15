const { app, BrowserWindow, screen, globalShortcut, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const { registerSelf, killOthers, requestQuit } = require('./process-pair');
const { makeLogger } = require('./kiosk-log');

const { log: wallpaperLog, logFile: WALLPAPER_LOG_FILE } = makeLogger('wallpaper');

// ---- Wallpaper only -------------------------------------------------------
// This process creates ONLY the desktop-layer video/weather window(s).
// The 5-panel kiosk browser cluster used to be created from here too, as a
// second window in this same process — it now lives in its own process
// (kiosk-main.js), launched separately by linux/xwinwrap-launch.sh /
// linux/native-launch.sh / scripts/launch-both.js. That split exists
// because of a confirmed crash: wrapping this process with `xwinwrap`
// (needed on Cinnamon, see README) while it also owned the kiosk window
// killed the whole process silently — exit status 0 — the instant that
// second, differently-sized window was created. xwinwrap was built to
// wrap a single-window app (tools like mpv), and having this process open
// only its own wallpaper window(s) keeps it exactly that.
// ---------------------------------------------------------------------------

// Track reason for a deliberate quit so exit handlers can distinguish it
// from a crash or external signal.
let _quitReason = null;

// Log all otherwise-silent failures to file and console.
process.on('uncaughtException', (err) => {
  const msg = `uncaughtException: ${err && err.stack ? err.stack : err}`;
  console.error('[wallpaper]', msg);
  try { wallpaperLog(msg); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  const msg = `unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`;
  console.error('[wallpaper]', msg);
  try { wallpaperLog(msg); } catch (_) {}
});

if (process.platform === 'linux') {
  process.on('SIGTERM', () => {
    _quitReason = 'SIGTERM';
    wallpaperLog('received SIGTERM — writing quit flag and exiting');
    requestQuit();
    try { cleanupPidFile(); } catch (_) {}
    process.exit(0);
  });
  process.on('SIGHUP', () => {
    _quitReason = 'SIGHUP';
    wallpaperLog('received SIGHUP — exiting');
    try { cleanupPidFile(); } catch (_) {}
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  _quitReason = 'SIGINT';
  wallpaperLog('received SIGINT — exiting');
  try { cleanupPidFile(); } catch (_) {}
  process.exit(0);
});

process.on('exit', (code) => {
  try { wallpaperLog(`process exit code=${code} reason=${_quitReason || 'unknown'}`); } catch (_) {}
});

const PROCESS_NAME = 'wallpaper';
const cleanupPidFile = registerSelf(PROCESS_NAME);

// Keep powerSaveBlocker id so we can stop it on quit.
let _psbId = null;

let wallpaperWindows = [];

function createWallpaperWindows() {
  const displays = screen.getAllDisplays();

  wallpaperWindows = displays.map((display) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      // Asks the window manager to treat this as the desktop background
      // layer: sits behind icons, never takes focus, no taskbar entry.
      // Honored by lighter X11 WMs (Openbox, XFCE, many i3 setups);
      // unreliable on GNOME/KDE; not supported on most Wayland
      // compositors at all — see linux/xwinwrap-launch.sh for the
      // fallback on window managers that ignore this.
      type: 'desktop',
      //focusable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      resizable: false,
      movable: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile('index.html');

    win.webContents.on('render-process-gone', (_e, details) => {
      const msg = `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
      console.error('[wallpaper]', msg);
      wallpaperLog(msg);
      // Reload the wallpaper page into the surviving renderer (if any).
      if (!win.isDestroyed()) {
        try { win.loadFile('index.html'); } catch (_) {}
      }
    });

    win.webContents.on('unresponsive', () => {
      wallpaperLog('webContents unresponsive');
    });

    return win;
  });
}

app.whenReady().then(() => {
  // Prevent X11/Cinnamon DPMS from blanking the display and killing the GPU
  // process while the kiosk is running unattended overnight.
  try {
    _psbId = powerSaveBlocker.start('prevent-display-sleep');
    wallpaperLog(`startup pid=${process.pid} platform=${process.platform} psb=${_psbId}`);
  } catch (e) {
    wallpaperLog(`startup pid=${process.pid} platform=${process.platform} (powerSaveBlocker failed: ${e.message})`);
  }
  console.log(`[wallpaper] log file: ${WALLPAPER_LOG_FILE}`);

  app.on('child-process-gone', (_e, details) => {
    const msg = `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`;
    console.error('[wallpaper]', msg);
    wallpaperLog(msg);
  });

  // Power events — help correlate display blanking with disappearance times.
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => wallpaperLog(`powerMonitor: ${ev}`));
  }

  // Screen changes — hotplug / resolution events.
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => {
      const displays = screen.getAllDisplays().map(d => `${d.bounds.width}x${d.bounds.height}`).join(', ');
      wallpaperLog(`screen: ${ev} — displays: [${displays}]`);
    });
  }

  // Memory metrics every 5 minutes.
  setInterval(() => {
    try {
      const mem     = process.memoryUsage();
      const metrics = app.getAppMetrics();
      let totalWS = 0;
      for (const m of metrics) {
        totalWS += (m.memory && m.memory.workingSetSize) ? m.memory.workingSetSize : 0;
      }
      wallpaperLog(
        `memory heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB` +
        ` rss=${Math.round(mem.rss / 1024 / 1024)}MB` +
        ` all-processes-ws=${Math.round(totalWS / 1024)}MB` +
        ` processes=${metrics.length}`
      );
    } catch (e) { wallpaperLog(`memory log failed: ${e.message}`); }
  }, 5 * 60 * 1000);

  try {
    createWallpaperWindows();
  } catch (err) {
    console.error('[wallpaper] Failed to create wallpaper windows:', err);
    wallpaperLog(`createWallpaperWindows failed: ${err && err.stack ? err.stack : err}`);
  }

  // Safety valve for development/testing: this app is designed to cover
  // the whole screen and (via xwinwrap) can end up genuinely on top of
  // everything else while we're still confirming window placement on a
  // new machine. A registered global shortcut is caught by Electron
  // before any window, so it works even if this app currently owns every
  // pixel on screen and no other window is reachable. Ctrl+Alt+Q always
  // quits immediately — and also quits the separate kiosk process (see
  // process-pair.js), since the two are meant to go together. Not
  // something a customer would ever guess or trigger by accident, but
  // worth removing (or changing) once placement is confirmed stable on
  // the target machine, if it's not wanted as a permanent "hidden exit"
  // in production.
  const registered = globalShortcut.register('Control+Alt+Q', () => {
    _quitReason = 'Ctrl+Alt+Q';
    wallpaperLog('Ctrl+Alt+Q — writing quit flag and exiting');
    requestQuit();
    killOthers(PROCESS_NAME);
    app.quit();
  });
  if (!registered) {
    // Expected if the kiosk process (kiosk-main.js) happened to register
    // this OS-level shortcut first — its handler kills this process too,
    // so Ctrl+Alt+Q still quits both either way.
    console.error(
      'Ctrl+Alt+Q already claimed by the kiosk process — expected, and ' +
      'harmless: that process\'s shortcut quits this one too.'
    );
  }
}).catch((err) => {
  console.error('[wallpaper] app.whenReady() rejected:', err);
  wallpaperLog(`app.whenReady rejected: ${err && err.stack ? err.stack : err}`);
});

app.on('before-quit', () => {
  wallpaperLog(`before-quit (reason=${_quitReason || 'unknown'})`);
});

app.on('will-quit', () => {
  wallpaperLog(`will-quit (reason=${_quitReason || 'unknown'})`);
  if (_psbId !== null) {
    try { powerSaveBlocker.stop(_psbId); } catch (_) {}
  }
  globalShortcut.unregisterAll();
  cleanupPidFile();
});

app.on('quit', (_e, exitCode) => {
  wallpaperLog(`quit exitCode=${exitCode} reason=${_quitReason || 'unknown'}`);
});

app.on('window-all-closed', () => {
  // A background/wallpaper app has no "all windows closed" quit moment in
  // the normal sense; keep running unless the user explicitly quits it
  // (tray icon, kill, or logging out).
});
