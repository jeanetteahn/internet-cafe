const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const { attachBrowserWall } = require('./browser-wall');

// ---- Tunables -----------------------------------------------------------
// The 5-panel live-search browser wall only attaches to the primary
// display. Attaching it per-monitor would multiply outbound search
// traffic per extra screen for no real benefit.
const ENABLE_BROWSER_WALL = true;
// ---------------------------------------------------------------------------

let wallpaperWindows = [];

function createWallpaperWindows() {
  const displays = screen.getAllDisplays();
  const primaryDisplayId = screen.getPrimaryDisplay().id;

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

    if (ENABLE_BROWSER_WALL && display.id === primaryDisplayId) {
      win.webContents.once('did-finish-load', () => {
        attachBrowserWall(win);
      });
    }

    return win;
  });
}

app.whenReady().then(createWallpaperWindows);

app.on('window-all-closed', () => {
  // A background/wallpaper app has no "all windows closed" quit moment in
  // the normal sense; keep running unless the user explicitly quits it
  // (tray icon, kill, or logging out).
});
