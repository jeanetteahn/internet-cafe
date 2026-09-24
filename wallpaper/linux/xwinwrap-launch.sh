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

sleep 15

# Kiosk cluster: separate, unwrapped, ordinary Electron process -- see the
# comment at the top of this file. Set ENABLE_KIOSK=0 to skip it (handy
# while debugging wallpaper placement on its own).
if [ "${ENABLE_KIOSK:-1}" != "0" ]; then
  "$ELECTRON_BIN" "$PROJECT_DIR/kiosk-main.js" &
fi

# Keep this script alive so relaunch.sh (which exec's into this script and
# then kills it to restart) has a stable process to target.
wait
