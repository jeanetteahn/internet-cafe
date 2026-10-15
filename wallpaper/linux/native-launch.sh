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

# ---- Supervisor / self-healing state ----------------------------------------
PID_DIR="/tmp/internet-cafe-wallpaper"
QUIT_FLAG="$PID_DIR/quit-requested"
LAUNCHER_PID_FILE="$PID_DIR/launcher-kiosk.pid"
SUPERVISOR_LOG="$PID_DIR/supervisor.log"
mkdir -p "$PID_DIR"

echo $$ > "$LAUNCHER_PID_FILE"

sup_log() {
  local msg="$(date -Iseconds) [supervisor-native] $1"
  echo "$msg" >> "$SUPERVISOR_LOG" 2>/dev/null || true
  echo "$msg" >&2
}

rm -f "$QUIT_FLAG"
sup_log "starting (pid=$$)"

# Wallpaper process starts first; the kiosk cluster follows after 15 s.
# This matches the xwinwrap-launch.sh startup order -- the wallpaper window
# must be established before the kiosk panels appear on top of it.
"$ELECTRON_BIN" "$PROJECT_DIR" &

sup_log "wallpaper started; waiting 15s before kiosk"
sleep 15

# ---- Kiosk supervisor loop --------------------------------------------------
if [ "${ENABLE_KIOSK:-1}" = "0" ]; then
  sup_log "ENABLE_KIOSK=0 — skipping kiosk supervisor loop"
  wait
  rm -f "$LAUNCHER_PID_FILE"
  exit 0
fi

crash_count=0
crash_window_start=$(date +%s)

while true; do
  if [ -f "$QUIT_FLAG" ]; then
    sup_log "quit-requested flag set — stopping supervisor loop"
    break
  fi

  sup_log "launching kiosk (crash_count=$crash_count)"
  "$ELECTRON_BIN" "$PROJECT_DIR/kiosk-main.js" &
  KIOSK_PID=$!

  wait "$KIOSK_PID" || true
  EXIT_CODE=$?

  if [ -f "$QUIT_FLAG" ]; then
    sup_log "kiosk exited (code=$EXIT_CODE) and quit-requested — stopping supervisor loop"
    break
  fi

  sup_log "kiosk exited with code=$EXIT_CODE — will restart"

  now=$(date +%s)
  elapsed=$(( now - crash_window_start ))
  if [ "$elapsed" -le 120 ]; then
    crash_count=$(( crash_count + 1 ))
  else
    crash_count=1
    crash_window_start=$now
  fi

  if [ "$crash_count" -gt 5 ]; then
    sup_log "too many restarts ($crash_count in ${elapsed}s) — backing off 60s"
    sleep 60
    crash_count=0
    crash_window_start=$(date +%s)
  else
    sleep 3
  fi
done

sup_log "supervisor exiting"
rm -f "$LAUNCHER_PID_FILE"
wait
