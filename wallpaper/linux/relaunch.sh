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

# Apply the spoon cursor theme now so it is active from this point.
# The state file persists across the exec below; xwinwrap-launch.sh reads it
# (crash-safety logic) and owns the restore-on-exit trap.
# shellcheck source=cursor-theme-switch.sh
. "$PROJECT_DIR/linux/cursor-theme-switch.sh"
spoon_cursor_apply

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
