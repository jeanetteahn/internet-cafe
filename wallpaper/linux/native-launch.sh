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
set -uo pipefail

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
LAUNCHER_PID_FILE="$PID_DIR/launcher.pid"
SUPERVISOR_LOG="$PID_DIR/supervisor.log"
WALLPAPER_ELECTRON_LOG="$PID_DIR/wallpaper-electron.log"
KIOSK_ELECTRON_LOG="$PID_DIR/kiosk-electron.log"
mkdir -p "$PID_DIR"

sup_log() {
  local msg
  msg="$(date -Iseconds) [supervisor-native] $1"
  echo "$msg" >> "$SUPERVISOR_LOG" 2>/dev/null || true
  echo "$msg" >&2
}

decode_exit() {
  local code=$1
  if [ "$code" -eq 0 ]; then
    echo "clean exit (0)"
  elif [ "$code" -ge 128 ] && [ "$code" -le 165 ]; then
    local sig=$(( code - 128 ))
    case $sig in
      1)  echo "SIGHUP (code=$code)"  ;;
      2)  echo "SIGINT (code=$code)"  ;;
      9)  echo "SIGKILL (code=$code)" ;;
      11) echo "SIGSEGV (code=$code)" ;;
      15) echo "SIGTERM (code=$code)" ;;
      *)  echo "signal $sig (code=$code)" ;;
    esac
  else
    echo "exit code=$code"
  fi
}

echo $$ > "$LAUNCHER_PID_FILE"

WALLPAPER_LOOP_PID=""
KIOSK_LOOP_PID=""
cleanup() {
  touch "$QUIT_FLAG" 2>/dev/null || true
  [ -n "$WALLPAPER_LOOP_PID" ] && kill "$WALLPAPER_LOOP_PID" 2>/dev/null || true
  [ -n "$KIOSK_LOOP_PID"     ] && kill "$KIOSK_LOOP_PID"     2>/dev/null || true
  rm -f "$LAUNCHER_PID_FILE"
  sup_log "supervisor cleanup — exiting"
  exit 0
}
trap cleanup TERM INT

rm -f "$QUIT_FLAG"

# Disable X11 screen saver and DPMS so the display never goes dark.
xset s off s noblank -dpms 2>/dev/null || true

sup_log "starting (pid=$$, electron=$ELECTRON_BIN)"

# ---- Wallpaper supervisor loop -----------------------------------------------
run_wallpaper_loop() {
  trap 'exit 0' TERM INT
  local crash_count=0
  local crash_window_start
  crash_window_start=$(date +%s)

  while true; do
    if [ -f "$QUIT_FLAG" ]; then
      sup_log "wallpaper loop: quit flag — stopping"
      break
    fi

    sup_log "wallpaper: launching (crash_count=$crash_count)"
    ELECTRON_ENABLE_LOGGING=1 "$ELECTRON_BIN" "$PROJECT_DIR" \
      > >(tee -a "$WALLPAPER_ELECTRON_LOG") 2>&1 &
    local WALL_PID=$!

    wait "$WALL_PID" 2>/dev/null || true
    local EXIT_CODE=$?

    if [ -f "$QUIT_FLAG" ]; then
      sup_log "wallpaper: exited ($(decode_exit $EXIT_CODE)) and quit requested — stopping"
      break
    fi

    sup_log "wallpaper: exited with $(decode_exit $EXIT_CODE) — will restart"

    local now
    now=$(date +%s)
    local elapsed=$(( now - crash_window_start ))
    if [ "$elapsed" -le 120 ]; then
      crash_count=$(( crash_count + 1 ))
    else
      crash_count=1
      crash_window_start=$now
    fi

    if [ "$crash_count" -gt 5 ]; then
      sup_log "wallpaper: too many restarts ($crash_count in ${elapsed}s) — backing off 60s"
      sleep 60
      crash_count=0
      crash_window_start=$(date +%s)
    else
      sleep 3
    fi
  done
  sup_log "wallpaper loop exiting"
}

# ---- Kiosk supervisor loop ---------------------------------------------------
run_kiosk_loop() {
  trap 'exit 0' TERM INT
  local crash_count=0
  local crash_window_start
  crash_window_start=$(date +%s)

  while true; do
    if [ -f "$QUIT_FLAG" ]; then
      sup_log "kiosk loop: quit flag — stopping"
      break
    fi

    sup_log "kiosk: launching (crash_count=$crash_count)"
    ELECTRON_ENABLE_LOGGING=1 "$ELECTRON_BIN" "$PROJECT_DIR/kiosk-main.js" \
      > >(tee -a "$KIOSK_ELECTRON_LOG") 2>&1 &
    local KIOSK_PID=$!

    wait "$KIOSK_PID" 2>/dev/null || true
    local EXIT_CODE=$?

    if [ -f "$QUIT_FLAG" ]; then
      sup_log "kiosk: exited ($(decode_exit $EXIT_CODE)) and quit requested — stopping"
      break
    fi

    sup_log "kiosk: exited with $(decode_exit $EXIT_CODE) — will restart"

    local now
    now=$(date +%s)
    local elapsed=$(( now - crash_window_start ))
    if [ "$elapsed" -le 120 ]; then
      crash_count=$(( crash_count + 1 ))
    else
      crash_count=1
      crash_window_start=$now
    fi

    if [ "$crash_count" -gt 5 ]; then
      sup_log "kiosk: too many restarts ($crash_count in ${elapsed}s) — backing off 60s"
      sleep 60
      crash_count=0
      crash_window_start=$(date +%s)
    else
      sleep 3
    fi
  done
  sup_log "kiosk loop exiting"
}

# ---- Launch both loops -------------------------------------------------------

if [ "${ENABLE_KIOSK:-1}" = "0" ]; then
  sup_log "ENABLE_KIOSK=0 — running wallpaper only (no kiosk loop)"
  run_wallpaper_loop &
  WALLPAPER_LOOP_PID=$!
  wait "$WALLPAPER_LOOP_PID" 2>/dev/null || true
  rm -f "$LAUNCHER_PID_FILE"
  exit 0
fi

# Wallpaper process starts first; the kiosk cluster follows after 15 s.
# This matches the xwinwrap-launch.sh startup order -- the wallpaper window
# must be established before the kiosk panels appear on top of it.
run_wallpaper_loop &
WALLPAPER_LOOP_PID=$!

sup_log "wallpaper loop started (pid=$WALLPAPER_LOOP_PID); waiting 15s before kiosk"
sleep 15

run_kiosk_loop &
KIOSK_LOOP_PID=$!
sup_log "kiosk loop started (pid=$KIOSK_LOOP_PID)"

wait "$WALLPAPER_LOOP_PID" 2>/dev/null || true
wait "$KIOSK_LOOP_PID"     2>/dev/null || true

rm -f "$LAUNCHER_PID_FILE"
sup_log "supervisor exiting"
