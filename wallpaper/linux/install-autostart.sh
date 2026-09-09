#!/usr/bin/env bash
# Installs the app as an XDG autostart entry, so it launches at login and
# sits on the desktop background layer for the rest of the session. XDG
# autostart is a shared freedesktop.org standard, so this works the same
# way under GNOME, KDE, XFCE, etc.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
DEST="$AUTOSTART_DIR/weather-wallpaper.desktop"

# Uses the project's own local Electron (from `npm install`) rather than a
# global `electron` command, which a plain `npm install` never provides.
ELECTRON_BIN="$PROJECT_DIR/node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found at $ELECTRON_BIN — run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi

mkdir -p "$AUTOSTART_DIR"

sed "s|Exec=.*|Exec=$ELECTRON_BIN $PROJECT_DIR|" \
  "$PROJECT_DIR/linux/weather-wallpaper.desktop" > "$DEST"

echo "Installed autostart entry: $DEST"
echo "It will launch next time you log in. To run it right now instead:"
echo "  cd $PROJECT_DIR && npm start"
echo ""
echo "If it doesn't sit behind your desktop icons (common on GNOME/KDE),"
echo "try linux/xwinwrap-launch.sh instead — see README.md."
