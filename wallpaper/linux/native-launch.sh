#!/usr/bin/env bash
# Native (non-xwinwrap) launcher — used by install-autostart.sh when NOT
# passing --xwinwrap. Starts the kiosk browser cluster and the desktop
# wallpaper as two separate Electron processes.
#
# They have to be two processes rather than two windows from one, even
# here on the native path where xwinwrap isn't involved at all — see
# xwinwrap-launch.sh's comments for the full story (wrapping both windows
# out of a single process is what actually crashed things; splitting them
# is the fix, and keeping both launch paths consistent means there's only
# one place, kiosk-main.js, that owns the kiosk window).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Real native binary, not node_modules/.bin/electron — see the longer
# explanation in install-autostart.sh; short version: the .bin wrapper
# needs `node` on PATH, which an autostart entry never has.
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found at $ELECTRON_BIN — run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi

# Wallpaper process starts first; the kiosk cluster follows after 15 s.
# This matches the xwinwrap-launch.sh startup order -- the wallpaper window
# must be established before the kiosk panels appear on top of it.
"$ELECTRON_BIN" "$PROJECT_DIR" &

sleep 15

# Set ENABLE_KIOSK=0 to skip the kiosk cluster (e.g. while debugging the
# wallpaper alone).
if [ "${ENABLE_KIOSK:-1}" != "0" ]; then
  "$ELECTRON_BIN" "$PROJECT_DIR/kiosk-main.js" &
fi

# Keep this script alive so any wrapper or relaunch tooling that targets
# this process continues to work correctly.
wait
