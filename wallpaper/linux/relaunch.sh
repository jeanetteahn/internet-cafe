#!/usr/bin/env bash
# Restarts the wallpaper/kiosk app using whatever code currently exists in
# this project folder. Kills any already-running instance first, so this
# is safe to trigger any time — including right after a `git pull` — and
# always picks up your latest code, visuals, and animations rather than
# leaving a stale instance running alongside a new one.
#
# This is what the double-clickable launcher (see install-desktop-launcher.sh)
# runs. You can also run it directly from a terminal.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PID_DIR="/tmp/internet-cafe-wallpaper"
QUIT_FLAG="$PID_DIR/quit-requested"
LAUNCHER_PID_FILE="$PID_DIR/launcher.pid"
mkdir -p "$PID_DIR"

# One-time cleanup: if a previous session (old code) left the cursor stuck on
# "spoon" in either the Cinnamon or GNOME schema, restore it now.
_CURSOR_STATE_FILE="$PID_DIR/cursor-theme-state"
if command -v gsettings >/dev/null 2>&1; then
  _SAVED_CURSOR=""
  [ -f "$_CURSOR_STATE_FILE" ] && _SAVED_CURSOR=$(cat "$_CURSOR_STATE_FILE" 2>/dev/null | tr -d "'" | tr -d '"')
  [ -z "$_SAVED_CURSOR" ] && _SAVED_CURSOR="Adwaita"
  for _SCHEMA in org.cinnamon.desktop.interface org.gnome.desktop.interface; do
    _CURR=$(gsettings get "$_SCHEMA" cursor-theme 2>/dev/null | tr -d "'" | tr -d '"' || true)
    if [ "$_CURR" = "spoon" ]; then
      gsettings set "$_SCHEMA" cursor-theme "$_SAVED_CURSOR" 2>/dev/null || true
    fi
  done
  rm -f "$_CURSOR_STATE_FILE"
fi

# Signal the supervisor loop(s) to stop before we kill the Electron processes.
# This prevents either loop from restarting in the window between our pkill
# and the new launch script starting.
touch "$QUIT_FLAG"

# Kill the previous launcher (supervisor script) by its saved PID.
# The launcher's trap handler kills both wallpaper and kiosk loop subshells.
if [ -f "$LAUNCHER_PID_FILE" ]; then
  OLD_LAUNCHER_PID=$(cat "$LAUNCHER_PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_LAUNCHER_PID" ]; then
    kill "$OLD_LAUNCHER_PID" 2>/dev/null || true
  fi
  rm -f "$LAUNCHER_PID_FILE"
fi

# Belt-and-suspenders: kill any lingering xwinwrap or Electron processes.
pkill -f xwinwrap 2>/dev/null || true
pkill -f electron 2>/dev/null || true
sleep 1

# Re-run npm install if node_modules is missing or package.json is newer than
# the lock file (e.g. after a git pull that added a new dependency).
NM="$PROJECT_DIR/node_modules"
PKG="$PROJECT_DIR/package.json"
if [ ! -d "$NM" ] || [ "$PKG" -nt "$NM/.package-lock.json" ]; then
  echo "[relaunch] running npm install in $PROJECT_DIR..."
  (cd "$PROJECT_DIR" && npm install --prefer-offline 2>&1) || echo "[relaunch] npm install failed, continuing anyway"
fi

# xwinwrap-launch.sh clears the QUIT_FLAG itself at startup (fresh launch),
# so we do not need to remove it here.
exec bash "$PROJECT_DIR/linux/xwinwrap-launch.sh"
