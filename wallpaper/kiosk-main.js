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
const { registerSelf, killOthers } = require('./process-pair');

const PROCESS_NAME = 'kiosk';
const cleanupPidFile = registerSelf(PROCESS_NAME);

app.whenReady().then(() => {
  createKioskWindow();

  // Safety valve, mirrored from main.js: Ctrl+Alt+Q always quits
  // immediately. Only one of the two processes (this one, or main.js —
  // whichever asks first) can actually win this OS-level registration;
  // the loser's handler below never fires, but that's fine, since
  // whichever one DOES fire kills the sibling process too.
  const registered = globalShortcut.register('Control+Alt+Q', () => {
    killOthers(PROCESS_NAME);
    app.quit();
  });
  if (!registered) {
    console.error(
      'Ctrl+Alt+Q already claimed by the wallpaper process — expected, ' +
      'and harmless: that process\'s shortcut quits this one too.'
    );
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupPidFile();
});

app.on('window-all-closed', () => {
  // Same reasoning as main.js: no normal "all windows closed means quit"
  // moment for an app meant to sit there indefinitely.
});
