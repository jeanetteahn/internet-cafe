#!/usr/bin/env bash
# Installs the app as an XDG autostart entry, so it launches at login and
# sits on the desktop background layer for the rest of the session. XDG
# autostart is a shared freedesktop.org standard, so this works the same
# way under GNOME, KDE, XFCE, etc.
#
# Usage:
#   bash install-autostart.sh            # native: launches Electron directly
#   bash install-autostart.sh --xwinwrap # launches via xwinwrap-launch.sh instead
#
# Use --xwinwrap on Cinnamon (Mint's default edition) — its compositor
# generally ignores the native `type: 'desktop'` hint, so xwinwrap is the
# one that actually lands the wallpaper behind your icons there. On MATE
# or Xfce, try without the flag first.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
DEST="$AUTOSTART_DIR/weather-wallpaper.desktop"

# Uses the project's own local Electron (from `npm install`) rather than a
# global `electron` command, which a plain `npm install` never provides.
#
# The real native binary, not node_modules/.bin/electron — that wrapper
# needs `node` on PATH (it's a `#!/usr/bin/env node` script), and an XDG
# autostart entry never sources ~/.bashrc the way an interactive terminal
# does, so nvm's PATH setup never runs and `node` can't be found. The
# actual Electron binary below is self-contained and needs nothing on PATH.
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found at $ELECTRON_BIN — run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi

if [ "${1:-}" = "--xwinwrap" ]; then
  EXEC_LINE="$PROJECT_DIR/linux/xwinwrap-launch.sh"
else
  # native-launch.sh, not a direct electron invocation: the kiosk browser
  # cluster is its own separate process (kiosk-main.js) now, so something
  # has to start both. See linux/native-launch.sh and
  # linux/xwinwrap-launch.sh's comments for why they're split.
  EXEC_LINE="$PROJECT_DIR/linux/native-launch.sh"
fi

mkdir -p "$AUTOSTART_DIR"

# Replace Exec=.  (The spoon cursor is not set here: Environment= is not a
# valid desktop-entry key and was silently ignored.  The theme is set for the
# whole account by linux/install-spoon-cursor.sh instead.)
sed "s|Exec=.*|Exec=$EXEC_LINE|" \
  "$PROJECT_DIR/linux/weather-wallpaper.desktop" \
  | grep -v '^Environment=' > "$DEST"

echo "Installed autostart entry: $DEST"
echo "Launch method: $EXEC_LINE"
echo "It will launch next time you log in. To run it right now instead:"
if [ "${1:-}" = "--xwinwrap" ]; then
  echo "  bash $PROJECT_DIR/linux/xwinwrap-launch.sh"
else
  echo "  bash $PROJECT_DIR/linux/native-launch.sh"
fi
