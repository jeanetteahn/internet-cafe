// Shared by main.js (wallpaper) and kiosk-browsers.js (kiosk).
//
// On Linux the spoon is meant to come from the X11 cursor theme "spoon"
// (linux/install-spoon-cursor.sh), which covers every window, gap and drag at
// one size.  Chromium only keeps CSS cursors larger than 32 px while the whole
// image fits inside the window, so the CSS spoon is left as the fallback for
// Windows/macOS dev machines and for Linux machines where the theme is
// missing.
//
// KIOSK_CSS_CURSOR=1 forces the CSS spoon even when the theme is active.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SPOON_THEME_FILE = path.join(os.homedir(), '.icons', 'spoon', 'cursors', 'spoon.cursor');

function gsettingsCursorTheme(schema) {
  try {
    return execFileSync('gsettings', ['get', schema, 'cursor-theme'], { encoding: 'utf8', timeout: 2000 })
      .trim().replace(/['"]/g, '');
  } catch (_) {
    return '';
  }
}

function defaultThemeInheritsSpoon() {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.icons', 'default', 'index.theme'), 'utf8');
    return /^Inherits\s*=\s*spoon\s*$/m.test(txt);
  } catch (_) {
    return false;
  }
}

let _cached = null;

// True when the native spoon theme is installed and selected for this user.
function useSystemSpoonCursor() {
  if (_cached !== null) return _cached;
  _cached = false;
  if (process.env.KIOSK_CSS_CURSOR === '1') return _cached;
  if (process.platform !== 'linux') return _cached;
  if (!fs.existsSync(SPOON_THEME_FILE)) return _cached;
  _cached = gsettingsCursorTheme('org.cinnamon.desktop.interface') === 'spoon' ||
            gsettingsCursorTheme('org.gnome.desktop.interface') === 'spoon' ||
            defaultThemeInheritsSpoon();
  return _cached;
}

module.exports = { useSystemSpoonCursor, SPOON_THEME_FILE };
