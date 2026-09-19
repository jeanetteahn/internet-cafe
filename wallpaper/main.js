const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const path = require('path');
const { registerSelf, killOthers } = require('./process-pair');

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

const PROCESS_NAME = 'wallpaper';
const cleanupPidFile = registerSelf(PROCESS_NAME);

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

    return win;
  });
}

app.whenReady().then(() => {
  createWallpaperWindows();

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
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupPidFile();
});

app.on('window-all-closed', () => {
  // A background/wallpaper app has no "all windows closed" quit moment in
  // the normal sense; keep running unless the user explicitly quits it
  // (tray icon, kill, or logging out).
});
