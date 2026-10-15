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
set -euo pipefail

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

# Full virtual screen geometry (all monitors combined). Adjust to a
# specific monitor's geometry (from `xrandr`) if you only want the
# wallpaper on one screen.
GEOMETRY=$(xdotool getdisplaygeometry 2>/dev/null || echo "1920 1080")
WIDTH=$(echo "$GEOMETRY" | awk '{print $1}')
HEIGHT=$(echo "$GEOMETRY" | awk '{print $2}')

# ---- Supervisor / self-healing state ----------------------------------------
PID_DIR="/tmp/internet-cafe-wallpaper"
QUIT_FLAG="$PID_DIR/quit-requested"
LAUNCHER_PID_FILE="$PID_DIR/launcher-kiosk.pid"
SUPERVISOR_LOG="$PID_DIR/supervisor.log"
mkdir -p "$PID_DIR"

# Write this script's PID so relaunch.sh can kill it cleanly before relaunching.
echo $$ > "$LAUNCHER_PID_FILE"

sup_log() {
  local msg="$(date -Iseconds) [supervisor] $1"
  echo "$msg" >> "$SUPERVISOR_LOG" 2>/dev/null || true
  echo "$msg" >&2
}

# Clear any quit flag left from a previous session; we are starting fresh.
rm -f "$QUIT_FLAG"

sup_log "starting (pid=$$, electron=$ELECTRON_BIN)"

# NOTE: deliberately no `-fs` here. xwinwrap's own usage text says `-ov`
# (override_redirect, what makes this sit seamlessly in the background) is
# intended for non-fullscreen mode; combining `-ov` with `-fs` triggers a
# BadMatch X error on window creation on at least some X11/compositor
# combinations (confirmed on Cinnamon/Mutter-family setups). The explicit
# `-g` geometry below already covers the full display, so dropping `-fs`
# costs nothing.
#
# xwinwrap must start first and claim its desktop-layer window before the
# kiosk cluster launches. Starting both simultaneously races with xwinwrap's
# window-placement handshake and can leave the kiosk invisible or mis-layered
# on Cinnamon. Sleep 15 s before starting the kiosk process.
xwinwrap -ov -s -st -sp -nf -b -un -g "${WIDTH}x${HEIGHT}+0+0" -- \
  "$ELECTRON_BIN" "$PROJECT_DIR" &

sup_log "wallpaper (xwinwrap) started; waiting 15s before kiosk"
sleep 15

# ---- Kiosk supervisor loop --------------------------------------------------
# Relaunches kiosk-main.js whenever it exits (crash, OOM, GPU death, etc.).
# Backs off to 60 s when more than 5 exits happen within 2 minutes.
# Exits cleanly when the quit-requested flag file exists.

if [ "${ENABLE_KIOSK:-1}" = "0" ]; then
  sup_log "ENABLE_KIOSK=0 — skipping kiosk supervisor loop"
  wait
  rm -f "$LAUNCHER_PID_FILE"
  exit 0
fi

crash_count=0
crash_window_start=$(date +%s)

while true; do
  # Stop immediately if Ctrl+Alt+Q or relaunch.sh requested a quit.
  if [ -f "$QUIT_FLAG" ]; then
    sup_log "quit-requested flag set — stopping supervisor loop"
    break
  fi

  sup_log "launching kiosk (crash_count=$crash_count)"
  "$ELECTRON_BIN" "$PROJECT_DIR/kiosk-main.js" &
  KIOSK_PID=$!

  # Wait for kiosk to exit (for any reason).
  wait "$KIOSK_PID" || true
  EXIT_CODE=$?

  # Check quit flag again — may have been written during the kiosk run.
  if [ -f "$QUIT_FLAG" ]; then
    sup_log "kiosk exited (code=$EXIT_CODE) and quit-requested — stopping supervisor loop"
    break
  fi

  sup_log "kiosk exited with code=$EXIT_CODE — will restart"

  # Crash-rate back-off: reset window every 2 minutes.
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

# Keep alive until the wallpaper (xwinwrap) process also exits, so this
# script's exit doesn't confuse any wrapper that targets the parent PID.
wait
