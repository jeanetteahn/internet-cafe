const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const { createKioskWindow } = require('./kiosk-browsers');

// ---- Tunables -----------------------------------------------------------
// The 5-panel kiosk browser cluster only appears on the primary display.
// Putting one on every monitor would multiply outbound search traffic per
// extra screen, and a customer can only sit at one screen at a time anyway.
const ENABLE_KIOSK_BROWSERS = true;
// ---------------------------------------------------------------------------

let wallpaperWindows = [];
let kioskWindow = null;

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
      focusable: false,
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

    // Belt-and-suspenders for WMs that respect setAlwaysOnTop levels but
    // not the `type: 'desktop'` hint itself — 'desktop' level asks to be
    // pinned at the very bottom of the stack rather than the top.
    if (typeof win.setAlwaysOnTop === 'function') {
      win.setAlwaysOnTop(true, 'desktop');
    }

    win.loadFile('index.html');

    return win;
  });
}

app.whenReady().then(() => {
  createWallpaperWindows();

  if (ENABLE_KIOSK_BROWSERS) {
    // A separate, normal, focusable window — unlike the wallpaper windows
    // above, this one is deliberately interactive, since it's what
    // customers actually click into and browse with. It sits on top of
    // the wallpaper automatically (any ordinary window sits above the
    // desktop-background layer), no special z-order code needed.
    kioskWindow = createKioskWindow();
  }
});

app.on('window-all-closed', () => {
  // A background/wallpaper app has no "all windows closed" quit moment in
  // the normal sense; keep running unless the user explicitly quits it
  // (tray icon, kill, or logging out).
});
