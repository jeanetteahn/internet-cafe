#!/usr/bin/env bash
# Fallback launcher for window managers that ignore Electron's native
# `type: 'desktop'` hint (main.js tries that first). xwinwrap creates a
# placeholder window pinned to the desktop layer and reparents an
# arbitrary app's window into it — the same trick most existing "live
# wallpaper on Linux" tools (mpv-based ones especially) use.
#
# xwinwrap wraps ONLY the wallpaper process (main.js) below — never the
# kiosk browser cluster. That used to be one Electron process opening both
# windows, but wrapping the pair crashed xwinwrap outright (confirmed on a
# NucBox5 running Mint Cinnamon: the whole Electron process died silently,
# exit status 0, the instant the second, differently-sized kiosk window
# was created). xwinwrap expects a single-window app, like the mpv-style
# tools it was built around. The kiosk cluster now runs as its own,
# completely separate, unwrapped Electron process (kiosk-main.js),
# launched normally in the background just below — it doesn't need any
# desktop-layer trick since it's an ordinary focusable window that sits
# above the wallpaper automatically, wrapped or not.
#
# xwinwrap isn't packaged in every distro's repos. On Debian/Ubuntu-based
# systems (Mint included) it's usually unavailable via apt and needs
# building from source:
#   sudo apt install build-essential libx11-dev libxext-dev libxrender-dev
#   git clone https://github.com/ujjwal96/xwinwrap
#   cd xwinwrap && make && sudo make install
# (search your distro's package manager first — some do carry it)
#
# Also needs `xdotool` for screen-size detection (falls back to a 1920x1080
# guess if it's missing, so install it for correct results):
#   sudo apt install xdotool
#
# This only manipulates X11 windows. Under Wayland it generally only has
# a chance of working through XWayland, and even then depends on how
# tolerant your compositor is of X11 clients requesting background
# placement — it is not guaranteed, unlike on a real X11 session.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use the project's own local Electron (installed by `npm install` into
# node_modules) rather than assuming a global `electron` command is on
# PATH — a plain `npm install` never puts one there.
#
# Deliberately the real native binary (node_modules/electron/dist/electron),
# NOT node_modules/.bin/electron. That .bin wrapper is a small script
# starting with `#!/usr/bin/env node` — it needs `node` on PATH to even
# start. That's fine in an interactive terminal (opening one sources
# ~/.bashrc, which is what wires up nvm's PATH additions), but this script
# is also meant to be launched from a desktop icon or an XDG autostart
# entry — neither of which sources ~/.bashrc, so `node` isn't found there
# and the wrapper dies immediately with "No such file or directory". The
# real Electron binary below is self-contained and needs nothing on PATH.
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found at $ELECTRON_BIN — run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi

# Full virtual screen geometry (all monitors combined).
GEOMETRY=$(xdotool getdisplaygeometry 2>/dev/null || echo "1920 1080")
WIDTH=$(echo  "$GEOMETRY" | awk '{print $1}')
HEIGHT=$(echo "$GEOMETRY" | awk '{print $2}')

# ---- Supervisor / self-healing state ----------------------------------------
PID_DIR="/tmp/internet-cafe-wallpaper"
QUIT_FLAG="$PID_DIR/quit-requested"
LAUNCHER_PID_FILE="$PID_DIR/launcher.pid"
SUPERVISOR_LOG="$PID_DIR/supervisor.log"
WALLPAPER_ELECTRON_LOG="$PID_DIR/wallpaper-electron.log"
KIOSK_ELECTRON_LOG="$PID_DIR/kiosk-electron.log"
mkdir -p "$PID_DIR"

# Spoon system cursor — must be exported before Electron starts so the custom
# cursor is visible from the very first frame and during X11 button grabs.
export XCURSOR_THEME=spoon
export XCURSOR_SIZE=128

sup_log() {
  local msg
  msg="$(date -Iseconds) [supervisor] $1"
  echo "$msg" >> "$SUPERVISOR_LOG" 2>/dev/null || true
  echo "$msg" >&2
}

# Decode a bash exit code: 0 = clean, 128+N = signal, else error.
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

# Write our PID so relaunch.sh can kill this script cleanly.
echo $$ > "$LAUNCHER_PID_FILE"

# When this script is killed (by relaunch.sh or Ctrl+C), stop both loops.
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

# Clear any quit flag left from a previous session; we are starting fresh.
rm -f "$QUIT_FLAG"

# Disable X11 screen saver and DPMS so the display never goes dark and the
# GPU driver never enters a low-power state that kills the Chromium GPU
# process.  powerSaveBlocker in main.js is the Electron-level equivalent;
# xset is the X11-level belt-and-suspenders. Ignore errors if xset is absent.
xset s off s noblank -dpms 2>/dev/null || true

sup_log "starting (pid=$$, electron=$ELECTRON_BIN, geometry=${WIDTH}x${HEIGHT})"

# ---- Wallpaper supervisor loop -----------------------------------------------
# Restarts xwinwrap + electron (main.js) whenever they exit.
# NOTE: deliberately no `-fs` here (see the original xwinwrap-launch comments
# above about BadMatch on Cinnamon when combining -ov with -fs).
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

    sup_log "wallpaper: launching xwinwrap+electron (crash_count=$crash_count)"
    ELECTRON_ENABLE_LOGGING=1 xwinwrap -ov -s -st -sp -nf -b -un \
      -g "${WIDTH}x${HEIGHT}+0+0" -- \
      "$ELECTRON_BIN" "$PROJECT_DIR" \
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
# Relaunches kiosk-main.js whenever it exits.  First start is delayed 15 s so
# xwinwrap can establish its desktop-layer window before the kiosk appears on
# top.  Subsequent restarts get the normal 3 s / 60 s backoff.
run_kiosk_loop() {
  trap 'exit 0' TERM INT
  local crash_count=0
  local crash_window_start
  crash_window_start=$(date +%s)
  local first_start=1

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
    first_start=0
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

# Start wallpaper immediately; wait 15 s before kiosk so xwinwrap's
# desktop-layer window is established first.
run_wallpaper_loop &
WALLPAPER_LOOP_PID=$!

sup_log "wallpaper loop started (pid=$WALLPAPER_LOOP_PID); waiting 15s before kiosk"
sleep 15

run_kiosk_loop &
KIOSK_LOOP_PID=$!
sup_log "kiosk loop started (pid=$KIOSK_LOOP_PID)"

# Wait for both loops.  Either finishing means the supervisor is done.
wait "$WALLPAPER_LOOP_PID" 2>/dev/null || true
wait "$KIOSK_LOOP_PID"     2>/dev/null || true

rm -f "$LAUNCHER_PID_FILE"
sup_log "supervisor exiting"
